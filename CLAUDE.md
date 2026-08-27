# Armada

Self-hosted platform for producing domain-specialized small language models (SLMs) and pairing each one with a purpose-built, tool-using agent. Specialization arrives through two independent channels: a **retrieval corpus** carries domain *knowledge*, an optional **LoRA adapter** carries domain *behavior*. Agents compose into teams where a manager delegates to specialist workers.

Single-operator, trusted-network, one host. Target hardware is **CPU-only** — no service may require a GPU to start.

## Current State — 7 of 15 phases built

**This is no longer greenfield.** `main` carries real, tested application code. Paths below mostly exist; check the tree rather than assuming either way.

| | |
|---|---|
| **Built** | P0 Compose/schema/skeletons · P1 Ingestion + Corpus API · P2 Model registry + base bindings · P3 Daemon kernel/gateway/event log · P4 Agent definition · P5 Sandbox + built-in tools · P6 Retrieval |
| **Remaining** | P7 Agent loop · P8 Teams · P9 Dashboard core · P10 Run inspection · P11 Training + eval gate · P12 MCP · P13 Code mode · P14 Egress allowlist |
| **Code** | `services/daemon/src` ~37 files · `services/forge/armada_forge` ~28 files · 6 migrations · `services/dashboard/src` is empty until P9 |
| **Tests** | `pytest` (forge) and `npm test` (daemon) both wired and green |

The build plan is `specs/build-plan/build-plan.md` (P0–P14). It **governs** — it is an audited spec and outranks any working note, per the Director ruling that re-cut the queue to its phase boundaries. `build-queue.groovy` holds the live task for each remaining phase.

### Two rules that exist because they were violated

**Tests land with the phase.** A phase is not done without them. This became a rule after the framework was chosen but the per-task acceptance criteria were never added — leaving the rule stated everywhere and enforced nowhere.

**A requirement enforced nowhere is decorative.** This repo has produced the same defect three times: `min_ram_gb` read by nothing, `min_disk_gb` unknown to the schema so its guard could not fire, and the test rule absent from every task. When you add a constraint, add the thing that fails when it is violated.

## Specs

`specs/platform-overview/platform-overview.md` is the anchor — shared vocabulary, service topology, spec boundaries. It is **not implementable on its own**; every requirement lives in one of the four implementable specs:

| Spec | Owns |
|---|---|
| `specs/model-training-pipeline/` | Corpus ingestion, indexing, dataset construction, training backends, model registry, evaluation gates |
| `specs/agent-runtime/` | Plugin kernel, agent loop, tool registry, sandboxing, MCP, retrieval query, event log, context management |
| `specs/agent-definition/` | Declarative agent format, persona, model/corpus/tool binding, validation, versioning, dashboard CRUD |
| `specs/team-orchestration/` | Manager/worker delegation, capability matching, model scheduling, run lifecycle, synthesis, termination |

`specs/dashboard/design-dashboard.md` is a **design** spec — tokens, motion, status vocabulary, per-surface layout. It constrains what the UI looks like, never how the React code is structured or which endpoints exist.

Read the owning spec before touching an area. Requirements are numbered and referenced by number across specs (e.g. "Agent Runtime R25", "Training Pipeline Requirement 37").

## Services

All five run under one `docker-compose.yml`.

| Service | Language | Responsibility |
|---|---|---|
| `armada-daemon` | TypeScript | Gateway (HTTP + WS on **one** port), plugin kernel, agent loop, tool dispatch, sandbox provisioning, team orchestration, event log writer |
| `armada-forge` | Python | Corpus ingestion, chunking, embedding, dataset construction, training dispatch, model registry, evaluation |
| `armada-dashboard` | TypeScript/React | Web UI — corpora, training runs, agents, teams, live run inspection |
| `armada-db` | Postgres + pgvector | Relational state and vector index in one store |
| `armada-models` | Ollama | OpenAI-compatible inference endpoint serving all registered ModelBindings |

Planned layout: `services/daemon/`, `services/forge/`, `services/dashboard/`, `db/migrations/`, `config/`, `agents/`, `teams/`.

## Core Entities

Used identically across all specs. **Any spec or code that redefines one is in error.**

