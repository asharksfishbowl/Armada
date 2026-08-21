# Spec: Agent Runtime

## Overview
`armada-daemon` is the execution kernel: a single-port gateway that loads runtime components as plugins, runs the agent loop against an OpenAI-compatible model endpoint, dispatches tools into a per-Run Docker sandbox and to MCP servers, injects and serves retrieval, and writes an append-only event stream that is both the observability surface and the raw material for trajectory training.

## Goals
- Execute a validated Agent against a task and reach a terminal outcome with a hard guarantee of termination.
- Decompose the runtime into swappable plugins (model adapter, tool provider, sandbox provider, retrieval provider, event sink) so a component can be replaced without touching the loop.
- Give every Run an isolated filesystem and shell that cannot reach the host.
- Record every message, tool call, tool result, retrieval, and model exchange in order, losslessly.
- Keep small models productive on a narrow context window through deterministic context budgeting and compaction.

## Non-Goals
- Defining or validating the Agent schema. That is Agent Definition; this spec consumes an already-validated Agent.
- Multi-agent delegation and team semantics. That is Team Orchestration; this spec provides the Run primitive it builds on.
- Writing to the vector index. `armada-daemon` issues read-only retrieval queries; `armada-forge` owns writes.
- Training, adapter management, or model promotion.
- Messaging channels. The gateway serves the dashboard only.

## Definitions
- **Kernel** — the plugin host. Owns registration, dependency resolution, and lifecycle of plugins; contains no agent logic itself.
- **Step** — one iteration of the agent loop: build context, call the model, and either dispatch tool calls or terminate.
- **Turn** — a user message and every Step taken in response to it, up to the next user message.
- **Terminal outcome** — one of `success`, `incomplete`, `failed`, `cancelled`, `budget_exhausted`, `no_progress`. Only `success` makes a Run eligible to become trajectory training data.
- **Self-report** — the `success` boolean the agent passes to the built-in `finish` tool. It is the sole source of a Run's `success` or `incomplete` outcome.

## Requirements

### Gateway
1. `armada-daemon` listens on a single port (default 8080, `ARMADA_PORT`) serving both HTTP and WebSocket, multiplexed by path: HTTP under `/api/*`, WebSocket at `/ws`.
2. `POST /api/runs` starts a Run with `agent_id` (uuid), `task` (string), and optional `workspace_path` (string), returning `run_id`. The call returns before the Run completes.
3. `GET /api/runs/{run_id}` returns the Run's `status`, `outcome`, `result` (the final assistant message, or the `finish` tool's `summary` when the Run terminated through `finish`), `agent_version_id`, `started_at`, `ended_at`, and budget counters.
3b. `GET /api/runs` lists Runs with `run_id`, `agent_version_id`, `status`, `outcome`, `started_at`, `ended_at`, and `parent_run_id` (null for a Run that is not a delegation), filterable by `agent_id`, `status`, `outcome`, and `parent_run_id`, newest first with `limit` and `cursor` pagination. Child Runs created by Team Orchestration appear in this list like any other Run.
3a. `GET /api/health` returns HTTP 200 with `{status, version, plugins}` once the Kernel has registered every declared plugin and the database is reachable, and HTTP 503 otherwise. The Compose healthcheck for `armada-daemon` targets this endpoint.
4. `POST /api/runs/{run_id}/cancel` transitions the Run to `cancelled`, terminates the sandbox container, and aborts any in-flight model request.
5. `POST /api/runs/{run_id}/messages` appends a user message to an active Run, starting a new Turn.
6. A WebSocket client sends `{"subscribe": {"run_id": "..."}}` and receives every Event for that Run as it is appended, plus every Event already recorded for that Run, in `seq` order, before any new Event.
7. The gateway holds no per-connection Run state. Run state lives in Postgres; a client that reconnects and re-subscribes receives the full ordered stream again.

