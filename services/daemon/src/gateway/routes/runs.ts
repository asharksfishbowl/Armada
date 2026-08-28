/**
 * Run endpoints — Agent Runtime R2, R3, R3b, R4; edge 16.
 *
 * Thin by design. Every decision that matters lives in the orchestrator or the store; this
 * file maps outcomes to HTTP and nothing else. A route that reasons about Runs would be a
 * second place that knows the lifecycle.
 */

import type { RouteResponse } from './agents.js';
import type { RunStore, RunRow } from '../../runs/store.js';
import { RunOrchestrator, RunStartError } from '../../runs/orchestrator.js';

/** R3b — a bound the caller cannot raise, so one request cannot ask for the whole table. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function summarise(run: RunRow): Record<string, unknown> {
  return {
    run_id: run.run_id,
    agent_version_id: run.agent_version_id,
    status: run.status,
    outcome: run.outcome,
    started_at: run.started_at,
    ended_at: run.ended_at,
    // R3b — explicitly null for a Run that is not a delegation, rather than omitted. An
    // absent key and a null one read differently to a client deciding whether to indent.
    parent_run_id: run.parent_run_id,
  };
}

export function createRunRoutes(orchestrator: RunOrchestrator, store: RunStore) {
  return {
    /** R2 — starts a Run and returns before it completes. */
    async create(raw: unknown): Promise<RouteResponse> {
      if (typeof raw !== 'object' || raw === null) {
        return { status: 400, body: { error: 'invalid_body', detail: 'a JSON object is required' } };
      }
      const body = raw as { agent_id?: unknown; task?: unknown; workspace_path?: unknown };

      const problems: string[] = [];
      if (typeof body.agent_id !== 'string' || body.agent_id === '') problems.push('`agent_id` is required and must be a string');
      if (typeof body.task !== 'string' || body.task === '') problems.push('`task` is required and must be a non-empty string');
      if (body.workspace_path !== undefined && body.workspace_path !== null && typeof body.workspace_path !== 'string') {
        problems.push('`workspace_path` must be a string when present');
      }
      // Every fault at once, matching how the rest of this repo validates — an operator
      // with two mistakes fixes both in one round trip.
      if (problems.length > 0) {
        return { status: 400, body: { error: 'invalid_body', errors: problems } };
      }

      try {
        const { runId } = await orchestrator.start({
          agentId: body.agent_id as string,
          task: body.task as string,
          workspacePath: (body.workspace_path as string | null | undefined) ?? null,
        });
        return { status: 201, body: { run_id: runId } };
      } catch (err) {
        if (err instanceof RunStartError) {
          // Carries the tag and the fixing action for a binding fault (D4, R18b).
          return { status: err.status, body: { error: err.code, detail: err.message } };
        }
        throw err;
      }
    },

    /** R3. */
    async get(runId: string): Promise<RouteResponse> {
      const run = await store.get(runId);
      if (!run) return { status: 404, body: { error: 'not_found', run_id: runId } };
      return {
        status: 200,
        body: {
          ...summarise(run),
          result: run.result,
          mode: run.mode,
          workspace_path: run.workspace_path,
          counters: {
            steps_used: run.steps_used,
            model_tokens_used: run.model_tokens_used,
            tool_calls_used: run.tool_calls_used,
            wall_clock_ms_used: run.wall_clock_ms_used,
            queued_ms_total: run.queued_ms_total,
          },
        },
      };
    },

    /** R3b — newest first, filterable, keyset paginated. */
    async list(query: URLSearchParams): Promise<RouteResponse> {
      const rawLimit = query.get('limit');
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
        return { status: 400, body: { error: 'invalid_limit', detail: `limit must be a positive integer, got '${rawLimit}'` } };
      }
      const limit = Math.min(rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit), MAX_LIMIT);

      let cursor: { startedAt: string; runId: string } | undefined;
      const rawCursor = query.get('cursor');
      if (rawCursor !== null) {
        // `{started_at}|{run_id}` — opaque to the client, and rejected rather than ignored
        // when malformed. Silently dropping it would serve page 1 forever while the client
        // believed it was paging.
        const [startedAt, runId] = rawCursor.split('|');
        if (!startedAt || !runId) {
          return { status: 400, body: { error: 'invalid_cursor', detail: 'cursor must be `{started_at}|{run_id}`' } };
        }
        cursor = { startedAt, runId };
      }

      const runs = await store.list({
        ...(query.get('agent_id') ? { agentId: query.get('agent_id') as string } : {}),
        ...(query.get('status') ? { status: query.get('status') as string } : {}),
        ...(query.get('outcome') ? { outcome: query.get('outcome') as string } : {}),
        ...(query.get('parent_run_id') ? { parentRunId: query.get('parent_run_id') as string } : {}),
        limit,
        ...(cursor ? { cursor } : {}),
      });

      const last = runs.at(-1);
      return {
        status: 200,
        body: {
          runs: runs.map(summarise),
          // Present only when a further page may exist, so a client stops without guessing.
          ...(last && runs.length === limit
            ? { next_cursor: `${last.started_at}|${last.run_id}` }
            : {}),
        },
      };
    },

    /** R4, edge 16. */
    async cancel(runId: string): Promise<RouteResponse> {
      const result = await orchestrator.cancel(runId);
      return result.ok
        ? { status: 202, body: { cancelling: runId } }
        : { status: result.status, body: result.body };
    },
  };
}

export type RunRoutes = ReturnType<typeof createRunRoutes>;
