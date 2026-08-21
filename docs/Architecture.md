# Architecture

Five services under one `docker-compose.yml`, plus a one-shot migration job. No service requires a GPU to start.

```
                    ┌──────────────────┐
                    │ armada-dashboard │  React, :3000
                    └────────┬─────────┘
                             │ HTTP + WS (one port)
                    ┌────────▼─────────┐
                    │  armada-daemon   │  TypeScript, :8080
                    │                  │
                    │  gateway         │
                    │  plugin kernel   │
                    │  agent loop      │──── spawns ──▶ ┌─────────┐
                    │  tool dispatch   │                │ sandbox │ per-Run
                    │  team orchestr.  │                └─────────┘ container
                    │  event log       │
                    └───┬─────────┬────┘
           reads chunks │         │ inference by tag
           reads bindings         │
                    ┌───▼─────┐ ┌─▼──────────────┐
                    │armada-db│ │ armada-models  │  Ollama
                    │ pgvector│ └────────────────┘
                    └───▲─────┘
       writes chunks    │
       writes adapters  │
                    ┌───┴──────────┐
                    │ armada-forge │  Python
                    │              │
                    │  ingestion   │
                    │  datasets    │
                    │  training    │
                    │  registry    │
                    │  evaluation  │
                    └──────────────┘
```

---

## Services

| Service | Language | Responsibility |
|---|---|---|
| `armada-daemon` | TypeScript | Gateway (HTTP + WS on **one** port), plugin kernel, agent loop, tool dispatch, sandbox provisioning, team orchestration, event log writer |
| `armada-forge` | Python | Corpus ingestion, chunking, embedding, dataset construction, training dispatch, model registry, evaluation |
| `armada-dashboard` | React | Corpora, training runs, agents, teams, live run inspection |
| `armada-db` | Postgres + pgvector | Relational state **and** vector index in one store |
| `armada-models` | Ollama | OpenAI-compatible inference endpoint serving all registered ModelBindings |

`armada-migrate` runs the SQL migrations to completion and exits. It is not a long-running service.

---

## Cross-service boundaries

These are the seams that leak most often. They are binding.

**1. Ingestion vs. retrieval.** `armada-forge` *writes* chunks and embeddings. `armada-daemon` *queries* them at agent time. The daemon never writes the vector index; the forge never serves a retrieval query.

**2. Training vs. serving.** `armada-forge` produces Adapters and registers ModelBindings. `armada-daemon` only ever consumes them by tag over the OpenAI-compatible API. This is the single seam through which models reach the daemon — which is why adding a second inference engine requires no daemon changes.

**3. Trajectories.** `armada-daemon` writes Events; `armada-forge` reads Events to build datasets. This is the only path from agent behavior back into training, and it is one-directional.

**4. Definitions.** Agent Definition owns schema and validation. Agent Runtime *executes* a validated Agent and must not reinterpret or extend the schema.

---

## The plugin kernel

The daemon decomposes into five plugin interfaces. The agent loop resolves every capability through the kernel and must never import a concrete implementation.

| Interface | Contract |
|---|---|
| `ModelAdapter` | `chat(request, signal) -> AsyncIterable<ChatDelta>`, `capabilities()` |
| `ToolProvider` | `list() -> ToolSpec[]`, `invoke(name, args, ctx) -> ToolResult` |
| `SandboxProvider` | `acquire(spec) -> Sandbox`, `release(sandbox)` |
| `RetrievalProvider` | `query(corpusId, text, k) -> Chunk[]` |
| `EventSink` | `append(event)` |

Plugins are registered from `config/plugins.yaml` at startup. A declared plugin that fails to load, or a required interface left unregistered, fails startup with a non-zero exit — never a silent degradation.

The practical test: swapping the `RetrievalProvider` entry in `config/plugins.yaml` for a stub must change retrieval behavior with **no edit** to `agent-loop.ts`.

---

## The agent loop

A **Step** is one iteration: build context, call the model, then either dispatch tool calls or terminate. A **Turn** is a user message plus every Step taken in response.

Context is assembled in a fixed order:

1. System prompt
2. Injected retrieval block (first Step of a Turn only)
3. Compacted history summary, if present
4. Retained history messages
5. Current user message

Tool calls within one Step run concurrently, but their results are appended to history **in the order the model emitted them**, not the order they completed — otherwise identical runs would produce different histories.

### Termination

Four budgets, defaulted in `config/runtime.yaml` and overridable per Agent: `max_steps`, `max_model_tokens`, `max_wall_clock_seconds`, `max_tool_calls`. Plus a no-progress detector that fires when the same tool name and byte-identical arguments recur across consecutive Steps.

Budget checks happen **before** each Step and **before** each tool dispatch, so a budget can never be exceeded — only prevented.

### Standard vs. Code mode

**Standard** presents tools as native function-call schemas. This is the default and the right choice for small models.

**Code mode** generates a TypeScript SDK, writes it into the sandbox, and executes the model's program entirely in-container. It has **no callback channel** into the daemon — which means MCP tools and `search_knowledge` are unavailable inside a Code-mode program. That is not a limitation to work around; it is what keeps the sandbox boundary one-directional.

---

## Sandboxing

One container per Run, from a profile in `config/sandbox-profiles.yaml`.

- Runs as a **non-root UID**, no Docker socket, dropped capabilities
- `network: none` or an egress allowlist
- Only two mounts: the workspace bind at `/workspace`, and a writable tmpfs at `/armada`
- Released and removed on any terminal outcome, including crash recovery on daemon restart

The `/armada` tmpfs exists so oversize tool results and Code-mode artifacts have somewhere to go even when `read_only_root: true`.

**The boundary is one-directional.** The daemon reaches into a sandbox; nothing in a sandbox calls back out.

---

## The event log

Events are appended to a table with a monotonic, gapless `seq` per Run. **No code path updates or deletes an Event.**

`run_start`, `user_message`, `model_request`, `model_response`, `reasoning`, `tool_call`, `tool_result`, `retrieval`, `compaction`, `mode_downgraded`, `mcp_unavailable`, `delegation`, `error`, `run_end`

`seq` is assigned by a transactional counter, so concurrent tool completions cannot produce duplicates or gaps. Event payloads redact any value sourced from a configured credential environment variable.

This log is doing double duty: it is the live stream the dashboard renders, and it is the trajectory data the forge reads to build training datasets.

---

## Model request scheduling

All model requests route through a scheduler enforcing a per-tag concurrency limit (default 1) and a global limit (default 2). Queue admission is **event-driven on request completion** — no timed polling, no fixed delays.

Time spent queued is recorded as `queued_ms` and does **not** count against a Run's wall-clock budget. A run should not be penalized for waiting on a busy box.

In team runs, the manager's requests are admitted at higher priority than workers', so a manager waiting to synthesize is never starved behind queued workers.

---

## Team orchestration

A Team is one manager Agent plus a roster of workers. The manager receives two extra tools — `delegate(worker, task, context)` and `list_workers()` — and nothing else changes about how it runs.

- Each delegation is a **child Run** with its own sandbox and its own event stream
- Workers share the workspace but not conversation history or tools
- Delegation is **one level deep**; a worker cannot delegate
- The manager must be Standard mode — `delegate` is daemon-side, and a Code-mode program has no callback channel to reach it
- **Tree budgets** are accounted across the parent and all children, so a team cannot outspend a solo run by fanning out

A Team Run's outcome follows the same self-report rule as any Run: `success` requires the manager to call `finish(success: true)` *and* synthesis to complete.
