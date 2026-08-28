/**
 * HTTP dispatch for the Team endpoints — Team Orchestration R39, R40.
 *
 * Same shape as agent-router.ts and run-router.ts, and same reason: `node:http` by
 * decision, a small closed route set, explicit matching. Returns null when the path is not
 * ours so the gateway owns its own 404.
 *
 * TWO PREFIXES, ONE DISPATCHER. `/api/teams` is the definition surface and `/api/team-runs`
 * starts a Run; they are one file because a caller that reaches neither must get exactly
 * one 404, and because forgetting to mount the second one is how this repo has repeatedly
 * shipped a handler nothing could reach.
 */

import type { RouteResponse } from './agents.js';
import type { TeamRoutes } from './teams.js';

const COLLECTION = '/api/teams';
const VALIDATE = '/api/teams/validate';
const TEAM_RUNS = '/api/team-runs';

export async function dispatchTeamRoute(
  routes: TeamRoutes,
  method: string,
  path: string,
  query: URLSearchParams,
  body: () => Promise<unknown>,
): Promise<RouteResponse | null> {
  if (path === TEAM_RUNS) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return routes.createRun(await body());
  }

  if (path !== COLLECTION && !path.startsWith(`${COLLECTION}/`)) return null;

  // Checked BEFORE the `{id}` patterns, or `validate` would be read as a team_id and
  // answer 404 for a route that exists.
  if (path === VALIDATE) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return routes.validateOnly(await body());
  }

  if (path === COLLECTION) {
    if (method === 'GET') return routes.list();
    if (method === 'POST') return routes.create(await body());
    return methodNotAllowed(['GET', 'POST']);
  }

  const [teamId, action, ...extra] = path.slice(COLLECTION.length + 1).split('/');
  // `/api/teams/a/b/c` is not a route. Answering 404 rather than ignoring the tail is what
  // stops a typo silently deleting a Team.
  if (!teamId || extra.length > 0 || action !== undefined) return null;

  if (method === 'GET') {
    // A non-numeric `?version=` is rejected rather than coerced: `?version=latest` becoming
    // NaN reads as "current" and would serve a different Team than the caller asked for.
    const raw = query.get('version');
    if (raw !== null && !/^\d+$/.test(raw)) {
      return {
        status: 400,
        body: { error: 'invalid_version', detail: `version must be a positive integer, got '${raw}'` },
      };
    }
    return routes.get(teamId, raw === null ? undefined : Number(raw));
  }

  if (method === 'PUT') return routes.create(await body());
  if (method === 'DELETE') return routes.remove(teamId);

  return methodNotAllowed(['GET', 'PUT', 'DELETE']);
}

function methodNotAllowed(allowed: string[]): RouteResponse {
  return { status: 405, body: { error: 'method_not_allowed', allowed } };
}
