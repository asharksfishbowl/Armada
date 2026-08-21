# Spec: Armada Build Plan

## Overview
This spec turns the five Armada specs into a buildable sequence. It carries three things no other spec owns: the deployment and provisioning requirements that belong to no feature, a defect list against the four implementable specs with the build phase each defect blocks, and a fifteen-phase decomposition with an explicit dependency order. It is the input to `build-queue.groovy`.

## Goals
- Order the build so that no phase depends on a phase after it, and every phase has a verifiable exit condition.
- Own the requirements that belong to deployment rather than to any feature: memory ceilings, model server configuration, host contracts, and model asset provisioning.
- Record every defect found in the four implementable specs during feasibility review, with its correction and the phase it blocks, without correcting any of them in place.
- Make the zero-external-spend constraint of `issue-queue.groovy` ISSUE #1 a testable property of a default installation rather than an aspiration.
- Surface the longest-running unknowns early and isolate the riskiest infrastructure so it fails alone.

## Non-Goals
- Restating, amending, or overriding any requirement in the four implementable specs. Corrections are recorded as defects against the owning spec and are discharged by re-running `/spec` on that spec.
- Design decisions. `specs/dashboard/design-dashboard.md` is locked and is consumed here, not revised.
- Task-level estimation, assignment, or scheduling in wall-clock time.
- The Colibri MoE backend. That is `issue-queue.groovy` ISSUE #2 and requires its own spec. Only its registry discriminator lands here, per Requirement 12.

## Definitions
- **Phase** — a numbered unit of the build with an explicit dependency set and an exit condition. Phases are ordered; a phase may not depend on a higher-numbered phase.
- **Upstream defect** — a fault in one of the four implementable specs, recorded here and corrected there. Never corrected in this document.
- **Build-time requirement** — a requirement owned by this spec because it concerns deployment, which no feature spec owns.
- **Materialized** — a ModelBinding whose underlying weights are present on the host and servable. A binding may be registered without being materialized.
- **Baked** — a model asset copied into a container image at image build time, so a running container needs no network to use it.

## Requirements

### Provisioning and the zero-egress claim

1. The claim that a default Armada installation performs no external transfer is stated precisely and testably in these terms: **after container images are pulled, a default installation transfers zero bytes from any model provider until the operator explicitly materializes a base model.** `docker compose up` pulls Postgres, Ollama, Node, and Python base images regardless; "zero external bytes" is not literally achievable and must not be claimed.
2. `bge-small-en-v1.5` (approximately 130 MB) is **baked** into the `armada-forge` image. Every ingestion requires it, it is fixed configuration because embedding-model fine-tuning is an explicit platform non-goal, and it is small enough to bake.
3. `qwen3-0.6b` is **baked** into a custom `armada-models` image built `FROM ollama/ollama` with the model pulled at image build time (approximately 400 MB quantized). It is the `smoke_test: true` model, so both the smoke training path and a first agent Run function with no network.
4. Every other entry in `config/base-models.yaml` is **lazily materialized**. Model & Training Pipeline R4a registers a base ModelBinding per shortlist entry at startup; registration writes the `model_bindings` row and sets `materialized: false`. The operator triggers materialization explicitly.
5. `model_bindings` carries a `materialized` boolean. `GET /models/bindings` returns it. Registration and materialization are separate acts, and a binding may be `promoted` and unmaterialized simultaneously.
6. A first `docker compose up` on a clean host downloads container images and nothing else. From that state the entire zero-cost path runs offline: ingest a Corpus, upload a JSONL, run a smoke training job, define an Agent against `armada/qwen3-0.6b-base`, and run it with retrieval and sandboxed tools.
7. `POST /api/runs` **fails fast** when the pinned `binding_tag` resolves to an unmaterialized binding, naming the tag and the required action. A Run must never block silently behind a multi-gigabyte download. This is the dashboard-visible half of upstream defect D4.

### Host capacity and resource ceilings

