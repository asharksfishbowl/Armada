-- 001_init.sql — extensions, shared enum types, migration bookkeeping.
--
-- Applied first by db/apply-migrations.sh. Every later migration depends on the
-- enums declared here, so nothing in 002..006 declares a type of its own.
--
-- NOTE ON ORDERING (roadmap F4): the specs' Key Files sections number the runs/events
-- migration 004 and the agents migration 005, which cannot work — runs.agent_version_id
-- carries a foreign key to agent_versions, so agent_versions must exist first. The
-- renumbering is: 004_agents, 005_runs_events. See the roadmap for the full ruling.

BEGIN;

-- pgvector for chunk embeddings (Training R13), pg_trgm alongside the GIN tsvector
-- index for the full-text half of hybrid retrieval (Runtime R41).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Migration bookkeeping ────────────────────────────────────────────────────
-- Every migration file records itself here in its own transaction. apply-migrations.sh
-- skips any file whose version is already present, which is what makes re-running the
-- whole directory idempotent.
CREATE TABLE schema_migrations (
    version     text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Shared enum types ────────────────────────────────────────────────────────

-- Training R6 — Source ingestion inputs.
CREATE TYPE source_type AS ENUM ('git', 'web', 'directory', 'upload');

-- Training edge 1 — `partial` is the outcome when one Source fails and others succeed.
CREATE TYPE ingestion_status AS ENUM ('running', 'succeeded', 'partial', 'failed');

-- Training R16a — sample provenance. `trajectory` samples are never eligible for the
-- held-out eval split (R33), which is why origin is persisted rather than inferred.
CREATE TYPE sample_origin AS ENUM ('distilled', 'supplied', 'trajectory');

-- Training R26 — where a training run physically executes.
CREATE TYPE training_backend AS ENUM ('local', 'remote');

-- Training R24a/R24b — smoke proves the pipeline, quality produces a servable Adapter.
-- Never operator-selectable (R24c); set by CUDA detection at startup.
CREATE TYPE run_kind AS ENUM ('smoke', 'quality');

-- Training R23 — JobStatus.
CREATE TYPE training_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- Training R29/R30 — an Adapter is bindable only at `promoted`.
CREATE TYPE adapter_status AS ENUM ('pending_eval', 'promoted', 'rejected');

-- Training R32 — `missing` means promoted in the DB but absent from armada-models (edge 15).
CREATE TYPE binding_status AS ENUM ('promoted', 'retired', 'missing');

-- Training R34 — gate mode. `mechanical` is the default and has no teacher dependency.
CREATE TYPE eval_mode AS ENUM ('mechanical', 'judge');

-- Runtime R53a — a Run is running until it reaches a terminal outcome.
CREATE TYPE run_status AS ENUM ('running', 'terminal');

-- Runtime "Definitions" — the six terminal outcomes. INVARIANT 1: only `success` makes a
-- Run eligible as trajectory training data, and only an explicit finish(success: true)
-- produces it. `incomplete` is a legitimate self-reported negative, NOT a fault —
-- `failed` is reserved for infrastructure faults (edge 20a).
CREATE TYPE run_outcome AS ENUM (
    'success',
    'incomplete',
    'failed',
    'cancelled',
    'budget_exhausted',
    'no_progress'
);

-- Runtime R27 — Standard presents native tool schemas; Code executes a program in-sandbox.
CREATE TYPE run_mode AS ENUM ('standard', 'code');

-- Runtime R55 — the complete Event type union. Append-only; adding a member here is a
-- migration, which is deliberate: the event vocabulary is a compatibility surface for
-- both the dashboard and forge's trajectory reader.
CREATE TYPE event_type AS ENUM (
    'run_start',
    'user_message',
    'model_request',
    'model_response',
    'reasoning',
    'tool_call',
    'tool_result',
    'retrieval',
    'compaction',
    'mode_downgraded',
    'mcp_unavailable',
    'delegation',
    'error',
    'run_end'
);

-- Training R1 — chat template and tool format, validated against config/base-models.yaml.
CREATE TYPE chat_template AS ENUM ('qwen3', 'llama3', 'gemma3');
CREATE TYPE tool_format AS ENUM ('json_schema', 'hermes');

INSERT INTO schema_migrations (version) VALUES ('001_init');

COMMIT;
