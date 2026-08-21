-- 003_training.sql — datasets, training_runs, adapters, evaluations, model_bindings.
-- Owned by the Model & Training Pipeline spec (R19, R28, R29, R32, R36).

BEGIN;

-- Training R19. `source_breakdown` records per-origin counts so R20's "zero samples from
-- every named source" failure can name each source and its count.
CREATE TABLE datasets (
    dataset_id       uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    corpus_id        uuid        REFERENCES corpora(corpus_id) ON DELETE SET NULL,
    sample_count     int         NOT NULL,
    source_breakdown jsonb       NOT NULL DEFAULT '{}'::jsonb,
    artifact_path    text        NOT NULL,
    eval_split_path  text,
    eval_fraction    real,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Training R28. `run_kind` is recorded by the backend at submit time from CUDA detection
-- (R24) and is NEVER operator-selectable (R24c) — a smoke run must stay identifiable as
-- one forever, because R37 makes it permanently unpromotable.
CREATE TABLE training_runs (
    training_run_id uuid             PRIMARY KEY DEFAULT uuid_generate_v4(),
    backend         training_backend NOT NULL,
    run_kind        run_kind         NOT NULL,
    base_model_id   text             NOT NULL,
    dataset_id      uuid             NOT NULL REFERENCES datasets(dataset_id),
    config          jsonb            NOT NULL DEFAULT '{}'::jsonb,
    status          training_status  NOT NULL DEFAULT 'queued',
    progress_steps  int              NOT NULL DEFAULT 0,
    total_steps     int              NOT NULL DEFAULT 0,
    backend_handle  text,
    error           text,
    started_at      timestamptz      NOT NULL DEFAULT now(),
    ended_at        timestamptz
);

CREATE INDEX training_runs_status_idx     ON training_runs (status);
CREATE INDEX training_runs_backend_idx    ON training_runs (backend);
CREATE INDEX training_runs_run_kind_idx   ON training_runs (run_kind);
CREATE INDEX training_runs_started_at_idx ON training_runs (started_at DESC);

-- Training R29. `corpus_name` is TEXT, not an FK to corpora — edge 16 requires an Adapter
-- to keep serving after its Corpus is deleted, and its ModelBinding tag embeds the name
-- verbatim. It carries the literal 'base' when the dataset had corpus_id: null.
CREATE TABLE adapters (
    adapter_id      uuid           PRIMARY KEY DEFAULT uuid_generate_v4(),
    training_run_id uuid           NOT NULL REFERENCES training_runs(training_run_id),
    base_model_id   text           NOT NULL,
    corpus_name     text           NOT NULL,
    version         int            NOT NULL,
    status          adapter_status NOT NULL DEFAULT 'pending_eval',
    artifact_path   text           NOT NULL,
    error           text,
    created_at      timestamptz    NOT NULL DEFAULT now()
);

-- Training edge 12 — `version` is monotonic per (base_model_id, corpus_name). Two runs on
-- the same pair succeeding concurrently must get DISTINCT versions and therefore distinct
-- binding tags; the unique constraint is what makes the transactional increment safe.
-- Two runs on the same base model but different corpus_name each start at 1 and do not
-- collide, because corpus_name is part of the tag.
CREATE UNIQUE INDEX adapters_version_per_base_corpus_idx
    ON adapters (base_model_id, corpus_name, version);

CREATE INDEX adapters_status_idx     ON adapters (status);
CREATE INDEX adapters_created_at_idx ON adapters (created_at DESC);

-- Training R36. `passed` is nullable and null exactly when `completed` is false —
-- R35: an absent judgement is not a failing judgement, so a gate that did not complete
-- leaves the Adapter at pending_eval rather than rejected.
CREATE TABLE evaluations (
    evaluation_id     uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    adapter_id        uuid        NOT NULL REFERENCES adapters(adapter_id) ON DELETE CASCADE,
    mode              eval_mode   NOT NULL,
    candidate_scores  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    baseline_scores   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    samples_evaluated int         NOT NULL DEFAULT 0,
    judge_errors      int         NOT NULL DEFAULT 0,
    completed         boolean     NOT NULL DEFAULT false,
    passed            boolean,
    error             text,
    evaluated_at      timestamptz NOT NULL DEFAULT now(),

    -- R35 made structural: a verdict may exist only for a completed gate.
    CONSTRAINT evaluations_passed_requires_completed
        CHECK (completed OR passed IS NULL)
);

CREATE INDEX evaluations_adapter_id_idx ON evaluations (adapter_id);

-- Training R32. Base bindings (R4a) carry adapter_id NULL, version NULL, and
-- corpus_name 'base'. Promoted-Adapter bindings carry all three.
CREATE TABLE model_bindings (
    binding_id     uuid           PRIMARY KEY DEFAULT uuid_generate_v4(),
    tag            text           NOT NULL UNIQUE,
    base_model_id  text           NOT NULL,
    corpus_name    text           NOT NULL,
    adapter_id     uuid           REFERENCES adapters(adapter_id) ON DELETE SET NULL,
    version        int,
    context_window int            NOT NULL,
    tool_format    tool_format    NOT NULL,
    status         binding_status NOT NULL DEFAULT 'promoted',
    created_at     timestamptz    NOT NULL DEFAULT now(),
    updated_at     timestamptz    NOT NULL DEFAULT now(),

    -- R4a — a base binding is exactly the one with no Adapter behind it. Keeping the two
    -- shapes distinguishable in the schema is what lets reconciliation (R4b) retire a base
    -- binding without touching Adapter-backed ones.
    CONSTRAINT model_bindings_base_has_no_adapter
        CHECK ((adapter_id IS NULL) = (version IS NULL))
);

CREATE INDEX model_bindings_base_model_id_idx ON model_bindings (base_model_id);
CREATE INDEX model_bindings_status_idx        ON model_bindings (status);

INSERT INTO schema_migrations (version) VALUES ('003_training');

COMMIT;