### Plugin Kernel
8. `services/daemon/src/kernel/types.ts` defines exactly these plugin interfaces: `ModelAdapter`, `ToolProvider`, `SandboxProvider`, `RetrievalProvider`, `EventSink`.
9. `ModelAdapter` exposes `chat(request: ChatRequest, signal: AbortSignal) -> AsyncIterable<ChatDelta>` and `capabilities() -> {toolCalling: boolean, contextWindow: number, toolFormat: 'json_schema' | 'hermes'}`.
10. `ToolProvider` exposes `list() -> ToolSpec[]` and `invoke(name: string, args: unknown, ctx: RunContext) -> Promise<ToolResult>`.
11. `SandboxProvider` exposes `acquire(spec: SandboxSpec) -> Promise<Sandbox>` and `release(sandbox: Sandbox) -> Promise<void>`; `Sandbox` exposes `exec`, `readFile`, `writeFile`, and `listDir`.
12. `RetrievalProvider` exposes `query(corpusId: string, text: string, k: number) -> Promise<Chunk[]>`.
13. `EventSink` exposes `append(event: Event) -> Promise<void>`.
14. The Kernel registers plugins from `config/plugins.yaml` at startup and fails startup with a non-zero exit code naming the plugin if a declared plugin fails to load or a required interface is unregistered.
15. The agent loop resolves every capability through the Kernel. It must not import a concrete implementation (for example `OllamaAdapter` or `DockerSandbox`) directly.

### Model Adapter
16. `OpenAICompatibleAdapter` is the only shipped `ModelAdapter`. It targets the base URL in `config/models.yaml` (default the `armada-models` service) and addresses models by ModelBinding `tag`.
17. The Run uses the `binding_tag`, `context_window`, and `tool_format` recorded in the Agent version's `resolved_snapshot`. The daemon does not re-resolve the Agent's model reference at Run start. At Run start it performs a liveness check only: it calls `armada-forge` `GET /models/bindings` and confirms the pinned `binding_tag` is present with `status: promoted`.
17a. Because bindings are pinned at Agent save time, a newly promoted Adapter does not change any existing Agent's behavior. An operator adopts a new Adapter by calling `POST /api/agents/{agent_id}/refresh-bindings`, which is owned by the Agent Definition spec and cuts a new Agent version.
18. When the liveness check finds the pinned `binding_tag` absent, or present with `status` `retired` or `missing`, Run start fails with outcome `failed` and an error naming the tag and the observed status; no sandbox is acquired.
18a. When `armada-forge` is unreachable during the liveness check, Run start fails with outcome `failed` naming the service. The daemon does not proceed on an unverified binding.
19. Model requests carry an `AbortSignal`. Cancelling a Run aborts the in-flight request rather than waiting for it to finish.

### Model Request Scheduling
20. The daemon routes all model requests through a scheduler that enforces a per-tag concurrency limit read from `config/models.yaml` (`max_concurrent_per_tag`, default 1) and a global limit (`max_concurrent_total`, default 2).
21. When a request exceeds a limit it waits in a FIFO queue for that tag. Queue admission is event-driven on request completion; the scheduler contains no timed polling and no fixed delays.
22. Time spent queued is recorded on the resulting `model_request` Event as `queued_ms` and does not count against the Run's wall-clock budget.

