"""Regressions for the two CodeQL findings on the ingestion path.

Both are here rather than split across the existing files because they share one property
worth stating once: THE INPUT IS INGESTED CORPUS CONTENT. A Corpus Source is a git repo, a
docs URL, an uploaded file or a directory — material that arrives from outside and is then
walked, chunked and embedded. "Single-operator, trusted-network" describes who calls the
API, not what the API is pointed at.

  py/redos (alert 1)          services/forge/armada_forge/ingest/chunker.py
  py/path-injection (2-5)     services/forge/armada_forge/ingest/directory_source.py
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from armada_forge.ingest.chunker import _TOP_LEVEL_DEF
from armada_forge.ingest.directory_source import resolve_directory_location


# ── py/redos ─────────────────────────────────────────────────────────────────
# `(?:@\w[\w.]*.*\n)*` gave the engine two ways to divide every decorator line between
# `[\w.]*` and `.*`, because the first is a subset of the second. 2^n over n lines.


def test_decorator_stack_above_a_def_still_matches() -> None:
    """The quantifier was redundant, so removing it must not change what matches."""
    assert _TOP_LEVEL_DEF.search("@app.route('/x')\ndef handler():\n")
    assert _TOP_LEVEL_DEF.search("@a\n@b.c\n@d.e.f(1, 2)\nclass Thing:\n")
    assert _TOP_LEVEL_DEF.search("@Override\npublic void run() {\n")


def test_a_bare_decorator_is_not_a_definition() -> None:
    """Guards against 'fixing' the regex by loosening it until everything matches."""
    assert not _TOP_LEVEL_DEF.search("@decorator_with_no_definition_under_it\n")
    assert not _TOP_LEVEL_DEF.search("    def indented_is_a_method(self):\n")


def test_the_catastrophic_input_completes_promptly() -> None:
    """CodeQL's witness: '@a' then many repetitions of '.\\n@a'.

    A WALL-CLOCK BUDGET IS THE ONLY HONEST ASSERTION HERE. The property under test is
    "this terminates in reasonable time", and there is nothing else to observe — the old
    pattern returns the same answer, eventually. 5s is ~4 orders of magnitude above the
    fixed pattern's real cost and far below the old one's, so it cannot pass by accident
    and will not flake on a loaded runner.
    """
    pathological = "@a" + ".\n@a" * 40

    start = time.monotonic()
    _TOP_LEVEL_DEF.search(pathological)
    elapsed = time.monotonic() - start

    assert elapsed < 5.0, f"regex took {elapsed:.1f}s — the backtracking blowup is back"


# ── py/path-injection ────────────────────────────────────────────────────────
# The validator resolved the location, then `_fetch_directory` resolved it AGAIN and
# walked that second result. The value checked was not the value used.


@pytest.fixture
def ingest_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ingest"
    root.mkdir()
    monkeypatch.setenv("ARMADA_INGEST_ROOT", str(root))
    return root


def test_the_validator_hands_back_the_path_it_validated(ingest_root: Path) -> None:
    source = ingest_root / "docs"
    source.mkdir()

    resolved, problem = resolve_directory_location(str(source))

    assert problem is None
    assert resolved == source.resolve()


def test_a_symlink_inside_the_root_returns_its_target_not_the_link(ingest_root: Path) -> None:
    """The returned path is post-resolution, so a caller cannot re-follow the link itself.

    This is the whole point: the caller now receives an already-resolved path and has no
    reason to touch `location` again. Re-resolving is what opened the window where a link
    swapped between the two calls passes containment and then escapes it.
    """
    target = ingest_root / "real"
    target.mkdir()
    link = ingest_root / "link"
    link.symlink_to(target)

    resolved, problem = resolve_directory_location(str(link))

    assert problem is None
    assert resolved == target.resolve()
    assert resolved != link


def test_a_rejected_location_yields_no_path_at_all(ingest_root: Path, tmp_path: Path) -> None:
    """`None` rather than a best-effort path, so a caller cannot use a rejected value."""
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    resolved, problem = resolve_directory_location(str(outside))

    assert resolved is None
    assert problem is not None
    assert "outside ARMADA_INGEST_ROOT" in problem
