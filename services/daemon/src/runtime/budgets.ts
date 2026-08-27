/**
 * Budget accounting — Agent Runtime R31, R31a, R32, R34; edge 28.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 6 LIVES HERE. Every Run terminates. Four budgets plus the no-progress
 * detector are the whole mechanism.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * CHECKS RUN **BEFORE** EACH STEP AND **BEFORE** EACH TOOL DISPATCH (R34), never after.
 * The difference is not stylistic: checking afterwards means a budget is *detected* as
 * exceeded, which is to say it was already exceeded. Checking first means it can never be
 * exceeded at all. For `max_model_tokens` that is the difference between refusing a Step
 * and paying for one.
 *
 * QUEUE TIME IS NOT WALL-CLOCK TIME (R22). Time a request spends waiting for a scheduler
 * slot is recorded as `queued_ms` and excluded from the wall-clock budget — otherwise a
 * Run on a busy host would fail for a reason that has nothing to do with the Run.
 */

import type { RunOutcome } from '../kernel/types.js';

export const BUDGET_KEYS = [
  'max_steps',
  'max_model_tokens',
  'max_wall_clock_seconds',
  'max_tool_calls',
] as const;

export type BudgetKey = (typeof BUDGET_KEYS)[number];
export type Budgets = Record<BudgetKey, number>;

export interface BudgetCounters {
  stepsUsed: number;
  modelTokensUsed: number;
  toolCallsUsed: number;
  /** Excludes queue time (R22). */
  wallClockMsUsed: number;
  queuedMsTotal: number;
}

export function emptyCounters(): BudgetCounters {
  return {
    stepsUsed: 0,
    modelTokensUsed: 0,
    toolCallsUsed: 0,
    wallClockMsUsed: 0,
    queuedMsTotal: 0,
  };
}

export interface ClampResult {
  budgets: Budgets;
  /** One per clamped budget — each becomes an `error` Event at Run start (R31a). */
  clamped: { budget: BudgetKey; requested: number; ceiling: number }[];
}

/**
 * R31a / edge 28 — clamp a pinned snapshot's budgets to the current ceilings.
 *
 * Agent Definition rejects an over-ceiling budget at SAVE time, so why check again? Because
 * a snapshot is PINNED (invariant 2) and the ceiling can be lowered in config afterwards.
 * The Agent version keeps its old value forever, and re-validating it at save time is not
 * possible — that save already happened. So the Run clamps, records an `error` Event naming
 * the budget, the requested value and the ceiling, and PROCEEDS under the clamped value.
 *
 * Proceeding rather than failing is deliberate: an operator who lowered a ceiling wants
 * subsequent Runs bounded, not an Agent that stops working with no explanation.
 */
export function clampToCeilings(snapshot: Budgets, ceilings: Partial<Budgets>): ClampResult {
  const budgets = { ...snapshot };
  const clamped: ClampResult['clamped'] = [];

  for (const key of BUDGET_KEYS) {
    const ceiling = ceilings[key];
    if (ceiling !== undefined && budgets[key] > ceiling) {
      clamped.push({ budget: key, requested: budgets[key], ceiling });
      budgets[key] = ceiling;
    }
  }

  return { budgets, clamped };
}

export interface BudgetCheck {
  ok: boolean;
  /** Which budget would be exceeded. Present only when ok is false. */
  budget?: BudgetKey;
}

/**
 * Tracks one Run's consumption and answers "may I do this next thing?".
 *
 * The accounting is deliberately dumb and total: every consumption path goes through a
 * method here, so there is exactly one place that knows what a Run has spent.
 */
export class BudgetTracker {
  private readonly counters: BudgetCounters = emptyCounters();

  constructor(
    private readonly budgets: Budgets,
    /** Injected so tests are deterministic and the loop can be driven without waiting. */
    private readonly now: () => number = Date.now,
    private readonly startedAt: number = Date.now(),
  ) {}

  snapshot(): BudgetCounters {
    return { ...this.counters, wallClockMsUsed: this.wallClockMs() };
  }

  /** Elapsed time MINUS queue time (R22). */
  private wallClockMs(): number {
    return Math.max(0, this.now() - this.startedAt - this.counters.queuedMsTotal);
  }

  /**
   * R34 — may another Step begin?
   *
   * Called BEFORE the Step, so `max_steps: 3` permits exactly three Steps and the fourth
   * is refused rather than run-and-then-noticed.
   */
  canStartStep(): BudgetCheck {
    if (this.counters.stepsUsed >= this.budgets.max_steps) {
      return { ok: false, budget: 'max_steps' };
    }
    if (this.counters.modelTokensUsed >= this.budgets.max_model_tokens) {
      return { ok: false, budget: 'max_model_tokens' };
    }
    if (this.wallClockMs() >= this.budgets.max_wall_clock_seconds * 1000) {
      return { ok: false, budget: 'max_wall_clock_seconds' };
    }
    return { ok: true };
  }

  /**
   * R34 — may another tool call be dispatched?
   *
   * Checked separately from canStartStep because one Step may dispatch several tools
   * concurrently, and `max_tool_calls` must bound the total rather than the Steps.
   */
  canDispatchTool(): BudgetCheck {
    if (this.counters.toolCallsUsed >= this.budgets.max_tool_calls) {
      return { ok: false, budget: 'max_tool_calls' };
    }
    if (this.wallClockMs() >= this.budgets.max_wall_clock_seconds * 1000) {
      return { ok: false, budget: 'max_wall_clock_seconds' };
    }
    return { ok: true };
  }

  recordStep(): void {
    this.counters.stepsUsed += 1;
  }

  recordToolCall(): void {
    this.counters.toolCallsUsed += 1;
  }

  /** Tokens from a model_request/model_response pair (R56). */
  recordModelTokens(promptTokens: number, completionTokens: number): void {
    this.counters.modelTokensUsed += promptTokens + completionTokens;
  }

  /** R22 — queue time is recorded and then EXCLUDED from wall clock. */
  recordQueuedMs(ms: number): void {
    this.counters.queuedMsTotal += ms;
  }

  get budgetValues(): Budgets {
    return { ...this.budgets };
  }
}

/** R32 — a budget check failure terminates the Run with this outcome. */
export const BUDGET_EXHAUSTED: RunOutcome = 'budget_exhausted';
