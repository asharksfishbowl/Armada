/**
 * The version pin badge — design-dashboard.md Requirements 106, 106a, 107.
 *
 * Three variants, all derived by `lib/version-pin.ts` rather than here, because the rule
 * that matters ("never render ↑0 for a deleted agent") has to be testable. This component
 * is the rendering only.
 *
 * Monospace with a border, per Requirement 106. The border token is the variant's only
 * colour difference — `--status-warn` on `behind` is a status-bearing border and therefore
 * renders at its declared value, never dimmed (Requirement 32c).
 */

import { derivePin, PIN_BORDER } from '../lib/version-pin';

export interface VersionPinBadgeProps {
  executedVersion: number;
  /** `undefined` means the agent is absent from `GET /api/agents`, i.e. soft-deleted. */
  currentVersion: number | undefined;
}

export function VersionPinBadge({ executedVersion, currentVersion }: VersionPinBadgeProps) {
  const pin = derivePin({ executedVersion, currentVersion });

  return (
    <span
      title={pin.tooltip}
      style={{
        display: 'inline-block',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-micro)',
        lineHeight: '18px',
        padding: '0 var(--space-2)',
        borderRadius: 'var(--radius-chip)',
        border: `1px ${pin.variant === 'deleted' ? 'dotted' : 'solid'} var(${PIN_BORDER[pin.variant]})`,
        color: pin.variant === 'behind' ? 'var(--status-warn)' : 'var(--fg-muted)',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {pin.text}
    </span>
  );
}
