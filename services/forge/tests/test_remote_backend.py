"""P11 — RemoteTrainingBackend's credential handling. Training R25; edges 9, 10.

INVARIANT 8 IS THE POINT OF THIS FILE. `config/training-remote.yaml` names an environment
VARIABLE, never a value, and edge 9 is literal: an unset variable fails the submission
IMMEDIATELY AND WITHOUT TRANSMITTING THE DATASET. That ordering is what stops a
misconfiguration from leaking training data to a provider that would have rejected the
request anyway — so it is asserted by making the dataset unreadable, not by inspecting a
message.

An acceptance criterion also states that grepping the repository for the key VALUE returns
no matches. Nothing in this file writes a credential to disk, and nothing in the production
path reads one from a file.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from armada_forge.training.backend import TrainingConfig, TrainingConfigRejected
from armada_forge.training.remote_backend import RemoteSettings, RemoteTrainingBackend

SETTINGS = RemoteSettings.from_config({
    "provider": "example",
    "endpoint": "https://api.example.invalid/v1",
    "api_key_env": "ARMADA_TRAINING_API_KEY",
    "gpu_type": "a10g",
    "max_runtime_minutes": 120,
    "webhook_url": "",
    "defaults": {"lora_rank": 16},
})

CONFIG = TrainingConfig(
    base_model_id="qwen3-4b-instruct", dataset_id="d", lora_rank=16, lora_alpha=32,
    learning_rate=2e-4, max_steps=1000, batch_size=4, max_seq_len=2048,
)


def _backend(settings: RemoteSettings = SETTINGS, dataset_path: Path | None = None) -> RemoteTrainingBackend:
    def path_for(dataset_id: str) -> Path:
        if dataset_path is None:
            raise AssertionError("the dataset was read before the credential was checked")
        return dataset_path

    return RemoteTrainingBackend(settings, path_for)


# ── Edge 9 / invariant 8 ─────────────────────────────────────────────────────

def test_an_unset_variable_fails_before_the_dataset_is_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """Edge 9 — "fails immediately with an error naming the variable and NEVER TRANSMITS
    THE DATASET".

    The dataset resolver raises if it is called at all, so a submission that read the file
    first would fail this test with an AssertionError rather than passing with a tidy
    message.
    """
    monkeypatch.delenv("ARMADA_TRAINING_API_KEY", raising=False)

    with pytest.raises(TrainingConfigRejected) as caught:
        _backend(dataset_path=None).submit(CONFIG)

    assert "ARMADA_TRAINING_API_KEY" in str(caught.value)
    assert "nothing was transmitted" in str(caught.value)


def test_the_credential_is_read_from_the_environment_not_from_config() -> None:
    """Invariant 8 — the config carries a NAME. Nothing reads a secret from a file in this
    repository."""
    assert SETTINGS.api_key_env == "ARMADA_TRAINING_API_KEY"
    # The settings object carries no value-shaped field at all, so there is nowhere for a
    # credential to be persisted even by mistake.
    assert not any(
        field.endswith("api_key") for field in SETTINGS.__dataclass_fields__
    )


def test_a_config_with_no_api_key_env_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = RemoteSettings.from_config({"provider": "example", "endpoint": "https://x"})
    with pytest.raises(TrainingConfigRejected) as caught:
        _backend(settings, dataset_path=None).submit(CONFIG)
    assert "api_key_env" in str(caught.value)


# ── provider: none is the shipped default and is not usable ─────────────────

def test_provider_none_is_refused_naming_the_alternative() -> None:
    """A CPU-only installation runs LocalTrainingBackend and never configures this. The
    refusal points at `backend: local` so the operator's next step is obvious."""
    settings = RemoteSettings.from_config({"provider": "none"})
    with pytest.raises(TrainingConfigRejected) as caught:
        _backend(settings, dataset_path=None).submit(CONFIG)

    message = str(caught.value)
    assert "provider: none" in message
    assert "backend: local" in message


def test_a_missing_dataset_file_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARMADA_TRAINING_API_KEY", "not-a-real-key")
    with pytest.raises(TrainingConfigRejected) as caught:
        _backend(dataset_path=tmp_path / "absent.jsonl").submit(CONFIG)
    assert "missing" in str(caught.value)


# ── R23 / R27: state mapping and the polling fallback ───────────────────────

def test_provider_states_map_onto_the_five_job_states() -> None:
    backend = _backend(dataset_path=None)
    for provider_state, expected in [
        ("queued", "queued"), ("pending", "queued"), ("running", "running"),
        ("completed", "succeeded"), ("succeeded", "succeeded"),
        ("error", "failed"), ("failed", "failed"), ("canceled", "cancelled"),
    ]:
        assert backend.ingest_webhook("h", {"status": provider_state}).state == expected


def test_an_unrecognised_provider_state_is_treated_as_running() -> None:
    """Inventing a terminal state from an unknown string would end a run that is still
    going — and, for a paid provider, keep billing while forge stopped watching."""
    assert _backend(dataset_path=None).ingest_webhook("h", {"status": "throttled"}).state == "running"


def test_the_poll_interval_comes_from_the_provider() -> None:
    """R27 — polling is the FALLBACK, and its interval is provider-recommended. There is no
    invented number on this path."""
    backend = _backend(dataset_path=None)
    backend.ingest_webhook("h", {"status": "running", "poll_after_seconds": 42})
    assert backend.poll_interval_seconds("h") == 42


def test_a_zero_recommendation_cannot_produce_a_spin_loop() -> None:
    """The floor is a guard against a provider answering 0, not an invented interval."""
    backend = _backend(dataset_path=None)
    backend.ingest_webhook("h", {"status": "running", "poll_after_seconds": 0})
    assert backend.poll_interval_seconds("h") >= 5


def test_run_kind_is_always_quality() -> None:
    """R25 — a remote run produces an Adapter promotable on the same terms as a local
    quality one, so R33a requires a split for it regardless of the host's hardware."""
    assert _backend(dataset_path=None).run_kind == "quality"


# ── fetch_artifacts is a boundary too ───────────────────────────────────────

def test_a_provider_artifact_name_cannot_escape_the_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The provider names these files, and a name is untrusted input like any other."""
    monkeypatch.setenv("ARMADA_TRAINING_API_KEY", "not-a-real-key")
    backend = _backend(dataset_path=None)
    monkeypatch.setattr(
        backend, "_get", lambda path, key: {"files": {"../escaped.txt": "x"}}
    )

    with pytest.raises(ValueError) as caught:
        backend.fetch_artifacts("h", tmp_path / "dest")

    assert "escapes" in str(caught.value)
