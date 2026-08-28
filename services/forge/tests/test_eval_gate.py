"""P11 — the evaluation gate. Training R33b, R34, R34e, R35, R35a, R36, R37; edges 13, 14, 25, 28.

TWO OF P11'S THREE EXIT CRITERIA ARE HERE:

  * "a smoke-run Adapter is set `rejected` and never registered" — and R33b makes that
    stronger than it sounds: the rejection happens BEFORE any evaluation work, so no
    completion is generated, no judge call is issued, and no `evaluations` row is written
    at all (edge 25).
  * "the gate scores candidate and baseline with no request to `armada-models`" — enforced
    by making every socket call raise for the duration of the gate, so a gate that reached
    the model server would fail with a connection error rather than pass quietly.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import pytest

from armada_forge.eval import gate as gate_module
from armada_forge.eval.gate import SMOKE_REJECTION, Gate, compare
from armada_forge.registry import export
from armada_forge.registry.models import ShortlistEntry, TrainingEntry
from armada_forge.teacher import TeacherClient, TeacherSettings

ADAPTER_ID = "aaaaaaaa-0000-0000-0000-000000000001"

TRAINING_ENTRY = TrainingEntry(
    id="qwen3-0.6b", hf_id="Qwen/Qwen3-0.6B", chat_template="qwen3",
    quantization="Q4_K_M", trainable=True, smoke_test=True,
    lora_target_modules=("q_proj",),
)
BINDING_ENTRY = ShortlistEntry(
    id="qwen3-0.6b", backend="ollama", serving_ref="qwen3:0.6b", context_window=32768,
    tool_format="hermes", min_ram_gb=2, min_disk_gb=2, smoke_test=True,
)


class FakeDB:
    """Only the three statements the gate issues."""

    def __init__(self, adapter: dict[str, Any]) -> None:
        self.adapter = adapter
        self.evaluations: list[dict[str, Any]] = []
        self.status_writes: list[tuple[str, str | None]] = []

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        return dict(self.adapter)

    def execute(self, sql: str, params: Any = None) -> int:
        flat = " ".join(sql.split())
        if flat.startswith("UPDATE adapters SET status"):
            status, error, _ = params
            self.adapter["status"] = status
            self.adapter["error"] = error
            self.status_writes.append((status, error))
            return 1
        if flat.startswith("INSERT INTO evaluations"):
            (
                adapter_id, mode, candidate, baseline, samples, judge_errors,
                completed, passed, error,
            ) = params
            self.evaluations.append({
                "adapter_id": adapter_id, "mode": mode,
                "candidate_scores": json.loads(candidate),
                "baseline_scores": json.loads(baseline),
                "samples_evaluated": samples, "judge_errors": judge_errors,
                "completed": completed, "passed": passed, "error": error,
            })
            return 1
        return 0


class FakeScorer:
    """A Scorer that answers from fixed values and records that it was asked."""

    instances: list["FakeScorer"] = []

    def __init__(self, perplexity: float, completion: str = "plain text answer") -> None:
        self._perplexity = perplexity
        self._completion = completion
        self.generated = 0
        self.scored = 0
        FakeScorer.instances.append(self)

    def generate(self, prompt: str) -> str:
        self.generated += 1
        return self._completion

    def perplexity(self, text: str) -> float:
        self.scored += 1
        return self._perplexity

    def close(self) -> None:
        pass


class FakeExporter:
    """Stands in for `registry.export`, reusing its REAL exception classes.

    Reusing them rather than defining look-alikes is deliberate: the gate distinguishes
    edge 13 from edge 14 by exception type, and a test with its own class hierarchy would
    pass even if the production types were reorganised into one.
    """

    ExportError = export.ExportError
    RegistrationUnreachable = export.RegistrationUnreachable

    def __init__(self, fail_convert: bool = False, fail_register: bool = False) -> None:
        self.fail_convert = fail_convert
        self.fail_register = fail_register
        self.registered: list[str] = []
        self.bindings: list[str] = []

    def binding_tag(self, base_model_id: str, corpus_name: str, version: int) -> str:
        return export.binding_tag(base_model_id, corpus_name, version)

    def merge_convert_quantize(self, hf_id: str, adapter_path: Path, quantization: str, work_dir: Path) -> Path:
        if self.fail_convert:
            raise export.ExportError("quantization to Q4_K_M failed (exit 1)")
        return work_dir / "model.gguf"

    def register_with_model_server(self, base_url: str, tag: str, gguf_path: Path) -> None:
        if self.fail_register:
            raise export.RegistrationUnreachable("armada-models is unreachable")
        self.registered.append(tag)

    def record_binding(self, tag: str, adapter: dict[str, Any], context_window: int, tool_format: str, backend: str) -> None:
        self.bindings.append(tag)


def _adapter_row(run_kind: str, eval_split_path: str | None, tmp_path: Path) -> dict[str, Any]:
    return {
        "adapter_id": ADAPTER_ID,
        "base_model_id": "qwen3-0.6b",
        "corpus_name": "recipes",
        "version": 1,
        "status": "pending_eval",
        "artifact_path": str(tmp_path / "adapter"),
        "error": None,
        "run_kind": run_kind,
        "dataset_id": "d",
        "eval_split_path": eval_split_path,
        "source_breakdown": {},
    }


def _write_eval_split(tmp_path: Path, count: int = 4) -> str:
    path = tmp_path / "d.eval.jsonl"
    path.write_text(
        "".join(
            json.dumps({
                "instruction": f"q{i}", "response": f"a{i}", "origin": "supplied",
                "text": f"q{i}\na{i}",
            }) + "\n"
            for i in range(count)
        ),
        encoding="utf-8",
    )
    return str(path)


@pytest.fixture(autouse=True)
def reset_scorers() -> None:
    FakeScorer.instances.clear()


def _gate(
    db: FakeDB,
    monkeypatch: pytest.MonkeyPatch,
    *,
    mode: str = "mechanical",
    candidate_perplexity: float = 5.0,
    baseline_perplexity: float = 9.0,
    candidate_completion: str = "plain text answer",
    baseline_completion: str = "plain text answer",
    exporter: Any = None,
    teacher: Any = None,
) -> Gate:
    monkeypatch.setattr(gate_module, "db", db)

    def factory(hf_id: str, adapter_path: Path | None):
        if adapter_path is None:
            return FakeScorer(baseline_perplexity, baseline_completion)
        return FakeScorer(candidate_perplexity, candidate_completion)

    return Gate(
        mode=mode,
        eval_fraction_config={"mode": mode, "eval_fraction": 0.1},
        training_entries={"qwen3-0.6b": TRAINING_ENTRY},
        binding_entries={"qwen3-0.6b": BINDING_ENTRY},
        teacher_client=teacher or TeacherClient(
            TeacherSettings.from_config({"enabled": False, "provider": "none"}, {})
        ),
        max_eval_samples=200,
        rubric="",
        models_url="http://armada-models:11434",
        scorer_factory=factory,
        exporter=exporter or FakeExporter(),
    )


# ── EXIT CRITERION: a smoke Adapter is rejected before any work ──────────────

def test_a_smoke_adapter_is_rejected_before_any_evaluation(tmp_path: Path, monkeypatch) -> None:
    """R33b / R37 — set `rejected` immediately with the exact spec'd error."""
    db = FakeDB(_adapter_row("smoke", _write_eval_split(tmp_path), tmp_path))
    result = _gate(db, monkeypatch).run(ADAPTER_ID)

    assert result.status == "rejected"
    assert db.adapter["status"] == "rejected"
    assert db.adapter["error"] == SMOKE_REJECTION == "smoke runs are not promotable"


