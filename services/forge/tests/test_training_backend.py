"""P11 — LocalTrainingBackend's caps and refusals. Training R21-R24c; edges 7, 8, 26.

TWO OF P11'S THREE EXIT CRITERIA ARE HERE:

  * "a local run against a non-`smoke_test` model is rejected naming the constraint" —
    and the refusal must name BOTH the model and the absent GPU (edge 26), and must NOT
    fall back to the smoke model.
  * the corrected caps of upstream defect D6(d): all FOUR of `max_steps`, `max_samples`,
    `max_seq_len`, and `batch_size`, with both the requested and the clamped value
    recorded. Capping only the first two bounds nothing, because step cost is roughly
    linear in the product of the last two.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from armada_forge.registry.models import TrainingEntry, training_entries
from armada_forge.training import hardware
from armada_forge.training.backend import JobStatus, TrainingConfig, TrainingConfigRejected
from armada_forge.training.local_backend import (
    SMOKE_BATCH_SIZE,
    SMOKE_MAX_SAMPLES,
    SMOKE_MAX_SEQ_LEN,
    SMOKE_MAX_STEPS,
    LocalTrainingBackend,
    clamp_for_smoke,
)

RAW_ENTRIES = [
    {
        "id": "qwen3-0.6b", "hf_id": "Qwen/Qwen3-0.6B", "chat_template": "qwen3",
        "quantization": "Q4_K_M", "trainable": True, "smoke_test": True,
        "lora_target_modules": ["q_proj", "v_proj"],
    },
    {
        "id": "qwen3-4b-instruct", "hf_id": "Qwen/Qwen3-4B-Instruct-2507",
        "chat_template": "qwen3", "quantization": "Q4_K_M", "trainable": True,
        "smoke_test": False, "lora_target_modules": ["q_proj", "v_proj"],
    },
    {
        "id": "frozen-model", "hf_id": "Example/Frozen", "chat_template": "qwen3",
        "quantization": "Q4_K_M", "trainable": False, "smoke_test": False,
        "lora_target_modules": [],
    },
]

ENTRIES: dict[str, TrainingEntry] = training_entries(RAW_ENTRIES)


def _config(base_model_id: str = "qwen3-0.6b", **overrides: Any) -> TrainingConfig:
    fields: dict[str, Any] = {
        "base_model_id": base_model_id,
        "dataset_id": "d",
        "lora_rank": 16,
        "lora_alpha": 32,
        "learning_rate": 2e-4,
        "max_steps": 1000,
        "batch_size": 4,
        "max_seq_len": 2048,
    }
    fields.update(overrides)
    return TrainingConfig(**fields)


def _backend(mode: str, tmp_path: Path, trainer=None) -> LocalTrainingBackend:
    return LocalTrainingBackend(ENTRIES, tmp_path, mode=mode, trainer=trainer or (lambda h, j: None))


# ── R24 / R24c: mode selection ───────────────────────────────────────────────

def test_mode_comes_from_cuda_detection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """R24c — never operator-selectable. There is no config key and no request field."""
    monkeypatch.setattr(hardware, "cuda_available", lambda: False)
    assert LocalTrainingBackend(ENTRIES, tmp_path, trainer=lambda h, j: None).mode == "smoke"

    monkeypatch.setattr(hardware, "cuda_available", lambda: True)
    assert LocalTrainingBackend(ENTRIES, tmp_path, trainer=lambda h, j: None).mode == "quality"


def test_run_kind_matches_the_mode(tmp_path: Path) -> None:
    """R24a/R24b — the value persisted to `training_runs.run_kind`, which R37 reads
    forever after."""
    assert _backend("smoke", tmp_path).run_kind == "smoke"
    assert _backend("quality", tmp_path).run_kind == "quality"


def test_cuda_detection_survives_a_missing_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    """A CPU-only image is a supported configuration, not a broken one."""
    import builtins

    real_import = builtins.__import__

    def no_torch(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    assert hardware.cuda_available() is False
    assert hardware.detect_mode() == "smoke"


# ── EXIT CRITERION: the smoke-model refusal ──────────────────────────────────

def test_a_non_smoke_model_is_refused_naming_the_constraint_and_the_gpu(tmp_path: Path) -> None:
    """Edges 8 AND 26 in one message. P11 exit criterion 1."""
    backend = _backend("smoke", tmp_path)

    with pytest.raises(TrainingConfigRejected) as caught:
        backend.validate(_config("qwen3-4b-instruct"))

    message = str(caught.value)
    assert "qwen3-4b-instruct" in message, "the refusal must name the model"
    assert "smoke_test" in message, "the refusal must name the constraint"
    assert "CUDA" in message or "GPU" in message, "the refusal must name the absent GPU"


def test_the_refusal_does_not_fall_back_to_the_smoke_model(tmp_path: Path) -> None:
    """Edge 26 — never silently downgraded.

    A downgraded run would report a `base_model_id` it was never trained against, and the
    caller would believe they had trained the model they asked for.
    """
    backend = _backend("smoke", tmp_path)
    with pytest.raises(TrainingConfigRejected):
        backend.submit(_config("qwen3-4b-instruct"))

    assert backend._jobs == {}, "a refused config must start no job"


def test_quality_mode_accepts_any_trainable_model(tmp_path: Path) -> None:
    """R24b — adding a GPU is sufficient; no configuration change (edge 27)."""
    assert _backend("quality", tmp_path).validate(_config("qwen3-4b-instruct")).id == "qwen3-4b-instruct"


# ── Edge 7: trainable: false ─────────────────────────────────────────────────

@pytest.mark.parametrize("mode", ["smoke", "quality"])
def test_a_non_trainable_model_is_refused_in_both_modes(tmp_path: Path, mode: str) -> None:
    """Edge 7 — and build-plan Req 19.4 forces `trainable: false` for any non-ollama
    backend, so this one guard also covers every future inference backend."""
    with pytest.raises(TrainingConfigRejected) as caught:
        _backend(mode, tmp_path).validate(_config("frozen-model"))

    message = str(caught.value)
    assert "frozen-model" in message and "trainable" in message


def test_an_unknown_model_is_refused(tmp_path: Path) -> None:
    with pytest.raises(TrainingConfigRejected) as caught:
        _backend("smoke", tmp_path).validate(_config("not-in-the-shortlist"))
    assert "not-in-the-shortlist" in str(caught.value)


# ── R24a / D6(d): ALL FOUR CAPS ──────────────────────────────────────────────

def test_all_four_caps_are_applied() -> None:
    """D6(d) — capping only max_steps and max_samples bounds nothing, because step cost is
    roughly linear in `batch_size * max_seq_len`."""
    record = clamp_for_smoke(_config(max_steps=1000, batch_size=8, max_seq_len=4096), 5000)

    assert record["clamped"] == {
        "max_steps": SMOKE_MAX_STEPS,
        "max_samples": SMOKE_MAX_SAMPLES,
        "max_seq_len": SMOKE_MAX_SEQ_LEN,
        "batch_size": SMOKE_BATCH_SIZE,
    }


def test_the_acceptance_criterion_case_is_clamped() -> None:
    """"A smoke TrainingConfig requesting batch_size: 8 and max_seq_len: 4096 is clamped to
    1 and 1024, and both the requested and clamped values are recorded." Verbatim."""
    record = clamp_for_smoke(_config(batch_size=8, max_seq_len=4096), SMOKE_MAX_SAMPLES)

    assert record["requested"]["batch_size"] == 8
    assert record["requested"]["max_seq_len"] == 4096
    assert record["clamped"]["batch_size"] == 1
    assert record["clamped"]["max_seq_len"] == 1024
    assert set(record["caps_applied"]) >= {"batch_size", "max_seq_len"}


