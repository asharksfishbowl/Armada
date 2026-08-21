"""armada-forge — FastAPI application entry point.

PHASE 1. Corpus ingestion and index, plus the config-capabilities contract.

SCOPE NOTE — base ModelBinding registration and materialization are DELIBERATELY ABSENT.
build-plan D1 overturns roadmap F3's eager pull: registration writes a record and
materialization is a separate explicit act. That correction has not yet landed in
model-training-pipeline.md (R4a still reads "registers ... with armada-models" and
`materialize` appears nowhere in it), so building the registry half now would mean
building it against wording already known to be wrong. Skipped on the Researcher's ruling;
it needs a /spec pass first.

What lands later:
  Phase 2 (blocked)  base ModelBinding registration + reconciliation, POST
                     /models/bindings/{tag}/materialize, GET /models/bindings
  Phase 7            dataset construction, training backends, evaluation gate, promotion

CONFIG VALIDATION IS NOT DEFERRED. Two acceptance criteria depend on startup validation
rather than first-use validation:
  - a shortlist entry missing a key exits non-zero naming its `id`
  - eval.mode judge against teacher.enabled false exits non-zero naming both
Both are enforced in config.py and invoked from the lifespan hook below.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from armada_forge import corpora, db, embed_api
from armada_forge.config import ArmadaConfig, load_config_or_exit
from armada_forge.progress import hub

VERSION = os.environ.get("ARMADA_VERSION", "0.1.0")

# Populated by the lifespan hook. Nothing reads this before startup completes, because a
# startup failure exits the process.
_config: ArmadaConfig | None = None


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

    smoke_model = next(
        (entry["id"] for entry in _config.base_models if entry.get("smoke_test") is True),
        None,
    )
    print(
        f"\n🚀 armada-forge starting: {len(_config.base_models)} base model(s), "
        f"smoke model {smoke_model}, "
        f"eval mode {_config.eval_config.get('mode')}, "
        f"teacher enabled {_config.teacher.get('enabled')}, "
        f"seeded corpora {seeded or 'none (already present)'}\n"
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
        # Training R24 — CUDA detection selects the mode. LocalTrainingBackend lands in
        # Phase 7; until then this reports what the current host would select, which on the
        # CPU-only target is `smoke`.
        "local_backend_mode": _detect_local_backend_mode(),
    }


def _detect_local_backend_mode() -> str:
    """Training R24 — CUDA present selects quality, absent selects smoke.

    Mode is NEVER operator-selectable (R24c): a run must never be mistaken for a quality
    run it was not. Detection here is deliberately import-guarded so a CPU-only image with
    no torch installed reports `smoke` rather than failing the endpoint.
    """
    try:
        import torch

        return "quality" if torch.cuda.is_available() else "smoke"
    except ImportError:
        return "smoke"


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
