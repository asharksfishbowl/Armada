# Getting Started

A fresh installation of Armada from `docker compose up` to a first Run.

Armada is **single-operator, trusted-network, one host**. There is no authentication, no
multi-tenancy, and no hosted deployment story — those are platform-wide non-goals, not
missing features. Do not expose it to an untrusted network.

## Requirements

- Docker with Compose v2
- **CPU only.** No GPU is required by any service. If you have one, see
  [Adding a GPU](#adding-a-gpu).
- **~20 GB free disk.** Roughly 10 GB of that is the base-model pull described below.
- **8 GB RAM minimum**, 16 GB comfortable. The largest shipped shortlist entries declare
  `min_ram_gb: 6`.

No accounts. No API keys. No credentials of any kind.

## Start it

```sh
git clone https://github.com/asharksfishbowl/Armada
cd Armada
docker compose up
```

Six containers start — five long-running services plus a one-shot migration job:
`armada-db` (Postgres + pgvector), `armada-migrate` (runs to completion and exits),
`armada-models` (Ollama), `armada-forge` (Python), `armada-daemon` (TypeScript), and
`armada-dashboard`. The dashboard is at <http://localhost:3000>.

A first start takes a few minutes, almost all of it building images. **It transfers no
model weights** — see below.

---

## Registration and materialization are separate

This is the part most worth understanding, because it is what keeps a first boot cheap.

`armada-forge` registers one ModelBinding per entry in `config/base-models.yaml` at
startup, tagged `armada/{id}-base`. That is what makes every shortlist model addressable
by an Agent declaring `adapter: none` **without any training run having happened**, and it
is what both shipped example Agents depend on for validation.

**Registering a binding writes a record. It does not download a model.** Materializing one
— actually pulling the weights so it can answer — is a separate, explicit act. A binding
reports whether it is materialized, so nothing has to guess whether a Run against it will
start immediately or block behind a download.

The practical consequence: `docker compose up` on a fresh host transfers **zero model
bytes**. You choose what to pull, when.

### What a model costs when you do materialize it

| Model (`serving_ref`) | Approx. download |
|---|---|
| `qwen3:0.6b` | ~0.5 GB |
| `qwen3:1.7b` | ~1.4 GB |
| `qwen3:4b` | ~2.6 GB |
| `llama3.2:3b` | ~2.0 GB |
| `gemma3:4b` | ~3.3 GB |
| **All five** | **~9–10 GB** |

Sizes are approximate and follow whatever `config/base-models.yaml` lists — if you trim or
extend that file, this table no longer describes your installation.

`qwen3:0.6b` is the one to start with: it is the smoke-test model, the smallest download,
and the only model a CPU-only host will train.

To watch a pull:

```sh
docker compose logs -f armada-models
```

If disk is tight, trim `config/base-models.yaml` before the first start. **Keep exactly one
entry with `smoke_test: true`** (Training R2) — forge validates this at startup and refuses
to run otherwise, naming the problem.

---

## Zero external spend

**A default installation cannot spend money.** Not "is configured not to" — cannot,
because the code paths that could are disabled by default and reject requests before
attempting a connection.

| Concern | Default | Cost |
|---|---|---|
| Ingestion, chunking, embedding (`bge-small`) | Local, CPU | none |
| Retrieval (pgvector + full-text + RRF) | Local | none |
| Agent and Team runs | Base ModelBindings via Ollama | none |
| Dataset construction | `supplied_file` and/or trajectories | none |
| Distillation (`config/teacher.yaml`) | `enabled: false` | none |
| Training (`LocalTrainingBackend`) | Smoke mode — CPU, `qwen3-0.6b`, 20 steps | none |
| Evaluation gate (`config/eval.yaml`) | `mode: mechanical` | none |

Two settings enforce it, and both fail loudly rather than quietly:

- `config/teacher.yaml` → `enabled: false`. A `POST /datasets` naming a `corpus_id`
  returns HTTP 400 naming the two teacher-free sources **and makes no outbound request**.
- `config/eval.yaml` → `mode: mechanical`. Setting `mode: judge` while the teacher is
  disabled **fails startup naming both settings**, rather than deferring the failure to
  your first promotion attempt.

### The blocked-egress test is a steady-state test

This matters, because two acceptance criteria look contradictory until you read them
precisely:

- **AC 166** requires each base ModelBinding to be usable — which, for a materialized
  binding, means its weights were downloaded at some point.
- **AC 176** requires the full flow to run with egress to external model providers blocked
  at the firewall, producing no errors attributable to a blocked request.

**Both hold, because AC 176 describes a STEADY-STATE installation — one whose models are
already on disk.** Materialize what you need once, then block egress and everything keeps
working: inference is local, retrieval is local, embedding is local, and the default
evaluation gate is local.

A model-registry download is not "an outbound request to a paid endpoint". The zero-spend
invariant is about **inference and teacher providers** — the things that bill per token.
Nothing on the default path ever contacts one.

---

## What you get for free, and what you do not

Specialization in Armada splits two ways: a **Corpus** carries domain *knowledge*, and an
optional **LoRA Adapter** carries domain *behavior*.

On the zero-cost path you get the knowledge half in full, plus persona and tool grants.
You do **not** get promoted Adapters. Smoke runs are unpromotable by design (Training R37):
a 0.6B model at 20 steps is a pipeline proof, not a model worth serving. The training
pipeline is built and exercised end to end — it just produces nothing servable.

Two upgrades change that, neither a rewrite:

- **Add a GPU.** `LocalTrainingBackend` detects CUDA at startup and switches to quality
  mode — uncapped steps, any `trainable` model, promotable Adapters. No account, no spend.
- **Add a teacher budget.** Set `teacher.enabled: true` for corpus distillation, and
  optionally `eval.mode: judge` for a stronger gate.

### Adding a GPU

Armada needs no configuration change. **Compose does** — the container only sees a device
if it is granted one. Uncomment the `deploy.resources.reservations.devices` block on
`armada-forge` in `docker-compose.yml` and restart. That is the entire change.

---

## Your first Run

Once every service is healthy:

1. **Both example Agents are already loaded.** `agents/frontend-engineer.yaml` and
   `agents/chef.yaml` load from `agents/` on startup. Both declare `adapter: none`, so
   they validate against base bindings with no training run.

   They reference Corpora named `frontend-docs` and `recipes`, which `armada-forge` seeds
   empty on first startup (`config/seed-corpora.yaml`). Because a seeded Corpus has zero
   chunks, both validate **with a zero-chunk warning rather than an error** — they are
   runnable immediately, with retrieval returning nothing until you ingest.

   `chef.yaml` is not decorative. It is the evidence that no field in the Agent schema
   privileges software engineering.

2. **Give a Corpus something to retrieve.** Add a Source (a git repo, a docs URL, a
   mounted directory, or an upload) and ingest:

   ```sh
   # Add a git Source to the seeded frontend-docs Corpus
   curl -X POST localhost:8000/corpora/$CORPUS_ID/sources \
     -H 'Content-Type: application/json' \
     -d '{"type":"git","location":"https://github.com/some/docs-repo",
          "include_globs":["**/*.md"],"exclude_globs":["vendor/**"]}'

   # Start ingestion — returns immediately with a job_id
   curl -X POST localhost:8000/corpora/$CORPUS_ID/ingest
   ```

   Ingestion clones at depth 1, extracts text, chunks it, embeds each chunk on CPU with
   `bge-small-en-v1.5`, and writes to pgvector. Progress streams over the forge WebSocket
   at `ws://localhost:8000/ws`.

   Two behaviors worth knowing:

   - **Re-ingesting an unchanged Source adds and removes nothing.** Idempotency is keyed
     on the pair `(content_sha256, source_path)`, so unchanged chunks are never
     re-embedded — which is what makes re-ingestion cheap rather than a full rebuild.
     Editing a file replaces exactly its chunks; deleting one removes exactly its chunks.
   - **One bad Source does not fail the job.** A repo that will not clone is recorded
     `failed` with its error, the remaining Sources still ingest, and the job ends
     `partial`. A typo in one URL should not discard the work done for everything else.

   Code files chunk on function and class boundaries and a function body is never split
   across chunks; prose chunks on headings and paragraphs. Half a function is not a useful
   retrieval result — it returns a signature with no body, or a body with no name.

3. **Run an Agent.** Open **Runs**, launch `frontend-engineer` against a real task, and
   watch the event stream. Every message, tool call, tool result, and retrieval is
   recorded in order.

4. **Compose a Team.** `teams/frontend-feature-team.yaml` ships as an example: a manager
   delegating to specialist workers.

### Reading an outcome

A Run ends with exactly one of `success`, `incomplete`, `failed`, `cancelled`,
`budget_exhausted`, or `no_progress`.

**`success` means the agent explicitly reported success** by calling
`finish(success: true)`. Nothing infers it from termination. A Run that simply stopped
without calling `finish` is `incomplete`.

That distinction is load-bearing rather than pedantic: `armada-forge` builds trajectory
training data **only** from `success` Runs. Defaulting a merely-terminated Run to `success`
would train your next Adapter on every run that managed not to crash.

`incomplete` is not a fault. It means the agent ran correctly and reported it did not
achieve the task. `failed` is reserved for infrastructure faults.

---

## What is built so far

Armada is being built in phases. What exists today:

| Surface | Status |
|---|---|
| `docker compose up`, all five services, six migrations | ✅ |
| Corpus CRUD — `POST/GET/DELETE /corpora`, `GET /corpora/{id}` | ✅ |
| Sources and ingestion — `POST /corpora/{id}/sources`, `.../ingest` | ✅ |
| Chunking, CPU embedding, idempotent indexing | ✅ |
| Ingestion progress over `ws://…:8000/ws` | ✅ |
| `GET /config/capabilities` | ✅ |
| Daemon: single-port gateway, plugin kernel, event log, `GET /api/health` | ✅ |
| Run event stream over `ws://…:8080/ws` with ordered replay | ✅ |
| Base ModelBinding registration and materialization | ⏳ blocked |
| Agent definition, agent loop, sandboxes, retrieval, teams, training, dashboard | ⏳ later phases |

**`GET /api/health`** reports 200 or 503 from **daemon-local facts only** — plugins
registered and database reachable. It also carries a `services` strip reporting whether
`forge` and `models` are reachable, but *peer reachability never changes the status code*.
Compose gates dependent services on this healthcheck, so a fan-out that could 503 the
daemon would turn one peer hiccup into a restart cascade — taking down the endpoint that
would have explained it.

**Subscribing to a run's events:** connect to `ws://localhost:8080/ws` and send
`{"subscribe": {"run_id": "..."}}`. You receive every recorded Event in `seq` order before
any live one. Reconnecting replays the whole stream again — the gateway keeps no
per-connection state, so the stream is always reconstructed from the log.

**Deleting a Corpus** removes it and its chunks, but **Adapters trained from it are
retained and keep serving** — their ModelBinding tags are unaffected. A served model must
not stop resolving because its training corpus was cleaned up.

**`GET /config/capabilities`** returns exactly three fields — `teacher_enabled`,
`eval_mode`, `local_backend_mode` — and nothing else. No credentials, no endpoints, no
environment variable names. The dashboard uses it to render disabled-with-reason instead
of enabled-and-guessing.

## Configuration reference

All under `config/`, mounted read-only into the services.

| File | What it controls |
|---|---|
| `base-models.yaml` | The curated BaseModel shortlist. Exactly one `smoke_test: true`. |
| `models.yaml` | Backend base URLs, request concurrency, `code_mode_min_context`. |
| `runtime.yaml` | The four budgets, their ceilings, context and retrieval defaults. |
| `plugins.yaml` | Which implementation backs each of the five plugin interfaces. |
| `sandbox-profiles.yaml` | Per-Run container image, limits, network, tmpfs size. |
| `mcp-servers.yaml` | MCP servers an Agent may grant. Ships empty. |
| `teacher.yaml` | Teacher model. **`enabled: false` by default.** |
| `eval.yaml` | Evaluation gate mode. **`mechanical` by default.** |
| `eval-rubric.md` | The pass/fail rubric, judge mode only. |
| `training-remote.yaml` | Remote provider. Unused on the default path. |
| `seed-corpora.yaml` | Corpora created empty on first startup. |
| `code-extensions.yaml` | Extensions chunked on function/class boundaries. |

**Credentials are never written to these files.** Fields named `*_api_key_env` hold an
environment variable *name*; the value is read from the environment at use time and is
never persisted to the database and never written into an Event.

## Troubleshooting

**`armada-forge` exits immediately.** It validates configuration at startup and refuses to
run on a fault, listing every problem at once. Common causes: a `base-models.yaml` entry
missing a required key (it names the offending `id`), zero or multiple entries with
`smoke_test: true`, or `eval.mode: judge` against `teacher.enabled: false`.

**`armada-forge` sits at `starting` for a long time on first boot.** Expected — see above.
Follow `docker compose logs -f armada-models`.

**A migration failed.** Each migration file is wrapped in a transaction and records itself
in `schema_migrations`, so a failure rolls back fully rather than leaving a half-applied
schema. Fix the cause and re-run `docker compose up armada-migrate`; already-applied
migrations are skipped.

**A Run fails immediately naming a binding tag.** Its Agent pinned a binding that is now
`retired` or `missing` — usually because an entry was removed from `base-models.yaml`.
Armada never re-resolves a pinned reference on its own; call
`POST /api/agents/{agent_id}/refresh-bindings` to adopt the current one deliberately.
