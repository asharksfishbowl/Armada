-- 004_agents.sql — agents, agent_versions.
-- Owned by the Agent Definition spec (R22, R23, R26).
--
-- RENUMBERED from 005 per roadmap F4. This migration MUST precede 005_runs_events,
-- because runs.agent_version_id carries a real foreign key to agent_versions.

BEGIN;

-- Agent Definition R22. `name` is unique and immutable (R2) and is the single namespace
-- shared by API-created and file-loaded Agents (R32) — a file whose name matches an
-- API-created Agent creates a new version of that same Agent rather than a second one.
CREATE TABLE agents (
    agent_id        uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            text        NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9-]+$'),
    current_version int         NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- R26 — delete is soft. Historical Runs stay queryable and agent_versions rows are
    -- retained, so a Run's pinned definition remains readable after its Agent is deleted.
    deleted_at      timestamptz
);

CREATE INDEX agents_deleted_at_idx ON agents (deleted_at) WHERE deleted_at IS NULL;

-- Agent Definition R22-R24. Versions are IMMUTABLE (R23) — no code path updates a row
-- here. `resolved_snapshot` is invariant 2 made concrete: it captures binding_tag,
-- context_window, tool_format, adapter_id, corpus_id, auto_inject_k, mode, the
-- post-denied tool list, effective budgets, effective sandbox values, and warnings.
-- A Run executes against this snapshot and never re-resolves (Runtime R17).
CREATE TABLE agent_versions (
    agent_version_id uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id         uuid        NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    version          int         NOT NULL,
    definition       jsonb       NOT NULL,
    resolved_snapshot jsonb      NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- R23 — version is monotonic per Agent. Edge 14: a byte-identical update creates no new
-- version, so the sequence has no gaps from no-op saves.
CREATE UNIQUE INDEX agent_versions_version_per_agent_idx
    ON agent_versions (agent_id, version);

CREATE INDEX agent_versions_agent_id_idx ON agent_versions (agent_id);

INSERT INTO schema_migrations (version) VALUES ('004_agents');

COMMIT;
