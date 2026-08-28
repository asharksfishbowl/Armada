/**
 * P9 EXIT CRITERION 1 — "the automated token contrast test passes."
 *
 * design-dashboard.md Requirement 139 is unusual in that it states the test IS the
 * requirement: every status hue must meet >= 4.5:1 against BOTH --surface-2 and
 * --surface-3, "asserted by an automated token test at build time", and the spec's own
 * measured table is marked informative. So nothing here is copied from the spec — the
 * hexes are read out of styles/tokens.css and the ratios are recomputed. Change a token to
 * a value that does not clear the floor and `npm test` goes red, which is the entire point.
 *
 * Requirement 139a flags --accent on --surface-3 at 4.97:1 as the tightest margin in the
 * system, 0.47 of headroom, and the token most likely to fail this test under any future
 * change. That is asserted explicitly below so a regression names itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceFile } from './source-root';

import { contrastRatio, parseHex, parseHexTokens } from '../lib/color';

const TOKENS_CSS = sourceFile('styles', 'tokens.css');
const tokens = parseHexTokens(readFileSync(TOKENS_CSS, 'utf8'));

/** Requirement 139's floor. */
const FLOOR = 4.5;

/** The grounds a status hue is measured against. Requirement 32c scopes the floor to
 *  FOREGROUND use, which is what a contrast ratio measures — and --surface-2 (table body)
 *  and --surface-3 (row hover) are the two surfaces a status mark or label sits on. */
const GROUNDS = ['--surface-2', '--surface-3'] as const;

/** The six status hues of Requirement 32d plus --accent, which Requirement 139a singles
 *  out. --fg and --fg-muted are included because they carry values an operator must read;
 *  --fg-dim deliberately is NOT — see the separate test below. */
const MEANING_BEARING = [
  '--fg',
  '--fg-muted',
  '--accent',
  '--status-live',
  '--status-good',
  '--status-neutral',
  '--status-warn',
  '--status-fault',
  '--status-pending',
] as const;

function hexOf(name: string): string {
  const value = tokens.get(name);
  assert.ok(value, `tokens.css does not define ${name}`);
  return value;
}

function ratio(fg: string, bg: string): number {
  return contrastRatio(parseHex(hexOf(fg)), parseHex(hexOf(bg)));
}

test('tokens.css defines exactly the token set the acceptance criteria enumerate', () => {
  // "A stylesheet or token module defines exactly five surface tokens, three foreground
  // tokens, one accent token with hover and wash, six status hue tokens..."
  const named = (prefix: string) =>
    [...tokens.keys()].filter((k) => k.startsWith(prefix)).sort();

  assert.deepEqual(named('--surface-'), [
    '--surface-0',
    '--surface-1',
    '--surface-2',
    '--surface-3',
    '--surface-4',
  ]);
  assert.deepEqual(named('--fg'), ['--fg', '--fg-dim', '--fg-muted']);
  assert.equal(
    [...tokens.keys()].filter((k) => k.startsWith('--status-')).length,
    6,
    'exactly six status hues (Requirement 32d). A seventh is a change to three requirements.',
  );
  // Requirement 23a — there is no --status-muted. `incomplete`, `cancelled`, and
  // `rejected` share --status-neutral and are separated by fill and label alone.
  assert.equal(tokens.has('--status-muted'), false, '--status-muted must not exist (R23a)');
});

test('every meaning-bearing token clears 4.5:1 on both oak grounds (Requirement 139)', () => {
  const failures: string[] = [];
  for (const token of MEANING_BEARING) {
    for (const ground of GROUNDS) {
      const measured = ratio(token, ground);
      if (measured < FLOOR) {
        failures.push(`${token} on ${ground} = ${measured.toFixed(2)}:1 (floor ${FLOOR})`);
      }
    }
  }
  assert.deepEqual(failures, [], `contrast floor breached:\n  ${failures.join('\n  ')}`);
});

