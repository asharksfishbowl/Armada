/**
 * Cross-Run budget accounting — Team Orchestration R25, R26, R28, R34.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT 6 ACROSS A TREE. Every Run terminates, and a Team Run terminates BOUNDED
 * ACROSS THE WHOLE TREE rather than per-Run. Four per-Run budgets cannot express that: a
 * manager with `max_delegations: 12` and workers each allowed 200k tokens is bounded only
 * at 2.4 million, which is not a bound anyone chose.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── EXHAUSTION IS DETECTED ON CONSUMPTION, NOT ON A TIMER ───────────────────
 * There is no `setInterval` and no polling here. Every path that spends tree budget calls
 * `recordModelTokens`, and every path that is about to spend calls `check` — so the moment
 * a budget goes over is the moment something reported crossing it. A poll would notice
 * late by up to its interval, and a Run that consumed nothing cannot exhaust a token
 * budget however long the poll ran.
 *
 * Wall clock is evaluated at those same points rather than watched. A tree with nothing
 * happening in it is not spending tree budget; a tree that IS doing something checks its
 * clock before each Step, each tool dispatch, and each delegation.
 *
 * ── R34: QUEUE TIME IS CHARGED TO NEITHER THE CHILD NOR THE TREE ────────────
 * Consistent with the Agent Runtime scheduler contract (R22). Each Run reports its own
 * queue time to its own tracker, and the tree's wall clock subtracts the total, so a busy
 * model server cannot exhaust a Team Run's tree budget with waiting.
 */

import type { TreeBudgetKey } from './team-schema.js';

export interface TreeBudgets {
  tree_max_wall_clock_seconds: number;
  tree_max_model_tokens: number;
}

export interface TreeCounters {
  modelTokensUsed: number;
  /** Elapsed minus queue time (R34). */
  wallClockMsUsed: number;
  queuedMsTotal: number;
}

export type TreeCheck = { ok: true } | { ok: false; budget: TreeBudgetKey };

/**
 * One Team Run's tree accounting.
 *
 * The manager's Run and every child Run report into the SAME instance, which is the whole
 * point: a per-Run tracker cannot see what its siblings spent.
 */
export class TreeAccountant {
  private modelTokensUsed = 0;
  private queuedMsTotal = 0;
  private exhausted: TreeBudgetKey | null = null;
  private readonly listeners: ((budget: TreeBudgetKey) => void)[] = [];

  constructor(
    private readonly budgets: TreeBudgets,
    private readonly now: () => number = Date.now,
    private readonly startedAt: number = Date.now(),
  ) {}

  /**
   * R26 — fired the first time a tree budget goes over, and never again.
   *
   * Once, because the listener cancels every in-flight child, and a cascade that could
   * fire twice would try to cancel Runs it has already terminated.
   */
  onExhausted(listener: (budget: TreeBudgetKey) => void): void {
    this.listeners.push(listener);
    if (this.exhausted) listener(this.exhausted);
  }

  /** Which tree budget stopped the Team Run, or null while it is still within them. */
  get exhaustedBudget(): TreeBudgetKey | null {
    return this.exhausted;
  }

  /**
   * R28 — called BEFORE a child Run is created and before each manager Step, so a child is
   * never started against an already-exhausted budget.
   */
  check(): TreeCheck {
    if (this.exhausted) return { ok: false, budget: this.exhausted };

    if (this.modelTokensUsed >= this.budgets.tree_max_model_tokens) {
      return this.trip('tree_max_model_tokens');
    }
    if (this.wallClockMs() >= this.budgets.tree_max_wall_clock_seconds * 1000) {
      return this.trip('tree_max_wall_clock_seconds');
    }
    return { ok: true };
  }

  /** R25 — every Run in the tree reports here as it accrues, not only at termination. */
  recordModelTokens(promptTokens: number, completionTokens: number): void {
    this.modelTokensUsed += promptTokens + completionTokens;
    // Evaluated immediately, so the Step that crossed the line is the last one that runs.
    this.check();
  }

  /** R34 — recorded so it can be SUBTRACTED from the tree's wall clock. */
  recordQueuedMs(ms: number): void {
    this.queuedMsTotal += ms;
  }

  snapshot(): TreeCounters {
    return {
      modelTokensUsed: this.modelTokensUsed,
      wallClockMsUsed: this.wallClockMs(),
      queuedMsTotal: this.queuedMsTotal,
    };
  }

  private wallClockMs(): number {
    return Math.max(0, this.now() - this.startedAt - this.queuedMsTotal);
  }

  private trip(budget: TreeBudgetKey): TreeCheck {
    this.exhausted = budget;
    for (const listener of this.listeners) listener(budget);
    return { ok: false, budget };
  }
}
