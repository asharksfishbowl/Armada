"""P2 backfill — base ModelBinding registration and startup reconciliation.

Training R4a, R4b, R4g, R4h.

R4h is the one that most needs pinning. A binding recorded `materialized: true` whose
weights the model server no longer has must be corrected back down, or P7's fail-fast
pre-flight trusts a stale `true` and admits a Run against a model that cannot answer —
turning a clean pre-flight failure into a mid-Run one, which is strictly harder to
diagnose.
"""

from __future__ import annotations

from typing import Any

import pytest

from armada_forge.registry import base_bindings, models


class FakeDB:
    """In-memory `model_bindings`, modelling only what these functions touch."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> int:
        flat = " ".join(sql.split())

        if flat.startswith("INSERT INTO model_bindings"):
            tag, backend, model_id, corpus, window, tool_format = params
            if tag in self.rows:
                # ON CONFLICT DO UPDATE — note it must NOT touch materialization state.
                self.rows[tag].update({
                    "backend": backend, "context_window": window,
                    "tool_format": tool_format, "status": "promoted",
                })
            else:
                self.rows[tag] = {
                    "tag": tag, "backend": backend, "base_model_id": model_id,
                    "corpus_name": corpus, "adapter_id": None, "version": None,
                    "context_window": window, "tool_format": tool_format,
                    "status": "promoted", "materialized": False,
                    "materialization_status": "absent", "materialization_error": None,
                }
            return 1

        if "SET materialized" in flat:
            present, status, error, tag = params
            self.rows[tag].update({
                "materialized": present, "materialization_status": status,
                "materialization_error": error,
            })
            return 1

        return 0

    def query(self, sql: str, params: tuple[Any, ...] | None = None) -> list[dict[str, Any]]:
        flat = " ".join(sql.split())

        if "SET status = 'retired'" in flat:
            keep = set(params[0])
            retired = []
            for tag, row in self.rows.items():
                if row["adapter_id"] is None and row["status"] != "retired" and tag not in keep:
                    row["status"] = "retired"
                    retired.append({"tag": tag})
            return retired

        if "SELECT mb.tag" in flat:
            return [
                {"tag": r["tag"], "base_model_id": r["base_model_id"], "materialized": r["materialized"]}
                for r in self.rows.values()
                if r["adapter_id"] is None and r["status"] == "promoted"
            ]

        return []


ENTRIES = [
    {"id": "qwen3-0.6b", "backend": "ollama", "serving_ref": "qwen3:0.6b",
     "context_window": 32768, "tool_format": "hermes", "min_ram_gb": 2,
     "min_disk_gb": 2, "smoke_test": True},
    {"id": "gemma-3-4b-it", "backend": "ollama", "serving_ref": "gemma3:4b",
     "context_window": 131072, "tool_format": "json_schema", "min_ram_gb": 6,
     "min_disk_gb": 6, "smoke_test": False},
]


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> tuple[FakeDB, list[models.ShortlistEntry]]:
    db = FakeDB()
    monkeypatch.setattr(base_bindings, "db", db)
    entries = models.shortlist(ENTRIES)
    base_bindings.set_serving_refs(entries)
    return db, entries


SMOKE = "armada/qwen3-0.6b-base"
OTHER = "armada/gemma-3-4b-it-base"


# ── R4a: registration writes records and transfers nothing ───────────────────

def test_registration_writes_one_record_per_entry(registry) -> None:
    db, entries = registry
    result = base_bindings.register_base_bindings(entries)

    assert sorted(result["registered"]) == sorted([SMOKE, OTHER])
    assert db.rows[SMOKE]["adapter_id"] is None
    assert db.rows[SMOKE]["version"] is None
    assert db.rows[SMOKE]["status"] == "promoted"


def test_registration_leaves_everything_unmaterialized(registry) -> None:
    """R4c — this is what makes a first `docker compose up` transfer zero model bytes."""
    db, entries = registry
    base_bindings.register_base_bindings(entries)

    assert all(row["materialized"] is False for row in db.rows.values())
    assert all(row["materialization_status"] == "absent" for row in db.rows.values())


def test_backend_is_stored_as_a_logical_name(registry) -> None:
    """R1b — no deployment URL is ever persisted; config/models.yaml maps name to URL."""
    db, entries = registry
    base_bindings.register_base_bindings(entries)

    assert db.rows[SMOKE]["backend"] == "ollama"
    assert not any("http" in str(v) for row in db.rows.values() for v in row.values())


# ── R4b: reconciliation ──────────────────────────────────────────────────────

def test_repeated_registration_creates_no_duplicates(registry) -> None:
    """R4b — restarting any number of times is idempotent."""
    db, entries = registry
    for _ in range(3):
        base_bindings.register_base_bindings(entries)

    assert len(db.rows) == 2


def test_a_removed_entry_is_retired_not_deleted(registry) -> None:
    """R4b / edge 23 — a Run against it must fail NAMING the tag.

    Deleting the row would instead produce "no such binding", losing the fact that it once
    existed and was withdrawn.
    """
    db, entries = registry
    base_bindings.register_base_bindings(entries)

    base_bindings.register_base_bindings([entries[0]])

    assert db.rows[OTHER]["status"] == "retired"
    assert OTHER in db.rows, "the row must be retained, not removed"


def test_restoring_an_entry_promotes_it_again(registry) -> None:
    db, entries = registry
    base_bindings.register_base_bindings(entries)
    base_bindings.register_base_bindings([entries[0]])

    base_bindings.register_base_bindings(entries)

    assert db.rows[OTHER]["status"] == "promoted"


# ── R4g / R4h: materialization reconciliation ────────────────────────────────

def test_baked_model_is_corrected_up_on_first_boot(registry) -> None:
    """R4g — the smoke model ships inside the armada-models image."""
    db, entries = registry
    base_bindings.register_base_bindings(entries)

    result = base_bindings.reconcile_materialization({"qwen3:0.6b"})

    assert result["corrected_up"] == [SMOKE]
    assert db.rows[SMOKE]["materialized"] is True
    assert db.rows[SMOKE]["materialization_status"] == "present"
    assert db.rows[OTHER]["materialized"] is False


def test_stale_materialized_true_is_corrected_down(registry) -> None:
    """R4h — THE test this phase most needs.

    Without it, P7's fail-fast trusts a stale `true` and admits a Run against a model the
    server cannot serve.
    """
    db, entries = registry
    base_bindings.register_base_bindings(entries)
    base_bindings.reconcile_materialization({"qwen3:0.6b"})
    assert db.rows[SMOKE]["materialized"] is True

    # The weights vanish behind forge's back.
    result = base_bindings.reconcile_materialization(set())

    assert result["corrected_down"] == [SMOKE]
    assert db.rows[SMOKE]["materialized"] is False
    assert db.rows[SMOKE]["materialization_status"] == "absent"


def test_an_unreachable_model_server_corrects_nothing(registry) -> None:
    """None is NOT an empty set.

    "Cannot ask" must never be read as "has nothing", or a transient blip would demote
    every binding and strand the platform until the next restart.
    """
    db, entries = registry
    base_bindings.register_base_bindings(entries)
    base_bindings.reconcile_materialization({"qwen3:0.6b"})

    result = base_bindings.reconcile_materialization(None)

    assert "skipped" in result
    assert db.rows[SMOKE]["materialized"] is True, "a blip must not demote a live binding"


def test_registration_does_not_clobber_materialization_state(registry) -> None:
    """Whether weights are present is a fact about the model server, not about config.

    A re-registration that reset it would undo R4h on every restart.
    """
    db, entries = registry
    base_bindings.register_base_bindings(entries)
    base_bindings.reconcile_materialization({"qwen3:0.6b"})

    base_bindings.register_base_bindings(entries)

    assert db.rows[SMOKE]["materialized"] is True
