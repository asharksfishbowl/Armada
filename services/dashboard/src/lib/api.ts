/**
 * The HTTP surface, typed against the endpoints that ACTUALLY EXIST.
 *
 * Every shape here was read out of the daemon's and forge's source, not out of a spec.
 * Where the two disagree, the code wins and the divergence is recorded in a comment beside
 * the call, because a client written against a spec the server does not implement fails at
 * runtime with a shape error rather than at review with a question.
 *
 * The divergences that bit, all confirmed in source:
 *   - Agent validation is `POST /api/agents/validate`, NOT `/api/agents/{id}/validate`.
 *   - Saving an agent is `POST /api/agents` — an upsert keyed on `name`. There is no
 *     `PUT /api/agents/{id}`; PUT on an agent id returns 405.
 *   - `GET /api/agents` and `GET /api/teams` return BARE ARRAYS. `GET /api/runs` returns
 *     `{runs, next_cursor?}`. There is no uniform envelope; do not assume one.
 *   - There is NO agent or team version-LIST endpoint. Only `current_version` plus
 *     `?version=n` point lookups. AgentVersionHistory walks the range.
 *
 * ALL PATHS ARE RELATIVE. The dashboard is same-origin with both services because neither
 * emits a CORS header and neither answers an OPTIONS preflight — nginx proxies `/api` and
 * `/ws` to armada-daemon and `/forge` to armada-forge. There is no base URL to configure
 * and deliberately no environment variable to get wrong.
 */

/** The forge lives behind this prefix, stripped by the proxy. See nginx.conf. */
const FORGE = '/forge';

/**
 * An API failure that preserves the SHAPE the server sent.
 *
 * The status code alone is not enough anywhere in this app: a 400 from a save carries the
 * full validation error list that the problems panel renders (Agent Definition R12, R27),
 * a 409 from cancel carries the existing outcome (Agent Runtime edge 16), and a 409 from
 * ingest carries the in-flight `job_id` (Training edge 18). Each of those renders as an
 * inline toast or a panel, never as a generic error modal, so the body has to survive.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Validation errors in the `{path, message}` shape both validate endpoints return. */
  get validationErrors(): { path: string; message: string }[] {
    const body = this.body as { errors?: unknown } | null;
    if (!body || !Array.isArray(body.errors)) return [];
    return body.errors.flatMap((entry) => {
      if (typeof entry === 'string') return [{ path: '', message: entry }];
      const item = entry as { path?: unknown; message?: unknown };
      if (typeof item.message !== 'string') return [];
      return [{ path: typeof item.path === 'string' ? item.path : '', message: item.message }];
    });
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const detail =
      (body as { detail?: unknown; error?: unknown } | null)?.detail ??
      (body as { error?: unknown } | null)?.error ??
      response.statusText;
    throw new ApiError(response.status, body, `${response.status} ${String(detail)}`);
  }
  return body as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(
    path,
    // `body` is OMITTED rather than set to undefined: under `exactOptionalPropertyTypes`
    // an explicit undefined is not the same as an absent key, and several of these
    // endpoints (ingest, materialize, cancel, refresh-bindings) take no body at all.
    body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body) },
  );
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

// ─── Health (Requirements 35a-35d) ────────────────────────────────────────────────────

export type Reachability = 'reachable' | 'unreachable' | 'unknown';

export interface Health {
  status: 'ok' | 'unavailable';
  version: string;
  checks: { database: string; kernel: string };
  /** Always keyed `daemon`, `forge`, `models` — the three dots of Requirement 35a. */
  services: Record<string, { reachable: Reachability; last_checked: string | null }>;
}

export const fetchHealth = () => get<Health>('/api/health');

// ─── Agents ───────────────────────────────────────────────────────────────────────────

export interface AgentListRow {
  agent_id: string;
  name: string;
  current_version: number;
  display_name: string | null;
  description: string | null;
  capabilities: string[] | null;
  binding_tag: string;
  warnings: string[] | null;
}

export interface AgentVersionRecord {
  agent_id: string;
  name: string;
  version: number;
  current_version: number;
  definition: Record<string, unknown>;
  resolved_snapshot: {
    binding_tag: string;
    mode: string;
    tools: string[];
    budgets: Record<string, number>;
    warnings: string[];
    corpus_id: string | null;
    adapter_id: string | null;
    [key: string]: unknown;
  };
}

