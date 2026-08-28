/**
 * P7 — the Run surface. Agent Runtime R2, R3, R3b, R4; edge 16; D4/R18b.
 *
 * Routing is asserted separately from behaviour for the same reason agent-router.test.ts
 * does it: five components in this repo have been written, tested, and never called. The
 * handler tests below prove the decisions; these prove a request can reach them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchRunRoute } from '../gateway/routes/run-router.js';
import type { RunRoutes } from '../gateway/routes/runs.js';
import { verifyPinnedBinding } from '../models/binding-verifier.js';

function spyRoutes(): { routes: RunRoutes; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      const trimmed = [...args];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
      calls.push(`${name}(${trimmed.map((a) => (a instanceof URLSearchParams ? a.toString() : JSON.stringify(a))).join(',')})`);
      return { status: 200, body: {} };
    };
  return {
    calls,
    routes: {
      create: record('create'),
      get: record('get'),
      list: record('list'),
      cancel: record('cancel'),
    } as unknown as RunRoutes,
  };
}

const q = (s = '') => new URLSearchParams(s);
const noBody = async () => undefined;

describe('run route dispatch', () => {
  test('POST /api/runs starts a Run (R2)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchRunRoute(routes, 'POST', '/api/runs', q(), async () => ({ agent_id: 'a', task: 't' }));
    assert.deepEqual(calls, ['create({"agent_id":"a","task":"t"})']);
  });

  test('GET /api/runs lists (R3b)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchRunRoute(routes, 'GET', '/api/runs', q('status=running'), noBody);
    assert.deepEqual(calls, ['list(status=running)']);
  });

  test('GET /api/runs/{id} fetches one (R3)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchRunRoute(routes, 'GET', '/api/runs/r1', q(), noBody);
    assert.deepEqual(calls, ['get("r1")']);
  });

  test('POST /api/runs/{id}/cancel cancels (R4)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchRunRoute(routes, 'POST', '/api/runs/r1/cancel', q(), noBody);
    assert.deepEqual(calls, ['cancel("r1")']);
  });

  test('a trailing segment cannot silently cancel a Run', async () => {
    const { routes, calls } = spyRoutes();
    assert.equal(await dispatchRunRoute(routes, 'POST', '/api/runs/r1/cancel/typo', q(), noBody), null);
    assert.deepEqual(calls, []);
  });

  test('an unrelated path returns null so the gateway owns the 404', async () => {
    const { routes } = spyRoutes();
    assert.equal(await dispatchRunRoute(routes, 'GET', '/api/agents', q(), noBody), null);
    assert.equal(await dispatchRunRoute(routes, 'GET', '/api/runsomething', q(), noBody), null);
  });

  test('a wrong method names the allowed ones', async () => {
    const { routes } = spyRoutes();
    const res = await dispatchRunRoute(routes, 'DELETE', '/api/runs', q(), noBody);
    assert.equal(res?.status, 405);
  });
});

describe('D4 / R18b — a Run fails at start on an unmaterialized binding', () => {
  const pinned = { binding_tag: 'armada/qwen3-0.6b-base', context_window: 32768, tool_format: 'json_schema' as const };

  test('promoted but NOT materialized is refused, naming the tag and the action', () => {
    // The whole point of D4: registration and materialization are separate, so a binding
    // can be `promoted` with no weights present. The original check tested presence and
    // status only, which such a binding PASSES — and the Run then blocked behind a
    // multi-gigabyte transfer with no indication why.
    const verdict = verifyPinnedBinding(pinned, [
      { tag: pinned.binding_tag, status: 'promoted', materialized: false, materialization_status: 'unmaterialized' },
    ]);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.error, /armada\/qwen3-0\.6b-base/, 'names the tag');
    assert.match(verdict.error, /materialize/, 'names the action that fixes it');
  });

  test('a materialized promoted binding passes', () => {
    const verdict = verifyPinnedBinding(pinned, [
      { tag: pinned.binding_tag, status: 'promoted', materialized: true, materialization_status: 'materialized' },
    ]);
    assert.equal(verdict.ok, true);
  });

  test('a retired binding is refused and says WHY it is retired', () => {
    const verdict = verifyPinnedBinding(pinned, [
      { tag: pinned.binding_tag, status: 'retired', materialized: true, materialization_status: 'materialized' },
    ]);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    // `retired` and `missing` have different causes and different fixes.
    assert.match(verdict.error, /base-models\.yaml/);
  });

  test('an absent binding points at refresh-bindings', () => {
    const verdict = verifyPinnedBinding(pinned, []);
    assert.equal(verdict.ok, false);
    if (verdict.ok) return;
    assert.match(verdict.error, /refresh-bindings/);
  });
});