def test_a_request_already_under_every_cap_is_left_alone() -> None:
    """The caps are a ceiling, not a setting. An operator asking for 5 steps gets 5."""
    record = clamp_for_smoke(_config(max_steps=5, batch_size=1, max_seq_len=512), 50)

    assert record["clamped"] == record["requested"]
    assert record["caps_applied"] == []


def test_submit_applies_the_caps_to_the_job(tmp_path: Path) -> None:
    """The record is not enough on its own — the EFFECTIVE config must carry the clamp, or
    the run does the unclamped work while reporting that it did not."""
    backend = _backend("smoke", tmp_path)
    handle = backend.submit(_config(max_steps=1000, batch_size=8, max_seq_len=4096))

    job = backend._jobs[handle]
    assert job.config.max_steps == SMOKE_MAX_STEPS
    assert job.config.batch_size == SMOKE_BATCH_SIZE
    assert job.config.max_seq_len == SMOKE_MAX_SEQ_LEN


def test_quality_mode_applies_no_caps(tmp_path: Path) -> None:
    """R24b — the requested hyperparameters, without caps."""
    backend = _backend("quality", tmp_path)
    handle = backend.submit(_config("qwen3-4b-instruct", max_steps=1000, batch_size=8))

    assert backend._jobs[handle].config.max_steps == 1000
    assert backend._jobs[handle].config.batch_size == 8


