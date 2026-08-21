# Spec: Team Orchestration

## Overview
A Team is a declarative document naming one manager Agent and a roster of worker Agents. On a Team Run, the manager decomposes the task and delegates subtasks to workers through a `delegate` tool; each delegation executes as a child Run with its own sandbox and event stream, and the manager synthesizes the results into a single answer. This is the layer that lets several specialized SLMs share one CPU-bound model server without starving each other.

## Goals
- Let an operator compose existing Agents into a Team with no code and no changes to those Agents.
- Give the manager a way to pick a worker by declared capability rather than by hardcoded name.
- Guarantee that a Team Run terminates, bounded across the whole tree rather than per-Run.
- Keep every child Run independently inspectable while presenting one coherent stream for the Team Run.
- Share a single CPU-bound model server across concurrent workers without deadlock or unbounded queueing.

## Non-Goals
- Worker-to-worker communication, peer delegation, or a shared blackboard. All coordination passes through the manager.
- Delegation deeper than one level. A worker cannot delegate.
- Dynamic team membership. The roster is fixed at Run start from the Team's pinned version.
- Automatic team composition or capability inference. The operator declares the roster and each Agent declares its own `capabilities`.
- Replacing the Run primitive. A child Run is an ordinary Run as defined in Agent Runtime.

## Definitions
- **Team Run** — the root Run, executed by the manager Agent. Its `run_id` is the parent of every child Run.
- **Child Run** — one delegation, executed by a worker Agent. An ordinary Run with `parent_run_id` set and `delegation_id` recorded.
- **Roster** — the resolved list of worker Agent versions available to the manager for a given Team Run.
- **Tree budget** — a budget accounted across the Team Run and every child Run together, as opposed to a per-Run budget.

## Requirements