**Corpus** — named collection of ingested Sources, chunked and embedded. Carries knowledge.
**Source** — one ingestion input in a Corpus: git repo, docs URL, local dir, uploaded file.
**BaseModel** — entry in the curated shortlist (`config/base-models.yaml`).
**Adapter** — LoRA adapter from a training run, versioned, attached to exactly one BaseModel. Carries behavior.
**ModelBinding** — resolved (BaseModel, Adapter-or-none) pair, registered with the model server under a unique tag.
**Agent** — declarative binding of persona + ModelBinding + tool grants + optional Corpus + runtime mode.
**Team** — one manager Agent, one or more workers, plus delegation limits.
**Run** — one execution of an Agent or Team. Produces an ordered event stream and a terminal outcome.
**Event** — append-only record within a Run. Unit of observability, raw material for trajectory datasets.
**Sandbox** — per-Run Docker container providing filesystem and shell for built-in tools.

## Cross-Cutting Invariants

These hold across every spec. Changing one is a change to all four.

1. **Success is self-reported.** Only an explicit `finish(success: true)` yields outcome `success`. Everything else terminates `incomplete`, `failed`, `cancelled`, `budget_exhausted`, or `no_progress`. No component ever infers success from termination.
2. **References are pinned, never live.** Agent/Team versions capture a resolved snapshot; runtime does liveness checks only. Adopting a newer Adapter is an explicit `refresh-bindings` call.
3. **The sandbox boundary is one-directional.** The daemon reaches in; nothing in a sandbox calls back out. This is why Code mode is restricted to sandbox-local tools.
4. **Corpora are referenced by `name`, models by `base_model_id`, both immutable.** No definition file contains a generated uuid.
5. **Events are append-only and gapless per Run.** No code path updates or deletes an Event.
6. **Every Run terminates.** Four budgets plus a no-progress detector, checked before each Step and each tool dispatch.

## Cross-Service Boundaries

The seams that leak most often. Binding.

1. **Ingestion vs. retrieval** — forge *writes* chunks/embeddings; daemon *queries* them at agent time. The daemon never writes the vector index; the forge never serves a retrieval query.
2. **Training vs. serving** — forge produces Adapters and registers ModelBindings; daemon only consumes them by tag over the OpenAI-compatible API.
3. **Trajectories** — daemon writes Events, forge reads Events to build datasets. The only path from agent behavior back into training, and it is one-directional.
4. **Definitions** — Agent Definition owns schema and validation; Agent Runtime *executes* a validated Agent and must not reinterpret or extend the schema.

## The MVP Costs Nothing to Run

No step on the MVP path contacts a paid endpoint. A default install is fully functional with no accounts, no credentials, no egress: local CPU embedding (`bge-small`), pgvector + full-text + RRF retrieval, base ModelBindings via Ollama, distillation off (`config/teacher.yaml`), `LocalTrainingBackend` in smoke mode, `mechanical` eval gate.

Preserve this. A change that makes the default path require a key or a GPU is a regression, not a feature. Smoke runs are never promotable by design — on the free path, specialization comes entirely from Corpus, persona, and tool grants.

## Non-Goals

- No messaging-channel gateway (Slack/Telegram/Discord). The dashboard is the only v1 interface.
- No multi-tenant auth, user accounts, or RBAC.
- No GPU-required code path in any default configuration.
- No pretraining or full-parameter fine-tuning. LoRA only.
- No agent-to-agent communication outside manager/worker delegation.
- No hosted/SaaS deployment. Compose on one host.
- Dashboard: no light theme, no mobile/tablet layouts (desktop ≥1280px).

## Licensing — proprietary

Armada is **proprietary, all rights reserved** (`LICENSE`). Sole proprietor, sole users.
The GitHub repository is **public**, which is deliberate and not a license — readability
grants no right to use, copy, modify, or distribute.

Constraints that follow, and that any change must respect:

- **Never add a GPL or AGPL dependency.** AGPL in particular is incompatible with keeping
  a network-served Armada proprietary. Permissive (MIT/BSD/Apache 2.0) only.
- **`psycopg` is LGPL-3.0** — the one copyleft dependency. Fine as used (imported at
  runtime, user-replaceable). Do not vendor, fork, or patch it.
- **Check a base model's license before adding it to `config/base-models.yaml`.**
  Apache 2.0 / MIT is fine. A custom license needs its naming, attribution, and
  downstream-terms clauses read and recorded in `THIRD_PARTY_NOTICES.md` first.
- **Two shipped base models are not open source.** Llama 3.2 requires "Built with Llama"
  attribution and that a distributed derivative's name *begin with* "Llama" — which
  Armada's `armada/{base_model_id}-{corpus}-v{n}` tag scheme does not satisfy. Gemma 3
  carries use restrictions and downstream terms pass-through. **Both obligations attach on
  distribution only**, so neither is live while Armada is single-operator and self-hosted.