# ── R23: the JobStatus contract ──────────────────────────────────────────────

def test_job_status_rejects_a_state_outside_the_enum() -> None:
    """The five states match the `training_status` enum in 001_init.sql. A sixth would be
    written to a column that cannot hold it, which is a runtime error much later."""
    with pytest.raises(ValueError):
        JobStatus(state="finished")


def test_terminal_states() -> None:
    assert JobStatus(state="succeeded").terminal
    assert JobStatus(state="failed").terminal
    assert JobStatus(state="cancelled").terminal
    assert not JobStatus(state="running").terminal
    assert not JobStatus(state="queued").terminal


# ── R21: the interface is exactly four methods ───────────────────────────────

def test_the_backend_interface_has_exactly_the_four_specified_methods() -> None:
    """R21 names four. A fifth added quietly would be a second way to do something the
    orchestrator already does through one of these, and only one implementation would
    have it."""
    from armada_forge.training.backend import TrainingBackend

    assert TrainingBackend.__abstractmethods__ == frozenset(
        {"submit", "poll", "fetch_artifacts", "cancel"}
    )


def test_training_config_carries_exactly_the_eight_specified_fields() -> None:
    """R22."""
    assert set(_config().as_dict()) == {
        "base_model_id", "dataset_id", "lora_rank", "lora_alpha",
        "learning_rate", "max_steps", "batch_size", "max_seq_len",
    }


# ── Progress is event-driven (R27) ───────────────────────────────────────────

def _await_terminal(backend: LocalTrainingBackend, handle: str, timeout: float = 10.0) -> JobStatus:
    """Join the worker thread by observing its state.

    A bounded deadline rather than an unbounded wait so a hung trainer fails the suite
    instead of hanging it. This is a test joining a thread, not production code waiting on
    an interval — the production path is the event-driven listener below.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = backend.poll(handle)
        if status.terminal:
            return status
        time.sleep(0.005)
    raise AssertionError(f"job {handle} did not reach a terminal state within {timeout}s")


def test_progress_reaches_a_listener_without_polling(tmp_path: Path) -> None:
    """R27 — the trainer pushes; nothing asks. The listener is the only progress source."""
    release = threading.Event()
    seen: list[JobStatus] = []

    def trainer(handle: str, job: Any) -> None:
        # Held until the listener is registered, so this asserts delivery rather than
        # racing the worker thread.
        release.wait(5)
        job.progress_steps = 7

    backend = _backend("smoke", tmp_path, trainer=trainer)
    handle = backend.submit(_config())
    backend.on_progress(handle, seen.append)
    release.set()

    assert _await_terminal(backend, handle).state == "succeeded"
    assert any(status.terminal for status in seen), (
        "the listener never received the terminal status, so runs.py would wait forever"
    )


def test_a_trainer_exception_becomes_a_failed_job(tmp_path: Path) -> None:
    def exploding(handle: str, job: Any) -> None:
        raise RuntimeError("out of memory")

    backend = _backend("smoke", tmp_path, trainer=exploding)
    handle = backend.submit(_config())

    status = _await_terminal(backend, handle)
    assert status.state == "failed"
    assert "out of memory" in (status.message or "")


def test_polling_an_unknown_handle_reports_why_rather_than_raising(tmp_path: Path) -> None:
    """Edge 11's shape for a local run: the training lived in the previous process's
    memory, so a handle this process does not know cannot be re-attached."""
    status = _backend("smoke", tmp_path).poll("no-such-handle")
    assert status.state == "failed"
    assert "cannot survive a restart" in (status.message or "")


def test_two_backends_do_not_share_listeners(tmp_path: Path) -> None:
    """A class-level mutable default would leak one backend's listeners into another's."""
    first = _backend("smoke", tmp_path)
    second = _backend("smoke", tmp_path)
    first.on_progress("h", lambda status: None)
    assert second._listeners == {}