def test_a_smoke_adapter_generates_nothing_and_writes_no_evaluations_row(
    tmp_path: Path, monkeypatch
) -> None:
    """Edge 25 — no completions, no judge call, NO ROW.

    Scores that were computed and then discarded would suggest the decision turned on them
    when it did not, and on a judge-mode installation they would have cost real money.
    """
    db = FakeDB(_adapter_row("smoke", _write_eval_split(tmp_path), tmp_path))
    _gate(db, monkeypatch).run(ADAPTER_ID)

    assert db.evaluations == []
    assert FakeScorer.instances == [], "a scorer was constructed for an Adapter that could not be promoted"


def test_a_smoke_adapter_is_never_registered(tmp_path: Path, monkeypatch) -> None:
    """The other half of the exit criterion."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("smoke", _write_eval_split(tmp_path), tmp_path))
    _gate(db, monkeypatch, exporter=exporter).run(ADAPTER_ID)

    assert exporter.registered == []
    assert exporter.bindings == []


def test_a_smoke_adapter_is_refused_by_the_manual_promote_route_too(
    tmp_path: Path, monkeypatch
) -> None:
    """R37 — "by this route or by POST /adapters/{adapter_id}/promote"."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("smoke", _write_eval_split(tmp_path), tmp_path))
    result = _gate(db, monkeypatch, exporter=exporter).promote(ADAPTER_ID)

    assert result.status == "rejected"
    assert exporter.registered == []


