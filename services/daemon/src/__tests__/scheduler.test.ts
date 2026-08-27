/**
 * P7 — model request scheduling and pinned-binding liveness.
 *
 * Agent Runtime R20-R22, R17-R18b; D5; build-plan Req 9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ModelScheduler } from '../models/scheduler.js';
import { verifyPinnedBinding, type LiveBinding, type PinnedBinding } from '../models/binding-verifier.js';

const PINNED: PinnedBinding = {
  binding_tag: 'armada/qwen3-0.6b-base',
  context_window: 32768,
  tool_format: 'hermes',
};

const live = (over: Partial<LiveBinding> = {}): LiveBinding => ({
  tag: PINNED.binding_tag,
  status: 'promoted',
  materialized: true,
  materialization_status: 'present',
  ...over,
});

describe('R20-R22 — concurrency limits and queue accounting', () => {
  test('a request within the limits is admitted immediately with ZERO queue time', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 2 });
    const admission = await scheduler.acquire('tag-a');
    // An idle host must not report a small non-zero wait.
    assert.equal(admission.queuedMs, 0);
    admission.release();
  });

  test('with max_concurrent_per_tag: 1 the SECOND request waits and records queued_ms', async () => {
    let clock = 0;
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 4 }, () => clock);

    const first = await scheduler.acquire('tag-a');
    let secondAdmission: { queuedMs: number; release: () => void } | null = null;
    const second = scheduler.acquire('tag-a').then((a) => (secondAdmission = a));

    await new Promise((r) => setImmediate(r));
    assert.equal(secondAdmission, null, 'the second must still be waiting');

    clock = 250;
    first.release();
    await second;

    // R22 — recorded on the model_request Event, and NOT charged to the Run's wall clock.
    assert.equal(secondAdmission!.queuedMs, 250);
    secondAdmission!.release();
  });

  test('a different tag is not blocked by a busy one', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 4 });
    const a = await scheduler.acquire('tag-a');
    const b = await scheduler.acquire('tag-b');
    assert.equal(b.queuedMs, 0);
    a.release();
    b.release();
  });

  test('the GLOBAL limit blocks even across different tags', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 5, maxConcurrentTotal: 2 });
    const a = await scheduler.acquire('tag-a');
    const b = await scheduler.acquire('tag-b');

    let third = false;
    void scheduler.acquire('tag-c').then(() => (third = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(third, false);

    a.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(third, true, 'releasing a slot admits the waiter');
    b.release();
  });

  test('ADMISSION IS EVENT-DRIVEN — a release admits the next waiter directly', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 1 });
    const first = await scheduler.acquire('t');

    let admitted = false;
    const waiting = scheduler.acquire('t').then((a) => {
      admitted = true;
      return a;
    });

    first.release();
    // One microtask turn, no timer. A poll would add latency proportional to its interval.
    await new Promise((r) => setImmediate(r));
    assert.equal(admitted, true);
    (await waiting).release();
  });
});

describe('D5 — FIFO WITHIN PRIORITY CLASS', () => {
  test('within one class, admission is strictly first-come-first-served', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 1 });
    const held = await scheduler.acquire('t');

    const order: string[] = [];
    const first = scheduler.acquire('t').then((a) => { order.push('first'); return a; });
    await new Promise((r) => setImmediate(r));
    const second = scheduler.acquire('t').then((a) => { order.push('second'); return a; });
    await new Promise((r) => setImmediate(r));

    held.release();
    (await first).release();
    await new Promise((r) => setImmediate(r));
    (await second).release();

    assert.deepEqual(order, ['first', 'second']);
  });

  test('a MANAGER request is admitted ahead of an earlier default one', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 1 });
    const held = await scheduler.acquire('t');

    const order: string[] = [];
    // The worker queues FIRST — strict FIFO would admit it first.
    const worker = scheduler.acquire('t', 'default').then((a) => { order.push('worker'); return a; });
    await new Promise((r) => setImmediate(r));
    const manager = scheduler.acquire('t', 'manager').then((a) => { order.push('manager'); return a; });
    await new Promise((r) => setImmediate(r));

    held.release();
    (await manager).release();
    await new Promise((r) => setImmediate(r));
    (await worker).release();

    // Team R32 — a manager waiting to synthesize must not be starved behind its workers.
    assert.deepEqual(order, ['manager', 'worker']);
  });

  test('priority does not break FIFO among managers', async () => {
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 1 });
    const held = await scheduler.acquire('t');

    const order: string[] = [];
    const m1 = scheduler.acquire('t', 'manager').then((a) => { order.push('m1'); return a; });
    await new Promise((r) => setImmediate(r));
    const m2 = scheduler.acquire('t', 'manager').then((a) => { order.push('m2'); return a; });
    await new Promise((r) => setImmediate(r));

    held.release();
    (await m1).release();
    await new Promise((r) => setImmediate(r));
    (await m2).release();

    assert.deepEqual(order, ['m1', 'm2']);
  });
});

describe('R17-R18b — pinned binding liveness, never re-resolution', () => {
  test('a promoted, materialized binding passes', () => {
    assert.deepEqual(verifyPinnedBinding(PINNED, [live()]), { ok: true });
  });

  test('an ABSENT tag fails, pointing at refresh-bindings', () => {
    const result = verifyPinnedBinding(PINNED, []);
    assert.equal(result.ok, false);
    // Adopting a different binding is a deliberate, auditable act (R17a) — not something
    // the Run does for the operator.
    assert.match((result as { error: string }).error, /refresh-bindings/);
  });

  test('a RETIRED binding fails, naming the status and its cause', () => {
    const result = verifyPinnedBinding(PINNED, [live({ status: 'retired' })]);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /retired/);
    assert.match((result as { error: string }).error, /base-models\.yaml/);
  });

  test('a MISSING binding fails, naming a different cause than retired', () => {
    const result = verifyPinnedBinding(PINNED, [live({ status: 'missing' })]);
    // `retired` means an operator removed a shortlist entry; `missing` means armada-models
    // lost a model the database still believes is promoted. Different fixes.
    assert.match((result as { error: string }).error, /armada-models no longer reports/);
  });

  test('D4 / R18b — PROMOTED BUT UNMATERIALIZED FAILS, naming the materialize call', () => {
    const result = verifyPinnedBinding(
      PINNED,
      [live({ materialized: false, materialization_status: 'absent' })],
    );

    assert.equal(result.ok, false);
    const error = (result as { error: string }).error;
    // The fail-fast that keeps a Run from blocking behind a multi-gigabyte transfer. The
    // operator is told the tag AND the exact action that fixes it.
    assert.match(error, /armada\/qwen3-0\.6b-base/);
    assert.match(error, /materialize/);
    assert.match(error, /not materialized/i);
  });

  test('it verifies the PINNED tag and never picks a newer binding', () => {
    const newerAdapter: LiveBinding = {
      tag: 'armada/qwen3-0.6b-docs-v3',
      status: 'promoted',
      materialized: true,
      materialization_status: 'present',
    };
    // Only the newer adapter is live; the pinned tag is gone.
    const result = verifyPinnedBinding(PINNED, [newerAdapter]);
    // Invariant 2 — a newly promoted Adapter must NOT silently change an existing Agent's
    // behaviour. This is a liveness check, not a resolution.
    assert.equal(result.ok, false);
  });
});
