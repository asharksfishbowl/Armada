/**
 * The `stdio` MCP transport — Agent Runtime R50, R52.
 *
 * Newline-delimited JSON-RPC over a child process's stdin/stdout, which is what the MCP
 * stdio transport is.
 *
 * ── THE CHILD'S ENVIRONMENT IS BUILT, NOT INHERITED ──────────────────────────
 * `process.env` is NOT passed through. An MCP server is third-party code; handing it the
 * daemon's whole environment would give it DATABASE_URL and every other server's
 * credential, and `env_keys` would then be documentation rather than a boundary. The child
 * receives a small, explicit passthrough set plus exactly the variables that server
 * declared. R52 says credentials are read from the variables named in `env_keys`; this is
 * the other half of that sentence.
 *
 * ── NOTHING HERE SPAWNS A SHELL ──────────────────────────────────────────────
 * `command` is argv, already split, and is passed to `spawn` without `shell: true`. A
 * server name or argument containing shell metacharacters is therefore an argument, not an
 * injection.
 *
 * ── A SERVER THAT WRITES NOISE TO STDOUT DOES NOT KILL THE SESSION ───────────
 * Unparsable lines are dropped. Servers that log to stdout are common and their noise is
 * not a protocol fault; treating it as one would take down a working server over a banner.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JsonRpcOutbound } from './protocol.js';
import type { McpTransport, McpTransportHandlers } from './transport.js';

/** How much stderr to keep for a diagnostic. Bounded so a chatty server cannot grow it. */
const STDERR_TAIL_BYTES = 2000;

export interface StdioTransportOptions {
  /** argv. `command[0]` is the executable. */
  command: string[];
  /** Resolved values, keyed by variable name. Built by the session manager. */
  env: Record<string, string>;
}

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private handlers: McpTransportHandlers | null = null;
  private buffer = '';
  private stderrTail = '';
  private closed = false;

  constructor(private readonly options: StdioTransportOptions) {}

  get description(): string {
    return `stdio \`${this.options.command.join(' ')}\``;
  }

  async start(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;

    const [executable, ...args] = this.options.command;
    if (!executable) throw new Error('an stdio MCP server needs a command');

    // No `shell: true`, and an environment built from nothing.
    const child = spawn(executable, args, { env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.absorb(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Kept ONLY to name a cause when the process dies. It is never appended to an Event
      // directly by this class; the session manager puts it in `mcp_unavailable`, where the
      // sink's redaction (R59) removes any credential value the server echoed.
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    // ENOENT for a command that does not exist. Event-driven: `connect` is waiting on the
    // `initialize` response, and failing every pending request is what wakes it — no poll,
    // no readiness delay.
    child.on('error', (err: Error) => this.die(`could not start: ${err.message}`));
    child.on('exit', (code, signal) => {
      const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      const tail = this.stderrTail.trim();
      this.die(`server process ended (${how})${tail ? `: ${tail}` : ''}`);
    });

    // stdin can break independently — a server that closed its input but is still alive.
    child.stdin.on('error', (err: Error) => this.die(`stdin closed: ${err.message}`));
  }

  async send(message: JsonRpcOutbound): Promise<void> {
    const child = this.child;
    if (!child || this.closed) throw new Error('the MCP server connection is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child) return;

    // Closing stdin is how the MCP stdio transport asks a server to exit. SIGTERM follows
    // so a server that ignores EOF still goes away — the daemon must not leak a child per
    // Run, which is the same failure mode R48's orphan sweep exists for on the Docker side.
    child.stdin.end();
    child.kill('SIGTERM');
  }

  /** Split the stream on newlines and hand each parsable line up. */
  private absorb(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');

    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');

      if (line.length === 0) continue;
      try {
        this.handlers?.message(JSON.parse(line));
      } catch {
        // Not JSON. A log line, not a protocol fault.
      }
    }
  }

  private die(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.child = null;
    this.handlers?.closed(reason);
  }
}