export interface SaveResult {
  agent_id: string;
  version: number;
  created: boolean;
  warnings: string[];
}

export interface RefreshResult {
  changed: boolean;
  version: number;
  changed_fields: string[];
  warnings: string[];
}

export const fetchAgents = () => get<AgentListRow[]>('/api/agents');

export const fetchAgentVersion = (agentId: string, version?: number) =>
  get<AgentVersionRecord>(
    `/api/agents/${encodeURIComponent(agentId)}${version === undefined ? '' : `?version=${version}`}`,
  );

/** Create-or-update, keyed on `definition.name`. The agent id in the UI is not sent. */
export const saveAgent = (definition: unknown) => post<SaveResult>('/api/agents', definition);

/** NOT `/api/agents/{id}/validate` — the spec says that; the daemon implements this. */
export const validateAgent = (definition: unknown) =>
  post<{ valid: true; warnings: string[] }>('/api/agents/validate', definition);

export const refreshAgentBindings = (agentId: string) =>
  post<RefreshResult>(`/api/agents/${encodeURIComponent(agentId)}/refresh-bindings`);

export const deleteAgent = (agentId: string) =>
  del<{ deleted: string }>(`/api/agents/${encodeURIComponent(agentId)}`);

// ─── Teams ────────────────────────────────────────────────────────────────────────────

export interface TeamWorker {
  alias: string;
  agent_name: string;
  capabilities: string[];
}

export interface TeamListRow {
  team_id: string;
  name: string;
  current_version: number;
  display_name: string | null;
  description: string | null;
  manager: string;
  workers: TeamWorker[];
  limits: {
    max_delegations: number;
    max_concurrent_delegations: number;
    tree_max_wall_clock_seconds: number;
    tree_max_model_tokens: number;
    per_delegation_budgets: Record<string, number>;
  };
  warnings: string[];
  missing_members?: string[];
}

export interface TeamVersionRecord {
  team_id: string;
  name: string;
  version: number;
  current_version: number;
  definition: Record<string, unknown>;
  resolved_roster: Record<string, unknown>;
}

export const fetchTeams = () => get<TeamListRow[]>('/api/teams');

export const fetchTeamVersion = (teamId: string, version?: number) =>
  get<TeamVersionRecord>(
    `/api/teams/${encodeURIComponent(teamId)}${version === undefined ? '' : `?version=${version}`}`,
  );

export const saveTeam = (definition: unknown) =>
  post<{ team_id: string; version: number; created: boolean; warnings: string[] }>(
    '/api/teams',
    definition,
  );

/** Team Orchestration R39 — mirrors the agent endpoint, full error list, no persistence. */
export const validateTeam = (definition: unknown) =>
  post<{ valid: true; warnings: string[]; resolved_roster: unknown }>(
    '/api/teams/validate',
    definition,
  );

/** Design spec dependency ruling 3. Already shipped in P8; P9 is its first consumer. */
export const deleteTeam = (teamId: string) =>
  del<{ deleted: string }>(`/api/teams/${encodeURIComponent(teamId)}`);

// ─── Runs ─────────────────────────────────────────────────────────────────────────────

export type RunOutcome =
  | 'success'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'no_progress';

export interface RunListRow {
  run_id: string;
  agent_version_id: string;
  /** ADDED IN P9, dependency ruling 6. Without these two the pin badge is unbuildable. */
  agent_id: string;
  version: number;
  status: 'running' | 'terminal';
  outcome: RunOutcome | null;
  started_at: string;
  ended_at: string | null;
  parent_run_id: string | null;
  delegation_id: string | null;
  is_team_run: boolean;
}

export interface RunDetail extends RunListRow {
  result: string | null;
  mode: 'standard' | 'code';
  workspace_path: string | null;
  /** ADDED IN P9, dependency ruling 7. */
  team_version_id: string | null;
  counters: {
    steps_used: number;
    model_tokens_used: number;
    tool_calls_used: number;
    wall_clock_ms_used: number;
    queued_ms_total: number;
  };
}

export interface RunFilters {
  agent_id?: string | undefined;
  status?: string | undefined;
  outcome?: string | undefined;
  parent_run_id?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** R134 — filters mirror the endpoint's own parameters, plus cursor pagination. */
export function fetchRuns(filters: RunFilters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return get<{ runs: RunListRow[]; next_cursor?: string }>(
    `/api/runs${query ? `?${query}` : ''}`,
  );
}

export const fetchRun = (runId: string) =>
  get<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);

