/**
 * P14 — the egress allowlist subsystem. Agent Runtime R44/R47; build-plan Req 29, D7.
 *
 * ── THE MECHANISM, STATED RATHER THAN IMPLIED ───────────────────────────────
 * Docker has no per-container host allowlist primitive. D7 names the two real options: a
 * proxy sidecar on an internal network with outbound DNS blocked, or per-container
 * firewall rules. This implements the first, because the second needs NET_ADMIN on the
 * host, cannot express a *hostname* allowlist at all (only addresses), and does not
 * survive a rootless daemon.
 *
 * Per Run, when — and only when — the Agent's profile declares `network: egress_allowlist`:
 *
 *   1. `docker network create --internal armada-egress-{run_id}`
 *      `--internal` is the load-bearing flag. Docker installs no masquerade/forward rule
 *      for an internal bridge, so a container on it has NO ROUTE OFF THE HOST. That is
 *      what blocks egress "including by direct IP" — the sandbox never gets to choose a
 *      destination, because it has no path to any of them.
 *   2. A proxy container, from the armada-daemon image running `egress-proxy.js`, joined
 *      to BOTH the default bridge (which has egress) and that internal network under the
 *      alias `armada-egress-proxy`. It holds the allowlist and is the only route out.
 *   3. The sandbox joins the internal network alone, with HTTP_PROXY/HTTPS_PROXY pointed
 *      at the alias and `--dns 127.0.0.1` so no external name resolves inside it.
 *
 * ── WHAT THIS ACTUALLY BLOCKS, AND WHAT IT DOES NOT ─────────────────────────
 * BLOCKS: every TCP destination the sandbox might dial itself, by IP or by name, because
 * the internal network has no route. Non-HTTP protocols (ssh, raw TCP, QUIC/UDP) are not
 * proxied and therefore do not work at all. DNS for external names fails in the sandbox,
 * so a DNS-tunnel exfiltration channel is closed as well as name resolution.
 * DOES NOT BLOCK: a second name served by an allowed host's IP. CONNECT is a tunnel, so
 * the proxy authorizes the requested host, pins the connection to that host's resolved
 * address, and then cannot see inside TLS — a client that CONNECTs to an allowed host and
 * sends a different SNI reaches whatever that same address serves. Closing that needs TLS
 * interception with a trusted CA in every sandbox image, which buys less than it costs.
 * ALSO NOT BLOCKED: nothing here verifies that the host's Docker actually honours
 * `--internal`; on an exotic firewall backend it might not, and the daemon does not probe.
 *
 * ── INVARIANT 3 IS WIDER HERE, NEVER REVERSED ───────────────────────────────
 * An allowlist widens what a sandbox may REACH OUT to. It creates no path back in. Three
 * things enforce that and each one is checked:
 *   - the proxy refuses any target that resolves to a private, loopback, link-local or
 *     CGNAT address (`isBlockedAddress`), which is where armada-daemon, armada-db,
 *     armada-forge, armada-models and every host-published port live;
 *   - `allowed_hosts` rejects a single-label name at config load, because a single-label
 *     name can only be a container on this host;
 *   - the proxy container is created with exactly two environment variables and no
 *     Docker socket, so it inherits nothing of the daemon's credentials or privilege.
 */

import { isIP } from 'node:net';

/** The DNS alias the sandbox reaches the proxy by, on the per-Run internal network. */
export const PROXY_ALIAS = 'armada-egress-proxy';

/** Squid's traditional port. Nothing depends on the number; it is only a default. */
export const DEFAULT_PROXY_PORT = 3128;

/** Ports an `allowed_hosts` entry covers when it names none. */
export const DEFAULT_EGRESS_PORTS = [80, 443] as const;

/** Written by the proxy once its listener is bound. The provider waits for this line. */
export const PROXY_READY_LINE = 'armada-egress-proxy: listening';

export const EGRESS_PROXY_COMMAND = ['node', '/app/dist/sandbox/egress-proxy.js'];

/** Marks the proxy container so it is distinguishable from the sandbox it serves. */
export const ROLE_LABEL = 'armada.role';
export const PROXY_ROLE = 'egress-proxy';

