/**
 * McpSessionManager — per-Run MCP server lifecycle. Agent Runtime R51, R52, R53; edge 17.
 *
 * One session per Run, holding one connected client per granted server. This is the only
 * file that knows a Run exists, and it is the only file that decides what a failing server
 * costs.
 *
 * ── AN UNAVAILABLE SERVER DEGRADES A RUN, IT NEVER ENDS ONE (R53) ────────────
 * A server that will not connect produces one `mcp_unavailable` Event naming it and the
 * Run continues WITHOUT that server's tools. This is the same shape as a retrieval fault
 * (R43): the agent loses a capability, which is worse than having it and far better than a
 * dead trajectory. Nothing in this file throws into the agent loop — `list` returns fewer
 * tools, `invoke` returns an `is_error` result.
 *
 * ── INVARIANT 3, ENFORCED HERE AND ONCE ──────────────────────────────────────
 * A CODE-MODE RUN GETS NO MCP TOOLS AND OPENS NO SESSION. A Code-mode program executes
 * inside the sandbox and there is no callback channel out (R27a), so an MCP tool it could
 * name could never be dispatched. The refusal sits at the top of `list` and `invoke` rather
 * than in the composite provider, so no second caller can route around it, and it happens
 * BEFORE a transport is constructed — a Code-mode Run never so much as spawns a child
 * process or opens a socket for MCP. The `mode_downgraded` Event that reports the exclusion
 * to an operator (R28a) belongs to P13, which is where Code mode itself lands.
 *
 * ── WHEN A SESSION OPENS AND WHEN IT CLOSES ──────────────────────────────────
 * It opens on the first tool-list of the Run — the first thing the agent loop does inside
 * Step 1, before the first `model_request` — so R51's "at Run start" holds and an
 * `mcp_unavailable` Event lands between `user_message` and the first `model_request`.
 *
 * It closes when the Run's `run_end` Event is appended, which is what
 * `closeMcpSessionsOnRunEnd` below observes. Data-flow step 14 puts disconnecting MCP
 * servers in exactly that moment, alongside destroying the sandbox, and invariant 6
 * guarantees every Run reaches it — so no session can outlive its Run. A Run that fails
 * before its first Step never opened one.
 *
 * ── CONNECTING IS NOT RE-DERIVING THE GRANT (INVARIANT 2) ────────────────────
 * The SERVERS come from the Run's pinned snapshot and are never read from config. Config
 * is consulted only for how to reach a server that was already granted. A pinned server
 * that has since been deleted from config/mcp-servers.yaml is therefore `mcp_unavailable`,
 * not a silent substitution and not a Run failure — a liveness check on a pinned reference,
 * which is precisely what invariant 2 permits.
 */

import type { Event, EventSink, RunContext, ToolResult, ToolSpec } from '../kernel/types.js';
import type { McpServerConfig } from './config.js';
import { McpClient } from './client.js';
import { HttpTransport } from './http-transport.js';
import { StdioTransport } from './stdio-transport.js';
import { toToolSpec } from './protocol.js';
import type { McpTransport } from './transport.js';
import { serverOfToolName, toolOfToolName } from './naming.js';

/**
 * Variables a stdio MCP server gets regardless of `env_keys`.
 *
 * Deliberately tiny. `process.env` is NOT inherited — see stdio-transport.ts. A server
 * needs PATH to find its own interpreter and HOME for the caches npm and uv keep; anything
 * beyond that is the operator's to declare.
 */
const ENV_PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'TMPDIR'];

export interface McpSessionManagerOptions {
  /** Validated at startup by `loadMcpServers`. */
  servers: McpServerConfig[];
  requestTimeoutMs: number;
  /**
   * A GETTER, not the sink.
   *
   * This manager is constructed before `Kernel.register` runs, because the ToolProvider
   * factory needs it. Resolving the EventSink eagerly is the exact mistake that killed
   * every boot in P7 when CompositeToolProvider resolved the RetrievalProvider in its
   * factory body — the Kernel does not exist yet while a factory is running.
   */
  events: () => EventSink;
  /**
   * Injectable so unit tests need no child process, no socket, and no live server.
   *
   * Defaults to the real transports.
   */
  connect?: (server: McpServerConfig, requestTimeoutMs: number) => Promise<McpClient>;
}

interface McpSession {
  /** Servers that connected. Absent from this map means unavailable for the whole Run. */
  clients: Map<string, McpClient>;
  /** Namespaced (R51), in granted order, ready to hand to the model. */
  specs: ToolSpec[];
  /** server -> why it is not in `clients`. Quoted back on an invoke (edge 17). */
  unavailable: Map<string, string>;
  /** server -> the tool names it actually offers, for an R29 message that helps. */
  toolNames: Map<string, string[]>;
}

export class McpSessionManager {
  /**
   * runId -> session, memoised as a PROMISE.
   *
   * The promise, not the resolved session: `list` is called on every Step and the first two
   * Steps of a Run can overlap with a still-connecting server. Storing the promise makes
   * "connect once per Run" true by construction rather than by a flag that two callers can
   * both read as false.
   */
  private readonly sessions = new Map<string, Promise<McpSession>>();

