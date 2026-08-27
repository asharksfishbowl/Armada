/**
 * P7 — outcome assignment, budget accounting, and the no-progress detector.
 *
 * Agent Runtime R25/R25a/R25b, R31-R34, R33/R33a; edges 4, 20, 20a-20d, 28.
 *
 * These are pure logic with no I/O, and they carry INVARIANT 1 (success is self-reported)
 * and INVARIANT 6 (every Run terminates). The queue calls them the highest-value units in
 * the repo, and the reason is concrete: a regression here does not crash anything. It
 * quietly mislabels Runs, and P11 then builds trajectory training data from Runs that
 * never succeeded.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveOutcome, isTrajectoryEligible } from '../runtime/outcome.js';
import { BudgetTracker, clampToCeilings, type Budgets } from '../runtime/budgets.js';
import { NoProgressDetector, signatureOf } from '../runtime/no-progress.js';

const BUDGETS: Budgets = {
  max_steps: 3,
  max_model_tokens: 1000,
  max_wall_clock_seconds: 60,
  max_tool_calls: 5,
};

describe('INVARIANT 1 — only finish(success: true) yields success', () => {
  test('finish(success: true) records success', () => {
    const result = resolveOutcome({ kind: 'finish', success: true, summary: 'done' });
    assert.equal(result.outcome, 'success');
    assert.equal(result.result, 'done');
  });

  test('finish(success: false) records INCOMPLETE, not failed (edge 20a)', () => {
    const result = resolveOutcome({ kind: 'finish', success: false, summary: 'could not' });
    // `failed` is reserved for infrastructure faults. Conflating an honest negative with a
    // crash makes the two indistinguishable in the dashboard and trains operators to
    // ignore the fault colour.
    assert.equal(result.outcome, 'incomplete');
  });

  test('a model that stops emitting tool calls without finish records INCOMPLETE (R25a)', () => {
    const result = resolveOutcome({ kind: 'no_tool_calls', finalMessage: 'I think that is all' });
    // A Run is NEVER assigned success by default. Stopping is not a claim of completion.
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.result, 'I think that is all');
  });

  test('an empty summary still terminates and records the outcome (edge 20)', () => {
    const result = resolveOutcome({ kind: 'finish', success: true, summary: '' });
    assert.equal(result.outcome, 'success');
    assert.equal(result.result, '');
  });

  test('ONLY success is trajectory-eligible (R25b)', () => {
    assert.equal(isTrajectoryEligible('success'), true);
    for (const outcome of ['incomplete', 'failed', 'cancelled', 'budget_exhausted', 'no_progress'] as const) {
      // This is the whole reason invariant 1 is strict: forge builds training data from
      // `success` alone, so a mislabelled Run becomes training data for the next Adapter.
      assert.equal(isTrajectoryEligible(outcome), false, `${outcome} must not be eligible`);
    }
  });
});

describe('edge 20d — an external termination IGNORES the self-report', () => {
  const earlierSuccess = { success: true, summary: 'I finished earlier' };

  test('budget exhaustion beats an earlier finish(success: true)', () => {
    const result = resolveOutcome({ kind: 'budget_exhausted', budget: 'max_steps' }, earlierSuccess);
    // The acceptance criterion states this exactly: a Run terminated by max_steps records
    // budget_exhausted EVEN THOUGH its agent called finish(success: true) on a prior Turn.
    assert.equal(result.outcome, 'budget_exhausted');
    assert.equal(result.budgetHit, 'max_steps');
  });

  test('cancellation beats it', () => {
    assert.equal(resolveOutcome({ kind: 'cancelled' }, earlierSuccess).outcome, 'cancelled');
  });

  test('no-progress beats it', () => {
    assert.equal(resolveOutcome({ kind: 'no_progress' }, earlierSuccess).outcome, 'no_progress');
  });

  test('an infrastructure fault beats it, and is `failed`', () => {
    const result = resolveOutcome({ kind: 'fault', error: 'model server unreachable' }, earlierSuccess);
    assert.equal(result.outcome, 'failed');
    assert.match(result.error ?? '', /unreachable/);
  });

  test('all six terminal outcomes are reachable', () => {
    const reached = new Set([
      resolveOutcome({ kind: 'finish', success: true, summary: '' }).outcome,
      resolveOutcome({ kind: 'finish', success: false, summary: '' }).outcome,
      resolveOutcome({ kind: 'budget_exhausted', budget: 'max_steps' }).outcome,
      resolveOutcome({ kind: 'cancelled' }).outcome,
      resolveOutcome({ kind: 'no_progress' }).outcome,
      resolveOutcome({ kind: 'fault', error: 'x' }).outcome,
    ]);
    assert.equal(reached.size, 6);
  });
});

describe('INVARIANT 6 — budgets are checked BEFORE, so they cannot be exceeded', () => {
  test('max_steps: 3 permits exactly three Steps and refuses the fourth', () => {
    const tracker = new BudgetTracker(BUDGETS);

    for (let i = 0; i < 3; i++) {
      assert.equal(tracker.canStartStep().ok, true, `Step ${i + 1} must be permitted`);
      tracker.recordStep();
    }

    const refused = tracker.canStartStep();
    // Checked BEFORE the Step, so the fourth never runs — rather than running and then
    // being noticed, which for max_model_tokens is the difference between refusing a Step
    // and paying for one.
    assert.equal(refused.ok, false);
    assert.equal(refused.budget, 'max_steps');
  });

  test('max_tool_calls bounds dispatches independently of Steps', () => {
    const tracker = new BudgetTracker(BUDGETS);
    // One Step may dispatch several tools concurrently, so the tool budget cannot be
    // derived from the step budget.
    for (let i = 0; i < 5; i++) {
      assert.equal(tracker.canDispatchTool().ok, true);
      tracker.recordToolCall();
    }
    assert.equal(tracker.canDispatchTool().budget, 'max_tool_calls');
  });

  test('max_model_tokens refuses the next Step once spent', () => {
    const tracker = new BudgetTracker(BUDGETS);
    tracker.recordModelTokens(600, 500);
    assert.equal(tracker.canStartStep().budget, 'max_model_tokens');
  });

  test('R22 — QUEUE TIME IS NOT CHARGED TO WALL CLOCK', () => {
    let clock = 0;
    const tracker = new BudgetTracker({ ...BUDGETS, max_wall_clock_seconds: 10 }, () => clock, 0);

    clock = 30_000;              // 30s elapsed…
    tracker.recordQueuedMs(25_000); // …of which 25s was spent waiting for a scheduler slot

    // 5s of actual work against a 10s budget. Charging queue time would fail this Run for
    // a reason that has nothing to do with the Run — a busy host, not a slow agent.
    assert.equal(tracker.canStartStep().ok, true);
    assert.equal(tracker.snapshot().wallClockMsUsed, 5_000);
    assert.equal(tracker.snapshot().queuedMsTotal, 25_000);
  });

  test('wall clock refuses a Step once genuinely exceeded', () => {
    let clock = 0;
    const tracker = new BudgetTracker({ ...BUDGETS, max_wall_clock_seconds: 10 }, () => clock, 0);
    clock = 11_000;
    assert.equal(tracker.canStartStep().budget, 'max_wall_clock_seconds');
  });
});

describe('R31a / edge 28 — a pinned snapshot is clamped to current ceilings', () => {
  test('an above-ceiling budget is clamped, naming requested and ceiling', () => {
    const { budgets, clamped } = clampToCeilings(
      { ...BUDGETS, max_steps: 500 },
      { max_steps: 200 },
    );

    assert.equal(budgets.max_steps, 200);
    assert.deepEqual(clamped, [{ budget: 'max_steps', requested: 500, ceiling: 200 }]);
    // Agent Definition rejects this at SAVE time — but a snapshot is PINNED, and a ceiling
    // lowered afterwards cannot re-validate a save that already happened.
  });

  test('the Run PROCEEDS under the clamped value rather than failing', () => {
    const { budgets } = clampToCeilings({ ...BUDGETS, max_steps: 500 }, { max_steps: 200 });
    const tracker = new BudgetTracker(budgets);
    assert.equal(tracker.canStartStep().ok, true);
    // An operator who lowered a ceiling wants subsequent Runs bounded, not an Agent that
    // stops working with no explanation.
  });

  test('a within-ceiling budget is untouched and reports no clamp', () => {
    const { budgets, clamped } = clampToCeilings(BUDGETS, { max_steps: 200 });
    assert.deepEqual(clamped, []);
    assert.equal(budgets.max_steps, 3);
  });

  test('every over-ceiling budget is reported, not just the first', () => {
    const { clamped } = clampToCeilings(
      { max_steps: 500, max_model_tokens: 9e9, max_wall_clock_seconds: 99999, max_tool_calls: 5 },
      { max_steps: 200, max_model_tokens: 2e6, max_wall_clock_seconds: 14400, max_tool_calls: 600 },
    );
    assert.equal(clamped.length, 3);
  });
});

describe('R33 — the no-progress detector', () => {
  const call = (name: string, args: unknown) => ({ kind: 'tool_calls' as const, calls: [{ name, args }] });

  test('terminates on the threshold-th consecutive identical Step', () => {
    const detector = new NoProgressDetector(3);
    assert.equal(detector.record(call('shell', { command: 'ls' })), false);
    assert.equal(detector.record(call('shell', { command: 'ls' })), false);
    // Exactly three identical Steps, per the acceptance criterion.
    assert.equal(detector.record(call('shell', { command: 'ls' })), true);
  });

  test('a DIFFERENT step resets the streak', () => {
    const detector = new NoProgressDetector(3);
    detector.record(call('shell', { command: 'ls' }));
    detector.record(call('shell', { command: 'ls' }));
    detector.record(call('shell', { command: 'pwd' }));
    assert.equal(detector.record(call('shell', { command: 'ls' })), false);
  });

  test('different ARGUMENTS to the same tool are progress', () => {
    const detector = new NoProgressDetector(2);
    detector.record(call('read_file', { path: '/a' }));
    assert.equal(detector.record(call('read_file', { path: '/b' })), false);
  });

  test('REORDERED JSON KEYS still count as identical', () => {
    const detector = new NoProgressDetector(2);
    detector.record(call('shell', { command: 'ls', timeout_seconds: 5 }));
    // Models reorder their JSON. Without stable serialization a stuck model would defeat
    // the detector while making no progress at all.
    assert.equal(detector.record(call('shell', { timeout_seconds: 5, command: 'ls' })), true);
  });

  test('R33a — in Code mode it compares the generated program source', () => {
    const detector = new NoProgressDetector(2);
    const program = { kind: 'program' as const, source: 'await shell("ls");' };
    detector.record(program);
    assert.equal(detector.record({ ...program }), true);
  });

  test('a program and a tool call are never confused for one another', () => {
    assert.notEqual(
      signatureOf({ kind: 'program', source: 'x' }),
      signatureOf({ kind: 'tool_calls', calls: [{ name: 'x', args: {} }] }),
    );
  });

  test('nested argument objects compare structurally, not by key order', () => {
    const a = signatureOf(call('t', { outer: { b: 2, a: 1 }, list: [1, { y: 2, x: 1 }] }));
    const b = signatureOf(call('t', { list: [1, { x: 1, y: 2 }], outer: { a: 1, b: 2 } }));
    assert.equal(a, b);
  });
});
