-- 006_teams.sql — teams, team_versions.
-- Owned by the Team Orchestration spec (R10).
--
-- This migration adds NO columns to `runs`. Per roadmap F4, parent_run_id, delegation_id,
-- is_team_run, and team_version_id were all declared nullable in 005_runs_events.sql so
-- GET /api/runs is complete from Phase 4. All that remains here is team_version_id's
-- foreign key, which had to wait for team_versions to exist.

BEGIN;

-- Team Orchestration R1, R10 — same immutable-version semantics as Agents (R22/R23).
CREATE TABLE teams (
    team_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            armada_name NOT NULL UNIQUE,
    current_version int         NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- R102 of the design spec: deleting a Team deletes the definition only. Every member
    -- Agent and every Run the Team produced is retained, so this is a soft delete.
    deleted_at      timestamptz
);

CREATE INDEX teams_deleted_at_idx ON teams (deleted_at) WHERE deleted_at IS NULL;

-- R10 — `resolved_roster` pins each member's agent_version_id (invariant 2). Every
-- delegation in one Team Run targets the same pinned worker versions even if the
-- underlying Agent is edited mid-Run (edge 10).
CREATE TABLE team_versions (
    team_version_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         uuid        NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    version         int         NOT NULL,
    definition      jsonb       NOT NULL,
    resolved_roster jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX team_versions_version_per_team_idx
    ON team_versions (team_id, version);

CREATE INDEX team_versions_team_id_idx ON team_versions (team_id);

-- The deferred half of F4's ruling: the column shipped in 005, the FK lands now.
ALTER TABLE runs
    ADD CONSTRAINT runs_team_version_id_fkey
    FOREIGN KEY (team_version_id) REFERENCES team_versions(team_version_id);

CREATE INDEX runs_team_version_id_idx ON runs (team_version_id);
CREATE INDEX runs_is_team_run_idx ON runs (is_team_run) WHERE is_team_run;

INSERT INTO schema_migrations (version) VALUES ('006_teams');

COMMIT;
