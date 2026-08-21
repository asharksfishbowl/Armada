/**
 * Event payload shapes — Agent Runtime R55-R57.
 *
 * `run_start` IS DELIBERATELY NOT ENUMERATED HERE. build-plan defect D2 records that
 * agent-runtime.md never states its payload — R57 specifies `run_end`'s, while `run_start`
 * appears only in R55's type union and edge 8. D2 is corrected by a /spec pass on
 * agent-runtime.md, not here and not by guessing: writing a shape into this file would be
 * the second conflicting statement of a requirement that build-plan explicitly warns
 * against. The event TYPE ships; its payload shape waits for the spec.
 *
 * Everything below is stated by the spec today.
 */

import type { RunOutcome } from '../kernel/types.js';

/** R56 — recorded on both model_request and model_response. */
export interface ModelExchangePayload {
  tag: string;
  promptTokens: number;
  completionTokens: number;
  /** R22 — queue time. Recorded here and NOT charged to the wall-clock budget. */
  queuedMs: number;
}

/** R57. */
export interface RunEndPayload {
  outcome: RunOutcome;
  budgets: {
    stepsUsed: number;
    modelTokensUsed: number;
    wallClockMsUsed: number;
    toolCallsUsed: number;
  };
  /** Present only for `budget_exhausted` — which budget was hit. */
  budgetHit?: string;
  /** Team Orchestration R36 — synthesis skipped because a tree budget was exhausted. */
  synthesisSkipped?: boolean;
}

/** R42. */
export interface RetrievalPayload {
  query: string;
  k: number;
  chunkIds: string[];
  scores: number[];
  /** Edge 11 — chunks dropped from lowest fused score upward to fit the context budget. */
  chunksDropped?: number;
}

/** R37. */
export interface CompactionPayload {
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  /** Edge 12 — oldest messages dropped without summarizing when compaction itself would
   *  not fit the budget. */
  summarized: boolean;
}

/** R28, R28a. */
export interface ModeDowngradedPayload {
  from: 'code';
  to: 'standard';
  reason: string;
  excludedTools?: string[];
}

/** R53. */
export interface McpUnavailablePayload {
  server: string;
  error: string;
}

export interface ErrorPayload {
  message: string;
  /** Set by the budget clamp at Run start (R31a, edge 28). */
  budget?: string;
  requested?: number;
  ceiling?: number;
}

/** Team Orchestration R19. */
export interface DelegationPayload {
  alias: string;
  task: string;
  childRunId: string;
  outcome?: RunOutcome;
}

