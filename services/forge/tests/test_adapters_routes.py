"""P11 — GET /adapters and POST /adapters/{id}/promote. Training R30a, R35d, R37; edge 25.

R30a EXISTS FOR EXACTLY ONE SITUATION: an Adapter whose evaluation PASSED and whose
REGISTRATION failed — edge 14's unreachable `armada-models`. It is not a way to promote
something the gate rejected and not a way to skip the gate, so both terminal statuses are
refused with HTTP 409 NAMING THE CURRENT STATUS.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from armada_forge import adapters

ADAPTER_ID = "aaaaaaaa-0000-0000-0000-000000000001"


class FakeDB:
    def __init__(self, adapter: dict[str, Any] | None, evaluation: dict[str, Any] | None = None) -> None:
        self.adapter = adapter
        self.evaluation = evaluation

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        if "FROM evaluations" in sql:
            return self.evaluation
        return self.adapter

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return []


class FakeGate:
    def __init__(self, status: str = "promoted", detail: str = "registered") -> None:
        self.result = type("R", (), {"status": status, "detail": detail})()
        self.promoted: list[str] = []

    def promote(self, adapter_id: str) -> Any:
        self.promoted.append(adapter_id)
        return self.result


def _adapter(status: str, run_kind: str = "quality") -> dict[str, Any]:
    return {
        "adapter_id": ADAPTER_ID, "base_model_id": "qwen3-0.6b", "corpus_name": "recipes",
        "version": 1, "status": status, "artifact_path": "/data/adapters/x", "error": None,
        "run_kind": run_kind, "backend": "local", "dataset_id": "d",
    }


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    def setup(adapter: dict[str, Any] | None, evaluation: dict[str, Any] | None = None,
              gate_status: str = "promoted") -> FakeGate:
        monkeypatch.setattr(adapters, "db", FakeDB(adapter, evaluation))
        gate = FakeGate(gate_status)
        adapters.configure(lambda: gate, "mechanical")
        return gate

    return setup


# ── R30a: the two 409s ───────────────────────────────────────────────────────

def test_promoting_an_already_promoted_adapter_is_409_naming_the_status(wired) -> None:
    gate = wired(_adapter("promoted"))

    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)

    assert caught.value.status_code == 409
    assert "promoted" in caught.value.detail
    assert gate.promoted == [], "a refused promotion must not reach the gate"


def test_promoting_a_rejected_adapter_is_409_naming_the_status(wired) -> None:
    """Rejection is terminal. A retry route that could un-reject would make the gate
    advisory rather than a gate."""
    gate = wired(_adapter("rejected"))

    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)

    assert caught.value.status_code == 409
    assert "rejected" in caught.value.detail
    assert gate.promoted == []


def test_promoting_a_pending_eval_adapter_runs_the_gates_promotion(wired) -> None:
    """R30a's actual purpose — edge 14's retry."""
    gate = wired(_adapter("pending_eval"))

    result = adapters.promote_adapter(ADAPTER_ID)

    assert result["status"] == "promoted"
    assert gate.promoted == [ADAPTER_ID]


def test_an_unknown_adapter_is_404(wired) -> None:
    wired(None)
    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)
    assert caught.value.status_code == 404


# ── R37 on this route too ────────────────────────────────────────────────────

def test_a_smoke_adapter_left_pending_is_still_refused(wired) -> None:
    """R37 — "by this route or by POST /adapters/{adapter_id}/promote".

    Unreachable in practice, because R33b already sets a smoke Adapter `rejected`. Stated
    here so the rule is enforced BY THE ROUTE rather than only by the state a previous step
    happened to leave behind — which is how a constraint ends up enforced in two places out
    of three.
    """
    gate = wired(_adapter("pending_eval", run_kind="smoke"))

    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)

    assert caught.value.status_code == 409
    assert "smoke" in caught.value.detail
    assert gate.promoted == []


# ── Edges 13 and 14 surface as different status codes ───────────────────────

def test_a_conversion_failure_surfaces_as_409(wired) -> None:
    """Edge 13 — terminal. Retrying the same inputs against the same image cannot help."""
    wired(_adapter("pending_eval"), gate_status="rejected")

    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)

    assert caught.value.status_code == 409


def test_an_unreachable_model_server_surfaces_as_503(wired) -> None:
    """Edge 14 — retryable. The artifact is fine and the environment is not, and a 409
    would tell the operator to stop trying."""
    wired(_adapter("pending_eval"), gate_status="pending_eval")

    with pytest.raises(HTTPException) as caught:
        adapters.promote_adapter(ADAPTER_ID)

    assert caught.value.status_code == 503


# ── R35d / edge 25: what GET /adapters/{id} tells the operator ──────────────

def test_a_smoke_adapter_reports_why_it_was_never_evaluated(wired) -> None:
    """Edge 25 — a smoke Adapter has NO evaluations row.

    Reported as an explicit reason rather than as a null evaluation, because "not evaluated
    because it could never be promoted" and "not evaluated yet" are different states an
    operator must be able to tell apart.
    """
    wired(_adapter("rejected", run_kind="smoke"), evaluation=None)

    body = adapters.get_adapter(ADAPTER_ID)

    assert body["evaluation"] is None
    assert "not promotable" in body["evaluation_skipped_reason"]


def test_an_evaluated_adapter_carries_the_recorded_limitations(wired) -> None:
    """R35d — surfaced alongside the scores, so an operator reading a passing mechanical
    gate can see what it did and did not measure."""
    wired(
        _adapter("promoted"),
        evaluation={"mode": "mechanical", "passed": True, "completed": True},
    )

    body = adapters.get_adapter(ADAPTER_ID)

    ids = {item["id"] for item in body["limitations"]}
    assert ids == {"unquantized_artifact", "in_distribution_split"}


def test_the_limitations_follow_the_evaluations_row_not_current_config(wired) -> None:
    """A gate run under a different config than the one currently loaded must still report
    the limitations that actually applied to IT."""
    wired(
        _adapter("promoted"),
        evaluation={"mode": "judge", "passed": True, "completed": True},
    )

    body = adapters.get_adapter(ADAPTER_ID)

    assert {item["id"] for item in body["limitations"]} == {"unquantized_artifact"}
