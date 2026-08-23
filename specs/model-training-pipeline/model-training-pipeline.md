# Spec: Model & Training Pipeline

## Overview
The `armada-forge` service turns raw domain material into the two artifacts an Armada agent needs: a **Corpus** (chunked, embedded domain knowledge in pgvector) and an optional **Adapter** (a LoRA adapter carrying domain behavior). It owns ingestion, dataset construction, training backend dispatch, model registration, and the evaluation gate that decides whether an Adapter is fit to serve.

## Goals
- Ingest a git repo, docs site, local directory, or uploaded file into a queryable Corpus without manual preprocessing.
- Produce LoRA Adapters from corpus-derived and trajectory-derived datasets through a backend interface that hides where training physically runs.
- Prove the entire training path end to end on a CPU-only host, with no GPU and no cloud credentials.
- Refuse to promote an Adapter that does not measurably beat its BaseModel.
- Register every promoted ModelBinding with `armada-models` under a stable, unique tag the daemon can address.

## Non-Goals
- Serving retrieval queries to agents. `armada-forge` writes the index; `armada-daemon` reads it (see Agent Runtime).
- Full-parameter fine-tuning, pretraining, RLHF, or DPO. LoRA SFT only.
- Automatic scheduled re-ingestion or re-training. All jobs are operator-triggered.
- Managing GPU infrastructure. The remote backend submits to an existing provider; it does not provision hardware.
- Embedding model fine-tuning. The embedding model is fixed configuration.

## Definitions
- **Smoke run** — a training run on `LocalTrainingBackend` whose purpose is proving the pipeline executes correctly, not producing a usable model. Always uses the BaseModel marked `smoke_test: true`.
- **Quality run** — a training run on `RemoteTrainingBackend` intended to produce an Adapter that will actually serve traffic.
- **Promotion** — the act of marking an Adapter `status: promoted`, which is the only state in which `armada-daemon` may bind it.

## Requirements

### Base Model Registry
1. `config/base-models.yaml` defines the curated BaseModel shortlist. Each entry has the keys: `id` (string, unique), `hf_id`, `backend` (string, default `ollama`), `serving_ref` (string), `context_window` (int), `chat_template` (string, one of `qwen3`, `llama3`, `gemma3`), `tool_format` (string, one of `json_schema`, `hermes`), `quantization` (string, e.g. `Q4_K_M`), `min_ram_gb` (int), `min_disk_gb` (int), `trainable` (bool), `lora_target_modules` (list of strings), `smoke_test` (bool).
1a. `serving_ref` is the identifier the named `backend` uses to serve the model, and is interpreted only by that backend — for `ollama` it is the Ollama tag. The key is deliberately not named after any one server: the shortlist is a curated list of *models*, and a specific inference server's addressing scheme is a deployment detail that must not leak into it.
1b. `backend` is the discriminator that keeps that separation honest. `ollama` is the only accepted value in this spec, and `config/models.yaml` maps a backend name to its base URL, so the binding stays a logical reference and no deployment-specific URL is ever written to the database. A spec introducing a second inference server adds a value here; nothing else in the registry, promotion path, or evaluation gate changes.
1c. The field exists now, ahead of any second backend, purely because the cost is asymmetric: adding a defaulted column to empty tables and an unshipped config schema is trivial, while retrofitting a discriminator into a populated `model_bindings` table behind a live `GET /models/bindings` contract is not.
2. The shipped shortlist contains exactly these entries: `qwen3-0.6b` (`smoke_test: true`), `qwen3-1.7b`, `qwen3-4b-instruct`, `llama-3.2-3b-instruct`, `gemma-3-4b-it`. Exactly one entry has `smoke_test: true`.
3. An operator may append entries to `config/base-models.yaml`. `armada-forge` validates appended entries against the same key schema on startup and fails startup with a non-zero exit code and the offending `id` in the error message if any entry is invalid.
4. `POST /models/base` is not exposed. The shortlist is file-configured only.
4a. On startup, after validating the shortlist, `armada-forge` **writes one `model_bindings` record** per BaseModel entry under the tag `armada/{base_model_id}-base`, with `adapter_id: null`, `status: promoted`, and `materialized: false` unless the weights are already present. This makes every base model addressable by an Agent declaring `adapter: none` without any training run having occurred.
4b. Base ModelBindings are reconciled on every startup: entries removed from `config/base-models.yaml` have their base binding set to `status: retired`, and existing bindings are not re-registered if already present. Reconciliation is idempotent — restarting `armada-forge` any number of times creates no duplicate bindings.

### Registration and materialization are separate acts

4c. **Registering a binding writes a record. It does not transfer model weights.** Materializing one — making the weights present so the binding can answer — is a separate, explicit operation. A binding may be `status: promoted` and `materialized: false` at the same time, and that is the normal state of most of the shortlist on a fresh installation.

The distinction exists so a first `docker compose up` transfers **zero model bytes**. Registering all five shortlist entries *with the model server* would require pulling roughly 10–15 GB before the platform is usable, which is incompatible with both a fast first boot and the blocked-egress acceptance criterion.

4d. `model_bindings` carries `materialized` (bool) and `materialization_status` (one of `absent`, `pending`, `materializing`, `present`, `failed`). Both are returned by `GET /models/bindings` (Requirement 32), so no consumer has to guess whether a Run against a binding will start immediately or block behind a download.

