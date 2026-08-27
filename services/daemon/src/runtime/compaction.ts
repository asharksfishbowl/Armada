/**
 * Oldest-first compaction — Agent Runtime R36, R37; edge 12.
 *
 * When retained history would exceed the context budget, the OLDEST messages are
 * summarized into a single `summary` message. The most recent `always_retain_messages` are
 * never compacted.
 *
 * WHY OLDEST-FIRST AND WHY A RETAINED TAIL. The recent messages are the ones the model is
 * actually reasoning about — the tool result it just received, the error it is about to
 * correct. Summarizing those would remove the detail the next Step depends on while
 * keeping older context it has already acted on. The tail is retained verbatim for the
 * same reason.
 *
 * EDGE 12 — WHEN COMPACTION ITSELF WILL NOT FIT. Summarizing costs a model call whose
 * input is the messages being summarized. If that input does not fit the budget, the
 * oldest non-retained messages are DROPPED without summarizing and the Event records
 * `summarized: false`. Losing them outright is worse than summarizing, and better than a
 * Run that cannot take another Step.
 */

import type { ChatMessage } from '../kernel/types.js';

export interface CompactionInput {
  messages: ChatMessage[];
  /** Tokens available for history after system prompt, retrieval block and user message. */
  availableTokens: number;
  alwaysRetainMessages: number;
  estimateTokens: (text: string) => number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  /** Null when nothing was compacted. Otherwise the `compaction` Event payload (R37). */
  event: {
    messagesCompacted: number;
    tokensBefore: number;
    tokensAfter: number;
    summarized: boolean;
  } | null;
  /** Messages the caller must summarize, when summarization is possible. */
  toSummarize: ChatMessage[];
}

function totalTokens(messages: ChatMessage[], estimate: (text: string) => number): number {
  return messages.reduce((sum, m) => sum + estimate(m.content), 0);
}

/**
 * Decide what to compact. Does NOT call the model — the caller owns that, because it needs
 * the Kernel's ModelAdapter and this stays pure and testable.
 */
export function planCompaction(input: CompactionInput): CompactionResult {
  const { messages, availableTokens, alwaysRetainMessages, estimateTokens } = input;
  const before = totalTokens(messages, estimateTokens);

  if (before <= availableTokens) {
    return { messages, event: null, toSummarize: [] };
  }

  // R36 — the tail is never compacted, however far over budget we are.
  const retainFrom = Math.max(0, messages.length - alwaysRetainMessages);
  const candidates = messages.slice(0, retainFrom);
  const retained = messages.slice(retainFrom);

  if (candidates.length === 0) {
    // Everything is inside the retained tail. There is nothing this function may compact;
    // the caller proceeds over budget rather than discarding what the model needs most.
    return { messages, event: null, toSummarize: [] };
  }

  const retainedTokens = totalTokens(retained, estimateTokens);
  const roomForSummary = availableTokens - retainedTokens;

  // Edge 12 — the summarization call's input is `candidates`. If even the retained tail
  // leaves no room for a summary, drop instead of summarizing.
  if (roomForSummary <= 0) {
    return {
      messages: retained,
      event: {
        messagesCompacted: candidates.length,
        tokensBefore: before,
        tokensAfter: retainedTokens,
        summarized: false,
      },
      toSummarize: [],
    };
  }

  return {
    messages: retained,
    event: {
      messagesCompacted: candidates.length,
      tokensBefore: before,
      // Filled in by the caller once the summary exists; this is the floor.
      tokensAfter: retainedTokens,
      summarized: true,
    },
    toSummarize: candidates,
  };
}

/** The message a summary is folded back in as. */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content: `Summary of earlier conversation:\n${summary}`,
  };
}
