"""P11 — POST /training/runs. Training R26, R28, R33a; edges 7, 11, 12.

R33a IS THE ONE THAT LOOKS INCONSISTENT UNTIL YOU SEE WHY. Two acceptance criteria give
opposite outcomes for the same split-less dataset, and D6(e) settled it: R33a is the
correct reading. A run that COULD produce a promotable Adapter is refused without a split;
a smoke run against the SAME dataset is accepted, because the split exists solely to gate
promotion and a smoke run is never promotable.

That is also what lets a trajectory-only dataset — which by R33 can never be split at all
(edge 21) — still prove the pipeline end to end at zero cost.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from armada_forge.registry.models import training_entries
from armada_forge.training import hardware, runs
from armada_forge.training.backend import JobStatus
from armada_forge.training.local_backend import LocalTrainingBackend
from armada_forge.training.remote_backend import RemoteSettings

RAW_ENTRIES = [
    {"id": "qwen3-0.6b", "hf_id": "Qwen/Qwen3-0.6B", "chat_template": "qwen3",
     "quantization": "Q4_K_M", "trainable": True, "smoke_test": True,
     "lora_target_modules": ["q_proj"]},
    {"id": "qwen3-4b-instruct", "hf_id": "Qwen/Qwen3-4B", "chat_template": "qwen3",
     "quantization": "Q4_K_M", "trainable": True, "smoke_test": False,
     "lora_target_modules": ["q_proj"]},
    {"id": "frozen-model", "hf_id": "Example/Frozen", "chat_template": "qwen3",
     "quantization": "Q4_K_M", "trainable": False, "smoke_test": False,
     "lora_target_modules": []},
]

DATASET_ID = "dddddddd-0000-0000-0000-000000000001"


class FakeDB:
    def __init__(self, eval_split_path: str | None) -> None:
        self.eval_split_path = eval_split_path
        self.inserted: list[dict[str, Any]] = []
        self.updates: list[str] = []

    def query_one(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        flat = " ".join(sql.split())
        if "FROM datasets WHERE dataset_id" in flat:
            return {
                "dataset_id": DATASET_ID,
                "artifact_path": "/data/datasets/x.jsonl",
                "eval_split_path": self.eval_split_path,
            }
        if flat.startswith("INSERT INTO training_runs"):
            backend, run_kind, base_model_id, dataset_id, config, total_steps = params
            self.inserted.append({
                "backend": backend, "run_kind": run_kind, "base_model_id": base_model_id,
                "dataset_id": dataset_id, "config": json.loads(config),
                "total_steps": total_steps,
            })
            return {"training_run_id": "rrrrrrrr-0000-0000-0000-000000000001"}
        return None

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        return []

    def execute(self, sql: str, params: Any = None) -> int:
        self.updates.append(" ".join(sql.split()))
        return 0

    def scalar(self, sql: str, params: Any = None) -> Any:
        return 0


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Configure the module the way the lifespan hook does, minus the event loop."""
    def setup(eval_split_path: str | None = None, mode: str = "smoke") -> FakeDB:
        db = FakeDB(eval_split_path)
        monkeypatch.setattr(runs, "db", db)
        monkeypatch.setattr(runs, "_loop", None)
        monkeypatch.setattr(runs, "_adapters_root", tmp_path)
        monkeypatch.setattr(runs, "_gate_factory", None)
        monkeypatch.setattr(
            runs, "_remote_settings",
            RemoteSettings.from_config({"provider": "example", "endpoint": "https://x",
                                        "api_key_env": "K", "max_runtime_minutes": 10}),
        )
        runs._entries.clear()
        runs._entries.update(training_entries(RAW_ENTRIES))
        monkeypatch.setattr(hardware, "cuda_available", lambda: mode == "quality")
        # The worker thread is replaced: this file tests admission, not execution.
        monkeypatch.setattr(runs, "_run_training", lambda *args, **kwargs: None)
        return db

    return setup


def _payload(**overrides: Any) -> runs.TrainingRunCreate:
    fields: dict[str, Any] = {
        "backend": "local",
        "base_model_id": "qwen3-0.6b",
        "dataset_id": DATASET_ID,
    }
    fields.update(overrides)
    return runs.TrainingRunCreate(**fields)


# ── R33a: the split requirement and its deliberate exception ─────────────────

def test_a_smoke_run_is_accepted_without_a_split(wired) -> None:
    """The acceptance criterion: "a smoke run against the same split-less dataset is
    accepted, per Requirement 33a"."""
    db = wired(eval_split_path=None, mode="smoke")

    result = runs.start_training_run(_payload())

    assert result["run_kind"] == "smoke"
    assert result["promotable"] is False
    assert len(db.inserted) == 1


