# Spec: Agent Definition

## Overview
An Agent is a declarative document binding a persona, a ModelBinding, a tool grant list, an optional Corpus, a sandbox profile, and runtime budgets. This spec owns the schema, its validation, its versioning, and the dashboard and API surface for managing Agents. It is what makes "frontend engineer" and "chef" the same machinery with different declarations.

## Goals
- Express a complete, runnable Agent in one YAML document with no code.
- Reject an Agent at save time for any binding that cannot resolve, so failures surface in the dashboard rather than mid-Run.
- Version every Agent so a Run is reproducible against the exact definition that produced it.
- Keep the schema domain-neutral: nothing in it privileges software engineering over any other domain.

## Non-Goals
- Executing an Agent. That is Agent Runtime, which consumes an already-validated Agent.
- Defining teams or delegation. That is Team Orchestration.
- Authoring or evaluating persona prompt text. Armada stores the operator's prompt verbatim.
- Creating Corpora, ModelBindings, sandbox profiles, or MCP servers. An Agent references entities those specs own.

## Definitions
- **Agent definition** — the YAML document. The authoring format.
- **Agent record** — the validated, persisted row in the `agents` table, including a resolved snapshot.
- **Resolved snapshot** — the fully dereferenced tool list, ModelBinding tag, and effective budgets captured at save time and stored on the version, so a Run does not re-resolve references that may have since changed.

## Requirements

### Schema
1. An Agent definition is YAML with these top-level keys: `schema_version` (int, must equal 1), `name`, `display_name`, `description`, `persona`, `model`, `corpus`, `tools`, `sandbox`, `runtime`, `capabilities`.
2. `name` is a string matching `^[a-z0-9-]+$`, unique across Agents, and immutable after creation.
3. `persona` has exactly one key: `system_prompt` (string, required, non-empty). It is stored verbatim and becomes the first message of every Step's context.
4. `model` has exactly two keys: `base_model_id` (string, required) and `adapter` (one of `latest_promoted`, `none`, or an explicit `adapter_id` uuid; default `latest_promoted`). There is no way to name a ModelBinding tag directly; a tag is always derived by resolution, so every Agent's model provenance is traceable to a BaseModel entry and an Adapter row.
5. `corpus` has `name` (string matching `^[a-z0-9-]+$`, nullable) and `auto_inject_k` (int, optional, overrides the runtime default). `corpus: null` means the Agent has no retrieval, and the runtime omits both the injected block and `search_knowledge`. Corpora are referenced by `name`, never by `corpus_id`, so a definition file authored on one installation is valid on another that has a Corpus of the same name. The named Corpus must still exist at validation time (Requirement 16); Requirement 36 covers how the shipped examples satisfy that on a fresh installation.
6. `tools` has `builtin` (list of strings drawn from `shell`, `read_file`, `write_file`, `list_dir`, `finish`), `mcp` (list of MCP server names from `config/mcp-servers.yaml`), and `denied` (list of fully-qualified tool names excluded even if otherwise granted).
7. `finish` is granted to every Agent whether or not it appears in `tools.builtin`, and may not appear in `tools.denied`.
8. `sandbox` has `profile` (string, a key in `config/sandbox-profiles.yaml`, required) and `workspace_required` (bool, default true).
9. `runtime` has `mode` (one of `standard`, `code`; default `standard`) and `budgets` (object with any subset of `max_steps`, `max_model_tokens`, `max_wall_clock_seconds`, `max_tool_calls`), each overriding the `config/runtime.yaml` default.
10. `capabilities` is a list of free-form strings used by Team Orchestration for worker matching. It has no effect on a solo Run.
11. Any key not listed in Requirement 1, or any unknown key within a nested object, causes validation to fail naming the offending key path. The schema is closed, not permissive.

