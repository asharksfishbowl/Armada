/**
 * The status vocabulary — design-dashboard.md Requirements 18-32g.
 *
 * ONE SYSTEM, THREE FAMILIES, THREE INDEPENDENT CHANNELS (Requirement 18):
 *   hue  = valence          (what kind of thing happened)
 *   mark = kind of judgement (who, if anyone, judged)
 *   fill = whether a verdict exists (Requirement 19)
 *
 * This file is a PURE LOOKUP on purpose. It is the single place any surface asks "how do I
 * render this state", and it is the thing the two exit-criteria tests assert against:
 *
 *   - src/__tests__/tokens.test.ts   — Requirement 139, every hue named here clears 4.5:1
 *                                      against --surface-2 and --surface-3.
 *   - src/__tests__/status.test.ts   — Requirement 142b, per-family distinguishability
 *                                      under desaturation.
 *
 * A table can be tested; a `switch` scattered across five components cannot. That is the
 * whole reason the vocabulary is data rather than code.
 *
 * HUES ARE TOKEN NAMES, NEVER HEX. The hexes live in styles/tokens.css and nowhere else.
 * A second copy here would be a second source of truth, and the contrast test would then
 * be guarding a value the browser does not render.
 */

/** Requirement 141 — the six marks. Shape carries the primary distinction, not colour. */
export type StatusMarkKind =
  /** `●` — a verdict exists (Requirement 19). */
  | 'disc-filled'
  /** `○` — the entity was stopped before a verdict could be reached. */
  | 'disc-hollow'
  /** `◐` — a verdict is pending. The only rotating element when live (Requirement 22). */
  | 'disc-half'
  /** `○` with a slash — stopped deliberately. Resolves the greyscale collision of R142. */
  | 'disc-slashed'
  /** `▲` — fault. Carries no fill meaning (Requirement 19). */
  | 'triangle'
  /** `✕` in a square — integrity fault. Requirement 29's `missing`. */
  | 'cross-square'
  /** `◌` — connection unknown. A CONNECTION mark, never an outcome (Requirement 114). */
  | 'ring-dotted';

/** The six status hues of tokens.css. Requirement 32g: normative code names tokens. */
export type StatusHue =
  | '--status-live'
  | '--status-good'
  | '--status-neutral'
  | '--status-warn'
  | '--status-fault'
  | '--status-pending';

export interface StatusRendering {
  hue: StatusHue;
  mark: StatusMarkKind;
  /** Requirement 32: mandatory. There is no bare mark and no chip without a label. */
  label: string;
  /** Requirement 21: `running` rotates. Requirement 22: nothing else ever does. */
  rotating?: true;
}

/** The three families of Requirements 21, 26, and 29. */
export type StatusFamily = 'run' | 'adapter' | 'binding';

/**
 * Requirement 21 — run outcome.
 *
 * `running` is included here rather than kept separate because a run row renders one chip
 * whose value is `status === 'running' ? 'running' : outcome`, and splitting the lookup
 * would put that ternary in every consumer.
 */
export type RunState =
  | 'running'
  | 'success'
  | 'incomplete'
  | 'budget_exhausted'
  | 'no_progress'
  | 'cancelled'
  | 'failed';

export const RUN_STATUS: Readonly<Record<RunState, StatusRendering>> = {
  running: { hue: '--status-live', mark: 'disc-half', label: 'RUNNING', rotating: true },
  success: { hue: '--status-good', mark: 'disc-filled', label: 'SUCCESS' },
  // Requirements 23, 24: FILLED and NEUTRAL, not fault. `finish(success: false)` is a
  // verdict — the agent judged the task and reported it did not achieve it. Rendering a
  // legitimate self-reported negative in the fault colour trains the operator to ignore
  // the fault colour. This is invariant 1, rendered.
  incomplete: { hue: '--status-neutral', mark: 'disc-filled', label: 'INCOMPLETE' },
  // Requirement 23: HOLLOW. The harness stopped the run before any self-report, so no
  // verdict exists to fill the disc.
  budget_exhausted: { hue: '--status-warn', mark: 'disc-hollow', label: 'BUDGET' },
  no_progress: { hue: '--status-warn', mark: 'disc-hollow', label: 'NO PROGRESS' },
  cancelled: { hue: '--status-neutral', mark: 'disc-slashed', label: 'CANCELLED' },
  failed: { hue: '--status-fault', mark: 'triangle', label: 'FAILED' },
};

