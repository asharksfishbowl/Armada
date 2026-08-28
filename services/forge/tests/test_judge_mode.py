"""P11 — judge mode. Training R34b, R34c, R34d; edges 19, 20.

NOT THE DEFAULT PATH, and every test here is about a property that cannot be observed by
running the gate once and looking at the number:

  R34c  position bias is neutralised by ORDER, not by hoping the judge is fair.
  R34d  teacher spend is bounded AND the bounded subset is deterministic, so a re-run
        cannot be used to resample until a borderline Adapter passes.
  edge 19/20  an absent judgement is not a failing judgement.
"""

from __future__ import annotations

from typing import Any

import pytest

from armada_forge.eval import judge as judge_mode
from armada_forge.teacher import TeacherUnreachable


class FakeTeacher:
    """Records every call and answers from a script."""

    def __init__(self, replies: list[str] | str, raises: Exception | None = None) -> None:
        self._replies = replies if isinstance(replies, list) else None
        self._reply = replies if isinstance(replies, str) else None
        self._raises = raises
        self.calls: list[list[dict[str, str]]] = []

    def complete(self, messages: list[dict[str, str]], temperature: float = 0.0) -> str:
        if self._raises is not None:
            raise self._raises
        self.calls.append(messages)
        if self._replies is not None:
            return self._replies[len(self.calls) - 1]
        assert self._reply is not None
        return self._reply


def _samples(count: int) -> list[dict[str, Any]]:
    return [{"instruction": f"q{i}", "response": f"ref{i}"} for i in range(count)]


def _run(
    teacher: FakeTeacher,
    count: int = 4,
    max_eval_samples: int = 200,
    adapter_id: str = "adapter-1",
) -> judge_mode.JudgeOutcome:
    return judge_mode.judge(
        teacher,  # type: ignore[arg-type]
        "the rubric",
        adapter_id,
        _samples(count),
        [f"CANDIDATE{i}" for i in range(count)],
        [f"BASELINE{i}" for i in range(count)],
        max_eval_samples,
    )


# ── R34d: the spend bound, and its determinism ──────────────────────────────

def test_at_most_max_eval_samples_calls_are_issued() -> None:
    """R34d — a hard bound on teacher spend per gate."""
    teacher = FakeTeacher("A: pass\nB: pass")
    _run(teacher, count=50, max_eval_samples=10)
    assert len(teacher.calls) == 10


def test_the_bounded_subset_is_deterministic_on_adapter_id() -> None:
    """The acceptance criterion: "re-running the gate for the same adapter_id scores the
    IDENTICAL sample subset".

    Without this, a borderline Adapter could be pushed through by re-running until a
    friendlier subset came up.
    """
    first = judge_mode.select_indices(100, "adapter-1", 10)
    second = judge_mode.select_indices(100, "adapter-1", 10)
    assert first == second
    assert len(first) == 10


def test_a_different_adapter_gets_a_different_subset() -> None:
    """Seeded on adapter_id, so two Adapters are not scored on the same ten samples by
    accident."""
    assert judge_mode.select_indices(100, "adapter-1", 10) != judge_mode.select_indices(
        100, "adapter-2", 10
    )


def test_a_held_out_set_under_the_bound_is_used_whole() -> None:
    assert judge_mode.select_indices(5, "adapter-1", 200) == [0, 1, 2, 3, 4]


# ── R34c: position bias ──────────────────────────────────────────────────────

def test_candidate_and_baseline_alternate_positions_by_sample_index() -> None:
    """R34c — deterministic alternation, not a coin.

    A random coin could, on a small held-out set, hand one model the first slot throughout
    — which is the bias the requirement exists to remove.
    """
    teacher = FakeTeacher("A: pass\nB: pass")
    _run(teacher, count=4)

    first_slots = []
    for call in teacher.calls:
        body = call[1]["content"]
        completion_a = body.split("COMPLETION A:\n")[1].split("\n\nCOMPLETION B:")[0]
        first_slots.append("CANDIDATE" if completion_a.startswith("CANDIDATE") else "BASELINE")

    assert first_slots == ["CANDIDATE", "BASELINE", "CANDIDATE", "BASELINE"]


