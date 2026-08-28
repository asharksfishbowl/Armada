/**
 * The version pin badge — design-dashboard.md Requirements 106, 106a, and edge case 21.
 *
 * The badge exists to make cross-cutting invariant 2 legible: a run executed against a
 * pinned snapshot, and editing the agent afterwards never changes what ran.
 *
 * ONE OF THESE ASSERTIONS IS A PROHIBITION, and it is the reason this logic is a pure
 * function rather than a ternary inside a component. Requirement 106a: a run whose agent
 * was soft-deleted renders `v?` and "MUST NOT render `↑0`, which would assert that the run
 * is current — precisely the invariant-2 misreading the badge exists to prevent."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PIN_BORDER, derivePin } from '../lib/version-pin';

test('a run on the agent’s current version renders v{n} with no annotation', () => {
  const pin = derivePin({ executedVersion: 3, currentVersion: 3 });
  assert.equal(pin.variant, 'current');
  assert.equal(pin.text, 'v3');
  assert.equal(pin.delta, undefined);
  assert.equal(PIN_BORDER.current, '--line-strong');
});

test('a run behind the current version renders v1 ↑2 in amber (edge case 21)', () => {
  const pin = derivePin({ executedVersion: 1, currentVersion: 3 });
  assert.equal(pin.variant, 'behind');
  assert.equal(pin.text, 'v1 ↑2');
  assert.equal(pin.delta, 2);
  assert.equal(PIN_BORDER.behind, '--status-warn');
  // The tooltip must state the invariant in words, not just the numbers.
  assert.match(pin.tooltip, /never affects a run/i);
});

test('a deleted agent renders v? and NEVER ↑0 (Requirement 106a)', () => {
  const pin = derivePin({ executedVersion: 7, currentVersion: undefined });
  assert.equal(pin.variant, 'deleted');
  assert.equal(pin.text, 'v?');
  assert.equal(pin.delta, undefined);
  assert.equal(PIN_BORDER.deleted, '--status-neutral');

  // The prohibition, asserted directly. `↑0` would assert the run is current, which is
  // exactly the invariant-2 misreading the badge exists to prevent.
  assert.ok(!pin.text.includes('↑'), 'a deleted-agent badge must carry no delta at all');
  assert.match(pin.tooltip, /deleted/i);
  assert.match(pin.tooltip, /retained/i);
});

test('no input produces an "↑0" badge', () => {
  // Swept rather than spot-checked: the string must be unreachable for EVERY combination,
  // not just for the deleted case that motivated the rule.
  for (let executed = 1; executed <= 5; executed += 1) {
    for (const current of [undefined, 1, 2, 3, 4, 5]) {
      const pin = derivePin({ executedVersion: executed, currentVersion: current });
      assert.ok(
        !pin.text.includes('↑0'),
        `derivePin({executed: ${executed}, current: ${String(current)}}) produced ${pin.text}`,
      );
    }
  }
});

test('a run ahead of the list’s current version reads as current, not as a negative delta', () => {
  // Only reachable when a read races a save. `↑-1` would be nonsense and `behind` would be
  // false; `current` is the only honest reading of "this run is not behind anything".
  const pin = derivePin({ executedVersion: 4, currentVersion: 3 });
  assert.equal(pin.variant, 'current');
  assert.equal(pin.text, 'v4');
  assert.ok(!pin.text.includes('↑'));
});
