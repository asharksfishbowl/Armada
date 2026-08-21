# Armada — Feasibility Review and Implementation Roadmap

**Author:** Researcher · **Filed:** 2026-08-21 · **Source:** `issue-queue.groovy` ISSUE #1
**Specs reviewed:** `model-training-pipeline`, `agent-runtime`, `agent-definition`,
`team-orchestration` (implementable) + `platform-overview`, `design-dashboard` (context/design)

This document records (1) the feasibility review against a CPU-only Docker host, (2) rulings
on the design spec's nine Unresolved Dependencies, and (3) the phase plan that
`build-queue.groovy` implements. Where a ruling amends a spec requirement, the amendment is
stated here and cited from the build task — the spec files themselves are not edited.

---

## Part 1 — Feasibility findings

Thirteen findings: two blockers that make a requirement unbuildable as written, four requiring a
decision before their phase starts, and seven flags that change how a task is built but not
whether it can be. F13 was added on 2026-08-21 alongside the Dependency 5 reversal.

### F1 — BLOCKER · The evaluation gate cannot generate from the candidate Adapter through `armada-models`

**Conflict.** Training R30 states an Adapter whose status is not `promoted` must not be
registered with `armada-models`. R31 performs the merge → GGUF → quantize → register sequence
*on promotion*. But R34 requires both gate modes to "generate a completion per held-out sample
from the candidate Adapter **and** from the unmodified BaseModel, using `armada-models`
locally."

At gate time the candidate has no GGUF artifact and no Ollama tag. The gate as written cannot
run, and the only way to make it run — registering the candidate first — is forbidden by R30.
This is circular, not merely underspecified.

**Ruling.** Candidate generation runs **in-process in `armada-forge`** via `transformers` +
`peft` (`PeftModel.from_pretrained` over the base), which forge already carries for
`LocalTrainingBackend`. No Ollama registration of an unpromoted Adapter, so R30 holds
unamended.

**The baseline runs in-process too.** Generating the baseline through `armada-models` would
compare a `Q4_K_M`-quantized baseline against an fp16 candidate; the quantization delta would
swamp the adapter delta and the gate would measure the wrong thing. Both sides load the same
dtype with identical sampling parameters.

R34's clause "using `armada-models` locally" is amended to "using a locally-loaded model inside
`armada-forge`". Generation stays local and free either way — the zero-spend property is
unaffected.

### F2 — BLOCKER · `held_out_perplexity` is not computable through Ollama

Mechanical mode is the **default** gate (R34, `config/eval.yaml` `mode: mechanical`) and
requires `held_out_perplexity` per model. Ollama's OpenAI-compatible surface does not return
per-token logprobs, and its native API does not either. There is no path from a served Ollama
tag to a perplexity number.

**Ruling.** Compute perplexity in-process with `transformers` — a plain forward pass over the
held-out text with labels, no generation, reading `outputs.loss`. This falls out of F1's
ruling at zero additional dependency cost and is the conventional implementation. It also means
mechanical mode never touches `armada-models` at all: generation for `tool_call_validity` and
the perplexity pass both run in-process.

### F3 — DECISION · First-startup base-model pull is ~9–10 GB and blocks the first boot

R4a registers one ModelBinding per shortlist entry at startup, and AC 166 requires each of the
five to **answer a chat completion** on a first-ever startup. At the specified quantizations
that is roughly 9–10 GB of registry download plus five sequential CPU model loads before the
platform is usable.

**Ruling — keep eager registration.** AC 166 is explicit and a lazily-populated shortlist would
break Agent Definition R14a (validation fails if the base binding is absent), which both
shipped example Agents depend on. Make the cost explicit rather than reducing it:

- An init step warms `armada-models` by pulling each entry's `serving_ref` (renamed from `ollama_tag` per build-plan.md; only `backend: ollama` entries are pulled).
- `armada-forge` holds its healthcheck at 503 until pulls complete and every binding answers.
- The first-boot cost is documented in `docs/getting-started.md` as a stated expectation.

**On the apparent AC 176 conflict:** the firewall-blocked test is a **steady-state** test — it
runs against an installation whose models are already on disk. A model-registry download is not
"an outbound request to a paid endpoint"; the zero-spend invariant is about inference and
teacher providers. `docs/getting-started.md` states this so the two acceptance criteria are not
read as contradicting each other.