  constructor(private readonly options: McpSessionManagerOptions) {}

  /** How many Runs currently hold a session. The teardown test asserts this returns to 0. */
  get openSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * R51 — the granted servers' tools, namespaced.
   *
   * Never throws. A fault while opening the session yields fewer tools, never a failed
   * Step: the agent loop calls this before every model request and an exception here would
   * end the Run (`fault` -> `failed`), which is exactly what R53 forbids.
   */
  async list(ctx: RunContext, grantedServers: string[]): Promise<ToolSpec[]> {
    if (ctx.mode === 'code') return [];
    if (grantedServers.length === 0) return [];

    try {
      return (await this.sessionFor(ctx, grantedServers)).specs;
    } catch {
      return [];
    }
  }

  /**
   * Dispatch one `{server}__{tool}` call.
   *
   * Every failure path is an `is_error` RESULT (R29, R30, edge 17). The model sees what
   * went wrong and gets another Step.
   */
  async invoke(
    ctx: RunContext,
    name: string,
    args: unknown,
    grantedServers: string[],
  ): Promise<ToolResult> {
    if (ctx.mode === 'code') {
      return {
        content:
          `\`${name}\` is an MCP tool and this Run is in Code mode, which has no callback ` +
          'channel out of the sandbox (R27a).',
        isError: true,
      };
    }

    const server = serverOfToolName(name);
    const tool = toolOfToolName(name);
    if (!server || !tool) {
      return { content: `\`${name}\` is not a valid \`{server}__{tool}\` name`, isError: true };
    }
    if (!grantedServers.includes(server)) {
      // R29 — an Agent not granted a server does not get it because the model asked.
      return {
        content:
          `unknown tool \`${name}\`; this Agent was not granted the \`${server}\` MCP server` +
          (grantedServers.length > 0 ? `; granted: ${grantedServers.join(', ')}` : ''),
        isError: true,
      };
    }

    let session: McpSession;
    try {
      session = await this.sessionFor(ctx, grantedServers);
    } catch (err) {
      return {
        content: `the \`${server}\` MCP server is unavailable: ${messageOf(err)}`,
        isError: true,
      };
    }

    const client = session.clients.get(server);
    if (!client) {
      // R53 — the server failed at Run start. The Event already said so; this tells the
      // model, which is the only way it can stop calling a tool it can still see in a
      // history message.
      return {
        content:
          `the \`${server}\` MCP server is unavailable for this Run: ` +
          `${session.unavailable.get(server) ?? 'it did not connect'}`,
        isError: true,
      };
    }

    const known = session.toolNames.get(server) ?? [];
    if (!known.includes(tool)) {
      return {
        content:
          `unknown tool \`${name}\`; the \`${server}\` MCP server offers: ` +
          (known.length > 0 ? known.join(', ') : '(no tools)'),
        isError: true,
      };
    }

    try {
      return await client.callTool(tool, args);
    } catch (err) {
      // EDGE 17 — a server that disconnects MID-RUN. An error result naming the server, and
      // the Run is not terminated.
      return {
        content: `the \`${server}\` MCP server failed to answer \`${tool}\`: ${messageOf(err)}`,
        isError: true,
      };
    }
  }

  /** Disconnect every server this Run held. Idempotent. */
  async close(runId: string): Promise<void> {
    const pending = this.sessions.get(runId);
    if (!pending) return;
    this.sessions.delete(runId);

    // The session may still be CONNECTING. Awaiting it first is what stops a server that
    // finishes connecting after `run_end` from leaking a child process with no session left
    // to close it.
    const session = await pending.catch(() => null);
    if (!session) return;
    await Promise.all([...session.clients.values()].map((client) => client.close().catch(() => undefined)));
  }

