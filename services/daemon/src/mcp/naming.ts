/**
 * MCP tool namespacing — Agent Runtime R51, edge 18.
 *
 * `{server_name}__{tool_name}`. Two servers exposing `search` stay distinct because the
 * server name is part of the tool name the model sees, so there is never a moment where
 * the daemon has to guess which of two `search` tools was meant.
 *
 * ── WHY THE SPLIT IS ON THE FIRST SEPARATOR AND NOT THE LAST ─────────────────
 * A server name may not contain `__` (config.ts rejects one that does), and a tool name
 * may. `github__list__issues` is therefore unambiguously server `github`, tool
 * `list__issues`. Splitting on the last separator would silently address a different tool
 * on a server that uses double underscores in its own names, and the failure would look
 * like the server lying about its tool list.
 *
 * ── THE GRANT IS A SERVER, THE TOOL LIST IS DISCOVERED ───────────────────────
 * An Agent's pinned snapshot records `{server}__*` (resolver.ts), not concrete tool names:
 * the tools a server exposes are only knowable once it has been queried, and pinning names
 * that may not exist would make the snapshot a claim about someone else's software.
 * Invariant 2 still holds — the SET OF SERVERS is pinned and never re-derived from config,
 * and expanding a pinned grant into the tools that server actually offers today is the
 * same liveness check R51 already describes.
 */

export const MCP_NAMESPACE_SEPARATOR = '__';

/** What `resolveTools` writes into a pinned snapshot for a granted server. */
export const MCP_SERVER_GRANT_SUFFIX = '__*';

export function namespacedToolName(server: string, tool: string): string {
  return `${server}${MCP_NAMESPACE_SEPARATOR}${tool}`;
}

/**
 * True for a name that carries a namespace.
 *
 * No built-in is affected: `shell`, `finish`, `read_file`, `write_file`, `list_dir`,
 * `search_knowledge`, `delegate` and `list_workers` all use SINGLE underscores, so none of
 * them can be mistaken for an MCP call.
 */
export function isNamespacedToolName(name: string): boolean {
  return name.includes(MCP_NAMESPACE_SEPARATOR) && !name.startsWith(MCP_NAMESPACE_SEPARATOR);
}

/** The server half, or null when the name carries no namespace. */
export function serverOfToolName(name: string): string | null {
  const at = name.indexOf(MCP_NAMESPACE_SEPARATOR);
  if (at <= 0) return null;
  return name.slice(0, at);
}

/** The tool half, or null when the name carries no namespace or names no tool. */
export function toolOfToolName(name: string): string | null {
  const at = name.indexOf(MCP_NAMESPACE_SEPARATOR);
  if (at <= 0) return null;
  const tool = name.slice(at + MCP_NAMESPACE_SEPARATOR.length);
  return tool.length > 0 ? tool : null;
}

/**
 * The MCP servers a pinned grant list names, in the order they appear.
 *
 * Reads `{server}__*` entries and nothing else. A snapshot that somehow carried a concrete
 * `github__create_issue` grant does NOT open a session for `github` — the grant unit is the
 * server, and inferring one from a tool name would let a stale snapshot reach a server it
 * was never granted.
 */
export function grantedMcpServers(granted: readonly string[]): string[] {
  const servers: string[] = [];
  for (const name of granted) {
    if (!name.endsWith(MCP_SERVER_GRANT_SUFFIX)) continue;
    const server = name.slice(0, -MCP_SERVER_GRANT_SUFFIX.length);
    if (server.length > 0 && !servers.includes(server)) servers.push(server);
  }
  return servers;
}