### Agent Loop
23. A Step builds the model context in this fixed order: system prompt, injected retrieval block (first Step of a Turn only), compacted history summary if present, retained history messages, and the current user message.
24. The loop dispatches every tool call the model emits in a Step. Tool calls within one Step run concurrently up to `max_concurrent_tools` (default 4); their results are appended to history in the order the model emitted them, not the order they completed.
25. The built-in `finish` tool takes `summary` (string, required) and `success` (boolean, required). Calling it terminates the Turn, and on the final Turn it sets the Run's outcome to `success` when `success` is true and `incomplete` when it is false. The `summary` becomes the Run's `result`.
25a. The loop also terminates a Turn when the model returns a message with no tool calls. A Run that terminates this way without `finish` ever having been called receives outcome `incomplete`, and its final assistant message becomes the `result`. A Run is never assigned `success` by default; `success` requires an explicit self-report.
25b. The rationale for Requirement 25a is that `armada-forge` builds trajectory training datasets exclusively from Runs with `outcome: success`. Defaulting a merely-terminated Run to `success` would train the next Adapter on every run that failed to crash.
26. Standard mode presents tools to the model as native function-call schemas in the format named by the binding's `tool_format`.
27. Code mode is opt-in per Agent. In Code mode, the daemon generates a TypeScript SDK declaring only the Agent's granted **sandbox-local** tools — `shell`, `read_file`, `write_file`, `list_dir`, and `finish` — writes it into the sandbox, and executes the model's returned program entirely inside the sandbox. A single program execution counts as one Step.
27a. Code mode has no callback channel from the sandbox into the daemon. MCP tools and `search_knowledge` are unavailable inside a Code-mode program, and the generated SDK does not declare them. This is what keeps the sandbox boundary one-directional.
27b. A Code-mode Agent that binds a Corpus still receives the auto-injected retrieval block on the first Step of each Turn (Requirement 39), because injection happens in the daemon before the program is generated. Only the on-demand `search_knowledge` tool is absent.
27c. The program communicates its result to the daemon by writing JSON to `/armada/code-mode/{step_id}.json` inside the sandbox, which the daemon reads after the process exits. The SDK's `finish(summary, success)` function does not call the daemon; it sets the `finish` field of that result object, which the program writes on exit. The daemon applies the outcome only after reading the file, so a program that calls `finish` and then crashes before writing the file does not terminate the Run.
28. When an Agent requests Code mode but its binding reports `toolCalling: false` or its `context_window` is below `config/models.yaml`'s `code_mode_min_context` (default 16384), the daemon starts the Run in Standard mode and appends a `mode_downgraded` Event naming the reason.
28a. When an Agent requests Code mode and grants MCP servers, those MCP tools are unavailable for the duration of the Run. The daemon appends one `mode_downgraded` Event at Run start listing every MCP tool excluded by Code mode, so the omission is recorded explicitly rather than inferred from their absence.
29. When the model emits a tool call whose name is not in the Agent's granted tool list, the daemon appends a `tool_result` Event with `is_error: true` and a message naming the unknown tool, and the loop continues. It does not terminate the Run.
30. When the model emits tool-call arguments that fail schema validation, the daemon appends a `tool_result` Event with `is_error: true` containing the validation error, and the loop continues.

### Termination Guarantees
31. Every Run carries four budgets, defaulted in `config/runtime.yaml` and overridable per Agent: `max_steps` (default 40), `max_model_tokens` (default 200000), `max_wall_clock_seconds` (default 1800), `max_tool_calls` (default 120).
31a. `config/runtime.yaml` also defines `budget_ceilings`, a hard upper bound for each of the four budget keys (defaults: `max_steps` 200, `max_model_tokens` 2000000, `max_wall_clock_seconds` 14400, `max_tool_calls` 600), and `tree_budget_ceilings` for the two cross-Run budgets that Team Orchestration defines (defaults: `tree_max_wall_clock_seconds` 28800, `tree_max_model_tokens` 6000000). An Agent may lower a budget below the default but may not raise one above its ceiling; the Agent Definition spec enforces this at save time and the daemon clamps to the ceiling at Run start whenever a snapshot exceeds it — which can happen when a ceiling in `config/runtime.yaml` is lowered after an Agent version was pinned — appending an `error` Event naming the budget, the snapshot value, and the ceiling.
32. When any budget is exhausted the Run terminates with outcome `budget_exhausted` and a `run_end` Event naming which budget was hit.
33. A no-progress detector terminates the Run with outcome `no_progress` when the same tool name and byte-identical arguments are invoked in `no_progress_threshold` (default 3) consecutive Steps.
33a. In Code mode a Step is one program rather than a tool call, so the detector compares the byte-identical source of the generated program across consecutive Steps and terminates on the same threshold.
34. Budget checks occur before each Step and before each tool dispatch, so a budget can never be exceeded rather than merely detected afterwards.

### Context Management
35. The context builder computes a token budget from the binding's `context_window` minus `reserved_output_tokens` (default 2048) and must produce a context that fits within it.
36. When retained history would exceed the budget, the oldest messages are compacted: the daemon summarizes them in a single model call against the same binding and replaces them with one `summary` message. The most recent `always_retain_messages` (default 6) messages are never compacted.
37. Every compaction appends a `compaction` Event recording `messages_compacted`, `tokens_before`, and `tokens_after`.
38. When a single tool result exceeds `max_tool_result_tokens` (default 4096), it is truncated at that limit, marked `truncated: true`, and the full result is written to the sandbox at `/armada/tool-results/{event_id}.txt` so the agent can read it in slices. The truncated result appended to history names that path.

