"""Dataset assembly — Training R15, R16b, R18, R19, R20; edges 5, 6, 22.

ORDER OF OPERATIONS IS LOAD-BEARING, and it is this:

  1. refuse a request naming no source at all (R15)
  2. refuse a `corpus_id` while the teacher is disabled, BEFORE any collection (R16b)
  3. collect from every named source
  4. refuse when every named source yielded zero, naming each and its count (R20)
  5. write the JSONL
  6. insert the `datasets` row

Steps 5 and 6 are in that order so a failed write leaves no row. Step 4 precedes both so an
empty dataset is never written at all — R20 is explicit that construction FAILS rather than
recording a dataset with nothing in it, because a zero-sample dataset would otherwise reach
`POST /training/runs` and produce a training run with nothing to train on.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from armada_forge import db
from armada_forge.datasets import distill, render, supplied, trajectory
from armada_forge.teacher import TeacherClient, TeacherDisabled, TeacherUnreachable

DATASETS_ROOT = Path(os.environ.get("ARMADA_DATASETS_ROOT", "/data/datasets"))

# R15's three sources, in the order they are reported back to the operator.
SOURCE_NAMES = ("corpus_id", "supplied_file", "include_trajectories")


class DatasetBuildError(Exception):
    """A build refused for a reason the operator can act on. Becomes HTTP 400."""


def artifact_path(dataset_id: str) -> Path:
    """R19 — `/data/datasets/{dataset_id}.jsonl`."""
    return DATASETS_ROOT / f"{dataset_id}.jsonl"


def eval_split_path(dataset_id: str) -> Path:
    """R33 — `/data/datasets/{dataset_id}.eval.jsonl`."""
    return DATASETS_ROOT / f"{dataset_id}.eval.jsonl"


def _corpus_name(corpus_id: str | None) -> str:
    """R29 — the `corpus_name` an Adapter from this dataset will carry.

    The literal `base` when the dataset had no Corpus behind it, which is what makes a
    ModelBinding tag well-formed for an Adapter trained purely on supplied JSONL or
    trajectories.
    """
    if not corpus_id:
        return "base"
    row = db.query_one("SELECT name FROM corpora WHERE corpus_id = %s", (corpus_id,))
    return str(row["name"]) if row else "base"


def build(
    *,
    corpus_id: str | None,
    include_trajectories: bool,
    agent_ids: list[str] | None,
    supplied_file: str | None,
    max_samples: int,
    base_model_id: str,
    chat_template: str,
    teacher_client: TeacherClient,
    distillation_config: dict[str, Any],
) -> dict[str, Any]:
    """Build one dataset and return its recorded row.

    `base_model_id` and `chat_template` are parameters rather than looked up here because
    R18 renders against the TARGET BaseModel, and choosing that target is the caller's job:
    the route defaults it to the `smoke_test` entry, which is the only model a zero-cost
    installation can train.
    """
    named = [
        name
        for name, present in (
            ("corpus_id", bool(corpus_id)),
            ("supplied_file", bool(supplied_file)),
            ("include_trajectories", include_trajectories),
        )
        if present
    ]

    # R15 — a request naming none of the three is refused NAMING ALL THREE. An operator who
    # posted an empty body needs to be told what a valid one contains.
    if not named:
        raise DatasetBuildError(
            "a dataset needs at least one source: `corpus_id`, `supplied_file`, or "
            "`include_trajectories: true`"
        )

    # R16b / edge 22 — CHECKED BEFORE ANY COLLECTION, and independently of whether the
    # Corpus has chunks. Deferring this to the distillation call would let an EMPTY Corpus
    # distil zero samples, return quietly, and never fire the refusal — the request would
    # then fail later under R20's "every named source yielded zero" message, which names
    # the wrong cause entirely.
    if corpus_id:
        try:
            teacher_client.require_enabled()
        except TeacherDisabled as exc:
            # The refusal names the two teacher-free sources rather than merely stating the
            # teacher is off, because the operator's next action is to pick one of them.
            raise DatasetBuildError(
                "corpus distillation requires a teacher, and config/teacher.yaml has "
                "`enabled: false`. No outbound request was made. The teacher-free sources "
                "are `supplied_file` and `include_trajectories`."
            ) from exc

    counts: dict[str, int] = {}
    samples: list[dict[str, Any]] = []

    # ── supplied (free) ──────────────────────────────────────────────────────
    if supplied_file:
        try:
            supplied_samples = supplied.read(supplied_file)
        except supplied.SuppliedValidationError as exc:
            raise DatasetBuildError("; ".join(exc.problems)) from exc
        counts["supplied"] = len(supplied_samples)
        samples.extend(supplied_samples)

    # ── trajectories (free) ──────────────────────────────────────────────────
    if include_trajectories:
        trajectory_samples = trajectory.collect(agent_ids)
        # R20 — zero successful Runs is NOT a failure when another source was also named.
        # A fresh installation has run nothing yet, and refusing to build a supplied-JSONL
        # dataset because no agent has ever succeeded would block the zero-cost path on a
        # condition the operator cannot satisfy first.
        counts["trajectory"] = len(trajectory_samples)
        samples.extend(trajectory_samples)

    # ── distillation (the only source that can spend) ────────────────────────
    if corpus_id:
        try:
            distilled = distill.distil(corpus_id, teacher_client, distillation_config)
        except TeacherUnreachable as exc:
            # Edge 5 — the build fails naming the endpoint, and every partial sample is
            # discarded by never being written.
            raise DatasetBuildError(str(exc)) from exc
        counts["distilled"] = len(distilled)
        samples.extend(distilled)

    # R20 — every named source yielding zero fails NAMING EACH SOURCE AND ITS COUNT, rather
    # than writing an empty dataset.
    if not samples:
        detail = ", ".join(f"{name}: {counts.get(_origin_for(name), 0)}" for name in named)
        raise DatasetBuildError(
            f"every named source yielded zero samples ({detail}); no dataset was written"
        )

    # Edge 6 — `max_samples` above what exists is not an error. The dataset is built from
    # everything available and `sample_count` reflects the smaller actual number.
    if max_samples > 0:
        samples = samples[:max_samples]

    dataset_id = str(uuid.uuid4())
    path = artifact_path(dataset_id)
    path.parent.mkdir(parents=True, exist_ok=True)

    # R18 — rendered with the target BaseModel's chat template BEFORE being written to
    # disk. The structured `messages` are written alongside the rendered `text` so a
    # trainer or the evaluation gate can work from either without re-deriving one from the
    # other.
    with path.open("w", encoding="utf-8") as handle:
        for sample in samples:
            messages = render.messages_for(sample)
            record = {
                "instruction": sample.get("instruction", ""),
                "response": sample.get("response", ""),
                "origin": sample["origin"],
                "messages": messages,
                "text": render.render(messages, chat_template),
            }
            handle.write(json.dumps(record) + "\n")

    breakdown = {
        # Every origin is reported, including the ones that produced nothing — R20's
        # `trajectory_count: 0` case is a recorded fact, not an absent key.
        "distilled": counts.get("distilled", 0),
        "supplied": counts.get("supplied", 0),
        "trajectory": counts.get("trajectory", 0),
        # The render target. `datasets` owns no column for it (build-plan Req 20a: every
        # migration lands in Phase 0 and no later phase adds one), and the evaluation gate
        # needs to know which model's template the file was rendered with.
        "base_model_id": base_model_id,
        "chat_template": chat_template,
        "corpus_name": _corpus_name(corpus_id),
        "requested_max_samples": max_samples,
    }

    row = db.query_one(
        """
        INSERT INTO datasets (dataset_id, corpus_id, sample_count, source_breakdown, artifact_path)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING dataset_id, corpus_id, sample_count, source_breakdown, artifact_path,
                  eval_split_path, eval_fraction, created_at
        """,
        (dataset_id, corpus_id, len(samples), json.dumps(breakdown), str(path)),
    )
    assert row is not None
    return row


def _origin_for(source_name: str) -> str:
    return {
        "corpus_id": "distilled",
        "supplied_file": "supplied",
        "include_trajectories": "trajectory",
    }[source_name]
