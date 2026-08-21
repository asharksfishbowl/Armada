"""Content-hash idempotent writes and deletions against `chunks` — Training R14.

Re-ingesting a Corpus is idempotent PER CHUNK:

  * a chunk whose content_sha256 already exists for the same (corpus_id, source_path) is
    not re-embedded and not duplicated
  * chunks present in a prior ingestion but absent from the current one are DELETED

Keying on the PAIR (content_sha256, source_path) rather than the hash alone is edge 17:
two Sources producing byte-identical content at different paths must keep both chunk sets,
because a retrieval result cites its source_path and collapsing them would misattribute it.

Embedding is the expensive step — seconds per batch on CPU — so the skip is what makes
re-ingesting an unchanged repository nearly free, and it is what the acceptance criterion
"re-running ingestion adds zero and removes zero chunks" actually tests.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from armada_forge import db
from armada_forge.ingest.chunker import Chunk
from armada_forge.ingest.embedder import embed

# Chunks embedded and inserted per slice. Large enough that the model amortizes
# tokenization across the batch, small enough that peak vector memory stays bounded
# regardless of corpus size.
EMBED_BATCH_SIZE = 500


@dataclass
class IndexResult:
    chunks_added: int
    chunks_removed: int
    chunks_unchanged: int


def content_sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def index_source(
    corpus_id: str,
    source_id: str,
    file_chunks: dict[str, list[Chunk]],
) -> IndexResult:
    """Write one Source's chunks idempotently and delete what is no longer present.

    `file_chunks` maps source_path -> chunks for every file extracted in THIS run. A path
    absent from it that has rows from a prior run is a deleted file, and its chunks go.
    """
    added = 0
    unchanged = 0

    # Everything currently stored for this Source, so we can diff against what we just
    # produced. Read once rather than per-chunk.
    existing_rows = db.query(
        """
        SELECT chunk_id, source_path, content_sha256
          FROM chunks
         WHERE corpus_id = %s AND source_id = %s
        """,
        (corpus_id, source_id),
    )
    existing: dict[tuple[str, str], str] = {
        (row["source_path"], row["content_sha256"]): row["chunk_id"] for row in existing_rows
    }

    seen: set[tuple[str, str]] = set()
    pending: list[tuple[str, Chunk, str]] = []  # (source_path, chunk, sha)

    for source_path, chunks in file_chunks.items():
        for chunk_obj in chunks:
            sha = content_sha256(chunk_obj.content)
            key = (source_path, sha)
            seen.add(key)

            if key in existing:
                # R14 — already present at this path with this content. Not re-embedded.
                unchanged += 1
                continue
            pending.append((source_path, chunk_obj, sha))

    if pending:
        with db.connection() as conn, conn.cursor() as cur:
            # Embed and insert in SLICES rather than all at once. Embedding the whole
            # corpus first would hold every vector in memory simultaneously — at 384 dims a
            # vector is ~12 KB as a Python list, so 50k chunks is ~600 MB of vectors alone,
            # on top of the chunk objects and their text. Slicing keeps that constant.
            #
            # executemany rather than one execute per chunk: psycopg3 pipelines it, turning
            # tens of thousands of sequential round-trips into a handful.
            for start in range(0, len(pending), EMBED_BATCH_SIZE):
                batch = pending[start : start + EMBED_BATCH_SIZE]
                vectors = embed([chunk_obj.content for _, chunk_obj, _ in batch])

                cur.executemany(
                    """
                    INSERT INTO chunks (
                        corpus_id, source_id, content, embedding, token_count,
                        source_path, start_line, end_line, content_sha256, split_oversize
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (corpus_id, source_path, content_sha256) DO NOTHING
                    """,
                    [
                        (
                            corpus_id,
                            source_id,
                            chunk_obj.content,
                            str(vector),
                            chunk_obj.token_count,
                            source_path,
                            chunk_obj.start_line,
                            chunk_obj.end_line,
                            sha,
                            chunk_obj.split_oversize,
                        )
                        for (source_path, chunk_obj, sha), vector in zip(batch, vectors)
                    ],
                )
                # rowcount after executemany is the aggregate across the batch. ON CONFLICT
                # DO NOTHING means it counts rows actually inserted, which is what `added`
                # is supposed to report.
                added += max(cur.rowcount, 0)

    # R14 — anything stored for this Source that this run did not produce is gone from the
    # upstream. That covers both an edited file (old chunk hashes vanish) and a deleted one
    # (the whole path vanishes).
    stale_ids = [chunk_id for key, chunk_id in existing.items() if key not in seen]
    removed = 0
    if stale_ids:
        removed = db.execute(
            "DELETE FROM chunks WHERE chunk_id = ANY(%s)",
            (stale_ids,),
        )

    return IndexResult(chunks_added=added, chunks_removed=removed, chunks_unchanged=unchanged)