### Retrieval
39. When an Agent has a bound `corpus_id`, the first Step of every Turn issues a `RetrievalProvider.query` against that corpus using the user message text with `k` equal to `auto_inject_k` (default 4), and injects the returned chunks as a system-role block containing each chunk's `source_path` and `content`.
40. Every Standard-mode Agent with a bound `corpus_id` also receives the built-in `search_knowledge(query: string, k?: number)` tool, callable on any Step, with `k` capped at `search_max_k` (default 10). Code-mode Agents do not receive it, per Requirement 27a; they rely on the auto-injected block alone.
41. `PgVectorRetrievalProvider` performs hybrid retrieval: a cosine-distance vector search and a `tsvector` full-text search, each returning `k * 3` candidates, fused with Reciprocal Rank Fusion at `rrf_k` (default 60), returning the top `k`.
42. Every retrieval, whether auto-injected or tool-invoked, appends a `retrieval` Event recording the query text, `k`, and the returned `chunk_id` list with fused scores.
43. When an Agent has no bound `corpus_id`, no retrieval block is injected and `search_knowledge` is not present in its tool list.

### Sandboxing
44. `DockerSandboxProvider` acquires one container per Run from the profile named by the Agent, defined in `config/sandbox-profiles.yaml` with fields `image`, `cpu_limit`, `memory_limit`, `network` (one of `none`, `egress_allowlist`), `allowed_hosts` (list of strings), `read_only_root` (bool), `armada_tmpfs_size` (string, default `64m`), `timeout_seconds`.
44a. Every sandbox mounts a writable tmpfs at `/armada` sized `armada_tmpfs_size`, regardless of `read_only_root`. This is where oversize tool results (Requirement 38) and Code-mode artifacts (Requirement 27c) are written, so `read_only_root: true` never disables either mechanism. `/armada` is discarded with the container and its contents are never part of the workspace.
45. The Run's `workspace_path` is bind-mounted at `/workspace` inside the container and is the container's working directory. Apart from `/workspace` and the `/armada` tmpfs, no host path is mounted.
46. The container runs as a non-root UID, has no access to the Docker socket, and drops all Linux capabilities not required by the profile.
47. When `network` is `egress_allowlist`, only hosts in `allowed_hosts` are reachable; all other egress is refused.
48. The sandbox is released and the container removed when the Run reaches any terminal outcome, including `cancelled` and process crash recovery on daemon restart.
49. Built-in tools `shell`, `read_file`, `write_file`, and `list_dir` execute exclusively through the `Sandbox` interface and have no host filesystem access path.

### MCP
50. An Agent may grant MCP servers listed in `config/mcp-servers.yaml`, each with `name`, `transport` (one of `stdio`, `http`), `command` or `url`, and `env_keys` (list of environment variable names).
51. `McpToolProvider` connects to each granted server at Run start, lists its tools, and namespaces them as `{server_name}__{tool_name}` in the Agent's tool list.
52. MCP server credentials are read from environment variables named in `env_keys` and are never persisted to the database or written into any Event.
53. When an MCP server fails to connect at Run start, the daemon appends an `mcp_unavailable` Event naming the server and continues the Run without that server's tools rather than failing the Run.

### Run Records
53a. `db/migrations/005_runs_events.sql` owns the `runs` table with columns `run_id` (uuid), `agent_version_id` (uuid, required, the pinned Agent version the Run executed against), `workspace_path` (text, nullable), `status` (one of `running`, `terminal`), `outcome` (nullable until termination), `result` (text, nullable), `mode` (one of `standard`, `code`), budget counters, `started_at`, `ended_at`. It runs after `004_agents.sql` because `agent_version_id` carries a real foreign key to `agent_versions`.
53c. `005_runs_events.sql` also declares the delegation columns `parent_run_id`, `delegation_id`, `is_team_run`, and `team_version_id` as nullable from the start, so `GET /api/runs` (Requirement 3b) is complete without Team Orchestration's migration. `006_teams.sql` adds only the `team_version_id` foreign key and the Team tables; it adds no columns to `runs` and does not redefine it.
53b. `agent_version_id` is written at Run creation and never updated. It is the only link between a Run and the definition that produced it.

