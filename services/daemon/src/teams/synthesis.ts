/**
 * The delegation digest and the synthesis Step — Team Orchestration R35-R38; edges 17, 18.
 *
 * ── SYNTHESIS IS ONE EXTRA STEP, AFTER THE MANAGER'S LOOP AND BEFORE run_end ─
 * R35. It is not a Turn and it dispatches no tools: the manager has already decided what
 * to do, and this is the daemon asking it to write the answer over a structured record of
 * what its workers produced.
 *
 * ── IT DOES NOT DECIDE THE OUTCOME ──────────────────────────────────────────
 * R38 and INVARIANT 1. Synthesis completing is NECESSARY for `success` and never
 * sufficient — the manager must also have called `finish(success: true)`. A Team Run whose
 * manager never called `finish` is `incomplete` even though it produced a perfectly good
 * synthesized answer (edge 21), and one in which every single delegation failed is
 * `success` if the manager self-reported success (edge 5, R38a). The manager is the
 * authority on whether the task was met; the delegations are evidence, not a verdict.
 *
 * ── WHEN THE TREE BUDGET IS ALREADY GONE, THE DIGEST IS THE ANSWER ──────────
 * R36. Synthesis is itself subject to the tree budgets, so an exhausted tree skips it and
 * the Team Run's output is the digest, with `run_end` recording `synthesis_skipped: true`.
 * Spending a model call the budget already refused would make the budget advisory.
 */

import type { ChatMessage, EventSink, ModelAdapter, ModelPriority } from '../kernel/types.js';
import type { ModelAdmission } from '../kernel/types.js';
import { estimateTokens, tokenBudget } from '../runtime/context-builder.js';

/** R35 — one delegation, as the manager sees it during synthesis. */
export interface DigestEntry {
  alias: string;
  task: string;
  outcome: string;
  final_message: string;
  child_run_id: string;
}

/**
 * R35 — `alias`, `task`, `outcome` and final message, in delegation order.
 *
 * JSON rather than prose because the manager has to distinguish which worker said what,
 * and a paragraph per delegation blurs exactly that when there are eight of them.
 */
export function buildDigest(entries: DigestEntry[]): string {
  if (entries.length === 0) {
    // Edge 1 — a manager that never delegated still synthesizes, over an empty digest.
    return 'No subtasks were delegated during this run.';
  }
  return JSON.stringify(entries, null, 2);
}

/**
 * Edge 18 — a digest that will not fit the manager's context is compacted first.
 *
 * OLDEST-FIRST, matching the ordinary context path (R36): the most recent delegations are
 * the ones the manager is reasoning about. Older entries keep their alias, task and
 * outcome — the facts the synthesis needs — and lose their verbatim final message, which
 * is the only part that can be arbitrarily long.
 *
 * Returns the compaction Event payload when it changed anything, so the caller can append
 * it (R37 requires the Event; edge 18 requires it before synthesis).
 */
export function compactDigest(
  entries: DigestEntry[],
  availableTokens: number,
): {
  entries: DigestEntry[];
  event: { messages_compacted: number; tokens_before: number; tokens_after: number; summarized: boolean } | null;
} {
  const before = estimateTokens(buildDigest(entries));
  if (before <= availableTokens || entries.length === 0) {
    return { entries, event: null };
  }

  const compacted = entries.map((entry) => ({ ...entry }));
  let trimmed = 0;

  for (let index = 0; index < compacted.length; index += 1) {
    if (estimateTokens(buildDigest(compacted)) <= availableTokens) break;
    const entry = compacted[index]!;
    if (entry.final_message === '') continue;
    entry.final_message = `[elided — ${estimateTokens(entry.final_message)} tokens; read child run ${entry.child_run_id}]`;
    trimmed += 1;
  }

  return {
    entries: compacted,
    event: {
      messages_compacted: trimmed,
      tokens_before: before,
      tokens_after: estimateTokens(buildDigest(compacted)),
      // Nothing is summarized by a model here: summarizing would cost a further model call
      // against the same budget that is already tight. The elision is honest about that.
      summarized: false,
    },
  };
}

