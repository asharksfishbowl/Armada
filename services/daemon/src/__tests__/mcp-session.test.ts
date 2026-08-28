/**
 * P12 — per-Run MCP sessions. Agent Runtime R51, R52, R53; edges 17 and 18.
 *
 * THE PHASE EXIT CRITERION LIVES IN THE SECOND DESCRIBE: "a failing MCP server at Run start
 * appends `mcp_unavailable` and the Run continues without that server's tools."
 *
 * Everything is driven through `McpSessionManager` with a scripted client, so no test needs
 * Docker, a network, or an installed MCP server — but the client and the namespacing under
 * it are the real ones.
 *
 * The last describe is the WIRING. This repo has shipped seven components that were
 * written, unit tested, and called by nothing; a passing suite proves nothing about
 * reachability, so reachability is asserted separately, twice: through the composite
 * provider a Run actually holds, and against the source of index.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { McpSessionManager, closeMcpSessionsOnRunEnd } from '../mcp/sessions.js';
import { McpClient } from '../mcp/client.js';
import { CompositeToolProvider } from '../tools/composite-provider.js';
import type { McpServerConfig } from '../mcp/config.js';
import type { McpTransport, McpTransportHandlers } from '../mcp/transport.js';
import type {
  Chunk,
  Event,
  EventInput,
  EventSink,
  RetrievalProvider,
  RunContext,
} from '../kernel/types.js';

const DAEMON_SRC = new URL('../../src/', import.meta.url).pathname;

// ── A sink that records, and can be made to fail ─────────────────────────────
function recordingSink(options: { failing?: boolean } = {}): EventSink & { events: EventInput[] } {
  const events: EventInput[] = [];
  let seq = 0;
  return {
    events,
    name: 'RecordingSink',
    async append(event: EventInput): Promise<Event> {
      if (options.failing) throw new Error('the database is unreachable');
      events.push(event);
      seq += 1;
      return {
        eventId: `e${seq}`,
        runId: event.runId,
        seq,
        type: event.type,
        payload: event.payload ?? {},
        createdAt: new Date().toISOString(),
      };
    },
    async read() {
      return [];
    },
  };
}

// ── A server, scripted, behind the REAL McpClient ────────────────────────────
interface ServerScript {
  tools?: { name: string; description?: string }[];
  /** Rejects the handshake, i.e. the server is down at Run start. */
  refuseConnection?: string;
  /** Rejects `tools/list` after a successful handshake. */
  refuseListing?: string;
  /** Rejects `tools/call`, i.e. the server went away mid-Run (edge 17). */
  failCalls?: string;
  /** The server answers, but reports the TOOL failed. */
  toolReportsError?: boolean;
}

function scriptedClient(name: string, script: ServerScript): McpClient {
  let handlers: McpTransportHandlers | null = null;
  let closed = 0;

  const transport: McpTransport = {
    description: `scripted ${name}`,
    async start(h) {
      handlers = h;
    },
    async send(message) {
      if (!('id' in message)) return;
      const id = message.id;
      const fail = (reason: string): void => {
        queueMicrotask(() =>
          handlers?.message({ jsonrpc: '2.0', id, error: { code: -32000, message: reason } }),
        );
      };
      const ok = (result: unknown): void => {
        queueMicrotask(() => handlers?.message({ jsonrpc: '2.0', id, result }));
      };

      if (message.method === 'initialize') {
        if (script.refuseConnection) return fail(script.refuseConnection);
        return ok({ protocolVersion: '2025-06-18', capabilities: {} });
      }
      if (message.method === 'tools/list') {
        if (script.refuseListing) return fail(script.refuseListing);
        return ok({ tools: script.tools ?? [] });
      }
      if (message.method === 'tools/call') {
        if (script.failCalls) return fail(script.failCalls);
        return ok({
          content: [{ type: 'text', text: `${name} answered` }],
          ...(script.toolReportsError ? { isError: true } : {}),
        });
      }
      return fail(`unexpected ${message.method}`);
    },
    async close() {
      closed += 1;
    },
  };

  const client = new McpClient({ server: name, transport, requestTimeoutMs: 5000 });
  // Exposed so a test can assert the transport was actually torn down.
  Object.defineProperty(client, 'closeCount', { get: () => closed });
  return client;
}