### Event Log
54. Events are appended to the `events` table with `event_id` (uuid), `run_id` (uuid), `seq` (bigint, monotonic and gapless per Run), `type`, `payload` (jsonb), `created_at` (timestamptz). The table is append-only; no code path updates or deletes an Event.
55. `type` is one of: `run_start`, `user_message`, `model_request`, `model_response`, `reasoning`, `tool_call`, `tool_result`, `retrieval`, `compaction`, `mode_downgraded`, `mcp_unavailable`, `delegation`, `error`, `run_end`.
56. `model_request` and `model_response` Events record `tag`, `prompt_tokens`, `completion_tokens`, and `queued_ms`.
57. `run_end` records the terminal `outcome`, the budget counters at termination, and, for `budget_exhausted`, which budget was hit.
58. `seq` is assigned by a transactional counter per `run_id` so concurrent tool completions cannot produce duplicate or out-of-order `seq` values.
59. Event payloads containing values sourced from environment variables named in any `env_keys` or `api_key_env` configuration are written with those values replaced by `[redacted]`.

## Data Flow
1. Dashboard calls `POST /api/runs` with `agent_id` and `task`; the daemon loads the validated Agent from the `agents` table.
2. The daemon inserts a `runs` row with `status: running`, appends a `run_start` Event, and returns `run_id`.
3. The daemon reads `binding_tag`, `context_window`, and `tool_format` from the Agent version's `resolved_snapshot`, then calls `armada-forge` `GET /models/bindings` once to confirm the pinned tag is present and `promoted`, failing the Run if it is not.
4. `SandboxProvider.acquire` starts a container from the Agent's sandbox profile with `workspace_path` bind-mounted at `/workspace`.
5. `McpToolProvider` connects to each granted MCP server and lists its tools; the Kernel merges built-in tools, `search_knowledge` if a corpus is bound, and namespaced MCP tools into the Agent's tool list.
6. The daemon appends a `user_message` Event carrying `task`, beginning the first Turn.
7. First Step of the Turn: `RetrievalProvider.query` runs hybrid search against the bound corpus; a `retrieval` Event is appended and the chunks are injected as a system-role block.
8. The context builder assembles system prompt, retrieval block, summary, retained history, and user message within the token budget, compacting and appending a `compaction` Event if needed.
9. The scheduler admits the model request under the per-tag limit; the adapter streams the response; `model_request` and `model_response` Events are appended with token counts and `queued_ms`.
10. If the response contains tool calls, each is validated against its schema, a `tool_call` Event is appended, and `ToolProvider.invoke` dispatches it — built-in tools into the Sandbox, MCP tools to their server.
11. Each result is appended as a `tool_result` Event in model-emission order, truncated and spilled to `/armada/tool-results/{event_id}.txt` if oversize.
12. Budgets are re-checked and the no-progress detector evaluated; the loop returns to step 8 for the next Step.
13. The Turn ends when the model calls `finish(summary, success)` or returns a message with no tool calls. In the first case the outcome is `success` or `incomplete` per the `success` argument and `result` is the `summary`; in the second the outcome is `incomplete` and `result` is the final assistant message.
14. On terminal outcome the daemon appends `run_end`, calls `SandboxProvider.release` which destroys the container and its `/armada` tmpfs, disconnects MCP servers, and sets the `runs` row `status`, `outcome`, and `result`.
15. `armada-forge` later reads `events` for Runs whose `run_end` records `outcome: success` to build trajectory datasets. Runs with any other outcome, including `incomplete`, are never used as training data.

