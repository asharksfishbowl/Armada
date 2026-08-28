/**
 * P14 — the egress proxy. Agent Runtime R47: "only hosts in `allowed_hosts` are reachable;
 * all other egress is refused."
 *
 * THIS RUNS IN ITS OWN CONTAINER, NOT IN THE DAEMON. It is started from the armada-daemon
 * image by `DockerSandboxProvider` and is the single route off a per-Run internal network.
 * It is emphatically NOT a callback channel: it holds no database handle, no Kernel, and no
 * daemon credential — the container receives exactly two environment variables — and it
 * cannot reach any Armada service, because `isBlockedAddress` refuses every private,
 * loopback, link-local and CGNAT destination, which is where all of them live.
 *
 * ── WHY A FORWARD PROXY AND NOT FIREWALL RULES ──────────────────────────────
 * `allowed_hosts` is a list of HOSTNAMES. Packet filters match addresses. A rule
 * synthesised from today's DNS answer for `api.example.com` is wrong the moment that
 * record changes, and on a CDN it is wrong immediately and in both directions — too narrow
 * for the allowed host, too wide for everything else on the same address. A proxy is the
 * only place the requested *name* still exists.
 *
 * ── WHAT IT ENFORCES ────────────────────────────────────────────────────────
 *   1. The requested host and port must match a rule. Both `CONNECT host:port` and
 *      absolute-URI plain HTTP go through the same check.
 *   2. The name is resolved HERE, and the connection is pinned to the resolved address, so
 *      the sandbox never chooses a destination address.
 *   3. Any resolved address in a private/loopback/link-local/CGNAT range is refused, after
 *      resolution, so a public name pointed at 172.17.0.1 is caught too.
 *
 * ── WHAT IT CANNOT ENFORCE ──────────────────────────────────────────────────
 * CONNECT is an opaque tunnel. Once authorized, the proxy cannot see inside TLS, so a
 * client may present a different SNI and reach whatever else the allowed host's IP serves.
 * Refusals are written to this container's stdout and are readable with `docker logs`;
 * they are NOT Events in the Run's stream, because appending one would require the sandbox
 * side of the boundary to call into the daemon (invariant 3).
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import {
  ALLOWED_HOSTS_ENV,
  DEFAULT_PROXY_PORT,
  PROXY_PORT_ENV,
  PROXY_READY_LINE,
  isBlockedAddress,
  matchesAllowlist,
  parseAllowedHost,
  type HostRule,
} from './egress.js';

/** Injected so a test can exercise the address gate without controlling real DNS. */
export type AddressResolver = (host: string) => Promise<string[]>;

export interface EgressProxyOptions {
  rules: HostRule[];
  resolve?: AddressResolver;
  /**
   * TEST SEAM ONLY. Production leaves this off, and `createEgressProxy` never turns it on
   * by itself — a test asserts the default refuses a loopback target.
   */
  allowPrivateTargets?: boolean;
  log?: (line: string) => void;
}

const defaultResolver: AddressResolver = async (host) => {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/** Hop-by-hop headers. Forwarding these upstream is a protocol error. */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
]);

type Target =
  | { ok: true; address: string; port: number }
  | { ok: false; reason: string };