8. `config/base-models.yaml`'s `min_ram_gb` is enforced rather than decorative. Materialization is refused when the host's available memory is below the entry's `min_ram_gb`, naming both values.
9. `config/base-models.yaml` gains a `min_disk_gb` sibling to `min_ram_gb`, enforced identically at materialization. Disk is the binding constraint for any expert-streaming backend and for large quantized weights generally.
10. `docker-compose.yml` sets explicit memory limits on `armada-forge` and `armada-models`. A CPU training run and a concurrent ingestion embed contend on the same host, and the unbounded failure mode is an OOM kill with no attribution.
11. `docker-compose.yml` sets `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_NUM_PARALLEL` to explicit values consistent with `config/models.yaml`'s `max_concurrent_per_tag` and `max_concurrent_total`. Without them the daemon's scheduler limits are fiction, because Ollama will serialize or evict beneath them.

### Model registry backend discriminator

12. The model registry lands with a backend discriminator in Phase 2 even though only Ollama is implemented, because retrofitting a discriminator into a populated `model_bindings` table, a shipped config schema, and a live `GET /models/bindings` contract is materially more work than defaulting a field on an empty one. Four changes:
    1. `backend` on each `config/base-models.yaml` entry, one of `ollama` or `colibri`, defaulting to `ollama`.
    2. `ollama_tag` is renamed `serving_ref` and is interpreted by the named backend. This is a fix independent of Colibri: a serving-engine identifier had leaked into what is specified as a curated, engine-neutral model list.
    3. `backend` is added to the `GET /models/bindings` response. It is a logical name, **not** an endpoint URL; `config/models.yaml` maps backend to base URL, so no deployment-specific value is persisted to the database.
    4. Validation forces `trainable: false` on any entry whose `backend` is not `ollama`.
13. Requirement 12.4 is what keeps this change small. Model & Training Pipeline edge 7 already rejects `POST /training/runs` against a `trainable: false` model, so forcing the flag reuses an existing guard and requires no change to the promotion path, the evaluation gate, or the ModelBinding tag scheme.

### Sandbox host contract

14. The Docker socket mount into `armada-daemon` is stated as an explicit requirement rather than left implied by a Dockerfile. The daemon spawns sibling containers, which requires `/var/run/docker.sock` mounted into it, which is root-equivalent on the host. It violates no invariant — invariant 3 governs the sandbox boundary, and the platform scope is single-operator on a trusted network — but it is the highest-privilege decision in the deployment and must be visible.
15. Sandbox containers run non-root with dropped capabilities, no Docker socket, `/workspace` bind-mounted and `/armada` as tmpfs, and `network: none`. `egress_allowlist` is **not** available before Phase 14; see upstream defect D7.
16. Orphaned sandbox containers are labelled `armada.run_id` and swept on daemon startup by filtering on that label, satisfying Agent Runtime edge 13.

### Evaluation gate execution model

17. The evaluation gate runs **in-process inside `armada-forge`** using transformers and PEFT against the base weights plus the unmerged adapter. `armada-models` is not involved in either generation or scoring. This is the correction for upstream defect D6a and it simultaneously closes D6c, because teacher-forced perplexity scoring is not obtainable through Ollama by any route.
18. `armada-forge` already carries torch, transformers, and PEFT for `LocalTrainingBackend`, so Requirement 17 adds no dependency.
19. Requirement 17 is chosen over an eval-scoped registration exception because the alternative makes an unpromoted Adapter briefly servable to the whole daemon, which is the exact state Model & Training Pipeline R30 exists to forbid.
20. A limitation is recorded rather than fixed: in-process scoring evaluates the **unquantized** adapter, while what serves is merged, converted to GGUF, and quantized. Quantization can move perplexity by a non-trivial margin, so the gate judges an artifact that is not the shipped artifact. Closing this properly requires scoring the converted GGUF, which inverts the pipeline order. The order is not changed; the limitation is documented.

## Upstream Spec Defects

Each defect is corrected in its **owning spec** by re-running `/spec` on that spec. This document corrects none of them in place, because two conflicting statements of the same requirement with nothing declaring precedence is worse than a pointer that says fix it at the source. Each is a blocking precondition on the named phase, not one upfront batch — only D1 blocks Phase 0.

