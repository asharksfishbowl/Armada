"""Judge mode — Training R34b, R34c, R34d; edges 19 and 20.

NOT THE DEFAULT, AND THE ONLY GATE THAT CAN SPEND. It requires
`config/teacher.yaml` `enabled: true`, and selecting it against a disabled teacher fails
STARTUP naming both settings (config.py, edge 26) rather than deferring the failure until
after a training run has been paid for.

THREE PROPERTIES ARE BUILT IN RATHER THAN HOPED FOR:

  R34c  position bias. Candidate and baseline completions are presented in a single call,
        and their ORDER is decided by the parity of the sample index. A judge that
        systematically prefers whichever completion it reads first therefore favours each
        model on half the samples instead of favouring one throughout. The judge returns a
        VERDICT PER COMPLETION, not a preference between them — a preference cannot be
        compared against R35's "at least as good as", which needs two independent scores.
  R34d  spend bound. At most `max_eval_samples` calls, and when the held-out set is larger
        the subset is DETERMINISTIC, seeded on `adapter_id`. Re-running the gate for the
        same Adapter scores the identical samples, so a re-run cannot be used to resample
        until a borderline Adapter passes.
  edge 20  an unparseable verdict excludes that sample from BOTH denominators and counts in
        `judge_errors`. When `judge_errors` exceeds half the evaluated samples the gate
        ABORTS and the Adapter stays `pending_eval`, because at that point the gate has not
        measured anything.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from armada_forge.teacher import TeacherClient, TeacherUnreachable

JUDGE_SYSTEM = (
    "You grade model completions against a rubric. You are shown one instruction, one "
    "reference response, and two candidate completions labelled A and B. Grade EACH "
    "completion independently as pass or fail against the rubric. Do not state a "
    "preference between them. Reply with exactly two lines:\nA: pass|fail\nB: pass|fail"
)


class JudgeAborted(Exception):
    """Edge 20 — more than half the samples produced an unparseable verdict.

    The gate did not complete. R35 leaves the Adapter at `pending_eval` rather than
    rejecting it: an absent judgement is not a failing judgement.

    Carries `errors` and `attempted` so R36's `judge_errors` column records what actually
    happened rather than 0. A row saying the gate failed with zero judge errors would be a
    contradiction on its face.
    """

    def __init__(self, message: str, errors: int, attempted: int) -> None:
        self.errors = errors
        self.attempted = attempted
        super().__init__(message)


@dataclass(frozen=True)
class JudgeOutcome:
    candidate_pass_rate: float | None
    baseline_pass_rate: float | None
    samples_evaluated: int
    judge_errors: int


def select_indices(sample_count: int, adapter_id: str, max_eval_samples: int) -> list[int]:
    """R34d — at most `max_eval_samples` INDICES, chosen deterministically from `adapter_id`.

    Indices rather than samples, because R34c's ordering rule keys on the sample INDEX and
    the caller also needs to line each selected sample up with its two completions. Handing
    back sliced dicts would force the caller to search for each one's original position,
    which is both quadratic and ambiguous when two samples are identical.

    Ordered by a hash rather than by `random.sample` so the selection is stable across
    interpreter versions and PRNG changes. "Re-running the gate scores the identical
    subset" has to hold across a container rebuild, not just within one process.
    """
    if max_eval_samples <= 0 or sample_count <= max_eval_samples:
        return list(range(sample_count))
    ranked = sorted(
        range(sample_count),
        key=lambda index: hashlib.sha256(f"{adapter_id}:{index}".encode()).hexdigest(),
    )
    return sorted(ranked[:max_eval_samples])


def _parse_verdicts(reply: str) -> tuple[bool, bool] | None:
    """`A: pass\\nB: fail` into (a_passed, b_passed), or None when unparseable."""
    found: dict[str, bool] = {}
    for line in reply.splitlines():
        stripped = line.strip().lower()
        for label in ("a", "b"):
            if stripped.startswith(f"{label}:"):
                verdict = stripped.split(":", 1)[1].strip()
                if verdict.startswith("pass"):
                    found[label] = True
                elif verdict.startswith("fail"):
                    found[label] = False
    if "a" in found and "b" in found:
        return found["a"], found["b"]
    return None


def judge(
    client: TeacherClient,
    rubric: str,
    adapter_id: str,
    samples: list[dict[str, Any]],
    candidate_completions: list[str],
    baseline_completions: list[str],
    max_eval_samples: int,
) -> JudgeOutcome:
    """R34b — one teacher call per held-out sample, returning a verdict per completion."""
    selected_indices = select_indices(len(samples), adapter_id, max_eval_samples)

    candidate_passes = 0
    baseline_passes = 0
    scored = 0
    errors = 0

    for index in selected_indices:
        sample = samples[index]

        # R34c — order by the PARITY OF THE SAMPLE INDEX, not at random. Deterministic
        # alternation gives each model the first slot on exactly half the samples; a random
        # coin could, on a small held-out set, hand one model the first slot throughout.
        candidate_first = index % 2 == 0
        first = candidate_completions[index] if candidate_first else baseline_completions[index]
        second = baseline_completions[index] if candidate_first else candidate_completions[index]

        try:
            reply = client.complete([
                {"role": "system", "content": JUDGE_SYSTEM},
                {
                    "role": "user",
                    "content": (
                        f"RUBRIC:\n{rubric}\n\n"
                        f"INSTRUCTION:\n{sample.get('instruction', '')}\n\n"
                        f"REFERENCE RESPONSE:\n{sample.get('response', '')}\n\n"
                        f"COMPLETION A:\n{first}\n\nCOMPLETION B:\n{second}"
                    ),
                },
            ])
        except TeacherUnreachable:
            # Edge 19 — propagated, not counted as a failing verdict. The caller leaves the
            # Adapter at `pending_eval` so the operator can retry once the teacher is back.
            raise

        verdicts = _parse_verdicts(reply)
        if verdicts is None:
            # Edge 20 — excluded from BOTH denominators, counted here.
            errors += 1
            continue

        first_passed, second_passed = verdicts
        candidate_passed = first_passed if candidate_first else second_passed
        baseline_passed = second_passed if candidate_first else first_passed

        scored += 1
        candidate_passes += int(candidate_passed)
        baseline_passes += int(baseline_passed)

    if errors > len(selected_indices) / 2:
        raise JudgeAborted(
            f"the judge returned an unparseable verdict for {errors} of "
            f"{len(selected_indices)} samples, which is more than half; the gate did not "
            "complete and the Adapter is left at pending_eval",
            errors=errors,
            attempted=len(selected_indices),
        )

    return JudgeOutcome(
        candidate_pass_rate=candidate_passes / scored if scored else None,
        baseline_pass_rate=baseline_passes / scored if scored else None,
        samples_evaluated=scored,
        judge_errors=errors,
    )
