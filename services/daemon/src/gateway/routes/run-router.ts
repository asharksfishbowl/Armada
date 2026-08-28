/**
 * HTTP dispatch for the Run endpoints — Agent Runtime R2, R3, R3b, R4.
 *
 * Same shape as agent-router.ts, and same reason: `node:http` by decision, a small closed
 * route set, explicit matching. Returns null when the path is not ours so the gateway owns
 * its own 404.
 */

import type { RouteResponse } from './agents.js';
import type { RunRoutes } from './runs.js';

const COLLECTION = '/api/runs';

export async function dispatchRunRoute(
  routes: RunRoutes,
  method: string,
  path: string,
  query: URLSearchParams,
  body: () => Promise<unknown>,
): Promise<RouteResponse | null> {
  if (path !== COLLECTION && !path.startsWith(`${COLLECTION}/`)) return null;

  if (path === COLLECTION) {
    if (method === 'GET') return routes.list(query);
    if (method === 'POST') return routes.create(await body());
    return { status: 405, body: { error: 'method_not_allowed', allowed: ['GET', 'POST'] } };
  }

  const [runId, action, ...extra] = path.slice(COLLECTION.length + 1).split('/');
  // `/api/runs/{id}/cancel/typo` is not a route. Answering 404 rather than ignoring the
  // tail is what stops a typo silently cancelling a Run.
  if (!runId || extra.length > 0) return null;

  if (action === 'cancel') {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed', allowed: ['POST'] } };
    return routes.cancel(runId);
  }

  if (action !== undefined) return null;

  if (method === 'GET') return routes.get(runId);
  return { status: 405, body: { error: 'method_not_allowed', allowed: ['GET'] } };
}