  /** SIGTERM. Every session, so a shutdown leaves no orphaned child process behind. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((runId) => this.close(runId)));
  }

  private sessionFor(ctx: RunContext, grantedServers: string[]): Promise<McpSession> {
    const existing = this.sessions.get(ctx.runId);
    if (existing) return existing;

    const opening = this.open(ctx.runId, grantedServers);
    this.sessions.set(ctx.runId, opening);
    return opening;
  }

  /**
   * Connect every granted server once, at Run start.
   *
   * Concurrently, because a slow server should not delay the others' tools into the second
   * Step — but the RESULTS are folded in granted order, so the tool list and the
   * `mcp_unavailable` Events are identical on every Run regardless of which server answered
   * first. Invariant 5 makes the event stream the observability surface AND the trajectory
   * training data; two orderings of the same Run is what that forbids.
   */
  private async open(runId: string, grantedServers: string[]): Promise<McpSession> {
    const session: McpSession = {
      clients: new Map(),
      specs: [],
      unavailable: new Map(),
      toolNames: new Map(),
    };

    const outcomes = await Promise.all(
      grantedServers.map(async (name) => {
        const config = this.options.servers.find((entry) => entry.name === name);
        if (!config) {
          // Invariant 2 — the grant is pinned, so it stays granted; the SERVER is gone.
          return {
            name,
            error:
              'no such server in config/mcp-servers.yaml; ' +
              'this Agent version was pinned when it was configured',
            transport: null,
          } as const;
        }

        const missing = config.envKeys.filter((key) => !process.env[key]);
        if (missing.length > 0) {
          // NAMES, never values. Connecting anyway would fail later inside the server as an
          // opaque auth error, and the operator would have no way to see which variable the
          // daemon was actually missing.
          return {
            name,
            error: `unset environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
            transport: config.transport,
          } as const;
        }

        try {
          const connect = this.options.connect ?? defaultConnect;
          const client = await connect(config, this.options.requestTimeoutMs);
          try {
            const tools = await client.listTools();
            return { name, client, tools, transport: config.transport } as const;
          } catch (err) {
            // Connected but unusable. Close it rather than leaving a child process behind
            // for a server whose tools this Run will never see.
            await client.close().catch(() => undefined);
            throw err;
          }
        } catch (err) {
          return { name, error: messageOf(err), transport: config.transport } as const;
        }
      }),
    );

    const events = this.options.events();

    for (const outcome of outcomes) {
      if ('error' in outcome) {
        session.unavailable.set(outcome.name, outcome.error);
        // R53 — ONE Event, NAMING THE SERVER, and the Run continues. Appended here rather
        // than by the caller so no caller can forget it.
        await appendQuietly(events, {
          runId,
          type: 'mcp_unavailable',
          payload: {
            server: outcome.name,
            ...(outcome.transport ? { transport: outcome.transport } : {}),
            error: outcome.error,
            degraded: true,
          },
        });
        continue;
      }

      session.clients.set(outcome.name, outcome.client);
      session.toolNames.set(outcome.name, outcome.tools.map((tool) => tool.name));
      for (const tool of outcome.tools) session.specs.push(toToolSpec(outcome.name, tool));
    }

    return session;
  }
}

/**
 * The real transports. Separated from the manager so tests can substitute a client without
 * substituting the lifecycle logic that is actually under test.
 */
async function defaultConnect(
  server: McpServerConfig,
  requestTimeoutMs: number,
): Promise<McpClient> {
  let transport: McpTransport;

  if (server.transport === 'stdio') {
    transport = new StdioTransport({
      command: server.command ?? [],
      env: childEnv(server.envKeys),
    });
  } else {
    transport = new HttpTransport({
      url: server.url ?? '',
      headers: bearerHeaders(server.envKeys),
      timeoutMs: requestTimeoutMs,
    });
  }

  const client = new McpClient({ server: server.name, transport, requestTimeoutMs });
  try {
    await client.connect();
  } catch (err) {
    // A handshake that failed must not leave a spawned child or an http session behind.
    await client.close().catch(() => undefined);
    throw err;
  }
  return client;
}

/** R52 — the declared variables, plus the minimum a process needs to run at all. */
function childEnv(envKeys: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of envKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** R52 — config.ts guarantees an http server declares at most one variable. */
function bearerHeaders(envKeys: string[]): Record<string, string> {
  const key = envKeys[0];
  if (!key) return {};
  const value = process.env[key];
  return value ? { authorization: `Bearer ${value}` } : {};
}

/**
 * Append an Event without letting the append decide the Run's fate.
 *
 * A database hiccup while recording a degradation must not turn that degradation into a
 * terminated Run — the tools are already gone either way, and the Event is the record of
 * it, not the cause.
 */
async function appendQuietly(
  sink: EventSink,
  event: Parameters<EventSink['append']>[0],
): Promise<Event | null> {
  return sink.append(event).catch(() => null);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Close a Run's MCP sessions when its `run_end` Event is appended — data-flow step 14.
 *
 * ── WHY THE EVENT SINK AND NOT THE ORCHESTRATOR ──────────────────────────────
 * `RunOrchestrator.executeRun`'s `finally` releases the sandbox and would be the obvious
 * neighbour for this. It is not used because a Run's MCP session is bounded by the Run's
 * EVENT STREAM at both ends: it opens when the first tool list is built and closes when
 * `run_end` is written, and invariant 6 guarantees `run_end` is always written. That makes
 * the pairing gapless without a second component needing to remember it, and it holds
 * identically for a solo Run, a Team Run and every child Run — three call sites that would
 * otherwise each need the same line.
 *
 * The wrapper delegates `name` so `GET /api/health` still reports the implementation
 * selected in config/plugins.yaml, and it appends FIRST: teardown never delays or reorders
 * the Event that invariant 5 makes authoritative.
 */
export function closeMcpSessionsOnRunEnd(sink: EventSink, sessions: McpSessionManager): EventSink {
  return {
    name: sink.name,
    async append(event) {
      const appended = await sink.append(event);
      if (event.type === 'run_end') {
        // Not awaited: `run_end` is the last thing a Run does and a slow server's SIGTERM
        // must not hold it open. Failures are swallowed inside close().
        void sessions.close(event.runId);
      }
      return appended;
    },
    read: (runId, afterSeq) => sink.read(runId, afterSeq),
  };
}