function stdioConfig(name: string, envKeys: string[] = []): McpServerConfig {
  return { name, transport: 'stdio', command: ['node', 'server.js'], envKeys };
}

function manager(
  scripts: Record<string, ServerScript>,
  sink: EventSink,
  servers?: McpServerConfig[],
): McpSessionManager {
  const connected: McpClient[] = [];
  const mgr = new McpSessionManager({
    servers: servers ?? Object.keys(scripts).map((name) => stdioConfig(name)),
    requestTimeoutMs: 5000,
    events: () => sink,
    connect: async (server) => {
      const client = scriptedClient(server.name, scripts[server.name] ?? {});
      await client.connect();
      connected.push(client);
      return client;
    },
  });
  Object.defineProperty(mgr, 'connectedClients', { get: () => connected });
  return mgr;
}

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'run-1',
  agentVersionId: 'v1',
  mode: 'standard',
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R51 — the granted servers\' tools, namespaced', () => {
  test('each server\'s tools arrive as `{server}__{tool}`', async () => {
    const sink = recordingSink();
    const mcp = manager(
      { github: { tools: [{ name: 'create_issue' }] }, docs: { tools: [{ name: 'search' }] } },
      sink,
    );

    const specs = await mcp.list(ctx(), ['github', 'docs']);
    assert.deepEqual(specs.map((s) => s.name), ['github__create_issue', 'docs__search']);
    assert.deepEqual(sink.events, [], 'a healthy connection appends nothing');
  });

  test('EDGE 18 — two servers exposing the SAME tool name stay distinct', async () => {
    const mcp = manager(
      { github: { tools: [{ name: 'search' }] }, docs: { tools: [{ name: 'search' }] } },
      recordingSink(),
    );

    const specs = await mcp.list(ctx(), ['github', 'docs']);
    assert.deepEqual(specs.map((s) => s.name), ['github__search', 'docs__search']);

    // And each dispatches to its OWN server, which is the point of the namespace.
    assert.match((await mcp.invoke(ctx(), 'github__search', {}, ['github', 'docs'])).content, /github answered/);
    assert.match((await mcp.invoke(ctx(), 'docs__search', {}, ['github', 'docs'])).content, /docs answered/);
  });

  test('the tool list is stable in GRANTED order, not in the order servers answered', async () => {
    // Invariant 5 makes the event stream the observability surface AND the trajectory
    // training data. Two orderings of the same Run is what that forbids, and `tools:` on
    // the model_request Event records this list.
    const mcp = manager(
      { slow: { tools: [{ name: 'a' }] }, fast: { tools: [{ name: 'b' }] } },
      recordingSink(),
    );
    assert.deepEqual(
      (await mcp.list(ctx({ runId: 'r-a' }), ['slow', 'fast'])).map((s) => s.name),
      ['slow__a', 'fast__b'],
    );
    assert.deepEqual(
      (await mcp.list(ctx({ runId: 'r-b' }), ['fast', 'slow'])).map((s) => s.name),
      ['fast__b', 'slow__a'],
    );
  });

  test('servers connect ONCE per Run, however many Steps list tools', async () => {
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, recordingSink());
    await Promise.all([
      mcp.list(ctx(), ['github']),
      mcp.list(ctx(), ['github']),
      mcp.list(ctx(), ['github']),
    ]);
    // Memoised as a PROMISE, so two Steps racing a still-connecting server cannot both
    // decide to connect.
    assert.equal((mcp as unknown as { connectedClients: McpClient[] }).connectedClients.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R53 — THE PHASE EXIT CRITERION: a failing server degrades, never terminates', () => {
  test('a server that will not connect appends `mcp_unavailable` and the Run continues', async () => {
    const sink = recordingSink();
    const mcp = manager(
      { github: { refuseConnection: 'connection refused' }, docs: { tools: [{ name: 'search' }] } },
      sink,
    );

    // 1. The Run continues WITHOUT that server's tools — and keeps the healthy one's.
    const specs = await mcp.list(ctx(), ['github', 'docs']);
    assert.deepEqual(specs.map((s) => s.name), ['docs__search']);

    // 2. Exactly one Event, naming the server.
    assert.equal(sink.events.length, 1);
    const event = sink.events[0]!;
    assert.equal(event.type, 'mcp_unavailable');
    assert.equal(event.runId, 'run-1');
    assert.equal(event.payload?.['server'], 'github');
    assert.equal(event.payload?.['degraded'], true);
    assert.match(String(event.payload?.['error']), /connection refused/);
  });

  test('and calling the dead server\'s tool is an is_error RESULT, not a throw', async () => {
    const mcp = manager({ github: { refuseConnection: 'connection refused' } }, recordingSink());
    const result = await mcp.invoke(ctx(), 'github__create_issue', {}, ['github']);
    assert.equal(result.isError, true);
    assert.match(result.content, /`github` MCP server is unavailable/);
  });

  test('ONE Event per server per Run, not one per Step', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { refuseConnection: 'down' } }, sink);
    await mcp.list(ctx(), ['github']);
    await mcp.list(ctx(), ['github']);
    await mcp.list(ctx(), ['github']);
    // A Run that logged its degradation 40 times would drown the stream P10 renders.
    assert.equal(sink.events.length, 1);
  });

  test('a server that connects but cannot list its tools is unavailable too', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { refuseListing: 'internal error' } }, sink);
    assert.deepEqual(await mcp.list(ctx(), ['github']), []);
    assert.match(String(sink.events[0]?.payload?.['error']), /internal error/);
  });

  test('INVARIANT 2 — a pinned server that config no longer has is unavailable, not fatal', async () => {
    const sink = recordingSink();
    // The grant is pinned on the Agent version; the SERVER was removed from config since.
    const mcp = manager({ docs: { tools: [{ name: 'search' }] } }, sink, [stdioConfig('docs')]);

    const specs = await mcp.list(ctx(), ['github', 'docs']);
    assert.deepEqual(specs.map((s) => s.name), ['docs__search']);
    assert.equal(sink.events[0]?.payload?.['server'], 'github');
    assert.match(String(sink.events[0]?.payload?.['error']), /no such server in config/);
  });

  test('R52 — an unset declared variable names the VARIABLE and never a value', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, sink, [
      stdioConfig('github', ['ARMADA_DEFINITELY_UNSET_TOKEN']),
    ]);

    assert.deepEqual(await mcp.list(ctx(), ['github']), []);
    const error = String(sink.events[0]?.payload?.['error']);
    // Connecting anyway would fail later inside the server as an opaque auth error and the
    // operator would never learn which variable the daemon was missing.
    assert.match(error, /unset environment variable: ARMADA_DEFINITELY_UNSET_TOKEN/);
  });

  test('a sink that cannot record the degradation still does not fail the Run', async () => {
    // The tools are gone either way. The Event is the RECORD of that, not the cause.
    const mcp = manager({ github: { refuseConnection: 'down' } }, recordingSink({ failing: true }));
    assert.deepEqual(await mcp.list(ctx(), ['github']), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('edge 17 / R29 — dispatch failures are results, never terminations', () => {
  test('a server that disconnects MID-RUN returns is_error naming it', async () => {
    const mcp = manager({ github: { tools: [{ name: 'create_issue' }], failCalls: 'EPIPE' } }, recordingSink());
    const result = await mcp.invoke(ctx(), 'github__create_issue', {}, ['github']);
    assert.equal(result.isError, true);
    assert.match(result.content, /`github` MCP server failed to answer `create_issue`/);
    assert.match(result.content, /EPIPE/);
  });

  test('a tool the server does not offer names the ones it does (R29)', async () => {
    const mcp = manager({ github: { tools: [{ name: 'create_issue' }] } }, recordingSink());
    const result = await mcp.invoke(ctx(), 'github__delete_repo', {}, ['github']);
    assert.equal(result.isError, true);
    assert.match(result.content, /offers: create_issue/);
  });

  test('an UNGRANTED server is an unknown tool, however real the server is', async () => {
    // An Agent that was not granted `github` does not get it because the model asked
    // nicely — the same rule the built-in registry applies.
    const mcp = manager({ github: { tools: [{ name: 'x' }] }, docs: {} }, recordingSink());
    const result = await mcp.invoke(ctx(), 'github__x', {}, ['docs']);
    assert.equal(result.isError, true);
    assert.match(result.content, /not granted the `github` MCP server/);
  });

  test('a tool that reports its own failure passes that through as is_error', async () => {
    const mcp = manager({ github: { tools: [{ name: 'x' }], toolReportsError: true } }, recordingSink());
    const result = await mcp.invoke(ctx(), 'github__x', {}, ['github']);
    assert.equal(result.isError, true);
  });

  test('a malformed namespaced name is an error result, not a crash', async () => {
    const mcp = manager({ github: {} }, recordingSink());
    assert.equal((await mcp.invoke(ctx(), 'github__', {}, ['github'])).isError, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT 3 — a Code-mode Run never reaches an MCP server', () => {
  test('it is offered no MCP tool (R27a)', async () => {
    const mcp = manager({ github: { tools: [{ name: 'create_issue' }] } }, recordingSink());
    assert.deepEqual(await mcp.list(ctx({ mode: 'code' }), ['github']), []);
  });

  test('and it OPENS NO SESSION — nothing is spawned, nothing is dialled', async () => {
    // The refusal happens before a transport is constructed. A Code-mode Run that
    // connected and then withheld the tools would still have opened a channel out of a
    // process whose whole job is to have none.
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, recordingSink());
    await mcp.list(ctx({ mode: 'code' }), ['github']);
    assert.equal((mcp as unknown as { connectedClients: McpClient[] }).connectedClients.length, 0);
    assert.equal(mcp.openSessionCount, 0);
  });

  test('and an MCP call from one is refused naming the reason', async () => {
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, recordingSink());
    const result = await mcp.invoke(ctx({ mode: 'code' }), 'github__x', {}, ['github']);
    assert.equal(result.isError, true);
    assert.match(result.content, /Code mode/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lifecycle — a session cannot outlive its Run', () => {
  test('`run_end` closes the Run\'s servers (data-flow step 14)', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, sink);
    const wrapped = closeMcpSessionsOnRunEnd(sink, mcp);

    await mcp.list(ctx(), ['github']);
    assert.equal(mcp.openSessionCount, 1);

    await wrapped.append({ runId: 'run-1', type: 'run_end', payload: { outcome: 'success' } });
    // The close is fired without being awaited so a slow SIGTERM cannot delay run_end.
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    assert.equal(mcp.openSessionCount, 0);

    const client = (mcp as unknown as { connectedClients: McpClient[] }).connectedClients[0]!;
    assert.equal((client as unknown as { closeCount: number }).closeCount, 1, 'the transport was torn down');
  });

  test('only THAT Run\'s session — a concurrent Run keeps its servers', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, sink);
    const wrapped = closeMcpSessionsOnRunEnd(sink, mcp);

    await mcp.list(ctx({ runId: 'run-1' }), ['github']);
    await mcp.list(ctx({ runId: 'run-2' }), ['github']);
    await wrapped.append({ runId: 'run-1', type: 'run_end' });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    assert.equal(mcp.openSessionCount, 1);
  });

  test('every other Event type leaves the session alone', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, sink);
    const wrapped = closeMcpSessionsOnRunEnd(sink, mcp);

    await mcp.list(ctx(), ['github']);
    for (const type of ['tool_call', 'tool_result', 'model_response', 'error'] as const) {
      await wrapped.append({ runId: 'run-1', type });
    }
    assert.equal(mcp.openSessionCount, 1);
  });

  test('the wrapper appends FIRST, delegates `read`, and keeps the plugin\'s name', async () => {
    // GET /api/health reports the implementation config/plugins.yaml selected; a wrapper
    // that renamed it would make the health strip lie about what is registered.
    const sink = recordingSink();
    const wrapped = closeMcpSessionsOnRunEnd(sink, manager({}, sink));
    assert.equal(wrapped.name, 'RecordingSink');
    const event = await wrapped.append({ runId: 'run-1', type: 'run_start' });
    assert.equal(event.seq, 1);
    assert.deepEqual(sink.events.map((e) => e.type), ['run_start']);
    assert.deepEqual(await wrapped.read('run-1'), []);
  });

  test('closeAll disconnects everything — SIGTERM must leave no child process', async () => {
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'x' }] } }, sink);
    await mcp.list(ctx({ runId: 'run-1' }), ['github']);
    await mcp.list(ctx({ runId: 'run-2' }), ['github']);

    await mcp.closeAll();
    assert.equal(mcp.openSessionCount, 0);
    for (const client of (mcp as unknown as { connectedClients: McpClient[] }).connectedClients) {
      assert.equal((client as unknown as { closeCount: number }).closeCount, 1);
    }
  });

  test('closing a Run that never opened a session is a no-op', async () => {
    const mcp = manager({}, recordingSink());
    await mcp.close('never-ran');
    assert.equal(mcp.openSessionCount, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('THE WIRING — the subsystem is reachable, not merely written', () => {
  const retrieval: RetrievalProvider = {
    name: 'stub',
    async query(): Promise<Chunk[]> {
      return [];
    },
  };

  test('a pinned `{server}__*` grant produces tools through the provider a Run holds', async () => {
    // The seam. `resolveTools` writes `github__*` into the snapshot; nothing before P12
    // expanded it, so the whole subsystem could pass its own tests and still be dead.
    const sink = recordingSink();
    const mcp = manager({ github: { tools: [{ name: 'create_issue' }] } }, sink);
    const provider = new CompositeToolProvider({
      grantsFor: async () => ['finish', 'github__*'],
      retrieval: () => retrieval,
      searchOptions: { searchMaxK: 10, defaultK: 4 },
      mcp,
    });

    assert.deepEqual(
      (await provider.list(ctx())).map((s) => s.name),
      ['finish', 'github__create_issue'],
    );
    assert.match(
      (await provider.invoke('github__create_issue', { title: 'x' }, ctx())).content,
      /github answered/,
    );
  });

  test('index.ts constructs the manager and hands it to BOTH plugins that need it', async () => {
    /**
     * Reads the SOURCE of index.ts. Importing it is not an option — it opens a database
     * pool, asserts the Docker socket is mounted, and calls process.exit on any fault. It
     * is a coarse test, and it is the one that would have caught all seven of this repo's
     * unwired components.
     */
    const source = readFileSync(`${DAEMON_SRC}index.ts`, 'utf8');

    assert.ok(source.includes('loadMcpServers('), 'the config must be validated at startup');
    assert.ok(source.includes('new McpSessionManager('), 'a session manager must be constructed');
    // Without this, every `{server}__*` grant expands to nothing and MCP is unreachable.
    assert.ok(source.includes('mcp: mcpSessions'), 'handed to the CompositeToolProvider');
    // Without this, a session is opened per Run and never closed.
    assert.ok(
      source.includes('closeMcpSessionsOnRunEnd('),
      'the EventSink must close sessions on run_end',
    );
    assert.ok(source.includes('mcpSessions.closeAll()'), 'and SIGTERM must close the rest');
  });

  test('index.ts validates Agent grants against the real server NAMES', async () => {
    const source = readFileSync(`${DAEMON_SRC}index.ts`, 'utf8');
    // `Object.keys` over the `servers:` LIST yielded array indices, so Agent Definition
    // R18 rejected every correctly-named grant and accepted one called "0".
    assert.ok(
      source.includes('mcpServers: mcp.servers.map((server) => server.name)'),
      'the validation context must get names from the validated config',
    );
    assert.ok(
      !/mcpServers:\s*Object\.keys/.test(source),
      'the array-index bug must not come back',
    );
  });
});