# ── EXIT CRITERION: no request to armada-models ─────────────────────────────

def test_the_gate_completes_with_every_socket_severed(tmp_path: Path, monkeypatch) -> None:
    """P11 exit criterion 3, and the acceptance criterion "the evaluation gate completes
    with `armada-models` stopped".

    Build-plan Req 31: generation and scoring are in-process. Severing every socket means a
    gate that reached the model server fails here with a connection error rather than
    passing quietly.
    """
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the mechanical gate opened a socket")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)

    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))
    result = _gate(db, monkeypatch).run(ADAPTER_ID)

    assert result.completed is True
    assert result.passed is True


def test_both_sides_are_scored_locally_and_identically(tmp_path: Path, monkeypatch) -> None:
    """R34e — the BASELINE generates in-process too.

    Scoring the baseline through armada-models would compare a Q4_K_M baseline against an
    fp16 candidate; the quantization delta would swamp the adapter delta.
    """
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path, 4), tmp_path))
    _gate(db, monkeypatch).run(ADAPTER_ID)

    assert len(FakeScorer.instances) == 2
    candidate, baseline = FakeScorer.instances
    assert candidate.generated == baseline.generated == 4
    assert candidate.scored == baseline.scored == 4


# ── R35: the comparison ──────────────────────────────────────────────────────

def test_a_better_candidate_is_promoted(tmp_path: Path, monkeypatch) -> None:
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))

    result = _gate(db, monkeypatch, candidate_perplexity=4.0, baseline_perplexity=9.0,
                   exporter=exporter).run(ADAPTER_ID)

    assert result.status == "promoted"
    assert exporter.registered == ["armada/qwen3-0.6b-recipes-v1"]
    assert db.evaluations[0]["passed"] is True


def test_a_worse_candidate_is_rejected_and_both_score_sets_are_persisted(
    tmp_path: Path, monkeypatch
) -> None:
    """R35 — "the Adapter is set to `rejected` and BOTH SCORE SETS are persisted"."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))

    result = _gate(db, monkeypatch, candidate_perplexity=12.0, baseline_perplexity=9.0,
                   exporter=exporter).run(ADAPTER_ID)

    assert result.status == "rejected"
    assert exporter.registered == [], "a rejected Adapter must never be registered (R30)"

    row = db.evaluations[0]
    assert row["passed"] is False and row["completed"] is True
    assert row["candidate_scores"]["held_out_perplexity"] == 12.0
    assert row["baseline_scores"]["held_out_perplexity"] == 9.0


def test_an_equal_candidate_passes(tmp_path: Path, monkeypatch) -> None:
    """R35 — "at least as good as", not "better than"."""
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))
    result = _gate(db, monkeypatch, candidate_perplexity=7.0, baseline_perplexity=7.0).run(ADAPTER_ID)
    assert result.passed is True


# ── R35a: a null metric is EXCLUDED, not compared ───────────────────────────

def test_tool_call_validity_is_null_when_no_tool_calls_were_emitted(
    tmp_path: Path, monkeypatch
) -> None:
    """The acceptance criterion: "records tool_call_validity: null — NOT 0 — and reaches a
    promotion decision on the remaining metrics"."""
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))
    result = _gate(db, monkeypatch, candidate_perplexity=4.0, baseline_perplexity=9.0).run(ADAPTER_ID)

    scores = db.evaluations[0]["candidate_scores"]
    assert scores["tool_call_validity"] is None
    assert scores["tool_call_validity"] != 0
    assert result.passed is True, "a null metric must not block the decision"