### Validation
12. `services/daemon/src/agents/definition-schema.ts` defines the schema; validation runs on every create and update and returns every error found, not just the first.
13. Validation resolves `model.base_model_id` against `armada-forge` `GET /models/bindings` and fails if no binding exists for it.
14. When `model.adapter` is `latest_promoted`, validation resolves the highest `version` Adapter with `status: promoted` for that `base_model_id`, preferring one whose `corpus_name` matches `corpus.name` when a Corpus is bound. When no promoted Adapter exists, validation fails naming the `base_model_id` and directing the operator to `adapter: none`.
14a. When `model.adapter` is `none`, validation resolves the base ModelBinding tagged `armada/{base_model_id}-base`, which `armada-forge` registers for every shortlist entry on startup, and fails only if that binding is absent or `retired`.
15. When `model.adapter` is an explicit `adapter_id`, validation fails if that Adapter's `status` is not `promoted` or its `base_model_id` does not match.
16. Validation fails if `corpus.name` is non-null and no Corpus with that `name` exists, naming the available Corpus names. It warns without failing if the Corpus exists but has zero chunks.
16a. Validation records the resolved `corpus_id` in the `resolved_snapshot`. Because Corpus `name` is immutable, the pinned `corpus_id` and the referenced `name` cannot diverge.
16b. Validation warns without failing if `runtime.mode` is `code` and `tools.mcp` is non-empty, naming every MCP server whose tools will be unavailable inside a Code-mode program. This is a warning rather than an error so an Agent can be switched between modes without editing its tool grants.
17. Validation fails if `sandbox.profile` is not a key in `config/sandbox-profiles.yaml`, naming the available keys.
18. Validation fails if any name in `tools.mcp` is not defined in `config/mcp-servers.yaml`, naming the unknown server.
19. Validation fails if `runtime.mode` is `code` and the resolved binding's `context_window` is below `code_mode_min_context`. This is a save-time rejection; the runtime's downgrade behavior covers bindings that change after save.
20. Validation fails if any `runtime.budgets` value is less than 1 or greater than the ceiling in `config/runtime.yaml` (`budget_ceilings`), naming the budget and the ceiling.
21. Validation fails if `tools.builtin` contains a name outside the allowed set, or if `sandbox.workspace_required` is true while `tools.builtin` grants none of `shell`, `read_file`, `write_file`, `list_dir`.

### Persistence and Versioning
22. Agents are stored in `agents` (`agent_id` uuid, `name` text unique, `current_version` int, `created_at`, `updated_at`) and `agent_versions` (`agent_version_id` uuid, `agent_id` uuid, `version` int, `definition` jsonb, `resolved_snapshot` jsonb, `created_at`).
23. Every successful create or update inserts a new `agent_versions` row with `version` incremented and updates `agents.current_version`. Existing versions are immutable.
24. The `resolved_snapshot` captures `binding_tag`, `context_window`, `tool_format`, `adapter_id`, `corpus_id`, `auto_inject_k`, `mode`, the fully-qualified granted tool list after applying `denied`, the effective budgets, the effective sandbox profile values, and any validation `warnings`.
25. `POST /api/runs` records `agent_version_id` on the `runs` row and executes against that version's `resolved_snapshot`. A Run is unaffected by later edits to the Agent, and the Agent Runtime performs only a liveness check on the pinned `binding_tag` rather than re-resolving it.
25a. `POST /api/agents/{agent_id}/refresh-bindings` re-runs reference resolution against the current definition and, when any resolved value differs from the current version's `resolved_snapshot`, creates a new version carrying the updated snapshot. When nothing differs it creates no version and returns the current `version` with `changed: false`.
25b. The response to `POST /api/agents/{agent_id}/refresh-bindings` lists every field that changed, so adopting a newly promoted Adapter is a deliberate, auditable act rather than a silent drift. Armada never refreshes bindings automatically.
26. Deleting an Agent sets `agents.deleted_at` and hides it from list endpoints. Rows in `agent_versions` and historical Runs are retained.

