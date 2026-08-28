"""P11 — the held-out evaluation split. Training R33, R33a; edge 21.

TWO ACCEPTANCE CRITERIA LIVE HERE, and they are the pair that keeps the gate honest:

  * splitting a dataset built with `include_trajectories: true` places ZERO
    `origin: trajectory` samples in the eval file;
  * `origin: supplied` samples DO appear in it.

A trajectory's reference response is a small model's own prior output, so scoring a
candidate against one compares the model to its own predecessor and measures nothing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from armada_forge.datasets import builder, split


class FakeDB:
    def __init__(self, dataset: dict[str, Any], consumed: int = 0) -> None:
        self.dataset = dataset
        self.consumed = consumed
        self.updates: list[tuple[Any, ...]] = []

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        return self.dataset

    def scalar(self, sql: str, params: Any = None) -> Any:
        return self.consumed

    def execute(self, sql: str, params: Any = None) -> int:
        self.updates.append(params)
        return 1


def _records(supplied: int = 8, trajectory: int = 4, distilled: int = 0) -> list[dict[str, Any]]:
    records = []
    for i in range(supplied):
        records.append({"instruction": f"s{i}", "response": "r", "origin": "supplied"})
    for i in range(trajectory):
        records.append({"instruction": f"t{i}", "response": "r", "origin": "trajectory"})
    for i in range(distilled):
        records.append({"instruction": f"d{i}", "response": "r", "origin": "distilled"})
    return records


@pytest.fixture
def dataset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(builder, "DATASETS_ROOT", tmp_path)

    def make(records: list[dict[str, Any]], consumed: int = 0) -> tuple[str, FakeDB]:
        dataset_id = "11111111-1111-1111-1111-111111111111"
        path = builder.artifact_path(dataset_id)
        split.write_jsonl(path, records)
        fake = FakeDB(
            {"dataset_id": dataset_id, "artifact_path": str(path), "eval_split_path": None},
            consumed=consumed,
        )
        monkeypatch.setattr(split, "db", fake)
        return dataset_id, fake

    return make


def _eval_records(dataset_id: str) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in builder.eval_split_path(dataset_id).read_text().splitlines()
        if line.strip()
    ]


# ── R33: what may be held out ────────────────────────────────────────────────

def test_no_trajectory_sample_reaches_the_eval_file(dataset) -> None:
    """The acceptance criterion, verbatim."""
    dataset_id, _ = dataset(_records(supplied=8, trajectory=12))

    result = split.split_dataset(dataset_id, 0.5)

    assert result["trajectory_samples_held_out"] == 0
    assert all(record["origin"] != "trajectory" for record in _eval_records(dataset_id))


def test_supplied_samples_do_reach_the_eval_file(dataset) -> None:
    dataset_id, _ = dataset(_records(supplied=10, trajectory=0))

    split.split_dataset(dataset_id, 0.3)

    origins = {record["origin"] for record in _eval_records(dataset_id)}
    assert origins == {"supplied"}


def test_distilled_samples_are_eligible_too(dataset) -> None:
    """R16a — a distilled response is also a reference written by something other than the
    model under test."""
    dataset_id, _ = dataset(_records(supplied=0, trajectory=0, distilled=10))

    split.split_dataset(dataset_id, 0.4)

    assert {r["origin"] for r in _eval_records(dataset_id)} == {"distilled"}


# ── Edge 21: a trajectory-only dataset cannot be split ───────────────────────

def test_a_trajectory_only_dataset_is_refused_naming_the_constraint(dataset) -> None:
    """Edge 21 — and the message must say the dataset is still usable for a smoke run, or
    the operator reads a dead end where there is a working path."""
    dataset_id, _ = dataset(_records(supplied=0, trajectory=6))

    with pytest.raises(split.SplitError) as caught:
        split.split_dataset(dataset_id, 0.1)

    message = str(caught.value)
    assert "trajectory" in message
    assert "smoke run" in message


# ── "Reserved" has to mean withdrawn ─────────────────────────────────────────

def test_held_out_rows_are_removed_from_the_training_file(dataset) -> None:
    """Otherwise `held_out_perplexity` is a memorisation test rather than a held-out one.

    R35c records that the split shares the training DISTRIBUTION; sharing the actual rows
    would be a defect on top of that limitation, not an instance of it.
    """
    dataset_id, _ = dataset(_records(supplied=10, trajectory=0))

    result = split.split_dataset(dataset_id, 0.2)

    train = [
        json.loads(line)
        for line in builder.artifact_path(dataset_id).read_text().splitlines()
        if line.strip()
    ]
    held_out = _eval_records(dataset_id)
    assert len(train) == result["train_sample_count"] == 8
    assert len(held_out) == 2
    train_instructions = {record["instruction"] for record in train}
    assert not any(record["instruction"] in train_instructions for record in held_out)


def test_the_selection_is_deterministic(dataset) -> None:
    """A re-split after an interrupted one must not silently change what the gate scores."""
    records = _records(supplied=20, trajectory=0)
    first, _ = dataset(records)
    split.split_dataset(first, 0.25)
    chosen = [r["instruction"] for r in _eval_records(first)]

    train, held_out = split.select_held_out(records, 0.25, first)
    assert [r["instruction"] for r in held_out] == chosen
    assert len(train) == 15


def test_at_least_one_sample_is_held_out(dataset) -> None:
    """A fraction that rounds to zero would produce an empty eval file, and the gate would
    then reach a promotion decision having scored nothing."""
    dataset_id, _ = dataset(_records(supplied=3, trajectory=0))

    result = split.split_dataset(dataset_id, 0.01)

    assert result["eval_sample_count"] == 1


# ── R33's "before any training run consumes the dataset" ─────────────────────

def test_splitting_after_a_run_has_consumed_the_dataset_is_refused(dataset) -> None:
    """Enforced, not assumed. Re-splitting afterwards would move rows out of the file the
    Adapter actually trained on, and the gate would then score against a set the operator
    believes was held out and was not."""
    dataset_id, _ = dataset(_records(supplied=10, trajectory=0), consumed=1)

    with pytest.raises(split.SplitError) as caught:
        split.split_dataset(dataset_id, 0.1)

    assert "already been consumed" in str(caught.value)


@pytest.mark.parametrize("fraction", [0.0, 1.0, -0.1, 1.5])
def test_a_degenerate_fraction_is_refused(dataset, fraction: float) -> None:
    dataset_id, _ = dataset(_records())
    with pytest.raises(split.SplitError):
        split.split_dataset(dataset_id, fraction)


def test_the_dataset_row_records_the_split(dataset) -> None:
    dataset_id, fake = dataset(_records(supplied=10, trajectory=0))

    split.split_dataset(dataset_id, 0.2)

    path, fraction, sample_count, recorded_id = fake.updates[-1]
    assert path.endswith(".eval.jsonl")
    assert fraction == 0.2
    assert sample_count == 8
    assert recorded_id == dataset_id