- **Prior art is reimplemented, not vendored.** DeepSeek Harness and OpenClaw contributed
  architecture only. No code, therefore no attribution obligation.

Update `THIRD_PARTY_NOTICES.md` whenever a dependency or base model is added.
Full reasoning: `docs/Licensing.md`.

## Tooling

The specs deliberately do not pin build tooling, test frameworks, or linters ("those
belong to the implementation spec"). Decisions made so far, recorded as they were forced
by an actual task — **do not invent the ones still marked undecided**; raise them through
the pipeline when a task first needs one.

| Area | Decision | Forced by |
|---|---|---|
| `armada-forge` | Python 3.12, FastAPI + uvicorn, psycopg 3 with a connection pool | Phase 0/1 |
| Embedding | `sentence-transformers`, CPU torch wheel, weights baked into the image, `HF_HUB_OFFLINE=1` | Phase 1 (roadmap F7) |
| `armada-daemon` | Node 22, TypeScript strict, `node:http` (no framework yet), `pg` | Phase 0 |
| `armada-db` | `pgvector/pgvector:pg16`; `gen_random_uuid()` from core, not `uuid-ossp` | Phase 0 |
| Migrations | Plain SQL under `db/migrations/`, applied by `db/apply-migrations.sh`, tracked in `schema_migrations` | Phase 0 |
| `armada-dashboard` | **Undecided.** Phase 0 ships an nginx static placeholder precisely so Phase 8 can pick the bundler and state library | — |
| Test framework | forge → `pytest` (`requirements-dev.txt`); daemon → **`node:test`** via `node --test`, built into Node 22 — no new dependency. **Every phase lands its own tests before it is marked done.** | Rule 9 / ISSUE #7 |
| Test execution | Manual via `scripts/smoke-test.sh` on a Docker host now; **GitHub Actions CI after P7**, once the agent loop exists and the end-to-end path is stable enough to guard | ISSUE #7 |
| Linter / formatter | **Undecided** for both services | — |

### Conventions that are already load-bearing

- **Config validation happens at startup, never at first use.** `armada_forge/config.py`
  collects *every* fault and exits non-zero listing all of them. Two acceptance criteria
  depend on this. A misconfiguration that surfaces at first promotion surfaces after a
  training run has already been paid for.
- **Credentials are environment-variable NAMES in config files, never values.** Fields are
  suffixed `_api_key_env`. Nothing reads a secret from a file in this repo.
- **Migrations are transactional and self-recording.** Each wraps itself in `BEGIN/COMMIT`
  and ends with `INSERT INTO schema_migrations`. `apply-migrations.sh` refuses to run a
  file whose recorded version disagrees with its filename — that skew would silently
  re-apply a migration on every boot.
- **Tests land with the phase — a phase with no tests is not done.** `pytest` from
  `services/forge`, `npm test` from `services/daemon`. Both exit non-zero on failure.
  Unit tests must not need Docker, Postgres, or armada-models; anything that does is
  marked `@pytest.mark.integration` (forge) or noted and left out (daemon), so units can
  run on every push.
- **Daemon tests COMPILE before running** (`tsc && node --test "dist/__tests__/*.test.js"`).
  Node 22 can run `.ts` directly via type stripping, but strip-only mode rejects
  TypeScript *parameter properties* (`constructor(private readonly x: T)`), which this
  codebase uses in eight files. Compiling first also type-checks the tests. Do not switch
  to running `.ts` directly without removing those first.
- **`console.log` in TypeScript must follow the repo's debug format** (a hook enforces it):
  blank line, `// DEBUG`, `console.log('🚀 LABEL:', { data })`, blank line. Only certain
  emoji are accepted.

## Pipeline Conventions

Armada is a **web/multi-service project**, not an Expo/React Native app. For the Dex Builder workflow this means:

- Direct `git checkout -b` in the main repo — no `/tmp/worktree-builder-*` worktree, no test lane, no `logs.groovy`.
- Stay on the feature branch after pushing; do not switch back to `main`.
- Open a GitHub PR against `main` after push (`gh pr create`). Remote is `asharksfishbowl/Armada`.
- Task hub reporting is optional — skip if the hub server isn't running.

Branch prefixes: `feature/`, `fix/`, `refactor/`, `chore/`, `debug/`. Never merge to `main` — the user decides.

Queue files (`issue-queue.groovy`, `build-queue.groovy`, `question-queue.groovy`, `question-answers.groovy`), `research/`, and `transcripts/` are gitignored and per-user.
