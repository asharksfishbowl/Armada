/**
 * Fixed-order context assembly — Agent Runtime R23, R35.
 *
 * A Step builds its context in ONE order, always:
 *
 *   1. system prompt (the Agent's persona)
 *   2. injected retrieval block  — first Step of a Turn only (R39)
 *   3. compacted history summary — if one exists
 *   4. retained history messages
 *   5. the current user message
 *
 * THE ORDER IS FIXED SO A RUN IS REPRODUCIBLE FROM ITS EVENT STREAM. Every element is
 * recorded as an Event; if assembly order varied by state, replaying those Events would
 * not reconstruct the context the model actually saw, and a trajectory built from them
 * (P11) would train on a prompt that never existed.
 *
 * The budget is `context_window - reserved_output_tokens` (R35) — reserving room for the
 * response, because a context that exactly fills the window leaves nowhere to answer.
 */

import type { ChatMessage } from '../kernel/types.js';

export interface ContextInput {
  systemPrompt: string;
  /** R39 — present only on the first Step of a Turn, and only with a bound corpus. */
  retrievalBlock: string | null;
  summary: string | null;
  history: ChatMessage[];
  userMessage: string;
  contextWindow: number;
  reservedOutputTokens: number;
  estimateTokens: (text: string) => number;
}

export interface BuiltContext {
  messages: ChatMessage[];
  promptTokens: number;
  /** R35 — the ceiling this context had to fit inside. */
  budget: number;
}

export function tokenBudget(contextWindow: number, reservedOutputTokens: number): number {
  return Math.max(0, contextWindow - reservedOutputTokens);
}

export function buildContext(input: ContextInput): BuiltContext {
  const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }];

  // R39 — the retrieval block is a SYSTEM-role block carrying each chunk's source_path and
  // content, placed before history so the model reads it as grounding rather than as a
  // turn in the conversation.
  if (input.retrievalBlock) {
    messages.push({ role: 'system', content: input.retrievalBlock });
  }

  if (input.summary) {
    messages.push({ role: 'system', content: input.summary });
  }

  messages.push(...input.history);
  messages.push({ role: 'user', content: input.userMessage });

  const promptTokens = messages.reduce((sum, m) => sum + input.estimateTokens(m.content), 0);

  return {
    messages,
    promptTokens,
    budget: tokenBudget(input.contextWindow, input.reservedOutputTokens),
  };
}

/**
 * The token estimate used across the runtime.
 *
 * Approximately four characters per token. Deliberately NOT the model's own tokenizer:
 * the context builder must produce the same budget decisions regardless of which binding a
 * Run uses, or an Agent switched between two models would compact at different points for
 * reasons unrelated to its history.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}
