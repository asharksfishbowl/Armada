/**
 * The gateway — Agent Runtime R1.
 *
 * ONE listener on ONE port, multiplexed by path: HTTP under `/api/*`, WebSocket at `/ws`.
 *
 * A single port is not an aesthetic choice. Armada is a single-operator, trusted-network
 * deployment with one Compose service to expose and one healthcheck to gate on; two ports
 * would mean two published ports, two firewall rules, and a dashboard that can reach the
 * REST API while silently failing to reach the event stream. Sharing the listener makes
 * "the daemon is reachable" one fact instead of two.
 *
 * Route handlers beyond health arrive in later phases (agents in P4, runs in P7). This
 * file owns the listener, the upgrade handshake, and dispatch — not the endpoints.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Pool } from 'pg';
import type { Kernel } from '../kernel/kernel.js';
import { buildHealth, PeerProbe } from './routes/health.js';
import { WsRouter } from './ws-router.js';

export interface GatewayOptions {
  port: number;
  version: string;
  pool: Pool;
  probe: PeerProbe;
  /**
   * Always registered by the time the listener opens — index.ts exits non-zero on a
   * plugin fault before reaching here, so there is no window in which the port serves
   * requests against a half-registered Kernel.
   */
  kernel: Kernel;
}

export interface Gateway {
  server: Server;
  wsRouter: WsRouter;
  close(): Promise<void>;
}

/** Both the health route and the upgrade handler need the path without its query string. */
const pathOf = (req: IncomingMessage): string => (req.url ?? '').split('?')[0] ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createGateway(options: GatewayOptions): Gateway {
  const { port, version, pool, probe } = options;
  const wsRouter = new WsRouter(options.kernel.get('EventSink'));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);

    if (req.method === 'GET' && path === '/api/health') {
      // buildHealth never rejects — it reports unhealthy instead. A health endpoint that
      // throws is worse than one that returns 503: the Compose healthcheck would see a
      // connection error rather than a body it can log.
      void buildHealth(options.kernel, pool, version, probe).then(({ status, body }) =>
        sendJson(res, status, body),
      );
      return;
    }

    // R1 — /ws is a REAL route on this port; it just requires an upgrade.
    //
    // Without this branch a plain GET falls through to the catch-all below and answers
    // 404, which asserts the route is ABSENT. That is indistinguishable from the upgrade
    // handler never having been wired — and it is exactly how the first smoke run read it.
    // R1 promises one port serving both HTTP and WebSocket, and R6's subscribe plus P10's
    // live run inspection both hang off this endpoint, so anyone curling it to confirm the
    // event stream is reachable would wrongly conclude it is not.
    //
    // 426 is RFC 7231 §6.5.15's answer for precisely this case: the route exists, and the
    // client must switch protocols to use it.
    if (path === '/ws') {
      const body = JSON.stringify({
        error: 'upgrade_required',
        detail: 'GET /ws is the run event stream and requires a WebSocket upgrade.',
        path,
      });
      res.writeHead(426, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        // Named in the response so a client is told which protocol to switch to, rather
        // than being left to infer it from the status code alone.
        upgrade: 'websocket',
        connection: 'Upgrade',
      });
      res.end(body);
      return;
    }

    sendJson(res, 404, { error: 'not_found', path });
  });

  // `noServer` rather than letting ws own a port — that is what keeps this to ONE
  // listener. The upgrade is dispatched by path below.
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => {
      void wsRouter.handleMessage(socket, data.toString());
    });
    socket.on('close', () => wsRouter.disconnect(socket));
    // An erroring socket also closes, but registering here avoids an unhandled 'error'
    // event taking the process down.
    socket.on('error', () => wsRouter.disconnect(socket));
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = pathOf(req);

    if (path !== '/ws') {
      // Refuse rather than hang: a client upgrading on the wrong path should learn.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  server.listen(port);

  return {
    server,
    wsRouter,
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.close();
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}
