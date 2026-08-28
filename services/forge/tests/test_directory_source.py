"""R8b — registration-time validation of `directory` Sources.

The original defect was SILENCE: a path that was not mounted into forge simply was not
there, so ingestion walked an empty tree, produced no chunks, and reported success. The
operator was told their corpus ingested fine when nothing had been read.

These tests pin the two halves of the fix — that a bad path is refused at registration,
and that the refusal says enough to act on. A terse 400 would stop the failure being
silent while still not telling anyone what to change.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from armada_forge.ingest.directory_source import validate_directory_location


@pytest.fixture
def ingest_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ingest"
    root.mkdir()
    monkeypatch.setenv("ARMADA_INGEST_ROOT", str(root))
    return root


def test_a_readable_in_root_path_is_accepted(ingest_root: Path) -> None:
    source = ingest_root / "docs"
    source.mkdir()
    assert validate_directory_location(str(source)) is None


def test_the_root_itself_is_accepted(ingest_root: Path) -> None:
    assert validate_directory_location(str(ingest_root)) is None


# ── Escapes: three routes, one containment rule ──────────────────────────────

def test_an_absolute_path_outside_the_root_is_refused(ingest_root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    problem = validate_directory_location(str(outside))

    assert problem is not None
    assert "outside ARMADA_INGEST_ROOT" in problem


def test_a_dotdot_escape_is_refused(ingest_root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    # Textually beneath the root, but resolves outside it.
    escape = str(ingest_root / ".." / "elsewhere")
    problem = validate_directory_location(escape)

    assert problem is not None
    assert "outside ARMADA_INGEST_ROOT" in problem


def test_a_symlink_escape_is_refused(ingest_root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "secrets"
    outside.mkdir()
    link = ingest_root / "innocent"
    link.symlink_to(outside)

    # The link LIVES under the root; only its target escapes. A containment check that
    # compared the literal path rather than the resolved one would pass this.
    problem = validate_directory_location(str(link))

    assert problem is not None
    assert "outside ARMADA_INGEST_ROOT" in problem


def test_a_sibling_sharing_the_root_prefix_is_refused(ingest_root: Path) -> None:
    # `/…/ingest-evil` starts with the root's text but is not inside it. A string-prefix
    # containment check would let this through.
    sibling = Path(f"{ingest_root}-evil")
    sibling.mkdir()

    problem = validate_directory_location(str(sibling))

    assert problem is not None
    assert "outside ARMADA_INGEST_ROOT" in problem


# ── Other rejections ─────────────────────────────────────────────────────────

def test_a_missing_path_inside_the_root_is_refused(ingest_root: Path) -> None:
    problem = validate_directory_location(str(ingest_root / "not-there"))
    assert problem is not None
    assert "does not exist" in problem


def test_a_file_rather_than_a_directory_is_refused(ingest_root: Path) -> None:
    target = ingest_root / "a-file.md"
    target.write_text("content")

    problem = validate_directory_location(str(target))

    assert problem is not None
    assert "not a directory" in problem


def test_a_relative_path_is_refused(ingest_root: Path) -> None:
    problem = validate_directory_location("relative/docs")
    assert problem is not None
    assert "absolute" in problem


def test_an_unreadable_directory_is_refused(ingest_root: Path) -> None:
    locked = ingest_root / "locked"
    locked.mkdir()
    os.chmod(locked, 0o000)
    try:
        problem = validate_directory_location(str(locked))
        # Skips under a user that bypasses permission bits, which is the common case in
        # containers running as root — asserting there would test the runner, not the code.
        if os.access(locked, os.R_OK | os.X_OK):
            pytest.skip("running as a user that bypasses permission bits")
        assert problem is not None
        assert "cannot read it" in problem
        # The mount is :ro, so advising a write-permission fix would be impossible to act
        # on. The remedy has to be read+execute.
        assert "read and execute" in problem
    finally:
        os.chmod(locked, 0o755)


# ── The message has to be actionable ─────────────────────────────────────────

def test_the_refusal_names_the_path_the_root_and_the_mount_requirement(
    ingest_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()

    problem = validate_directory_location(str(outside))
    assert problem is not None

    # R8b names all three deliberately: an operator reading this should know what to change
    # WITHOUT opening the spec. That is the difference between fixing the silence and
    # actually fixing the defect.
    assert str(outside) in problem, "names the offending path"
    assert "ARMADA_INGEST_ROOT" in problem, "names the root"
    assert "bind-mount" in problem or "mounted" in problem, "names the mount requirement"


def test_the_root_default_matches_the_compose_default() -> None:
    from armada_forge.ingest.directory_source import DEFAULT_INGEST_ROOT

    # docker-compose.yml uses ${ARMADA_INGEST_ROOT:-/var/lib/armada/ingest}. A drift here
    # would make the error message name a root the deployment does not use.
    assert DEFAULT_INGEST_ROOT == "/var/lib/armada/ingest"
