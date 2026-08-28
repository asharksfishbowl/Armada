"""Dataset routes — Training R15, R15a, R16b, R19, R33; build-plan Req 22.

`GET /datasets` lands in THIS phase rather than in P9, and build-plan Req 21 is why: an
endpoint ships with its consumer, and both the producer (`POST /datasets`) and the consumer
(the build-dataset modal on `TrainingPage`) are P11. An endpoint verified only against an
empty table is a shape test, not a working feature.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from armada_forge import db
from armada_forge.datasets import builder, split, supplied
from armada_forge.registry.models import TrainingEntry
from armada_forge.teacher import TeacherClient

router = APIRouter()

# Set by main.py at startup, exactly as corpora.configure does. Nothing reads these before
# startup completes, because a startup failure exits the process.
_entries: dict[str, TrainingEntry] = {}
_teacher_client: TeacherClient | None = None
_distillation_config: dict[str, Any] = {}
_default_eval_fraction: float = 0.1
_smoke_model_id: str = ""

# R15a caps the upload at a size a single-operator dashboard would ever send. Enforced
# because the body is read into memory before it is validated: an unbounded read on a
# trusted network is still an unbounded read.
MAX_SUPPLIED_BYTES = 64 * 1024 * 1024


def configure(
    entries: dict[str, TrainingEntry],
    teacher_client: TeacherClient,
    distillation_config: dict[str, Any],
    default_eval_fraction: float,
    smoke_model_id: str,
) -> None:
    global _teacher_client, _default_eval_fraction, _smoke_model_id
    _teacher_client = teacher_client
    _default_eval_fraction = default_eval_fraction
    _smoke_model_id = smoke_model_id
    _entries.clear()
    _entries.update(entries)
    _distillation_config.clear()
    _distillation_config.update(distillation_config)


class DatasetCreate(BaseModel):
    """R15 — the request fields, plus the render target R18 needs."""

    corpus_id: str | None = None
    include_trajectories: bool = False
    agent_ids: list[str] = Field(default_factory=list)
    supplied_file: str | None = None
    max_samples: int = Field(default=0, ge=0)
    # R18 renders every sample with the TARGET BaseModel's chat template before writing it
    # to disk, and R15 names no field to choose that target. Defaulted to the `smoke_test`
    # entry because that is the only model a zero-cost installation can train — an operator
    # training something else names it, and the dataset records which template it used.
    base_model_id: str | None = None


class SplitRequest(BaseModel):
    eval_fraction: float | None = Field(default=None, gt=0, lt=1)


@router.post("/datasets", status_code=201)
def create_dataset(payload: DatasetCreate) -> dict[str, Any]:
    """R15 — build a dataset from at least one of the three sources."""
    assert _teacher_client is not None

    base_model_id = payload.base_model_id or _smoke_model_id
    entry = _entries.get(base_model_id)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"`{base_model_id}` is not in config/base-models.yaml",
        )

    if payload.corpus_id and not db.query_one(
        "SELECT corpus_id FROM corpora WHERE corpus_id = %s", (payload.corpus_id,)
    ):
        raise HTTPException(status_code=404, detail=f"no Corpus with corpus_id {payload.corpus_id}")

    try:
        row = builder.build(
            corpus_id=payload.corpus_id,
            include_trajectories=payload.include_trajectories,
            agent_ids=payload.agent_ids or None,
            supplied_file=payload.supplied_file,
            max_samples=payload.max_samples,
            base_model_id=base_model_id,
            chat_template=entry.chat_template,
            teacher_client=_teacher_client,
            distillation_config=_distillation_config,
        )
    except builder.DatasetBuildError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return row


@router.post("/datasets/supplied", status_code=201)
async def upload_supplied(request: Request) -> dict[str, Any]:
    """R15a — a JSONL upload, validated in full before anything is stored.

    The name arrives as the `name` query parameter and the body is the raw JSONL. A raw
    body rather than multipart because the only client is the dashboard and `curl --data-
    binary` is the operator's fallback; multipart would add a dependency (`python-multipart`)
    for no gain.
    """
    name = request.query_params.get("name", "")
    if not name:
        raise HTTPException(status_code=400, detail="the `name` query parameter is required")

    body = await request.body()
    if len(body) > MAX_SUPPLIED_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"the upload is {len(body)} bytes, above the {MAX_SUPPLIED_BYTES} byte limit",
        )

    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"the upload is not valid UTF-8: {exc}") from exc

    try:
        return supplied.store(name, text)
    except supplied.SuppliedValidationError as exc:
        # Edge 24 — the WHOLE upload is rejected, listing every offending line number, and
        # /data/supplied/ is unchanged. `problems` is a list so the dashboard can render one
        # row per line rather than parsing a sentence.
        raise HTTPException(status_code=400, detail={"rejected": True, "problems": exc.problems}) from exc


@router.get("/datasets/supplied")
def list_supplied() -> list[dict[str, Any]]:
    return supplied.listing()


@router.get("/datasets")
def list_datasets(limit: int = 100) -> list[dict[str, Any]]:
    """Build-plan Req 22."""
    return db.query(
        """
        SELECT dataset_id, corpus_id, sample_count, source_breakdown, artifact_path,
               eval_split_path, eval_fraction, created_at
          FROM datasets
         ORDER BY created_at DESC
         LIMIT %s
        """,
        (max(1, min(limit, 500)),),
    )


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM datasets WHERE dataset_id = %s", (dataset_id,))
    if row is None:
        raise HTTPException(status_code=404, detail=f"no dataset with dataset_id {dataset_id}")
    row["training_runs"] = db.query(
        "SELECT training_run_id, backend, run_kind, status FROM training_runs "
        "WHERE dataset_id = %s ORDER BY started_at DESC",
        (dataset_id,),
    )
    return row


@router.post("/datasets/{dataset_id}/split", status_code=200)
def split_dataset(dataset_id: str, payload: SplitRequest | None = None) -> dict[str, Any]:
    """R33 — reserve the held-out fraction BEFORE any training run consumes the dataset."""
    fraction = (payload.eval_fraction if payload else None) or _default_eval_fraction
    try:
        return split.split_dataset(dataset_id, fraction)
    except split.SplitError as exc:
        message = str(exc)
        # A dataset already consumed by a run is a conflict with existing state, not a bad
        # request — the operator's next action is to build a new dataset, not to fix this
        # call's arguments.
        status = 409 if "already been consumed" in message else 400
        if message.startswith("no dataset"):
            status = 404
        raise HTTPException(status_code=status, detail=message) from exc
