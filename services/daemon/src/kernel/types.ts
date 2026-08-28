/**
 * The five plugin interfaces — Agent Runtime R8-R13.
 *
 * EXACTLY these five, no more. The Kernel resolves every runtime capability through them,
 * and R15 forbids the agent loop from importing a concrete implementation directly. That
 * restriction is what the Runtime spec's final acceptance criterion tests: replacing the
 * RetrievalProvider entry in config/plugins.yaml with a stub must change retrieval
 * behaviour with no edit to agent-loop.ts.
 *
 * Nothing in this file imports an implementation. It is types and contracts only.
 */

// ── Shared value types ───────────────────────────────────────────────────────

export type ToolFormat = 'json_schema' | 'hermes';
export type RunMode = 'standard' | 'code';

/** Runtime R24 — the six terminal outcomes. */
export type RunOutcome =
  | 'success'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'no_progress';

/** Runtime R55 — the complete Event type union. Mirrors the `event_type` enum in 001. */
export type EventType =
  | 'run_start'
  | 'user_message'
  | 'model_request'
  | 'model_response'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'retrieval'
  | 'compaction'
  | 'mode_downgraded'
  | 'mcp_unavailable'
  | 'delegation'
  | 'error'
  | 'run_end';

export interface Event {
  eventId: string;
  runId: string;
  /** Monotonic and gapless per Run (R54). Assigned by the sink, never by a caller. */
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** An Event as submitted. No `seq` — R58 makes assignment the sink's job. */
export interface EventInput {
  runId: string;
  type: EventType;
  payload?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatRequest {
  /** The ModelBinding tag from the Agent's pinned resolved_snapshot. Never re-resolved. */
  tag: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
}

/**
 * D5 — EXACTLY TWO ADMISSION CLASSES. Runtime R21a, Team Orchestration R32.
 *
 * Declared here rather than in `models/scheduler.ts` so the agent loop can name a priority
 * without importing a concrete scheduler. R15 forbids the loop importing an implementation,
 * and a type import that happens to erase is still a dependency on the wrong file.
 */
export type ModelPriority = 'manager' | 'default';

/** A scheduler slot — Runtime R20-R22. */
export interface ModelAdmission {
  /** R22 — recorded on the model_request Event and NEVER charged to wall clock. */
  queuedMs: number;
  /** Called when the request finishes, success or failure. */
  release: () => void;
}

export interface ChatDelta {
  content?: string;
  toolCall?: Partial<ToolCall>;
  promptTokens?: number;
  completionTokens?: number;
  done?: boolean;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  contextWindow: number;
  toolFormat: ToolFormat;
}

export interface ToolSpec {
  /** Fully qualified: a built-in name, or `{server}__{tool}` for MCP (R51). */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  truncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  spillFailed?: boolean;
}

export interface RunContext {
  runId: string;
  agentVersionId: string;
  mode: RunMode;
  sandbox?: Sandbox;
  corpusId?: string | null;
  /**
   * Team Orchestration R19 — the `event_id` of the `tool_call` Event that dispatched THIS
   * invocation, and therefore the `delegation_id` a child Run is created with.
   *
   * Set per invocation rather than per Run: one Step may dispatch several tools
   * concurrently, so a single shared field on the Run's context would hand every one of
   * them the same id. The loop spreads a fresh object per call.
   */
  toolCallEventId?: string;
}

export interface Chunk {
  chunkId: string;
  content: string;
  sourcePath: string;
  score: number;
}

export interface SandboxSpec {
  runId: string;
  profile: string;
  workspacePath?: string | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * The filesystem and shell a Run's built-in tools operate on.
 *
 * INVARIANT 3 — one-directional. The daemon reaches in through this interface; nothing
 * inside a sandbox calls back out. There is deliberately no callback channel here, which
 * is exactly why Code mode is restricted to sandbox-local tools (R27a).
 */
export interface Sandbox {
  id: string;
  exec(command: string, timeoutSeconds?: number): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
}

// ── The five plugin interfaces ───────────────────────────────────────────────

/** R9. */
export interface ModelAdapter {
  readonly name: string;
  chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>;
  capabilities(tag: string): Promise<ModelCapabilities>;
}

/** R10. */
export interface ToolProvider {
  readonly name: string;
  list(ctx: RunContext): Promise<ToolSpec[]>;
  invoke(name: string, args: unknown, ctx: RunContext): Promise<ToolResult>;
}

/** R11. */
export interface SandboxProvider {
  readonly name: string;
  acquire(spec: SandboxSpec): Promise<Sandbox>;
  release(sandbox: Sandbox): Promise<void>;
  /** Edge 13 — remove containers labelled with a run_id whose Run is not active. */
  sweepOrphans(): Promise<string[]>;
}

/**
 * R12. READ-ONLY by contract: there is no write method here, because armada-forge owns
 * writes to the vector index and the daemon only queries it (platform boundary 1).
 */
export interface RetrievalProvider {
  readonly name: string;
  query(corpusId: string, text: string, k: number): Promise<Chunk[]>;
}

/**
 * R13. The sink assigns `seq` (R58) and performs redaction (R59) — both are properties of
 * the sink rather than of its callers, so no caller can forget either.
 */
export interface EventSink {
  readonly name: string;
  append(event: EventInput): Promise<Event>;
  read(runId: string, afterSeq?: number): Promise<Event[]>;
}

/** The interface names the Kernel requires. Order is the registration/report order. */
export const PLUGIN_INTERFACES = [
  'ModelAdapter',
  'ToolProvider',
  'SandboxProvider',
  'RetrievalProvider',
  'EventSink',
] as const;

export type PluginInterface = (typeof PLUGIN_INTERFACES)[number];

export interface PluginMap {
  ModelAdapter: ModelAdapter;
  ToolProvider: ToolProvider;
  SandboxProvider: SandboxProvider;
  RetrievalProvider: RetrievalProvider;
  EventSink: EventSink;
}