| ID | Owning spec | Defect | Correction | Blocks |
|---|---|---|---|---|
| **D1** | model-training-pipeline + platform-overview | The blocked-egress acceptance criterion is incompatible with R4a's acceptance criterion requiring all five shortlist models to answer a chat completion at startup — roughly 10–15 GB of first-boot pulls. | Adopt Requirements 1–6: bake two assets, materialize the rest lazily, and scope the egress claim to model-provider transfer after image pull. | **P0** |
| **D2** | agent-runtime | The `run_start` event payload is never enumerated. R57 specifies `run_end`'s payload; `run_start` appears only in edge 8. | A requirement specifying `run_start` carries `agent_version_id`, `binding_tag`, `mode`, `workspace_path`, effective budgets, and the fully-qualified tool list after `denied`. | **P3**, **P10** |
| **D3** | agent-runtime | Two host contracts are unstated or unimplementable. The Docker socket mount is implied rather than required. Edge 7 requires Run start to fail when `workspace_path` does not exist on the host, which a containerized daemon cannot verify by `stat` against a host path it has not mounted. | State the socket mount as a requirement (Requirement 14). Verify `workspace_path` either through a shared workspace root mounted into the daemon, or through Docker rather than the filesystem. | **P5** |
| **D4** | agent-runtime | R17/R18's liveness check verifies that a pinned `binding_tag` is present and `promoted`. A registered-but-unmaterialized binding passes that check and the Run then blocks behind a multi-gigabyte download. | Extend the liveness check to `materialized`, failing Run start per Requirement 7. | **P7** |
| **D5** | agent-runtime + team-orchestration | R21 specifies a request `"waits in a FIFO queue for that tag"`; Team Orchestration R32 admits manager requests `"at a higher priority than workers'"`. A priority queue is not FIFO. | Restate as **FIFO within priority class**. | **P8** |
| **D6** | model-training-pipeline | A cluster of six. **(a)** R34 requires generating from the candidate Adapter via `armada-models`, R30 forbids registering an unpromoted Adapter there, and R31 produces the GGUF only on promotion — a closed loop, present in both eval modes. **(b)** `tool_call_validity` has a 0/0 denominator on supplied-JSONL held-out samples, because no tool schemas are presented at generation time, yet R35 requires candidate ≥ baseline on it. **(c)** `held_out_perplexity` requires teacher-forced scoring of a supplied continuation, which Ollama does not expose by any route. **(d)** R24a caps `max_steps` at 20 and `max_samples` at 200 while leaving `batch_size` and `max_seq_len` uncapped; step cost is roughly linear in their product, so a caller can satisfy every stated cap and still turn a fifteen-minute smoke run into many hours. **(e)** Four acceptance criteria and edge 5 are judge-mode-only but carry no qualifier, and two acceptance criteria give opposite outcomes for `POST /training/runs` against a split-less dataset. **(f)** The edge case list runs 1–21, 25–31, 22, 23, 24. | **(a)** and **(c)**: Requirement 17 — the gate generates and scores in-process; `armada-models` is not involved. **(b)** `tool_call_validity` is null when its denominator is zero and is excluded from R35's comparison, which reduces the default mechanical gate to perplexity alone; R35 must say so rather than leave it emergent. **(d)** Cap `max_seq_len` and `batch_size` in R24a. **(e)** Add judge-mode qualifiers; R33a is the correct reading of the split conflict. **(f)** Renumber. | **P11** |
| **D7** | agent-runtime | `egress_allowlist` with `allowed_hosts` is specified as a sandbox profile field, but Docker has no per-container host allowlist primitive. Real implementations are a proxy sidecar on an internal network with outbound DNS blocked, or per-container firewall rules. It is a subsystem, not a config value. | Either specify the proxy subsystem, or defer explicitly with `network: none` as the only supported network mode before Phase 14. | **P14** |

A further limitation is recorded against **model-training-pipeline** without blocking any phase: the mechanical evaluation gate draws its held-out split from the same dataset the adapter trained on, so a non-degenerate LoRA will nearly always lower perplexity on its own training distribution. The gate satisfies the goal's letter — the adapter does measurably beat the baseline — but it is a smoke test for the gate rather than a quality bar, and the spec should say so plainly so that a mechanical pass is not read as evidence of adapter quality. Judge mode remains the real gate.

## Build Phases

