/**
 * config/mcp-servers.yaml — Agent Runtime R50, R52; edge 18.
 *
 * ── VALIDATED AT STARTUP, NEVER AT FIRST USE ─────────────────────────────────
 * The repo convention (CLAUDE.md): a misconfiguration must surface when the daemon boots,
 * not when a Run first reaches for a server. Every fault is collected and reported at once
 * so an operator with three bad entries fixes three in one restart rather than one per
 * restart. Edge 18 — two servers sharing a `name` — is a STARTUP FAILURE naming the
 * collision, because namespacing (R51) cannot disambiguate two servers that answer to the
 * same prefix and a Run would silently reach whichever won the map.
 *
 * ── SHIPPED EMPTY ─────────────────────────────────────────────────────────────
 * `servers: []` is the default and it is not an error. The MVP costs nothing to run: a
 * default installation needs no credential and makes no egress, and adding a server is a
 * deliberate operator act. `loadMcpServers({})` is therefore valid and yields no servers.
 *
 * ── CREDENTIALS ARE ENVIRONMENT VARIABLE NAMES ────────────────────────────────
 * `env_keys` holds NAMES. Nothing in this file reads a value; the values are read from the
 * daemon's own environment at connect time and are the input to the event sink's redaction
 * (R59, event-log.ts `collectCredentialEnvNames`). A value in this file would be a secret
 * committed to a repository, which is why the shape rejects anything but a name.
 */

export class McpConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'McpConfigError';
  }
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio only. argv, already split — never a shell string (nothing here spawns a shell). */
  command?: string[];
  /** http only. */
  url?: string;
  /** Environment variable NAMES. Never values. */
  envKeys: string[];
}

export interface McpConfig {
  servers: McpServerConfig[];
  /**
   * Bound on a single JSON-RPC request to a server.
   *
   * Not a retry and not a delay: it is the ceiling that stops an unresponsive server from
   * holding a Step open forever. A Run's four budgets are checked between Steps (R34) and
   * cannot end a Step that never returns, which is the same reason the model call is
   * bounded by an AbortSignal rather than by `max_wall_clock_seconds`.
   */
  requestTimeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const TRANSPORTS = ['stdio', 'http'] as const;
const ENTRY_KEYS = ['name', 'transport', 'command', 'url', 'env_keys'];
const TOP_LEVEL_KEYS = ['servers', 'request_timeout_seconds'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse and validate the whole file.
 *
 * Throws `McpConfigError` carrying EVERY problem. index.ts turns that into a non-zero exit
 * naming each one, exactly as a bad plugins.yaml does (R14).
 */
export function loadMcpServers(raw: unknown): McpConfig {
  const problems: string[] = [];

  if (raw !== null && raw !== undefined && !isRecord(raw)) {
    throw new McpConfigError(['config/mcp-servers.yaml: the file must be a mapping']);
  }

  const top = isRecord(raw) ? raw : {};

  for (const key of Object.keys(top)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      problems.push(
        `config/mcp-servers.yaml: unknown key \`${key}\`; expected one of ${TOP_LEVEL_KEYS.join(', ')}`,
      );
    }
  }

  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_SECONDS * 1000;
  const timeout = top['request_timeout_seconds'];
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      problems.push('config/mcp-servers.yaml: `request_timeout_seconds` must be a positive number');
    } else {
      requestTimeoutMs = Math.round(timeout * 1000);
    }
  }

  const rawServers = top['servers'];
  const servers: McpServerConfig[] = [];

  if (rawServers !== undefined && rawServers !== null) {
    if (!Array.isArray(rawServers)) {
      // A mapping here is the mistake that made `Object.keys(config.servers)` in index.ts
      // produce array INDICES as server names. Reject the shape rather than coping with it.
      problems.push('config/mcp-servers.yaml: `servers` must be a list of entries');
    } else {
      const seen = new Set<string>();
      for (const [index, entry] of rawServers.entries()) {
        const parsed = parseEntry(entry, index, seen, problems);
        if (parsed) servers.push(parsed);
      }
    }
  }

  if (problems.length > 0) throw new McpConfigError(problems);
  return { servers, requestTimeoutMs };
}

function parseEntry(
  entry: unknown,
  index: number,
  seen: Set<string>,
  problems: string[],
): McpServerConfig | null {
  const at = `config/mcp-servers.yaml: servers[${index}]`;

  if (!isRecord(entry)) {
    problems.push(`${at} must be a mapping with \`name\` and \`transport\``);
    return null;
  }

  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) {
      problems.push(`${at}: unknown key \`${key}\`; expected one of ${ENTRY_KEYS.join(', ')}`);
    }
  }

  const name = entry['name'];
  let validName: string | null = null;
  if (typeof name !== 'string' || name.length === 0) {
    problems.push(`${at}: \`name\` must be a non-empty string`);
  } else if (name.includes('__')) {
    // R51 — the separator. A server called `a__b` would make `a__b__run` split as server
    // `a`, tool `b__run`, so the namespace would address a server that does not exist.
    problems.push(`${at}: \`name\` may not contain \`__\`, which namespaces MCP tools (R51)`);
  } else if (seen.has(name)) {
    // EDGE 18. Startup fails NAMING the collision.
    problems.push(
      `${at}: two MCP servers are configured with the name \`${name}\`; ` +
        'names must be unique because tools are namespaced by them (R51)',
    );
  } else {
    seen.add(name);
    validName = name;
  }

  const transport = entry['transport'];
  if (transport !== 'stdio' && transport !== 'http') {
    problems.push(`${at}: \`transport\` must be one of ${TRANSPORTS.join(', ')}`);
    return null;
  }

  const envKeys: string[] = [];
  const rawEnvKeys = entry['env_keys'];
  if (rawEnvKeys !== undefined && rawEnvKeys !== null) {
    if (!Array.isArray(rawEnvKeys)) {
      problems.push(`${at}: \`env_keys\` must be a list of environment variable NAMES`);
    } else {
      for (const key of rawEnvKeys) {
        if (typeof key !== 'string' || key.length === 0) {
          problems.push(`${at}: every \`env_keys\` entry must be a non-empty variable name`);
        } else {
          envKeys.push(key);
        }
      }
    }
  }

  if (transport === 'stdio') {
    if (entry['url'] !== undefined) {
      problems.push(`${at}: \`url\` belongs to an http server; a stdio server takes \`command\``);
    }
    const command = entry['command'];
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== 'string' || part.length === 0)
    ) {
      problems.push(`${at}: a stdio server requires \`command\` as a non-empty list of strings`);
      return null;
    }
    return validName === null
      ? null
      : { name: validName, transport, command: command as string[], envKeys };
  }

  if (entry['command'] !== undefined) {
    problems.push(`${at}: \`command\` belongs to a stdio server; an http server takes \`url\``);
  }
  const url = entry['url'];
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    problems.push(`${at}: an http server requires \`url\` as an http:// or https:// string`);
    return null;
  }
  // R52 says credentials are READ from the named variables; it does not say how an http
  // transport presents them, and the MCP authorization spec uses exactly one mechanism —
  // `Authorization: Bearer`. Rather than silently ignoring extra keys, or inventing a
  // header-mapping field the spec does not have, more than one is refused at startup where
  // the operator can see it. See http-transport.ts.
  if (envKeys.length > 1) {
    problems.push(
      `${at}: an http server takes at most one \`env_keys\` entry — its value is sent as ` +
        `\`Authorization: Bearer\`; got ${envKeys.length} (${envKeys.join(', ')})`,
    );
  }

  return validName === null ? null : { name: validName, transport, url, envKeys };
}