## Edge Cases
1. When the model server is unreachable at Run start, the Run terminates `failed` with an error naming the endpoint, and no sandbox container is created.
2. When the model server becomes unreachable mid-Run, the current Step fails, an `error` Event is appended, and the Run terminates `failed`; the sandbox is still released.
3. When the model returns malformed JSON in a tool call, the daemon appends a `tool_result` with `is_error: true` describing the parse failure and the loop continues, counting toward `max_steps`.
4. When the model emits the same failing tool call with identical arguments for `no_progress_threshold` consecutive Steps, the Run terminates `no_progress` rather than looping until `max_steps`.
5. When a tool call runs longer than the sandbox profile's `timeout_seconds`, the process is killed, a `tool_result` with `is_error: true` and `timed_out: true` is appended, and the loop continues.
6. When the sandbox container exits unexpectedly mid-Run, the next tool dispatch fails, an `error` Event is appended, and the Run terminates `failed`. The daemon does not silently start a replacement container.
7. When `workspace_path` does not exist on the host, Run start fails with outcome `failed` naming the path, before the container is created.
8. When two Runs specify the same `workspace_path`, both proceed; Armada does not lock workspaces. The `run_start` Event records the path so concurrent mutation is attributable.
9. When the bound corpus has zero chunks, retrieval returns an empty list, no retrieval block is injected, a `retrieval` Event with an empty `chunk_id` list is still appended, and the Run proceeds.
10. When a retrieval query fails (database unreachable), an `error` Event is appended, the Step proceeds without a retrieval block, and the Run is not terminated.
11. When auto-injected chunks alone exceed the context budget, chunks are dropped from lowest fused score upward until the block fits, and the `retrieval` Event records `chunks_dropped`.
12. When compaction itself would require more context than the budget allows, the daemon drops the oldest non-retained messages without summarizing, records `compaction` with `messages_compacted` and `tokens_after`, and sets `summarized: false`.
13. When the daemon restarts with Runs in `status: running`, each such Run is marked `failed` with an `error` Event reading `daemon restarted during run`, and any orphaned sandbox container labelled with that `run_id` is removed on startup.
14. When a WebSocket client subscribes to a `run_id` that has already completed, it receives the full recorded Event stream in `seq` order and then a close signal, not an error.
15. When a WebSocket client disconnects mid-Run, the Run continues unaffected; Events continue to be appended.
16. When `POST /api/runs/{run_id}/cancel` is called on an already-terminal Run, it returns HTTP 409 naming the existing outcome and does not append a second `run_end`.
17. When an MCP server disconnects mid-Run, subsequent calls to its tools return `tool_result` with `is_error: true` naming the server; the Run is not terminated.
18. When two MCP servers expose the same tool name, namespacing by `{server_name}__{tool_name}` keeps them distinct; two servers configured with the same `name` cause startup to fail naming the collision.
19. When an Agent grants zero tools, the loop still runs and terminates on the first model response with no tool calls.
20. When the `finish` tool is called with an empty `summary`, the Turn still terminates and `run_end` records the outcome from the `success` argument with an empty `result`.
20a. When `finish` is called with `success: false`, the Run terminates with outcome `incomplete`, not `failed`. `failed` is reserved for infrastructure faults; `incomplete` means the agent ran correctly and reported it did not achieve the task.
20b. When `finish` is called with a missing or non-boolean `success` argument, the call fails schema validation, a `tool_result` with `is_error: true` is appended, and the loop continues. The Turn does not terminate on a malformed `finish`.
20c. When `finish` is called on a Turn that is not the final Turn — the operator posts another user message afterwards — the outcome recorded at that `finish` is superseded by the outcome of the last Turn. Only the terminal state of the Run is recorded in `run_end`.
20d. When a Run terminates by budget, cancellation, no-progress, or infrastructure fault, the self-report is irrelevant and the outcome is `budget_exhausted`, `cancelled`, `no_progress`, or `failed` respectively. `success` can only ever come from `finish`.
21. When a Run is cancelled while a tool call is in flight, the tool process is killed, a `tool_result` with `cancelled: true` is appended, and then `run_end` with outcome `cancelled`.
22. When Code mode is active and the model's program throws, the thrown error is returned as the Step's tool result with `is_error: true` and the loop continues.
23. When Code mode is active and the model's program contains no SDK calls, the Step counts toward `max_steps` and the loop continues.
24. When Code mode is active and the program exits without writing `/armada/code-mode/{step_id}.json`, the Step's result is `is_error: true` naming the missing file, and the loop continues. The daemon does not infer a result from stdout.
25. When Code mode is active and the program writes malformed JSON to that path, the result is `is_error: true` containing the parse error and the first 512 bytes of the file.
26. When a Code-mode program calls a function name resembling an MCP tool or `search_knowledge`, it fails inside the sandbox as an undefined reference, because the generated SDK never declares them. No request reaches the daemon.
27. When `/armada` fills to `armada_tmpfs_size` — a tool result larger than the tmpfs, or many oversize results in one Run — the spill write fails, the tool result is appended truncated with `spill_failed: true`, and the Run continues. A full tmpfs never terminates a Run.
28. When the Agent's snapshot carries a budget above its ceiling in `config/runtime.yaml`, the daemon clamps it at Run start and appends an `error` Event naming the budget, the requested value, and the ceiling; the Run proceeds under the clamped value.