def test_a_promotable_run_without_a_split_is_refused_naming_it(wired) -> None:
    """The other half of the same criterion, "when the run could produce a promotable
    Adapter"."""
    db = wired(eval_split_path=None, mode="quality")

    with pytest.raises(HTTPException) as caught:
        runs.start_training_run(_payload(base_model_id="qwen3-4b-instruct"))

    assert caught.value.status_code == 400
    assert "split" in caught.value.detail
    assert db.inserted == [], "a refused run must write no training_runs row"


def test_a_promotable_run_with_a_split_is_accepted(wired) -> None:
    db = wired(eval_split_path="/data/datasets/x.eval.jsonl", mode="quality")

    result = runs.start_training_run(_payload(base_model_id="qwen3-4b-instruct"))

    assert result["run_kind"] == "quality"
    assert result["promotable"] is True
    assert len(db.inserted) == 1


def test_a_remote_run_is_promotable_and_needs_a_split(wired) -> None:
    """R25 records `run_kind: quality` regardless of the host's hardware."""
    wired(eval_split_path=None, mode="smoke")

    with pytest.raises(HTTPException) as caught:
        runs.start_training_run(_payload(backend="remote", base_model_id="qwen3-4b-instruct"))

    assert "split" in caught.value.detail


@pytest.mark.parametrize(
    "backend,run_kind,expected",
    [("local", "smoke", False), ("local", "quality", True), ("remote", "quality", True)],
)
def test_promotable_predicate(backend: str, run_kind: str, expected: bool) -> None:
    """ONE predicate, because three places must agree: the split requirement, R33b's
    short-circuit in the gate, and R37's refusal on the manual promote route."""
    assert runs.promotable(backend, run_kind) is expected


# ── EXIT CRITERION: the non-smoke local refusal reaches the API as a 400 ────

def test_a_local_run_against_a_non_smoke_model_is_a_400_naming_the_constraint(wired) -> None:
    """P11 exit criterion 1, at the HTTP boundary.

    Called explicitly rather than relying on `submit` raising, because the refusal has to
    become a 400 BEFORE a training_runs row is written — a rejected run that left a row
    behind would show in the dashboard as a training run that never ran.
    """
    db = wired(eval_split_path="/data/datasets/x.eval.jsonl", mode="smoke")

    with pytest.raises(HTTPException) as caught:
        runs.start_training_run(_payload(base_model_id="qwen3-4b-instruct"))

    assert caught.value.status_code == 400
    assert "smoke_test" in caught.value.detail
    assert db.inserted == [], "no training process starts, and no row is written"


def test_edge_7_a_non_trainable_model_is_refused_on_both_backends(wired) -> None:
    for backend in ("local", "remote"):
        db = wired(eval_split_path="/data/datasets/x.eval.jsonl", mode="quality")
        with pytest.raises(HTTPException) as caught:
            runs.start_training_run(_payload(backend=backend, base_model_id="frozen-model"))
        assert "trainable" in caught.value.detail
        assert db.inserted == []


def test_an_unknown_backend_is_refused(wired) -> None:
    wired()
    with pytest.raises(HTTPException) as caught:
        runs.start_training_run(_payload(backend="modal"))
    assert caught.value.status_code == 400


def test_a_missing_dataset_is_a_404(wired, monkeypatch: pytest.MonkeyPatch) -> None:
    wired()

    class NoDataset(FakeDB):
        def query_one(self, sql: str, params: Any = None):
            if "FROM datasets" in sql:
                return None
            return super().query_one(sql, params)

    monkeypatch.setattr(runs, "db", NoDataset(None))
    with pytest.raises(HTTPException) as caught:
        runs.start_training_run(_payload())
    assert caught.value.status_code == 404


# ── R24a / R28: what is persisted ───────────────────────────────────────────

def test_the_smoke_caps_are_recorded_on_the_run(wired) -> None:
    """R24a — "records BOTH the requested and the clamped value for each" on the run.

    A run that silently used different hyperparameters than were asked for is
    indistinguishable from one whose hyperparameters did nothing.
    """
    db = wired(mode="smoke")

    runs.start_training_run(_payload(batch_size=8, max_seq_len=4096, max_steps=1000))

    caps = db.inserted[0]["config"]["smoke_caps"]
    assert caps["requested"]["batch_size"] == 8
    assert caps["clamped"]["batch_size"] == 1
    assert caps["requested"]["max_seq_len"] == 4096
    assert caps["clamped"]["max_seq_len"] == 1024
    assert caps["clamped"]["max_steps"] == 20


