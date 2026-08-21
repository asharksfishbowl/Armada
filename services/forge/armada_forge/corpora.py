"""Corpus CRUD, Sources, ingestion trigger, and seeding.

Training R5, R5a, R6, R7; Agent Definition R36; Unresolved Dependency 3.

INVARIANT 4 — a Corpus is referenced by `name`, never by `corpus_id`, in every Agent
definition. `name` is therefore immutable after creation (R5): a definition file authored
on one installation stays valid on another that has a Corpus of the same name, and a
ModelBinding tag embedding that name can never become ambiguous.
"""

from __future__ import annotations

import asyncio
import re
import threading
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from armada_forge import db
from armada_forge.ingest import job as ingest_job

router = APIRouter()

NAME_PATTERN = re.compile(r"^[a-z0-9-]+$")

# Set by main.py at startup. The ingestion worker needs the loop to push progress frames
# back across the thread boundary, and the extension set to decide chunking strategy.
_loop: asyncio.AbstractEventLoop | None = None
_code_extensions: frozenset[str] = frozenset()


def configure(loop: asyncio.AbstractEventLoop, code_extensions: frozenset[str]) -> None:
    global _loop, _code_extensions
    _loop = loop
    _code_extensions = code_extensions


class CorpusCreate(BaseModel):
    name: str = Field(..., description="Immutable, ^[a-z0-9-]+$")
    description: str = ""


class SourceCreate(BaseModel):
    type: str
    location: str
    include_globs: list[str] = Field(default_factory=list)
    exclude_globs: list[str] = Field(default_factory=list)


VALID_SOURCE_TYPES = frozenset({"git", "web", "directory", "upload"})


def _corpus_or_404(corpus_id: str) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM corpora WHERE corpus_id = %s", (corpus_id,))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no Corpus with corpus_id {corpus_id}")
    return row


@router.post("/corpora", status_code=201)
def create_corpus(payload: CorpusCreate) -> dict[str, Any]:
    """R5 — create a Corpus. `name` is unique and immutable."""
    if not NAME_PATTERN.match(payload.name):
        # Edge 24 — two names differing only by case would make a ModelBinding tag
        # ambiguous, so the constraint is enforced here as well as in the schema domain.
        raise HTTPException(
            status_code=400,
            detail=f"name `{payload.name}` must match ^[a-z0-9-]+$",
        )

    existing = db.query_one("SELECT corpus_id FROM corpora WHERE name = %s", (payload.name,))
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"a Corpus named `{payload.name}` already exists")

    row = db.query_one(
        """
        INSERT INTO corpora (name, description) VALUES (%s, %s)
        RETURNING corpus_id, name, description, created_at, last_ingested_at
        """,
        (payload.name, payload.description),
    )
    assert row is not None
    return row


@router.get("/corpora")
def list_corpora() -> list[dict[str, Any]]:
    """R5a — the daemon calls this to resolve an Agent's `corpus.name` to a corpus_id."""
    return db.query(
        """
        SELECT c.corpus_id, c.name, c.description, c.last_ingested_at,
               (SELECT count(*) FROM chunks  ch WHERE ch.corpus_id = c.corpus_id) AS chunk_count,
               (SELECT count(*) FROM sources s  WHERE s.corpus_id  = c.corpus_id) AS source_count
          FROM corpora c
         ORDER BY c.name
        """
    )


@router.get("/corpora/{corpus_id}")
def get_corpus(corpus_id: str) -> dict[str, Any]:
    """R5a — the same fields as the list, plus Sources and the most recent job."""
    corpus = _corpus_or_404(corpus_id)
    counts = db.query_one(
        """
        SELECT (SELECT count(*) FROM chunks  WHERE corpus_id = %(cid)s) AS chunk_count,
               (SELECT count(*) FROM sources WHERE corpus_id = %(cid)s) AS source_count
        """,
        {"cid": corpus_id},
    )
    sources_rows = db.query(
        "SELECT * FROM sources WHERE corpus_id = %s ORDER BY created_at",
        (corpus_id,),
    )
    latest_job = db.query_one(
        """
        SELECT * FROM ingestion_jobs
         WHERE corpus_id = %s
         ORDER BY started_at DESC
         LIMIT 1
        """,
        (corpus_id,),
    )
    return {**corpus, **(counts or {}), "sources": sources_rows, "latest_job": latest_job}