## Acceptance Criteria
- [ ] `docker compose up` starts `armada-daemon`; `GET /api/health` returns 200 and the process listens on exactly one port serving both `/api/*` and `/ws`.
- [ ] Starting a Run against an Agent with no corpus and only built-in tools produces `events` rows with gapless `seq` starting at 1.
- [ ] A Run whose agent calls `finish(summary, success: true)` records outcome `success`; a Run whose agent calls `finish(summary, success: false)` records outcome `incomplete`, not `failed`.
- [ ] A Run whose model simply stops emitting tool calls without ever calling `finish` records outcome `incomplete`, and `armada-forge` excludes it from a trajectory dataset built over that Agent.
- [ ] A Run terminated by `max_steps` records `budget_exhausted` even though its agent had earlier called `finish(success: true)` on a prior Turn.
- [ ] A `finish` call missing the `success` argument produces a `tool_result` with `is_error: true` and the Run continues.
- [ ] Starting a Run whose Agent snapshot pins a `binding_tag` that has since been retired fails with outcome `failed` naming the tag and its status, and `docker ps` shows no container was created.
- [ ] Promoting a new Adapter does not change the `binding_tag` used by an existing Agent's Runs until `POST /api/agents/{agent_id}/refresh-bindings` is called.
- [ ] In a Code-mode Run, the generated SDK file inside the sandbox declares only `shell`, `read_file`, `write_file`, `list_dir`, and `finish`, and declares no MCP tool and no `search_knowledge`.
- [ ] A Code-mode Run for an Agent granting MCP servers appends one `mode_downgraded` Event at Run start listing every excluded MCP tool.
- [ ] A Code-mode Run for an Agent binding a Corpus still produces a `retrieval` Event on the first Step of each Turn.
- [ ] A Code-mode program that exits without writing `/armada/code-mode/{step_id}.json` yields an error result naming the missing file and the loop continues.
- [ ] Inspecting a running sandbox with `read_only_root: true` shows `/` read-only and `/armada` writable as tmpfs, and an oversize tool result is readable at `/armada/tool-results/{event_id}.txt`.
- [ ] An Agent snapshot carrying `max_steps` above its ceiling is clamped at Run start with an `error` Event naming the requested value and the ceiling.
- [ ] `GET /api/health` returns 503 before plugin registration completes and 200 after, and the Compose healthcheck for `armada-daemon` gates dependent services on it.
- [ ] `GET /api/runs/{run_id}` returns a `result` and an `agent_version_id` for a terminated Run.
- [ ] A shell tool call attempting to read `/etc/hostname` of the host returns the container's file, and attempting to read a host path outside `/workspace` fails.
- [ ] The sandbox container runs as a non-root UID and has no Docker socket mounted, verified by inspecting the running container.
- [ ] With `network: none`, a shell tool call attempting outbound HTTP fails; with `egress_allowlist`, a request to a listed host succeeds and a request to an unlisted host fails.
- [ ] A Run whose Agent sets `max_steps: 3` terminates with outcome `budget_exhausted` and a `run_end` Event naming `max_steps`.
- [ ] An Agent whose model repeats one identical tool call terminates with outcome `no_progress` in exactly `no_progress_threshold` Steps.
- [ ] Cancelling an in-flight Run terminates the container within the request and `docker ps` shows no container labelled with that `run_id`.
- [ ] Restarting the daemon with a Run in flight marks that Run `failed` and removes its orphaned container on startup.
- [ ] Subscribing over WebSocket after a Run completes replays every Event in `seq` order.
- [ ] Two WebSocket clients subscribed to the same Run receive identical Event sequences.
- [ ] An Agent bound to a corpus produces a `retrieval` Event on the first Step of each Turn and has `search_knowledge` in its tool list; an Agent with no corpus produces neither.
- [ ] Forcing history past the context budget produces a `compaction` Event and the subsequent model request's `prompt_tokens` is below `context_window` minus `reserved_output_tokens`.
- [ ] A tool result exceeding `max_tool_result_tokens` is truncated in the Event and readable in full at `/armada/tool-results/{event_id}.txt` inside the sandbox.
- [ ] With `max_concurrent_per_tag: 1`, two concurrent Runs on the same tag produce `model_request` Events with non-zero `queued_ms` on the later request, and neither Run's wall-clock budget is charged for queue time.
- [ ] An Agent requesting Code mode against a binding with `context_window` below `code_mode_min_context` produces a `mode_downgraded` Event and completes in Standard mode.
- [ ] Grepping the `events` table for the value of any configured MCP credential returns no matches.
- [ ] Replacing the `RetrievalProvider` entry in `config/plugins.yaml` with a stub changes retrieval behavior without any edit to `services/daemon/src/runtime/agent-loop.ts`.

