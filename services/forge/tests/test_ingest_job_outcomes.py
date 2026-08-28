"""R8c — an all-zero-match ingest is a FAILURE, and ONLY the all-zero case.

Zero files from a Source the operator explicitly registered is a fault, not an empty
result. Reporting it as `succeeded` is how a misconfiguration survives to be discovered
much later — which is exactly what happened with unmounted `directory` Sources.

THE SCOPING TESTS ARE THE ONES THAT MATTER. Widening this beyond all-zero would turn a
working corpus with one stale Source into a failing one. Both directions are asserted:
all-zero fails the job, and anything short of all-zero keeps the outcome it had — while
the stale Source is still labelled on its own merits, so it stays discoverable.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from armada_forge.ingest import job as ingest_job
from armada_forge.ingest.chunker import Chunk
from armada_forge.ingest.extractor import ExtractedFile

A = "/var/lib/armada/ingest/alpha"
B = "/var/lib/armada/ingest/beta"


class FakeDB:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.sources = sources
        self.job_status: str | None = None
        self.job_error: str | None = None
        self.source_results: dict[str, Any] = {}

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return self.sources if "FROM sources" in sql else []

    def execute(self, sql: str, params: Any = None) -> int:
        if " ".join(sql.split()).startswith("UPDATE ingestion_jobs SET status"):
            # Status, source_results and error land in ONE statement — there is no second
            # UPDATE to tell apart.
            self.job_status = params[0]
            self.source_results = json.loads(params[4])
            self.job_error = params[5]
        return 1

    def status_of(self, location: str) -> str:
        return next(r for r in self.source_results.values() if r["location"] == location)["status"]


def source_row(location: str) -> dict[str, Any]:
    return {
        # Keyed off the final segment — "alpha" and "beta" share a last CHARACTER, so a
        # naive location[-1] silently collapsed both Sources onto one dict key.
        "source_id": f"src-{location.rsplit('/', 1)[-1]}",
        "type": "directory",
        "location": location,
        "include_globs": [],
        "exclude_globs": [],
    }


@pytest.fixture
def run_job(monkeypatch: pytest.MonkeyPatch):
    """Run one ingestion with fetch/walk/extract/index stubbed.

    Keyed by LOCATION throughout, so a mixed job — one Source matching, another matching
    nothing — is expressed directly as `files_per_source={A: 3}`. That mix is the scoping
    case R8c must not catch, so it needs to be the easy thing to write.
    """

    def run(
        locations: list[str],
        files_per_source: dict[str, int] | None = None,
        failing: set[str] | None = None,
        extractable: bool = True,
    ) -> FakeDB:
        files_per_source = files_per_source or {}
        failing = failing or set()
        db = FakeDB([source_row(loc) for loc in locations])
        monkeypatch.setattr(ingest_job, "db", db)

        class Fetched:
            def __init__(self, location: str) -> None:
                self.root = Path(location)
                self.cleanup = None

        def fetch(source_type: str, location: str) -> Fetched:
            if location in failing:
                raise ingest_job.sources.SourceFetchError("clone failed")
            return Fetched(location)

        def walk(root: Path, include: Any, exclude: Any) -> list[tuple[Path, str]]:
            count = files_per_source.get(str(root), 0)
            return [(root / f"doc{i}.md", f"doc{i}.md") for i in range(count)]

        monkeypatch.setattr(ingest_job.sources, "fetch", fetch)
        monkeypatch.setattr(ingest_job.sources, "cleanup", lambda *_: None)
        monkeypatch.setattr(ingest_job.sources, "walk_files", walk)
        monkeypatch.setattr(ingest_job.extractor, "is_ingestable", lambda *_: True)
        monkeypatch.setattr(
            ingest_job.extractor,
            "extract",
            lambda path, rel, exts: (
                ExtractedFile(source_path=rel, text="body", is_code=False) if extractable else None
            ),
        )
        monkeypatch.setattr(
            ingest_job,
            "chunk",
            lambda text, is_code: [
                Chunk(content=text, token_count=1, start_line=1, end_line=1, split_oversize=False)
            ],
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


def test_every_source_matching_zero_ends_FAILED(run_job) -> None:
    """R8c — the fault case. This is what an unmounted directory looks like."""
    db = run_job([A, B])
    assert db.job_status == "failed", "an all-zero ingest must never report succeeded"


def test_the_failure_names_each_source_and_points_at_the_root(run_job) -> None:
    db = run_job([A, B])

    assert db.job_error is not None
    # With several Sources, "something matched nothing" is unactionable — the operator
    # needs to know WHICH, and what to do about it.
    assert A in db.job_error
    assert B in db.job_error
    assert "ARMADA_INGEST_ROOT" in db.job_error


def test_files_found_but_none_extractable_gives_DIFFERENT_advice(run_job) -> None:
    """Matched-but-unextractable is a different fault from matched-nothing.

    Telling an operator to check the mount and the globs is right when nothing was walked
    and actively misleading when forty files were found and none could be read. The two
    causes must not collapse into one message.
    """
    db = run_job([A], files_per_source={A: 40}, extractable=False)

    assert db.job_status == "failed"
    assert db.job_error is not None
    assert "matched 40 file(s)" in db.job_error
    assert "code-extensions.yaml" in db.job_error
    assert "ARMADA_INGEST_ROOT" not in db.job_error, (
        "the mount is demonstrably fine — 40 files were walked through it"
    )


# ── THE SCOPING GUARDS ───────────────────────────────────────────────────────

def test_ONE_source_matching_zero_still_ends_SUCCEEDED(run_job) -> None:
    """The regression guard that matters most.

    A corpus with one stale Source alongside working ones must keep ingesting. Widening
    R8c past the all-zero case would turn that working corpus into a failing one.
    """
    db = run_job([A, B], files_per_source={A: 3})

    assert db.job_status == "succeeded"
    assert db.job_error is None


def test_the_stale_source_is_STILL_labelled_even_though_the_job_succeeded(run_job) -> None:
    """Scoping the JOB status must not make the stale Source invisible.

    Leaving it `succeeded` with files_indexed: 0 would be the original defect preserved one
    level down — a green result hiding a Source that read nothing.
    """
    db = run_job([A, B], files_per_source={A: 3})

    assert db.status_of(A) == "succeeded"
    assert db.status_of(B) == "zero_matches"


def test_a_mixed_fetch_failure_still_ends_PARTIAL(run_job) -> None:
    """Edge 1 is untouched: one Source failing to fetch while another succeeds is partial."""
    db = run_job([A, B], files_per_source={A: 2}, failing={B})

    assert db.job_status == "partial"
    assert db.job_error is None, "partial is not the R8c fault path"


def test_every_source_FAILING_to_fetch_still_ends_FAILED_not_zero_matches(run_job) -> None:
    """All Sources failing to fetch was already `failed` via edge 1, and stays that way.

    R8c must not relabel it — the error should describe the fetch failures, not claim the
    globs matched nothing.
    """
    db = run_job([A, B], failing={A, B})

    assert db.job_status == "failed"
    assert db.job_error is None, "the R8c message must not overwrite a fetch failure"
    assert db.status_of(A) == "failed"


def test_all_sources_matching_files_ends_SUCCEEDED(run_job) -> None:
    db = run_job([A, B], files_per_source={A: 1, B: 4})

    assert db.job_status == "succeeded"
    assert db.job_error is None
    assert db.status_of(A) == "succeeded"
    assert db.status_of(B) == "succeeded"


def test_matched_and_indexed_are_recorded_separately(run_job) -> None:
    """The two numbers are the diagnosis; collapsing them loses it."""
    db = run_job([A], files_per_source={A: 5}, extractable=False)

    result = next(iter(db.source_results.values()))
    assert result["files_matched"] == 5, "the globs did match five files"
    assert result["files_indexed"] == 0, "none of them produced text"
