/**
 * The transport seam — Agent Runtime R50.
 *
 * Two transports, `stdio` and `http`, and ONE client above them. The client owns request
 * correlation, the handshake and timeouts; a transport owns nothing but moving bytes. That
 * split is why adding a transport later cannot change how a Run behaves when a server
 * fails: `mcp_unavailable` and the error-result path live above this line.
 *
 * ── INVARIANT 3 ───────────────────────────────────────────────────────────────
 * BOTH TRANSPORTS RUN DAEMON-SIDE. A stdio server is a child of the daemon process, not of
 * a sandbox container; an http server is reached by the daemon's own fetch. Nothing here is
 * reachable from inside a sandbox, and no sandbox handle appears anywhere in this
 * subsystem — which is what keeps Code mode's restriction to sandbox-local tools (R27a) a
 * property of the design rather than a rule someone has to remember.
 */

import type { JsonRpcOutbound } from './protocol.js';

export interface McpTransportHandlers {
  /** One parsed JSON-RPC message from the server. */
  message: (message: unknown) => void;
  /**
   * The transport can carry nothing further, and why.
   *
   * Every in-flight request is failed with this reason. A server that dies mid-Run must
   * produce an `is_error` tool_result naming it (edge 17), never a hung Step.
   */
  closed: (reason: string) => void;
}

export interface McpTransport {
  /** Human-readable, for an `mcp_unavailable` payload. Never carries a credential. */
  readonly description: string;
  start(handlers: McpTransportHandlers): Promise<void>;
  send(message: JsonRpcOutbound): Promise<void>;
  close(): Promise<void>;
}