export function createEgressProxy(options: EgressProxyOptions): Server {
  const resolve = options.resolve ?? defaultResolver;
  const allowPrivate = options.allowPrivateTargets === true;
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));

  async function selectTarget(host: string, port: number): Promise<Target> {
    if (!matchesAllowlist(host, port, options.rules)) {
      return { ok: false, reason: `${host}:${port} is not in allowed_hosts` };
    }

    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = await resolve(host);
      } catch (err) {
        return { ok: false, reason: `${host} did not resolve: ${errText(err)}` };
      }
    }

    // Pin to a resolved address. The sandbox names a host; it never picks an address.
    const usable = allowPrivate ? addresses : addresses.filter((a) => !isBlockedAddress(a));
    const address = usable[0];
    if (address === undefined) {
      return {
        ok: false,
        reason:
          `${host} resolves only to private, loopback or link-local addresses ` +
          `(${addresses.join(', ') || 'none'}); refused because invariant 3 forbids a ` +
          'sandbox reaching back into the host or a sibling Armada service',
      };
    }
    return { ok: true, address, port };
  }

  const server = createServer();

  // ── CONNECT: the TLS path ──────────────────────────────────────────────────
  server.on('connect', (req: IncomingMessage, clientSocket: Socket) => {
    const { host, port } = splitAuthority(req.url ?? '', 443);
    if (host === '') {
      denyTunnel(clientSocket, 400, 'malformed CONNECT target');
      return;
    }

    void selectTarget(host, port).then((target) => {
      if (!target.ok) {
        log(`🛑 EGRESS DENIED: CONNECT ${host}:${port} — ${target.reason}`);
        // 403 before any socket is opened. A denial costs the destination nothing,
        // because nothing was dialled.
        denyTunnel(clientSocket, 403, target.reason);
        return;
      }

      const upstream = netConnect({ host: target.address, port: target.port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', (err) => {
        denyTunnel(clientSocket, 502, `upstream error: ${errText(err)}`);
      });
      clientSocket.on('error', () => upstream.destroy());
    });
  });

  // ── Absolute-URI requests: the plain HTTP path ─────────────────────────────
  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('armada-egress-proxy: this is a forward proxy; requests must use an absolute URI\n');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`armada-egress-proxy: ${url.protocol} is not proxied; use CONNECT for TLS\n`);
      return;
    }

    const port = url.port === '' ? 80 : Number(url.port);
    void selectTarget(url.hostname, port).then((target) => {
      if (!target.ok) {
        log(`🛑 EGRESS DENIED: ${req.method ?? 'GET'} ${url.hostname}:${port} — ${target.reason}`);
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end(`armada-egress-proxy: refused — ${target.reason}\n`);
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
        headers[name] = value;
      }
      headers['host'] = url.host;

      const upstream = httpRequest(
        {
          host: target.address,
          port: target.port,
          method: req.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          headers,
          setHost: false,
        },
        (upstreamRes) => {
          // Hop-by-hop headers are stripped in BOTH directions. Forwarding the upstream's
          // `connection: keep-alive` back to a client that asked for `connection: close`
          // holds the client's socket open until it times out, which reads as a hung
          // request rather than as the completed one it is.
          const responseHeaders: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
            responseHeaders[name] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`armada-egress-proxy: upstream error — ${errText(err)}\n`);
      });
      req.pipe(upstream);
    });
  });

  // A malformed client request must not take the proxy down mid-Run.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function denyTunnel(socket: Socket, status: number, reason: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n` +
        'content-type: text/plain\r\n' +
        'connection: close\r\n\r\n' +
        `armada-egress-proxy: refused — ${reason}\n`,
    );
  }
  socket.destroy();
}

/** `host:port` from a CONNECT target. IPv6 literals arrive bracketed. */
export function splitAuthority(authority: string, defaultPort: number): { host: string; port: number } {
  const value = authority.trim();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return { host: '', port: defaultPort };
    const host = value.slice(1, close);
    const rest = value.slice(close + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    return { host, port: Number.isInteger(port) && port > 0 ? port : defaultPort };
  }
  const colon = value.lastIndexOf(':');
  if (colon < 0) return { host: value, port: defaultPort };
  const port = Number(value.slice(colon + 1));
  return {
    host: value.slice(0, colon),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPort,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-parse the allowlist with the SAME parser the daemon validated it with.
 *
 * The daemon already rejected a malformed list at startup, so a failure here means the
 * container was started by something other than the daemon. Exiting non-zero is the only
 * safe answer: a proxy that came up with a partial allowlist would be filtering to a list
 * nobody wrote.
 */
export function rulesFromEnv(value: string | undefined): HostRule[] {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${ALLOWED_HOSTS_ENV} is unset; an egress proxy with no allowlist reaches nothing`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch (err) {
    throw new Error(`${ALLOWED_HOSTS_ENV} is not valid JSON: ${errText(err)}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${ALLOWED_HOSTS_ENV} must be a non-empty JSON array of hosts`);
  }

  const rules: HostRule[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const parsed = parseAllowedHost(entry);
    if (parsed.ok) rules.push(parsed.rule);
    else problems.push(parsed.error);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  return rules;
}

/** Container entry point. Not reached when this module is imported by a test. */
export function main(env: NodeJS.ProcessEnv = process.env): Server {
  const rules = rulesFromEnv(env[ALLOWED_HOSTS_ENV]);
  const port = Number(env[PROXY_PORT_ENV] ?? DEFAULT_PROXY_PORT);
  const server = createEgressProxy({ rules });
  server.listen(port, '0.0.0.0', () => {
    // The provider waits for this exact line over `docker logs --follow` rather than
    // sleeping, so the sandbox is never created against a listener that is not up.
    process.stdout.write(
      `${PROXY_READY_LINE} on ${port}; allowing ${rules.map(describeRule).join(', ')}\n`,
    );
  });
  return server;
}

function describeRule(rule: HostRule): string {
  return `${rule.wildcard ? '*.' : ''}${rule.host}:${rule.ports.join('|')}`;
}

// `node /app/dist/sandbox/egress-proxy.js` — argv[1] is this file only when run directly.
if (process.argv[1] !== undefined && process.argv[1].endsWith('egress-proxy.js')) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`\n🛑 armada-egress-proxy: ${errText(err)}\n\n`);
    process.exit(1);
  }
}