## Key Files
- `services/daemon/src/index.ts` — new file, process entry, kernel bootstrap, plugin registration
- `services/daemon/src/gateway/server.ts` — new file, single-port HTTP + WS listener and `/api/*` routes
- `services/daemon/src/gateway/ws-router.ts` — new file, subscription handling and ordered Event replay
- `services/daemon/src/kernel/kernel.ts` — new file, plugin host and capability resolution
- `services/daemon/src/kernel/plugin-registry.ts` — new file, loads `config/plugins.yaml`, fails startup on missing interfaces
- `services/daemon/src/kernel/types.ts` — new file, the five plugin interfaces and shared types
- `services/daemon/src/runtime/agent-loop.ts` — new file, Step execution, tool dispatch, termination
- `services/daemon/src/runtime/context-builder.ts` — new file, fixed-order context assembly within token budget
- `services/daemon/src/runtime/compaction.ts` — new file, oldest-first summarization with retained tail
- `services/daemon/src/runtime/budgets.ts` — new file, budget accounting and pre-Step/pre-dispatch checks
- `services/daemon/src/runtime/no-progress.ts` — new file, repeated identical tool-call detector
- `services/daemon/src/runtime/code-mode.ts` — new file, sandbox-local SDK generation, in-container execution, result-file parsing
- `services/daemon/src/runtime/outcome.ts` — new file, terminal outcome assignment and self-report handling
- `services/daemon/src/models/openai-compatible.ts` — new file, streaming adapter with abort support
- `services/daemon/src/models/scheduler.ts` — new file, per-tag and global concurrency queue
- `services/daemon/src/models/binding-verifier.ts` — new file, liveness check of a pinned `binding_tag` against `armada-forge`
- `services/daemon/src/gateway/routes/health.ts` — new file, `GET /api/health` plugin and database readiness
- `services/daemon/src/gateway/routes/runs.ts` — new file, run start, fetch, cancel, and message endpoints
- `services/daemon/src/tools/registry.ts` — new file, tool list assembly and schema validation
- `services/daemon/src/tools/builtin/shell.ts` — new file, sandboxed shell tool
- `services/daemon/src/tools/builtin/files.ts` — new file, `read_file`, `write_file`, `list_dir`
- `services/daemon/src/tools/builtin/search-knowledge.ts` — new file, retrieval tool
- `services/daemon/src/tools/builtin/finish.ts` — new file, explicit termination tool
- `services/daemon/src/tools/mcp-client.ts` — new file, stdio and http MCP transports, namespacing, credential handling
- `services/daemon/src/sandbox/docker-sandbox.ts` — new file, container lifecycle, limits, network policy, orphan cleanup
- `services/daemon/src/retrieval/pgvector-provider.ts` — new file, hybrid vector + full-text retrieval with RRF
- `services/daemon/src/events/event-log.ts` — new file, transactional `seq` assignment, append-only writes, redaction
- `services/daemon/src/events/types.ts` — new file, Event type union and payload shapes
- `config/plugins.yaml` — new file, plugin selection per interface
- `config/runtime.yaml` — new file, budget and context defaults
- `config/models.yaml` — new file, model endpoint, concurrency limits, `code_mode_min_context`
- `config/sandbox-profiles.yaml` — new file, sandbox profile definitions
- `config/mcp-servers.yaml` — new file, available MCP servers
- `db/migrations/005_runs_events.sql` — new file, `runs` and `events` tables, per-run `seq` counter, nullable delegation columns
- `services/daemon/Dockerfile` — new file, Node image with Docker client for sandbox provisioning
- `docker-compose.yml` — adds `armada-daemon` and `armada-db` services
