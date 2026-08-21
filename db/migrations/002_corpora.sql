-- 002_corpora.sql — corpora, sources, chunks, ingestion_jobs.
-- Owned by the Model & Training Pipeline spec (R5-R14). armada-forge writes here;
-- armada-daemon only ever reads `chunks` for retrieval (platform boundary 1).

BEGIN;

-- Training R5 — `name` is immutable and takes the shared `armada_name` domain from 001,
-- because Agent definitions reference Corpora by name (invariant 4) and ModelBinding tags
-- embed it. Edge 24: two names differing only by case would make a binding tag ambiguous,
-- which the domain's constraint prevents rather than detects.
CREATE TABLE corpora (
    corpus_id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name             armada_name NOT NULL UNIQUE,
    description      text        NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_ingested_at timestamptz
);

-- Training R6.
CREATE TABLE sources (
    source_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id     uuid        NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
    type          source_type NOT NULL,
    location      text        NOT NULL,
    include_globs text[]      NOT NULL DEFAULT '{}',
    exclude_globs text[]      NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sources_corpus_id_idx ON sources (corpus_id);

-- Training R12. Deleting a Corpus deletes its chunks (edge 16) — Adapters trained from
-- it are retained and keep serving, which is why no FK runs from adapters to corpora.
CREATE TABLE chunks (
    chunk_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id      uuid        NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
    source_id      uuid        NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
    content        text        NOT NULL,
    embedding      vector(384) NOT NULL,
    token_count    int         NOT NULL,
    source_path    text        NOT NULL,
    start_line     int,
    end_line       int,
    content_sha256 text        NOT NULL,
    split_oversize boolean     NOT NULL DEFAULT false,
    ingested_at    timestamptz NOT NULL DEFAULT now()
);

-- Training R14 — idempotency is keyed on the PAIR (content_sha256, source_path) per
-- corpus. Edge 17: two Sources producing byte-identical content at different paths keep
-- both chunk sets, which is why source_path is part of the key and not just the hash.
CREATE UNIQUE INDEX chunks_idempotency_idx
    ON chunks (corpus_id, source_path, content_sha256);

-- No standalone corpus_id index: chunks_idempotency_idx leads with corpus_id, so Postgres
-- already uses it for corpus-scoped lookups.
CREATE INDEX chunks_source_id_idx ON chunks (source_id);

-- Training R13 — the two halves of hybrid retrieval (Runtime R41). Both indexes exist
-- from this migration so Phase 5's RRF fusion has nothing to add to the schema.
CREATE INDEX chunks_embedding_hnsw_idx
    ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX chunks_content_fts_idx
    ON chunks USING gin (to_tsvector('english', content));

-- Training R7, data flow 2/7. Edge 18: a second concurrent ingest for one Corpus returns
-- 409 naming the in-flight job, enforced by the partial unique index below.
CREATE TABLE ingestion_jobs (
    job_id         uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
    corpus_id      uuid             NOT NULL REFERENCES corpora(corpus_id) ON DELETE CASCADE,
    status         ingestion_status NOT NULL DEFAULT 'running',
    chunks_added   int              NOT NULL DEFAULT 0,
    chunks_removed int              NOT NULL DEFAULT 0,
    files_skipped  int              NOT NULL DEFAULT 0,
    source_results jsonb            NOT NULL DEFAULT '{}'::jsonb,
    error          text,
    started_at     timestamptz      NOT NULL DEFAULT now(),
    ended_at       timestamptz
);

-- At most one running job per Corpus. Enforced in the schema rather than in application
-- code so a race between two API calls cannot produce two running jobs.
CREATE UNIQUE INDEX ingestion_jobs_one_running_per_corpus_idx
    ON ingestion_jobs (corpus_id)
    WHERE status = 'running';

CREATE INDEX ingestion_jobs_corpus_id_started_idx
    ON ingestion_jobs (corpus_id, started_at DESC);

INSERT INTO schema_migrations (version) VALUES ('002_corpora');

COMMIT;