Each phase names its dependencies, its contents, and its exit condition. No phase depends on a higher-numbered phase.

### P0 — Foundation
**Depends on:** nothing.
`docker-compose.yml` with all five services, `db/migrations/001_init.sql` with the pgvector extension, service skeletons, healthchecks, the memory limits of Requirement 10, the Ollama environment of Requirement 11, and the asset baking of Requirements 2 and 3.
**Blocked by:** D1.
**Exit:** `docker compose up` on a clean host brings all five services to healthy, `GET /api/health` returns 200, and the only network transfer is container image pulls.

### P1 — Corpus ingestion and index
**Depends on:** P0.
`db/migrations/002_corpora.sql`, the four Source types, extraction, chunking, `bge-small` embedding, per-chunk idempotency on `(content_sha256, source_path)`, the Corpus API, and seed corpora.
**Rationale for position:** the only spine item with no upstream dependency but P0, and the longest-running unknown in the build. It is surfaced early so its cost is known early.
**Exit:** ingesting one git Source produces `chunks` rows with non-null 384-dimension embeddings; re-ingesting unchanged adds and removes zero.

### P2 — Model registry and base bindings
**Depends on:** P0.
`db/migrations/003_models.sql`, shortlist validation, R4a base binding registration, R4b reconciliation, `GET /models/bindings`, the `materialized` field of Requirement 5, the capacity enforcement of Requirements 8 and 9, and the backend discriminator of Requirement 12.
**Rationale for position:** split out of ISSUE #1's Phase 1, which bundled it with ingestion. It is small — validating a YAML and inserting rows — and it is the only part of the training pipeline the agent path requires.
**Exit:** a first-ever startup registers one `promoted` binding per shortlist entry tagged `armada/{base_model_id}-base`, `qwen3-0.6b` reports `materialized: true` and answers a chat completion, and the other four report `materialized: false`.

### P3 — Kernel, gateway, and event log
**Depends on:** P0.
`db/migrations/004_runs_events.sql`, the plugin registry and the five plugin interfaces, the single-port HTTP and WebSocket listener, transactional gapless `seq`, ordered replay on subscribe, and credential redaction.
**Rationale for position:** invariant 5 lives here and is proven before anything writes to the log.
**Blocked by:** D2.
**Exit:** the process listens on exactly one port serving both `/api/*` and `/ws`; synthetic concurrent appends produce gapless `seq`; two subscribers receive identical ordered streams; grepping `events` for a configured credential returns nothing.

### P4 — Agent definition
**Depends on:** P1, P2, P3.
`db/migrations/005_agents.sql`, the closed schema, error-accumulating validation, reference resolution, the resolver and `resolved_snapshot`, versioning, `refresh-bindings`, the file loader, and both shipped examples.
**Exit:** both shipped examples load from `agents/` and validate on a fresh installation, each carrying the zero-chunk warning; a definition with three errors returns all three in one response.

### P5 — Sandbox and built-in tools
**Depends on:** P3.
Sibling container provisioning over the mounted socket, non-root with dropped capabilities, `network: none` only, `/workspace` bind and `/armada` tmpfs, the five built-in tools, oversize result spill, and orphan sweep.
**Rationale for position:** the riskiest infrastructure in the build, isolated so that it fails alone rather than inside the agent loop.
**Blocked by:** D3.
**Exit:** a sandbox shows `/` read-only and `/armada` writable as tmpfs; an oversize tool result is readable at its spill path; a killed daemon leaves no container labelled with a `run_id` after restart.

### P6 — Retrieval provider
**Depends on:** P1, P3.
Hybrid pgvector and full-text query, Reciprocal Rank Fusion, the `search_knowledge` tool, and the auto-injection block.
**Rationale for position — this is the correctness fix to ISSUE #1's ordering.** ISSUE #1 places retrieval at Phase 4 and the agent loop at Phase 2, but Agent Runtime R39 makes auto-injection part of the first Step of every Turn, so the loop cannot be completed or verified without retrieval. Retrieval must precede the loop.
**Exit:** a query against a populated Corpus returns fused results; a query against a zero-chunk Corpus returns an empty list and appends a `retrieval` Event.

