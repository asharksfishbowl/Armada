"""The evaluation gate — Training R33b, R34, R35, R35a, R36, R37; edges 19, 20, 25, 28.

THE ORDER OF THE FIRST TWO CHECKS IS THE POINT OF R33b. `run_kind` is inspected BEFORE the
gate performs any work at all. A `smoke` Adapter is set `rejected` immediately with
`error: "smoke runs are not promotable"`, no completions are generated, no judge call is
issued, and NO `evaluations` ROW IS WRITTEN (edge 25). Spending judge tokens — or twenty
minutes of CPU generation — on an Adapter that cannot be promoted under any outcome is
never correct, and a row of scores that were computed and then discarded would suggest the
decision turned on them when it did not.

R35's COMPARISON, EXACTLY:
  tool_call_validity   candidate >= baseline   (both modes)
  held_out_perplexity  candidate <= baseline   (mechanical mode)
  task_success_rate    candidate >= baseline   (judge mode)
A NULL metric is EXCLUDED rather than compared (R35a). With `tool_call_validity` null —
the common case on supplied JSONL, because no tool schemas are presented at generation time
— the default mechanical gate reduces to the perplexity comparison alone. R35 states that
rather than leaving it emergent, and so does this file.

WHEN THE GATE DID NOT COMPLETE THE ADAPTER IS NOT REJECTED (R35, edges 19/20). An absent
judgement is not a failing judgement. Mechanical mode has no external dependency and
therefore cannot reach that state at all.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from armada_forge import db
from armada_forge.eval import JUDGE, judge as judge_mode, mechanical, tool_calls
from armada_forge.eval.scoring import InProcessScorer, Scorer
from armada_forge.registry import export
from armada_forge.registry.models import ShortlistEntry, TrainingEntry
from armada_forge.teacher import TeacherClient, TeacherUnreachable

SMOKE_REJECTION = "smoke runs are not promotable"


@dataclass
class GateResult:
    adapter_id: str
    status: str
    completed: bool
    passed: bool | None
    detail: str
    candidate_scores: dict[str, Any] | None = None
    baseline_scores: dict[str, Any] | None = None


def compare(candidate: dict[str, Any], baseline: dict[str, Any]) -> tuple[bool, list[str]]:
    """R35/R35a — every SCORED metric must be at least as good. Returns (passed, notes).

    FAILS CLOSED WHEN NOTHING WAS COMPARABLE. A gate that compared zero metrics has not
    judged anything, and "no evidence against" is not "evidence for" — promoting on an
    empty comparison would make the gate decorative, which is the failure this repo has
    now produced five times in other forms.
    """
    checks = (
        # (metric, lower_is_better)
        ("tool_call_validity", False),
        ("held_out_perplexity", True),
        ("task_success_rate", False),
    )

    notes: list[str] = []
    compared = 0
    passed = True

    for metric, lower_is_better in checks:
        candidate_value = candidate.get(metric)
        baseline_value = baseline.get(metric)

        if candidate_value is None or baseline_value is None:
            # R35a — excluded, not compared. Treating a 0/0 denominator as a score would
            # either block every promotion or pass every one depending on the direction.
            notes.append(f"{metric}: excluded (null on at least one side)")
            continue

        compared += 1
        ok = candidate_value <= baseline_value if lower_is_better else candidate_value >= baseline_value
        passed = passed and ok
        direction = "<=" if lower_is_better else ">="
        notes.append(
            f"{metric}: candidate {candidate_value:.4f} {direction} baseline "
            f"{baseline_value:.4f} — {'ok' if ok else 'WORSE'}"
        )

    if compared == 0:
        notes.append("no metric was comparable; the gate cannot promote on an empty comparison")
        return False, notes

    return passed, notes


class Gate:
    """Runs the gate for one Adapter and applies the promotion decision.

    `scorer_factory` and `exporter` are injected so the decision logic can be exercised
    without loading multi-gigabyte weights. Nothing on the request path supplies them.
    """

    def __init__(
        self,
        *,
        mode: str,
        eval_fraction_config: dict[str, Any],
        training_entries: dict[str, TrainingEntry],
        binding_entries: dict[str, ShortlistEntry],
        teacher_client: TeacherClient,
        max_eval_samples: int,
        rubric: str,
        models_url: str,
        scorer_factory: Callable[[str, Path | None], Scorer] | None = None,
        exporter: Any = export,
    ) -> None:
        self.mode = mode
        self.eval_config = eval_fraction_config
        self.training_entries = training_entries
        self.binding_entries = binding_entries
        self.teacher_client = teacher_client
        self.max_eval_samples = max_eval_samples
        self.rubric = rubric
        self.models_url = models_url
        self.exporter = exporter
        self._scorer_factory = scorer_factory or (
            lambda hf_id, adapter_path: InProcessScorer(hf_id=hf_id, adapter_path=adapter_path)
        )

    # ── Data access ──────────────────────────────────────────────────────────

    def _adapter(self, adapter_id: str) -> dict[str, Any] | None:
        return db.query_one(
            """
            SELECT a.*, tr.run_kind, tr.dataset_id, d.eval_split_path, d.source_breakdown
              FROM adapters a
              JOIN training_runs tr ON tr.training_run_id = a.training_run_id
              LEFT JOIN datasets d  ON d.dataset_id = tr.dataset_id
             WHERE a.adapter_id = %s
            """,
            (adapter_id,),
        )

    def _set_status(self, adapter_id: str, status: str, error: str | None) -> None:
        db.execute(
            "UPDATE adapters SET status = %s, error = %s WHERE adapter_id = %s",
            (status, error, adapter_id),
        )

    # ── The gate ─────────────────────────────────────────────────────────────

    def run(self, adapter_id: str) -> GateResult:
        adapter = self._adapter(adapter_id)
        if adapter is None:
            return GateResult(adapter_id, "unknown", False, None, "no such Adapter")

        # ── R33b / R37 / edge 25 — BEFORE ANY WORK ───────────────────────────
        if adapter["run_kind"] == "smoke":
            self._set_status(adapter_id, "rejected", SMOKE_REJECTION)
            return GateResult(
                adapter_id,
                "rejected",
                completed=False,
                passed=None,
                detail=SMOKE_REJECTION,
            )

        entry = self.training_entries.get(adapter["base_model_id"])
        if entry is None:
            # Left pending_eval: the model left the shortlist, which an operator can undo.
            # Rejecting would make a config edit permanently destroy an Adapter.
            detail = (
                f"`{adapter['base_model_id']}` is no longer in config/base-models.yaml, so "
                "the baseline cannot be loaded; the Adapter is left at pending_eval"
            )
            self._set_status(adapter_id, "pending_eval", detail)
            return GateResult(adapter_id, "pending_eval", False, None, detail)

        samples = self._held_out(adapter)
        if isinstance(samples, str):
            self._set_status(adapter_id, "pending_eval", samples)
            return GateResult(adapter_id, "pending_eval", False, None, samples)

        candidate = self._scorer_factory(entry.hf_id, Path(adapter["artifact_path"]))
        baseline = self._scorer_factory(entry.hf_id, None)

        try:
            if self.mode == JUDGE:
                outcome = self._judge(adapter_id, samples, candidate, baseline)
            else:
                outcome = self._mechanical(samples, candidate, baseline)
        except TeacherUnreachable as exc:
            # Edge 19 — JUDGE MODE ONLY. Left at pending_eval with the error recorded on the
            # evaluations row, never rejected.
            self._record_evaluation(adapter_id, {}, {}, 0, 0, completed=False, passed=None, error=str(exc))
            self._set_status(adapter_id, "pending_eval", str(exc))
            return GateResult(adapter_id, "pending_eval", False, None, str(exc))
        except judge_mode.JudgeAborted as exc:
            # Edge 20 — more than half the verdicts were unparseable. The gate measured
            # nothing, so it did not complete.
            self._record_evaluation(
                adapter_id, {}, {}, 0, exc.errors,
                completed=False, passed=None, error=str(exc),
            )
            self._set_status(adapter_id, "pending_eval", str(exc))
            return GateResult(adapter_id, "pending_eval", False, None, str(exc))
        finally:
            candidate.close()
            baseline.close()

        candidate_scores, baseline_scores, judge_errors = outcome
        passed, notes = compare(candidate_scores, baseline_scores)

        self._record_evaluation(
            adapter_id,
            candidate_scores,
            baseline_scores,
            int(candidate_scores.get("samples_evaluated", len(samples))),
            judge_errors,
            completed=True,
            passed=passed,
            error=None,
        )

        if not passed:
            detail = "; ".join(notes)
            self._set_status(adapter_id, "rejected", detail)
            return GateResult(adapter_id, "rejected", True, False, detail, candidate_scores, baseline_scores)

        result = self.promote(adapter_id)
        result.candidate_scores = candidate_scores
        result.baseline_scores = baseline_scores
        result.completed = True
        result.passed = True
        return result

    def _held_out(self, adapter: dict[str, Any]) -> list[dict[str, Any]] | str:
        """The held-out samples, or a message explaining why there are none.

        A missing split here should be unreachable — R33a refuses a promotable run without
        one at `POST /training/runs` — so it is reported rather than worked around. Silently
        promoting on an empty held-out set would be the gate passing everything.
        """
        path_value = adapter.get("eval_split_path")
        if not path_value:
            return (
                "this Adapter's dataset has no held-out split, so the gate has nothing to "
                "score. R33a should have refused the run; the Adapter is left at pending_eval."
            )
        path = Path(path_value)
        if not path.exists():
            return f"the held-out split file `{path}` is missing; the Adapter is left at pending_eval"

        samples = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not samples:
            return f"the held-out split file `{path}` is empty; the Adapter is left at pending_eval"
        return samples

    def _mechanical(
        self, samples: list[dict[str, Any]], candidate: Scorer, baseline: Scorer
    ) -> tuple[dict[str, Any], dict[str, Any], int]:
        """R34a — both sides scored identically, in-process, with no teacher and no
        `armada-models`. `judge_errors` is 0 by construction (edge 28)."""
        return mechanical.score(candidate, samples), mechanical.score(baseline, samples), 0

    def _judge(
        self,
        adapter_id: str,
        samples: list[dict[str, Any]],
        candidate: Scorer,
        baseline: Scorer,
    ) -> tuple[dict[str, Any], dict[str, Any], int]:
        """R34b — generation is still local and free; only the JUDGEMENT costs.

        `held_out_perplexity` is not computed in this mode (R34b), so it is absent from both
        score sets and R35a's exclusion rule drops it from the comparison automatically.
        """
        prompts = [sample.get("instruction") or "" for sample in samples]
        candidate_completions = [candidate.generate(prompt) for prompt in prompts]
        baseline_completions = [baseline.generate(prompt) for prompt in prompts]

        outcome = judge_mode.judge(
            self.teacher_client,
            self.rubric,
            adapter_id,
            samples,
            candidate_completions,
            baseline_completions,
            self.max_eval_samples,
        )

        candidate_scores = {
            "task_success_rate": outcome.candidate_pass_rate,
            "tool_call_validity": tool_calls.validity(candidate_completions),
            "held_out_perplexity": None,
            "samples_evaluated": outcome.samples_evaluated,
        }
        baseline_scores = {
            "task_success_rate": outcome.baseline_pass_rate,
            "tool_call_validity": tool_calls.validity(baseline_completions),
            "held_out_perplexity": None,
            "samples_evaluated": outcome.samples_evaluated,
        }
        return candidate_scores, baseline_scores, outcome.judge_errors

    def _record_evaluation(
        self,
        adapter_id: str,
        candidate_scores: dict[str, Any],
        baseline_scores: dict[str, Any],
        samples_evaluated: int,
        judge_errors: int,
        *,
        completed: bool,
        passed: bool | None,
        error: str | None,
    ) -> None:
        """R36 — one `evaluations` row. `passed` is null exactly when `completed` is false,
        which migration 003 also enforces as a CHECK constraint."""
        db.execute(
            """
            INSERT INTO evaluations (
                adapter_id, mode, candidate_scores, baseline_scores,
                samples_evaluated, judge_errors, completed, passed, error
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                adapter_id,
                self.mode,
                json.dumps(candidate_scores),
                json.dumps(baseline_scores),
                samples_evaluated,
                judge_errors,
                completed,
                passed,
                error,
            ),
        )

    # ── Promotion ────────────────────────────────────────────────────────────

    def promote(self, adapter_id: str) -> GateResult:
        """R31 — merge, convert, quantize, register, THEN set `promoted`.

        R30 in order form: the status is written last, so there is no window in which an
        Adapter is `promoted` while the model server has nothing under its tag.
        """
        adapter = self._adapter(adapter_id)
        if adapter is None:
            return GateResult(adapter_id, "unknown", False, None, "no such Adapter")

        # R37, enforced on THIS route too and not only on the evaluation route. A smoke
        # Adapter is never promotable "by this route or by POST /adapters/{id}/promote".
        if adapter["run_kind"] == "smoke":
            self._set_status(adapter_id, "rejected", SMOKE_REJECTION)
            return GateResult(adapter_id, "rejected", False, None, SMOKE_REJECTION)

        entry = self.training_entries.get(adapter["base_model_id"])
        binding_entry = self.binding_entries.get(adapter["base_model_id"])
        if entry is None or binding_entry is None:
            detail = (
                f"`{adapter['base_model_id']}` is no longer in config/base-models.yaml, so "
                "no ModelBinding can be registered for this Adapter"
            )
            self._set_status(adapter_id, "pending_eval", detail)
            return GateResult(adapter_id, "pending_eval", False, None, detail)

        tag = self.exporter.binding_tag(
            adapter["base_model_id"], adapter["corpus_name"], adapter["version"]
        )
        work_dir = Path(adapter["artifact_path"]) / "export"

        try:
            gguf = self.exporter.merge_convert_quantize(
                entry.hf_id, Path(adapter["artifact_path"]), entry.quantization, work_dir
            )
        except self.exporter.ExportError as exc:
            # Edge 13 — conversion or quantization failed AFTER a passing evaluation. The
            # Adapter is rejected with the conversion error and NO binding is registered.
            self._set_status(adapter_id, "rejected", str(exc))
            return GateResult(adapter_id, "rejected", True, True, str(exc))

        try:
            self.exporter.register_with_model_server(self.models_url, tag, gguf)
        except self.exporter.RegistrationUnreachable as exc:
            # Edge 14 — the artifact is fine, the model server is not. LEFT pending_eval so
            # POST /adapters/{adapter_id}/promote can retry.
            self._set_status(adapter_id, "pending_eval", str(exc))
            return GateResult(adapter_id, "pending_eval", True, True, str(exc))

        self.exporter.record_binding(
            tag,
            adapter,
            binding_entry.context_window,
            binding_entry.tool_format,
            binding_entry.backend,
        )
        self._set_status(adapter_id, "promoted", None)
        return GateResult(adapter_id, "promoted", True, True, f"registered as `{tag}`")
