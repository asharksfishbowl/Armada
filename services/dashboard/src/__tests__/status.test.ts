/**
 * P9 EXIT CRITERION 2 — "the desaturation test passes per-family."
 *
 * design-dashboard.md Requirement 141: "The design does not rely on colour: no two states
 * within one family are distinguishable by colour alone." Requirement 142b: the test
 * "asserts PER-FAMILY distinguishability, not global uniqueness. A test asserting global
 * uniqueness would fail on a property the design deliberately wants."
 *
 * The deliberate property is Requirement 142a's two cross-family identities:
 *   `incomplete` (run) and `rejected` (adapter)          -> both --status-neutral `●`
 *   `cancelled` (run), `retired` (binding), queued deleg -> all --status-neutral `○`
 * Each pair means the same thing under Requirement 31a and appears in a different table,
 * so reading one as the other produces no wrong conclusion.
 *
 * HOW THIS TEST IS CONSTRUCTED SO IT CANNOT TRIVIALLY PASS. Asserting only "the three
 * channels together are unique" would pass on any table at all, because labels are unique
 * by construction. So it does two things instead:
 *   1. It first PROVES the collision is real — it desaturates the hues out of tokens.css
 *      and asserts the greys actually do collapse, exactly as Requirement 141 predicts.
 *   2. It then asserts every within-family pair is separated with the hue DISCARDED, by
 *      (mark, label) alone. That is what "does not rely on colour" means operationally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceFile } from './source-root';

import { greyscale, parseHexTokens } from '../lib/color';
import {
  ADAPTER_STATUS,
  BINDING_STATUS,
  HEALTH_STATUS,
  RUN_STATUS,
  STATUS_FAMILIES,
  runChipLabel,
  runState,
  type StatusRendering,
} from '../lib/status';

const tokens = parseHexTokens(
  readFileSync(sourceFile('styles', 'tokens.css'), 'utf8'),
);

function grey(token: string): number {
  const hex = tokens.get(token);
  assert.ok(hex, `styles/tokens.css does not define ${token}, but the vocabulary names it`);
  return greyscale(hex);
}

test('every hue named by the vocabulary exists in tokens.css', () => {
  // The vocabulary stores token NAMES, never hexes. That is only safe if the names
  // resolve — a typo would otherwise render an unstyled mark and no test would notice.
  const all: StatusRendering[] = [
    ...Object.values(RUN_STATUS),
    ...Object.values(ADAPTER_STATUS),
    ...Object.values(BINDING_STATUS),
    ...Object.values(HEALTH_STATUS),
  ];
  for (const entry of all) {
    assert.ok(tokens.has(entry.hue), `${entry.label} names ${entry.hue}, which is not a token`);
  }
});

test('desaturated, the hues really do collapse (Requirement 141 is not hypothetical)', () => {
  // R141: "Desaturated, --status-good and --status-warn collapse together at high
  // luminance, and --status-fault, --status-pending, --status-neutral, and --accent
  // collapse together at mid luminance."
  //
  // This is the control for the assertion below it. If the hues did NOT collapse, the
  // per-family test would be passing for the wrong reason.
  const highPair = Math.abs(grey('--status-good') - grey('--status-warn'));
  assert.ok(
    highPair < 0.05,
    `--status-good and --status-warn should collapse in greyscale; they differ by ${highPair.toFixed(3)}`,
  );

  const mid = ['--status-fault', '--status-pending', '--status-neutral', '--accent'].map(grey);
  const spread = Math.max(...mid) - Math.min(...mid);
  assert.ok(
    spread < 0.12,
    `the mid-luminance group should collapse in greyscale; spread is ${spread.toFixed(3)}`,
  );
});

test('per-family: no two states need colour to be told apart (Requirements 141, 142b)', () => {
  for (const [family, table] of Object.entries(STATUS_FAMILIES)) {
    const states = Object.entries(table);
    for (let i = 0; i < states.length; i += 1) {
      for (let j = i + 1; j < states.length; j += 1) {
        const [nameA, a] = states[i] as [string, StatusRendering];
        const [nameB, b] = states[j] as [string, StatusRendering];

        // Hue is DISCARDED. Only shape and words remain.
        const identical = a.mark === b.mark && a.label === b.label;
        assert.ok(
          !identical,
          `${family}: '${nameA}' and '${nameB}' render identically once colour is removed ` +
            `(both ${a.mark} labelled "${a.label}"). Requirement 141 forbids this within a family.`,
        );
      }
    }
  }
});

test('the residual within-family greyscale collisions are the ones R142 and R32a name', () => {
  // R142 names exactly one residual collision in the run family: budget_exhausted
  // (--status-warn ○) against cancelled (--status-neutral ○), "resolved by the slash on
  // the cancelled mark and by the mandatory text label".
  assert.equal(RUN_STATUS.budget_exhausted.mark, 'disc-hollow');
  assert.equal(RUN_STATUS.cancelled.mark, 'disc-slashed', 'the slash is what resolves R142');

  // R32a.3: budget_exhausted and no_progress DO share a hue and a mark. That is legal
  // only because a shared pair is always resolved in words.
  assert.equal(RUN_STATUS.budget_exhausted.hue, RUN_STATUS.no_progress.hue);
  assert.equal(RUN_STATUS.budget_exhausted.mark, RUN_STATUS.no_progress.mark);
  assert.notEqual(
    RUN_STATUS.budget_exhausted.label,
    RUN_STATUS.no_progress.label,
    'a shared (hue, mark) pair is resolved in words or it is not resolved at all',
  );
});

test('Requirement 142a cross-family identities are preserved, not "fixed"', () => {
  // These are INTENTIONAL and must not be treated as defects. A future contributor
  // tidying them into uniqueness would break the design's own stated claim, so the
  // identity is asserted rather than merely tolerated.
  assert.equal(RUN_STATUS.incomplete.hue, ADAPTER_STATUS.rejected.hue);
  assert.equal(RUN_STATUS.incomplete.mark, ADAPTER_STATUS.rejected.mark);

  assert.equal(RUN_STATUS.cancelled.hue, BINDING_STATUS.retired.hue);
});

test('fill carries the meaning Requirement 19 assigns it', () => {
  // A verdict exists -> filled. Stopped before one -> hollow. Pending -> half.
  // Requirements 23, 24: `incomplete` is a verdict (finish(success:false)) so it is
  // FILLED and NEUTRAL, not fault. `budget_exhausted`/`no_progress` are the harness
  // stopping the run before any self-report, so they are HOLLOW.
  assert.equal(RUN_STATUS.incomplete.mark, 'disc-filled');
  assert.equal(RUN_STATUS.incomplete.hue, '--status-neutral');
  assert.notEqual(RUN_STATUS.incomplete.hue, '--status-fault');
  assert.equal(RUN_STATUS.budget_exhausted.mark, 'disc-hollow');
  assert.equal(RUN_STATUS.no_progress.mark, 'disc-hollow');

  // R27: pending_eval must not share a hue OR a mark with rejected.
  assert.notEqual(ADAPTER_STATUS.pending_eval.hue, ADAPTER_STATUS.rejected.hue);
  assert.notEqual(ADAPTER_STATUS.pending_eval.mark, ADAPTER_STATUS.rejected.mark);
  assert.notEqual(ADAPTER_STATUS.rejected.hue, '--status-fault');
});

test('running is the only rotating state (Requirement 22)', () => {
  const rotating = [
    ...Object.entries(RUN_STATUS),
    ...Object.entries(ADAPTER_STATUS),
    ...Object.entries(BINDING_STATUS),
    ...Object.entries(HEALTH_STATUS),
  ].filter(([, entry]) => entry.rotating);
  assert.deepEqual(
    rotating.map(([name]) => name),
    ['running'],
    'Requirement 22: the rotating half-disc on a running entity is the ONLY rotating element',
  );
});

test('every status rendering carries a label (Requirement 32 — no bare marks)', () => {
  for (const table of [RUN_STATUS, ADAPTER_STATUS, BINDING_STATUS, HEALTH_STATUS]) {
    for (const [name, entry] of Object.entries(table)) {
      assert.ok(entry.label.length > 0, `${name} has no label; there is no bare mark (R32)`);
    }
  }
});

test('the mandatory qualifier is appended only where Requirement 25 requires it', () => {
  assert.equal(runChipLabel('budget_exhausted', 'max_steps'), 'BUDGET · max_steps');
  assert.equal(runChipLabel('no_progress', 'shell ×3'), 'NO PROGRESS · shell ×3');
  // Not a tooltip and not optional — but a missing cause must not render a dangling
  // separator either.
  assert.equal(runChipLabel('budget_exhausted', null), 'BUDGET');
  // Every other state takes no qualifier even if one is supplied.
  assert.equal(runChipLabel('success', 'ignored'), 'SUCCESS');
  assert.equal(runChipLabel('cancelled', 'ignored'), 'CANCELLED');
});

test('runState derives the chip from REST, and never infers success', () => {
  // Invariant 1: success is self-reported. Only an explicit success outcome yields it.
  assert.equal(runState({ status: 'running', outcome: null }), 'running');
  assert.equal(runState({ status: 'terminal', outcome: 'success' }), 'success');
  assert.equal(runState({ status: 'terminal', outcome: 'incomplete' }), 'incomplete');
  // A terminal run with no outcome violates the schema CHECK. It is a fault, not a
  // success and not an `incomplete` — nothing may infer an outcome that was never decided.
  assert.equal(runState({ status: 'terminal', outcome: null }), 'failed');
});

test('the health strip reuses the locked marks and introduces none (Requirement 35b)', () => {
  const marks = Object.values(HEALTH_STATUS).map((entry) => entry.mark);
  assert.deepEqual(marks, ['disc-filled', 'triangle', 'ring-dotted']);
  // `unknown` must be distinct from `unreachable`: the daemon reports peers as unknown
  // until its first probe completes, and rendering that as a fault would flash two false
  // alarms on every dashboard load.
  assert.notEqual(HEALTH_STATUS.unknown.mark, HEALTH_STATUS.unreachable.mark);
  assert.notEqual(HEALTH_STATUS.unknown.hue, HEALTH_STATUS.unreachable.hue);
});