**This is the Phase 1 test checkpoint.** Whether the target host absorbs ~10 GB and a long
first boot is a real-hardware fact, and if it does not, the base-binding design changes shape —
which would invalidate Agent Definition validation built on top of it.

### F4 — DECISION · Migration order does not admit the foreign keys the specs imply

Two ordering faults in the Key Files as written:

1. `004_runs_events.sql` creates `runs.agent_version_id` (required), but `agent_versions` is
   not created until `005_agents.sql`. A real FK in 004 cannot resolve.
2. Agent Runtime R3b has `GET /api/runs` return `parent_run_id`, but that column is assigned to
   `006_teams.sql` — so a Phase-4 endpoint reads a Phase-6 column.

**Ruling — renumber so schema precedes use:**

| File | Contents |
|---|---|
| `001_init.sql` | `vector`, `pg_trgm`, shared enums, migration bookkeeping |
| `002_corpora.sql` | `corpora`, `sources`, `chunks`, `ingestion_jobs` |
| `003_training.sql` | `datasets`, `training_runs`, `adapters`, `evaluations`, `model_bindings` |
| `004_agents.sql` | `agents`, `agent_versions` *(was 005)* |
| `005_runs_events.sql` | `runs`, `events` *(was 004)* |
| `006_teams.sql` | `teams`, `team_versions` only |

`005_runs_events.sql` declares `parent_run_id`, `delegation_id`, `is_team_run`, and
`team_version_id` as **nullable columns from the start**, with only `team_version_id`'s FK
added in 006. `GET /api/runs` is therefore complete from Phase 4 and 006 adds no columns to
`runs`. Agent Runtime R53a's "Team Orchestration adds columns to this table in a later
migration" is amended: the columns exist from 005 and 006 adds the referenced tables.

### F5 — DECISION · `egress_allowlist` has no native Docker mechanism

`network: none` is native. A per-container egress ACL is not — Docker has no such primitive.
Implementing R47 as written requires either a per-Run internal bridge plus a forward-proxy
sidecar constrained to `allowed_hosts`, or host iptables manipulation from inside the daemon.

**Ruling — defer, loudly.** Neither shipped sandbox profile needs egress (`node` and `minimal`
both run `network: none`), and the MVP vertical slice never uses it. Phase 2 ships `network:
none` only, and a sandbox profile declaring `network: egress_allowlist` is **rejected at config
load with an error naming the unimplemented mode**. The allowlist lands as its own task
(Phase 9, backlog) implementing the internal-bridge-plus-proxy design.

This is a scope deferral, not a stub: the unimplemented value fails loudly at startup rather
than being silently downgraded to `none`, which would be a security fault. Agent Runtime AC
"with `egress_allowlist`, a request to a listed host succeeds…" defers with the task.

### F6 — FLAG · GGUF toolchain must be baked into the forge image

Merge → GGUF → quantize needs llama.cpp's `convert_hf_to_gguf.py` and `llama-quantize` present
in `services/forge/Dockerfile`. Merging a 4B model in fp16 needs roughly 8–16 GB RAM. This is
Phase 7 risk only — on the zero-cost path no Adapter is ever promoted, so the path is built and
tested but not exercised by the MVP.

### F7 — FLAG · The embedding model must be baked in, not fetched at runtime

`BAAI/bge-small-en-v1.5` is fetched from HuggingFace on first use, which fails AC 176's
blocked-egress test. Bake the weights into `services/forge/Dockerfile` at build time (~130 MB)
and set `HF_HUB_OFFLINE=1` at runtime so a missing cache fails loudly instead of silently
reaching out.

### F8 — FLAG · "Adding a GPU requires no configuration change" is true of Armada, not of Compose

`LocalTrainingBackend` detecting CUDA at startup is correct, but the container only *sees* a GPU
if Compose grants it. Ship the `deploy.resources.reservations.devices` block commented in
`docker-compose.yml` with a one-line note. Platform Overview's upgrade-path claim is accurate
about Armada configuration and inaccurate about Compose; the comment closes the gap.

### F9 — FLAG · The daemon requires the Docker socket

`DockerSandboxProvider` provisions sibling containers, so `/var/run/docker.sock` is mounted into
`armada-daemon`. That is host-root-equivalent for the daemon process. It is consistent with the
spec — sandboxes get no socket, and the boundary is one-directional — and acceptable under the
single-operator trusted-network posture, but it must be a documented decision rather than an
incidental mount.