### Team Schema
1. A Team definition is YAML with top-level keys: `schema_version` (int, must equal 1), `name` (string, `^[a-z0-9-]+$`, unique, immutable), `display_name`, `description`, `manager`, `workers`, `limits`.
2. `manager` has `agent_name` (string, required) and `synthesis_prompt` (string, optional, appended to the manager's persona for the final synthesis Step).
3. `workers` is a list of at least one entry, each with `agent_name` (string, required) and `alias` (string, optional, defaults to `agent_name`, unique within the Team).
4. `limits` has `max_delegations` (int, default 12), `max_concurrent_delegations` (int, default 2), `tree_max_wall_clock_seconds` (int, default 3600), `tree_max_model_tokens` (int, default 600000), and `per_delegation_budgets` (object with any subset of the Agent Runtime budget keys, overriding each worker's own budgets for this Team only).
5. The Team schema is closed. Any unknown key at any level fails validation naming the key path.
6. Validation fails if `manager.agent_name` or any `workers[].agent_name` does not resolve to a non-deleted Agent, naming the unresolved name.
7. Validation fails if `manager.agent_name` also appears in `workers`, naming the conflict.
8. Validation fails if any two workers resolve to the same `alias`, naming the collision.
9. Validation fails if any worker Agent has an empty `capabilities` list, naming the worker, because it could never be matched by capability.
9a. Validation fails if any value in `limits.per_delegation_budgets` is less than 1 or exceeds its `budget_ceilings` entry in `config/runtime.yaml`, naming the budget and the ceiling. A Team may lower a worker's budget but may not raise it past the platform ceiling.
9b. Validation fails if `tree_max_wall_clock_seconds` or `tree_max_model_tokens` is less than 1 or exceeds its `tree_budget_ceilings` entry in `config/runtime.yaml` (defaults: `tree_max_wall_clock_seconds` 28800, `tree_max_model_tokens` 6000000), naming the budget and the ceiling.
9c. Validation fails if `tree_max_model_tokens` is lower than the largest `max_model_tokens` any single roster member could consume under the merged budget precedence of Requirement 22, naming both values, because the tree budget would be exhausted by one delegation.
10. Teams are persisted in `teams` and `team_versions` with the same immutable-version semantics as Agents: every save creates a new version capturing the `definition` and a `resolved_roster` snapshot pinning each member's `agent_version_id`.

### The `delegate` Tool
11. On a Team Run, and only on a Team Run, the manager's tool list additionally contains `delegate(worker: string, task: string, context?: string)` and `list_workers()`.
12. `list_workers()` returns each roster entry's `alias`, `display_name`, `description`, and `capabilities`. It does not return the worker's persona, model tag, or tool list.
13. `delegate` resolves `worker` first as an exact `alias` match. When no alias matches, it resolves as a capability match: roster entries whose `capabilities` contain the string, case-insensitively. A single match is used; zero or multiple matches are an error result.
14. `delegate` starts a child Run against the matched worker's pinned `agent_version_id`, passing `task` as the child's user message and `context` as an additional system-role block when present.
15. `delegate` returns only after the child Run reaches a terminal outcome. Its `ToolResult` carries the child's `outcome`, the child's final assistant message, the child `run_id`, and the child's token and step counts.
16. When the child's outcome is not `success`, `delegate` returns `is_error: true` with the outcome and the child's terminal error, and the manager's loop continues. A failed delegation does not terminate the Team Run.
17. Concurrent `delegate` calls emitted in one manager Step run concurrently up to `limits.max_concurrent_delegations`; excess calls queue and are admitted as earlier delegations terminate.
18. `delegate` is never present in a worker's tool list. A worker attempting to call it receives the runtime's unknown-tool error result.

### Child Run Semantics
19. A child Run has `parent_run_id` set to the Team Run's `run_id` and `delegation_id` set to the `event_id` of the manager's `tool_call` Event that created it.
20. Each child Run acquires its own sandbox from its own Agent's profile. Workers do not share a sandbox with the manager or with each other.
21. When the Team Run specifies `workspace_path`, every child Run bind-mounts that same host path at `/workspace`. Workers therefore see each other's file writes; the manager is responsible for sequencing conflicting work.
22. A child Run's budgets are `limits.per_delegation_budgets` merged over the worker Agent's own `runtime.budgets`, merged over `config/runtime.yaml` defaults, in that precedence order.
23. Cancelling the Team Run cancels every in-flight child Run, terminating each child's sandbox before the Team Run's `run_end` is appended.
24. A child Run appears in `GET /api/runs` and is independently subscribable over WebSocket by its own `run_id`.

### Tree Budgets and Termination
25. `tree_max_wall_clock_seconds` and `tree_max_model_tokens` are accounted across the Team Run and all child Runs. Each child reports its consumption to the tree accountant as it accrues, not only at termination.
26. When a tree budget is exhausted, the daemon cancels every in-flight child Run and terminates the Team Run with outcome `budget_exhausted`, naming which tree budget was hit.
27. `max_delegations` counts every `delegate` call across the Team Run, including failed and cancelled ones. Exceeding it makes further `delegate` calls return `is_error: true` naming the limit; it does not terminate the Team Run, which then proceeds to synthesis.
28. Tree budget checks occur before a child Run is created, so a child is never started against an already-exhausted budget.
29. A worker whose Agent version has `runtime.mode: code` runs in Code mode as an ordinary Run; Team Orchestration adds no constraint on workers.
29a. The manager Agent must have `runtime.mode: standard`. Team validation fails naming the manager when its pinned version has `runtime.mode: code`, because `delegate` and `list_workers` are daemon-side tools and a Code-mode program executes inside the sandbox with no callback channel into the daemon. A Code-mode manager could never delegate.
30. The no-progress detector applies within each Run independently. Additionally, when the manager issues `no_progress_threshold` consecutive `delegate` calls with byte-identical `worker` and `task` arguments, the Team Run terminates with outcome `no_progress`.

### Model Scheduling Across a Team
31. Child Runs submit model requests to the same scheduler defined in Agent Runtime, subject to the same `max_concurrent_per_tag` and `max_concurrent_total` limits.
32. The manager's model requests are admitted at a higher priority than workers' requests for the same tag, so a manager waiting to synthesize is not starved behind queued workers.
33. `max_concurrent_delegations` must not exceed `max_concurrent_total` from `config/models.yaml`. Team validation fails naming both values when it does, because the excess delegations could never make progress concurrently.
34. Queue wait time inside a child Run is charged to neither the child's nor the tree's wall-clock budget, consistent with the Agent Runtime scheduler contract.

### Synthesis
35. After the manager's loop terminates, the daemon issues one final synthesis Step: the manager's persona plus `manager.synthesis_prompt`, the original task, and a structured digest of every delegation containing `alias`, `task`, `outcome`, and final message.
36. The synthesis Step is subject to the tree budgets. When a tree budget is already exhausted, synthesis is skipped and the Team Run's final output is the digest itself, with `run_end` recording `synthesis_skipped: true`.
37. The synthesis result is written as the Team Run's final assistant message and is what `GET /api/runs/{run_id}` returns as `result`.
38. A Team Run's outcome is `success` only when both conditions hold: the manager called `finish(summary, success: true)`, and synthesis completed. When the manager called `finish` with `success: false`, or terminated without calling `finish`, the Team Run's outcome is `incomplete` even if synthesis completed normally.
38a. Delegation failures do not by themselves determine the Team Run's outcome. A Team Run in which every delegation failed is `success` if the manager nonetheless self-reported success and synthesis completed — the manager is the authority on whether the task was met.
38b. Because a Team Run's outcome follows the same self-report rule as any Run, `armada-forge` treats a Team Run's own event stream as a trajectory candidate only when it is `success`. Child Runs are evaluated independently on their own outcomes, so a failed child never enters training data even when its parent succeeded.

### API, Events, and Dashboard
39. `POST /api/teams`, `PUT /api/teams/{team_id}`, `GET /api/teams`, `GET /api/teams/{team_id}?version=N`, and `POST /api/teams/{team_id}/validate` mirror the Agent endpoints, including full-error-list responses and no persistence on failure.
40. `POST /api/team-runs` starts a Team Run with `team_id`, `task`, and optional `workspace_path`, returning the Team Run's `run_id`.
41. Teams are also file-loaded from `teams/*.yaml` on startup and on file change, with the same upsert-by-`name`, collision, and skip-on-invalid behavior as Agents.
42. A `delegation` Event is appended to the Team Run when a child Run is created, recording `delegation_id`, `alias`, `child_run_id`, and the resolved `agent_version_id`; and again on child termination with `outcome` and consumption counts.
43. Subscribing to a Team Run's `run_id` over WebSocket streams the Team Run's own Events. Child Events are not interleaved into that stream; a client follows a child by subscribing to its `child_run_id` from the `delegation` Event.
44. `armada-dashboard` renders a Team Run as a tree: the manager's stream with each delegation expandable into its child Run's stream, showing per-child outcome, tokens, and wall-clock.
45. `teams/frontend-feature-team.yaml` ships as a working example with a manager and at least two workers drawn from the shipped Agents.

## Data Flow
1. Operator defines a Team in the dashboard or drops a YAML file into `teams/`; validation resolves the manager and every worker to Agent versions and pins them into `resolved_roster`.
2. Operator calls `POST /api/team-runs` with `team_id`, `task`, and `workspace_path`.
3. The daemon creates the Team Run's `runs` row with `is_team_run: true` and the pinned `team_version_id`, appends `run_start`, and initializes the tree accountant with `tree_max_wall_clock_seconds` and `tree_max_model_tokens`.
4. The daemon starts the manager's Run against its pinned `agent_version_id`, adding `delegate` and `list_workers` to its tool list.
5. The manager's first Step proceeds as an ordinary Run Step, including retrieval if the manager Agent binds a corpus.
6. The manager calls `list_workers()` and receives each roster entry's `alias`, `display_name`, `description`, and `capabilities`.
7. The manager emits one or more `delegate` calls. For each, the daemon checks `max_delegations` and the tree budgets, then resolves `worker` by alias and then by capability.
8. For each admitted delegation the daemon appends a `delegation` Event, creates a child Run with `parent_run_id` and `delegation_id`, and acquires that worker's own sandbox against the shared `workspace_path`.
9. Delegations beyond `max_concurrent_delegations` wait in a queue and are admitted as earlier child Runs terminate.
10. Each child Run executes the ordinary agent loop, submitting model requests to the shared scheduler at worker priority and reporting token and wall-clock consumption to the tree accountant as it accrues.
11. On child termination the daemon releases the child's sandbox, appends a second `delegation` Event with the outcome and counts, and returns the `ToolResult` to the manager's loop.
12. The manager continues stepping, delegating further or terminating its own loop.
13. The daemon issues the synthesis Step with the manager persona, `synthesis_prompt`, the original task, and the delegation digest.
14. The daemon appends `run_end` for the Team Run with its outcome, the tree budget counters, and the synthesis result as the final assistant message.
15. `armada-forge` may later read the Team Run and its child Runs from `events` for trajectory dataset construction; each child Run is flattened as its own sample.

## Edge Cases
1. When the manager never calls `delegate`, the Team Run completes as an ordinary Run and synthesis runs over an empty digest, producing outcome `success`.
2. When `delegate` names a worker matching neither an alias nor any capability, the result is `is_error: true` listing the available aliases, and the manager's loop continues.
3. When `delegate` names a capability matching two or more workers, the result is `is_error: true` naming every match and instructing the manager to use an alias. No worker is started.
4. When a child Run terminates `budget_exhausted`, the manager receives `is_error: true` with that outcome and may delegate a narrower subtask; the Team Run is unaffected.
5. When every delegation fails, synthesis still runs over a digest of failures and the Team Run's outcome is `success` provided synthesis completed.
6. When a tree budget is exhausted while three child Runs are in flight, all three are cancelled, all three sandboxes are removed, and the Team Run terminates `budget_exhausted`.
7. When the Team Run is cancelled by the operator, in-flight child Runs are cancelled first and their `run_end` Events are appended before the Team Run's `run_end`.
8. When a child Run's sandbox fails to acquire, `delegate` returns `is_error: true` naming the sandbox profile and the failure; no child Run row is left in `running`.
9. When two workers write the same file in the shared workspace concurrently, Armada does not arbitrate. Both writes are recorded in their respective child Event streams and the last write wins.
10. When a worker Agent is edited between Team Run start and a later delegation, the pinned `agent_version_id` is still used, so all delegations within one Team Run target the same worker version.
11. When a worker Agent is deleted after the Team was saved, Team Run start fails naming the worker, before any sandbox is created; the Team record remains but is flagged with `warnings: ["worker_missing"]` in `GET /api/teams`.
12. When `max_concurrent_delegations` exceeds `max_concurrent_total`, Team validation fails at save time naming both values.
13. When the manager and a worker resolve to the same ModelBinding tag with `max_concurrent_per_tag: 1`, the worker's request queues behind the manager's; manager priority prevents the reverse starvation. The worker's `model_request` Event records non-zero `queued_ms` and the manager's records zero, and neither charges queue time to its wall-clock budget.
14. When the daemon restarts with a Team Run in flight, the Team Run and every child Run are marked `failed` with `daemon restarted during run`, and every orphaned container labelled with any of those `run_id` values is removed on startup.
15. When `max_delegations` is reached, further `delegate` calls return `is_error: true` naming the limit and the manager proceeds to synthesis rather than the Run terminating.
16. When the manager emits `no_progress_threshold` identical `delegate` calls, the Team Run terminates `no_progress` and any in-flight child Runs are cancelled.
17. When synthesis itself fails because the model server is unreachable, the Team Run terminates `failed` with the delegation digest retained as the final message and `synthesis_skipped: false`.
18. When the delegation digest exceeds the manager binding's context budget, the digest is compacted by the ordinary context-builder path and a `compaction` Event is appended before synthesis.
19. When a client subscribes to a Team Run, it receives `delegation` Events carrying `child_run_id` but no child Events; subscribing to a `child_run_id` for a child that has already terminated replays that child's full stream.
20. When `workspace_path` is omitted and any roster member has `sandbox.workspace_required: true`, Team Run start fails naming that member and the requirement.
21. When the manager terminates without ever calling `finish`, synthesis still runs, `result` is the synthesis output, and the Team Run's outcome is `incomplete`. The Team Run is therefore excluded from trajectory training data even though it produced an answer.
22. When a child Run terminates `incomplete` because its worker self-reported failure, `delegate` returns `is_error: true` carrying that outcome, exactly as it does for `failed`. The manager cannot distinguish a worker that could not do the job from one that crashed except by reading the returned message.
23. When the manager Agent is edited to `runtime.mode: code` after the Team was saved, the pinned `resolved_roster` still holds the standard-mode version and existing Team Runs are unaffected. A subsequent Team save or roster refresh fails validation per Requirement 29a.
24. When a worker's pinned version has `runtime.mode: code` and that worker grants MCP servers, its child Run emits the runtime's `mode_downgraded` Event listing the excluded tools, inside the child's own stream rather than the Team Run's.
25. When `limits.per_delegation_budgets` raises a budget above the `budget_ceilings` in `config/runtime.yaml`, Team validation fails naming the budget and the ceiling, matching the Agent Definition constraint.

## Acceptance Criteria
- [ ] Posting `teams/frontend-feature-team.yaml` returns HTTP 200 with `version: 1` and a `resolved_roster` pinning an `agent_version_id` for the manager and every worker.
- [ ] A Team definition naming a nonexistent worker is rejected with an error naming that worker, and nothing is persisted.
- [ ] A Team definition whose manager also appears in `workers` is rejected naming the conflict.
- [ ] A Team definition with a worker whose `capabilities` list is empty is rejected naming that worker.
- [ ] A Team definition with `max_concurrent_delegations: 5` against `max_concurrent_total: 2` is rejected naming both values.
- [ ] A Team Run where the manager calls `list_workers()` receives every alias with capabilities and no persona, model tag, or tool list.
- [ ] `delegate` by capability string resolves to the single matching worker; with two matches it returns an error naming both and starts no child Run.
- [ ] A child Run has `parent_run_id` equal to the Team Run's `run_id` and `delegation_id` equal to the manager's `tool_call` `event_id`.
- [ ] Each child Run has its own container, verified by two distinct container IDs for two concurrent delegations, both bind-mounting the same `workspace_path`.
- [ ] A worker Agent's Run does not contain `delegate` in its tool list, and a worker calling it receives an unknown-tool error result.
- [ ] With `max_concurrent_delegations: 2`, four delegations emitted in one Step produce at most two concurrently running child Runs at any instant.
- [ ] A Team Run with `tree_max_model_tokens` set low terminates `budget_exhausted` naming that budget, with every in-flight child cancelled and no containers left running.
- [ ] A Team Run with `max_delegations: 2` returns errors on the third `delegate` call and still reaches synthesis with outcome `success`.
- [ ] Cancelling a Team Run with two children in flight produces `run_end` for both children before the Team Run's `run_end`.
- [ ] A Team Run where every delegation fails still produces a synthesis result and outcome `success`.
- [ ] Restarting the daemon mid-Team-Run marks the Team Run and all children `failed` and leaves no containers labelled with any of those `run_id` values.
- [ ] Subscribing to a Team Run yields `delegation` Events with `child_run_id`; subscribing to that `child_run_id` replays the child's full ordered stream.
- [ ] The dashboard renders a completed Team Run as an expandable tree with per-child outcome, token count, and wall-clock.
- [ ] A Team Run's `runs` row records `team_version_id`, and editing the Team mid-Run does not change the roster used by that Run.
- [ ] A Team definition whose manager Agent has `runtime.mode: code` is rejected naming the manager and the delegate-tool constraint.
- [ ] A Team Run whose manager calls `finish(success: true)` and completes synthesis records outcome `success`; one whose manager never calls `finish` records `incomplete` despite producing a synthesis result.
- [ ] A Team Run where every delegation failed but the manager self-reported success records outcome `success`.
- [ ] A trajectory dataset built after a Team Run with one successful and one incomplete child includes only the successful child's flattened sample.
- [ ] A Team definition whose `per_delegation_budgets` exceeds a `budget_ceilings` value is rejected naming the budget and the ceiling.

## Key Files
- `services/daemon/src/teams/team-schema.ts` — new file, closed Team schema and version gate
- `services/daemon/src/teams/validator.ts` — new file, roster resolution, alias and capability checks, concurrency-limit check
- `services/daemon/src/teams/store.ts` — new file, `teams` and `team_versions` persistence and `resolved_roster` pinning
- `services/daemon/src/teams/file-loader.ts` — new file, watches `teams/`, upsert by `name`, collision handling
- `services/daemon/src/teams/orchestrator.ts` — new file, Team Run lifecycle, manager Run setup, cancellation cascade
- `services/daemon/src/teams/delegate-tool.ts` — new file, `delegate` and `list_workers` implementations and worker resolution
- `services/daemon/src/teams/tree-budget.ts` — new file, cross-Run budget accounting and pre-delegation checks
- `services/daemon/src/teams/synthesis.ts` — new file, delegation digest assembly and final synthesis Step
- `services/daemon/src/models/scheduler.ts` — modified, adds manager-over-worker priority admission
- `services/daemon/src/gateway/routes/teams.ts` — new file, team CRUD, validate, and `POST /api/team-runs`
- `services/dashboard/src/pages/TeamsPage.tsx` — new file, list, create, edit, delete
- `services/dashboard/src/components/TeamRunTree.tsx` — new file, expandable manager-and-children run tree
- `teams/frontend-feature-team.yaml` — new file, shipped example Team
- `db/migrations/006_teams.sql` — new file, `teams` and `team_versions` tables plus the `runs.team_version_id` foreign key; the delegation columns themselves are declared nullable in `005_runs_events.sql`
