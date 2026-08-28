/**
 * Version pin derivation — design-dashboard.md Requirements 106, 106a, 106b.
 *
 * The pin badge is how cross-cutting invariant 2 becomes legible: a Run executed against a
 * resolved snapshot of an Agent version, and editing that Agent never affects the Run.
 *
 * THIS IS PURE LOGIC IN ITS OWN MODULE BECAUSE ONE OF ITS OUTPUTS IS FORBIDDEN. Requirement
 * 106a: a run whose Agent was soft-deleted renders `v?`, and it "MUST NOT render `↑0`,
 * which would assert that the run is current — precisely the invariant-2 misreading the
 * badge exists to prevent." A rule that says "never emit this string" is only enforced if
 * something checks; a `? :` inside a component is not checkable, a function is.
 *
 * THE DELETED CASE IS DETECTED BY ABSENCE, and that is not a hack. Agent Definition R26
 * makes delete SOFT and hides the Agent from LIST endpoints only. So `GET /api/agents`
 * excludes it while `GET /api/agents/{id}?version=N` still resolves — which is exactly what
 * Requirement 106b relies on for the version link to keep working. An `agent_id` present on
 * a run row but absent from the agent list is therefore precisely the soft-deleted case.
 */

export type PinVariant = 'current' | 'behind' | 'deleted';

export interface PinBadge {
  variant: PinVariant;
  /** The full badge text. `v3`, `v1 ↑2`, or `v?`. */
  text: string;
  /** Requirement 106's tooltip, stating the invariant in words. */
  tooltip: string;
  /** Only ever set on `behind`. Never 0 — see the file comment. */
  delta?: number;
}

export function derivePin(input: {
  /** The version the run actually executed against. */
  executedVersion: number;
  /**
   * The agent's current version, or `undefined` when the agent is not in the agent list —
   * which under R26 means soft-deleted.
   */
  currentVersion: number | undefined;
}): PinBadge {
  const { executedVersion, currentVersion } = input;

  if (currentVersion === undefined) {
    // Requirement 106a. No delta, ever. `v?` is the whole badge.
    return {
      variant: 'deleted',
      text: 'v?',
      tooltip:
        'The agent was deleted. This run’s pinned version is retained and still viewable — ' +
        'deleting an agent never removes its versions or its runs.',
    };
  }

  const delta = currentVersion - executedVersion;

  if (delta <= 0) {
    // `<= 0` rather than `=== 0`: a run executing against a version ahead of the list's
    // `current_version` can only be a read racing a save. Rendering `↑-1` would be
    // nonsense, and rendering `behind` would be false. `current` is the honest reading.
    return {
      variant: 'current',
      text: `v${executedVersion}`,
      tooltip: `This run executed against version ${executedVersion}, which is the agent’s current version.`,
    };
  }

  return {
    variant: 'behind',
    text: `v${executedVersion} ↑${delta}`,
    delta,
    tooltip:
      `This run executed against version ${executedVersion}. The agent has since changed and is now at ` +
      `version ${currentVersion}. Editing an agent never affects a run that has already executed.`,
  };
}

/** The border token each variant renders. Requirement 106 / 106a. */
export const PIN_BORDER: Readonly<Record<PinVariant, string>> = {
  current: '--line-strong',
  behind: '--status-warn',
  deleted: '--status-neutral',
};