@router.delete("/corpora/{corpus_id}")
def delete_corpus(corpus_id: str) -> dict[str, Any]:
    """Unresolved Dependency 3, ADDED.

    Semantics are already fixed by Training edge 16 and need no new decision: the Corpus
    and its chunks are deleted, but ADAPTERS TRAINED FROM IT ARE RETAINED and keep
    serving, with their ModelBinding tags unaffected. That is why `adapters.corpus_name`
    is text rather than a foreign key — the tag embeds the name, and a served model must
    not stop resolving because its training corpus was cleaned up.
    """
    _corpus_or_404(corpus_id)

    # Delete the chunks explicitly rather than counting them and letting the cascade do it:
    # the rowcount IS the number to report, so this is one pass over the rows instead of two.
    chunks_deleted = db.execute("DELETE FROM chunks WHERE corpus_id = %s", (corpus_id,))
    # sources cascade from the corpora row (migration 002).
    db.execute("DELETE FROM corpora WHERE corpus_id = %s", (corpus_id,))

    return {
        "deleted": corpus_id,
        "chunks_deleted": chunks_deleted,
        "adapters_retained": True,
    }


@router.post("/corpora/{corpus_id}/sources", status_code=201)
def add_source(corpus_id: str, payload: SourceCreate) -> dict[str, Any]:
    """R6 — register a Source."""
    _corpus_or_404(corpus_id)

    if payload.type not in VALID_SOURCE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"type `{payload.type}` must be one of {', '.join(sorted(VALID_SOURCE_TYPES))}",
        )

    row = db.query_one(
        """
        INSERT INTO sources (corpus_id, type, location, include_globs, exclude_globs)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING *
        """,
        (corpus_id, payload.type, payload.location, payload.include_globs, payload.exclude_globs),
    )
    assert row is not None
    return row


@router.post("/corpora/{corpus_id}/ingest", status_code=202)
def start_ingestion(corpus_id: str) -> dict[str, Any]:
    """R7 — start a job over every Source. Returns BEFORE ingestion completes."""
    _corpus_or_404(corpus_id)

    if db.scalar("SELECT count(*) FROM sources WHERE corpus_id = %s", (corpus_id,)) == 0:
        # Edge 2 — a zero-Source Corpus returns 400 and creates NO job. A job row that
        # could never do anything would show up in the dashboard as a phantom ingestion.
        raise HTTPException(
            status_code=400,
            detail=f"Corpus {corpus_id} has no Sources; add one before ingesting",
        )

    # Edge 18 — a second concurrent ingest returns 409 NAMING THE IN-FLIGHT job_id, so the
    # caller can follow the existing job rather than guess why it was refused. The partial
    # unique index in migration 002 is the real guard; this check produces the good error.
    in_flight = db.query_one(
        "SELECT job_id FROM ingestion_jobs WHERE corpus_id = %s AND status = 'running'",
        (corpus_id,),
    )
    if in_flight is not None:
        raise HTTPException(
            status_code=409,
            detail=f"ingestion already running for this Corpus: job_id {in_flight['job_id']}",
        )

    row = db.query_one(
        "INSERT INTO ingestion_jobs (corpus_id) VALUES (%s) RETURNING job_id",
        (corpus_id,),
    )
    assert row is not None
    job_id = str(row["job_id"])

    # Ingestion is CPU-bound (embedding) and IO-bound (cloning); running it inline would
    # block the event loop and every concurrent request. A thread keeps R7's "returns
    # before ingestion completes" true.
    threading.Thread(
        target=ingest_job.run_ingestion,
        args=(job_id, corpus_id, _code_extensions, _loop),
        name=f"ingest-{job_id[:8]}",
        daemon=True,
    ).start()

    return {"job_id": job_id, "corpus_id": corpus_id, "status": "running"}


@router.get("/corpora/{corpus_id}/jobs")
def list_jobs(corpus_id: str) -> list[dict[str, Any]]:
    _corpus_or_404(corpus_id)
    return db.query(
        "SELECT * FROM ingestion_jobs WHERE corpus_id = %s ORDER BY started_at DESC LIMIT 50",
        (corpus_id,),
    )


def seed_corpora(seeds: list[dict[str, Any]]) -> list[str]:
    """Agent Definition R36 — seed Corpora on first startup.

    WHY THIS EXISTS. Both shipped example Agents reference Corpora by name, and R16 fails
    validation when a named Corpus is absent. Without seeding, a fresh installation ships
    two example Agents that both fail to load — the first thing a new operator sees would
    be two validation errors.

    IDEMPOTENT, AND NEVER TOUCHES AN EXISTING CORPUS. An operator who has since added
    Sources to `recipes` does not lose them on restart, which is why this inserts only
    when absent rather than upserting.
    """
    created: list[str] = []
    for seed in seeds:
        name = seed.get("name")
        if not name:
            continue
        existing = db.query_one("SELECT corpus_id FROM corpora WHERE name = %s", (name,))
        if existing is not None:
            continue
        db.execute(
            "INSERT INTO corpora (name, description) VALUES (%s, %s)",
            (name, seed.get("description", "")),
        )
        created.append(name)
    return created
