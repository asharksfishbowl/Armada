"""armada-forge — FastAPI application entry point.

P1 + P2 + P11. Corpus ingestion and index, the config-capabilities contract, the
query-embedding endpoint, the model registry with base ModelBindings, and — from P11 —
dataset construction, the training backends, the evaluation gate, and promotion.

REGISTRATION IS NOT MATERIALIZATION (R4c). Startup writes one model_bindings record per
shortlist entry and transfers ZERO model bytes; materializing a binding is a separate
explicit act (POST /models/bindings/{tag}/materialize). That split is what lets a first
`docker compose up` come up without pulling 10-15 GB.

CONFIG VALIDATION IS NOT DEFERRED. Three acceptance criteria depend on startup validation
rather than first-use validation:
  - a shortlist entry missing a key exits non-zero naming its `id`
  - eval.mode judge against teacher.enabled false exits non-zero naming both
  - an enabled teacher whose endpoint cannot be resolved exits non-zero naming it
All are enforced in config.py and invoked from the lifespan hook below.

EVERY ROUTER THIS FILE IMPORTS IS ALSO REGISTERED, and `tests/test_routes_registered.py`
fails if one is not. This repo has now shipped a component that was written, tested, and
never called five times — a router that is imported but never `include_router`'d is that
failure in its most invisible form, because the module imports cleanly and its unit tests
all pass.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from armada_forge import adapters, corpora, db, embed_api
from armada_forge.datasets import routes as dataset_routes
from armada_forge.eval.gate import Gate
from armada_forge.registry import base_bindings, materialize, models as registry_models
from armada_forge.config import ArmadaConfig, load_config_or_exit
from armada_forge.progress import hub
from armada_forge.teacher import TeacherClient, TeacherSettings
from armada_forge.training import hardware, runs as training_runs
from armada_forge.training.remote_backend import RemoteSettings

VERSION = os.environ.get("ARMADA_VERSION", "0.1.0")
MODELS_URL = os.environ.get("ARMADA_MODELS_URL", "http://armada-models:11434")
ADAPTERS_ROOT = Path(os.environ.get("ARMADA_ADAPTERS_ROOT", "/data/adapters"))

# Populated by the lifespan hook. Nothing reads this before startup completes, because a
# startup failure exits the process.
_config: ArmadaConfig | None = None


def _build_gate() -> Gate:
    """A fresh Gate per evaluation.

    Per-gate rather than a shared singleton because a Gate holds no cross-run state and a
    long-lived one would keep the last run's scorers — and therefore several gigabytes of
    weights — resident between evaluations that may be hours apart.
    """
    assert _config is not None
    teacher_settings = TeacherSettings.from_config(_config.teacher, _config.models)
    return Gate(
        mode=str(_config.eval_config.get("mode", "mechanical")),
        eval_fraction_config=_config.eval_config,
        training_entries=registry_models.training_entries(_config.base_models),
        binding_entries={
            entry.id: entry for entry in registry_models.shortlist(_config.base_models)
        },
        teacher_client=TeacherClient(teacher_settings),
        max_eval_samples=teacher_settings.max_eval_samples,
        rubric=_config.eval_rubric,
        models_url=MODELS_URL,
    )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Validate configuration and open the pool before serving a single request."""
    global _config

    if not db.DATABASE_URL:
        print("\n🛑 armada-forge: DATABASE_URL is unset\n")
        raise SystemExit(1)

    _config = load_config_or_exit()
    db.init_pool()

    # Ingestion runs in worker threads and pushes progress back onto this loop.
    corpora.configure(
        asyncio.get_running_loop(),
        frozenset(ext.lower() for ext in _config.code_extensions),
    )

    seeded = corpora.seed_corpora(_config.seed_corpora)

    # R4a/R4b — write one record per shortlist entry and retire the departed. This
    # contacts NOTHING: registering is a database write, and that is what makes a first
    # boot transfer zero model bytes (R4c).
    entries = registry_models.shortlist(_config.base_models)
    base_bindings.set_serving_refs(entries)
    registration = base_bindings.register_base_bindings(entries)

    model_client = materialize.ModelServerClient(MODELS_URL)
    materialize.configure(asyncio.get_running_loop(), entries, model_client)

    # R4h/R4g — correct materialization state against what armada-models ACTUALLY has.
    # An unreachable server corrects nothing: "cannot ask" is not evidence that weights
    # are gone, and demoting everything on a transient blip would strand the platform.
    reconciliation = base_bindings.reconcile_materialization(model_client.list_served())

    smoke_model = next(
        (entry["id"] for entry in _config.base_models if entry.get("smoke_test") is True),
        None,
    )

    # ── P11 wiring ───────────────────────────────────────────────────────────
    # Configured here for the same reason corpora and materialize are: the routers are
    # imported at module scope so FastAPI can register them, and the collaborators they
    # need do not exist until config has loaded and the pool is open.
    teacher_settings = TeacherSettings.from_config(_config.teacher, _config.models)
    training_entry_map = registry_models.training_entries(_config.base_models)

    dataset_routes.configure(
        training_entry_map,
        TeacherClient(teacher_settings),
        dict((_config.teacher.get("distillation") or {})),
        float(_config.eval_config.get("eval_fraction", 0.1)),
        smoke_model or "",
    )
    training_runs.configure(
        asyncio.get_running_loop(),
        training_entry_map,
        RemoteSettings.from_config(_config.training_remote),
        ADAPTERS_ROOT,
        _build_gate,
    )
    adapters.configure(_build_gate, str(_config.eval_config.get("mode", "mechanical")))

    # Edge 11 — a restart with runs still `running`. A local run cannot be re-attached and
    # is failed naming why; a remote one is re-attached from its persisted backend_handle.
    training_reconciliation = training_runs.reconcile_on_startup()

    print(
        f"\n🚀 armada-forge starting: {len(_config.base_models)} base model(s), "
        f"smoke model {smoke_model}, "
        f"eval mode {_config.eval_config.get('mode')}, "
        f"teacher enabled {_config.teacher.get('enabled')}, "
        f"seeded corpora {seeded or 'none (already present)'}, "
        f"bindings registered {len(registration['registered'])}"
        f"{', retired ' + ', '.join(registration['retired']) if registration['retired'] else ''}, "
        f"materialization {reconciliation}, "
        f"local backend mode {hardware.detect_mode()}, "
        f"training runs {training_reconciliation}\n"
    )

    try:
        yield
    finally:
        db.close_pool()


