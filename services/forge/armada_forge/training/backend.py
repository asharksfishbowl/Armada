"""The TrainingBackend interface — Training R21, R22, R23.

R21 specifies EXACTLY four methods, and this file defines exactly four. The interface is
what lets the training run orchestrator in `runs.py` be written once against "a backend"
rather than twice against a local path and a remote one — and it is what lets a GPU appear
on the host, or a provider be configured, without any change above this line.

`run_kind` is NOT on TrainingConfig. It is a property of the backend and the hardware, not
of the request (R24c), and putting it on the config would make it look settable by a
caller. The backend reports it, `runs.py` persists it, and R37 reads it forever after.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

# R23 — the five JobStatus states, matching the `training_status` enum in 001_init.sql.
VALID_STATES: frozenset[str] = frozenset(
    {"queued", "running", "succeeded", "failed", "cancelled"}
)


class TrainingConfigRejected(Exception):
    """A config a backend refuses BEFORE allocating memory (edges 7, 8, 26).

    Raised from `submit`, which is what makes "no training process starts" true rather than
    "a training process starts and then stops".
    """


@dataclass(frozen=True)
class TrainingConfig:
    """R22 — exactly the eight fields the spec names."""

    base_model_id: str
    dataset_id: str
    lora_rank: int
    lora_alpha: int
    learning_rate: float
    max_steps: int
    batch_size: int
    max_seq_len: int

    def with_caps(self, **overrides: Any) -> "TrainingConfig":
        return replace(self, **overrides)

    def as_dict(self) -> dict[str, Any]:
        return {
            "base_model_id": self.base_model_id,
            "dataset_id": self.dataset_id,
            "lora_rank": self.lora_rank,
            "lora_alpha": self.lora_alpha,
            "learning_rate": self.learning_rate,
            "max_steps": self.max_steps,
            "batch_size": self.batch_size,
            "max_seq_len": self.max_seq_len,
        }


@dataclass(frozen=True)
class JobStatus:
    """R23 — a backend job's state and progress."""

    state: str
    progress_steps: int = 0
    total_steps: int = 0
    message: str | None = None

    def __post_init__(self) -> None:
        if self.state not in VALID_STATES:
            raise ValueError(
                f"JobStatus.state `{self.state}` is not one of {', '.join(sorted(VALID_STATES))}"
            )

    @property
    def terminal(self) -> bool:
        return self.state in ("succeeded", "failed", "cancelled")


class TrainingBackend(ABC):
    """R21 — submit, poll, fetch_artifacts, cancel. Nothing else."""

    #: `smoke` or `quality`. Read by runs.py to persist R28's `run_kind` and by R33a to
    #: decide whether a held-out split is required.
    run_kind: str = "quality"

    @abstractmethod
    def submit(self, config: TrainingConfig) -> str:
        """Start a job and return a backend job handle."""

    @abstractmethod
    def poll(self, handle: str) -> JobStatus:
        """Current state of a submitted job."""

    @abstractmethod
    def fetch_artifacts(self, handle: str, dest: Path) -> None:
        """Place the produced adapter artifacts under `dest`."""

    @abstractmethod
    def cancel(self, handle: str) -> None:
        """Stop a running job."""