export interface SynthesisInput {
  runId: string;
  model: ModelAdapter;
  events: EventSink;
  bindingTag: string;
  /** The manager's pinned persona (invariant 2). */
  systemPrompt: string;
  /** R2 — appended to the persona for this Step only. */
  synthesisPrompt: string | null;
  /** The Team Run's original task. */
  task: string;
  entries: DigestEntry[];
  contextWindow: number;
  reservedOutputTokens: number;
  admitModelRequest: (tag: string, priority: ModelPriority) => Promise<ModelAdmission>;
  /** R25 — synthesis spends tree budget like anything else. */
  onModelTokens: (promptTokens: number, completionTokens: number) => void;
  signal: AbortSignal;
}

export interface SynthesisResult {
  result: string;
  /** R36 — recorded on `run_end`. */
  skipped: boolean;
  /** Edge 17 — set when the synthesis Step itself failed. */
  error?: string;
}

/** R36 — an exhausted tree budget skips synthesis and returns the digest itself. */
export function skippedSynthesis(entries: DigestEntry[]): SynthesisResult {
  return { result: buildDigest(entries), skipped: true };
}

/**
 * R35 — issue the synthesis Step.
 *
 * Edge 17 — when the model server is unreachable the Team Run terminates `failed` with the
 * digest retained as the final message and `synthesis_skipped: false`. `false` because
 * synthesis was ATTEMPTED and failed, which is a different fact from R36's budget skip and
 * leads an operator to a different place.
 */
export async function runSynthesis(input: SynthesisInput): Promise<SynthesisResult> {
  const available = tokenBudget(input.contextWindow, input.reservedOutputTokens);
  const { entries, event } = compactDigest(input.entries, Math.max(1, Math.floor(available / 2)));

  if (event) {
    await input.events.append({ runId: input.runId, type: 'compaction', payload: { ...event, phase: 'synthesis' } });
  }

  const digest = buildDigest(entries);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: input.synthesisPrompt
        ? `${input.systemPrompt}\n\n${input.synthesisPrompt}`
        : input.systemPrompt,
    },
    { role: 'system', content: `Results of the subtasks you delegated:\n${digest}` },
    { role: 'user', content: input.task },
  ];

  const admission = await input.admitModelRequest(input.bindingTag, 'manager');
  let content = '';
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    await input.events.append({
      runId: input.runId,
      type: 'model_request',
      payload: {
        binding_tag: input.bindingTag,
        phase: 'synthesis',
        messages: messages.length,
        prompt_tokens_estimated: messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
        // R35 — synthesis dispatches NO tools. The manager has already decided.
        tools: [],
        priority: 'manager',
        queued_ms: admission.queuedMs,
      },
    });

    for await (const delta of input.model.chat(
      { tag: input.bindingTag, messages, maxTokens: input.reservedOutputTokens },
      input.signal,
    )) {
      if (delta.content) content += delta.content;
      if (delta.promptTokens !== undefined) promptTokens = delta.promptTokens;
      if (delta.completionTokens !== undefined) completionTokens = delta.completionTokens;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await input.events.append({
      runId: input.runId,
      type: 'error',
      payload: { phase: 'synthesis', error },
    });
    return { result: digest, skipped: false, error };
  } finally {
    admission.release();
  }

  input.onModelTokens(promptTokens, completionTokens);

  await input.events.append({
    runId: input.runId,
    type: 'model_response',
    payload: {
      phase: 'synthesis',
      content,
      tool_calls: [],
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  });

  // A model that returned nothing has not synthesized. Falling back to the digest keeps
  // R37's promise that `result` is the Team Run's answer rather than an empty string.
  return { result: content.trim() === '' ? digest : content, skipped: false };
}
