/**
 * P12 — the MCP client and its two transports. Agent Runtime R50, R51, R52.
 *
 * NO DOCKER, NO NETWORK, NO INSTALLED MCP SERVER. The stdio transport is exercised against
 * a real child process — `process.execPath -e`, the Node binary already running the tests —
 * so the spawn, the environment boundary and the newline framing are all genuinely under
 * test without anything external existing. The http transport is exercised against an
 * injected `fetch`.
 *
 * The property that matters most is the LAST describe: every way a server can fail
 * produces a rejection here, never a hang and never a throw that escapes into the agent
 * loop. `McpSessionManager` turns those rejections into `mcp_unavailable` (R53) and
 * `is_error` results (edge 17), and it can only do that if they arrive.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { McpClient } from '../mcp/client.js';
import { StdioTransport } from '../mcp/stdio-transport.js';
import { HttpTransport } from '../mcp/http-transport.js';
import { parseToolCall, parseToolsList, toToolSpec } from '../mcp/protocol.js';
import {
  grantedMcpServers,
  isNamespacedToolName,
  namespacedToolName,
  serverOfToolName,
  toolOfToolName,
} from '../mcp/naming.js';
import type { McpTransport, McpTransportHandlers } from '../mcp/transport.js';
import type { JsonRpcOutbound } from '../mcp/protocol.js';

// ─────────────────────────────────────────────────────────────────────────────
// A real MCP server, in one Node process. Answers the three methods this client
// speaks and nothing else. `FAKE_TOKEN` is echoed back so the environment boundary
// can be asserted from the outside.
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
function handle(message) {
  if (message.method === 'initialize') {
    process.stdout.write('a server that logs to stdout must not break the session\\n');
    reply(message.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: [
      { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ] });
  } else if (message.method === 'tools/call') {
    const seen = Object.keys(process.env).sort().join(',');
    reply(message.id, { content: [{ type: 'text', text:
      'text=' + String((message.params.arguments || {}).text) +
      ' token=' + String(process.env.FAKE_TOKEN) +
      ' env=' + seen }] });
  }
}
`;

/** A transport whose answers are decided by a table. No process, no socket. */
function scriptedTransport(script: {
  results?: Record<string, unknown>;
  errors?: Record<string, string>;
  dieOnStart?: string;
  silent?: boolean;
}): McpTransport & { sent: JsonRpcOutbound[] } {
  let handlers: McpTransportHandlers | null = null;
  const sent: JsonRpcOutbound[] = [];

  return {
    sent,
    description: 'scripted',
    async start(h) {
      handlers = h;
      // queueMicrotask, not a timer: the failure is delivered as an EVENT, which is the
      // whole point — `connect` is woken by the death, not by waiting for a bound.
      if (script.dieOnStart) queueMicrotask(() => h.closed(script.dieOnStart!));
    },
    async send(message) {
      sent.push(message);
      if (!('id' in message)) return;
      if (script.silent) return;

      const error = script.errors?.[message.method];
      const response = error
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error } }
        : { jsonrpc: '2.0', id: message.id, result: script.results?.[message.method] ?? {} };
      queueMicrotask(() => handlers?.message(response));
    },
    async close() {
      handlers = null;
    },
  };
}

