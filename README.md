# Armada

Self-hosted platform for producing domain-specialized small language models and pairing each one with a purpose-built, tool-using agent.

Specialization arrives through two independent channels: a **retrieval corpus** carries domain *knowledge*, and an optional **LoRA adapter** carries domain *behavior*. Agents compose into **teams** where a manager delegates to specialist workers.

The same machinery runs a frontend engineer and a chef. Only the declaration differs.

```yaml
# agents/chef.yaml
name: chef
persona:
  system_prompt: You are a recipe developer...
model:
  base_model_id: qwen3-4b-instruct
  adapter: none
corpus:
  name: recipes
tools:
  builtin: [read_file, write_file]
sandbox:
  profile: minimal
capabilities: [cooking, recipes, nutrition]
```

---

## It costs nothing to run

**No step on the default path contacts a paid endpoint.** A fresh install is fully functional with no accounts, no credentials, and no egress to any model provider. This is a platform invariant enforced by four defaults, not a trial tier:

| Setting | Default | Effect |
|---|---|---|
| `config/teacher.yaml` → `enabled` | `false` | Corpus distillation is opt-in. No outbound request is made while off. |
| `config/eval.yaml` → `mode` | `mechanical` | Promotion gated on perplexity + tool-call validity. No judge calls. |
| `LocalTrainingBackend` | smoke mode | CPU, `qwen3-0.6b`, 20 steps. |
| Agent `model.adapter` | `none` | Base ModelBindings served locally. |

`docker compose up` on a fresh host transfers **zero model bytes** — registering a binding writes a record; materializing one is a separate, explicit act. You choose what to pull, when.

**What the free path does not give you: promoted adapters.** Smoke runs are unpromotable by design — 0.6B at 20 steps proves the pipeline executes, it does not produce a model worth serving. Specialization comes entirely from corpus, persona, and tool grants until one of two things changes, neither a rewrite:

- **Add a GPU.** `LocalTrainingBackend` detects CUDA at startup and switches to quality mode. No config change, no account, no spend.
- **Add a teacher budget.** Set `teacher.enabled: true` to unlock corpus distillation, and optionally `eval.mode: judge` for a stronger gate.

---

## Quickstart

```sh
git clone https://github.com/asharksfishbowl/Armada
cd Armada
docker compose up
```

Dashboard at <http://localhost:3000>. Full walkthrough: **[Getting Started](docs/getting-started.md)**.

Requirements: Docker with Compose v2, **CPU only**, ~20 GB disk, 8 GB RAM minimum.

> **Armada is single-operator, trusted-network, one host.** No authentication, no multi-tenancy, no hosted deployment. Those are platform-wide non-goals, not missing features. Do not expose it to an untrusted network.

---

## Architecture

Five services under one `docker-compose.yml`. No service requires a GPU to start.

| Service | Language | Responsibility |
|---|---|---|
| `armada-daemon` | TypeScript | Gateway (HTTP + WS on one port), plugin kernel, agent loop, tool dispatch, sandboxing, team orchestration, event log |
| `armada-forge` | Python | Corpus ingestion, chunking, embedding, dataset construction, training dispatch, model registry, evaluation |
| `armada-dashboard` | React | Corpora, training runs, agents, teams, live run inspection |
| `armada-db` | Postgres + pgvector | Relational state and vector index in one store |
| `armada-models` | Ollama | OpenAI-compatible inference for all registered ModelBindings |

Prior art: the micro-kernel plugin decomposition and append-only event log come from **DeepSeek Harness**; the single-port gateway daemon shape comes from **OpenClaw**. Both are reimplemented rather than depended on — Harness is in active preview with documented breaking changes to its extension contracts.

---

## Core concepts

| Entity | What it is |
|---|---|
| **Corpus** | Named collection of ingested sources, chunked and embedded. Carries knowledge. |
| **BaseModel** | Entry in the curated shortlist (`config/base-models.yaml`). |
| **Adapter** | LoRA adapter from a training run, attached to one BaseModel. Carries behavior. |
| **ModelBinding** | Resolved (BaseModel, Adapter-or-none) pair, registered under a unique tag. |
| **Agent** | Declarative binding of persona + ModelBinding + tool grants + optional Corpus. |
| **Team** | One manager agent, one or more workers, plus delegation limits. |
| **Run** | One execution of an Agent or Team. Produces an ordered event stream and an outcome. |
| **Event** | Append-only record within a Run. Observability surface and trajectory training data. |
| **Sandbox** | Per-Run Docker container providing filesystem and shell. |

---

## Invariants

These hold across every spec. Changing one changes all of them.

1. **Success is self-reported.** Only an explicit `finish(success: true)` yields outcome `success`. No component infers success from termination.
2. **References are pinned, never live.** Agent and Team versions capture a resolved snapshot; runtime does liveness checks only.
3. **The sandbox boundary is one-directional.** The daemon reaches in; nothing reaches out.
4. **Corpora are referenced by `name`, models by `base_model_id`.** No definition file contains a generated uuid.
5. **Events are append-only and gapless per Run.**
6. **Every Run terminates.** Four budgets plus a no-progress detector.
7. **Zero external spend on the default path.**

---

## Documentation

| | |
|---|---|
| **[Getting Started](docs/getting-started.md)** | Fresh install to first Run |
| **[Wiki Home](docs/Home.md)** | Full documentation index |
| **[Architecture](docs/Architecture.md)** | Services, boundaries, plugin kernel |
| **[Configuration](docs/Configuration.md)** | Every config file, every knob |
| **[Zero-Cost Operation](docs/Zero-Cost-Operation.md)** | What's free, what isn't, how to upgrade |
| **[Specifications](docs/Specifications.md)** | How to read the specs |

---

## Specifications

Requirements are numbered and referenced across specs (e.g. "Agent Runtime R25"). Read the owning spec before touching an area.

| Spec | Owns |
|---|---|
| [`platform-overview`](specs/platform-overview/platform-overview.md) | Shared vocabulary, topology, boundaries. **Not implementable alone.** |
| [`model-training-pipeline`](specs/model-training-pipeline/model-training-pipeline.md) | Ingestion, indexing, datasets, training backends, registry, evaluation |
| [`agent-runtime`](specs/agent-runtime/agent-runtime.md) | Plugin kernel, agent loop, tools, sandboxing, MCP, retrieval, event log |
| [`agent-definition`](specs/agent-definition/agent-definition.md) | Declarative format, validation, versioning, CRUD |
| [`team-orchestration`](specs/team-orchestration/team-orchestration.md) | Manager/worker delegation, scheduling, synthesis, termination |
| [`dashboard`](specs/dashboard/design-dashboard.md) | Design spec — tokens, motion, status vocabulary, per-surface layout |

---

## Non-goals

- No messaging-channel gateway (Slack, Telegram, Discord). The dashboard is the only v1 interface.
- No multi-tenant auth, user accounts, or RBAC.
- No GPU-required code path in any default configuration.
- No pretraining or full-parameter fine-tuning. LoRA only.
- No agent-to-agent communication outside manager/worker delegation.
- No hosted or SaaS deployment. Compose on one host.
- Dashboard: no light theme, no mobile layouts (desktop ≥1280px).

---

## License

**Proprietary. All rights reserved.** See [LICENSE](LICENSE).

The repository is publicly readable; that is not a license. No permission is granted to use, copy, modify, or distribute Armada.

Third-party dependencies are licensed separately and are all compatible with proprietary use. **Two of the five shipped base models — Llama 3.2 and Gemma 3 — are not open source** and carry attribution, naming, and downstream-terms obligations that activate on distribution. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [docs/Licensing.md](docs/Licensing.md).