export const ALLOWED_HOSTS_ENV = 'ARMADA_EGRESS_ALLOWED_HOSTS';
export const PROXY_PORT_ENV = 'ARMADA_EGRESS_PORT';
export const PROXY_IMAGE_ENV = 'ARMADA_EGRESS_PROXY_IMAGE';

/** One parsed `allowed_hosts` entry. */
export interface HostRule {
  /** Lowercase, no trailing dot. For a wildcard rule this is the parent domain. */
  host: string;
  /** True for `*.example.com` — matches subdomains, NOT the apex. */
  wildcard: boolean;
  ports: number[];
}

/** A profile's egress mode, resolved at config load. Present only in that mode. */
export interface ResolvedEgress {
  /** Must be an image carrying the daemon's `dist/` — i.e. the armada-daemon image. */
  proxyImage: string;
  proxyPort: number;
  /** The raw entries, passed to the proxy so it re-parses with THIS parser. */
  allowedHosts: string[];
  rules: HostRule[];
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse one `allowed_hosts` entry: `example.com`, `*.example.com`, `example.com:8443`.
 *
 * Every rejection below exists because the alternative is an entry that looks like it
 * restricts egress and does not.
 */
export function parseAllowedHost(
  entry: unknown,
): { ok: true; rule: HostRule } | { ok: false; error: string } {
  if (typeof entry !== 'string') {
    return { ok: false, error: `\`${String(entry)}\` is not a string` };
  }

  const raw = entry.trim().toLowerCase();
  if (raw === '') return { ok: false, error: 'an empty entry allows nothing and means nothing' };

  if (raw.includes('://') || raw.includes('/')) {
    return {
      ok: false,
      error: `\`${entry}\` looks like a URL; allowed_hosts holds hosts, optionally \`host:port\` — a scheme or path is never matched`,
    };
  }
  if (/\s|@|\?|#/.test(raw)) {
    return { ok: false, error: `\`${entry}\` contains a character that cannot appear in a host` };
  }
  if (raw === '*' || raw === '*.') {
    return {
      ok: false,
      error: '`*` would allow every host, which is not an allowlist; use `network: none` if egress should be unrestricted-by-absence, or name the hosts',
    };
  }
  if (raw.startsWith('[') || raw.split(':').length > 2) {
    return {
      ok: false,
      error: `\`${entry}\`: IPv6 literals are not supported in allowed_hosts; name the host instead`,
    };
  }

  let hostPart = raw;
  let ports: number[] = [...DEFAULT_EGRESS_PORTS];
  const colon = raw.indexOf(':');
  if (colon >= 0) {
    hostPart = raw.slice(0, colon);
    const portText = raw.slice(colon + 1);
    if (!/^\d+$/.test(portText)) {
      return { ok: false, error: `\`${entry}\`: \`${portText}\` is not a port number` };
    }
    const port = Number(portText);
    if (port < 1 || port > 65535) {
      return { ok: false, error: `\`${entry}\`: port ${port} is outside 1-65535` };
    }
    ports = [port];
  }

  let wildcard = false;
  if (hostPart.startsWith('*.')) {
    wildcard = true;
    hostPart = hostPart.slice(2);
  }
  if (hostPart.includes('*')) {
    return {
      ok: false,
      error: `\`${entry}\`: the only supported wildcard is a leading \`*.\` covering subdomains`,
    };
  }
  if (hostPart.endsWith('.')) hostPart = hostPart.slice(0, -1);
  if (hostPart === '') return { ok: false, error: `\`${entry}\` names no host` };

  if (isIP(hostPart) === 4) {
    if (wildcard) return { ok: false, error: `\`${entry}\`: a wildcard cannot apply to an IP address` };
    if (isBlockedAddress(hostPart)) {
      return {
        ok: false,
        error:
          `\`${entry}\` is a private, loopback or link-local address. Invariant 3 is ` +
          'one-directional: an egress allowlist may widen what a sandbox reaches OUT to, ' +
          'never open a path back to armada-daemon, armada-db, armada-forge, ' +
          'armada-models, or any host-published port.',
      };
    }
    return { ok: true, rule: { host: hostPart, wildcard: false, ports } };
  }

  const labels = hostPart.split('.');
  if (labels.length < 2) {
    return {
      ok: false,
      error:
        `\`${entry}\` is a single-label name, which on this host can only be a container ` +
        '— reaching a sibling Armada service is the callback path invariant 3 forbids. ' +
        'Name a fully-qualified host.',
    };
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return { ok: false, error: `\`${entry}\`: \`${label}\` is not a valid DNS label` };
    }
  }

