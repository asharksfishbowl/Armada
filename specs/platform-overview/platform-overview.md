# Spec: Armada Platform Overview

## Overview
Armada is a self-hosted platform for producing domain-specialized small language models (SLMs) and pairing each one with a purpose-built agent that can use tools. Specialization arrives through two independent channels: a retrieval corpus carries domain *knowledge*, and an optional LoRA adapter carries domain *behavior*. Agents can be composed into teams where a manager agent delegates subtasks to specialist workers.

This document is **not implementable on its own**. It defines shared vocabulary, the service topology, and the boundaries between the four implementable specs. Every requirement lives in one of those four.

## The Four Specs

| Spec | Owns | Path |
|---|---|---|
| Model & Training Pipeline | Corpus ingestion, indexing, dataset construction, training backends, model registry, evaluation gates | `specs/model-training-pipeline/model-training-pipeline.md` |
| Agent Runtime | Plugin kernel, agent loop, tool registry, sandboxing, MCP, retrieval query, event log, context management | `specs/agent-runtime/agent-runtime.md` |
| Agent Definition | Declarative agent format, persona, model/corpus/tool binding, validation, versioning, dashboard CRUD | `specs/agent-definition/agent-definition.md` |
| Team Orchestration | Manager/worker delegation, capability matching, model scheduling, run lifecycle, synthesis, termination | `specs/team-orchestration/team-orchestration.md` |

## Prior Art and What Armada Borrows

Armada implements its own runtime. It does not depend on either project below.

- **DeepSeek Harness** (`@deepseek-ai/dsh`, MIT) — a micro-kernel agent runtime on the Cordis meta-framework where every runtime component is a swappable plugin (model adapters, tool registries, sandboxes, session handlers, event dispatchers, UIs). Ships Standard / Code / Minimal / Creator modes and an append-only event log recording every message, tool invocation, reasoning state, token metric, and sub-agent dispatch. **Armada borrows:** the micro-kernel plugin decomposition, the Standard-vs-Code tool-calling split, and the append-only event log as a first-class artifact.
- **OpenClaw** (formerly Clawdbot/Moltbot) — a persistent background agent service whose central Gateway process multiplexes WebSocket and HTTP on a single port and owns session lifecycle, tool dispatch, channel routing, and agent orchestration; model-agnostic across hosted APIs, Ollama, and any OpenAI-compatible endpoint. **Armada borrows:** the single-port gateway daemon shape and the model-agnostic adapter boundary.

**Rationale for reimplementing:** DeepSeek Harness is in active preview and its extension contracts and schemas are documented as subject to breaking changes. Armada takes the architecture and accepts the build cost rather than the churn.

## Core Entities

These nouns are used identically across all four specs. Any spec that redefines one is in error.

| Entity | Definition | Owning spec |
|---|---|---|
| **Corpus** | A named collection of ingested sources, chunked and embedded into the vector store. Carries domain knowledge. | Training Pipeline |
| **Source** | One ingestion input belonging to a Corpus: a git repo, a docs URL, a local directory, or an uploaded file. | Training Pipeline |
| **BaseModel** | An entry in the curated shortlist (`config/base-models.yaml`) describing a pretrained SLM and its serving/training configuration. | Training Pipeline |
| **Adapter** | A LoRA adapter produced by a training run, versioned, attached to exactly one BaseModel. Carries domain behavior. | Training Pipeline |
| **ModelBinding** | The resolved pair (BaseModel, Adapter or none) that an Agent runs against, registered with the model server under a unique tag. | Training Pipeline |
| **Agent** | A declarative definition binding a persona, a ModelBinding, a tool grant list, an optional Corpus, and a runtime mode. | Agent Definition |
| **Team** | A declarative definition naming one manager Agent and one or more worker Agents, plus delegation limits. | Team Orchestration |
| **Run** | One execution of an Agent or Team against a task. Produces an ordered event stream and a terminal outcome. Only an agent's explicit `finish(success: true)` self-report yields outcome `success`; everything else terminates `incomplete`, `failed`, `cancelled`, `budget_exhausted`, or `no_progress`. | Agent Runtime |
| **Event** | An append-only record within a Run. The unit of observability and the raw material for trajectory datasets. | Agent Runtime |
| **Sandbox** | A per-Run Docker container providing the filesystem and shell that an Agent's built-in tools operate on. | Agent Runtime |

## Service Topology

All services run under one `docker-compose.yml`. Target hardware is **CPU-only** — no service may require a GPU to start.

| Service | Language | Responsibility |
|---|---|---|
| `armada-daemon` | TypeScript | Gateway (HTTP + WS on one port), plugin kernel, agent loop, tool dispatch, sandbox provisioning, team orchestration, event log writer |
| `armada-forge` | Python | Corpus ingestion, chunking, embedding, dataset construction, training backend dispatch, model registry, evaluation |
| `armada-dashboard` | TypeScript/React | Web UI for corpora, training runs, agents, teams, and live run inspection |
| `armada-db` | Postgres + pgvector | Relational state (agents, teams, runs, events) and vector index in one store |
| `armada-models` | Ollama | OpenAI-compatible inference endpoint serving all registered ModelBindings |

## Cross-Service Boundaries