def test_a_quality_run_records_no_smoke_caps(wired) -> None:
    db = wired(eval_split_path="/data/datasets/x.eval.jsonl", mode="quality")
    runs.start_training_run(_payload(base_model_id="qwen3-4b-instruct"))
    assert "smoke_caps" not in db.inserted[0]["config"]


def test_run_kind_is_persisted_from_the_backend_not_the_request(wired) -> None:
    """R24c — `run_kind` is never operator-selectable. There is no request field for it, and
    R37 reads it forever after."""
    db = wired(mode="smoke")
    runs.start_training_run(_payload())
    assert db.inserted[0]["run_kind"] == "smoke"
    assert "run_kind" not in runs.TrainingRunCreate.model_fields


# ── Edge 11: a restart with runs still running ──────────────────────────────

def test_a_local_run_is_failed_on_restart_naming_why(monkeypatch: pytest.MonkeyPatch) -> None:
    """Edge 11 — a local run cannot be re-attached; leaving it `running` forever is the one
    thing the training view cannot render truthfully."""
    statements: list[str] = []

    class ReconcileDB:
        def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
            flat = " ".join(sql.split())
            statements.append(flat)
            if "SET status = 'failed'" in flat:
                return [{"training_run_id": "rrrr"}]
            return []

        def execute(self, sql: str, params: Any = None) -> int:
            return 0

    monkeypatch.setattr(runs, "db", ReconcileDB())
    result = runs.reconcile_on_startup()

    assert result["local_failed"] == ["rrrr"]
    assert any("local run interrupted by restart" in s for s in statements)
    assert any("backend = 'local'" in s for s in statements)


def test_a_remote_run_is_not_failed_on_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """Edge 11 — a remote run IS re-attachable from its persisted backend_handle, so
    failing it would discard a job the operator is still paying for."""
    started: list[str] = []

    class ReconcileDB:
        def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
            flat = " ".join(sql.split())
            if "SET status = 'failed'" in flat:
                return []
            if "backend = 'remote'" in flat:
                return [{
                    "training_run_id": "remote-1", "backend_handle": "provider-job-9",
                    "base_model_id": "qwen3-4b-instruct", "dataset_id": DATASET_ID,
                    "config": {"effective": {}},
                }]
            return []

        def execute(self, sql: str, params: Any = None) -> int:
            return 0

    monkeypatch.setattr(runs, "db", ReconcileDB())
    monkeypatch.setattr(
        runs, "_track_reattached_remote",
        lambda run_id, handle: started.append(run_id),
    )

    result = runs.reconcile_on_startup()

    assert result["remote_reattached"] == ["remote-1"]

    # RE-ATTACHED, NOT MERELY LISTED. Returning ids without resuming tracking would leave
    # the run `running` forever. Waited on with a deadline so a broken spawn fails the
    # suite instead of hanging it.
    deadline = time.monotonic() + 5
    while not started and time.monotonic() < deadline:
        time.sleep(0.005)
    assert started == ["remote-1"]


# ── Edge 12: concurrent runs on the same (base_model_id, corpus_name) ───────

