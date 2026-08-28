/**
 * P8 — the Team surface is REACHABLE. Team Orchestration R39, R40.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS BECAUSE UNIT TESTS PASS HAPPILY ON UNREACHABLE CODE.
 *
 * Armada has now shipped SIX components that were written, unit tested, and called by
 * nothing: `min_ram_gb`, `validate_directory_location`, the Agent routes, the Agent file
 * loader, `verifyPinnedBinding`, and a placeholder system prompt. Every one of them had
 * passing tests. The tests were not wrong; they were testing a function, and nobody was
 * testing that anything called it.
 *
 * So this file asserts three separate layers, because each has failed independently:
 *
 *   1. dispatch      — the router maps a path and method onto a handler
 *   2. the gateway   — a real HTTP request on the real listener reaches that router
 *   3. the process   — index.ts constructs the routes, mounts them, AND loads teams/
 *
 * Layer 3 is asserted against the source of index.ts. That is unusual and it is
 * deliberate: it is the only layer that cannot be exercised without a database, a Docker
 * socket and a reachable forge, and it is precisely the layer where all six defects lived.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';

import { dispatchTeamRoute } from '../gateway/routes/team-router.js';
import type { TeamRoutes } from '../gateway/routes/teams.js';
import { createGateway, type Gateway } from '../gateway/server.js';
import { PeerProbe } from '../gateway/routes/health.js';

function spyRoutes(): { routes: TeamRoutes; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
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
      remove: record('remove'),
      createRun: record('createRun'),
    } as unknown as TeamRoutes,
  };
}

const q = (s = '') => new URLSearchParams(s);
const noBody = async () => undefined;

describe('layer 1 — route dispatch (R39, R40)', () => {
  test('POST /api/teams creates', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'POST', '/api/teams', q(), async () => ({ name: 't' }));
    assert.deepEqual(calls, ['create({"name":"t"})']);
  });

  test('GET /api/teams lists', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'GET', '/api/teams', q(), noBody);
    assert.deepEqual(calls, ['list()']);
  });

  test('POST /api/teams/validate is matched BEFORE the {id} pattern', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'POST', '/api/teams/validate', q(), async () => ({ name: 't' }));
    // Otherwise `validate` reads as a team_id and a route that exists answers 404.
    assert.deepEqual(calls, ['validateOnly({"name":"t"})']);
  });

  test('GET /api/teams/{id}?version=2 selects a pinned version', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'GET', '/api/teams/t1', q('version=2'), noBody);
    assert.deepEqual(calls, ['get("t1",2)']);
  });

  test('a non-numeric version is rejected rather than coerced', async () => {
    const { routes, calls } = spyRoutes();
    const res = await dispatchTeamRoute(routes, 'GET', '/api/teams/t1', q('version=latest'), noBody);
    assert.equal(res?.status, 400);
    assert.deepEqual(calls, []);
  });

  test('PUT /api/teams/{id} updates, DELETE removes', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'PUT', '/api/teams/t1', q(), async () => ({ name: 't' }));
    await dispatchTeamRoute(routes, 'DELETE', '/api/teams/t1', q(), noBody);
    assert.deepEqual(calls, ['create({"name":"t"})', 'remove("t1")']);
  });

  test('POST /api/team-runs starts a Team Run (R40)', async () => {
    const { routes, calls } = spyRoutes();
    await dispatchTeamRoute(routes, 'POST', '/api/team-runs', q(), async () => ({
      team_id: 't1',
      task: 'go',
    }));
    assert.deepEqual(calls, ['createRun({"team_id":"t1","task":"go"})']);
  });

  test('a trailing segment is not a route', async () => {
    const { routes, calls } = spyRoutes();
    assert.equal(await dispatchTeamRoute(routes, 'DELETE', '/api/teams/t1/typo', q(), noBody), null);
    assert.deepEqual(calls, []);
  });

  test('an unrelated path returns null so the gateway owns the 404', async () => {
    const { routes } = spyRoutes();
    assert.equal(await dispatchTeamRoute(routes, 'GET', '/api/agents', q(), noBody), null);
    assert.equal(await dispatchTeamRoute(routes, 'GET', '/api/teamsomething', q(), noBody), null);
  });

  test('a wrong method names the allowed ones', async () => {
    const { routes } = spyRoutes();
    assert.equal((await dispatchTeamRoute(routes, 'GET', '/api/team-runs', q(), noBody))?.status, 405);
    assert.equal((await dispatchTeamRoute(routes, 'PATCH', '/api/teams', q(), noBody))?.status, 405);
  });
});

describe('layer 2 — the gateway actually mounts them', () => {
  const kernel = {
    isReady: true,
    describe: () => [{ interface: 'EventSink', implementation: 'stub' }],
    get: () => ({ name: 'stub', append: async () => ({}), read: async () => [] }),
  } as never;
  const pool = { query: async () => ({ rows: [{}] }) } as unknown as Pool;

  let gateway: Gateway;
  let base: string;
  let calls: string[];

  before(async () => {
    const spy = spyRoutes();
    calls = spy.calls;
    gateway = createGateway({
      port: 0,
      version: '0.1.0',
      pool,
      probe: new PeerProbe([], 15, 50),
      kernel,
      teamRoutes: spy.routes,
    });
    await new Promise((resolve) => gateway.server.once('listening', resolve));
    base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await gateway.close();
  });

  test('GET /api/teams reaches the handler, NOT the catch-all 404', async () => {
    const response = await fetch(`${base}/api/teams`);
    // A 404 here is exactly what `/api/agents` answered through all of P4, P5 and P6.
    assert.equal(response.status, 200);
    assert.ok(calls.includes('list()'));
  });

  test('POST /api/team-runs reaches the handler', async () => {
    const response = await fetch(`${base}/api/team-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team_id: 't1', task: 'go' }),
    });
    assert.equal(response.status, 200);
    assert.ok(calls.some((c) => c.startsWith('createRun(')));
  });

  test('an unknown path still 404s — the new branch does not swallow them', async () => {
    const response = await fetch(`${base}/api/nonsense`);
    assert.equal(response.status, 404);
  });
});

describe('layer 3 — the process wires the Team surface at startup', () => {
  const indexPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'src',
    'index.ts',
  );

  /**
   * Reads the SOURCE of index.ts.
   *
   * Importing it is not an option: index.ts opens a database pool, asserts the Docker
   * socket is mounted, and calls process.exit on any fault. So the wiring is asserted
   * statically. It is a coarse test and it would have caught all six of this repo's
   * unwired components, which is the bar it is written to.
   */
  test('index.ts constructs the routes, MOUNTS them, and loads teams/', async () => {
    const source = await readFile(indexPath, 'utf8');

    for (const fragment of [
      'createTeamRoutes(',
      'new TeamOrchestrator(',
      // R41 — the loader that makes teams/frontend-feature-team.yaml exist at runtime.
      'loadTeamDirectory(',
    ]) {
      assert.ok(source.includes(fragment), `index.ts must call ${fragment}`);
    }

    // The mount itself. `createTeamRoutes` without this line is the Agent-routes defect
    // repeated exactly: every handler written, every handler unreachable.
    const gatewayCall = source.slice(source.indexOf('createGateway({'));
    assert.ok(
      /\bteamRoutes\b/.test(gatewayCall.slice(0, gatewayCall.indexOf('});') + 3)),
      'teamRoutes must be passed to createGateway',
    );
  });

  test('index.ts routes model requests through the scheduler (R20-R22, D5)', async () => {
    const source = await readFile(indexPath, 'utf8');
    // ModelScheduler shipped in P7 written, tested, and called by nothing, so the per-tag
    // and total limits in config/models.yaml enforced nothing at all.
    assert.ok(source.includes('new ModelScheduler('), 'a scheduler must be constructed');
    assert.ok(source.includes('scheduler: modelScheduler'), 'and handed to the RunOrchestrator');
  });
});
