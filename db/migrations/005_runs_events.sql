-- 005_runs_events.sql — runs, events, and the transactional per-run seq counter.
-- Owned by the Agent Runtime spec (R53a, R54-R58).
--
-- RENUMBERED from 004 per roadmap F4, so agent_versions (004) exists before the FK below.
--
-- The four Team Orchestration columns — parent_run_id, delegation_id, is_team_run,
-- team_version_id — are declared NULLABLE HERE rather than added in 006. Runtime R3b has
-- GET /api/runs return parent_run_id, and that endpoint ships in Phase 4, two phases
-- before Team Orchestration. Only team_version_id's foreign key is deferred to 006,
-- because team_versions does not exist yet. 006 therefore adds NO columns to this table.

BEGIN;

-- Runtime R53a.
CREATE TABLE runs (
    run_id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- R53b — written at Run creation, NEVER updated. The only link between a Run and the
    -- definition that produced it, and what makes a Run reproducible (invariant 2).
    agent_version_id uuid        NOT NULL REFERENCES agent_versions(agent_version_id),

    workspace_path   text,
    status           run_status  NOT NULL DEFAULT 'running',

    -- Nullable until termination. INVARIANT 1: `success` is reachable ONLY through an
    -- explicit finish(success: true) self-report (R25, R25a). Nothing infers it from
    -- termination, which is why there is no DEFAULT here.
    outcome          run_outcome,

    result           text,
    mode             run_mode    NOT NULL DEFAULT 'standard',

    -- Budget counters (R31). Persisted rather than derived so run_end (R57) can record
    -- them at termination and GET /api/runs/{id} can report them mid-Run.
    steps_used         int    NOT NULL DEFAULT 0,
    model_tokens_used  bigint NOT NULL DEFAULT 0,
    tool_calls_used    int    NOT NULL DEFAULT 0,
    -- R22 — queue time is recorded separately and does NOT count against wall clock.
    wall_clock_ms_used bigint NOT NULL DEFAULT 0,
    queued_ms_total    bigint NOT NULL DEFAULT 0,

    -- Team Orchestration R19. Both nullable: a solo Run is not a delegation.
    parent_run_id    uuid        REFERENCES runs(run_id) ON DELETE SET NULL,
    -- The event_id of the manager's tool_call Event that created this child. No FK —
    -- events is append-only and a delegation_id must survive independently.
    delegation_id    uuid,
    is_team_run      boolean     NOT NULL DEFAULT false,
    -- FK added in 006_teams.sql once team_versions exists.
    team_version_id  uuid,

    -- R58 — the transactional per-run seq counter. Incremented by append_event() under a
    -- row lock, which is what makes concurrent tool completions unable to duplicate or
    -- reorder seq values. Starts at 1 so the first Event is seq 1 (Runtime AC).
    next_seq         bigint      NOT NULL DEFAULT 1,

    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,

    -- A terminal Run has an outcome; a running Run does not. Makes invariant 1's
    -- "every Run terminates with one of six outcomes" checkable in the schema.
    CONSTRAINT runs_terminal_has_outcome
        CHECK ((status = 'terminal') = (outcome IS NOT NULL))
);

CREATE INDEX runs_agent_version_id_idx ON runs (agent_version_id);
CREATE INDEX runs_status_idx           ON runs (status);
CREATE INDEX runs_outcome_idx          ON runs (outcome);
CREATE INDEX runs_parent_run_id_idx    ON runs (parent_run_id);
-- R3b — newest-first listing with cursor pagination.
CREATE INDEX runs_started_at_idx       ON runs (started_at DESC, run_id DESC);

-- Runtime R54. APPEND-ONLY (invariant 5) — enforced by trigger below, not by convention.
CREATE TABLE events (
    event_id   uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id     uuid        NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    seq        bigint      NOT NULL,
    type       event_type  NOT NULL,
    payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- R54 — gapless and monotonic PER RUN. The unique constraint is the backstop that makes
-- a duplicate seq a database error rather than a silently corrupted stream.
CREATE UNIQUE INDEX events_seq_per_run_idx ON events (run_id, seq);
CREATE INDEX events_run_id_seq_idx ON events (run_id, seq);
CREATE INDEX events_type_idx       ON events (type);

-- ── Invariant 5: append-only, enforced ───────────────────────────────────────
-- "No code path updates or deletes an Event." A trigger makes that true of every code
-- path including a psql session, rather than true only of the code paths we remembered.
-- Deleting a Run still cascades — that removes the whole stream, it does not mutate one.
CREATE FUNCTION events_reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'events is append-only (invariant 5): % on event_id % rejected',
        TG_OP, COALESCE(OLD.event_id, NEW.event_id);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_no_update
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();

CREATE TRIGGER events_no_delete
    BEFORE DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();

-- ── R58: transactional seq assignment ────────────────────────────────────────
-- Assigns seq and inserts the Event atomically. The UPDATE ... RETURNING takes a row lock
-- on `runs`, so two concurrent tool completions serialize here rather than racing for the
-- same seq. Callers never compute a seq themselves — that is the whole point.
--
-- Gaplessness holds because the counter increment and the insert share one transaction:
-- if the insert rolls back, so does the increment, and the number is reused.
CREATE FUNCTION append_event(
    p_run_id  uuid,
    p_type    event_type,
    p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (event_id uuid, seq bigint) AS $$
DECLARE
    v_seq bigint;
BEGIN
    UPDATE runs
       SET next_seq = next_seq + 1
     WHERE run_id = p_run_id
    RETURNING next_seq - 1 INTO v_seq;

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'append_event: no run with run_id %', p_run_id;
    END IF;

    RETURN QUERY
    INSERT INTO events (run_id, seq, type, payload)
         VALUES (p_run_id, v_seq, p_type, p_payload)
      RETURNING events.event_id, events.seq;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version) VALUES ('005_runs_events');

COMMIT;
