"""BaseModel shortlist access and ModelBinding records — Training R1-R3, R32.

Shortlist VALIDATION already happens at startup in armada_forge/config.py (it must, so a
malformed entry exits non-zero naming its `id` before anything else runs). This module is
the read side: turning validated entries into the binding rows the daemon consumes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from armada_forge import db

# R4a — every base binding is tagged this way, and `corpus_name` is the literal 'base'
# because no Corpus is behind it.
BASE_CORPUS_NAME = "base"


def base_tag(base_model_id: str) -> str:
    """R4a — the tag under which a BaseModel is addressable with `adapter: none`."""
    return f"armada/{base_model_id}-base"


@dataclass(frozen=True)
class ShortlistEntry:
    """One validated `config/base-models.yaml` entry, in the shape this module needs."""

    id: str
    backend: str
    serving_ref: str
    context_window: int
    tool_format: str
    min_ram_gb: int
    min_disk_gb: int
    smoke_test: bool

    @classmethod
    def from_config(cls, raw: dict[str, Any]) -> "ShortlistEntry":
        return cls(
            id=raw["id"],
            # R1 — `backend` carries a default, so absence means `ollama`.
            backend=raw.get("backend", "ollama"),
            serving_ref=raw["serving_ref"],
            context_window=int(raw["context_window"]),
            tool_format=raw["tool_format"],
            min_ram_gb=int(raw["min_ram_gb"]),
            # min_disk_gb arrived with the D1 correction; tolerate its absence rather than
            # crash a startup on an operator's older appended entry, and treat unknown as
            # zero so the capacity check simply does not gate on it.
            min_disk_gb=int(raw.get("min_disk_gb", 0)),
            smoke_test=bool(raw.get("smoke_test", False)),
        )


def shortlist(entries: list[dict[str, Any]]) -> list[ShortlistEntry]:
    return [ShortlistEntry.from_config(entry) for entry in entries]


def smoke_entry(entries: list[ShortlistEntry]) -> ShortlistEntry | None:
    """R4g — the one baked into the armada-models image, materialized from first boot."""
    return next((entry for entry in entries if entry.smoke_test), None)


def list_bindings() -> list[dict[str, Any]]:
    """R32 — what the daemon reads at Agent save time and at Run start.

    Returns `materialized` and `materialization_status` alongside `status`, so no consumer
    has to guess whether a Run against a binding starts immediately or blocks behind a
    download (R4d). `backend` is a LOGICAL name — config/models.yaml maps it to a base URL,
    so no deployment-specific value is ever persisted or served from here (R1b).
    """
    return db.query(
        """
        SELECT tag, backend, base_model_id, corpus_name, adapter_id, version,
               context_window, tool_format, materialized, materialization_status,
               materialization_error, status
          FROM model_bindings
         ORDER BY base_model_id, version NULLS FIRST
        """
    )


def get_binding(tag: str) -> dict[str, Any] | None:
    return db.query_one("SELECT * FROM model_bindings WHERE tag = %s", (tag,))