4e. `POST /models/bindings/{tag}/materialize` transfers the weights for a registered binding and registers it with `armada-models`. It is owned by `armada-forge` — cross-service boundary 2 gives the forge responsibility for registering ModelBindings with the model server, so materialization belongs there too. The call returns before the transfer completes and reports progress on the forge progress channel with `job_kind: materialization`.

4f. Materialization is **refused** when host available memory is below the entry's `min_ram_gb`, or host free disk is below its `min_disk_gb`. The refusal names **both** the required and the observed value for whichever limit was hit. `min_ram_gb` is load-bearing here rather than decorative.

4g. Exactly one shortlist entry — the `smoke_test: true` model — is baked into the `armada-models` image and is therefore `materialized: true` from first boot. This is what lets the smoke training path and a first Agent Run work offline on a fresh installation. Every other entry registers unmaterialized.
4h. Materialization state is reconciled on startup alongside registration: a binding recorded `materialized: true` whose weights are no longer present in `armada-models` is corrected to `materialized: false` with `materialization_status: absent`, rather than left claiming a model the server cannot serve.

### Corpus Ingestion
5. `POST /corpora` creates a Corpus with fields `name` (string, unique, `^[a-z0-9-]+$`), `description` (string), and returns `corpus_id` (uuid). A Corpus `name` is immutable after creation, because Agent definitions reference Corpora by `name` and ModelBinding tags embed it.
5a. `GET /corpora` lists every Corpus with `corpus_id`, `name`, `description`, `chunk_count`, `source_count`, and `last_ingested_at`. `GET /corpora/{corpus_id}` returns the same fields plus the Corpus's Sources and its most recent `ingestion_jobs` row. `armada-daemon` calls `GET /corpora` to resolve an Agent's `corpus.name` to a `corpus_id` during validation.
6. `POST /corpora/{corpus_id}/sources` registers a Source with `type` (one of `git`, `web`, `directory`, `upload`), `location` (string), and `include_globs` / `exclude_globs` (lists of strings, optional).
7. `POST /corpora/{corpus_id}/ingest` starts an ingestion job over all of that Corpus's Sources and returns `job_id`. The call returns before ingestion completes.
8. Ingestion fetches each Source: `git` clones at depth 1 to a temp directory; `web` crawls same-origin links to a depth of 2; `directory` reads a path bind-mounted into the container; `upload` reads a previously uploaded blob.
9. Ingestion extracts text from these file types and skips all others: `.md`, `.mdx`, `.txt`, `.rst`, `.pdf`, `.html`, and any file whose extension appears in `config/code-extensions.yaml`.
10. Chunking uses two strategies selected by file type. Code files chunk on top-level function and class boundaries, never splitting a function body. Prose files chunk on heading and paragraph boundaries. Both strategies target 512 tokens with 64 tokens of overlap and hard-split any single unit exceeding 1024 tokens.
11. Each chunk is embedded with `BAAI/bge-small-en-v1.5` (384 dimensions) running on CPU inside `armada-forge`.
12. Each chunk is written to the `chunks` table with columns: `chunk_id` (uuid), `corpus_id` (uuid), `source_id` (uuid), `content` (text), `embedding` (vector(384)), `token_count` (int), `source_path` (text), `start_line` (int, nullable), `end_line` (int, nullable), `content_sha256` (text), `ingested_at` (timestamptz).
13. The `chunks` table has an HNSW index on `embedding` using cosine distance, and a GIN index on `to_tsvector('english', content)`.
14. Re-ingesting a Corpus is idempotent per chunk: a chunk whose `content_sha256` already exists for the same `corpus_id` and `source_path` is not re-embedded and not duplicated. Chunks present in a prior ingestion but absent from the current one are deleted.

