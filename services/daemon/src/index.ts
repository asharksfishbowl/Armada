/**
 * armada-daemon — process entry.
 *
 * PHASE 0 SKELETON. This boots, serves GET /api/health, and does nothing else, which is
 * the whole of what Phase 0 asks of it.
 *
 * What lands later, and where:
 *   Phase 2  the plugin kernel (R8-R15), the WebSocket half of the single port (R1, R6,
 *            R7), the event log (R54-R59), and the Docker sandbox provider (R44-R49).
 *   Phase 3  agent routes.
 *   Phase 4  the agent loop, tools, scheduler, budgets, and Code mode.
 *
 * ON THE HEALTH CONTRACT. Agent Runtime R3a defines health as 200 once the Kernel has
 * registered every declared plugin AND the database is reachable. There is no Kernel yet,
 * so this skeleton checks the half that exists — database reachability — and reports
 * `plugins: []` with `kernel: "not-loaded"` rather than claiming a registration that has
 * not happened. Phase 2 adds the plugin condition and with it the acceptance criterion
 * that health returns 503 before registration completes and 200 after.
 *
 * The Compose healthcheck targets this endpoint and dependent services gate on it, so
 * reporting healthy here means exactly "the process is up and can reach Postgres".
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';

const PORT = Number(process.env.ARMADA_PORT ?? 8080);
const VERSION = process.env.ARMADA_VERSION ?? '0.1.0';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('\n🛑 armada-daemon: DATABASE_URL is unset\n');
  process.exit(1);
}

/**
 * Small pool — Phase 0 only issues the health probe. The agent loop sizes this properly
 * in Phase 4 when it actually has concurrent work.
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
});

async function databaseReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('\n⚠️  armada-daemon: database probe failed:', err instanceof Error ? err.message : err, '\n');
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleHealth(res: ServerResponse): Promise<void> {
  const dbOk = await databaseReachable();

  // R3a — 200 only when every readiness condition holds. In Phase 0 that is the database
  // alone; Phase 2 adds plugin registration to this same gate.
  sendJson(res, dbOk ? 200 : 503, {
    status: dbOk ? 'ok' : 'unavailable',
    version: VERSION,
    plugins: [],
    checks: {
      database: dbOk ? 'ok' : 'unreachable',
      // Explicit rather than absent: a reader should be able to tell that the kernel is
      // not yet part of this gate, instead of inferring it from an empty plugin list.
      kernel: 'not-loaded',
    },
  });
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // R1 — one listener, multiplexed by path. /ws joins it in Phase 2.
  if (req.method === 'GET' && req.url === '/api/health') {
    void handleHealth(res);
    return;
  }

  sendJson(res, 404, { error: 'not_found', path: req.url ?? '' });
});

server.listen(PORT, () => {
  // DEBUG
  console.log('🚀 DAEMON_LISTENING:', { port: PORT, version: VERSION, health: '/api/health' });

});

/**
 * Compose sends SIGTERM on `docker compose down`. Close the listener and drain the pool
 * so a restart is not racing a half-open connection.
 *
 * Phase 2 extends this to release sandbox containers — a daemon that exits without
 * releasing leaves orphans, which is why R48 also requires cleanup on the next startup.
 */
function shutdown(signal: string): void {
  // DEBUG
  console.log('🏁 DAEMON_SHUTDOWN:', { signal });

  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
