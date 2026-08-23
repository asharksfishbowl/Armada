"""Base ModelBinding registration and startup reconciliation — Training R4a, R4b, R4h.

THE CENTRAL DISTINCTION (R4c): REGISTERING A BINDING WRITES A RECORD. IT DOES NOT TRANSFER
MODEL WEIGHTS.

Registering all five shortlist entries *with the model server* would mean pulling roughly
10-15 GB before the platform is usable — incompatible with both a fast first boot and the
blocked-egress acceptance criterion. So startup writes five rows and transfers zero model
bytes; materializing is a separate explicit act (registry/materialize.py).

Three reconciliations run on every startup, and all three are idempotent:

  R4b  entries removed from config go `status: retired`; present entries are not
       re-registered, so restarting any number of times creates no duplicates.
  R4g  the `smoke_test` entry is baked into the armada-models image, so it is
       materialized from first boot.
  R4h  a binding recorded `materialized: true` whose weights armada-models no longer has
       is corrected back down to false/absent.

R4h is the one worth building deliberately. Without it, P7's fail-fast pre-flight would
trust a stale `true` and admit a Run against a model that cannot answer — converting a
clean pre-flight failure into a mid-Run one, which is strictly worse to diagnose.
"""

from __future__ import annotations

from typing import Any

from armada_forge import db
from armada_forge.registry.models import BASE_CORPUS_NAME, ShortlistEntry, base_tag


def register_base_bindings(entries: list[ShortlistEntry]) -> dict[str, Any]:
    """R4a + R4b — write one record per shortlist entry, retire the departed.

    Writes `materialized: false` unless a later reconciliation says otherwise. Nothing here
    contacts armada-models: that is the whole point of R4c.
    """
    registered: list[str] = []
    retired: list[str] = []

    for entry in entries:
        tag = base_tag(entry.id)

        # R4b — idempotent. ON CONFLICT updates the fields that can legitimately change
        # when an operator edits the shortlist (context window, tool format, backend) but
        # NEVER touches materialization state: whether weights are present is a fact about
        # the model server, not about this file, and clobbering it here would undo R4h.
        db.execute(
            """
            INSERT INTO model_bindings (
                tag, backend, base_model_id, corpus_name, adapter_id, version,
                context_window, tool_format, status
            ) VALUES (%s, %s, %s, %s, NULL, NULL, %s, %s, 'promoted')
            ON CONFLICT (tag) DO UPDATE SET
                backend        = EXCLUDED.backend,
                context_window = EXCLUDED.context_window,
                tool_format    = EXCLUDED.tool_format,
                status         = 'promoted',
                updated_at     = now()
            """,
            (
                tag,
                entry.backend,
                entry.id,
                BASE_CORPUS_NAME,
                entry.context_window,
                entry.tool_format,
            ),
        )
        registered.append(tag)

    # R4b — an entry removed from config has its base binding RETIRED, not deleted. A Run
    # against a retired binding must fail with the runtime's missing-binding error naming
    # the tag (edge 23); deleting the row would instead produce "no such binding", which
    # loses the fact that it once existed and was withdrawn.
    if registered:
        retired_rows = db.query(
            """
            UPDATE model_bindings
               SET status = 'retired', updated_at = now()
             WHERE adapter_id IS NULL
               AND status <> 'retired'
               AND tag <> ALL(%s)
            RETURNING tag
            """,
            (registered,),
        )
        retired = [row["tag"] for row in retired_rows]

    return {"registered": registered, "retired": retired}


def mark_materialized(tag: str, present: bool, error: str | None = None) -> None:
    """Set both materialization fields together.

    They are written as a pair because the schema constrains `materialized` to equal
    `materialization_status = 'present'`. Writing one without the other is rejected by the
    database rather than producing the disagreement R4h exists to clean up.
    """
    db.execute(
        """
        UPDATE model_bindings
           SET materialized = %s,
               materialization_status = %s,
               materialization_error = %s,
               updated_at = now()
         WHERE tag = %s
        """,
        (present, "present" if present else ("failed" if error else "absent"), error, tag),
    )


def reconcile_materialization(served_refs: set[str] | None) -> dict[str, Any]:
    """R4h + R4g — correct materialization state against what the model server actually has.

    `served_refs` is the set of serving_refs armada-models reports. None means the server
    could not be reached, in which case NOTHING is corrected: an unreachable model server
    is not evidence that weights are gone, and demoting every binding on a transient blip
    would make the platform unusable until the next restart.
    """
    if served_refs is None:
        return {"skipped": "armada-models unreachable; materialization state left as-is"}

    rows = db.query(
        """
        SELECT mb.tag, mb.base_model_id, mb.materialized
          FROM model_bindings mb
         WHERE mb.adapter_id IS NULL AND mb.status = 'promoted'
        """
    )

    corrected_down: list[str] = []
    corrected_up: list[str] = []

    for row in rows:
        tag = row["tag"]
        # A base binding's serving_ref comes from the shortlist, which the caller resolves;
        # `_serving_ref_for` is injected so this function stays testable without config.
        serving_ref = _SERVING_REFS.get(row["base_model_id"])
        if serving_ref is None:
            continue

        present = serving_ref in served_refs

        if row["materialized"] and not present:
            # R4h — the stale-true case. This is what stops P7's pre-flight from admitting
            # a Run against a model the server cannot serve.
            mark_materialized(tag, False)
            corrected_down.append(tag)
        elif present and not row["materialized"]:
            # R4g on first boot: the baked smoke model is already there. Also covers an
            # operator who pulled a model into armada-models by hand.
            mark_materialized(tag, True)
            corrected_up.append(tag)

    return {"corrected_down": corrected_down, "corrected_up": corrected_up}


# Populated by set_serving_refs() at startup. A module-level map rather than a parameter so
# reconcile_materialization keeps the signature its callers and tests want.
_SERVING_REFS: dict[str, str] = {}


def set_serving_refs(entries: list[ShortlistEntry]) -> None:
    _SERVING_REFS.clear()
    _SERVING_REFS.update({entry.id: entry.serving_ref for entry in entries})
