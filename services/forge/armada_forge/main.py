"""armada-forge — FastAPI application entry point.

PHASE 0 SKELETON. This boots, validates startup configuration, serves GET /health, and
does nothing else.

What lands later, and where:
  Phase 1  Corpus CRUD, Sources, ingestion, chunking, embedding, idempotent indexing,
           base ModelBinding registration and reconciliation, Corpus seeding, the /ws
           progress channel, and GET /config/state.
  Phase 7  dataset construction, training backends, the evaluation gate, and promotion.

CONFIG VALIDATION IS NOT DEFERRED. Two Phase 0 acceptance criteria depend on this
happening at startup rather than at first use:

  - Appending a shortlist entry with a missing key exits non-zero naming its `id`.
  - Setting eval.mode: judge with teacher.enabled: false exits non-zero naming both.

Both are enforced in config.py and invoked from the lifespan hook below.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import psycopg
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from armada_forge.config import ArmadaConfig, load_config_or_exit

DATABASE_URL = os.environ.get("DATABASE_URL", "")
VERSION = os.environ.get("ARMADA_VERSION", "0.1.0")

# Populated by the lifespan hook. Nothing reads this before startup completes, because
# startup failing exits the process.
_config: ArmadaConfig | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Validate configuration before serving a single request.

    load_config_or_exit exits non-zero on any fault, so reaching the yield means every
    startup-critical config file parsed and validated.
    """
    global _config

    if not DATABASE_URL:
        print("\n🛑 armada-forge: DATABASE_URL is unset\n")
        raise SystemExit(1)

    _config = load_config_or_exit()

    smoke_model = next(
        (entry["id"] for entry in _config.base_models if entry.get("smoke_test") is True),
        None,
    )
    print(
        f"\n🚀 armada-forge starting: {len(_config.base_models)} base model(s), "
        f"smoke model {smoke_model}, "
        f"eval mode {_config.eval_config.get('mode')}, "
        f"teacher enabled {_config.teacher.get('enabled')}\n"
    )

    yield


app = FastAPI(
    title="armada-forge",
    version=VERSION,
    description="Corpus ingestion, dataset construction, training, and model registry",
    lifespan=lifespan,
)


def _database_reachable() -> bool:
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=5) as conn, conn.cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception as exc:  # noqa: BLE001 - any failure means unreachable
        print(f"\n⚠️  armada-forge: database probe failed: {exc}\n")
        return False


@app.get("/health")
def health() -> JSONResponse:
    """Readiness for the Compose healthcheck.

    PHASE 1 ADDS BASE-BINDING RECONCILIATION to this gate. It does NOT add roadmap F3's
    eager model pull — build-plan D1 supersedes that: registration writes a record and
    materialization is a separate explicit act, so forge never blocks startup on a
    multi-gigabyte download.

    Config is not a reported condition because it cannot be false here: load_config_or_exit
    terminates the process on any fault, so serving this endpoint at all means config
    loaded. Reporting a check that is structurally always "ok" would be noise.
    """
    db_ok = _database_reachable()

    body: dict[str, Any] = {
        "status": "ok" if db_ok else "unavailable",
        "version": VERSION,
        "checks": {
            "database": "ok" if db_ok else "unreachable",
            # Explicit rather than absent, so a reader can tell this gate is not yet part
            # of health instead of inferring it from silence.
            "base_bindings": "not-implemented-until-phase-1",
        },
    }
    return JSONResponse(status_code=200 if db_ok else 503, content=body)