### API and File Loading
27. `POST /api/agents` accepts a definition as YAML or JSON and returns `agent_id` and `version`, or HTTP 400 with the full error list.
28. `PUT /api/agents/{agent_id}` validates and creates a new version. `GET /api/agents/{agent_id}?version=N` returns a specific version; omitting `version` returns the current one.
29. `GET /api/agents` lists non-deleted Agents with `agent_id`, `name`, `display_name`, `description`, `current_version`, `capabilities`, and the resolved `binding_tag`.
30. `POST /api/agents/{agent_id}/validate` runs validation against a candidate definition and returns the error list without persisting anything.
31. On startup and on file change, the daemon loads every `*.yaml` file in `agents/` and upserts it by `name`. A file that fails validation is logged with its path and error list and skipped; it does not block startup or affect other files.
32. File-loaded and API-created Agents share one namespace keyed on `name`. A file whose `name` matches an API-created Agent creates a new version of that same Agent.
33. `armada-dashboard` provides create, edit, clone, and delete for Agents, surfacing validation errors inline per field path, and a read-only view of any prior version.

### Shipped Examples
34. `agents/frontend-engineer.yaml` ships as a working example: a persona for React and TypeScript work, `model.adapter: none` so it validates on a fresh installation, `sandbox.profile: node`, `tools.builtin` granting all four workspace tools, `corpus.name: frontend-docs`, and `capabilities` including `frontend`, `react`, `typescript`.
35. `agents/chef.yaml` ships as a working example in a non-software domain: a recipe-development persona, `model.adapter: none`, `sandbox.profile: minimal`, `tools.builtin` granting only `read_file` and `write_file`, `corpus.name: recipes`, and `capabilities` including `cooking`, `recipes`, `nutrition`. It demonstrates that no schema field is software-specific.
36. Both shipped examples reference Corpora by `name`, which per Requirement 16 must exist for validation to pass. To keep a fresh installation coherent, `armada-forge` seeds the Corpora named in `config/seed-corpora.yaml` on first startup, creating each with zero Sources if it does not already exist. The shipped file lists `frontend-docs` and `recipes`. Seeding is idempotent and never touches a Corpus that already exists.
37. Because a seeded Corpus has zero chunks, both shipped Agents validate with the zero-chunk warning from Requirement 16 rather than failing. They are runnable immediately, with retrieval returning nothing until the operator adds Sources and ingests.

## Data Flow
1. Operator authors a definition in the dashboard editor or drops a YAML file into `agents/`.
2. The dashboard calls `POST /api/agents/{agent_id}/validate` on edit, or the file watcher triggers validation on file change.
3. Validation parses the YAML against the closed schema and collects structural errors.
4. Validation resolves `model.base_model_id` and the requested adapter against `armada-forge` `GET /models/bindings`, producing a `binding_tag`, `context_window`, and `tool_format`.
5. Validation resolves `corpus.name` to a `corpus_id` by calling `armada-forge` `GET /corpora`, resolves `sandbox.profile` against `config/sandbox-profiles.yaml`, and resolves every name in `tools.mcp` against `config/mcp-servers.yaml`.
6. Validation applies `tools.denied` to the union of built-in, MCP, and implicit tools to produce the fully-qualified granted tool list, always retaining `finish`.
7. Validation merges `runtime.budgets` over `config/runtime.yaml` defaults and checks each against `budget_ceilings`.
8. If any error was collected, the API returns HTTP 400 with the full list and nothing is persisted.
9. On success the daemon inserts an `agent_versions` row containing the raw `definition` and the `resolved_snapshot`, and updates `agents.current_version`.
10. `POST /api/runs` reads the Agent's current `agent_version_id`, records it on the `runs` row, and hands the `resolved_snapshot` to the Agent Runtime, which does not re-resolve any reference.