### Dataset Construction
15. `POST /datasets` builds a dataset and returns `dataset_id`. The request specifies `corpus_id` (uuid, nullable), `include_trajectories` (bool), `agent_ids` (list of uuid, optional filter for trajectories), `supplied_file` (string, nullable, a path under `/data/supplied/`), and `max_samples` (int). At least one of `corpus_id`, `include_trajectories: true`, or `supplied_file` must be present; a request with none returns HTTP 400 naming the three sources.
15a. `POST /datasets/supplied` accepts a JSONL upload and stores it at `/data/supplied/{name}.jsonl`. Each line must be an object with `instruction` (string, non-empty) and `response` (string, non-empty); any other key is ignored. Lines that fail validation are rejected with their line numbers and the upload is not stored. This is the **operator-supplied** dataset source: it requires no teacher model and therefore no external spend.
15b. Samples read from `supplied_file` are recorded with `origin: supplied`. Like distilled samples, they carry a reference response written by something other than the model under test, so they are eligible for the held-out evaluation split (Requirement 33).
16. Corpus-derived samples are produced by distillation: for each sampled chunk, `armada-forge` prompts the configured teacher model to emit instruction/response pairs grounded in that chunk. A sample whose response contains text not entailed by its source chunk, as judged by a second teacher call returning a boolean, is discarded.
16a. Every sample carries `instruction`, `response`, and `origin` (one of `distilled`, `supplied`, `trajectory`). For `distilled` and `supplied` samples the `response` is the **reference response** used by the evaluation gate (Requirement 34). Trajectory samples are never placed in the held-out eval split, because their reference response is a small model's own prior output.
16b. **Distillation is opt-in and off by default.** `config/teacher.yaml` has `enabled` (bool, default `false`). When `enabled` is `false`, a `POST /datasets` naming a `corpus_id` returns HTTP 400 stating that corpus distillation requires a teacher and naming the two teacher-free sources (`supplied_file`, `include_trajectories`). No request is made to any external endpoint while `enabled` is `false`. This is what makes a default installation cost nothing to run.
16c. `config/teacher.yaml` selects the teacher with `provider`, one of `none` (default), `local`, or `remote`. `local` targets a model served by `armada-models`, costs nothing beyond CPU time, and is expected to be slow — a 4B teacher on CPU generates on the order of thousands of samples per day. `remote` targets an external OpenAI-compatible endpoint and is the only option that incurs spend.
17. Trajectory-derived samples are read from the `events` table written by `armada-daemon`. Only Runs whose `run_end` Event records `outcome: success` contribute; Runs with outcome `incomplete`, `failed`, `cancelled`, `budget_exhausted`, or `no_progress` are excluded. Each contributing Run is flattened into one multi-turn sample preserving the system prompt, user message, assistant messages, tool calls, and tool results in original order.
18. Every sample is rendered using the `chat_template` of the target BaseModel before being written to disk.
19. Datasets are written as JSONL to `/data/datasets/{dataset_id}.jsonl` and recorded in the `datasets` table with `dataset_id`, `sample_count`, `source_breakdown` (jsonb), and `created_at`.
20. If `include_trajectories` is true and zero successful Runs match the filter, dataset construction succeeds using whichever other sources were named and records `trajectory_count: 0` in `source_breakdown`. If every named source yields zero samples, construction fails with HTTP 400 naming each source and its count, rather than writing an empty dataset.

### Training Backend Interface
21. `services/forge/armada_forge/training/backend.py` defines an abstract `TrainingBackend` with exactly these methods: `submit(config: TrainingConfig) -> str` returning a backend job handle, `poll(handle: str) -> JobStatus`, `fetch_artifacts(handle: str, dest: Path) -> None`, and `cancel(handle: str) -> None`.
22. `TrainingConfig` carries: `base_model_id`, `dataset_id`, `lora_rank` (int), `lora_alpha` (int), `learning_rate` (float), `max_steps` (int), `batch_size` (int), `max_seq_len` (int).
23. `JobStatus` is one of `queued`, `running`, `succeeded`, `failed`, `cancelled`, and carries `progress_steps` (int), `total_steps` (int), and `message` (string, nullable).
24. `LocalTrainingBackend` runs LoRA SFT in-process using PEFT and TRL. At startup it detects whether a CUDA device is available and selects one of two modes, recording the detected mode in the `training_runs` row:
24a. **Smoke mode** (no CUDA device — the default on the target CPU-only host). It rejects any `TrainingConfig` whose `base_model_id` does not have `smoke_test: true`, returning a validation error naming the constraint. It caps `max_steps` at 20 and `max_samples` at 200 regardless of requested values, and records `run_kind: smoke`. A smoke run proves the pipeline executes end to end; it is not expected to produce a model worth serving, and is never promotable (Requirement 37).
24b. **Quality mode** (CUDA device present). It accepts any `base_model_id` with `trainable: true`, applies the requested hyperparameters without caps, and records `run_kind: quality`. Adapters from this mode are promotable on the same terms as remote ones. This mode requires no configuration change and no external account — adding a GPU to the host is sufficient to move from smoke to quality runs.
24c. Mode is never operator-selectable. Requesting a non-smoke model while no CUDA device is present is an error, not a silent downgrade, so a run can never be mistaken for a quality run it was not.
25. `RemoteTrainingBackend` submits to the provider configured in `config/training-remote.yaml` (fields: `provider`, `endpoint`, `api_key_env`, `gpu_type`, `max_runtime_minutes`). It uploads the dataset, submits the job, and records `run_kind: quality`. It reads its credential from the environment variable named by `api_key_env` and never from a file in the repo.
26. `POST /training/runs` starts a training run with `backend` (one of `local`, `remote`), `base_model_id`, `dataset_id`, and optional hyperparameter overrides. It returns `training_run_id`.
27. `armada-forge` polls the active backend for each in-flight run on an event-driven basis: `LocalTrainingBackend` reports progress through a TRL trainer callback, and `RemoteTrainingBackend` subscribes to the provider's job webhook when `config/training-remote.yaml` sets `webhook_url`, falling back to provider-recommended polling intervals only when it does not.
28. Training run state is persisted to the `training_runs` table with `training_run_id`, `backend`, `run_kind`, `base_model_id`, `dataset_id`, `config` (jsonb), `status`, `progress_steps`, `total_steps`, `backend_handle`, `started_at`, `ended_at`, `error` (text, nullable).