test('--accent on --surface-3 is the tightest margin and still clears (Requirement 139a)', () => {
  const measured = ratio('--accent', '--surface-3');
  assert.ok(measured >= FLOOR, `--accent on --surface-3 = ${measured.toFixed(2)}:1`);

  // It is the tightest of the whole meaning-bearing set, on either ground. Asserted rather
  // than trusted, because 139a's warning is only useful if it stays true.
  const others = MEANING_BEARING.filter((t) => t !== '--accent').flatMap((t) =>
    GROUNDS.map((g) => ratio(t, g)),
  );
  assert.ok(
    others.every((r) => r > measured),
    'Requirement 139a says --accent on --surface-3 is the tightest margin in the system. ' +
      'It no longer is, so 139a is now describing the wrong token.',
  );
});

test('--fg-dim is below the floor, which is why Requirement 140 restricts it', () => {
  // Not a defect — a guard. Requirement 140 confines --fg-dim to non-essential text
  // precisely BECAUSE it measures below 4.5:1. If someone "fixes" it by lightening the
  // value, Requirement 140's restriction silently becomes unmotivated, and the next
  // reader will lift it. This test fails on that change and says so.
  for (const ground of GROUNDS) {
    const measured = ratio('--fg-dim', ground);
    assert.ok(
      measured < FLOOR,
      `--fg-dim on ${ground} now measures ${measured.toFixed(2)}:1, above the 4.5:1 floor. ` +
        'Requirement 140 restricts --fg-dim to non-essential text BECAUSE it is below the ' +
        'floor. Raising it above without amending R140 leaves a restriction with no reason.',
    );
  }
});

test('--accent and --status-live are different values and neither is set from the other', () => {
  // Requirement 4, and an explicit acceptance criterion. The accent signals operator
  // intent; --status-live signals machine activity. Collapsing them would make "this row
  // is selected" and "this run is executing" the same colour.
  assert.notEqual(hexOf('--accent'), hexOf('--status-live'));
});

test('the accent is not brass-adjacent (Requirement 3b, ruled out permanently)', () => {
  // R3b rules brass out as the accent with a specific measurement: #C9A227 sits 6 degrees
  // from --status-warn, where --accent sits 179 degrees away. Brass would render "this row
  // is selected" and "the harness intervened" in effectively the same colour.
  //
  // THE ASSERTION IS SCOPED TO --status-warn ON PURPOSE, and this is worth stating because
  // the obvious stronger test is wrong. Asserting separation from EVERY status hue fails
  // on the shipped palette: --accent #4C8DFF and --status-pending #A78BFA are only ~39
  // degrees apart, and --status-live is nearer still. That is not a defect. R4's guarantee
  // is not hue distance from all six — it is that the accent is never confused with a
  // status hue, which Requirement 5 delivers structurally by confining the accent to four
  // elements (primary buttons, focus ring, active nav item, selected-row edge), none of
  // which is a status readout. Requirement 32's mandatory mark-plus-label does the rest.
  // A test asserting 60-degree global separation would be asserting a rule the design
  // does not make, and would fail on a palette the design explicitly accepts.
  const hue = (hex: string): number => {
    const { r, g, b } = parseHex(hex);
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    if (max === min) return 0;
    const d = max - min;
    let h: number;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  const separation = (a: number, b: number) => {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  };

  const accentHue = hue(hexOf('--accent'));
  const fromWarn = separation(accentHue, hue(hexOf('--status-warn')));
  assert.ok(
    fromWarn > 90,
    `--accent is ${fromWarn.toFixed(0)} degrees from --status-warn. R3b rejects an accent ` +
      'near the amber that means "the harness intervened"; brass failed at 6 degrees.',
  );

  // Brass survives as structural chrome only, in --line-strong, which Requirement 32b
  // permits because chrome is not status. Asserted so that "brass is ruled out" is not
  // mistaken for "brass appears nowhere".
  assert.equal(hexOf('--line-strong'), '#5A4128');
});
