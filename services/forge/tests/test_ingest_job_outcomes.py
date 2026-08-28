"""R8c — an all-zero-match ingest is a FAILURE, and ONLY the all-zero case.

Zero files from a Source the operator explicitly registered is a fault, not an empty
result. Reporting it as `succeeded` is how a misconfiguration survives to be discovered
much later — which is exactly what happened with unmounted `directory` Sources.

THE SCOPING TESTS ARE THE ONES THAT MATTER. Widening this beyond all-zero would turn a
working corpus with one stale Source into a failing one. Both directions are asserted:
all-zero fails, and anything short of all-zero keeps the behaviour it had.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from armada_forge.ingest import job as ingest_job
from armada_forge.ingest.chunker import Chunk
from armada_forge.ingest.extractor import ExtractedFile


class FakeDB:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.sources = sources
        self.job_status: str | None = None
        self.job_error: str | None = None
        self.source_results: dict[str, Any] = {}

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return self.sources if "FROM sources" in sql else []

    def execute(self, sql: str, params: Any = None) -> int:
        flat = " ".join(sql.split())
        if flat.startswith("UPDATE ingestion_jobs SET status"):
            self.job_status = params[0]
            self.source_results = json.loads(params[4])
        elif "UPDATE ingestion_jobs SET error" in flat:
            self.job_error = params[0]
        return 1


def source_row(source_id: str, location: str) -> dict[str, Any]:
    return {
        "source_id": source_id,
        "type": "directory",
        "location": location,
        "include_globs": [],
        "exclude_globs": [],
    }


@pytest.fixture
def run_job(monkeypatch: pytest.MonkeyPatch):
    """Run one ingestion with fetch/walk/extract/index stubbed.

    `files_per_source` maps source_id to how many extractable files that Source yields, so
    a mixed job — one Source matching, one matching nothing — is expressible. That mix is
    the scoping case R8c must NOT catch.
    """

    def run(
        sources: list[dict[str, Any]],
        files_per_source: dict[str, int],
        failing: set[str] | None = None,
    ) -> FakeDB:
        db = FakeDB(sources)
        failing = failing or set()
        monkeypatch.setattr(ingest_job, "db", db)

        class Fetched:
            def __init__(self, source_id: str) -> None:
                self.root = Path(f"/stub/{source_id}")
                self.cleanup = None

        # The job fetches by (type, location), so map location back to its source_id.
        by_location = {row["location"]: row["source_id"] for row in sources}

        def fetch(source_type: str, location: str) -> Fetched:
            source_id = by_location[location]
            if source_id in failing:
                raise ingest_job.sources.SourceFetchError("clone failed")
            return Fetched(source_id)

        monkeypatch.setattr(ingest_job.sources, "fetch", fetch)
        monkeypatch.setattr(ingest_job.sources, "cleanup", lambda *_: None)

        def walk(root: Path, include: Any, exclude: Any) -> list[tuple[Path, str]]:
            source_id = root.name
            return [
                (root / f"doc{i}.md", f"doc{i}.md")
                for i in range(files_per_source.get(source_id, 0))
            ]

        monkeypatch.setattr(ingest_job.sources, "walk_files", walk)
        monkeypatch.setattr(ingest_job.extractor, "is_ingestable", lambda *_: True)
        monkeypatch.setattr(
            ingest_job.extractor,
            "extract",
            lambda path, rel, exts: ExtractedFile(source_path=rel, text="body", is_code=False),
        )
        monkeypatch.setattr(
            ingest_job,
            "chunk",
            lambda text, is_code: [Chunk(content=text, token_count=1, start_line=1, end_line=1, split_oversize=False)],
        )
        monkeypatch.setattr(
            ingest_job.indexer,
            "index_source",
            lambda corpus_id, source_id, file_chunks: ingest_job.indexer.IndexResult(
                chunks_added=len(file_chunks), chunks_removed=0, chunks_unchanged=0
            ),
        )

        ingest_job.run_ingestion("job-1", "corpus-1", frozenset({".md"}), None)
        return db

    return run


A = "/var/lib/armada/ingest/alpha"
B = "/var/lib/armada/ingest/beta"


def test_every_source_matching_zero_ends_FAILED(run_job) -> None:
    """R8c — the fault case. This is what an unmounted directory looks like."""
    db = run_job([source_row("s1", A), source_row("s2", B)], files_per_source={})
    assert db.job_status == "failed", "an all-zero ingest must never report succeeded"


def test_the_failure_names_each_source_and_points_at_the_root(run_job) -> None:
    db = run_job([source_row("s1", A), source_row("s2", B)], files_per_source={})

    assert db.job_error is not None
    # With several Sources, "something matched nothing" is unactionable — the operator
    # needs to know WHICH, and what to do about it.
    assert A in db.job_error
    assert B in db.job_error
    assert "ARMADA_INGEST_ROOT" in db.job_error


# ── THE SCOPING GUARDS ───────────────────────────────────────────────────────

def test_ONE_source_matching_zero_still_ends_SUCCEEDED(run_job) -> None:
    """The regression guard that matters most.

    A corpus with one stale Source alongside working ones must keep ingesting. Widening
    R8c past the all-zero case would turn that working corpus into a failing one.
    """
    db = run_job([source_row("s1", A), source_row("s2", B)], files_per_source={"s1": 3})

    assert db.job_status == "succeeded"
    assert db.job_error is None


def test_a_mixed_fetch_failure_still_ends_PARTIAL(run_job) -> None:
    """Edge 1 is untouched: one Source failing to fetch while another succeeds is partial."""
    db = run_job(
        [source_row("s1", A), source_row("s2", B)],
        files_per_source={"s1": 2},
        failing={"s2"},
    )

    assert db.job_status == "partial"
    assert db.job_error is None, "partial is not the R8c fault path"


def test_every_source_FAILING_to_fetch_still_ends_FAILED_not_zero_matches(run_job) -> None:
    """All Sources failing to fetch was already `failed` via edge 1, and stays that way.

    R8c must not relabel it — the error should describe the fetch failures, not claim the
    globs matched nothing.
    """
    db = run_job(
        [source_row("s1", A), source_row("s2", B)],
        files_per_source={},
        failing={"s1", "s2"},
    )

    assert db.job_status == "failed"
    assert db.job_error is None, "the R8c message must not overwrite a fetch failure"


def test_all_sources_matching_files_ends_SUCCEEDED(run_job) -> None:
    db = run_job([source_row("s1", A), source_row("s2", B)], files_per_source={"s1": 1, "s2": 4})
    assert db.job_status == "succeeded"
    assert db.job_error is None
