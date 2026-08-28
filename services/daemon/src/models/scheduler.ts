/**
 * Model request scheduling — Agent Runtime R20, R21, R21a, R22.
 *
 * Enforces a per-tag concurrency limit and a global one, from config/models.yaml.
 *
 * ── D5: FIFO **WITHIN PRIORITY CLASS** ──────────────────────────────────────
 * R21 originally said requests wait in a FIFO queue for their tag, while Team
 * Orchestration R32 admits a manager's requests ahead of its workers'. Those cannot both
 * be true — a priority queue is not FIFO. The corrected R21/R21a define exactly two
 * classes, `manager` and `default`: admission takes the highest class with anyone waiting,
 * and within a class it is strictly first-come-first-served.
 *
 * Built that way NOW even though Team Orchestration (which is what assigns the `manager`
 * class) arrives in P8. Retrofitting priority into a plain FIFO later would mean revisiting
 * every admission path; carrying an unused class costs one comparison.
 *
 * ── ADMISSION IS EVENT-DRIVEN (R21) ─────────────────────────────────────────
 * There is NO timed polling and NO fixed delay anywhere in this file. A slot opens exactly
 * when a request completes, and the completion hands the slot to the next waiter directly.
 * A poll would add latency proportional to its interval for no benefit, and it would be
 * the kind of arbitrary wait the platform forbids.
 */

import type { ModelAdmission, ModelPriority } from '../kernel/types.js';

/**
 * R21a — exactly two classes. Manager requests are admitted ahead of workers'.
 *
 * ALIASED to the kernel contract rather than re-declared. Two identical string unions in
 * two files is the shape a drift starts in: the loop names a priority against the kernel's
 * type and this scheduler consumes it, so they must be the SAME type, not two that happen
 * to agree today.
 */
export type PriorityClass = ModelPriority;

const CLASS_ORDER: PriorityClass[] = ['manager', 'default'];

export interface SchedulerLimits {
  maxConcurrentPerTag: number;
  maxConcurrentTotal: number;
}

interface Waiter {
  tag: string;
  priority: PriorityClass;
  /** Monotonic, so ordering within a class is strictly arrival order. */
  seq: number;
  admit: () => void;
}

export type Admission = ModelAdmission;

export class ModelScheduler {
  private readonly perTagActive = new Map<string, number>();
  private totalActive = 0;
  private readonly waiting: Waiter[] = [];
  private nextSeq = 0;

  constructor(
    private readonly limits: SchedulerLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Acquire a slot for `tag`, waiting if the limits are already met.
   *
   * Resolves with the queue time and a release function. The caller MUST release, in a
   * finally block — a leaked slot would stall every subsequent request for that tag with
   * no error to diagnose.
   */
  async acquire(tag: string, priority: PriorityClass = 'default'): Promise<Admission> {
    const requestedAt = this.now();

    if (this.hasCapacity(tag)) {
      this.take(tag);
      // Admitted immediately: no queue time at all, which is the common case on an idle
      // host and must not be reported as a small non-zero wait.
      return { queuedMs: 0, release: () => this.release(tag) };
    }

    await new Promise<void>((resolve) => {
      this.waiting.push({ tag, priority, seq: this.nextSeq++, admit: resolve });
    });

    return { queuedMs: this.now() - requestedAt, release: () => this.release(tag) };
  }

  private hasCapacity(tag: string): boolean {
    const forTag = this.perTagActive.get(tag) ?? 0;
    return forTag < this.limits.maxConcurrentPerTag && this.totalActive < this.limits.maxConcurrentTotal;
  }

  private take(tag: string): void {
    this.perTagActive.set(tag, (this.perTagActive.get(tag) ?? 0) + 1);
    this.totalActive += 1;
  }

  /**
   * Release a slot and hand it to the next eligible waiter.
   *
   * THIS is the event-driven admission: the completion of one request directly admits the
   * next, with no timer in between.
   */
  private release(tag: string): void {
    const forTag = this.perTagActive.get(tag) ?? 1;
    if (forTag <= 1) this.perTagActive.delete(tag);
    else this.perTagActive.set(tag, forTag - 1);
    this.totalActive = Math.max(0, this.totalActive - 1);

    this.admitNext();
  }

  /**
   * Admit as many waiters as the freed capacity allows.
   *
   * A loop rather than a single admission because releasing one global slot can unblock a
   * waiter on a different tag, and because the highest-priority waiter may be blocked on
   * its own tag while a lower-priority one on another tag can proceed.
   */
  private admitNext(): void {
    for (;;) {
      const next = this.pickNext();
      if (!next) return;

      this.waiting.splice(this.waiting.indexOf(next), 1);
      this.take(next.tag);
      next.admit();
    }
  }

  /**
   * D5 — the highest class with an admissible waiter, and within that class the earliest
   * arrival. Strictly FIFO inside a class; strictly priority across classes.
   */
  private pickNext(): Waiter | undefined {
    for (const priority of CLASS_ORDER) {
      const candidate = this.waiting
        .filter((w) => w.priority === priority && this.hasCapacity(w.tag))
        .sort((a, b) => a.seq - b.seq)[0];
      if (candidate) return candidate;
    }
    return undefined;
  }

  /** For health and tests. */
  get stats(): { active: number; waiting: number } {
    return { active: this.totalActive, waiting: this.waiting.length };
  }
}
