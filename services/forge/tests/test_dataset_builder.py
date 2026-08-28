"""P11 — dataset construction. Training R15, R16b, R18, R19, R20; edges 6, 22.

THE TEST THAT MATTERS MOST HERE IS THE ZERO-SPEND ONE. `test_corpus_source_is_refused_...`
asserts not only that a `corpus_id` is refused while the teacher is disabled, but that NO
OUTBOUND CONNECTION IS ATTEMPTED — edge 22's wording is "no outbound connection is
attempted", which a check performed after building a request would not satisfy. It is
enforced by making every socket call raise.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import pytest

from armada_forge.datasets import builder, supplied, trajectory
from armada_forge.teacher import TeacherClient, TeacherSettings


class FakeDB:
    """Only the two reads and one write `builder` performs."""

    def __init__(self, corpus_name: str | None = None) -> None:
        self.corpus_name = corpus_name
        self.rows: list[dict[str, Any]] = []

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        flat = " ".join(sql.split())
        if flat.startswith("SELECT name FROM corpora"):
            return {"name": self.corpus_name} if self.corpus_name else None
        if flat.startswith("INSERT INTO datasets"):
            dataset_id, corpus_id, sample_count, breakdown, path = params
            row = {
                "dataset_id": dataset_id,
                "corpus_id": corpus_id,
                "sample_count": sample_count,
                "source_breakdown": json.loads(breakdown),
                "artifact_path": path,
                "eval_split_path": None,
                "eval_fraction": None,
            }
            self.rows.append(row)
            return row
        return None

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return []


DISABLED_TEACHER = TeacherClient(
    TeacherSettings.from_config({"enabled": False, "provider": "none"}, {})
)


@pytest.fixture
def roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(builder, "DATASETS_ROOT", tmp_path / "datasets")
    monkeypatch.setattr(supplied, "SUPPLIED_ROOT", tmp_path / "supplied")
    return tmp_path


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> FakeDB:
    db = FakeDB()
    monkeypatch.setattr(builder, "db", db)
    # `trajectory` holds its own module-level reference to `db`, so patching only the
    # builder's would leave the trajectory reader talking to a pool that was never opened.
    monkeypatch.setattr(trajectory, "db", db)
    return db


def _write_supplied(count: int = 4) -> str:
    supplied.store(
        "seed",
        "".join(
            json.dumps({"instruction": f"q{i}", "response": f"a{i}"}) + "\n"
            for i in range(count)
        ),
    )
    return "seed"


def _build(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "corpus_id": None,
        "include_trajectories": False,
        "agent_ids": None,
        "supplied_file": None,
        "max_samples": 0,
        "base_model_id": "qwen3-0.6b",
        "chat_template": "qwen3",
        "teacher_client": DISABLED_TEACHER,
        "distillation_config": {},
    }
    kwargs.update(overrides)
    return builder.build(**kwargs)


# ── R15: at least one source ─────────────────────────────────────────────────

def test_a_request_naming_no_source_is_refused_naming_all_three(roots: Path, fake_db: FakeDB) -> None:
    with pytest.raises(builder.DatasetBuildError) as caught:
        _build()

    message = str(caught.value)
    for source in ("corpus_id", "supplied_file", "include_trajectories"):
        assert source in message


# ── R16b / edge 22: the zero-spend refusal ───────────────────────────────────

def test_corpus_source_is_refused_with_no_outbound_connection(
    roots: Path, fake_db: FakeDB, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Edge 22 — "no outbound connection is attempted", enforced rather than asserted.

    Every socket is made to raise, so a refusal that happened AFTER opening one would fail
    this test with a connection error rather than passing with a tidy message.
    """
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the teacher-disabled path opened a socket")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)

    with pytest.raises(builder.DatasetBuildError) as caught:
        _build(corpus_id="00000000-0000-0000-0000-000000000001")

    message = str(caught.value)
    assert "supplied_file" in message and "include_trajectories" in message
    assert "No outbound request was made" in message


