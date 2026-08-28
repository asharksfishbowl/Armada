/**
 * The agent loop — Agent Runtime R19-R25, R31-R39, R55-R58. The Step cycle.
 *
 * THIS FILE IMPORTS NO CONCRETE IMPLEMENTATION. R15, and the Runtime spec's final
 * acceptance criterion tests exactly that: swapping the RetrievalProvider entry in
 * config/plugins.yaml for a stub must change retrieval behaviour with no edit here. Every
 * capability arrives as a plugin interface through the Kernel; the type imports below are
 * contracts, not implementations.
 *
 * ── INVARIANT 1: SUCCESS IS SELF-REPORTED ────────────────────────────────────
 * `finish(success: true)` is the ONLY path to outcome `success`. This loop never infers it
 * from a clean termination, an empty tool list, or a model that simply stopped talking.
 * Running out of Steps is `budget_exhausted`; a model that answers without calling a tool
 * is `incomplete`. Both are terminations, neither is success. `resolveOutcome` owns that
 * mapping and this loop only reports the CAUSE.
 *
 * ── INVARIANT 6: EVERY RUN TERMINATES ────────────────────────────────────────
 * Four budgets plus a no-progress detector, checked BEFORE each Step and BEFORE each tool
 * dispatch (R34). Checked before rather than after so a budget is never EXCEEDED, only
 * prevented — a Run that overspends and then notices has already spent it.
 *
 * The model call is bounded separately, by AbortSignal. A budget checked between Steps
 * cannot end a Step that never returns, so a hung model server would otherwise defeat all
 * five mechanisms at once.
 *
 * ── INVARIANT 5: EVENTS ARE APPEND-ONLY AND GAPLESS ──────────────────────────
 * Every transition appends. Nothing here updates or deletes, and `seq` is assigned by the
 * sink (R58), never by this loop — a caller that numbered its own events would produce two
 * Runs with colliding sequences the moment they interleaved.
 */