/** R136 — the launcher's agent path. */
export const startAgentRun = (body: { agent_id: string; task: string; workspace_path?: string | null }) =>
  post<{ run_id: string }>('/api/runs', body);

/** R136 — the launcher's team path. The two differ ONLY in the endpoint called. */
export const startTeamRun = (body: { team_id: string; task: string; workspace_path?: string | null }) =>
  post<{ run_id: string }>('/api/team-runs', body);

export const cancelRun = (runId: string) =>
  post<{ cancelling: string }>(`/api/runs/${encodeURIComponent(runId)}/cancel`);

// ─── Corpora (forge) ──────────────────────────────────────────────────────────────────

export interface CorpusListRow {
  corpus_id: string;
  name: string;
  description: string;
  last_ingested_at: string | null;
  chunk_count: number;
  source_count: number;
}

export interface CorpusSource {
  source_id: string;
  type: string;
  location: string;
  include_globs: string[];
  exclude_globs: string[];
  created_at: string;
}

export interface IngestionJob {
  job_id: string;
  corpus_id: string;
  status: string;
  chunks_added: number;
  chunks_removed: number;
  files_skipped: number;
  source_results: Record<string, Record<string, unknown>> | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface CorpusDetail extends CorpusListRow {
  created_at: string;
  sources: CorpusSource[];
  latest_job: IngestionJob | null;
}

export const fetchCorpora = () => get<CorpusListRow[]>(`${FORGE}/corpora`);

export const fetchCorpus = (corpusId: string) =>
  get<CorpusDetail>(`${FORGE}/corpora/${encodeURIComponent(corpusId)}`);

export const createCorpus = (body: { name: string; description?: string }) =>
  post<CorpusListRow>(`${FORGE}/corpora`, body);

/** Design spec dependency ruling 3. Already shipped in P1; P9 is its first consumer. */
export const deleteCorpus = (corpusId: string) =>
  del<{ deleted: string; chunks_deleted: number; adapters_retained: boolean }>(
    `${FORGE}/corpora/${encodeURIComponent(corpusId)}`,
  );

export const addSource = (
  corpusId: string,
  body: { type: string; location: string; include_globs?: string[]; exclude_globs?: string[] },
) => post<CorpusSource>(`${FORGE}/corpora/${encodeURIComponent(corpusId)}/sources`, body);

/** 409 carries the in-flight `job_id` — edge 30 renders that as a toast, not a modal. */
export const startIngest = (corpusId: string) =>
  post<{ job_id: string; corpus_id: string; status: string }>(
    `${FORGE}/corpora/${encodeURIComponent(corpusId)}/ingest`,
  );

export const fetchIngestionJobs = (corpusId: string) =>
  get<IngestionJob[]>(`${FORGE}/corpora/${encodeURIComponent(corpusId)}/jobs`);

// ─── Models (forge) ───────────────────────────────────────────────────────────────────

/**
 * `GET /models/base` — ADDED IN P9. Requirement 129's shortlist table needs
 * `quantization` and `smoke_test`, which are properties of config/base-models.yaml and are
 * never written to the `model_bindings` table, so `GET /models/bindings` could not carry
 * them. The alternative was two fabricated columns.
 */
export interface BaseModelRow {
  base_model_id: string;
  backend: string;
  context_window: number;
  tool_format: string;
  quantization: string;
  min_ram_gb: number;
  min_disk_gb: number;
  trainable: boolean;
  smoke_test: boolean;
  base_tag: string;
}

export interface BindingRow {
  tag: string;
  backend: string;
  base_model_id: string;
  corpus_name: string;
  adapter_id: string | null;
  version: number | null;
  context_window: number;
  tool_format: string;
  materialized: boolean;
  materialization_status: string | null;
  materialization_error: string | null;
  status: 'promoted' | 'retired' | 'missing';
}

export const fetchBaseModels = () => get<BaseModelRow[]>(`${FORGE}/models/base`);

export const fetchBindings = () => get<BindingRow[]>(`${FORGE}/models/bindings`);

/** build-plan Req 4. The tag contains a slash, which the `:path` converter accepts. */
export const materializeBinding = (tag: string) =>
  post<{ tag: string; status: string }>(`${FORGE}/models/bindings/${tag}/materialize`);