# ── R19 / R18: what is written ───────────────────────────────────────────────

def test_jsonl_line_count_equals_the_recorded_sample_count(roots: Path, fake_db: FakeDB) -> None:
    """An acceptance criterion, verbatim."""
    row = _build(supplied_file=_write_supplied(5))

    lines = Path(row["artifact_path"]).read_text().strip().splitlines()
    assert len(lines) == row["sample_count"] == 5


def test_every_line_is_rendered_with_the_target_chat_template(roots: Path, fake_db: FakeDB) -> None:
    """R18 — rendered BEFORE being written to disk, with the target BaseModel's template."""
    row = _build(supplied_file=_write_supplied(2), chat_template="qwen3")

    for line in Path(row["artifact_path"]).read_text().strip().splitlines():
        record = json.loads(line)
        assert record["text"].startswith("<|im_start|>user\n")
        # The structured messages ride alongside so the trainer and the gate can use either
        # without re-deriving one from the other.
        assert record["messages"][0]["role"] == "user"


def test_the_render_target_is_recorded_in_the_breakdown(roots: Path, fake_db: FakeDB) -> None:
    """`datasets` owns no column for it (build-plan Req 20a bars a new migration), and the
    gate needs to know which template the file was rendered with."""
    row = _build(supplied_file=_write_supplied(), base_model_id="qwen3-0.6b", chat_template="qwen3")
    assert row["source_breakdown"]["base_model_id"] == "qwen3-0.6b"
    assert row["source_breakdown"]["chat_template"] == "qwen3"


def test_corpus_name_is_base_when_no_corpus_is_behind_the_dataset(roots: Path, fake_db: FakeDB) -> None:
    """R29 — the literal `base`, which is what makes the eventual ModelBinding tag
    well-formed for an Adapter trained purely on supplied JSONL."""
    row = _build(supplied_file=_write_supplied())
    assert row["source_breakdown"]["corpus_name"] == "base"


# ── R20: zero-sample outcomes ────────────────────────────────────────────────

def test_trajectories_yielding_zero_is_not_a_failure_when_another_source_exists(
    roots: Path, fake_db: FakeDB
) -> None:
    """R20 — a fresh installation has run nothing yet, and refusing to build a
    supplied-JSONL dataset on that basis would block the zero-cost path on a condition the
    operator cannot satisfy first."""
    row = _build(supplied_file=_write_supplied(3), include_trajectories=True)

    assert row["sample_count"] == 3
    assert row["source_breakdown"]["trajectory"] == 0


def test_every_source_yielding_zero_fails_naming_each_and_its_count(
    roots: Path, fake_db: FakeDB
) -> None:
    """R20 — construction FAILS rather than writing an empty dataset."""
    with pytest.raises(builder.DatasetBuildError) as caught:
        _build(include_trajectories=True)

    message = str(caught.value)
    assert "include_trajectories: 0" in message
    assert "no dataset was written" in message
    assert fake_db.rows == [], "an empty dataset must leave no row behind"


def test_a_failed_build_writes_no_file(roots: Path, fake_db: FakeDB) -> None:
    """Steps 5 and 6 are ordered so a refusal precedes both the write and the row."""
    with pytest.raises(builder.DatasetBuildError):
        _build(include_trajectories=True)

    assert not (roots / "datasets").exists() or not list((roots / "datasets").iterdir())


# ── Edge 6: max_samples above what exists ────────────────────────────────────

def test_max_samples_above_the_available_count_is_not_an_error(roots: Path, fake_db: FakeDB) -> None:
    row = _build(supplied_file=_write_supplied(3), max_samples=100)
    assert row["sample_count"] == 3


def test_max_samples_truncates(roots: Path, fake_db: FakeDB) -> None:
    row = _build(supplied_file=_write_supplied(10), max_samples=4)
    assert row["sample_count"] == 4
    assert len(Path(row["artifact_path"]).read_text().strip().splitlines()) == 4
