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
from collections.abc import Iterable
from typing import Any

from armada_forge import db
from armada_forge.ingest import extractor, indexer, sources
from armada_forge.ingest.chunker import Chunk, chunk
from armada_forge.progress import hub


def _emit(loop: asyncio.AbstractEventLoop | None, message: dict[str, Any]) -> None:
    if loop is not None:
        hub.broadcast_threadsafe(loop, message)


def _zero_match_error(results: Iterable[dict[str, Any]]) -> str:
    """R8c's message. The REMEDY depends on which of two things went wrong.

    A Source whose globs matched no files at all and a Source that matched forty files and
    extracted none of them are different faults with different fixes. Telling an operator
    to "check the mount and the globs" is right for the first and actively misleading for
    the second, where the files were found perfectly well. So each Source reports its own
    numbers, and the advice is chosen from what actually happened.
    """
    rows = list(results)
    lines = []
    for r in rows:
        matched = r.get("files_matched", 0)
        if matched == 0:
            lines.append(f"  - {r['location']}: the include/exclude globs matched no files")
        else:
            lines.append(
                f"  - {r['location']}: matched {matched} file(s), but none produced any "
                f"text ({r.get('files_skipped', 0)} skipped as empty or unsupported)"
            )

    if all(r.get("files_matched", 0) == 0 for r in rows):
        remedy = (
            "Nothing was walked at all. Check that each path is mounted into armada-forge "
            "under ARMADA_INGEST_ROOT and that the globs match real files — note `*.md` "
            "matches only the top level, while `**/*.md` recurses."
        )
    else:
        remedy = (
            "The files were found but none could be extracted. Check that their extensions "
            "are ones forge extracts (config/code-extensions.yaml) and that the files are "
            "not empty."
        )

    return (
        "every Source yielded zero extractable files, so nothing was ingested:\n"
        + "\n".join(lines)
        + "\n"
        + remedy
    )


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
                # MATCHED and INDEXED are deliberately different numbers. Matched is what
                # the globs found; indexed is what survived extraction and chunking. When
                # an ingest yields nothing, the gap between them IS the diagnosis: 0
                # matched means the path or the glob is wrong, while 40 matched and 0
                # indexed means the files are there and nothing could be extracted from
                # them. Reporting one number for both would collapse four distinct causes
                # into one and make the R8c message give wrong advice for half of them.
                "files_matched": len(candidates),
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

    # Label each Source on its OWN merits, independent of what its siblings did. A Source
    # that indexed nothing is a fault whether or not the others succeeded — leaving it
    # `succeeded` with files_indexed: 0 would preserve the original defect one level down,
    # in the per-Source record instead of the job status. This is what makes ONE stale
    # Source discoverable without changing the job outcome anything depends on.
    for result in source_results.values():
        if result["status"] == "succeeded" and result["files_indexed"] == 0:
            result["status"] = "zero_matches"

    # R8c — EVERY Source yielding zero extractable files is a FAULT, not an empty result.
    # Zero files from a Source the operator explicitly registered means a misconfiguration,
    # and reporting it as success is how that survives to be discovered much later.
    #
    # ⚠ THE JOB STATUS CHANGES ONLY IN THE ALL-ZERO CASE. One Source of several matching
    # zero leaves the job `succeeded` exactly as before, because the working Sources' chunks
    # did land — widening this would turn a working corpus into a failing one. Edge 3 also
    # still stands: an individual file whose extracted text is empty counts in files_skipped
    # and fails nothing.
    job_error: str | None = None
    if (
        status == "succeeded"
        and source_results
        and all(r["status"] == "zero_matches" for r in source_results.values())
    ):
        status = "failed"
        job_error = _zero_match_error(source_results.values())

    db.execute(
        """
        UPDATE ingestion_jobs
           SET status = %s,
               chunks_added = %s,
               chunks_removed = %s,
               files_skipped = %s,
               source_results = %s,
               error = %s,
               ended_at = now()
         WHERE job_id = %s
        """,
        (status, total_added, total_removed, total_skipped,
         json.dumps(source_results), job_error, job_id),
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
