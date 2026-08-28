"""Held-out evaluation split — Training R33, R33a; edge 21.

WHAT THE SPLIT IS FOR, STATED ONCE: it exists SOLELY to gate promotion. That single fact
decides two behaviours that otherwise look inconsistent —

  * a run that could produce a promotable Adapter is refused without a prior split (R33a),
  * a smoke run against the same split-less dataset is accepted, because a smoke Adapter is
    never promotable under any outcome (R37).

TRAJECTORY SAMPLES ARE NEVER HELD OUT (R33, R16a). Their reference response is a small
model's own prior output, so scoring a candidate against them compares the model to its own
predecessor and measures nothing. A dataset whose samples are ALL trajectories therefore
cannot be split at all (edge 21) — and that is not a dead end: it can still be used for a
smoke run, which is the zero-cost path.

THE HELD-OUT ROWS ARE REMOVED FROM THE TRAINING FILE. "Reserved" has to mean withdrawn, or
the gate scores the candidate on rows it was trained on directly and `held_out_perplexity`
becomes a memorisation test. R35c already records that the split shares the training
DISTRIBUTION; sharing the actual rows would be a defect on top of that limitation, not an
instance of it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from armada_forge import db
from armada_forge.datasets.builder import artifact_path, eval_split_path

# R33/R16a — the two origins whose reference response was written by something other than
# the model under test.
ELIGIBLE_ORIGINS: frozenset[str] = frozenset({"distilled", "supplied"})


class SplitError(Exception):
    """A split refused for a reason the operator can act on. Becomes HTTP 400 or 409."""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise SplitError(f"dataset file `{path}` is missing")
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


def select_held_out(
    records: list[dict[str, Any]], eval_fraction: float, seed: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (train, held_out).

    DETERMINISTIC, seeded on the dataset_id. Two calls over the same file choose the same
    rows, so a re-split after an interrupted one does not silently change what the gate
    will score. Ordering by a hash rather than by `random.shuffle` keeps that property
    independent of the interpreter's PRNG implementation.
    """
    eligible_indices = [
        index for index, record in enumerate(records)
        if record.get("origin") in ELIGIBLE_ORIGINS
    ]

    if not eligible_indices:
        # Edge 21 — naming the constraint, because "cannot split" without the reason reads
        # as a bug rather than as the deliberate rule it is.
        raise SplitError(
            "every sample in this dataset has `origin: trajectory`, and R33 draws the "
            "held-out set only from `distilled` or `supplied` samples — a trajectory's "
            "reference response is the model's own prior output. This dataset can still "
            "be used for a local smoke run, which is never promotable and therefore needs "
            "no split."
        )

    wanted = max(1, round(len(eligible_indices) * eval_fraction))
    wanted = min(wanted, len(eligible_indices))

    ranked = sorted(
        eligible_indices,
        key=lambda index: hashlib.sha256(f"{seed}:{index}".encode()).hexdigest(),
    )
    held_out_indices = set(ranked[:wanted])

    train = [record for index, record in enumerate(records) if index not in held_out_indices]
    held_out = [records[index] for index in ranked[:wanted]]
    return train, held_out


def split_dataset(dataset_id: str, eval_fraction: float) -> dict[str, Any]:
    """R33 — reserve the held-out set BEFORE any training run consumes the dataset."""
    dataset = db.query_one(
        "SELECT dataset_id, artifact_path, eval_split_path FROM datasets WHERE dataset_id = %s",
        (dataset_id,),
    )
    if dataset is None:
        raise SplitError(f"no dataset with dataset_id {dataset_id}")

    if not 0 < eval_fraction < 1:
        raise SplitError(f"eval_fraction {eval_fraction} must be strictly between 0 and 1")

    # R33's "before any training run consumes the dataset", enforced rather than assumed.
    # Re-splitting after a run would move rows out of the training file the Adapter was
    # actually trained on, and the gate would then score against a set the operator
    # believes was held out and was not.
    consumed = db.scalar(
        "SELECT count(*) FROM training_runs WHERE dataset_id = %s", (dataset_id,)
    )
    if consumed:
        raise SplitError(
            f"dataset {dataset_id} has already been consumed by {consumed} training run(s); "
            "the split must be reserved before the first run"
        )

    train_path = Path(dataset["artifact_path"] or artifact_path(dataset_id))
    records = read_jsonl(train_path)

    train, held_out = select_held_out(records, eval_fraction, str(dataset_id))

    held_out_path = eval_split_path(dataset_id)
    write_jsonl(held_out_path, held_out)
    write_jsonl(train_path, train)

    db.execute(
        """
        UPDATE datasets
           SET eval_split_path = %s, eval_fraction = %s, sample_count = %s
         WHERE dataset_id = %s
        """,
        (str(held_out_path), eval_fraction, len(train), dataset_id),
    )

    return {
        "dataset_id": str(dataset_id),
        "eval_split_path": str(held_out_path),
        "eval_fraction": eval_fraction,
        "train_sample_count": len(train),
        "eval_sample_count": len(held_out),
        # Asserted in the response, not merely in a test: an operator reading this can see
        # the R33 guarantee held for their data.
        "trajectory_samples_held_out": sum(
            1 for record in held_out if record.get("origin") == "trajectory"
        ),
    }
