/**
 * P8 — tree budget accounting. Team Orchestration R25, R26, R28, R34.
 *
 * INVARIANT 6 ACROSS A TREE. The clock is injected, so nothing here waits: a test that
 * proved a wall-clock budget by sleeping would be an arbitrary delay, and it would prove
 * the sleep rather than the budget.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TreeAccountant } from '../teams/tree-budget.js';

const BUDGETS = { tree_max_wall_clock_seconds: 60, tree_max_model_tokens: 1000 };

describe('R25 — consumption is accounted across the whole tree', () => {
  test('several Runs reporting separately share ONE budget', () => {
    const tree = new TreeAccountant(BUDGETS);
    // Three "children", none of which would exhaust a per-Run budget of 1000 alone.
    tree.recordModelTokens(300, 0);
    tree.recordModelTokens(300, 0);
    assert.equal(tree.check().ok, true, '600 of 1000 is still admissible');
    tree.recordModelTokens(300, 100);
    assert.equal(tree.check().ok, false, 'the tree sees what no single Run could');
  });

  test('the budget names itself when it trips (R26)', () => {
    const tree = new TreeAccountant(BUDGETS);
    tree.recordModelTokens(1000, 0);
    const check = tree.check();
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.equal(check.budget, 'tree_max_model_tokens');
  });
});

describe('R26 — exhaustion fires the cascade exactly once', () => {
  test('a listener registered before exhaustion is called once, on the crossing', () => {
    const tree = new TreeAccountant(BUDGETS);
    const fired: string[] = [];
    tree.onExhausted((b) => fired.push(b));

    tree.recordModelTokens(500, 0);
    assert.deepEqual(fired, [], 'not yet');

    tree.recordModelTokens(500, 0);
    assert.deepEqual(fired, ['tree_max_model_tokens']);

    // Further reports and further checks must NOT re-fire: the listener cancels in-flight
    // children, and a cascade that fired twice would try to cancel Runs it already ended.
    tree.recordModelTokens(500, 0);
    tree.check();
    assert.deepEqual(fired, ['tree_max_model_tokens']);
  });

  test('a listener registered AFTER exhaustion still learns, immediately', () => {
    const tree = new TreeAccountant(BUDGETS);
    tree.recordModelTokens(2000, 0);
    const fired: string[] = [];
    tree.onExhausted((b) => fired.push(b));
    assert.deepEqual(fired, ['tree_max_model_tokens']);
  });
});

describe('R34 — queue time is charged to neither the child nor the tree', () => {
  test('wall clock excludes queued milliseconds', () => {
    let clock = 0;
    const tree = new TreeAccountant(
      { tree_max_wall_clock_seconds: 10, tree_max_model_tokens: 10_000 },
      () => clock,
      0,
    );

    // 20 seconds elapsed, 15 of which was spent waiting for a scheduler slot.
    clock = 20_000;
    tree.recordQueuedMs(15_000);

    assert.equal(tree.snapshot().wallClockMsUsed, 5_000);
    assert.equal(
      tree.check().ok,
      true,
      // A Run on a busy host must not fail for a reason that has nothing to do with the Run.
      'five seconds of work under a ten second budget is admissible however long it queued',
    );

    clock = 26_000;
    const check = tree.check();
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.equal(check.budget, 'tree_max_wall_clock_seconds');
  });
});

describe('R28 — the pre-delegation check', () => {
  test('check() is pure until it trips, and reports the same budget afterwards', () => {
    const tree = new TreeAccountant(BUDGETS);
    assert.equal(tree.exhaustedBudget, null);
    assert.equal(tree.check().ok, true);
    assert.equal(tree.exhaustedBudget, null, 'a passing check changes nothing');

    tree.recordModelTokens(1000, 0);
    assert.equal(tree.exhaustedBudget, 'tree_max_model_tokens');
    const again = tree.check();
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.budget, 'tree_max_model_tokens');
  });
});