### F10 — FLAG · Ollama registration is a two-step blob protocol

Registering a GGUF is `POST /api/blobs/{digest}` followed by `POST /api/create` with a Modelfile
referencing the blob, not a single call. Affects `registry/export.py` in Phase 7.

### F11 — MINOR · `min_ram_gb` is declared but unconsumed

No requirement reads it. Ruling: at startup base-binding registration, compare against host
memory and log a warning naming the model and both values. Informational only — it never blocks
registration.

### F12 — MINOR · Ollama's own concurrency must agree with the daemon's

The daemon enforces `max_concurrent_per_tag` and `max_concurrent_total`, but Ollama independently
swaps models in and out of RAM when concurrent requests hit different tags — multi-second
reloads on CPU. Set `OLLAMA_MAX_LOADED_MODELS` and `OLLAMA_NUM_PARALLEL` in Compose to agree
with `config/models.yaml`. Most visible under Team Orchestration, where manager and workers hold
different tags concurrently.

### F13 — DECISION · The health-strip fan-out must not touch `GET /api/health`'s status code

*Added 2026-08-21 with the Dependency 5 reversal.*

Design R35a's strip is served by extending `GET /api/health` to fan out to `armada-forge` and
`armada-models`. Built naively — letting an unreachable peer produce a 503 — that extension is
actively harmful, and specifically it breaks the first boot:

- Agent Runtime R3a makes this endpoint the **Compose healthcheck** for `armada-daemon`, and
  dependent services gate on it.
- F3 has `armada-forge` deliberately hold its own healthcheck at 503 for the entire first-boot
  model pull.

So a fan-out that can 503 the daemon would mark the daemon unhealthy for the whole first boot
and cascade to everything gated on it — a self-inflicted startup deadlock, on the one code path
every installation runs exactly once and cannot skip.

**Ruling.** The 200/503 decision stays exactly as R3a defines it — daemon-local plugin
registration and database reachability, nothing else. Peer reachability is **reported in the
payload** and never affects the status code:

```
services: { daemon: {reachable, last_checked},
            forge:  {reachable, last_checked},
            models: {reachable, last_checked} }
```

The strip renders a degraded peer; it must never manufacture a degraded self.

**On probing.** The daemon probes peers on `health_probe_interval_seconds`
(`config/runtime.yaml`) and serves the cached result with its `last_checked`, which is what
R35a's last-checked time renders. Probing inline on every request would let a dashboard polling
the strip stampede forge. This is a genuine periodic liveness probe of a peer container — there
is no event source for "is another container still up" to subscribe to — and is therefore not a
timed stand-in for event-driven logic. Before the first probe returns, a service reports unknown,
which R35b renders as `◌`.

### Confirmed feasible — no finding

Reviewed and buildable as written on CPU-only Docker: pgvector HNSW + GIN hybrid retrieval with
RRF; PEFT/TRL LoRA SFT at qwen3-0.6b × 20 steps; single-port HTTP+WS multiplexing; transactional
gapless `seq`; append-only event log; the four budgets and the no-progress detector; Code mode's
result-file protocol (no callback channel is exactly what makes it CPU- and
sandbox-boundary-safe); tree-budget accounting; manager-priority scheduling; closed-schema
validation with full error accumulation; file-watch upsert on `agents/` and `teams/`.

---

## Part 2 — Rulings on the design spec's nine Unresolved Dependencies

**Amended 2026-08-21 — all nine added, none refused.** My first pass refused #5 and coined my
own names for #6, #8, and #9. The design spec was then revised: its "Unresolved Dependencies"
section became "Dependencies", every entry is ruled, and it now names each contract itself. The
spec's names are authoritative and the table below is reconciled to them. Each added endpoint is
small and folds into the phase owning its service.

