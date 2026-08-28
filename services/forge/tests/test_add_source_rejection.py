"""R8b at the ENDPOINT — a rejected `directory` Source writes no row.

test_directory_source.py covers the validator in isolation. This covers the thing the
acceptance criterion actually names: that POST /corpora/{id}/sources REJECTS and that NO
`sources` row survives the rejection.

Those are two different claims. A validator that returns the right message while the
endpoint inserts anyway would pass every test in the other file — and would reproduce the
original defect one layer down, since ingestion would then walk the unreadable path exactly
as before. The INSERT assertion is the point of this file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from armada_forge import corpora


class RecordingDB:
    """Records every statement so the test can assert what was NOT executed."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def _record(self, sql: str) -> None:
        self.statements.append(" ".join(sql.split()))

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        self._record(sql)
        if "FROM corpora" in sql:
            return {"corpus_id": "c1", "name": "smoke"}
        # An INSERT reaching here is the failure this file exists to catch, but return a
        # plausible row anyway — the assertion should be the explicit one below, not an
        # incidental crash that happens to have the right colour.
        return {"source_id": "s1"}

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        self._record(sql)
        return []

    def execute(self, sql: str, params: Any = None) -> int:
        self._record(sql)
        return 1

    def scalar(self, sql: str, params: Any = None) -> Any:
        self._record(sql)
        return 0

    @property
    def inserted_a_source(self) -> bool:
        return any("INSERT INTO sources" in s for s in self.statements)


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> RecordingDB:
    recording = RecordingDB()
    monkeypatch.setattr(corpora, "db", recording)
    return recording


@pytest.fixture
def ingest_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ingest"
    root.mkdir()
    monkeypatch.setenv("ARMADA_INGEST_ROOT", str(root))
    return root


def add(location: str) -> Any:
    return corpora.add_source(
        "c1",
        corpora.SourceCreate(type="directory", location=location, include_globs=["**/*.md"]),
    )


def test_an_out_of_root_directory_is_refused_AND_writes_no_row(
    db: RecordingDB, ingest_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "unmounted"
    outside.mkdir()

    with pytest.raises(HTTPException) as caught:
        add(str(outside))

    assert caught.value.status_code == 400
    assert not db.inserted_a_source, (
        "a rejected registration left a `sources` row behind — ingestion would then walk "
        "the unreadable path exactly as it did before the fix"
    )


def test_a_nonexistent_in_root_directory_is_refused_AND_writes_no_row(
    db: RecordingDB, ingest_root: Path
) -> None:
    with pytest.raises(HTTPException) as caught:
        add(str(ingest_root / "never-created"))

    assert caught.value.status_code == 400
    assert not db.inserted_a_source


def test_a_symlink_escape_is_refused_AND_writes_no_row(
    db: RecordingDB, ingest_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "secrets"
    outside.mkdir()
    (ingest_root / "innocent").symlink_to(outside)

    with pytest.raises(HTTPException) as caught:
        add(str(ingest_root / "innocent"))

    assert caught.value.status_code == 400
    assert not db.inserted_a_source


def test_the_400_carries_the_actionable_message_not_a_bare_status(
    db: RecordingDB, ingest_root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "unmounted"
    outside.mkdir()

    with pytest.raises(HTTPException) as caught:
        add(str(outside))

    # The original defect was silence. A bare 400 would end the silence without telling
    # anyone what to change, which is only half a fix — so the message is part of the
    # contract, not decoration.
    detail = str(caught.value.detail)
    assert str(outside) in detail
    assert "ARMADA_INGEST_ROOT" in detail


def test_a_valid_in_root_directory_IS_inserted(db: RecordingDB, ingest_root: Path) -> None:
    """The other half — validation that rejects everything would pass every test above."""
    good = ingest_root / "docs"
    good.mkdir()

    add(str(good))

    assert db.inserted_a_source


def test_a_git_source_is_not_subjected_to_the_directory_check(
    db: RecordingDB, ingest_root: Path
) -> None:
    """R8b is scoped to `directory`. A git URL is not a path and must not be root-checked."""
    corpora.add_source(
        "c1",
        corpora.SourceCreate(type="git", location="https://github.com/example/repo.git"),
    )

    assert db.inserted_a_source
