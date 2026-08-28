/**
 * P7 — HTTP dispatch for the Agent surface. Agent Definition R26-R30.
 *
 * WHY THIS SUITE IS THE POINT OF THE CHANGE. Every handler these tests exercise was
 * written and unit-tested in P4. All of them worked. `/api/agents` still answered 404 for
 * three phases, because `server.ts` imported only `routes/health.js` and nothing ever
 * asserted that a request reached a handler.
 *
 * So these tests deliberately assert ROUTING, not handler behaviour — which route a given
 * method and path reaches, and that an unmatched path reaches none. The handlers already
 * have their own suite; what was missing was the thing that fails when they are
 * unreachable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchAgentRoute, type AgentRoutes } from '../gateway/routes/agent-router.js';

/** Records which handler ran, so a test can assert dispatch rather than behaviour. */
function spyRoutes(): { routes: AgentRoutes; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      // Trailing `undefined` is dropped before serialising. The router calls
      // `get(id, undefined)` when no ?version is present, which is the correct call —
      // but `JSON.stringify(undefined)` is `undefined`, so a naive join renders it
      // `get("abc",)` and the test fails on its own formatting rather than on behaviour.
      const trimmed = [...args];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
      calls.push(`${name}(${trimmed.map((a) => JSON.stringify(a)).join(',')})`);
      return { status: 200, body: { ok: name } };
    };
  return {
    calls,
    routes: {
      create: record('create'),
      validateOnly: record('validateOnly'),
      list: record('list'),
      get: record('get'),
      refresh: record('refresh'),
      remove: record('remove'),
    } as unknown as AgentRoutes,
  };
}

const q = (s = '') => new URLSearchParams(s);
const noBody = async () => undefined;

describe('agent route dispatch', () => {
  test('GET /api/agents lists (R29)', async () => {
    const { routes, calls } = spyRoutes();
    const res = await dispatchAgentRoute(routes, 'GET', '/api/agents', q(), noBody);
    assert.equal(res?.status, 200);
    assert.deepEqual(calls, ['list()']);
  });

  test('POST /api/agents creates, and the body is passed through (R27)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'POST', '/api/agents', q(), async () => ({ name: 'chef' }));
    assert.deepEqual(calls, ['create({"name":"chef"})']);
  });

  test('POST /api/agents/validate persists nothing and is matched before {id} (R30)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'POST', '/api/agents/validate', q(), async () => ({ a: 1 }));
    // The ordering matters: matched after the `{id}` pattern, `validate` would be read as
    // an agent_id and answer 404 for a route that exists.
    assert.deepEqual(calls, ['validateOnly({"a":1})']);
  });

  test('GET /api/agents/{id} fetches one (R28)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'GET', '/api/agents/abc', q(), noBody);
    assert.deepEqual(calls, ['get("abc")']);
  });

  test('GET /api/agents/{id}?version=3 selects a pinned version (R28)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'GET', '/api/agents/abc', q('version=3'), noBody);
    assert.deepEqual(calls, ['get("abc",3)']);
  });

  test('a non-numeric version is rejected, not coerced', async () => {
    const { routes, calls } = spyRoutes();
    const res = await dispatchAgentRoute(routes, 'GET', '/api/agents/abc', q('version=latest'), noBody);
    assert.equal(res?.status, 400);
    // `Number('latest')` is NaN, which reads as "current" — serving a DIFFERENT Agent
    // than the caller asked for, silently. No handler may run.
    assert.deepEqual(calls, []);
  });

  test('POST /api/agents/{id}/refresh-bindings refreshes (R25a)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'POST', '/api/agents/abc/refresh-bindings', q(), noBody);
    assert.deepEqual(calls, ['refresh("abc")']);
  });

  test('DELETE /api/agents/{id} soft-deletes (R26)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchAgentRoute(routes, 'DELETE', '/api/agents/abc', q(), noBody);
    assert.deepEqual(calls, ['remove("abc")']);
  });

  test('a wrong method names the ones that are allowed', async () => {
    const { routes, calls } = spyRoutes();
    const res = await dispatchAgentRoute(routes, 'PUT', '/api/agents', q(), noBody);
    assert.equal(res?.status, 405);
    assert.deepEqual((res?.body as { allowed: string[] }).allowed, ['GET', 'POST']);
    assert.deepEqual(calls, []);
  });

  test('an unrelated path returns null so the gateway owns the 404', async () => {
    const { routes, calls } = spyRoutes();
    assert.equal(await dispatchAgentRoute(routes, 'GET', '/api/health', q(), noBody), null);
    assert.equal(await dispatchAgentRoute(routes, 'GET', '/api/runs', q(), noBody), null);
    assert.deepEqual(calls, []);
  });

  test('a path that only looks like ours is not ours', async () => {
    const { routes } = spyRoutes();
    // `/api/agentsomething` shares the prefix but is a different route entirely — the
    // reason the check is `=== COLLECTION || startsWith(COLLECTION + '/')` and not a
    // bare `startsWith`.
    assert.equal(await dispatchAgentRoute(routes, 'GET', '/api/agentsomething', q(), noBody), null);
  });

  test('a trailing segment does not silently trigger the action before it', async () => {
    const { routes, calls } = spyRoutes();
    const res = await dispatchAgentRoute(
      routes,
      'POST',
      '/api/agents/abc/refresh-bindings/typo',
      q(),
      noBody,
    );
    assert.equal(res, null);
    assert.deepEqual(calls, []);
  });
});
