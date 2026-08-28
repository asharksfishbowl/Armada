/**
 * The `http` MCP transport — Agent Runtime R50, R52.
 *
 * Streamable HTTP: one POST per outbound message, and the response body carries the
 * server's reply either as JSON or as an SSE stream. The daemon opens no listening
 * endpoint for a server to call back into — this transport is strictly request/response,
 * which keeps the direction of every MCP connection outbound from the daemon.
 *
 * ── WHY THIS ONE DOES NOT NEED A `closed` SIGNAL ─────────────────────────────
 * A dead http server is a failed POST, and a failed POST belongs to exactly one request.
 * It is turned into a JSON-RPC error response for that id, so the caller learns precisely
 * which call failed and the session stays usable if the server comes back. The stdio
 * transport has no such per-request boundary — a dead child kills everything in flight —
 * which is why `closed` exists at all.
 *
 * ── CREDENTIALS ──────────────────────────────────────────────────────────────
 * R52. The one variable an http server may declare in `env_keys` is sent as
 * `Authorization: Bearer <value>` — the mechanism the MCP authorization spec defines. The
 * value is read from the daemon's environment by the session manager and never appears in
 * this file, in config, or in any Event: the sink redacts by value (R59), and every name
 * in `env_keys` reaches it through `collectCredentialEnvNames`.
 *
 * ── INVARIANT 3 ───────────────────────────────────────────────────────────────
 * The fetch is the DAEMON's. No sandbox handle exists here, and a Code-mode Run never
 * reaches this file (the session manager refuses before a transport is constructed).
 */

import { isJsonRpcRequest, type JsonRpcOutbound, type JsonRpcResponse } from './protocol.js';
import type { McpTransport, McpTransportHandlers } from './transport.js';

/** Header the server assigns on `initialize` and expects echoed on every later request. */
const SESSION_HEADER = 'mcp-session-id';

export interface HttpTransportOptions {
  url: string;
  /** Already-resolved values. Built by the session manager from `env_keys`. */
  headers: Record<string, string>;
  /** Bound on one POST. Same reasoning as McpConfig.requestTimeoutMs. */
  timeoutMs: number;
  /** Injectable so the unit tests need no network and no live server. */
  fetchImpl?: typeof fetch;
}

export class HttpTransport implements McpTransport {
  private handlers: McpTransportHandlers | null = null;
  private sessionId: string | null = null;
  private closed = false;

  constructor(private readonly options: HttpTransportOptions) {}

  get description(): string {
    return `http ${this.options.url}`;
  }

  async start(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(message: JsonRpcOutbound): Promise<void> {
    if (this.closed) throw new Error('the MCP server connection is closed');

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const id = isJsonRpcRequest(message) ? message.id : null;

    let response: Response;
    try {
      response = await fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.options.headers,
          ...(this.sessionId ? { [SESSION_HEADER]: this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      // A notification that cannot be delivered is dropped: nothing is waiting on it, and
      // failing the session over `notifications/initialized` would discard a server that
      // works. A REQUEST becomes an error response so its caller stops waiting.
      if (id === null) return;
      this.fail(id, err instanceof Error ? err.message : String(err));
      return;
    }

    const assigned = response.headers.get(SESSION_HEADER);
    if (assigned) this.sessionId = assigned;

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (id === null) return;
      this.fail(id, `HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
      return;
    }

    // 202 with no body is the correct answer to a notification.
    const body = await response.text().catch(() => '');
    if (body.trim().length === 0) return;

    const contentType = response.headers.get('content-type') ?? '';
    for (const parsed of contentType.includes('text/event-stream')
      ? parseSse(body)
      : parseJsonBody(body)) {
      this.handlers?.message(parsed);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;

    // Best effort. The MCP spec has a client terminate its session with DELETE; a server
    // that does not implement it, or that is already gone, is not a problem worth
    // surfacing — the Run is over by the time this runs.
    const fetchImpl = this.options.fetchImpl ?? fetch;
    await fetchImpl(this.options.url, {
      method: 'DELETE',
      headers: { ...this.options.headers, [SESSION_HEADER]: this.sessionId },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    }).catch(() => undefined);
  }

  private fail(id: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    };
    this.handlers?.message(response);
  }
}

function parseJsonBody(body: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(body);
    // A batch response is a JSON array of messages.
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Pull JSON-RPC messages out of an SSE body.
 *
 * The whole body is read first rather than streamed. A `tools/call` result is delivered as
 * one event on a stream the server closes, so incremental parsing would buy nothing but a
 * second code path that only the streaming case exercises.
 */
function parseSse(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A keep-alive or a comment. Not a protocol fault.
    }
  }
  return messages;
}