## Edge Cases
1. When a definition omits `schema_version`, validation fails naming the missing key rather than assuming version 1.
2. When `schema_version` is greater than 1, validation fails naming the supported version, so a future format cannot be silently misread.
3. When two files in `agents/` declare the same `name`, startup logs the collision naming both paths and loads neither.
4. When an operator changes `name` in an existing file, the daemon treats it as a new Agent; the old Agent remains with its prior definition and is not deleted.
5. When `model.adapter` is `latest_promoted` and a newer Adapter is promoted after the Agent was saved, existing versions keep their pinned `adapter_id` and Runs are unaffected until the operator calls `POST /api/agents/{agent_id}/refresh-bindings` or re-saves the Agent. `latest_promoted` describes resolution at save time, not a live subscription.
6. When the Adapter referenced by a `resolved_snapshot` is later deleted from `armada-models`, Run start fails with the runtime's missing-binding error; the Agent record itself remains valid.
7. When `tools.denied` names a tool the Agent was never granted, validation succeeds and the entry has no effect.
8. When `tools.denied` contains `finish`, validation fails naming `finish` as non-deniable.
9. When `tools.builtin` and `tools.mcp` are both empty, validation succeeds; the Agent runs with only `finish` and, if a corpus is bound, `search_knowledge`.
10. When `sandbox.workspace_required` is false and `POST /api/runs` omits `workspace_path`, the sandbox is created with an empty ephemeral `/workspace`.
11. When `sandbox.workspace_required` is true and `POST /api/runs` omits `workspace_path`, Run start fails naming the requirement before any container is created.
12. When a bound Corpus is deleted after the Agent was saved, Run start proceeds with retrieval returning zero chunks and the runtime's empty-corpus behavior applies; the Agent is flagged in `GET /api/agents` with `warnings: ["corpus_missing"]`.
13. When `persona.system_prompt` alone exceeds the resolved `context_window` minus `reserved_output_tokens`, validation fails naming the token count and the window.
14. When an update is submitted whose definition is byte-identical to the current version, no new version is created and the API returns the existing `version`.
15. When `capabilities` is omitted, it defaults to an empty list and the Agent is never matched as a worker by Team Orchestration.
16. When `armada-forge` is unreachable during validation, create and update return HTTP 503 naming the service and nothing is persisted; file-loaded Agents are retried on the next file change rather than being marked invalid.
17. When a YAML file in `agents/` is malformed YAML, the parse error is logged with the file path and line number and the file is skipped.
18. When `GET /api/agents/{agent_id}?version=N` names a version that does not exist, the API returns HTTP 404 naming the requested and current versions.
19. When `POST /api/agents/{agent_id}/refresh-bindings` finds nothing changed, no `agent_versions` row is created and the response reports `changed: false`. Repeated calls are therefore idempotent and do not inflate version numbers.
20. When `POST /api/agents/{agent_id}/refresh-bindings` re-resolves a definition that has since become invalid — its `sandbox.profile` was removed from config, say — it returns HTTP 400 with the error list and creates no version, leaving the existing pinned version serving Runs.
21. When a Corpus named in a definition is deleted and a new Corpus is created with the same `name`, `refresh-bindings` resolves to the new `corpus_id` and reports it as a change. Without that call the Agent keeps querying the deleted `corpus_id` and retrieval returns zero chunks.
22. When `corpus.name` is set but `config/seed-corpora.yaml` does not list it and the operator has not created it, validation fails per Requirement 16. Seeding covers only the shipped examples, not arbitrary definitions.
23. When `runtime.mode` is `code` and `tools.mcp` is non-empty, the Agent saves successfully with a warning in `resolved_snapshot.warnings`, and the runtime additionally emits a `mode_downgraded` Event at Run start listing the excluded tools.
24. When `model.adapter` is `none` and the named `base_model_id` was removed from `config/base-models.yaml`, its base binding is `retired` and validation fails per Requirement 14a, naming the model.

