"""Adapter listing and manual promotion — Training R29, R30, R30a, R35d, R37; edges 13, 14.

`POST /adapters/{adapter_id}/promote` EXISTS FOR EXACTLY ONE SITUATION (R30a): an Adapter
whose evaluation PASSED and whose REGISTRATION failed — edge 14's unreachable
`armada-models`. It is not a way to promote something the gate rejected, and it is not a way
to skip the gate. R30a therefore refuses with HTTP 409 for an Adapter already `promoted` or
`rejected`, naming the current status, and R37 refuses a smoke Adapter on this route as
firmly as on the automatic one.

`GET /adapters` and `GET /adapters/{id}` land in this phase rather than in P9 for build-plan
Req 21's reason: an endpoint ships with its consumer, and the ModelsPage adapter table is
P11. `GET /adapters/{id}` carries `limitations`, which is R35d's forge-side half — an
operator reading a passing mechanical gate must be able to see that the scored artifact was
unquantized and that the held-out set came from the training distribution, without
consulting the spec.
"""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, HTTPException

from armada_forge import db, eval as eval_pkg

router = APIRouter()

_gate_factory: Callable[[], Any] | None = None
_eval_mode: str = eval_pkg.MECHANICAL


def configure(gate_factory: Callable[[], Any], eval_mode: str) -> None:
    global _gate_factory, _eval_mode
    _gate_factory = gate_factory
    _eval_mode = eval_mode


def _adapter_or_404(adapter_id: str) -> dict[str, Any]:
    row = db.query_one(
        """
        SELECT a.*, tr.run_kind, tr.backend, tr.dataset_id
          FROM adapters a
          JOIN training_runs tr ON tr.training_run_id = a.training_run_id
         WHERE a.adapter_id = %s
        """,
        (adapter_id,),
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no Adapter with adapter_id {adapter_id}")
    return row


@router.get("/adapters")
def list_adapters(limit: int = 200) -> list[dict[str, Any]]:
    """Build-plan Req 22 — the ModelsPage adapter table's source."""
    return db.query(
        """
        SELECT a.adapter_id, a.training_run_id, a.base_model_id, a.corpus_name, a.version,
               a.status, a.artifact_path, a.error, a.created_at,
               tr.run_kind, tr.backend,
               e.evaluation_id, e.mode AS eval_mode, e.completed AS eval_completed,
               e.passed AS eval_passed
          FROM adapters a
          JOIN training_runs tr ON tr.training_run_id = a.training_run_id
          LEFT JOIN LATERAL (
              SELECT * FROM evaluations ev
               WHERE ev.adapter_id = a.adapter_id
               ORDER BY ev.evaluated_at DESC
               LIMIT 1
          ) e ON true
         ORDER BY a.created_at DESC
         LIMIT %s
        """,
        (max(1, min(limit, 500)),),
    )


@router.get("/adapters/{adapter_id}")
def get_adapter(adapter_id: str) -> dict[str, Any]:
    adapter = _adapter_or_404(adapter_id)

    evaluation = db.query_one(
        "SELECT * FROM evaluations WHERE adapter_id = %s ORDER BY evaluated_at DESC LIMIT 1",
        (adapter_id,),
    )

    # Edge 25 — a smoke Adapter has NO evaluations row at all. Reported as an explicit
    # reason rather than as a null evaluation, because "not evaluated because it could
    # never be promoted" and "not evaluated yet" are different states an operator must be
    # able to tell apart.
    if evaluation is None and adapter["run_kind"] == "smoke":
        return {
            **adapter,
            "evaluation": None,
            "evaluation_skipped_reason": (
                "smoke runs are not promotable (R37), so the gate rejected this Adapter "
                "before performing any evaluation work (R33b). No completions were "
                "generated and no judge call was issued."
            ),
            "limitations": [],
        }

    return {
        **adapter,
        "evaluation": evaluation,
        # R35d — surfaced alongside the scores. The mode comes from the evaluation row
        # when one exists, so a gate run under a different config than the one currently
        # loaded still reports the limitations that actually applied to it.
        "limitations": eval_pkg.limitations(
            str(evaluation["mode"]) if evaluation else _eval_mode
        ),
    }


@router.post("/adapters/{adapter_id}/promote", status_code=200)
def promote_adapter(adapter_id: str) -> dict[str, Any]:
    """R30a — re-run promotion for an Adapter left `pending_eval` by a failed registration."""
    adapter = _adapter_or_404(adapter_id)
    status = adapter["status"]

    # R30a — 409 NAMING THE CURRENT STATUS. Both terminal statuses are refused, and for
    # different reasons that the message states rather than leaving the operator to guess.
    if status == "promoted":
        raise HTTPException(
            status_code=409,
            detail=f"Adapter {adapter_id} is already `promoted`; there is nothing to re-run",
        )
    if status == "rejected":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Adapter {adapter_id} is `rejected` and cannot be promoted. Rejection is "
                "terminal: either the evaluation gate found it worse than its BaseModel, or "
                "it came from a smoke run, which R37 makes permanently unpromotable."
            ),
        )

    # R37 on this route too. Unreachable in practice — R33b sets a smoke Adapter `rejected`
    # and the check above already refuses that — but stated here so the rule is enforced by
    # the route rather than only by the state a previous step happened to leave behind.
    if adapter["run_kind"] == "smoke":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Adapter {adapter_id} came from a run with `run_kind: smoke` and is never "
                "promotable (R37), by this route or any other"
            ),
        )

    if _gate_factory is None:
        raise HTTPException(status_code=503, detail="the evaluation gate is not configured")

    result = _gate_factory().promote(adapter_id)
    if result.status != "promoted":
        # Edge 13 leaves it `rejected`, edge 14 leaves it `pending_eval`. The status code
        # distinguishes them: 409 is terminal, 503 is retryable.
        raise HTTPException(
            status_code=409 if result.status == "rejected" else 503,
            detail=result.detail,
        )

    return {"adapter_id": adapter_id, "status": result.status, "detail": result.detail}
