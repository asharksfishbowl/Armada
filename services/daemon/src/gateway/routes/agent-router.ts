/**
 * HTTP dispatch for the Agent routes — Agent Definition R26-R30.
 *
 * WHY THIS FILE EXISTS AT ALL. `createAgentRoutes` was written in P4 with every handler
 * complete and tested, and was then never mounted: `server.ts` imported only
 * `routes/health.js`, so every `/api/agents` request fell through to the catch-all 404.
 * The smoke test read that 404 and recorded `SKIP shipped Agents loaded (GET /api/agents
 * returned 404 — routes wire up in P7)`, which made a wiring gap look like a phase that
 * had not landed yet.
 *
 * That is this repo's most repeated defect — a validator written and not called, a
 * `min_ram_gb` read by nothing, a test rule stated everywhere and enforced nowhere. The
 * handlers are the easy half; the thing that fails when they are absent is the half that
 * keeps getting skipped.
 *
 * PATH MATCHING IS EXPLICIT, NOT A FRAMEWORK. The repo has no HTTP framework by decision
 * (`node:http`, recorded in CLAUDE.md), and the route set is small and closed. A hand-rolled
 * matcher is the right size for six routes; it would be the wrong size for sixty.
 */

import type { createAgentRoutes } from './agents.js';
import type { RouteResponse } from './agents.js';

export type AgentRoutes = ReturnType<typeof createAgentRoutes>;

/** `/api/agents/{id}` and `/api/agents/{id}/refresh-bindings`, plus the collection. */
const COLLECTION = '/api/agents';
const VALIDATE = '/api/agents/validate';

/**
 * Returns null when the path is not ours, so `server.ts` can fall through to its own 404
 * rather than this file deciding what an unknown path means.
 */
export async function dispatchAgentRoute(
  routes: AgentRoutes,
  method: string,
  path: string,
  query: URLSearchParams,
  body: () => Promise<unknown>,
): Promise<RouteResponse | null> {
  if (path !== COLLECTION && !path.startsWith(`${COLLECTION}/`)) return null;

  // R30 — checked BEFORE the `{id}` patterns, or `validate` would be read as an agent_id
  // and answer 404 for a route that exists.
  if (path === VALIDATE) {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return routes.validateOnly(await body());
  }

  if (path === COLLECTION) {
    if (method === 'GET') return routes.list();
    if (method === 'POST') return routes.create(await body());
    return methodNotAllowed(['GET', 'POST']);
  }

  const rest = path.slice(COLLECTION.length + 1);
  const [agentId, action, ...extra] = rest.split('/');

  // `/api/agents/a/b/c` is not a route. Answering 404 here rather than ignoring the tail
  // stops `/api/agents/{id}/refresh-bindings/typo` silently refreshing bindings.
  if (!agentId || extra.length > 0) return null;

  if (action === 'refresh-bindings') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    return routes.refresh(agentId);
  }

  if (action !== undefined) return null;

  if (method === 'GET') {
    // R28 — `?version=3` selects a pinned version. A non-numeric value is rejected rather
    // than coerced: `?version=latest` silently becoming version 0 (or NaN, which reads as
    // "current") would serve a different Agent than the caller asked for.
    const raw = query.get('version');
    if (raw !== null && !/^\d+$/.test(raw)) {
      return {
        status: 400,
        body: {
          error: 'invalid_version',
          detail: `version must be a positive integer, got '${raw}'`,
        },
      };
    }
    return routes.get(agentId, raw === null ? undefined : Number(raw));
  }

  if (method === 'DELETE') return routes.remove(agentId);

  return methodNotAllowed(['GET', 'DELETE']);
}

function methodNotAllowed(allowed: string[]): RouteResponse {
  return {
    status: 405,
    // Named, so a client learns which verb to use instead of retrying blind.
    body: { error: 'method_not_allowed', allowed },
  };
}