def test_the_version_increment_takes_an_advisory_lock_on_the_pair(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Edge 12 — two runs on the same pair must get DISTINCT versions, or they would share
    one ModelBinding tag. The lock is keyed on the PAIR so two runs on the same base model
    with different corpora do not contend, and each sequence starts at 1 independently.
    """
    executed: list[tuple[str, Any]] = []

    class Cursor:
        def execute(self, sql: str, params: Any = None) -> None:
            executed.append((" ".join(sql.split()), params))

        def fetchone(self) -> dict[str, Any]:
            return {"next": 4}

        def __enter__(self): return self
        def __exit__(self, *exc): return False

    class Conn:
        def cursor(self) -> Cursor: return Cursor()
        def __enter__(self): return self
        def __exit__(self, *exc): return False

    class LockDB:
        def connection(self) -> Conn: return Conn()

    monkeypatch.setattr(runs, "db", LockDB())

    assert runs._next_version("qwen3-0.6b", "recipes") == 4

    lock_sql, lock_params = executed[0]
    assert "pg_advisory_xact_lock" in lock_sql
    assert lock_params == ("qwen3-0.6b:recipes",), "the lock must key on the PAIR"
    assert "MAX(version)" in executed[1][0]


# ── The orchestrator, end to end with a fake backend ────────────────────────

def test_a_successful_run_creates_an_adapter_and_runs_the_gate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The driver nothing else exercises: submit -> event-driven wait -> fetch artifacts ->
    adapters row -> gate.

    The gate is called UNCONDITIONALLY rather than guarded by a second run_kind check here.
    R33b short-circuits a smoke Adapter inside the gate, and `promotable()` is what keeps
    the three readings of "is this a smoke run" in agreement — a fourth reading in this
    function is how they would drift.
    """
    gated: list[str] = []
    inserted: list[tuple[Any, ...]] = []

    class OrchestratorDB:
        def query_one(self, sql: str, params: Any = None):
            if "FROM training_runs tr" in sql:
                return {"base_model_id": "qwen3-0.6b", "dataset_id": DATASET_ID,
                        "source_breakdown": {"corpus_name": "recipes"}}
            return None

        def query(self, sql: str, params: Any = None): return []

        def execute(self, sql: str, params: Any = None) -> int:
            if "INSERT INTO adapters" in sql:
                inserted.append(params)
            return 1

    # A REAL LocalTrainingBackend with the trainer injected, so this exercises the actual
    # event-driven handshake between runs.py and the backend rather than a stand-in that
    # could satisfy an interface the production path does not use.
    def trainer(handle: str, job: Any) -> None:
        job.output_dir.mkdir(parents=True, exist_ok=True)
        (job.output_dir / "adapter_model.safetensors").write_text("weights")

    backend = LocalTrainingBackend(
        training_entries(RAW_ENTRIES), tmp_path / "work", mode="smoke", trainer=trainer
    )

    monkeypatch.setattr(runs, "db", OrchestratorDB())
    monkeypatch.setattr(runs, "_loop", None)
    monkeypatch.setattr(runs, "_adapters_root", tmp_path)
    monkeypatch.setattr(runs, "_next_version", lambda base, corpus: 1)
    monkeypatch.setattr(
        runs, "_gate_factory",
        lambda: type("G", (), {"run": lambda self, adapter_id: gated.append(adapter_id)})(),
    )

    config = runs.TrainingConfig(
        base_model_id="qwen3-0.6b", dataset_id=DATASET_ID, lora_rank=16, lora_alpha=32,
        learning_rate=2e-4, max_steps=20, batch_size=1, max_seq_len=1024,
    )
    runs._run_training("run-1", backend, config)  # noqa: SLF001 - the driver under test

    assert len(inserted) == 1
    adapter_id, training_run_id, base_model_id, corpus_name, version, path = inserted[0]
    assert training_run_id == "run-1"
    assert corpus_name == "recipes", "R29 — corpus_name comes from the dataset's breakdown"
    assert version == 1
    assert gated == [adapter_id], "the gate must run for every Adapter, smoke included"


def test_a_failed_run_creates_no_adapter(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    inserted: list[Any] = []

    class OrchestratorDB:
        def query_one(self, sql: str, params: Any = None): return None
        def query(self, sql: str, params: Any = None): return []
        def execute(self, sql: str, params: Any = None) -> int:
            if "INSERT INTO adapters" in sql:
                inserted.append(params)
            return 1

    def exploding(handle: str, job: Any) -> None:
        raise RuntimeError("out of memory")

    backend = LocalTrainingBackend(
        training_entries(RAW_ENTRIES), tmp_path / "work", mode="smoke", trainer=exploding
    )

    monkeypatch.setattr(runs, "db", OrchestratorDB())
    monkeypatch.setattr(runs, "_loop", None)
    monkeypatch.setattr(runs, "_adapters_root", tmp_path)
    monkeypatch.setattr(
        runs, "_gate_factory",
        lambda: type("G", (), {"run": lambda self, adapter_id: None})(),
    )

    config = runs.TrainingConfig(
        base_model_id="qwen3-0.6b", dataset_id=DATASET_ID, lora_rank=16, lora_alpha=32,
        learning_rate=2e-4, max_steps=20, batch_size=1, max_seq_len=1024,
    )
    runs._run_training("run-1", backend, config)

    assert inserted == [], "a failed run must produce no Adapter to evaluate"


# ── Build-plan Req 26: the progress envelope ────────────────────────────────

def test_the_progress_frame_matches_the_specified_envelope() -> None:
    """Req 26 defines the envelope for the whole channel, because no feature spec owns it:
    `job_kind`, `job_id`, `status`, `progress`, `total`, `message`. A consumer keys on
    `job_kind` and `job_id`."""
    frame = runs._frame("run-1", JobStatus(state="running", progress_steps=3, total_steps=20))

    assert frame["job_kind"] == "training"
    assert frame["job_id"] == "run-1"
    assert frame["status"] == "running"
    assert frame["progress"] == 3
    assert frame["total"] == 20
    assert "message" in frame