### P7 — Agent loop
**Depends on:** P2, P4, P5, P6.
The context builder, compaction, the four budgets and the no-progress detector, outcome determination, the model adapter, and the scheduler.
**Rationale for position:** the MVP runtime slice closes here. This is the first phase in which the product does the thing it exists to do.
**Blocked by:** D4.
**Exit:** an Agent calling `finish(success: true)` records `success` and one calling `finish(success: false)` records `incomplete`; a Run with `max_steps: 3` records `budget_exhausted` naming `max_steps`; a Run against an unmaterialized binding fails at start naming the tag.

### P8 — Teams
**Depends on:** P7.
`db/migrations/006_teams.sql`, the team schema and roster resolution, the orchestrator, `delegate` and `list_workers`, child Run creation, tree budgets, synthesis, and scheduler priority.
**Rationale for position:** before the dashboard, so that `TeamsPage` and `TeamRunTree` have a runtime to render.
**Blocked by:** D5.
**Exit:** a Team Run produces child Runs with `parent_run_id` and `delegation_id` set; a tree budget exhaustion cancels in-flight children before the Team Run's `run_end`.

### P9 — Dashboard core
**Depends on:** P4, P7, P8.
The token module, the shell and health strip, the list-plus-drawer pattern, all five list pages, both editors, `AgentVersionHistory`, the run launcher, and `RunsPage`. Includes the bucket-A endpoints the design spec's dependency rulings define: `GET /training/runs`, `GET /adapters`, `GET /datasets`, `DELETE /corpora/{corpus_id}`, `DELETE /api/teams/{team_id}`, the `version` field on run rows, team-run identification on `GET /api/runs/{run_id}`, and `GET /api/config/capabilities`.
**Exit:** the automated token contrast test passes; the desaturation test passes per-family; a fresh installation renders the first-run states the design spec specifies.

### P10 — Run inspection
**Depends on:** P3, P8, P9.
`RunDetailPage`, the event stream and Step blocks, the minimap, filters and the fault-unfilterability guarantee, follow and detach, reconnect and the broken-log assertion, and `TeamRunTree`.
**Rationale for position:** the densest surface in the design spec, and it depends on P3's event shape being settled.
**Blocked by:** D2.
**Exit:** a 300-event run renders legibly with the single `is_error` result findable via the fault jump; an injected `seq` gap renders the non-dismissible banner; twelve collapsed children open zero sockets.

### P11 — Training and evaluation gate
**Depends on:** P1, P2, P9.
Dataset construction, supplied JSONL, the eval split, the `TrainingBackend` interface, `LocalTrainingBackend` with the corrected caps, the in-process evaluation gate of Requirement 17, export and promotion, `TrainingPage`, and the ModelsPage adapter table.
**Rationale for position — the rationale in ISSUE #1 is void and this is its replacement.** ISSUE #1 places training late because it is *"the only phase gated on external accounts."* That is no longer true: distillation defaults off, the gate defaults to mechanical, and neither contacts a paid endpoint. Training stays late for two different reasons that survive a GPU appearing tomorrow. First, it is a **leaf that unblocks nothing** — agents run on the base bindings P2 registers, with zero training having occurred. Second, trajectory datasets read `events` from successful Runs, which do not exist until P7 works.
**Blocked by:** D6.
**Exit:** a local run against a non-`smoke_test` model is rejected naming the constraint; a smoke-run Adapter is set `rejected` and never registered; the gate scores candidate and baseline with no request to `armada-models`.

### P12 — MCP
**Depends on:** P5, P7.
The `stdio` and `http` transports, server lifecycle, tool namespacing, `mcp_unavailable` handling, and credential redaction.
**Rationale for position:** absent from ISSUE #1's eight phases entirely. It is a substantial subsystem — two transports, a client, and a credential path — and it is not a footnote to the tool registry.
**Exit:** a failing MCP server at Run start appends `mcp_unavailable` and the Run continues without that server's tools.

### P13 — Code mode
**Depends on:** P5, P12.
SDK generation, in-sandbox program execution, result-file parsing, and downgrade handling.
**Rationale for position:** adjacent to P12 because Agent Runtime R28a — the `mode_downgraded` Event listing MCP tools excluded by Code mode — is the seam between them.
**Exit:** a Code-mode Run for an Agent granting MCP servers appends one `mode_downgraded` Event listing every excluded tool; a program that calls `finish` and crashes before writing its result file does not terminate the Run.