/** Requirement 26 — adapter status. */
export type AdapterState = 'pending_eval' | 'promoted' | 'rejected';

export const ADAPTER_STATUS: Readonly<Record<AdapterState, StatusRendering>> = {
  // Requirement 27: violet and pending, because R35 states that an absent judgement is
  // not a failing judgement. It must not share a hue or a mark with `rejected`.
  pending_eval: { hue: '--status-pending', mark: 'disc-half', label: 'PENDING EVAL' },
  promoted: { hue: '--status-good', mark: 'disc-filled', label: 'PROMOTED' },
  // Filled and neutral: the gate completed and returned a negative. Deliberately NOT
  // fault — a rejected adapter is the gate working correctly (Requirement 27).
  rejected: { hue: '--status-neutral', mark: 'disc-filled', label: 'REJECTED' },
};

/** Requirement 29 — ModelBinding status. */
export type BindingState = 'promoted' | 'retired' | 'missing';

export const BINDING_STATUS: Readonly<Record<BindingState, StatusRendering>> = {
  promoted: { hue: '--status-good', mark: 'disc-filled', label: 'PROMOTED' },
  retired: { hue: '--status-neutral', mark: 'disc-hollow', label: 'RETIRED' },
  // Requirement 30: the only status in the product that is never an expected state — the
  // database reports the binding promoted while armada-models does not serve it. It is
  // therefore the only status that escalates beyond its own row, to a navigation badge.
  missing: { hue: '--status-fault', mark: 'cross-square', label: 'MISSING' },
};

/**
 * Requirement 25 — the MANDATORY inline qualifier.
 *
 * `budget_exhausted` and `no_progress` share a hue AND a mark, which is legal only because
 * Requirement 32a.3 resolves a shared pair in words. The qualifier is not optional and is
 * not a tooltip, so it is returned by the same function that returns the label rather than
 * left to each caller to remember.
 */
export function runChipLabel(state: RunState, qualifier?: string | null): string {
  const base = RUN_STATUS[state].label;
  const needsQualifier = state === 'budget_exhausted' || state === 'no_progress';
  if (!needsQualifier) return base;
  return qualifier ? `${base} · ${qualifier}` : base;
}

/**
 * The run chip's state, derived once here rather than in each of the three surfaces that
 * render it. REST is authoritative for a run's outcome (Requirement 118).
 */
export function runState(run: { status: string; outcome: string | null }): RunState {
  if (run.status === 'running') return 'running';
  const outcome = run.outcome;
  if (outcome !== null && outcome in RUN_STATUS && outcome !== 'running') {
    return outcome as RunState;
  }
  // A terminal run with no outcome cannot exist — the schema's
  // `runs_terminal_has_outcome` CHECK forbids it. Reaching here means the API disagreed
  // with the database, which is a fault, not an `incomplete`.
  return 'failed';
}

/**
 * Requirements 35a-35b — the navigation health strip.
 *
 * Reuses the locked vocabulary and introduces NO new mark: `●` reachable, `▲`
 * unreachable, `◌` unknown. `◌` is Requirement 114's connection mark, which holds here
 * because the strip is chrome rather than a list.
 *
 * `unknown` is a distinct state from `unreachable` and must render distinctly: the daemon
 * reports peers as `unknown` until its first probe completes, and showing that as a fault
 * would make every dashboard load flash two false alarms.
 */
export type HealthState = 'reachable' | 'unreachable' | 'unknown';

export const HEALTH_STATUS: Readonly<Record<HealthState, StatusRendering>> = {
  reachable: { hue: '--status-good', mark: 'disc-filled', label: 'REACHABLE' },
  unreachable: { hue: '--status-fault', mark: 'triangle', label: 'UNREACHABLE' },
  unknown: { hue: '--status-neutral', mark: 'ring-dotted', label: 'UNKNOWN' },
};

/**
 * The three families as data, so the desaturation test can iterate them rather than being
 * handed a list it might drift from. Requirement 142b asserts distinguishability WITHIN
 * each family; a test asserting global uniqueness would fail on Requirement 142a's two
 * deliberate cross-family identities.
 */
export const STATUS_FAMILIES: Readonly<
  Record<StatusFamily, Readonly<Record<string, StatusRendering>>>
> = {
  run: RUN_STATUS,
  adapter: ADAPTER_STATUS,
  binding: BINDING_STATUS,
};
