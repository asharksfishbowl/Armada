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
  EventSink,
  ModelAdapter,
  RetrievalProvider,
  RunContext,
  ToolCall,
  ToolProvider,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';
import { BudgetTracker, type Budgets } from './budgets.js';
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

export interface AgentLoopInput {
  ctx: RunContext;
  /** From the Agent's pinned resolved_snapshot. Never re-derived (invariant 2). */
  bindingTag: string;
  systemPrompt: string;
  userMessage: string;
  contextWindow: number;
  reservedOutputTokens: number;
  budgets: Budgets;
  noProgressThreshold: number;
  /** R39 — chunks auto-injected on the first Step of a Turn when a Corpus is bound. */
  autoInjectK: number;
  maxConcurrentTools: number;
  /** Cancels the Run (R23). Also bounds every model call. */
  signal: AbortSignal;
}

export interface AgentLoopResult extends RunResolution {
  steps: number;
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

  const append = (type: Parameters<EventSink['append']>[0]['type'], payload: Record<string, unknown>) =>
    plugins.events.append({ runId: ctx.runId, type, payload });

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

  const resolution = resolveOutcome(cause ?? { kind: 'fault', error: 'loop exited with no cause' }, selfReport);

  await append('run_end', {
    outcome: resolution.outcome,
    result: resolution.result,
    steps,
    counters: budgets.snapshot(),
    ...(resolution.budgetHit ? { budget_hit: resolution.budgetHit } : {}),
    ...(resolution.error ? { error: resolution.error } : {}),
  });

  return { ...resolution, steps };
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
  append: (type: 'model_request' | 'model_response' | 'error', payload: Record<string, unknown>) => Promise<unknown>,
  budgets: BudgetTracker,
): Promise<StepResult> {
  await append('model_request', {
    binding_tag: input.bindingTag,
    messages: built.messages.length,
    prompt_tokens_estimated: built.promptTokens,
    tools: tools.map((t) => t.name),
  });

  let content = '';
  const toolCalls: ToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  try {
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
  }

  // R56 — counted from the request/response pair. Recorded even on a Step that produced
  // nothing useful, because the tokens were spent either way.
  budgets.recordModelTokens(promptTokens, completionTokens);

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
  append: (type: 'tool_call' | 'tool_result', payload: Record<string, unknown>) => Promise<unknown>,
  budgets: BudgetTracker,
): Promise<DispatchOutcome> {
  let budgetHit: string | undefined;

  // Slots are filled by index and the EVENT STREAM IS WRITTEN AFTERWARDS, IN INDEX ORDER.
  //
  // Appending from inside a worker put tool_result events in COMPLETION order, so a Run
  // whose second tool finished first replayed in a different order than it ran. R24 —
  // "the loop must be reproducible from the event stream regardless of which tool happened
  // to finish first" — makes the stream authoritative, not just the in-memory history, and
  // invariant 5 makes it the observability surface and the trajectory training data. Two
  // orderings of the same Run is exactly what that forbids.
  //
  // The cost is that a slow tool delays its siblings' events becoming visible. Ordering is
  // worth more: P10's live inspection can render a correct stream slightly late, but it
  // cannot un-see a wrong one.
  const slots = new Array<{ call: ToolCall; result: ToolResult } | undefined>(calls.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= calls.length) return;
      const call = calls[index];
      if (!call) return;

      // R34 — checked BEFORE each dispatch, not once per Step, so a Step emitting ten
      // calls cannot spend ten past a ceiling of two.
      //
      // CHECK AND RECORD ARE ADJACENT AND SYNCHRONOUS, WITH NO await BETWEEN THEM. That
      // adjacency IS the mutual exclusion: JavaScript will not interleave two workers
      // inside a synchronous run. An `await append(...)` used to sit here, and every
      // worker passed the check before any of them recorded — three tools dispatched
      // against a ceiling of two. The budget was checked and still exceeded.
      const check = budgets.canDispatchTool();
      if (!check.ok) {
        budgetHit ??= check.budget ?? 'unknown';
        return;
      }
      budgets.recordToolCall();

      let result: ToolResult;
      try {
        result = await plugins.tools.invoke(call.name, call.arguments, ctx);
      } catch (err) {
        // R29/R30 — a tool that throws becomes an error RESULT. The loop continues; a
        // failing tool should cost a Step, not a trajectory.
        result = {
          content: `tool \`${call.name}\` failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      slots[index] = { call, result };
    }
  };

  const width = Math.max(1, Math.min(input.maxConcurrentTools, calls.length));
  await Promise.all(Array.from({ length: width }, () => worker()));

  const completed: { call: ToolCall; result: ToolResult }[] = [];
  for (const entry of slots) {
    if (!entry) continue;   // never dispatched — the budget stopped before this index
    const { call, result } = entry;
    await append('tool_call', { tool_call_id: call.id, name: call.name, arguments: call.arguments });
    await append('tool_result', {
      tool_call_id: call.id,
      name: call.name,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.spillFailed ? { spill_failed: true } : {}),
    });
    completed.push(entry);
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