### P14 — Egress allowlist
**Depends on:** P5, P12.
The proxy subsystem, DNS control, and `allowed_hosts` enforcement.
**Rationale for position:** it stands alone because it is a subsystem rather than a profile field, and it is deliberately after MCP. MCP's `http` transport dispatches daemon-side and therefore does not depend on sandbox egress, so building it first proves invariant 3 holds before anything begins opening holes in the network policy.
**Blocked by:** D7.
**Exit:** a sandbox with an `egress_allowlist` profile reaches an allowed host and fails to reach any other, including by direct IP.

## Data Flow

**How a phase is discharged**
1. The phase's blocking defects, if any, are corrected in their owning specs by re-running `/spec` on each. No build task starts against a spec carrying a defect that blocks its phase.
2. The phase is decomposed into `build-queue.groovy` tasks whose dependency order is internal to the phase.
3. Tasks are implemented against the corrected owning spec, never against this document, except for the build-time requirements this document owns.
4. The phase's exit condition is verified against a running `docker compose` stack.
5. Later phases may begin only once every phase in their dependency set has met its exit condition.

**How the zero-egress claim is verified**
1. A clean host pulls container images.
2. Network egress to model providers is blocked at the firewall.
3. `docker compose up` brings all five services healthy.
4. A Corpus is ingested, a JSONL uploaded, a dataset built and split, a smoke training run executed, an Agent defined against `armada/qwen3-0.6b-base`, and a Run executed with retrieval and sandboxed tools.
5. No step produces an error attributable to a blocked request, because `bge-small` and `qwen3-0.6b` are baked and every other model is unmaterialized and unreferenced.

## Edge Cases
1. When the host has less memory than an entry's `min_ram_gb`, materialization is refused naming both values and the binding remains `materialized: false`.
2. When the host has less free disk than an entry's `min_disk_gb`, materialization is refused identically.
3. When a Run is started against a registered but unmaterialized binding, Run start fails naming the tag and the materialization action, and no sandbox is created.
4. When materialization is interrupted, the binding remains `materialized: false` and the operation is retryable; a partially transferred artifact is never reported as materialized.
5. When `config/base-models.yaml` names a `backend` other than `ollama` before ISSUE #2 is built, startup fails naming the unsupported backend rather than defaulting silently.
6. When an entry declares `backend: colibri`, validation forces `trainable: false`, and `POST /training/runs` against it is rejected by the existing non-trainable guard.
7. When `OLLAMA_MAX_LOADED_MODELS` is lower than `max_concurrent_total`, the daemon's scheduler admits requests that Ollama then serializes; the two values are checked for consistency at startup and a mismatch is logged naming both.
8. When `armada-forge` exceeds its Compose memory limit during a training run, the container is killed by the OOM killer and the training run is recorded `failed` with that cause, rather than the daemon reporting an unattributed loss of the service.
9. When a phase's blocking defect has not been corrected, its build tasks are not started; the queue entry names the defect id and its owning spec.
10. When a defect correction changes a requirement that an earlier completed phase already built against, the affected phase is re-verified against the corrected spec before dependent phases proceed.
11. When the evaluation gate runs, no request reaches `armada-models` from `armada-forge`; a gate that issues one is a defect, not a fallback.
12. When the mechanical gate's `tool_call_validity` denominator is zero, the metric is null and excluded from the promotion comparison, and the decision rests on perplexity alone.
13. When a smoke `TrainingConfig` requests a `batch_size` or `max_seq_len` above the smoke caps, the values are clamped and the clamp is recorded on the training run, so a smoke run's duration is bounded by the caps rather than by the caller.
14. When `egress_allowlist` appears in a sandbox profile before Phase 14, the profile is rejected at load naming the unsupported mode rather than silently running with `network: none`.
15. When the daemon starts without `/var/run/docker.sock` mounted, it fails at startup naming the missing mount rather than failing at the first Run.