  return { ok: true, rule: { host: hostPart, wildcard, ports } };
}

/**
 * Does `host:port` match any rule?
 *
 * A wildcard rule covers subdomains and NOT the apex — `*.example.com` does not admit
 * `example.com`. Allowing both from one entry would mean an operator who wrote the
 * narrower form silently got the wider one.
 */
export function matchesAllowlist(host: string, port: number, rules: readonly HostRule[]): boolean {
  let candidate = host.trim().toLowerCase();
  if (candidate.endsWith('.')) candidate = candidate.slice(0, -1);
  if (candidate === '') return false;

  for (const rule of rules) {
    if (!rule.ports.includes(port)) continue;
    if (rule.wildcard) {
      if (candidate.endsWith(`.${rule.host}`)) return true;
    } else if (candidate === rule.host) {
      return true;
    }
  }
  return false;
}

/**
 * Addresses a sandbox may never be proxied to — INVARIANT 3'S ENFORCEMENT POINT.
 *
 * Applied to the RESOLVED address, not to the requested name, so a DNS record pointing a
 * public-looking name at 172.x — deliberately or by rebinding — is refused too.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true; // Unparseable is not proxied.

  if (version === 4) return isBlockedV4(address);

  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:10.0.0.1) is an IPv4 destination wearing a v6 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  const compact = lower.replace(/^\[|\]$/g, '');
  if (compact === '::1' || compact === '::') return true;
  const head = compact.split(':')[0] ?? '';
  if (head === '') return true; // ::something — unspecified prefix.
  const first = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8  multicast
  return false;
}

function isBlockedV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8   this network
  if (a === 10) return true; // 10.0.0.0/8  private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private (Docker's own)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

// ── Per-Run resource names and docker argument lists ─────────────────────────

/** Shared by the name builder and the orphan sweep, which recovers the run id from it. */
export const EGRESS_NETWORK_PREFIX = 'armada-egress-';

export function egressNetworkName(runId: string): string {
  return `${EGRESS_NETWORK_PREFIX}${runId}`;
}

export function proxyContainerName(runId: string): string {
  return `armada-egress-proxy-${runId}`;
}

/**
 * `--internal` is the whole mechanism: no masquerade, no forward rule, no route off the
 * host for anything attached. Everything else here is bookkeeping.
 */
export function buildNetworkCreateArgs(runId: string, runIdLabel: string): string[] {
  return [
    'network', 'create',
    '--internal',
    '--driver', 'bridge',
    '--label', `${runIdLabel}=${runId}`,
    egressNetworkName(runId),
  ];
}

/**
 * The proxy sidecar. Created on the DEFAULT bridge — which has egress and working DNS —
 * and joined to the internal network afterwards, so it is the only container with a foot
 * on both sides.
 *
 * It is hardened like a sandbox and for the same reason: it is reachable from one. Note
 * what it does NOT receive — the Docker socket, DATABASE_URL, or any credential. Exactly
 * two environment variables are passed, and a test asserts that count.
 */
export function buildProxyCreateArgs(
  runId: string,
  egress: ResolvedEgress,
  runIdLabel: string,
): string[] {
  return [
    'run',
    '--detach',
    '--name', proxyContainerName(runId),
    '--label', `${runIdLabel}=${runId}`,
    '--label', `${ROLE_LABEL}=${PROXY_ROLE}`,
    '--network', 'bridge',
    '--user', '10001:10001',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=8m',
    '--memory', '128m',
    '--env', `${ALLOWED_HOSTS_ENV}=${JSON.stringify(egress.allowedHosts)}`,
    '--env', `${PROXY_PORT_ENV}=${egress.proxyPort}`,
    egress.proxyImage,
    ...EGRESS_PROXY_COMMAND,
  ];
}

/** The second foot. The alias is how the sandbox names the proxy without knowing its IP. */
export function buildNetworkConnectArgs(runId: string, proxyContainerId: string): string[] {
  return [
    'network', 'connect',
    '--alias', PROXY_ALIAS,
    egressNetworkName(runId),
    proxyContainerId,
  ];
}