### Model Registry, Export, and Promotion
29. On a `succeeded` training run, `armada-forge` fetches artifacts to `/data/adapters/{adapter_id}/` and inserts an `adapters` row with `adapter_id`, `training_run_id`, `base_model_id`, `corpus_name` (text, the `name` of the Corpus behind the training run's dataset, or the literal `base` when the dataset had `corpus_id: null`), `version` (int, monotonic per the pair `base_model_id` + `corpus_name`), `status` (`pending_eval`), `artifact_path`, `created_at`.
30. Promotion requires passing the evaluation gate (Requirements 33–36). An Adapter whose status is not `promoted` must not be registered with `armada-models`.
30a. `POST /adapters/{adapter_id}/promote` re-runs promotion for an Adapter whose evaluation passed but whose registration failed. It is rejected with HTTP 409 for an Adapter whose `status` is `promoted` or `rejected`, naming the current status.
31. On promotion, `armada-forge` merges the adapter into the base weights, converts to GGUF, quantizes using the BaseModel's `quantization` value, and registers the result with `armada-models` under the ModelBinding tag `armada/{base_model_id}-{corpus_name}-v{version}`, using the `corpus_name` and `version` recorded on the `adapters` row.
32. `GET /models/bindings` returns every registered ModelBinding with `tag`, `backend`, `base_model_id`, `corpus_name`, `adapter_id` (nullable), `version` (nullable for base bindings), `context_window`, `tool_format`, `materialized` (bool), `materialization_status`, and `status` (one of `promoted`, `retired`, `missing`). `armada-daemon` reads this endpoint to resolve an Agent's model binding at save time and to verify a pinned binding at Run start.

### Evaluation Gate
33. `POST /datasets/{dataset_id}/split` reserves a held-out fraction (`eval_fraction`, default 0.1) before any training run consumes the dataset, writing `/data/datasets/{dataset_id}.eval.jsonl`. The held-out set is drawn from samples with `origin: distilled` or `origin: supplied` (Requirement 16a), never from `origin: trajectory`.
33a. A dataset used for a run that could produce a promotable Adapter is rejected by `POST /training/runs` without a prior split, with an error naming the missing split. A run that cannot produce a promotable Adapter — any run `LocalTrainingBackend` will execute in smoke mode (Requirement 24a) — is accepted without a split, because the split exists solely to gate promotion. This is what allows a trajectory-only dataset, which by Requirement 33 can never be split, to still be used to prove the pipeline at zero cost.
33b. Before the evaluation gate performs any work, `armada-forge` checks the Adapter's `run_kind`. A `smoke` Adapter is set to `rejected` immediately with `error: "smoke runs are not promotable"` and **no evaluation is performed** — no completions are generated and no judge call is issued. Spending judge tokens on an Adapter that cannot be promoted under any outcome is never correct.
34. The evaluation gate runs in one of two modes, selected by `mode` in `config/eval.yaml` (one of `mechanical`, `judge`; default `mechanical`). Both modes generate a completion per held-out sample from the candidate Adapter and from the unmodified BaseModel, using `armada-models` locally, and both compute `tool_call_validity` — the fraction of tool calls emitted across those completions that parse and validate against their declared schema. Generation is local in both modes and costs nothing.
34a. **Mechanical mode** requires no teacher and incurs no external spend. It additionally computes `held_out_perplexity` for each model over the held-out set, and sets `task_success_rate` to null. This is the default gate.
34b. **Judge mode** additionally issues one teacher call per held-out sample presenting the sample's `instruction`, its `response` as the reference, and the generated completions, and asks for a pass/fail judgement against the rubric in `config/eval-rubric.md`. `task_success_rate` is the fraction judged pass; `held_out_perplexity` is not computed. Judge mode requires `config/teacher.yaml` to have `enabled: true`; selecting it against a disabled teacher fails startup validation naming both settings.
34c. **Judge mode only.** The judge is invoked with the candidate's and the baseline's completions for the same sample in a single call, with their order determined by the parity of the sample index, so position bias cannot systematically favour either model. The judge returns a verdict per completion, not a preference between them.
34d. **Judge mode only.** Teacher spend is bounded: the gate judges at most `max_eval_samples` (`config/teacher.yaml`, default 200) held-out samples. When the held-out set is larger, a deterministic sample seeded on `adapter_id` is used so a re-run of the same gate scores the same subset. Mechanical mode has no such bound, because its cost is local compute.
35. An Adapter is promoted only if the gate completed and every scored metric is at least as good as the BaseModel's: `tool_call_validity` greater than or equal (both modes); `held_out_perplexity` less than or equal (mechanical mode); `task_success_rate` greater than or equal (judge mode). When the gate completed and any scored metric is worse, the Adapter is set to `rejected` and both score sets are persisted. When the gate did not complete — in judge mode, the teacher was unreachable or `judge_errors` exceeded half the evaluated samples — the Adapter is left at `pending_eval` and is not rejected, because an absent judgement is not a failing judgement. Mechanical mode has no external dependency and therefore no incomplete outcome.
35a. `tool_call_validity` is **null**, not zero, when no tool calls were emitted across the generated completions — which is the common case for a dataset built from operator-supplied JSONL, since those samples present no tool schemas at generation time. A null metric is **excluded from the comparison in Requirement 35** rather than compared. Treating a 0/0 denominator as a score would either block every promotion or pass every one, depending on the comparison's direction; neither is a judgement.

### Recorded limitations of the gate

These are known, accepted, and stated here rather than discovered later. Both weaken what a passing gate proves; neither is a defect to be fixed inside this spec.

35b. **The gate scores an artifact that is not the one that ships.** Evaluation runs in-process against base weights plus the *unmerged* adapter in full precision, while a promoted Adapter serves as merged, GGUF-converted, and quantized weights (Requirement 31). The gate therefore judges a different artifact from the one an Agent will bind.

Closing this would require quantizing before evaluating, but quantization happens only on promotion and promotion requires passing the gate — inverting that order is a larger change than this spec makes. The obvious alternative, registering the candidate with `armada-models` for the duration of the gate, is rejected because it makes an unpromoted Adapter servable to the entire daemon, which is the exact state Requirement 30 exists to forbid. The limitation is accepted; quantization damage is not currently measured.

35c. **A mechanical pass is a smoke test, not a quality bar.** The held-out split is reserved from the same dataset the Adapter trained on, so `held_out_perplexity` measures fit to the training distribution rather than generalization to the task. Taken together with Requirement 35a — which commonly nulls the only other mechanical metric — the default gate reduces to a single in-distribution perplexity comparison.

That is sufficient to catch a training run that damaged the model, and it is the strongest gate obtainable at zero cost. It is **not** evidence the Adapter is better at the task. An operator who wants a quality bar should supply an independent held-out set drawn from outside the training data, or enable judge mode (Requirement 34b).

35d. Both limitations above are surfaced in the dashboard's evaluation view alongside the scores. An operator reading a passing gate must be able to see what it did and did not measure without consulting this spec.

36. Evaluation results are written to the `evaluations` table with `evaluation_id`, `adapter_id`, `mode` (one of `mechanical`, `judge`), `candidate_scores` (jsonb), `baseline_scores` (jsonb), `samples_evaluated` (int), `judge_errors` (int, always 0 in mechanical mode), `completed` (bool), `passed` (bool, null when `completed` is false), `error` (text, nullable), `evaluated_at`.
37. An Adapter produced by a run with `run_kind: smoke` is never promotable, by this route or by `POST /adapters/{adapter_id}/promote`. It is rejected before evaluation runs, per Requirement 33b, so it carries no scores at all rather than scores that were computed and then discarded.

## Data Flow

**Ingestion**
1. Operator creates a Corpus and registers Sources via the dashboard, which calls `POST /corpora` and `POST /corpora/{corpus_id}/sources`.
2. Operator triggers `POST /corpora/{corpus_id}/ingest`; `armada-forge` inserts an `ingestion_jobs` row with `status: running` and returns `job_id`.
3. For each Source, `armada-forge` fetches content, filters by extension and glob, and extracts text.
4. Each extracted file is chunked by the strategy matching its type, producing chunk records with `content_sha256`.
5. Chunks whose `content_sha256` is already present for that `corpus_id` and `source_path` are skipped; the rest are embedded with `bge-small-en-v1.5`.
6. New chunks are inserted into `chunks`; chunks from the prior ingestion absent from this one are deleted.
7. `armada-forge` sets the `ingestion_jobs` row to `status: succeeded` with `chunks_added` and `chunks_removed` counts.

**Training and promotion**
8. Operator triggers `POST /datasets` naming at least one of a `corpus_id`, `include_trajectories: true`, or a `supplied_file`.
8a. On a default installation `config/teacher.yaml` has `enabled: false`, so naming a `corpus_id` is rejected and the buildable sources are the operator-supplied JSONL and captured trajectories — neither of which contacts an external service.
9. When distillation is enabled, `armada-forge` samples chunks, calls the teacher model to distill instruction/response pairs, and discards pairs failing the entailment check.
10. If `include_trajectories` is true, `armada-forge` reads `events` for Runs with `outcome: success` and flattens each into a multi-turn sample.
11. All samples are rendered with the target BaseModel's `chat_template` and written to `/data/datasets/{dataset_id}.jsonl`.
12. Operator calls `POST /datasets/{dataset_id}/split`, reserving the held-out eval file.
13. Operator calls `POST /training/runs`; `armada-forge` selects the backend and calls `TrainingBackend.submit(config)`.
14. Progress reaches `armada-forge` via trainer callback (local) or webhook (remote); each update writes `progress_steps` to `training_runs` and emits a dashboard WS message.
15. On `succeeded`, `armada-forge` calls `fetch_artifacts`, writes `/data/adapters/{adapter_id}/`, and inserts an `adapters` row with `status: pending_eval`.
16. If `run_kind` is `smoke`, the Adapter is set to `rejected` immediately and no evaluation work is performed. Otherwise the gate scores candidate and baseline on the held-out set in the configured mode and writes an `evaluations` row.
17. If `passed` is true, `armada-forge` merges, converts to GGUF, quantizes, registers the ModelBinding with `armada-models`, and sets `status: promoted`. Otherwise it sets `status: rejected`.
18. `armada-daemon` calls `GET /models/bindings` at two moments only: at Agent save time, to resolve a definition's model reference into a pinned `binding_tag`; and at Run start, to verify that pinned tag is still present and `promoted`. It then addresses that tag through the `armada-models` OpenAI-compatible API. It never re-resolves a pinned Agent's model reference on its own.

## Edge Cases
1. When a git Source clone fails (bad URL, auth required, host unreachable), the ingestion job records that Source as `failed` with the underlying error, continues ingesting remaining Sources, and completes with `status: partial`.
2. When a Corpus has zero Sources, `POST /corpora/{corpus_id}/ingest` returns HTTP 400 naming the empty Corpus and no job is created.
3. When a file's extracted text is empty or whitespace-only, it produces zero chunks and is counted in `files_skipped` rather than failing the job.
4. When a single code unit (function or class) exceeds 1024 tokens, it is hard-split at 1024 tokens with 64 tokens of overlap and the resulting chunks are flagged `split_oversize: true`.
5. When the teacher model endpoint in `config/teacher.yaml` is unreachable during dataset construction, the job fails with `status: failed` and an error naming the endpoint. Partial samples already generated are discarded and no `datasets` row is written.
6. When `max_samples` exceeds the number of available chunks and trajectories combined, the dataset is built from everything available and `sample_count` reflects the smaller actual number.
7. When a training run is submitted against a BaseModel with `trainable: false`, `POST /training/runs` returns HTTP 400 naming the model and the constraint.
8. When `LocalTrainingBackend` receives a non-smoke `base_model_id`, it rejects the config before allocating memory and returns an error naming the `smoke_test` constraint.
9. When the environment variable named by `api_key_env` is unset, `RemoteTrainingBackend.submit` fails immediately with an error naming the variable and never transmits the dataset.
10. When a remote training job exceeds `max_runtime_minutes`, `armada-forge` calls `cancel(handle)` and records `status: cancelled` with `error: "exceeded max_runtime_minutes"`.
11. When `armada-forge` restarts with training runs in `running` state, it re-attaches to remote runs using the persisted `backend_handle`. Local runs cannot be re-attached and are marked `failed` with `error: "local run interrupted by restart"`.
12. When two training runs targeting the same `base_model_id` and the same `corpus_name` succeed concurrently, `version` is assigned by a transactional increment on that pair so the two Adapters receive distinct versions and distinct ModelBinding tags. Two runs on the same `base_model_id` but different `corpus_name` values each start their own version sequence at 1 and do not collide, because `corpus_name` is part of the tag.
13. When GGUF conversion or quantization fails after a passing evaluation, the Adapter is set to `status: rejected` with the conversion error and no ModelBinding is registered.
14. When `armada-models` is unreachable at registration time, promotion fails, the Adapter is left `pending_eval`, and the operator can retry promotion via `POST /adapters/{adapter_id}/promote`.
15. When the daemon requests a ModelBinding tag that has been deleted from `armada-models` but is still `promoted` in the database, `GET /models/bindings` reports that binding with `status: missing`.
16. When a Corpus is deleted, its chunks are deleted, but Adapters trained from datasets derived from it are retained and keep serving; their `corpus_name` in the ModelBinding tag is unaffected.
17. When two Sources in the same Corpus produce byte-identical content at different `source_path` values, both chunk sets are retained because idempotency is keyed on the pair (`content_sha256`, `source_path`).
18. When an ingestion job is triggered while another is already running for the same Corpus, the second call returns HTTP 409 naming the in-flight `job_id`.
19. **Judge mode only.** When the teacher endpoint is unreachable during the evaluation gate, the Adapter is left at `status: pending_eval` with the error recorded on the `evaluations` row rather than being set to `rejected`, so the operator can retry via `POST /adapters/{adapter_id}/promote` once the teacher is reachable. An unreachable judge must never be read as a failing score. Mechanical mode cannot reach this state.
20. **Judge mode only.** When the judge returns an unparseable verdict for a sample, that sample is excluded from both `task_success_rate` denominators and counted in `judge_errors` on the `evaluations` row. When `judge_errors` exceeds half the evaluated samples, the gate aborts and the Adapter stays `pending_eval`.
21. When a dataset's held-out split contains zero samples because every sample had `origin: trajectory`, `POST /datasets/{dataset_id}/split` fails naming the constraint from Requirement 33. That dataset can still be used for a smoke run per Requirement 33a; it cannot be used for a run that would produce a promotable Adapter.
25. When `config/teacher.yaml` has `enabled: false` and a `POST /datasets` names a `corpus_id`, the request is rejected with HTTP 400 naming the two teacher-free sources. No outbound request is made, so a default installation with no credentials configured never attempts to reach an external endpoint.
26. When `config/eval.yaml` sets `mode: judge` while `config/teacher.yaml` has `enabled: false`, `armada-forge` fails startup naming both settings rather than deferring the failure to the first promotion attempt.
27. When a supplied JSONL line is missing `instruction` or `response`, or has either as an empty string, `POST /datasets/supplied` rejects the whole upload listing the offending line numbers and stores nothing.
28. When a smoke Adapter is created, the `evaluations` table receives no row for it — the rejection at Requirement 33b precedes evaluation entirely, so `judge_errors`, `samples_evaluated`, and the score sets are absent rather than zero.
29. When `LocalTrainingBackend` detects no CUDA device and the request names a `base_model_id` without `smoke_test: true`, the run is rejected naming both the model and the absent GPU. It is never silently downgraded to the smoke model, because a caller would otherwise believe it had trained the model it asked for.
30. When a CUDA device is added to the host and `armada-forge` restarts, `LocalTrainingBackend` switches to quality mode with no configuration change; previously recorded smoke runs keep `run_kind: smoke` and remain unpromotable.
31. When the gate runs in mechanical mode, `judge_errors` is 0 and `task_success_rate` is null in both score sets; promotion is decided on `held_out_perplexity` and `tool_call_validity` alone.
22. When `armada-models` already serves a tag matching a base ModelBinding at startup, that binding is not re-registered and startup proceeds; startup registration is idempotent.
23. When a BaseModel entry is removed from `config/base-models.yaml` while an Agent is still bound to its base tag, the binding is set to `status: retired` and `GET /models/bindings` reports it; Run start against a retired binding fails with the runtime's missing-binding error rather than silently serving a stale model.
24. When two Corpora are created whose `name` values differ only by case, the second is rejected by the `^[a-z0-9-]+$` constraint, so `corpus_name` in a ModelBinding tag is never ambiguous.

## Acceptance Criteria
- [ ] `docker compose up` starts `armada-forge` on a CPU-only host with no GPU present and no cloud credentials configured, and its healthcheck passes.
- [ ] Creating a Corpus with one git Source and ingesting it produces rows in `chunks` with non-null 384-dimension embeddings, and `GET /corpora/{corpus_id}` reports a non-zero chunk count.
- [ ] Re-running ingestion on an unchanged Source adds zero chunks and removes zero chunks.
- [ ] Deleting a file from a Source and re-ingesting removes exactly that file's chunks.
- [ ] A dataset built with `include_trajectories: false` from a corpus produces a JSONL file whose line count equals the recorded `sample_count`.
- [ ] `POST /training/runs` with `backend: local` and `base_model_id: qwen3-0.6b` completes on CPU and produces an `adapters` row.
- [ ] `POST /training/runs` with `backend: local` and `base_model_id: qwen3-4b-instruct` is rejected with an error naming the `smoke_test` constraint, and no training process starts.
- [ ] A smoke-run Adapter is set to `rejected` and is never registered with `armada-models`.
- [ ] An Adapter whose `task_success_rate` is below its BaseModel's is set to `rejected`, and both score sets are readable from the `evaluations` table.
- [ ] `POST /training/runs` against a dataset with no eval split is rejected with an error naming the missing split.
- [ ] A promoted Adapter appears in `GET /models/bindings` with a tag matching `armada/{base_model_id}-{corpus_name}-v{version}` and responds to a chat completion request through `armada-models`.
- [ ] Appending an entry with a missing required key to `config/base-models.yaml` causes `armada-forge` startup to exit non-zero with the offending `id` in the message.
- [ ] Grepping the repository for the remote provider API key value returns no matches; the credential is read only from the environment variable named by `api_key_env`.
- [ ] On a first-ever startup with an empty database, `GET /models/bindings` returns one `promoted` binding per `config/base-models.yaml` entry, each tagged `armada/{base_model_id}-base` with `adapter_id: null`. The `smoke_test` entry reports `materialized: true` and answers a chat completion through `armada-models`; every other entry reports `materialized: false`.
- [ ] A first-ever `docker compose up` transfers zero model bytes beyond container image pulls, verified by measuring egress after images are present.
- [ ] `POST /models/bindings/{tag}/materialize` against a host with less available memory than the entry's `min_ram_gb`, or less free disk than its `min_disk_gb`, is refused naming both the required and the observed value.
- [ ] Restarting `armada-forge` does not create duplicate base bindings.
- [ ] Removing a BaseModel entry from `config/base-models.yaml` and restarting sets its base binding to `status: retired`.
- [ ] `GET /corpora` returns each Corpus with its `name` and `chunk_count`, and is sufficient for `armada-daemon` to resolve a Corpus `name` to a `corpus_id`.
- [ ] Two Adapters trained on the same `base_model_id` from datasets of two different Corpora both receive `version: 1` and distinct ModelBinding tags.
- [ ] Splitting a dataset built with `include_trajectories: true` places zero `origin: trajectory` samples in `/data/datasets/{dataset_id}.eval.jsonl`.
- [ ] The evaluation gate issues at most `max_eval_samples` judge calls, and re-running the gate for the same `adapter_id` scores the identical sample subset.
- [ ] With the teacher endpoint unreachable, the evaluation gate leaves the Adapter at `pending_eval` and does not set it to `rejected`.
- [ ] `POST /adapters/{adapter_id}/promote` succeeds for an Adapter left `pending_eval` by a registration failure and returns HTTP 409 for one already `promoted`.
- [ ] **Zero-cost end to end:** on a fresh CPU-only installation with no `config/teacher.yaml` credentials and no network egress to any model provider, an operator can ingest a Corpus, upload a supplied JSONL, build a dataset, run a local smoke training run, and run an Agent against a real task with retrieval and sandboxed tools — with no outbound request to a paid endpoint at any step.
- [ ] With container images already pulled, running the full flow above with egress to external model providers blocked at the firewall produces no errors attributable to a blocked request.
- [ ] A `POST /datasets` naming a `corpus_id` with `teacher.enabled: false` returns HTTP 400 naming `supplied_file` and `include_trajectories`, and no outbound connection is attempted.
- [ ] A trajectory-only dataset is rejected by `POST /datasets/{dataset_id}/split` but is accepted by `POST /training/runs` with `backend: local` in smoke mode.
- [ ] A supplied JSONL with one malformed line is rejected in full, naming that line number, and `/data/supplied/` is unchanged.
- [ ] Samples with `origin: supplied` appear in `/data/datasets/{dataset_id}.eval.jsonl` after a split; samples with `origin: trajectory` do not.
- [ ] A smoke Adapter produces zero rows in `evaluations` and zero judge calls, verified by an unchanged teacher request count.
- [ ] With `mode: mechanical`, a promotion decision is reached with zero teacher calls, and `evaluations.mode` records `mechanical` with a null `task_success_rate`.
- [ ] A gate over a held-out set that emitted no tool calls records `tool_call_validity: null` — not `0` — and reaches a promotion decision on the remaining metrics rather than blocking or auto-passing on it.
- [ ] The dashboard's evaluation view states, for a passing mechanical gate, both that the scored artifact was unquantized and that the held-out set came from the training distribution.
- [ ] Setting `mode: judge` with `teacher.enabled: false` causes `armada-forge` startup to exit non-zero naming both settings.
- [ ] `LocalTrainingBackend` on a host with no CUDA device rejects `qwen3-4b-instruct` naming both the model and the absent GPU, and does not fall back to `qwen3-0.6b`.

## Key Files
- `services/forge/armada_forge/main.py` — new file, FastAPI app, route registration, startup validation of `config/base-models.yaml`
- `services/forge/armada_forge/ingest/sources.py` — new file, git/web/directory/upload fetchers
- `services/forge/armada_forge/ingest/extractor.py` — new file, per-filetype text extraction and extension filtering
- `services/forge/armada_forge/ingest/chunker.py` — new file, code-boundary and prose-boundary chunking strategies
- `services/forge/armada_forge/ingest/embedder.py` — new file, CPU bge-small embedding
- `services/forge/armada_forge/ingest/indexer.py` — new file, content-hash idempotent writes and deletions against `chunks`
- `services/forge/armada_forge/datasets/builder.py` — new file, dataset assembly, chat-template rendering, JSONL writing
- `services/forge/armada_forge/datasets/distill.py` — new file, teacher-model distillation and entailment filtering
- `services/forge/armada_forge/datasets/trajectory.py` — new file, flattens successful Runs from `events` into multi-turn samples
- `services/forge/armada_forge/datasets/supplied.py` — new file, operator-supplied JSONL upload, validation, and reading
- `services/forge/armada_forge/datasets/split.py` — new file, held-out eval split over `distilled` and `supplied` origins
- `services/forge/armada_forge/eval/mechanical.py` — new file, held-out perplexity and tool-call validity with no teacher dependency
- `services/forge/armada_forge/training/hardware.py` — new file, CUDA detection and smoke/quality mode selection
- `config/eval.yaml` — new file, gate `mode` selection (`mechanical` default)
- `services/forge/armada_forge/training/backend.py` — new file, abstract `TrainingBackend`, `TrainingConfig`, `JobStatus`
- `services/forge/armada_forge/training/local_backend.py` — new file, CPU LoRA SFT with smoke-only enforcement
- `services/forge/armada_forge/training/remote_backend.py` — new file, provider submission, webhook handling, artifact fetch
- `services/forge/armada_forge/registry/models.py` — new file, BaseModel shortlist loading and ModelBinding records
- `services/forge/armada_forge/registry/export.py` — new file, adapter merge, GGUF conversion, quantization, Ollama registration
- `services/forge/armada_forge/eval/gate.py` — new file, candidate-vs-baseline generation, judge invocation, promotion decision
- `services/forge/armada_forge/eval/judge.py` — new file, teacher-backed pass/fail judging with order randomisation and verdict parsing
- `services/forge/armada_forge/registry/base_bindings.py` — new file, startup registration and reconciliation of base ModelBindings
- `config/base-models.yaml` — new file, curated BaseModel shortlist
- `config/code-extensions.yaml` — new file, extensions treated as code for chunking
- `config/teacher.yaml` — new file, teacher model endpoint, `max_eval_samples`, distillation and judging parameters
- `config/eval-rubric.md` — new file, the pass/fail rubric text passed to the judge
- `config/training-remote.yaml` — new file, remote provider configuration
- `services/dashboard/src/pages/CorporaPage.tsx` — new file, Corpus and Source management, ingestion trigger and progress
- `services/dashboard/src/pages/TrainingPage.tsx` — new file, dataset construction, training run launch, live progress
- `services/dashboard/src/pages/ModelsPage.tsx` — new file, BaseModel shortlist, Adapter list, evaluation scores, manual promotion
- `db/migrations/001_init.sql` — new file, `vector` and `pg_trgm` extensions, shared enum types, migration bookkeeping table
- `db/migrations/002_corpora.sql` — new file, `corpora`, `sources`, `chunks`, `ingestion_jobs` tables and indexes
- `db/migrations/003_training.sql` — new file, `datasets`, `training_runs`, `adapters`, `evaluations`, `model_bindings` tables
- `services/forge/Dockerfile` — new file, CPU-only Python image
- `docker-compose.yml` — adds `armada-forge` and `armada-models` services
