"""P1 backfill — idempotent chunk indexing.

Training R14 and edge 17.

R14's idempotency is keyed on the PAIR (content_sha256, source_path) per corpus, and the
pair is the subtle part. Edge 17 turns on it directly: two Sources producing byte-identical
content at DIFFERENT paths must BOTH be retained, because a retrieval result cites its
source_path and collapsing them would misattribute it.

The cost of getting this wrong is quiet. Keying on the hash alone would silently drop half
the chunks of a corpus containing a vendored copy of a file — retrieval would still work,
just with a hole in it.
"""

from __future__ import annotations

from typing import Any

import pytest

from armada_forge.ingest import indexer
from armada_forge.ingest.chunker import Chunk


class FakeDB:
    """In-memory stand-in for the `chunks` table.

    Models only what index_source touches: read the existing rows, insert new ones with
    ON CONFLICT DO NOTHING, and delete by id.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self._next_id = 0

    # -- db module surface -------------------------------------------------
    def query(self, sql: str, params: tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
        if "SELECT chunk_id, source_path, content_sha256" in sql:
            corpus_id, source_id = params
            return [
                {"chunk_id": r["chunk_id"], "source_path": r["source_path"],
                 "content_sha256": r["content_sha256"]}
                for r in self.rows
                if r["corpus_id"] == corpus_id and r["source_id"] == source_id
            ]
        return []

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> int:
        if "DELETE FROM chunks WHERE chunk_id = ANY" in sql:
            ids = set(params[0])
            before = len(self.rows)
            self.rows = [r for r in self.rows if r["chunk_id"] not in ids]
            return before - len(self.rows)
        return 0

    def connection(self):
        return _FakeConnection(self)


class _FakeCursor:
    def __init__(self, db: FakeDB) -> None:
        self.db = db
        self.rowcount = 0

    def executemany(self, sql: str, rows: list[tuple[Any, ...]]) -> None:
        inserted = 0
        for row in rows:
            corpus_id, source_id, content, _vec, tokens, source_path, _s, _e, sha, oversize = row
            # ON CONFLICT (corpus_id, source_path, content_sha256) DO NOTHING
            if any(
                r["corpus_id"] == corpus_id
                and r["source_path"] == source_path
                and r["content_sha256"] == sha
                for r in self.db.rows
            ):
                continue
            self.db._next_id += 1
            self.db.rows.append({
                "chunk_id": f"c{self.db._next_id}", "corpus_id": corpus_id,
                "source_id": source_id, "content": content, "token_count": tokens,
                "source_path": source_path, "content_sha256": sha, "split_oversize": oversize,
            })
            inserted += 1
        self.rowcount = inserted

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class _FakeConnection:
    def __init__(self, db: FakeDB) -> None:
        self.db = db

    def cursor(self):
        return _FakeCursor(self.db)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> FakeDB:
    db = FakeDB()
    monkeypatch.setattr(indexer, "db", db)
    # Embedding is the expensive step and is not what these tests are about; a fixed vector
    # keeps them fast and deterministic.
    monkeypatch.setattr(indexer, "embed", lambda texts: [[0.0] * 384 for _ in texts])
    return db


def chunk(content: str) -> Chunk:
    return Chunk(content=content, token_count=len(content) // 4 or 1,
                 start_line=1, end_line=2, split_oversize=False)


CORPUS = "corpus-1"
SOURCE = "source-1"


def test_first_ingestion_adds_every_chunk(fake_db: FakeDB) -> None:
    result = indexer.index_source(CORPUS, SOURCE, {"a.md": [chunk("alpha"), chunk("beta")]})
    assert result.chunks_added == 2
    assert result.chunks_removed == 0
    assert len(fake_db.rows) == 2


def test_reingesting_unchanged_adds_and_removes_zero(fake_db: FakeDB) -> None:
    """R14 — the acceptance criterion, and what makes re-ingestion cheap.

    Embedding is seconds per batch on CPU; without the skip, re-ingesting an unchanged
    repository would cost as much as the first pass.
    """
    files = {"a.md": [chunk("alpha"), chunk("beta")]}
    indexer.index_source(CORPUS, SOURCE, files)

    result = indexer.index_source(CORPUS, SOURCE, files)

    assert result.chunks_added == 0
    assert result.chunks_removed == 0
    assert result.chunks_unchanged == 2
    assert len(fake_db.rows) == 2


def test_deleting_a_file_removes_exactly_that_files_chunks(fake_db: FakeDB) -> None:
    """R14 — chunks present in a prior ingestion but absent from this one are deleted."""
    indexer.index_source(CORPUS, SOURCE, {
        "keep.md": [chunk("kept content")],
        "gone.md": [chunk("doomed content")],
    })

    result = indexer.index_source(CORPUS, SOURCE, {"keep.md": [chunk("kept content")]})

    assert result.chunks_removed == 1
    assert [r["source_path"] for r in fake_db.rows] == ["keep.md"]


def test_editing_a_file_replaces_only_its_chunks(fake_db: FakeDB) -> None:
    indexer.index_source(CORPUS, SOURCE, {
        "a.md": [chunk("original")],
        "b.md": [chunk("untouched")],
    })

    result = indexer.index_source(CORPUS, SOURCE, {
        "a.md": [chunk("edited")],
        "b.md": [chunk("untouched")],
    })

    assert (result.chunks_added, result.chunks_removed) == (1, 1)
    contents = sorted(r["content"] for r in fake_db.rows)
    assert contents == ["edited", "untouched"]


# ── EDGE 17 — the reason the key is a PAIR ───────────────────────────────────

def test_identical_content_at_two_paths_is_retained_as_two_chunk_sets(fake_db: FakeDB) -> None:
    """Edge 17 — byte-identical content at different source_paths must NOT collapse.

    A retrieval result cites its source_path. Collapsing these would attribute a passage to
    whichever path happened to be indexed first, and the operator would have no way to tell.
    Keying on content_sha256 alone is the natural mistake this pins against.
    """
    duplicated = "the very same words in two places"

    result = indexer.index_source(CORPUS, SOURCE, {
        "docs/guide.md": [chunk(duplicated)],
        "vendor/copy/guide.md": [chunk(duplicated)],
    })

    assert result.chunks_added == 2, "identical content at two paths must be kept twice"
    assert sorted(r["source_path"] for r in fake_db.rows) == ["docs/guide.md", "vendor/copy/guide.md"]
    # Same hash, different rows — the pair is doing the work.
    assert len({r["content_sha256"] for r in fake_db.rows}) == 1


def test_duplicate_content_at_the_same_path_is_stored_once(fake_db: FakeDB) -> None:
    """The other half of the pair: within ONE path, identical content is one chunk."""
    result = indexer.index_source(CORPUS, SOURCE, {"a.md": [chunk("same"), chunk("same")]})
    assert result.chunks_added == 1


def test_content_sha256_is_stable_for_identical_content() -> None:
    assert indexer.content_sha256("abc") == indexer.content_sha256("abc")
    assert indexer.content_sha256("abc") != indexer.content_sha256("abd")
