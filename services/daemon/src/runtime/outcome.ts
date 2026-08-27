/**
 * Terminal outcome assignment — Agent Runtime R25, R25a, R25b; edges 20, 20a-20d.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 1 LIVES IN THIS FILE. `success` is reachable ONLY through an explicit
 * finish(success: true). Nothing infers it from termination.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS THE MOST CONSEQUENTIAL RULE IN THE RUNTIME. armada-forge builds trajectory
 * training data EXCLUSIVELY from Runs whose outcome is `success` (R25b). Every Run that
 * merely stopped without crashing would otherwise become training data, and the next
 * Adapter would be trained on the model's own mediocre transcripts — a feedback loop that
 * degrades the platform while every individual component looks fine.
 *
 * So the default is NOT success. A Turn that ends with no tool calls and no finish is
 * `incomplete` (R25a). A malformed finish does not terminate at all (edge 20b). And when a
 * Run ends for an external reason — budget, cancel, no-progress, infrastructure fault —
 * the self-report is IGNORED ENTIRELY (edge 20d), because the agent's opinion about a Run
 * it did not get to finish is not evidence.
 */

import type { RunOutcome } from '../kernel/types.js';

/** How a Turn came to an end. The loop reports this; the outcome is derived from it. */
export type TerminationCause =
  | { kind: 'finish'; success: boolean; summary: string }
  | { kind: 'no_tool_calls'; finalMessage: string }
  | { kind: 'budget_exhausted'; budget: string }
  | { kind: 'cancelled' }
  | { kind: 'no_progress' }
  | { kind: 'fault'; error: string };

export interface RunResolution {
  outcome: RunOutcome;
  /** R3 — what GET /api/runs/{run_id} returns as `result`. */
  result: string;
  /** Present only for budget_exhausted; run_end records which budget was hit (R57). */
  budgetHit?: string;
  error?: string;
}

/**
 * Resolve a Run's terminal outcome.
 *
 * `selfReport` is the last finish() the agent made, if any. It is passed separately from
 * `cause` because edge 20c allows a finish on a non-final Turn — the operator posts
 * another user message afterwards — and only the LAST Turn's termination decides the Run.
 */
export function resolveOutcome(
  cause: TerminationCause,
  selfReport?: { success: boolean; summary: string },
): RunResolution {
  switch (cause.kind) {
    case 'finish':
      // R25 — the ONLY path to `success`, and only when the boolean is true.
      // Edge 20a — false is `incomplete`, NOT `failed`. `failed` is reserved for
      // infrastructure faults; `incomplete` means the agent ran correctly and honestly
      // reported it did not achieve the task. Conflating them would make an honest
      // negative indistinguishable from a crash, and would train operators to ignore the
      // fault colour in the dashboard.
      return {
        outcome: cause.success ? 'success' : 'incomplete',
        // Edge 20 — an empty summary is legitimate; the Turn still terminates.
        result: cause.summary,
      };

    case 'no_tool_calls':
      // R25a — a Run is NEVER assigned `success` by default. The model stopping is not a
      // claim that the task is done; it is only a claim that it has nothing more to say.
      return { outcome: 'incomplete', result: cause.finalMessage };

    case 'budget_exhausted':
      // Edge 20d — the self-report is IRRELEVANT here, even if the agent called
      // finish(success: true) on an earlier Turn. A Run that ran out of budget did not
      // finish, whatever it said before it was stopped.
      return {
        outcome: 'budget_exhausted',
        result: selfReport?.summary ?? '',
        budgetHit: cause.budget,
      };

    case 'cancelled':
      return { outcome: 'cancelled', result: selfReport?.summary ?? '' };

    case 'no_progress':
      return { outcome: 'no_progress', result: selfReport?.summary ?? '' };

    case 'fault':
      // `failed` is for infrastructure only: an unreachable model server, a dead
      // container, a database fault. Never for an agent that tried and did not succeed.
      return { outcome: 'failed', result: selfReport?.summary ?? '', error: cause.error };
  }
}

/** R25b — only these Runs are eligible to become trajectory training data. */
export function isTrajectoryEligible(outcome: RunOutcome): boolean {
  return outcome === 'success';
}

/** Terminal outcomes, for the runs table's status transition. */
export function isTerminal(outcome: RunOutcome | null): outcome is RunOutcome {
  return outcome !== null;
}
