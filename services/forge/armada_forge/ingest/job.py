"""Ingestion job orchestration — Training R7, R8, data flow 2-7, edges 1/2/3/18.

One job walks every Source in a Corpus: fetch, filter, extract, chunk, embed, index.

THE PARTIAL OUTCOME IS THE POINT (edge 1). A Source that fails to fetch is recorded
`failed` with its underlying error, the remaining Sources are still ingested, and the job
ends `partial`. Failing the whole job on one bad URL would discard real work and force an
operator to re-run everything to recover from one typo.
"""

from __future__ import annotations

import asyncio
import json
import traceback
from typing import Any

from armada_forge import db
from armada_forge.ingest import extractor, indexer, sources
from armada_forge.ingest.chunker import Chunk, chunk
from armada_forge.progress import hub


def _emit(loop: asyncio.AbstractEventLoop | None, message: dict[str, Any]) -> None:
    if loop is not None:
        hub.broadcast_threadsafe(loop, message)


def run_ingestion(
    job_id: str,
    corpus_id: str,
    code_extensions: frozenset[str],
    loop: asyncio.AbstractEventLoop | None = None,
) -> None:
    """Execute one ingestion job to completion.

    Runs in a worker thread — embedding is CPU-bound and would otherwise stall the event
    loop and every concurrent HTTP request with it.
    """
    source_rows = db.query(
        """
        SELECT source_id, type, location, include_globs, exclude_globs
          FROM sources
         WHERE corpus_id = %s
         ORDER BY created_at
        """,
        (corpus_id,),
    )

    source_results: dict[str, Any] = {}
    total_added = 0
    total_removed = 0
    total_skipped = 0

    def frame(**extra: Any) -> dict[str, Any]:
        """Progress frame. The fixed identity fields live here so each emit below shows
        only what actually changed."""
        return {
            "channel": "ingestion",
            "job_id": job_id,
            "corpus_id": corpus_id,
            "sources_total": len(source_rows),
            **extra,
        }

    _emit(loop, frame(status="running", sources_done=0))

    for index, row in enumerate(source_rows):
        source_id = str(row["source_id"])
        fetched: sources.FetchedSource | None = None

        try:
            fetched = sources.fetch(row["type"], row["location"])
            candidates = sources.walk_files(
                fetched.root,
                list(row["include_globs"] or []),
                list(row["exclude_globs"] or []),
            )

            file_chunks: dict[str, list[Chunk]] = {}
            skipped = 0

            for path, rel_path in candidates:
                if not extractor.is_ingestable(path, code_extensions):
                    # R9 — an extension we do not extract. Not a failure.
                    continue

                extracted = extractor.extract(path, rel_path, code_extensions)
                if extracted is None:
                    # Edge 3 — empty or whitespace-only text counts as skipped, not failed.
                    skipped += 1
                    continue

                chunks = chunk(extracted.text, extracted.is_code)
                if chunks:
                    file_chunks[rel_path] = chunks
                else:
                    skipped += 1

            result = indexer.index_source(corpus_id, source_id, file_chunks)

            total_added += result.chunks_added
            total_removed += result.chunks_removed
            total_skipped += skipped
            source_results[source_id] = {
                "status": "succeeded",
                "location": row["location"],
                "files_indexed": len(file_chunks),
                "files_skipped": skipped,
                "chunks_added": result.chunks_added,
                "chunks_removed": result.chunks_removed,
                "chunks_unchanged": result.chunks_unchanged,
            }

        except sources.SourceFetchError as exc:
            # EDGE 1 — record and continue. This is the whole reason `partial` exists.
            source_results[source_id] = {
                "status": "failed",
                "location": row["location"],
                "error": str(exc),
            }
            print(f"\n⚠️  armada-forge: source {source_id} failed: {exc}\n")

        except Exception as exc:  # noqa: BLE001 - one Source must not abort the job
            source_results[source_id] = {
                "status": "failed",
                "location": row["location"],
                "error": f"{type(exc).__name__}: {exc}",
            }
            print(f"\n❌ armada-forge: source {source_id} raised:\n{traceback.format_exc()}\n")

        finally:
            if fetched is not None:
                sources.cleanup(fetched)

        _emit(loop, frame(
            status="running",
            sources_done=index + 1,
            chunks_added=total_added,
            chunks_removed=total_removed,
        ))

    # Edge 1 — `partial` when some Sources succeeded and some failed; `failed` only when
    # every Source failed, because then nothing was ingested at all.
    statuses = [r["status"] for r in source_results.values()]
    failed, succeeded = "failed" in statuses, "succeeded" in statuses
    if failed and succeeded:
        status = "partial"
    elif failed:
        status = "failed"
    else:
        status = "succeeded"

    db.execute(
        """
        UPDATE ingestion_jobs
           SET status = %s,
               chunks_added = %s,
               chunks_removed = %s,
               files_skipped = %s,
               source_results = %s,
               ended_at = now()
         WHERE job_id = %s
        """,
        (status, total_added, total_removed, total_skipped,
         json.dumps(source_results), job_id),
    )

    if status in ("succeeded", "partial"):
        db.execute(
            "UPDATE corpora SET last_ingested_at = now() WHERE corpus_id = %s",
            (corpus_id,),
        )

    _emit(loop, frame(
        status=status,
        sources_done=len(source_rows),
        chunks_added=total_added,
        chunks_removed=total_removed,
        files_skipped=total_skipped,
    ))