## Acceptance Criteria
- [ ] `docker compose up` on a clean host with model-provider egress blocked at the firewall brings all five services healthy, and the only observed transfer is container image pulls.
- [ ] With egress still blocked, the full zero-cost path completes: ingest a Corpus, upload a JSONL, split a dataset, run a smoke training job, define an Agent against `armada/qwen3-0.6b-base`, and complete a Run with retrieval and a sandboxed tool call.
- [ ] `GET /models/bindings` on a first-ever startup returns one `promoted` binding per shortlist entry, with `qwen3-0.6b` reporting `materialized: true` and every other entry reporting `materialized: false`.
- [ ] `POST /api/runs` against an unmaterialized binding fails naming the tag, and `docker ps` shows no container was created.
- [ ] Materialization against a host below an entry's `min_ram_gb` or `min_disk_gb` is refused naming both the requirement and the observed value.
- [ ] `GET /models/bindings` returns a `backend` field, `config/base-models.yaml` uses `serving_ref` rather than `ollama_tag`, and no endpoint URL is persisted to `model_bindings`.
- [ ] An entry with a non-`ollama` `backend` is forced `trainable: false`, and `POST /training/runs` against it is rejected by the pre-existing non-trainable guard with no new code path.
- [ ] `armada-forge` completes an evaluation gate with `armada-models` stopped, proving the gate makes no request to it.
- [ ] A smoke `TrainingConfig` requesting `batch_size: 8, max_seq_len: 4096` is clamped, and the resulting run completes within the same order of magnitude as one requesting the defaults.
- [ ] `docker-compose.yml` declares memory limits for `armada-forge` and `armada-models`, and explicit `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_NUM_PARALLEL` values consistent with `config/models.yaml`.
- [ ] Starting `armada-daemon` without the Docker socket mounted fails at startup naming the mount, not at the first Run.
- [ ] A sandbox profile declaring `egress_allowlist` is rejected at load before Phase 14 rather than running as `network: none`.
- [ ] Every phase in the decomposition depends only on lower-numbered phases, verified by inspection of the dependency sets.
- [ ] Phase 6 completes and is verified before Phase 7 begins, so that the agent loop is never built against an absent retrieval provider.
- [ ] Every defect in the Upstream Spec Defects table names an owning spec, a correction, and a blocking phase, and no build task for a blocked phase is queued before that defect is corrected in its owning spec.
- [ ] This document contains no restatement of any requirement from the four implementable specs; every correction is a pointer to the owning spec.

## Key Files
- `docker-compose.yml` — new file, five services, memory limits, Ollama concurrency environment, Docker socket mount on `armada-daemon`
- `services/models/Dockerfile` — new file, `FROM ollama/ollama` with `qwen3-0.6b` pulled at image build time
- `services/forge/Dockerfile` — new file, bakes `bge-small-en-v1.5` into the image
- `config/base-models.yaml` — new file, shortlist with `backend`, `serving_ref`, `trainable`, `min_ram_gb`, `min_disk_gb`
- `config/models.yaml` — new file, per-backend base URLs and concurrency limits
- `services/forge/armada_forge/models/registry.py` — new file, base binding registration, reconciliation, `materialized` state, capacity enforcement
- `services/forge/armada_forge/models/materialize.py` — new file, operator-triggered model materialization with capacity refusal and retry
- `services/forge/armada_forge/eval/gate.py` — new file, in-process candidate and baseline generation and scoring, no `armada-models` dependency
- `services/forge/armada_forge/eval/mechanical.py` — new file, in-process perplexity and null-safe `tool_call_validity`
- `services/forge/armada_forge/training/local_backend.py` — new file, CPU LoRA SFT with clamped `max_steps`, `max_samples`, `batch_size`, and `max_seq_len`
- `services/daemon/src/models/scheduler.ts` — new file, per-backend concurrency limits read from the binding's `backend`, FIFO within priority class
- `services/daemon/src/runtime/liveness.ts` — new file, pinned-binding check extended to `materialized`
- `db/migrations/001_init.sql` — new file, pgvector extension and shared types
- `db/migrations/003_models.sql` — new file, `model_bindings` including `backend` and `materialized`
- `build-queue.groovy` — existing file, receives the phase decomposition as dependency-ordered tasks
