"""Training run orchestration and routes — Training R26, R27, R28, R29, R33a; edges 7, 11, 12.

WHAT R33a DECIDES, AND WHY IT LOOKS INCONSISTENT UNTIL YOU SEE IT: a run that COULD produce
a promotable Adapter is refused without a prior eval split; a run that could NOT is accepted
without one. The split exists solely to gate promotion, and a smoke run is never promotable
(R37), so requiring a split for one would block the zero-cost path on a file that could
never be used. This is also what lets a trajectory-only dataset — which by R33 can never be
split at all (edge 21) — still prove the pipeline end to end.

R27 — PROGRESS IS EVENT-DRIVEN. `LocalTrainingBackend` pushes through a TRL trainer
callback and this module blocks on a `threading.Event` that the callback sets; there is no
poll loop and no sleep on the local path. The remote path subscribes to the provider's
webhook when `config/training-remote.yaml` sets `webhook_url`, and falls back to the
PROVIDER'S OWN recommended interval only when it does not.

EDGE 12 — TWO CONCURRENT RUNS ON THE SAME (base_model_id, corpus_name) MUST GET DISTINCT
VERSIONS. The increment is serialised by a transaction-scoped advisory lock keyed on that
pair, and migration 003's unique index on (base_model_id, corpus_name, version) is the
backstop that turns a missed lock into a database error instead of two Adapters sharing a
ModelBinding tag.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from armada_forge import db
from armada_forge.datasets.builder import artifact_path as dataset_artifact_path
from armada_forge.progress import hub
from armada_forge.registry.models import TrainingEntry
from armada_forge.training import hardware
from armada_forge.training.backend import (
    JobStatus,
    TrainingBackend,
    TrainingConfig,
    TrainingConfigRejected,
)
from armada_forge.training.local_backend import LocalTrainingBackend
from armada_forge.training.remote_backend import RemoteSettings, RemoteTrainingBackend

router = APIRouter()

# Hyperparameter defaults for a run that names none. Sourced from
# config/training-remote.yaml's `defaults` block at configure() time; these are the
# fallbacks if that block is absent.
FALLBACK_DEFAULTS: dict[str, Any] = {
    "lora_rank": 16,
    "lora_alpha": 32,
    "learning_rate": 0.0002,
    "max_steps": 1000,
    "batch_size": 4,
    "max_seq_len": 2048,
}

_loop: asyncio.AbstractEventLoop | None = None
_entries: dict[str, TrainingEntry] = {}
_adapters_root = Path("/data/adapters")
_remote_settings: RemoteSettings | None = None
_gate_factory: Callable[[], Any] | None = None
_remote_backends: dict[str, RemoteTrainingBackend] = {}
# R27's event-driven remote path. The webhook route sets the Event; the tracking thread
# waits on it. No interval, no poll.
_webhook_terminal: dict[str, threading.Event] = {}
_webhook_status: dict[str, JobStatus] = {}


def configure(
    loop: asyncio.AbstractEventLoop,
    entries: dict[str, TrainingEntry],
    remote_settings: RemoteSettings,
    adapters_root: Path,
    gate_factory: Callable[[], Any],
) -> None:
    """Called once from the lifespan hook. Nothing here runs before startup completes."""
    global _loop, _remote_settings, _adapters_root, _gate_factory
    _loop = loop
    _remote_settings = remote_settings
    _adapters_root = adapters_root
    _gate_factory = gate_factory
    _entries.clear()
    _entries.update(entries)


class TrainingRunCreate(BaseModel):
    """R26 — backend, base_model_id, dataset_id, and optional hyperparameter overrides."""

    backend: str
    base_model_id: str
    dataset_id: str
    lora_rank: int | None = Field(default=None, ge=1, le=256)
    lora_alpha: int | None = Field(default=None, ge=1, le=1024)
    learning_rate: float | None = Field(default=None, gt=0, le=1)
    max_steps: int | None = Field(default=None, ge=1, le=1_000_000)
    batch_size: int | None = Field(default=None, ge=1, le=1024)
    max_seq_len: int | None = Field(default=None, ge=8, le=1_048_576)


def _emit(message: dict[str, Any]) -> None:
    """Build-plan Req 24/26 — training progress rides the forge channel built in P1.

    The envelope is Req 26's: `job_kind`, `job_id`, `status`, `progress`, `total`, and
    `message`. Req 27 makes REST authoritative for state and this channel authoritative
    only for increments, so a client that misses a frame has missed an increment, never a
    state transition it cannot recover by re-reading the resource.
    """
    if _loop is not None:
        hub.broadcast_threadsafe(_loop, message)


def _frame(training_run_id: str, status: JobStatus) -> dict[str, Any]:
    return {
        "channel": "job",
        "job_kind": "training",
        "job_id": training_run_id,
        "status": status.state,
        "progress": status.progress_steps,
        "total": status.total_steps,
        "message": status.message,
    }


def _build_backend(backend_name: str) -> TrainingBackend:
    if backend_name == "local":
        return LocalTrainingBackend(_entries, _adapters_root)
    assert _remote_settings is not None
    return RemoteTrainingBackend(_remote_settings, dataset_artifact_path)


def _effective_config(payload: TrainingRunCreate) -> TrainingConfig:
    defaults = dict(FALLBACK_DEFAULTS)
    if _remote_settings is not None and _remote_settings.defaults:
        defaults.update(_remote_settings.defaults)

    def pick(field: str) -> Any:
        override = getattr(payload, field)
        return defaults[field] if override is None else override

    return TrainingConfig(
        base_model_id=payload.base_model_id,
        dataset_id=payload.dataset_id,
        lora_rank=int(pick("lora_rank")),
        lora_alpha=int(pick("lora_alpha")),
        learning_rate=float(pick("learning_rate")),
        max_steps=int(pick("max_steps")),
        batch_size=int(pick("batch_size")),
        max_seq_len=int(pick("max_seq_len")),
    )


def promotable(backend_name: str, run_kind: str) -> bool:
    """R33a/R37 — could this run produce a promotable Adapter?

    A single predicate rather than an inline condition, because THREE places must agree on
    the answer: the split requirement here, R33b's short-circuit in the gate, and R37's
    refusal on the manual promote route. Three independent readings of "is this a smoke
    run" is exactly how a rule ends up enforced in two places out of three.
    """
    return not (backend_name == "local" and run_kind == hardware.SMOKE)


@router.post("/training/runs", status_code=202)
def start_training_run(payload: TrainingRunCreate) -> dict[str, Any]:
    """R26 — start a run. Returns BEFORE training completes."""
    if payload.backend not in ("local", "remote"):
        raise HTTPException(
            status_code=400,
            detail=f"backend `{payload.backend}` must be one of local, remote",
        )

    dataset = db.query_one(
        "SELECT dataset_id, artifact_path, eval_split_path FROM datasets WHERE dataset_id = %s",
        (payload.dataset_id,),
    )
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"no dataset with dataset_id {payload.dataset_id}")

    backend = _build_backend(payload.backend)
    config = _effective_config(payload)

    # Edges 7, 8, 26 — REFUSED BEFORE ANYTHING IS ALLOCATED, with the constraint named.
    # `validate` is called explicitly rather than relying on `submit` raising, because the
    # refusal has to become a 400 before a `training_runs` row is written: a rejected run
    # that left a row behind would show in the dashboard as a training run that never ran.
    if isinstance(backend, LocalTrainingBackend):
        try:
            backend.validate(config)
        except TrainingConfigRejected as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        entry = _entries.get(payload.base_model_id)
        if entry is None:
            raise HTTPException(
                status_code=400,
                detail=f"`{payload.base_model_id}` is not in config/base-models.yaml",
            )
        if not entry.trainable:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"`{entry.id}` has `trainable: false` in config/base-models.yaml and "
                    "cannot be used for a training run"
                ),
            )

    run_kind = backend.run_kind

    # R33a — the split requirement, and its deliberate exception.
    if promotable(payload.backend, run_kind) and not dataset.get("eval_split_path"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"dataset {payload.dataset_id} has no held-out evaluation split, and this "
                f"run ({payload.backend}/{run_kind}) could produce a promotable Adapter. "
                "Call POST /datasets/{dataset_id}/split first. A local smoke run is "
                "accepted without a split, because a smoke Adapter is never promotable."
            ),
        )

    config_record: dict[str, Any] = {"effective": config.as_dict()}
    if isinstance(backend, LocalTrainingBackend) and backend.mode == hardware.SMOKE:
        from armada_forge.training.local_backend import SMOKE_MAX_SAMPLES, clamp_for_smoke

        # R24a — BOTH the requested and the clamped value for all four caps.
        config_record["smoke_caps"] = clamp_for_smoke(config, SMOKE_MAX_SAMPLES)

    row = db.query_one(
        """
        INSERT INTO training_runs (backend, run_kind, base_model_id, dataset_id, config,
                                   status, total_steps)
        VALUES (%s, %s, %s, %s, %s, 'queued', %s)
        RETURNING training_run_id
        """,
        (
            payload.backend,
            run_kind,
            payload.base_model_id,
            payload.dataset_id,
            json.dumps(config_record),
            config.max_steps,
        ),
    )
    assert row is not None
    training_run_id = str(row["training_run_id"])

    threading.Thread(
        target=_run_training,
        args=(training_run_id, backend, config),
        name=f"training-{training_run_id[:8]}",
        daemon=True,
    ).start()

    return {
        "training_run_id": training_run_id,
        "backend": payload.backend,
        "run_kind": run_kind,
        "status": "queued",
        # Stated in the response rather than left for the operator to infer from `run_kind`.
        # A smoke run that produced an Adapter and then rejected it looks like a bug unless
        # you already knew it could never be promoted.
        "promotable": promotable(payload.backend, run_kind),
    }


def _record_status(training_run_id: str, status: JobStatus) -> None:
    db.execute(
        """
        UPDATE training_runs
           SET status = %s, progress_steps = %s,
               total_steps = GREATEST(total_steps, %s),
               error = %s,
               ended_at = CASE WHEN %s THEN now() ELSE ended_at END
         WHERE training_run_id = %s
        """,
        (
            status.state,
            status.progress_steps,
            status.total_steps,
            status.message if status.state == "failed" else None,
            status.terminal,
            training_run_id,
        ),
    )
    _emit(_frame(training_run_id, status))


def _run_training(training_run_id: str, backend: TrainingBackend, config: TrainingConfig) -> None:
    """Drive one run to a terminal state, then create the Adapter and run the gate."""
    finished = threading.Event()
    final: dict[str, JobStatus] = {}

    try:
        handle = backend.submit(config)
    except TrainingConfigRejected as exc:
        # Reachable only for the remote backend's own refusals (edge 9) — the local ones
        # were already turned into a 400 above.
        _record_status(training_run_id, JobStatus(state="failed", message=str(exc)))
        return
    except Exception as exc:  # noqa: BLE001 - any submission failure is a failed run
        _record_status(training_run_id, JobStatus(state="failed", message=f"{type(exc).__name__}: {exc}"))
        return

    db.execute(
        "UPDATE training_runs SET backend_handle = %s, status = 'running' WHERE training_run_id = %s",
        (handle, training_run_id),
    )

    if isinstance(backend, LocalTrainingBackend):
        # R27 — EVENT-DRIVEN. The TRL callback pushes here; nothing polls.
        #
        # TERMINATION IS RECORDED EXACTLY ONCE. There are two ways this run can be observed
        # terminal — the listener firing, and the catch-up poll below — and they race: a
        # trainer that fails in microseconds sets `job.state` before its callback runs, so
        # the poll can see `failed` first and the callback then arrives afterwards. Without
        # the `finished` guard that late callback writes the terminal row a second time,
        # AFTER `_on_succeeded` has already run, and emits a duplicate progress frame the
        # dashboard would render as a second termination.
        def on_status(status: JobStatus) -> None:
            if finished.is_set():
                return
            _record_status(training_run_id, status)
            if status.terminal:
                final["status"] = status
                finished.set()

        backend.on_progress(handle, on_status)
        # The job may already have finished between submit() and the listener registering.
        current = backend.poll(handle)
        if current.terminal and not finished.is_set():
            final["status"] = current
            _record_status(training_run_id, current)
            finished.set()
        finished.wait()
    else:
        final["status"] = _await_remote(training_run_id, backend, handle)

    status = final["status"]
    if status.state != "succeeded":
        return

    _on_succeeded(training_run_id, backend, handle)


def _await_remote(
    training_run_id: str, backend: RemoteTrainingBackend, handle: str
) -> JobStatus:
    """R27 — the webhook when the provider offers one, its recommended interval otherwise.

    A provider with `webhook_url` set pushes to `POST /training/runs/{id}/webhook`, and this
    function then simply waits for that route to drive the run terminal. Only a provider
    that offers no webhook is polled, and the interval is the PROVIDER'S OWN
    `poll_after_seconds` rather than a number invented here.
    """
    _remote_backends[training_run_id] = backend

    if backend.settings.webhook_url:
        # Event-driven. `_webhook_terminal` is set by the route when a pushed update is
        # terminal, so nothing here spins or sleeps on an interval.
        event = _webhook_terminal.setdefault(training_run_id, threading.Event())
        event.wait()
        return _webhook_status.get(training_run_id, JobStatus(state="failed", message="no status"))

    while True:
        status = backend.poll(handle)
        _record_status(training_run_id, status)
        if status.terminal:
            return status
        time.sleep(backend.poll_interval_seconds(handle))


def _next_version(base_model_id: str, corpus_name: str) -> int:
    """Edge 12 — a transactional increment on (base_model_id, corpus_name).

    The advisory lock is transaction-scoped and keyed on the PAIR, so two runs on the same
    base model with different corpora do not contend, and each sequence starts at 1
    independently. Migration 003's unique index remains the backstop.
    """
    with db.connection() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{base_model_id}:{corpus_name}",)
        )
        cur.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM adapters "
            "WHERE base_model_id = %s AND corpus_name = %s",
            (base_model_id, corpus_name),
        )
        row = cur.fetchone()
        return int(row["next"]) if row else 1


def _on_succeeded(training_run_id: str, backend: TrainingBackend, handle: str) -> None:
    """R29 — fetch artifacts, insert the `adapters` row, then run the gate.

    Takes no TrainingConfig. Everything it needs — the base model, the dataset, and the
    `corpus_name` R29 records on the Adapter — is read back from the persisted
    `training_runs` row, which is the authoritative record of what actually ran. Passing
    the config in as well would give this function two sources for the same facts, and
    the re-attach path (edge 11) would have to reconstruct one from jsonb to satisfy a
    parameter it never reads.
    """
    run = db.query_one(
        """
        SELECT tr.base_model_id, tr.dataset_id, d.source_breakdown
          FROM training_runs tr
          LEFT JOIN datasets d ON d.dataset_id = tr.dataset_id
         WHERE tr.training_run_id = %s
        """,
        (training_run_id,),
    )
    assert run is not None

    breakdown = run.get("source_breakdown") or {}
    if isinstance(breakdown, str):
        breakdown = json.loads(breakdown)
    corpus_name = str(breakdown.get("corpus_name") or "base")

    adapter_id = str(uuid.uuid4())
    dest = _adapters_root / adapter_id

    try:
        backend.fetch_artifacts(handle, dest)
    except Exception as exc:  # noqa: BLE001 - no artifacts means no Adapter
        _record_status(
            training_run_id,
            JobStatus(state="failed", message=f"artifact fetch failed: {type(exc).__name__}: {exc}"),
        )
        return

    version = _next_version(run["base_model_id"], corpus_name)
    db.execute(
        """
        INSERT INTO adapters (adapter_id, training_run_id, base_model_id, corpus_name,
                              version, status, artifact_path)
        VALUES (%s, %s, %s, %s, %s, 'pending_eval', %s)
        """,
        (adapter_id, training_run_id, run["base_model_id"], corpus_name, version, str(dest)),
    )

    # Data flow 16 — the gate decides. For a smoke run it short-circuits at R33b without
    # generating anything, which is why this is called unconditionally rather than guarded
    # by a second run_kind check here: one place decides, and `promotable()` above is what
    # keeps the three readings of that question in agreement.
    if _gate_factory is None:
        return
    try:
        _gate_factory().run(adapter_id)
    except Exception:  # noqa: BLE001 - a gate crash must not lose the Adapter row
        print(f"\n❌ armada-forge: evaluation gate raised for adapter {adapter_id}:\n{traceback.format_exc()}\n")


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("/training/runs")
def list_training_runs(limit: int = 100) -> list[dict[str, Any]]:
    """Build-plan Req 22 — moved to this phase because its producer and its consumers are
    both here."""
    return db.query(
        """
        SELECT training_run_id, backend, run_kind, base_model_id, dataset_id, config,
               status, progress_steps, total_steps, backend_handle, error,
               started_at, ended_at
          FROM training_runs
         ORDER BY started_at DESC
         LIMIT %s
        """,
        (max(1, min(limit, 500)),),
    )


@router.get("/training/runs/{training_run_id}")
def get_training_run(training_run_id: str) -> dict[str, Any]:
    row = db.query_one(
        "SELECT * FROM training_runs WHERE training_run_id = %s", (training_run_id,)
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no training run {training_run_id}")
    row["adapters"] = db.query(
        "SELECT adapter_id, status, version, corpus_name, error FROM adapters "
        "WHERE training_run_id = %s",
        (training_run_id,),
    )
    return row


@router.post("/training/runs/{training_run_id}/webhook", status_code=202)
def training_webhook(training_run_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """R27 — the event-driven remote path.

    Only reaches a run whose backend is `remote` AND whose handle matches the one this
    service recorded. A body naming an unknown run, or one whose `handle` disagrees with
    the persisted `backend_handle`, is refused: this endpoint takes an unauthenticated POST
    on a trusted network, and matching the handle keeps it from being usable to drive an
    arbitrary run to an arbitrary state.
    """
    run = db.query_one(
        "SELECT backend, backend_handle FROM training_runs WHERE training_run_id = %s",
        (training_run_id,),
    )
    if run is None:
        raise HTTPException(status_code=404, detail=f"no training run {training_run_id}")
    if run["backend"] != "remote":
        raise HTTPException(
            status_code=409,
            detail="webhook updates apply only to a run with `backend: remote`",
        )
    if not run["backend_handle"] or body.get("handle") != run["backend_handle"]:
        raise HTTPException(
            status_code=403,
            detail="the webhook body's `handle` does not match this run's backend handle",
        )

    backend = _remote_backends.get(training_run_id)
    if backend is None:
        raise HTTPException(status_code=409, detail="this run is not being tracked by this process")

    status = backend.ingest_webhook(run["backend_handle"], body)
    _record_status(training_run_id, status)

    if status.terminal:
        _webhook_status[training_run_id] = status
        _webhook_terminal.setdefault(training_run_id, threading.Event()).set()

    return {"training_run_id": training_run_id, "accepted": True, "status": status.state}


# ── Startup reconciliation ───────────────────────────────────────────────────


def reconcile_on_startup() -> dict[str, Any]:
    """Edge 11 — a restart with runs still `running`.

    A LOCAL run cannot be re-attached, and saying so is the honest outcome: the training
    lived in the previous process's memory and there is nothing to reconnect to. Leaving it
    `running` forever would be a run that never terminates, which is the one thing the
    dashboard's training view cannot render truthfully.

    A REMOTE run is re-attachable from its persisted `backend_handle`, so it is left alone
    for the tracking thread to pick up rather than being failed.
    """
    failed = db.query(
        """
        UPDATE training_runs
           SET status = 'failed',
               error = 'local run interrupted by restart',
               ended_at = now()
         WHERE backend = 'local' AND status IN ('queued', 'running')
        RETURNING training_run_id
        """
    )
    orphaned_remote = db.query(
        """
        SELECT tr.training_run_id, tr.backend_handle, tr.base_model_id, tr.dataset_id,
               tr.config
          FROM training_runs tr
         WHERE tr.backend = 'remote' AND tr.status IN ('queued', 'running')
        """
    )

    # RE-ATTACHED, NOT MERELY LISTED. Edge 11 says forge "re-attaches to remote runs using
    # the persisted backend_handle" — returning the ids without resuming tracking would
    # leave those runs `running` forever, which is the same never-terminating state the
    # local branch above exists to prevent.
    reattached: list[str] = []
    for row in orphaned_remote:
        handle = row["backend_handle"]
        if not handle:
            # Submitted but never acknowledged. There is nothing to re-attach to.
            db.execute(
                "UPDATE training_runs SET status = 'failed', "
                "error = 'remote run has no backend handle to re-attach to', ended_at = now() "
                "WHERE training_run_id = %s",
                (row["training_run_id"],),
            )
            continue

        threading.Thread(
            target=_track_reattached_remote,
            args=(str(row["training_run_id"]), str(handle)),
            name=f"reattach-{str(row['training_run_id'])[:8]}",
            daemon=True,
        ).start()
        reattached.append(str(row["training_run_id"]))

    return {
        "local_failed": [str(row["training_run_id"]) for row in failed],
        "remote_reattached": reattached,
    }


def _track_reattached_remote(training_run_id: str, handle: str) -> None:
    """Resume tracking a remote run that outlived a forge restart (edge 11).

    Nothing is reconstructed from the persisted config: the provider owns the job now, and
    everything forge still needs from this run — base model, dataset, corpus name — is read
    from its `training_runs` row when the job succeeds.
    """
    if _remote_settings is None:
        return
    backend = RemoteTrainingBackend(_remote_settings, dataset_artifact_path)
    status = _await_remote(training_run_id, backend, handle)
    if status.state != "succeeded":
        return
    _on_succeeded(training_run_id, backend, handle)