def test_edge_28_mechanical_mode_records_zero_judge_errors_and_a_null_success_rate(
    tmp_path: Path, monkeypatch
) -> None:
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))
    _gate(db, monkeypatch).run(ADAPTER_ID)

    row = db.evaluations[0]
    assert row["mode"] == "mechanical"
    assert row["judge_errors"] == 0
    assert row["candidate_scores"]["task_success_rate"] is None
    assert row["baseline_scores"]["task_success_rate"] is None


# ── compare(): the rule in isolation ────────────────────────────────────────

def test_compare_excludes_a_null_on_either_side() -> None:
    passed, notes = compare(
        {"tool_call_validity": None, "held_out_perplexity": 4.0},
        {"tool_call_validity": 1.0, "held_out_perplexity": 9.0},
    )
    assert passed is True
    assert any("tool_call_validity" in note and "excluded" in note for note in notes)


def test_compare_fails_closed_when_nothing_was_comparable() -> None:
    """A gate that compared zero metrics has not judged anything.

    "No evidence against" is not "evidence for" — promoting on an empty comparison would
    make the gate decorative, which is the failure this repo keeps producing.
    """
    passed, notes = compare({"held_out_perplexity": None}, {"held_out_perplexity": None})
    assert passed is False
    assert any("empty comparison" in note for note in notes)


def test_compare_directions() -> None:
    """Perplexity is lower-is-better; the other two are higher-is-better. Getting one
    direction wrong would reject every good adapter or promote every bad one."""
    assert compare({"held_out_perplexity": 3.0}, {"held_out_perplexity": 9.0})[0] is True
    assert compare({"held_out_perplexity": 9.0}, {"held_out_perplexity": 3.0})[0] is False
    assert compare({"task_success_rate": 0.9}, {"task_success_rate": 0.5})[0] is True
    assert compare({"task_success_rate": 0.5}, {"task_success_rate": 0.9})[0] is False
    assert compare({"tool_call_validity": 1.0}, {"tool_call_validity": 0.5})[0] is True
    assert compare({"tool_call_validity": 0.5}, {"tool_call_validity": 1.0})[0] is False


# ── Edges 13 and 14: two failures, two different outcomes ───────────────────

def test_a_conversion_failure_rejects_and_registers_nothing(tmp_path: Path, monkeypatch) -> None:
    """Edge 13 — the artifact cannot be produced, so retrying the same inputs cannot help."""
    exporter = FakeExporter(fail_convert=True)
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))

    result = _gate(db, monkeypatch, candidate_perplexity=4.0, exporter=exporter).run(ADAPTER_ID)

    assert db.adapter["status"] == "rejected"
    assert "quantization" in (db.adapter["error"] or "")
    assert exporter.registered == [] and exporter.bindings == []


def test_an_unreachable_model_server_leaves_the_adapter_retryable(
    tmp_path: Path, monkeypatch
) -> None:
    """Edge 14 — the artifact is fine and the environment is not. LEFT `pending_eval` so
    POST /adapters/{adapter_id}/promote can retry, rather than rejected."""
    exporter = FakeExporter(fail_register=True)
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))

    _gate(db, monkeypatch, candidate_perplexity=4.0, exporter=exporter).run(ADAPTER_ID)

    assert db.adapter["status"] == "pending_eval"
    assert exporter.bindings == [], "no binding row may claim a tag the server does not have"