def test_the_verdict_is_attributed_to_the_right_model_in_both_orders() -> None:
    """The alternation is only useful if the un-swap is correct. A verdict attributed to
    the wrong model would make the bias correction actively harmful.
    """
    # Sample 0 shows candidate first, sample 1 shows baseline first. In both, only the
    # CANDIDATE passes.
    teacher = FakeTeacher(["A: pass\nB: fail", "A: fail\nB: pass"])
    outcome = _run(teacher, count=2)

    assert outcome.candidate_pass_rate == 1.0
    assert outcome.baseline_pass_rate == 0.0


def test_both_models_are_graded_independently_not_compared() -> None:
    """R34c — "a verdict per completion, not a preference between them". A preference
    cannot be checked against R35's "at least as good as", which needs two scores."""
    teacher = FakeTeacher("A: pass\nB: pass")
    outcome = _run(teacher, count=4)
    assert outcome.candidate_pass_rate == outcome.baseline_pass_rate == 1.0


# ── Edge 20: unparseable verdicts ───────────────────────────────────────────

def test_an_unparseable_verdict_is_excluded_from_both_denominators() -> None:
    """Edge 20 — counted in `judge_errors`, not scored as a failure for either model."""
    # Samples 0 and 2 show the candidate first, sample 3 shows the baseline first — so the
    # replies below make the CANDIDATE pass every scored sample under both orderings.
    teacher = FakeTeacher(["A: pass\nB: fail", "nonsense", "A: pass\nB: fail", "A: fail\nB: pass"])
    outcome = _run(teacher, count=4)

    assert outcome.judge_errors == 1
    assert outcome.samples_evaluated == 3
    assert outcome.candidate_pass_rate == 1.0
    assert outcome.baseline_pass_rate == 0.0


def test_more_than_half_unparseable_aborts_the_gate() -> None:
    """Edge 20 — at that point the gate has measured nothing, so it did not COMPLETE, and
    R35 leaves the Adapter at pending_eval rather than rejecting it."""
    teacher = FakeTeacher(["junk", "junk", "junk", "A: pass\nB: pass"])

    with pytest.raises(judge_mode.JudgeAborted) as caught:
        _run(teacher, count=4)

    assert caught.value.errors == 3
    assert caught.value.attempted == 4


def test_exactly_half_unparseable_does_not_abort() -> None:
    """"exceeds half", not "reaches half". An off-by-one here silently changes which
    Adapters get a verdict at all."""
    teacher = FakeTeacher(["junk", "junk", "A: pass\nB: fail", "A: pass\nB: fail"])
    outcome = _run(teacher, count=4)
    assert outcome.judge_errors == 2


# ── Edge 19: an unreachable teacher is not a failing score ──────────────────

def test_an_unreachable_teacher_propagates_rather_than_scoring_zero() -> None:
    """Edge 19 — "an unreachable judge must never be read as a failing score". Scoring it
    as 0 would reject a good Adapter because a network was down."""
    teacher = FakeTeacher("", raises=TeacherUnreachable("endpoint down"))

    with pytest.raises(TeacherUnreachable):
        _run(teacher, count=4)


# ── Verdict parsing ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "reply,expected",
    [
        ("A: pass\nB: fail", (True, False)),
        ("a: PASS\nb: FAIL", (True, False)),
        ("  A:  passes the rubric \n  B: failed ", (True, False)),
        ("A: pass", None),
        ("B: fail", None),
        ("A: maybe\nB: pass", None),
        ("", None),
    ],
)
def test_verdict_parsing(reply: str, expected: tuple[bool, bool] | None) -> None:
    assert judge_mode._parse_verdicts(reply) == expected
