/**
 * Run persistence — Agent Runtime R3, R3b, R53, R53a-c.
 *
 * `runs` is the only mutable row a Run owns. The Event stream beside it is append-only
 * (invariant 5) and is the record of WHAT HAPPENED; this table is the current state, so
 * `GET /api/runs/{id}` can answer without replaying a stream.
 *
 * THE TERMINAL WRITE IS CONDITIONAL, AND THAT IS THE POINT. `terminate` only transitions a
 * Run that is still `running`, and reports whether it did. Edge 16 requires cancelling an
 * already-terminal Run to return 409 naming the existing outcome and append NO second
 * `run_end` — expressing that as a WHERE clause makes it one atomic decision instead of a
 * read, a think, and a write with a race in the middle.
 *
 * The schema's `runs_terminal_has_outcome` CHECK enforces invariant 1 from underneath: a
 * terminal Run has an outcome and a running one does not, so no code path can record a
 * terminal Run whose outcome was never decided.
 */

import type { Pool } from 'pg';
import type { RunMode, RunOutcome } from '../kernel/types.js';

export interface RunRow {
  run_id: string;
  agent_version_id: string;
  status: 'running' | 'terminal';
  outcome: RunOutcome | null;
  result: string | null;
  mode: RunMode;
  workspace_path: string | null;
  steps_used: number;
  model_tokens_used: number;
  tool_calls_used: number;
  wall_clock_ms_used: number;
  queued_ms_total: number;
  // Team Orchestration R19, R10. Declared nullable in 005 (Runtime R53c) so GET /api/runs
  // was complete from Phase 4; 006 adds team_version_id's foreign key and nothing else.
  parent_run_id: string | null;
  delegation_id: string | null;
  is_team_run: boolean;
  team_version_id: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface ListFilter {
  agentId?: string;
  status?: string;
  outcome?: string;
  parentRunId?: string;
  limit: number;
  /** R3b — the `started_at,run_id` of the last row of the previous page. */
  cursor?: { startedAt: string; runId: string };
}

export class RunStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Create a Run row.
   *
   * The four Team Orchestration columns default to the solo-Run shape, so `POST /api/runs`
   * needs to know nothing about Teams. A child Run supplies `parentRunId` and
   * `delegationId` (R19); the Team Run itself supplies `isTeamRun` and `teamVersionId`
   * (data-flow step 3).
   */
  async create(input: {
    agentVersionId: string;
    mode: RunMode;
    workspacePath: string | null;
    parentRunId?: string | null;
    delegationId?: string | null;
    isTeamRun?: boolean;
    teamVersionId?: string | null;
  }): Promise<RunRow> {
    const { rows } = await this.pool.query<RunRow>(
      `INSERT INTO runs (
         agent_version_id, mode, workspace_path,
         parent_run_id, delegation_id, is_team_run, team_version_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.agentVersionId,
        input.mode,
        input.workspacePath,
        input.parentRunId ?? null,
        input.delegationId ?? null,
        input.isTeamRun ?? false,
        input.teamVersionId ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('run insert returned no row');
    return row;
  }

  /**
   * Team R23, edge 7 — the Runs a Team Run must cancel before appending its own `run_end`.
   *
   * Read from the database rather than from an in-memory set: a daemon that restarted
   * mid-Team-Run has no in-memory children, and edge 14 still requires every one of them
   * to reach a terminal state.
   */
  async listRunningChildren(parentRunId: string): Promise<RunRow[]> {
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM runs WHERE parent_run_id = $1 AND status = 'running' ORDER BY started_at ASC`,
      [parentRunId],
    );
    return rows;
  }

  async get(runId: string): Promise<RunRow | null> {
    const { rows } = await this.pool.query<RunRow>('SELECT * FROM runs WHERE run_id = $1', [runId]);
    return rows[0] ?? null;
  }

  /**
   * R3b — newest first, keyset pagination.
   *
   * Keyset rather than OFFSET: Runs are created while an operator pages, and OFFSET would
   * silently skip or repeat rows as the list shifts under them. The `(started_at DESC,
   * run_id DESC)` index in migration 005 exists for exactly this comparison.
   */
  async list(filter: ListFilter): Promise<RunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.agentId) {
      params.push(filter.agentId);
      // Joined rather than stored on `runs`: a Run pins an agent VERSION (R53b), and
      // filtering by agent must span every version of it.
      where.push(
        `agent_version_id IN (SELECT agent_version_id FROM agent_versions WHERE agent_id = $${params.length})`,
      );
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}::run_status`);
    }
    if (filter.outcome) {
      params.push(filter.outcome);
      where.push(`outcome = $${params.length}::run_outcome`);
    }
    if (filter.parentRunId) {
      params.push(filter.parentRunId);
      where.push(`parent_run_id = $${params.length}`);
    }
    if (filter.cursor) {
      params.push(filter.cursor.startedAt, filter.cursor.runId);
      where.push(`(started_at, run_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(filter.limit);
    const { rows } = await this.pool.query<RunRow>(
      `SELECT * FROM runs
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC, run_id DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /** Mid-Run counters for GET /api/runs/{id} (R3). */
  async recordCounters(
    runId: string,
    counters: { steps: number; modelTokens: number; toolCalls: number; wallClockMs: number; queuedMs: number },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE runs
          SET steps_used = $2, model_tokens_used = $3, tool_calls_used = $4,
              wall_clock_ms_used = $5, queued_ms_total = $6
        WHERE run_id = $1`,
      [runId, counters.steps, counters.modelTokens, counters.toolCalls, counters.wallClockMs, counters.queuedMs],
    );
  }

  /**
   * Transition to terminal, but ONLY from `running`.
   *
   * Returns false when the Run was already terminal, which is how edge 16's 409 is decided
   * without a separate read. Two concurrent cancels, or a cancel racing a natural
   * termination, cannot both win.
   */
  async terminate(runId: string, outcome: RunOutcome, result: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE runs
          SET status = 'terminal', outcome = $2::run_outcome, result = $3, ended_at = now()
        WHERE run_id = $1 AND status = 'running'`,
      [runId, outcome, result],
    );
    return (rowCount ?? 0) > 0;
  }
}