| # | Dependency | Ruling | Lands in |
|---|---|---|---|
| 1 | No `GET /training/runs` | **ADD** — list over `training_runs`, cursor pagination mirroring `GET /api/runs` | Phase 7 |
| 2 | No `GET /adapters`, `GET /datasets` | **ADD** — adapters filtered by `base_model_id`/`status`; datasets include `source_breakdown` | Phase 7 |
| 3 | No `DELETE /corpora/{id}`, `DELETE /api/teams/{id}` | **ADD** — corpus behaviour already fixed by Training edge 16; team delete mirrors the Agent soft delete of R26 | Phases 1, 6 |
| 4 | No push channel for ingestion progress | **ADD** — forge WebSocket at `/ws` | Phase 1 |
| 5 | No service health endpoints / strip | **ACCEPT, narrowed to three dots** *(reversed)* | Phases 2, 8 |
| 6 | `agent_version_id` is a uuid, badge needs an integer | **ADD** — `version` (int) beside `agent_version_id` on run rows | Phase 4 |
| 7 | Team-run identification on `GET /api/runs/{id}` | **ADD** — `parent_run_id`, `is_team_run`, `team_version_id` | Phase 4 |
| 8 | `run_start` payload not enumerated | **SPEC DEFECT — corrected requirement** | Phase 4 |
| 9 | No config-state endpoint | **ADD** — `GET /api/config/capabilities` | Phases 1, 2 |

**On #4.** Training R27 already requires progress to reach the dashboard ("emits a dashboard WS
message"), so `armada-forge` needs a WebSocket channel regardless. Ingestion rides the same
channel at near-zero marginal cost, so design **R126 applies**; R127's degraded form is retained
only for a channel that is genuinely unavailable, not as the normal path.

**On #5 — the reversal.** I refused this on one ground: the spec recorded the strip as "flagged,
not designed" and outside its own scope, so there was no design to build. That ground no longer
holds — the spec now designs it at Requirements 35a–35d, and narrows it from five dots to three
(`daemon`, `forge`, `models`) with a rationale I agree with: a `db` dot could only mirror
`daemon`, since a daemon answering `GET /api/health` has a reachable database by definition, and
`sandbox` has no persistent process to be up or down. A dot that cannot independently change
state is decoration wearing a status mark.

The mechanism is cheap — `GET /api/health` already exists (Agent Runtime R3a) and is extended to
fan out to forge and models. R35b introduces no new marks, and R35d keeps the strip from raising
a navigation badge, so `missing` remains the only status that escalates to the rail. **The rail
still has six destinations**; the strip is chrome on it, not a seventh.

The extension is not free of consequence, however — see **F13**, which is what the fan-out breaks
if built naively.

**On #8 — the `run_start` payload.** Ruled a spec defect rather than a design gap: Agent Runtime
R54–R59 simply never enumerated it. The corrected set is exactly what design R107 renders:

```
{ agent_version_id, binding_tag, mode, workspace_path,
  budgets: {max_steps, max_model_tokens, max_wall_clock_seconds, max_tool_calls},
  tools: [fully-qualified, post-denied] }
```

Six fields, every one already present in the pinned `resolved_snapshot` (Agent Definition R24) —
a copy, not a new derivation, which is invariant 2 holding at the event boundary. My first pass
proposed a superset including `agent_name`, `context_window`, `tool_format`, `corpus_id`,
`auto_inject_k`, and `sandbox_profile`; the narrower set is correct, because nothing in R107
renders them and an event payload is not a place to put fields on speculation.