app = FastAPI(
    title="armada-forge",
    version=VERSION,
    description="Corpus ingestion, dataset construction, training, and model registry",
    lifespan=lifespan,
)

app.include_router(corpora.router)
# POST /embed — the daemon calls this at agent time for R41 query vectors. Forge owns the
# embedding model (platform boundary 1); this returns a vector, never a retrieval.
app.include_router(embed_api.router)
# GET /models/bindings and POST /models/bindings/{tag}/materialize — cross-service
# boundary 2 puts ModelBinding registration, and therefore materialization, in forge.
app.include_router(materialize.router)
# P11. POST/GET /datasets, POST /datasets/supplied, POST /datasets/{id}/split.
app.include_router(dataset_routes.router)
# P11. POST/GET /training/runs and the remote provider's webhook.
app.include_router(training_runs.router)
# P11. GET /adapters and POST /adapters/{id}/promote (R30a).
app.include_router(adapters.router)


@app.get("/health")
def health() -> JSONResponse:
    """Readiness for the Compose healthcheck.

    Does NOT block on model availability. build-plan D1 supersedes roadmap F3's eager
    pull — registration writes a record and materialization is a separate explicit act —
    so forge never holds startup behind a multi-gigabyte download.

    Config is not a reported condition because it cannot be false here: load_config_or_exit
    terminates the process on any fault, so serving this endpoint at all means config
    loaded. Reporting a check that is structurally always "ok" would be noise.
    """
    db_ok = db.reachable()

    body: dict[str, Any] = {
        "status": "ok" if db_ok else "unavailable",
        "version": VERSION,
        "checks": {
            "database": "ok" if db_ok else "unreachable",
            # Explicit rather than absent, so a reader can tell this gate is not yet part
            # of health instead of inferring it from silence.
            "base_bindings": "not-implemented-pending-d1",
        },
    }
    return JSONResponse(status_code=200 if db_ok else 503, content=body)


@app.get("/config/capabilities")
def config_capabilities() -> dict[str, Any]:
    """Dependency 9, ADDED — exactly three fields and nothing else.

    LEAKS NOTHING. No credentials, no endpoints, no environment variable names. The
    dashboard needs to know what the platform can currently do so it can render
    disabled-with-reason instead of enabled-and-guessing; it does not need to know how any
    of it is wired, and an ops console on a trusted network is still not a place to
    enumerate configuration.

    All three are forge-side facts, so forge owns this endpoint. The dashboard calls
    /api/config/capabilities, which the daemon proxies in Phase 2 because /api/* is the
    daemon's namespace.
    """
    assert _config is not None

    return {
        "teacher_enabled": bool(_config.teacher.get("enabled", False)),
        "eval_mode": _config.eval_config.get("mode", "mechanical"),
        # Training R24 — CUDA detection selects the mode, and this endpoint calls THE SAME
        # FUNCTION LocalTrainingBackend enforces with. Two detections could disagree, and a
        # dashboard offering a quality run the backend will refuse is worse than one that
        # offers nothing.
        "local_backend_mode": hardware.detect_mode(),
    }


@app.websocket("/ws")
async def progress_socket(websocket: WebSocket) -> None:
    """Unresolved Dependency 4 — ingestion progress, and from Phase 7 training progress.

    The hub holds no per-connection job state (mirroring Runtime R7): a client that
    reconnects simply re-subscribes. Job state lives in `ingestion_jobs` and the dashboard
    reads authoritative status over REST — a socket is a delivery mechanism, never a
    source of truth.
    """
    await hub.connect(websocket)
    try:
        while True:
            # Nothing is expected from the client; this await is how we notice a
            # disconnect. Frames that do arrive are ignored rather than parsed, because
            # this channel is push-only by design.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(websocket)