import type {
  ChatMessage,
  Event,
  EventSink,
  ModelAdapter,
  ModelAdmission,
  ModelPriority,
  RetrievalProvider,
  RunContext,
  RunOutcome,
  ToolCall,
  ToolProvider,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';
import { BudgetTracker, type BudgetCounters, type Budgets } from './budgets.js';
import { NoProgressDetector } from './no-progress.js';
import { buildContext, estimateTokens, type BuiltContext } from './context-builder.js';
import { resolveOutcome, type RunResolution, type TerminationCause } from './outcome.js';

/** The `finish` tool name. Compared by value so this file imports no built-in module. */
const FINISH = 'finish';

export interface AgentLoopPlugins {
  model: ModelAdapter;
  tools: ToolProvider;
  events: EventSink;
  retrieval: RetrievalProvider;
}

/**
 * What a finalizer may change about a terminated Run — Team Orchestration R36-R38.
 *
 * ── IT CAN DEMOTE AN OUTCOME AND IT CAN NEVER PROMOTE ONE ───────────────────
 * INVARIANT 1. `success` is self-reported, and a finalizer is not the agent. `demoteTo`
 * is typed to exclude `success` so a finalizer that tried to award it would not compile,
 * and `runAgentLoop` throws on one that reaches it another way — a requirement enforced
 * nowhere is decorative.
 *
 * Team R38 needs exactly this and nothing more: a Team Run whose manager self-reported
 * success but whose synthesis Step failed is `failed` (edge 17); one whose tree budget
 * blew is `budget_exhausted` (R26). Both are demotions of an outcome the loop already
 * resolved.
 */
export interface RunFinalization {
  /** Team R37 — replaces the Run's `result`, e.g. with the synthesis output. */
  result?: string;
  /** Merged into the `run_end` payload, e.g. Team R36's `synthesis_skipped`. */
  runEnd?: Record<string, unknown>;
  demoteTo?: Exclude<RunOutcome, 'success'>;
}

/**
 * Runs AFTER the Turn terminates and BEFORE `run_end` is appended.
 *
 * The ordering is the contract, and it is what the P8 exit criterion is stated in terms
 * of: cancelling in-flight children has to happen before the Team Run's `run_end`, so the
 * cascade lives inside a finalizer rather than beside the call.
 */
export type RunFinalizer = (resolution: RunResolution) => Promise<RunFinalization>;

export interface AgentLoopInput {
  ctx: RunContext;
  /** From the Agent's pinned resolved_snapshot. Never re-derived (invariant 2). */
  bindingTag: string;
  systemPrompt: string;
  userMessage: string;
  /** Team R14 — the manager's `context` argument, when this Run is a delegation. */
  contextBlock?: string;
  contextWindow: number;
  reservedOutputTokens: number;
  budgets: Budgets;
  noProgressThreshold: number;
  /** R39 — chunks auto-injected on the first Step of a Turn when a Corpus is bound. */
  autoInjectK: number;
  maxConcurrentTools: number;
  /**
   * R20-R22 / Team R31-R34 — acquire a model-server slot.
   *
   * REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT. `ModelScheduler` was written and unit
   * tested in P7 and then never called by anything; making this mandatory means a caller
   * that forgets to route through it does not compile. An optional field with a
   * pass-through default would have reproduced exactly the defect it is meant to prevent.
   *
   * A function rather than the scheduler itself, so R15 still holds: this file names no
   * concrete implementation.
   */
  admitModelRequest: (tag: string, priority: ModelPriority) => Promise<ModelAdmission>;
  /** D5 / Team R32 — `manager` outranks `default` for the same tag. */
  priority: ModelPriority;
  /** Team R25 — reported as it accrues so a tree accountant sees it before termination. */
  onModelTokens?: (promptTokens: number, completionTokens: number) => void;
  /** Team R35-R38 — the synthesis Step, between termination and `run_end`. */
  finalize?: RunFinalizer;
  /** Cancels the Run (R23). Also bounds every model call. */
  signal: AbortSignal;
}

export interface AgentLoopResult extends RunResolution {
  steps: number;
  /**
   * Team R15 — `delegate`'s ToolResult carries the child's token and step counts, and R3
   * has GET /api/runs/{id} report them. Returned rather than re-derived from the event
   * stream: the tracker already knows, and a second count computed from Events could
   * disagree with the one the budget was enforced against.
   */
  counters: BudgetCounters;
}

export async function runAgentLoop(
  plugins: AgentLoopPlugins,
  input: AgentLoopInput,
): Promise<AgentLoopResult> {
  const { ctx, signal } = input;
  const budgets = new BudgetTracker(input.budgets);
  const noProgress = new NoProgressDetector(input.noProgressThreshold);
  const history: ChatMessage[] = [];

  /** The last VALID finish. Edge 20b — a malformed one does not terminate the Turn. */
  let selfReport: { success: boolean; summary: string } | undefined;
  let steps = 0;

  const append = (
    type: Parameters<EventSink['append']>[0]['type'],
    payload: Record<string, unknown>,
  ): Promise<Event> => plugins.events.append({ runId: ctx.runId, type, payload });

  await append('run_start', {
    agent_version_id: ctx.agentVersionId,
    binding_tag: input.bindingTag,
    mode: ctx.mode,
    budgets: input.budgets,
  });
  await append('user_message', { content: input.userMessage });

  let cause: TerminationCause | null = null;

  try {
    // R39 — retrieval runs ONCE per Turn, on the first Step. Re-running it every Step would
    // inject the same chunks repeatedly against an unchanged query, spending context on
    // duplicates.
    const retrievalBlock = await autoInject(plugins, ctx, input, append);

    while (cause === null) {
      if (signal.aborted) {
        cause = { kind: 'cancelled' };
        break;
      }

      // R34 — BEFORE the Step, so the budget is prevented rather than exceeded.
      const check = budgets.canStartStep();
      if (!check.ok) {
        // `budget` is optional on BudgetCheck — present only when ok is false. Named
        // explicitly rather than asserted non-null: if a future change ever returns
        // !ok without naming the budget, run_end should say "unknown" (R57) instead of
        // recording `undefined` as the budget that stopped the Run.
        cause = { kind: 'budget_exhausted', budget: check.budget ?? 'unknown' };
        break;
      }

      const tools = await plugins.tools.list(ctx);
      const built = buildContext({
        systemPrompt: input.systemPrompt,
        contextBlock: input.contextBlock ?? null,
        // Only the first Step of the Turn carries it (R39).
        retrievalBlock: steps === 0 ? retrievalBlock : null,
        summary: null,
        history,
        userMessage: input.userMessage,
        contextWindow: input.contextWindow,
        reservedOutputTokens: input.reservedOutputTokens,
        estimateTokens,
      });

      budgets.recordStep();
      steps += 1;

      const step = await runStep(plugins, input, built, tools, append, budgets);
      if (step.kind === 'fault') {
        cause = { kind: 'fault', error: step.error };
        break;
      }

      history.push({
        role: 'assistant',
        content: step.content,
        ...(step.toolCalls.length > 0 ? { toolCalls: step.toolCalls } : {}),
      });

      // R21 — a Step with no tool calls ends the Turn. The model answered rather than
      // acting, which is a termination but NEVER a success (invariant 1).
      if (step.toolCalls.length === 0) {
        cause = { kind: 'no_tool_calls', finalMessage: step.content };
        break;
      }

      // R33 — the same tool with byte-identical arguments across consecutive Steps. Caught
      // here rather than at max_steps, which would only notice long after it stopped being
      // useful.
      // Mapped to the detector's shape: it compares NAME and ARGUMENTS only. Passing the
      // wire ToolCall would include `id`, which is unique per call, so two identical calls
      // would never compare equal and the detector would never fire.
      const signature = step.toolCalls.map((c) => ({ name: c.name, args: c.arguments }));
      if (noProgress.record({ kind: 'tool_calls', calls: signature })) {
        cause = { kind: 'no_progress' };
        break;
      }

      const results = await dispatchTools(plugins, ctx, step.toolCalls, input, append, budgets);
      if (results.budgetHit) {
        cause = { kind: 'budget_exhausted', budget: results.budgetHit };
        break;
      }

      // R24 — appended in MODEL-EMISSION order, never completion order, so a Run replays
      // identically from its event stream regardless of which tool finished first.
      for (const { call, result } of results.completed) {
        history.push({ role: 'tool', content: result.content, toolCallId: call.id });
      }

      // Edge 20b — only a WELL-FORMED finish terminates.
      const finish = results.completed.find((r) => r.call.name === FINISH && !r.result.isError);
      if (finish) {
        selfReport = {
          success: readFinishSuccess(finish.call.arguments),
          summary: finish.result.content,
        };
        cause = { kind: 'finish', ...selfReport };
      }
    }
  } catch (err) {
    // A throw escaping the loop is infrastructure, not agent behaviour — `failed`, which
    // is deliberately distinct from the `incomplete` an honest negative self-report
    // produces (edge 20a).
    cause = { kind: 'fault', error: err instanceof Error ? err.message : String(err) };
  }

  let resolution = resolveOutcome(
    cause ?? { kind: 'fault', error: 'loop exited with no cause' },
    selfReport,
  );
  let runEndExtra: Record<string, unknown> = {};

  // Team R35-R38 — synthesis, and the cancellation cascade that must precede `run_end`.
  if (input.finalize) {
    let final: RunFinalization;
    try {
      final = await input.finalize(resolution);
    } catch (err) {
      // A finalizer that throws must not leave the Run without a `run_end` — invariant 6
      // is about the Run terminating, not about the loop body succeeding.
      final = {
        demoteTo: 'failed',
        runEnd: { finalizer_error: err instanceof Error ? err.message : String(err) },
      };
    }

    if ((final.demoteTo as RunOutcome | undefined) === 'success') {
      // Unreachable through the type, reachable from untyped JS. Invariant 1 is the most
      // consequential rule in the runtime; it gets a guard, not a comment.
      throw new Error('a run finalizer may never award `success`: it is self-reported (invariant 1)');
    }

    runEndExtra = final.runEnd ?? {};
    resolution = {
      ...resolution,
      ...(final.demoteTo ? { outcome: final.demoteTo } : {}),
      ...(final.result !== undefined ? { result: final.result } : {}),
    };
  }

  await append('run_end', {
    outcome: resolution.outcome,
    result: resolution.result,
    steps,
    counters: budgets.snapshot(),
    ...(resolution.budgetHit ? { budget_hit: resolution.budgetHit } : {}),
    ...(resolution.error ? { error: resolution.error } : {}),
    ...runEndExtra,
  });

  return { ...resolution, steps, counters: budgets.snapshot() };
}

// ── One Step ─────────────────────────────────────────────────────────────────

type StepResult =
  | { kind: 'ok'; content: string; toolCalls: ToolCall[] }
  | { kind: 'fault'; error: string };

async function runStep(
  plugins: AgentLoopPlugins,
  input: AgentLoopInput,
  built: BuiltContext,
  tools: ToolSpec[],
  append: (type: 'model_request' | 'model_response' | 'error', payload: Record<string, unknown>) => Promise<Event>,
  budgets: BudgetTracker,
): Promise<StepResult> {
  // R20-R22 — THE SLOT IS ACQUIRED BEFORE `model_request` IS APPENDED, not after.
  //
  // Edge 13 requires the Event itself to carry `queued_ms`, and a worker queued behind a
  // manager on the same tag is the case that matters. Appending first and patching later
  // is not available: events are append-only (invariant 5), so the number has to be known
  // by the time the row is written.
  const admission = await input.admitModelRequest(input.bindingTag, input.priority);
  // R22 — recorded, then EXCLUDED from wall clock. A Run on a busy host must not fail for
  // a reason that has nothing to do with the Run.
  budgets.recordQueuedMs(admission.queuedMs);

  let content = '';
  const toolCalls: ToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    await append('model_request', {
      binding_tag: input.bindingTag,
      messages: built.messages.length,
      prompt_tokens_estimated: built.promptTokens,
      tools: tools.map((t) => t.name),
      priority: input.priority,
      queued_ms: admission.queuedMs,
    });

    for await (const delta of plugins.model.chat(
      {
        tag: input.bindingTag,
        messages: built.messages,
        tools,
        maxTokens: input.reservedOutputTokens,
      },
      input.signal,
    )) {
      if (delta.content) content += delta.content;
      if (delta.promptTokens !== undefined) promptTokens = delta.promptTokens;
      if (delta.completionTokens !== undefined) completionTokens = delta.completionTokens;
      if (delta.toolCall?.name) {
        toolCalls.push({
          id: delta.toolCall.id ?? `call_${toolCalls.length}`,
          name: delta.toolCall.name,
          arguments: delta.toolCall.arguments ?? {},
        });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await append('error', { phase: 'model_call', error });
    return { kind: 'fault', error };
  } finally {
    // A leaked slot stalls every subsequent request for this tag with no error to
    // diagnose, so it is released on the throwing path too.
    admission.release();
  }

  // R56 — counted from the request/response pair. Recorded even on a Step that produced
  // nothing useful, because the tokens were spent either way.
  budgets.recordModelTokens(promptTokens, completionTokens);
  // Team R25 — the tree accountant learns of this Run's consumption HERE, as it accrues,
  // rather than at termination. A child that only reported at the end could spend the
  // whole tree budget in one delegation before anything noticed.
  input.onModelTokens?.(promptTokens, completionTokens);

  await append('model_response', {
    content,
    tool_calls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  });

  return { kind: 'ok', content, toolCalls };
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

interface DispatchOutcome {
  completed: { call: ToolCall; result: ToolResult }[];
  budgetHit?: string;
}

async function dispatchTools(
  plugins: AgentLoopPlugins,
  ctx: RunContext,
  calls: ToolCall[],
  input: AgentLoopInput,
  append: (type: 'tool_call' | 'tool_result', payload: Record<string, unknown>) => Promise<Event>,
  budgets: BudgetTracker,
): Promise<DispatchOutcome> {
  let budgetHit: string | undefined;

  // ── PHASE 1: RESERVE, IN INDEX ORDER, ONE CALL AT A TIME ────────────────────
  //
  // The budget check, the counter increment and the `tool_call` Event all happen here, in
  // a SEQUENTIAL loop — not inside the concurrent workers below.
  //
  // Two properties depend on that, and they used to be in tension:
  //
  //   * R34 — the budget is checked before EACH dispatch, and check-and-record must not
  //     interleave. In the previous shape that meant no `await` could sit between them,
  //     which is why the Event was appended afterwards. A sequential loop gets the same
  //     mutual exclusion for free: there is only ever one reservation in flight.
  //
  //   * Team Orchestration R19 — a child Run's `delegation_id` IS the `event_id` of the
  //     manager's `tool_call` Event. `delegate` therefore has to know that id while it
  //     runs, and appending the Event after the tool returned made it unknowable. The id
  //     is handed to the invocation through `ctx.toolCallEventId`.
  //
  // Every reserved call is dispatched, so `tool_call` and `tool_result` still pair
  // exactly. A call the budget refuses is never reserved and never appended.
  const reserved: { call: ToolCall; eventId: string }[] = [];
  for (const call of calls) {
    const check = budgets.canDispatchTool();
    if (!check.ok) {
      budgetHit ??= check.budget ?? 'unknown';
      break;
    }
    budgets.recordToolCall();
    const event = await append('tool_call', {
      tool_call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    reserved.push({ call, eventId: event.eventId });
  }

  // ── PHASE 2: DISPATCH CONCURRENTLY, WRITE RESULTS IN INDEX ORDER ────────────
  //
  // Appending from inside a worker put tool_result events in COMPLETION order, so a Run
  // whose second tool finished first replayed in a different order than it ran. R24 —
  // "the loop must be reproducible from the event stream regardless of which tool happened
  // to finish first" — makes the stream authoritative, not just the in-memory history, and
  // invariant 5 makes it the observability surface and the trajectory training data. Two
  // orderings of the same Run is exactly what that forbids.
  //
  // The cost is that a slow tool delays its siblings' results becoming visible. Ordering
  // is worth more: P10's live inspection can render a correct stream slightly late, but it
  // cannot un-see a wrong one.
  const slots = new Array<ToolResult | undefined>(reserved.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= reserved.length) return;
      const entry = reserved[index];
      if (!entry) return;

      try {
        // A FRESH context object per call. The sandbox and the ids are shared by
        // reference, but `toolCallEventId` is per-invocation — mutating one shared object
        // would hand every concurrently dispatched tool the last writer's id.
        slots[index] = await plugins.tools.invoke(entry.call.name, entry.call.arguments, {
          ...ctx,
          toolCallEventId: entry.eventId,
        });
      } catch (err) {
        // R29/R30 — a tool that throws becomes an error RESULT. The loop continues; a
        // failing tool should cost a Step, not a trajectory.
        slots[index] = {
          content: `tool \`${entry.call.name}\` failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }
  };

  const width = Math.max(1, Math.min(input.maxConcurrentTools, Math.max(1, reserved.length)));
  await Promise.all(Array.from({ length: width }, () => worker()));

  const completed: { call: ToolCall; result: ToolResult }[] = [];
  for (const [index, entry] of reserved.entries()) {
    const result = slots[index];
    if (!result) continue;
    await append('tool_result', {
      tool_call_id: entry.call.id,
      name: entry.call.name,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.spillFailed ? { spill_failed: true } : {}),
    });
    completed.push({ call: entry.call, result });
  }

  return budgetHit === undefined ? { completed } : { completed, budgetHit };
}

// ── Retrieval auto-injection ─────────────────────────────────────────────────

async function autoInject(
  plugins: AgentLoopPlugins,
  ctx: RunContext,
  input: AgentLoopInput,
  append: (type: 'retrieval' | 'error', payload: Record<string, unknown>) => Promise<unknown>,
): Promise<string | null> {
  if (!ctx.corpusId || input.autoInjectK <= 0) return null;

  try {
    const chunks = await plugins.retrieval.query(ctx.corpusId, input.userMessage, input.autoInjectK);
    if (chunks.length === 0) return null;

    await append('retrieval', {
      corpus_id: ctx.corpusId,
      k: input.autoInjectK,
      chunk_ids: chunks.map((c) => c.chunkId),
    });

    // Each chunk carries its source_path, so the model can attribute what it read and the
    // dashboard can link back to it.
    return chunks.map((c) => `# ${c.sourcePath}\n${c.content}`).join('\n\n');
  } catch (err) {
    // R43 — a retrieval fault DEGRADES the Run, it does not end it. An agent with a corpus
    // it could not reach is an agent working from its own knowledge, which is worse than
    // grounded but far better than a dead Run.
    await append('error', {
      phase: 'auto_inject',
      error: err instanceof Error ? err.message : String(err),
      degraded: true,
    });
    return null;
  }
}

function readFinishSuccess(args: unknown): boolean {
  // The registry has already validated shape; this reads the field it guaranteed. No
  // coercion — `success: "false"` must never be truthy, which is why finish.ts requires a
  // real boolean rather than accepting anything falsy-ish.
  return typeof args === 'object' && args !== null && (args as { success?: unknown }).success === true;
}
