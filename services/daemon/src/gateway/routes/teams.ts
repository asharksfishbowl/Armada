/**
 * Team CRUD, validate, and `POST /api/team-runs` — Team Orchestration R39, R40.
 *
 * "Mirror the Agent endpoints, including full-error-list responses and no persistence on
 * failure." Thin by design, exactly like `runs.ts`: every decision that matters lives in
 * the validator, the store, or the orchestrator, and this file maps outcomes to HTTP.
 *
 * VALIDATION FAILURES RETURN THE FULL ERROR LIST AND PERSIST NOTHING. A partially-saved
 * Team would be worse than a rejected one: the operator would have to work out which half
 * landed, against a roster that pins Agent versions.
 */

import type { RouteResponse } from './agents.js';
import type { TeamStore } from '../../teams/store.js';
import type { TeamContextProvider } from '../../teams/validation-context.js';
import { validateTeam } from '../../teams/validator.js';
import { TeamOrchestrator, TeamRunStartError } from '../../teams/orchestrator.js';

function errorBody(errors: { path: string; message: string }[]): unknown {
  return {
    error: 'validation_failed',
    // Every error, each anchored to a key path so the dashboard can attach it to a field
    // rather than showing one opaque string.
    errors: errors.map((e) => ({ path: e.path, message: e.message })),
  };
}

export function createTeamRoutes(
  store: TeamStore,
  getContext: TeamContextProvider,
  orchestrator: TeamOrchestrator,
) {
  return {
    /** R39 — create or update by name. */
    async create(raw: unknown): Promise<RouteResponse> {
      const result = validateTeam(raw, await getContext());
      if (result.errors.length > 0 || !result.definition || !result.roster) {
        return { status: 400, body: errorBody(result.errors) };
      }

      const saved = await store.save(result.definition, result.roster);
      return {
        status: saved.created ? 201 : 200,
        body: {
          team_id: saved.teamId,
          version: saved.version,
          created: saved.created,
          // The acceptance criterion is stated on this field: a pinned agent_version_id
          // for the manager and every worker.
          resolved_roster: result.roster,
          warnings: result.warnings,
        },
      };
    },

    /** R39 — validate a candidate without persisting anything. */
    async validateOnly(raw: unknown): Promise<RouteResponse> {
      const result = validateTeam(raw, await getContext());
      return {
        status: result.errors.length > 0 ? 400 : 200,
        body:
          result.errors.length > 0
            ? errorBody(result.errors)
            : { valid: true, warnings: result.warnings, resolved_roster: result.roster },
      };
    },

    /** R39, edge 11 — flags `worker_missing` rather than hiding the Team. */
    async list(): Promise<RouteResponse> {
      return { status: 200, body: await store.list() };
    },

    /** R39 — a specific version, or the current one. */
    async get(teamId: string, version?: number): Promise<RouteResponse> {
      const team = await store.getById(teamId);
      if (!team || team.deleted_at) {
        return { status: 404, body: { error: 'not_found', team_id: teamId } };
      }

      const record = await store.getVersion(teamId, version);
      if (!record) {
        // Name BOTH the requested and the current version, so the operator can see whether
        // they asked for one that never existed or one long superseded.
        return {
          status: 404,
          body: { error: 'version_not_found', requested: version, current: team.current_version },
        };
      }

      return {
        status: 200,
        body: {
          team_id: team.team_id,
          name: team.name,
          version: record.version,
          current_version: team.current_version,
          definition: record.definition,
          resolved_roster: record.resolved_roster,
        },
      };
    },

    /**
     * Design spec R102 — soft delete.
     *
     * The definition only. Every member Agent and every Run the Team produced is retained,
     * or a Team Run's event stream would become uninterpretable the moment its Team was
     * tidied away.
     */
    async remove(teamId: string): Promise<RouteResponse> {
      const deleted = await store.softDelete(teamId);
      return deleted
        ? { status: 200, body: { deleted: teamId, agents_retained: true, runs_retained: true } }
        : { status: 404, body: { error: 'not_found', team_id: teamId } };
    },

    /** R40 — start a Team Run and return before it completes. */
    async createRun(raw: unknown): Promise<RouteResponse> {
      if (typeof raw !== 'object' || raw === null) {
        return { status: 400, body: { error: 'invalid_body', detail: 'a JSON object is required' } };
      }
      const body = raw as { team_id?: unknown; task?: unknown; workspace_path?: unknown };

      const problems: string[] = [];
      if (typeof body.team_id !== 'string' || body.team_id === '') {
        problems.push('`team_id` is required and must be a string');
      }
      if (typeof body.task !== 'string' || body.task === '') {
        problems.push('`task` is required and must be a non-empty string');
      }
      if (
        body.workspace_path !== undefined &&
        body.workspace_path !== null &&
        typeof body.workspace_path !== 'string'
      ) {
        problems.push('`workspace_path` must be a string when present');
      }
      if (problems.length > 0) {
        return { status: 400, body: { error: 'invalid_body', errors: problems } };
      }

      try {
        const { runId } = await orchestrator.start({
          teamId: body.team_id as string,
          task: body.task as string,
          workspacePath: (body.workspace_path as string | null | undefined) ?? null,
        });
        // The Team Run is an ordinary Run from here: GET /api/runs/{run_id} reports it and
        // /ws streams it (R24, R43).
        return { status: 201, body: { run_id: runId } };
      } catch (err) {
        if (err instanceof TeamRunStartError) {
          return { status: err.status, body: { error: err.code, detail: err.message } };
        }
        throw err;
      }
    },
  };
}

export type TeamRoutes = ReturnType<typeof createTeamRoutes>;