These are the seams that most often leak between specs. They are binding.

1. **Ingestion vs. retrieval.** `armada-forge` owns writing chunks and embeddings into `armada-db`. `armada-daemon` owns *querying* them at agent time. The daemon never writes to the vector index; the forge never serves a retrieval query to an agent.
2. **Training vs. serving.** `armada-forge` produces Adapters and registers ModelBindings with `armada-models`. `armada-daemon` only ever consumes ModelBindings by tag through the OpenAI-compatible API.
3. **Trajectories.** `armada-daemon` writes Events. `armada-forge` reads Events to build trajectory datasets. This is the only path by which agent behavior feeds back into training, and it is one-directional.
4. **Definitions.** The Agent Definition spec owns the schema and validation of an Agent. The Agent Runtime spec owns *executing* a validated Agent and must not reinterpret or extend the schema.

## MVP Vertical Slice

The one path that must work end to end before anything else is built:

1. Create a Corpus, add a git repo Source, ingest it.
2. Upload an operator-supplied JSONL and build a dataset from it (optionally plus captured trajectories).
3. Run a local smoke training run, proving the pipeline executes end to end.
4. Define an Agent binding a **base** ModelBinding (`adapter: none`), the Corpus, and a sandboxed toolset.
5. Run that Agent against a real task in a sandbox and observe the full event stream in the dashboard.
6. Compose that Agent into a Team and run a manager-delegated task.

Every requirement in the four specs is either on this path or explicitly marked post-MVP.

### The MVP costs nothing to run

**No step on that path contacts a paid endpoint.** This is a deliberate constraint, not an accident of sequencing — a default installation is fully functional with no accounts, no credentials, and no egress to any model provider:

| Concern | Default | Cost |
|---|---|---|
| Ingestion, chunking, embedding (`bge-small`) | Local, CPU | none |
| Retrieval (pgvector + full-text + RRF) | Local | none |
| Agent and Team runs | Base ModelBindings via Ollama | none |
| Dataset construction | `supplied_file` and/or trajectories | none |
| Distillation (`config/teacher.yaml`) | `enabled: false` | none |
| Training (`LocalTrainingBackend`) | Smoke mode — CPU, `qwen3-0.6b`, 20 steps | none |
| Evaluation gate (`config/eval.yaml`) | `mode: mechanical` — perplexity + tool-call validity | none |

### What the free path does not give you

**Promoted Adapters.** Smoke runs are never promotable by design (Training Pipeline Requirement 37) — a 0.6B model at 20 steps is a pipeline proof, not a model worth serving. On the zero-cost path, specialization comes entirely from the **Corpus, persona, and tool grants**, with every Agent bound to a base model. The behavior half of the RAG/fine-tuning split is built and exercised, but produces nothing servable until one of two things changes.

### Two upgrade paths, neither requiring a rewrite

- **Add a GPU to the host.** `LocalTrainingBackend` detects CUDA at startup and switches to quality mode — uncapped steps, any `trainable` model, promotable Adapters. No configuration change, no account, no spend.
- **Add a teacher budget.** Set `teacher.enabled: true` to unlock corpus distillation, and optionally `eval.mode: judge` for a stronger promotion gate. `RemoteTrainingBackend` becomes available for quality runs without local hardware.

Both are config-level changes against specs that already describe them. Nothing on the free path has to be rebuilt.

## Cross-Cutting Invariants

Rules that hold across every spec. A change to any one of these is a change to all four.

1. **Success is self-reported.** No component infers task success from termination. See Agent Runtime Requirements 25–25b.
2. **References are pinned, never live.** Agent and Team versions capture a resolved snapshot; runtime performs liveness checks only. Adopting a newer Adapter is an explicit `refresh-bindings` call.
3. **The sandbox boundary is one-directional.** The daemon reaches into a sandbox; nothing in a sandbox calls back out. This is why Code mode is restricted to sandbox-local tools.
4. **Corpora are referenced by `name`, models by `base_model_id`, both immutable.** No definition file contains a generated uuid.
5. **Events are append-only and gapless per Run.** No code path updates or deletes an Event.
6. **Every Run terminates.** Four budgets plus a no-progress detector, checked before each Step and each tool dispatch.

## Platform-Wide Non-Goals

- No messaging-channel gateway (Slack, Telegram, Discord, WhatsApp). The dashboard is the only interface for v1.
- No multi-tenant auth, user accounts, or RBAC. Armada is single-operator, trusted-network.
- No GPU-required code path in any service's default configuration.
- No pretraining or full-parameter fine-tuning. LoRA adapters only.
- No agent-to-agent communication outside the manager/worker delegation defined in Team Orchestration.
- No hosted/SaaS deployment story. Compose on one host only.

## Key Files
- `docker-compose.yml` — new file, defines the five services, healthchecks, and the shared network
- `config/base-models.yaml` — new file, curated BaseModel shortlist with serving and training configuration
- `specs/model-training-pipeline/model-training-pipeline.md` — spec, corpus and model production
- `specs/agent-runtime/agent-runtime.md` — spec, execution kernel
- `specs/agent-definition/agent-definition.md` — spec, agent declaration format
- `specs/team-orchestration/team-orchestration.md` — spec, multi-agent delegation