## Acceptance Criteria
- [ ] Posting `agents/frontend-engineer.yaml` returns HTTP 200 with `version: 1` and an `agent_versions` row whose `resolved_snapshot` contains a non-null `binding_tag`.
- [ ] Posting `agents/chef.yaml` succeeds using the same schema with no software-specific fields, and its `resolved_snapshot` grants exactly `read_file`, `write_file`, `search_knowledge`, and `finish`.
- [ ] A definition containing an unknown top-level key is rejected with an error naming that key path.
- [ ] A definition with three separate errors returns all three in one HTTP 400 response.
- [ ] A definition naming a nonexistent `sandbox.profile` is rejected with an error listing the available profile keys.
- [ ] A definition with `runtime.mode: code` against a 8192-context binding is rejected at save time naming `code_mode_min_context`.
- [ ] A definition with `tools.denied: [finish]` is rejected naming `finish` as non-deniable.
- [ ] Updating an Agent creates `version: 2` while `GET /api/agents/{agent_id}?version=1` still returns the original definition unchanged.
- [ ] A Run started before an Agent update completes against the pre-update `resolved_snapshot`, verified by the `agent_version_id` on its `runs` row.
- [ ] Dropping a valid YAML file into `agents/` creates an Agent without a daemon restart; dropping an invalid one logs the path and error list and leaves other Agents loaded.
- [ ] Two files declaring the same `name` cause both to be skipped with a logged collision naming both paths.
- [ ] `POST /api/agents/{agent_id}/validate` with an invalid definition returns errors and creates no `agent_versions` row.
- [ ] Deleting an Agent removes it from `GET /api/agents` while its historical Runs remain queryable.
- [ ] On a fresh installation with an empty database, both shipped example Agents load from `agents/` and validate successfully against seeded Corpora, each carrying the zero-chunk warning.
- [ ] A definition whose `corpus.name` matches no Corpus is rejected with an error listing the available Corpus names, and contains no `corpus_id` anywhere in the file.
- [ ] An Agent with `model.adapter: none` validates on a fresh installation and its `resolved_snapshot.binding_tag` equals `armada/{base_model_id}-base`.
- [ ] `POST /api/agents/{agent_id}/refresh-bindings` after a newer Adapter is promoted creates `version: 2` and reports `adapter_id` in its changed-field list.
- [ ] Calling `refresh-bindings` twice in a row creates exactly one new version, the second returning `changed: false`.
- [ ] A definition with `runtime.mode: code` and a non-empty `tools.mcp` saves successfully and its `resolved_snapshot.warnings` names each excluded MCP server.
- [ ] Re-running Corpus seeding on a second startup creates no duplicate Corpora and does not modify an existing one.

## Key Files
- `services/daemon/src/agents/definition-schema.ts` — new file, closed schema, error accumulation, version gate
- `services/daemon/src/agents/validator.ts` — new file, reference resolution against forge, corpora, and config files
- `services/daemon/src/agents/resolver.ts` — new file, builds `resolved_snapshot` including tool grants and effective budgets
- `services/daemon/src/agents/store.ts` — new file, `agents` and `agent_versions` persistence and versioning
- `services/daemon/src/agents/file-loader.ts` — new file, watches `agents/`, upserts by `name`, collision and parse-error handling
- `services/daemon/src/agents/refresh-bindings.ts` — new file, re-resolution, change detection, conditional version creation
- `services/daemon/src/gateway/routes/agents.ts` — new file, agent CRUD, validate, and refresh-bindings endpoints
- `config/seed-corpora.yaml` — new file, Corpora seeded on first startup so shipped examples validate
- `docs/getting-started.md` — new file, fresh-installation walkthrough from `docker compose up` to a first Run
- `services/dashboard/src/pages/AgentsPage.tsx` — new file, list, create, edit, clone, delete
- `services/dashboard/src/components/AgentEditor.tsx` — new file, YAML editor with inline per-field-path validation errors
- `services/dashboard/src/components/AgentVersionHistory.tsx` — new file, read-only prior version view
- `agents/frontend-engineer.yaml` — new file, shipped software-domain example
- `agents/chef.yaml` — new file, shipped non-software-domain example
- `db/migrations/004_agents.sql` — new file, `agents` and `agent_versions` tables (precedes `runs`, which FKs to it)
