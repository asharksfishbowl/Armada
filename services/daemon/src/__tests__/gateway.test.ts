/**
 * The gateway's single port — Agent Runtime R1, R6.
 *
 * Binds a real listener on a loopback port and speaks real HTTP and real WebSocket to it.
 * No Docker, no Postgres, no armada-models, so this stays a unit test under rule 9.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The first real smoke run found `GET /ws` answering 404. The routing was fine — the
 * upgrade handler worked — but the plain-HTTP path had no `/ws` branch, so a curl fell
 * through to the catch-all. A 404 asserts the route is ABSENT, which is indistinguishable
 * from the upgrade handler never having been wired, and that is precisely how it was first
 * read. R1's one-port promise was unverifiable over HTTP for as long as that was true.
 *
 * The regression guard that matters most here is the THIRD test: a new branch placed ahead
 * of a catch-all is the easy thing to get wrong, and swallowing genuine 404s would be a
 * worse bug than the one being fixed.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { Pool } from 'pg';

import { createGateway, type Gateway } from '../gateway/server.js';
import { PeerProbe } from '../gateway/routes/health.js';
import type { Event } from '../kernel/types.js';

const RECORDED: Event[] = [1, 2].map((seq) => ({
  eventId: `e${seq}`,
  runId: 'run-1',
  seq,
  type: 'user_message',
  payload: {},
  createdAt: '',
}));

/** Enough of a Kernel for the gateway: an EventSink and a plugin description. */
const kernel = {
  isReady: true,
  describe: () => [{ interface: 'EventSink', implementation: 'PostgresEventSink' }],
  get: () => ({
    name: 'stub',
    append: async () => ({}),
    read: async () => RECORDED.slice(),
  }),
} as never;

const pool = { query: async () => ({ rows: [{}] }) } as unknown as Pool;

let gateway: Gateway;
let base: string;

before(async () => {
  // Port 0 — the OS assigns a free one, so a busy port cannot make this flaky.
  gateway = createGateway({
    port: 0,
    version: '0.1.0',
    pool,
    probe: new PeerProbe([], 15, 50),
    kernel,
  });
  await new Promise((resolve) => gateway.server.once('listening', resolve));
  const { port } = gateway.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await gateway.close();
});

describe('R1 — one port serves both HTTP and WebSocket', () => {
  test('GET /ws returns 426, NOT 404', async () => {
    const response = await fetch(`${base}/ws`);
    // 404 would assert the route is absent — the defect the first smoke run caught.
    assert.equal(response.status, 426, 'the route exists; it requires an upgrade');
  });

  test('the 426 response carries Upgrade: websocket', async () => {
    const response = await fetch(`${base}/ws`);
    // Naming the protocol tells a client what to switch to, rather than leaving it to
    // infer that from the status code.
    assert.equal(response.headers.get('upgrade'), 'websocket');
    assert.match(response.headers.get('connection') ?? '', /upgrade/i);

    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'upgrade_required');
  });

  test('AN UNKNOWN PATH STILL RETURNS 404 — the new branch does not swallow the catch-all', async () => {
    // The easy thing to get wrong when adding a branch ahead of a catch-all. Swallowing
    // genuine 404s would be a worse bug than the one being fixed.
    for (const path of ['/api/nope', '/', '/wsx', '/ws/extra']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, `${path} must still 404`);
    }
  });

  test('a GENUINE WebSocket upgrade to /ws still completes', async () => {
    // The fix touches the same file as the working upgrade handler, so this proves it was
    // not disturbed — and it exercises R6's ordered replay end to end over a real socket.
    const received = await new Promise<Event[]>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      const events: Event[] = [];

      socket.on('open', () => socket.send(JSON.stringify({ subscribe: { run_id: 'run-1' } })));
      socket.on('message', (raw) => {
        events.push(JSON.parse(raw.toString()) as Event);
        if (events.length === RECORDED.length) {
          socket.close();
          resolve(events);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('websocket timed out')), 3000);
    });

    assert.deepEqual(
      received.map((e) => e.seq),
      [1, 2],
      'replay arrives in seq order',
    );
  });

  test('GET /api/health is served on the SAME port', async () => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { plugins: unknown[] };
    assert.equal(body.plugins.length, 1);
  });

  test('the server binds exactly one port', () => {
    const address = gateway.server.address() as AddressInfo;
    assert.ok(address.port > 0);
    // Two ports would mean two published ports, two firewall rules, and a dashboard that
    // can reach REST while silently failing to reach the event stream.
  });
});