**On #9.** `GET /api/config/capabilities` returns `teacher_enabled`, `eval_mode`, and
`local_backend_mode` — no credentials, no endpoints, no key names. All three are forge-side
facts (`local_backend_mode` comes from Training R24's CUDA detection), so **forge owns the
endpoint and the daemon proxies it**, because `/api/*` is the daemon's namespace. It converts
design R137a's guess into a fact, reaches R137c's preferred end state, and lets ModelsPage label
scores correctly (R130).

---

## Part 3 — Phase plan

### Branch shape

Genuinely phased with ordered cross-branch dependencies, so this is a **parent + sub-branch**
stack, matching the issue's stated expectation:

```
feature/armada-v1                        ← parent, long-lived, merges to main ONCE (user-gated)
├─ feature/armada-v1-phase-0-foundation
├─ feature/armada-v1-phase-1-forge-ingestion
├─ feature/armada-v1-phase-2-daemon-kernel
├─ feature/armada-v1-phase-3-agent-definition
├─ feature/armada-v1-phase-4-agent-loop
├─ feature/armada-v1-phase-5-retrieval
├─ feature/armada-v1-phase-6-teams
├─ feature/armada-v1-phase-7-training
└─ feature/armada-v1-phase-8-dashboard
```

Each sub cuts from the parent, which already carries the prior phases, so the ordering is
structural — no `BLOCKED-BY` markers and no green-light handoff.

**Subs are dash-separated, not nested under the parent** — amended 2026-08-21 after the
Builder hit it during Phase 0. `feature/armada-v1/phase-0-foundation` is not creatable while
`feature/armada-v1` exists: a loose ref is a file, a ref namespace is a directory, and one
path cannot be both. Git rejects the directory/file conflict regardless of storage backend.

```
$ ls -la .git/refs/heads/feature/
-rw-r--r--  41  armada-v1          ← a FILE
$ git checkout -b feature/armada-v1/phase-test feature/armada-v1
fatal: cannot lock ref ... 'refs/heads/feature/armada-v1' exists
```

The nested form came from the Researcher brief's parent+sub template, which is not
representable in git for any `<name>`. The alternative — naming the parent
`feature/armada-v1/parent` so the namespace becomes a directory — was rejected: it needs a
force-push over an already-published ref, and it puts a storage-constraint artifact in the
name of the branch that raises the final user-gated PR. Dash-form subs sort adjacently under
the parent anyway, so the grouping is preserved. **Naming only — the parent+sub dependency
structure is unchanged.**

### Sequencing, and where it departs from the issue's suggestion

The issue's order is kept except for one split. It placed the whole of `armada-daemon` at
Phase 2 and `agent-definition` at Phase 3 — which builds an agent loop before any Agent record
exists for it to execute, leaving Phase 2 verifiable only against fixtures.

**Departure:** the daemon splits across Phases 2 and 4, with Agent Definition between them.

- **Phase 2** — kernel, gateway, event log, sandbox provider. Infrastructure with no loop.
  Independently verifiable: health endpoint, plugin registration failure modes, gapless `seq`,
  container acquire/release, orphan cleanup.
- **Phase 3** — Agent Definition. Needs only forge (Phase 1) and the gateway to host its routes
  (Phase 2).
- **Phase 4** — the agent loop, which now has real validated Agents and real `resolved_snapshot`
  values to execute against, rather than hand-written fixtures.

Everything else follows the issue: retrieval (5), teams (6), training (7), dashboard (8).
Training stays late for the reason the issue gives — it is demonstrable without promotion, and
nothing else depends on it.

| Phase | Delivers | Depends on |
|---|---|---|
| 0 | Compose, all six migrations, service skeletons, healthchecks, config files | — |
| 1 | Forge: ingestion, Corpus API, base bindings, seeding, `/ws`, `GET /config/capabilities` | 0 |
| 2 | Daemon: kernel, gateway, event log, sandbox provider | 0 |
| 3 | Agent Definition: schema, validation, resolver, store, file loader, routes | 1, 2 |
| 4 | Agent loop, tools, model adapter, scheduler, budgets, context, Code mode, MCP | 3 |
| 5 | Retrieval: pgvector hybrid provider, `search_knowledge`, auto-injection | 4 |
| 6 | Team Orchestration | 5 |
| 7 | Training: datasets, backends, eval gate, promotion, registry | 5 |
| 8 | Dashboard | 6, 7 |

Phases 6 and 7 both depend only on 5 and are independent of each other. They are ordered 6-then-7
because the dashboard's team surfaces are the more intricate of the two, not because 7 needs 6.

### Test checkpoints — two, not nine

Per the checkpoint rule, most phases are additive and testable at leisure. Two are not:

- **Phase 1** — the ~10 GB first-boot pull (F3) is a real-hardware fact. If the host cannot
  absorb it, base-binding registration changes shape, and Agent Definition validation (R14a)
  is built directly on top of it.
- **Phase 5** — the MVP vertical slice reaches an end-to-end usable state for the first time:
  an Agent runs a real task with retrieval and sandboxed tools. Teams and Training both compound
  on that behavior.

No other phase gets one.

### Zero-spend acceptance criterion

Per the issue, "no outbound request to a paid endpoint on the default path" is an acceptance
criterion for **every** phase, not just training. Each build task carries it. The check is the
blocked-egress test from Training AC 176, run per phase against that phase's surface, understood
as a steady-state test per F3.

---

## Part 4 — Backlog (not queued)

- **Phase 9 — `egress_allowlist` sandbox networking** (F5). Internal bridge + constrained
  forward-proxy sidecar. Unblocks Agent Runtime R47 and its acceptance criterion.
- **Service health strip** (Unresolved Dependency 5). Refused for v1; needs its own design pass
  before it is buildable.