def test_a_missing_eval_split_leaves_the_adapter_pending_not_promoted(
    tmp_path: Path, monkeypatch
) -> None:
    """Silently promoting on an empty held-out set would be the gate passing everything."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", None, tmp_path))

    result = _gate(db, monkeypatch, exporter=exporter).run(ADAPTER_ID)

    assert result.status == "pending_eval"
    assert exporter.registered == []
    assert db.evaluations == []


# ── Judge mode through the Gate: edges 19 and 20 ────────────────────────────


class ScriptedTeacher:
    def __init__(self, replies: list[str] | None = None, raises: Exception | None = None) -> None:
        self.replies = replies or []
        self.raises = raises
        self.calls = 0

    def complete(self, messages: list[dict[str, str]], temperature: float = 0.0) -> str:
        if self.raises is not None:
            raise self.raises
        self.calls += 1
        return self.replies[(self.calls - 1) % len(self.replies)]


def test_judge_mode_compares_task_success_rate(tmp_path: Path, monkeypatch) -> None:
    """R34b — `task_success_rate` is the scored metric and `held_out_perplexity` is not
    computed, so R35a's exclusion rule drops perplexity from the comparison on its own."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path, 4), tmp_path))

    # Samples 0 and 2 show the candidate first, 1 and 3 show the baseline first.
    teacher = ScriptedTeacher(["A: pass\nB: fail", "A: fail\nB: pass"])
    result = _gate(db, monkeypatch, mode="judge", teacher=teacher, exporter=exporter).run(ADAPTER_ID)

    row = db.evaluations[0]
    assert row["mode"] == "judge"
    assert row["candidate_scores"]["task_success_rate"] == 1.0
    assert row["baseline_scores"]["task_success_rate"] == 0.0
    assert row["candidate_scores"]["held_out_perplexity"] is None
    assert result.status == "promoted"


def test_an_unreachable_teacher_leaves_the_adapter_pending_not_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    """Edge 19 — JUDGE MODE ONLY. "An unreachable judge must never be read as a failing
    score." Rejecting here would destroy a good Adapter because a network was down."""
    from armada_forge.teacher import TeacherUnreachable

    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path), tmp_path))
    teacher = ScriptedTeacher(raises=TeacherUnreachable("teacher endpoint is unreachable"))

    result = _gate(db, monkeypatch, mode="judge", teacher=teacher, exporter=exporter).run(ADAPTER_ID)

    assert result.status == "pending_eval"
    assert db.adapter["status"] == "pending_eval"
    assert exporter.registered == []

    # R36 — the error is recorded ON THE EVALUATIONS ROW, and `passed` is null exactly when
    # `completed` is false. Migration 003 enforces the same pairing as a CHECK.
    row = db.evaluations[0]
    assert row["completed"] is False
    assert row["passed"] is None
    assert "unreachable" in row["error"]


def test_a_judge_aborting_on_unparseable_verdicts_leaves_the_adapter_pending(
    tmp_path: Path, monkeypatch
) -> None:
    """Edge 20 — more than half unparseable means the gate measured nothing."""
    exporter = FakeExporter()
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path, 4), tmp_path))
    teacher = ScriptedTeacher(["junk"])

    result = _gate(db, monkeypatch, mode="judge", teacher=teacher, exporter=exporter).run(ADAPTER_ID)

    assert result.status == "pending_eval"
    row = db.evaluations[0]
    assert row["completed"] is False
    assert row["judge_errors"] == 4, "the recorded count must reflect what happened, not 0"


def test_judge_mode_still_generates_locally(tmp_path: Path, monkeypatch) -> None:
    """R34b — only the JUDGEMENT costs. Generation stays in-process and free on both sides,
    so `armada-models` is uninvolved in judge mode too."""
    db = FakeDB(_adapter_row("quality", _write_eval_split(tmp_path, 4), tmp_path))
    teacher = ScriptedTeacher(["A: pass\nB: pass"])

    _gate(db, monkeypatch, mode="judge", teacher=teacher).run(ADAPTER_ID)

    candidate, baseline = FakeScorer.instances
    assert candidate.generated == baseline.generated == 4
    # R34b — perplexity is NOT computed in judge mode, so neither side is scored.
    assert candidate.scored == baseline.scored == 0


# ── R35d: the limitations are exported, not left to the UI to invent ────────

def test_the_mechanical_gate_reports_both_recorded_limitations() -> None:
    """R35d — an operator reading a passing gate must see what it did and did not measure."""
    from armada_forge import eval as eval_pkg

    ids = {item["id"] for item in eval_pkg.limitations("mechanical")}
    assert ids == {"unquantized_artifact", "in_distribution_split"}


def test_judge_mode_does_not_claim_the_perplexity_limitation() -> None:
    """R35c is specifically about held_out_perplexity, which judge mode does not compute."""
    from armada_forge import eval as eval_pkg

    ids = {item["id"] for item in eval_pkg.limitations("judge")}
    assert ids == {"unquantized_artifact"}