function clientOver(transport: McpTransport, requestTimeoutMs = 5000): McpClient {
  return new McpClient({ server: 'fake', transport, requestTimeoutMs });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('R51 — namespacing', () => {
  test('`{server}__{tool}` round-trips', () => {
    const name = namespacedToolName('github', 'create_issue');
    assert.equal(name, 'github__create_issue');
    assert.equal(serverOfToolName(name), 'github');
    assert.equal(toolOfToolName(name), 'create_issue');
  });

  test('the split is on the FIRST separator, so a tool name may contain one', () => {
    assert.equal(serverOfToolName('github__list__issues'), 'github');
    assert.equal(toolOfToolName('github__list__issues'), 'list__issues');
  });

  test('no built-in tool name is mistaken for an MCP call', () => {
    // Every built-in uses SINGLE underscores. If one ever gained a double, it would be
    // routed to a server that does not exist instead of into the sandbox.
    for (const builtin of [
      'shell',
      'finish',
      'read_file',
      'write_file',
      'list_dir',
      'search_knowledge',
      'delegate',
      'list_workers',
    ]) {
      assert.equal(isNamespacedToolName(builtin), false, builtin);
    }
    assert.equal(isNamespacedToolName('github__create_issue'), true);
  });

  test('a pinned grant list yields its SERVERS, and only from `{server}__*`', () => {
    // The grant unit is the server. Inferring one from a concrete tool name would let a
    // stale snapshot open a session it was never granted.
    assert.deepEqual(
      grantedMcpServers(['finish', 'shell', 'github__*', 'docs__*', 'github__*']),
      ['github', 'docs'],
    );
    assert.deepEqual(grantedMcpServers(['github__create_issue']), []);
  });
});

describe('protocol parsing', () => {
  test('a tool without a name is dropped rather than offered', () => {
    const page = parseToolsList({ tools: [{ name: 'ok' }, { description: 'nameless' }, 7] });
    assert.deepEqual(page.tools.map((t) => t.name), ['ok']);
  });

  test('a missing inputSchema becomes an empty object schema, never undefined', () => {
    // `ToolSpec.parameters` is required; a model handed undefined where a JSON Schema
    // belongs produces a request the model server rejects, which reads as a daemon fault.
    const spec = toToolSpec('github', { name: 'ping' });
    assert.equal(spec.name, 'github__ping');
    assert.deepEqual(spec.parameters, { type: 'object', properties: {} });
    assert.match(spec.description, /github/);
  });

  test('pagination is followed', async () => {
    let page = 0;
    const transport: McpTransport = {
      description: 'paged',
      async start(h) {
        this.handlers = h;
      },
      async send(message) {
        if (!('id' in message)) return;
        const result =
          message.method === 'initialize'
            ? {}
            : page++ === 0
              ? { tools: [{ name: 'a' }], nextCursor: 'next' }
              : { tools: [{ name: 'b' }] };
        queueMicrotask(() => (this as { handlers?: McpTransportHandlers }).handlers?.message({
          jsonrpc: '2.0',
          id: (message as { id: number }).id,
          result,
        }));
      },
      async close() {},
    } as McpTransport & { handlers?: McpTransportHandlers };

    const client = clientOver(transport);
    await client.connect();
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['a', 'b']);
  });

  test('a tool result carries text, and `isError` becomes is_error', () => {
    assert.deepEqual(parseToolCall({ content: [{ type: 'text', text: 'hi' }] }), { content: 'hi' });
    assert.deepEqual(parseToolCall({ content: [{ type: 'text', text: 'nope' }], isError: true }), {
      content: 'nope',
      isError: true,
    });
  });

  test('a binary block is named, not inlined as base64', () => {
    const result = parseToolCall({ content: [{ type: 'image', data: 'AAAA' }] });
    assert.match(result.content, /image content omitted/);
    assert.ok(!result.content.includes('AAAA'), 'base64 would blow the context window');
  });

  test('an empty result says so rather than returning an empty string', () => {
    // An empty tool_result reads to a model as a tool that did nothing, and it retries —
    // straight into the no-progress detector (R33).
    assert.match(parseToolCall({ content: [] }).content, /no content/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the stdio transport, against a real child process', () => {
  function stdioClient(env: Record<string, string>, command?: string[]): McpClient {
    return new McpClient({
      server: 'fake',
      transport: new StdioTransport({
        command: command ?? [process.execPath, '-e', FAKE_SERVER],
        env,
      }),
      requestTimeoutMs: 10_000,
    });
  }

  test('handshake, tools/list and tools/call over newline-delimited JSON-RPC', async () => {
    const client = stdioClient({ PATH: process.env['PATH'] ?? '' });
    await client.connect();
    assert.equal(client.protocolVersion, '2025-06-18');

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['echo']);

    const result = await client.callTool('echo', { text: 'hello' });
    assert.match(result.content, /text=hello/);
    assert.equal(result.isError, undefined);
    await client.close();
  });

  test('the initialized notification is sent, and it expects no reply', async () => {
    // Servers that gate on it refuse every later call without it, with an error that
    // names the call rather than the handshake.
    const transport = scriptedTransport({ results: { initialize: {} } });
    await clientOver(transport).connect();
    assert.deepEqual(
      transport.sent.map((m) => m.method),
      ['initialize', 'notifications/initialized'],
    );
  });

  test('a server that logs to stdout does not break the session', async () => {
    // The fake server writes a bare line during initialize. Treating unparsable output as
    // a protocol fault would kill a working server over a banner.
    const client = stdioClient({ PATH: process.env['PATH'] ?? '' });
    await client.connect();
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo']);
    await client.close();
  });

  test('R52 — the child sees the declared variable and NOT the daemon environment', async () => {
    // The security property. `process.env` is not inherited, so a third-party MCP server
    // never sees DATABASE_URL or another server's credential.
    process.env['ARMADA_MCP_TEST_SECRET'] = 'must-not-leak';
    try {
      const client = stdioClient({ PATH: process.env['PATH'] ?? '', FAKE_TOKEN: 'tok-123' });
      await client.connect();
      const result = await client.callTool('echo', { text: 'x' });
      assert.match(result.content, /token=tok-123/, 'the declared variable reaches the child');
      assert.ok(
        !result.content.includes('ARMADA_MCP_TEST_SECRET'),
        'an undeclared variable must not reach a third-party server',
      );
      await client.close();
    } finally {
      delete process.env['ARMADA_MCP_TEST_SECRET'];
    }
  });

  test('a command that does not exist REJECTS rather than hanging', async () => {
    const client = stdioClient({ PATH: '' }, ['/nonexistent/armada-mcp-server']);
    await assert.rejects(() => client.connect(), /could not start|ENOENT/);
  });

  test('a server that exits mid-session fails everything in flight, naming the cause', async () => {
    const client = stdioClient({ PATH: process.env['PATH'] ?? '' }, [
      process.execPath,
      '-e',
      'process.stdin.on("data", () => process.exit(3));',
    ]);
    await assert.rejects(() => client.connect(), /server process ended/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the http transport, against an injected fetch', () => {
  function httpClient(
    respond: (body: unknown) => { status?: number; contentType?: string; body: string },
    headers: Record<string, string> = {},
  ): { client: McpClient; requests: { headers: Record<string, string>; body: unknown }[] } {
    const requests: { headers: Record<string, string>; body: unknown }[] = [];

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body: unknown = JSON.parse(String(init.body));
      requests.push({ headers: init.headers as Record<string, string>, body });
      const reply = respond(body);
      return new Response(reply.body, {
        status: reply.status ?? 200,
        headers: {
          'content-type': reply.contentType ?? 'application/json',
          'mcp-session-id': 'sess-1',
        },
      });
    }) as unknown as typeof fetch;

    return {
      requests,
      client: new McpClient({
        server: 'docs',
        transport: new HttpTransport({
          url: 'http://docs/mcp',
          headers,
          timeoutMs: 5000,
          fetchImpl,
        }),
        requestTimeoutMs: 5000,
      }),
    };
  }

  const answer = (body: unknown, result: unknown): { body: string } => ({
    body: JSON.stringify({ jsonrpc: '2.0', id: (body as { id: number }).id, result }),
  });

  test('a JSON body carries the response', async () => {
    const { client } = httpClient((body) =>
      answer(body, (body as { method: string }).method === 'tools/list' ? { tools: [{ name: 'search' }] } : {}),
    );
    await client.connect();
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['search']);
  });

  test('an SSE body carries it too', async () => {
    const { client } = httpClient((body) => ({
      contentType: 'text/event-stream',
      body: `: keep-alive\nevent: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: (body as { id: number }).id,
        result: { content: [{ type: 'text', text: 'streamed' }] },
      })}\n\n`,
    }));
    await client.connect();
    assert.equal((await client.callTool('search', { q: 'x' })).content, 'streamed');
  });

  test('R52 — the credential is sent as Authorization: Bearer, once per request', async () => {
    const { client, requests } = httpClient((body) => answer(body, {}), {
      authorization: 'Bearer tok-abc',
    });
    await client.connect();
    assert.equal(requests[0]?.headers['authorization'], 'Bearer tok-abc');
  });

  test('the session id the server assigns is echoed on later requests', async () => {
    const { client, requests } = httpClient((body) => answer(body, { tools: [] }));
    await client.connect();
    await client.listTools();
    assert.equal(requests[0]?.headers['mcp-session-id'], undefined, 'not on the first');
    assert.equal(requests.at(-1)?.headers['mcp-session-id'], 'sess-1');
  });

  test('an HTTP error REJECTS the one request, naming the status', async () => {
    const { client } = httpClient(() => ({ status: 503, body: 'upstream down' }));
    await assert.rejects(() => client.connect(), /HTTP 503/);
  });

  test('a transport-level throw rejects rather than hanging', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new McpClient({
      server: 'docs',
      transport: new HttpTransport({ url: 'http://docs/mcp', headers: {}, timeoutMs: 100, fetchImpl }),
      requestTimeoutMs: 5000,
    });
    await assert.rejects(() => client.connect(), /ECONNREFUSED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every failure REJECTS — nothing here can hang a Step', () => {
  test('a JSON-RPC error becomes a rejection naming the method', async () => {
    const client = clientOver(scriptedTransport({ errors: { initialize: 'unsupported version' } }));
    await assert.rejects(() => client.connect(), /initialize failed: unsupported version/);
  });

  test('a transport that dies during start fails the handshake', async () => {
    const client = clientOver(scriptedTransport({ dieOnStart: 'server process ended (exit code 1)' }));
    await assert.rejects(() => client.connect(), /exit code 1/);
  });

  test('a server that never answers is bounded, not waited on forever', async () => {
    // The bound is an AbortSignal, not a retry loop and not a poll: the wait ends on an
    // event. A Run's four budgets are checked BETWEEN Steps (R34) and cannot end a Step
    // that never returns, which is why this bound has to exist at all.
    const client = clientOver(scriptedTransport({ silent: true }), 1);
    await assert.rejects(() => client.connect(), /did not answer within/);
  });

  test('after a failure, further requests reject immediately with the same reason', async () => {
    const client = clientOver(scriptedTransport({ dieOnStart: 'server process ended (exit code 1)' }));
    await assert.rejects(() => client.connect());
    await assert.rejects(() => client.listTools(), /exit code 1/);
  });

  test('close() is idempotent and fails anything still pending', async () => {
    const client = clientOver(scriptedTransport({ silent: true }), 10_000);
    const pending = assert.rejects(() => client.listTools(), /closed with the Run/);
    await client.close();
    await client.close();
    await pending;
  });
});
