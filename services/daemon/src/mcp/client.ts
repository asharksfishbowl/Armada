/**
 * McpClient — one connection to one MCP server. Agent Runtime R50-R53.
 *
 * Owns the handshake, request correlation and the per-request bound. Transport-agnostic:
 * it is handed an `McpTransport` and never learns whether the server is a child process or
 * a URL, which is what lets the two transports be tested against the same client.
 *
 * ── THIS CLASS NEVER TERMINATES A RUN ────────────────────────────────────────
 * Its methods reject. Every caller is `McpSessionManager`, which turns a rejection into an
 * `mcp_unavailable` Event (R53) or an `is_error` tool_result (edge 17) and lets the Run
 * continue. That division is deliberate: a client that knew about Runs would need the event
 * sink, and the thing that decides a Run's fate would be the thing talking to third-party
 * software.
 *
 * ── THE TIMEOUT IS A BOUND, NOT A DELAY ──────────────────────────────────────
 * There is no retry, no backoff and no wait-and-see. A request that has not been answered
 * within the configured ceiling is failed once, because the Run's four budgets are checked
 * BETWEEN Steps (R34) and cannot end a Step that never returns. Same reasoning as the
 * AbortSignal that bounds every model call in the agent loop.
 */

import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseToolCall,
  parseToolsList,
  type JsonRpcResponse,
  type McpToolDescriptor,
} from './protocol.js';
import type { McpTransport } from './transport.js';
import type { ToolResult } from '../kernel/types.js';

/**
 * Ceiling on `tools/list` pagination.
 *
 * Not a retry limit — each page is a distinct result. It exists because a server that
 * returns the same `nextCursor` forever would otherwise spin here, and a Run must not hang
 * on another program's bug.
 */
const MAX_TOOL_PAGES = 20;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  /** Detaches the bound's abort listener. Called on every settle path. */
  dispose: () => void;
  method: string;
}

export interface McpClientOptions {
  /** The configured server name. Used in messages so a fault names its server (R53). */
  server: string;
  transport: McpTransport;
  requestTimeoutMs: number;
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private failure: string | null = null;
  private serverProtocolVersion: string | null = null;

  constructor(private readonly options: McpClientOptions) {}

  get server(): string {
    return this.options.server;
  }

  /** Non-null once the connection can carry nothing further, carrying the reason. */
  get closedReason(): string | null {
    return this.failure;
  }

  get protocolVersion(): string | null {
    return this.serverProtocolVersion;
  }

  /**
   * The MCP handshake: `initialize`, then the `notifications/initialized` notification.
   *
   * The notification is required by the protocol and is deliberately NOT awaited for a
   * reply — it has none. Skipping it leaves servers that gate on it refusing every
   * subsequent call with a confusing error.
   */
  async connect(): Promise<void> {
    await this.options.transport.start({
      message: (message) => this.receive(message),
      closed: (reason) => this.fail(reason),
    });

    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // No client capabilities are declared: this daemon consumes tools and offers the
      // server nothing to call back into. Declaring `sampling` would invite a server to ask
      // the daemon for model calls that no Run's budget accounts for.
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    });

    const negotiated = (result as { protocolVersion?: unknown } | null)?.protocolVersion;
    this.serverProtocolVersion = typeof negotiated === 'string' ? negotiated : null;

    await this.options.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** Every tool the server exposes, unnamespaced. The session applies R51's prefix. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result: unknown = await this.request(
        'tools/list',
        cursor === null ? {} : { cursor },
      );
      const parsed = parseToolsList(result);
      tools.push(...parsed.tools);
      if (parsed.nextCursor === null || parsed.nextCursor === cursor) return tools;
      cursor = parsed.nextCursor;
    }

    return tools;
  }

  /**
   * Call one tool.
   *
   * A PROTOCOL error rejects; a TOOL error comes back as `isError` in the result and is
   * returned, not thrown. The distinction is the one R29/R30 already draw: the tool failing
   * is information for the model, the connection failing is information for the operator.
   */
  async callTool(tool: string, args: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name: tool,
      // A model that emitted no arguments must still produce a valid call object.
      arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    });
    return parseToolCall(result);
  }

  async close(): Promise<void> {
    this.fail('the MCP session was closed with the Run');
    await this.options.transport.close().catch(() => undefined);
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure !== null) {
      return Promise.reject(new Error(this.failure));
    }

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      // The bound, expressed as a signal rather than a timer. It is the same primitive the
      // agent loop uses to bound a model call and the same one validation-context.ts uses
      // to bound a fan-out to forge: the wait ENDS on an event, and Node does not hold the
      // process open for it, so a pending MCP request can never be the reason the daemon
      // will not exit on SIGTERM.
      const bound = AbortSignal.timeout(this.options.requestTimeoutMs);
      const onBoundReached = (): void => {
        this.pending.delete(id);
        reject(
          new Error(
            `\`${method}\` did not answer within ${Math.round(this.options.requestTimeoutMs / 1000)}s`,
          ),
        );
      };
      bound.addEventListener('abort', onBoundReached, { once: true });

      this.pending.set(id, {
        resolve,
        reject,
        dispose: () => bound.removeEventListener('abort', onBoundReached),
        method,
      });

      this.options.transport
        .send({ jsonrpc: '2.0', id, method, params })
        .catch((err: unknown) => {
          this.settle(id, (pending) =>
            pending.reject(new Error(err instanceof Error ? err.message : String(err))),
          );
        });
    });
  }

  private receive(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      const response = message as JsonRpcResponse;
      this.settle(response.id, (pending) => {
        if (response.error) {
          pending.reject(
            new Error(`${pending.method} failed: ${response.error.message} (${response.error.code})`),
          );
        } else {
          pending.resolve(response.result);
        }
      });
      return;
    }

    // A server asking the client for something. No client capabilities were declared, so
    // the honest answer is that the method does not exist — and answering matters: a server
    // left waiting on a request nobody replies to may never answer the tool call the Run is
    // actually blocked on.
    if (isJsonRpcRequest(message)) {
      void this.options.transport
        .send({
          jsonrpc: '2.0',
          id: message.id,
          method: message.method,
          params: { error: { code: -32601, message: 'armada-daemon declares no client capabilities' } },
        } as never)
        .catch(() => undefined);
    }
  }

  private settle(id: number, apply: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.dispose();
    apply(pending);
  }

  /** Fail everything in flight with one reason. Idempotent — close() and death both call it. */
  private fail(reason: string): void {
    this.failure ??= reason;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.dispose();
      pending.reject(new Error(reason));
    }
  }
}
