/**
 * Status chip and flag chip — design-dashboard.md Requirements 32, 50a.
 *
 * A STATUS CHIP IS: the mark, a 12% tint of its hue as background, the hue as text colour,
 * and a text label. There is no filled-pill chip and no bare status dot anywhere in the
 * product, which is why `label` is a required prop with no default — a chip you can
 * construct without words is a chip someone will construct without words.
 *
 * A FLAG CHIP IS A DIFFERENT VISUAL CLASS (Requirement 50a) and never uses a status hue:
 * `--surface-3` background, `--fg-muted` text, no mark, lowercase monospace 11px. It
 * exists to resolve a real collision — the `tool_result` flag `cancelled` and the run
 * outcome `CANCELLED` are the same word naming two different concepts (Requirement 50b).
 * They live in one file precisely so the contrast between them is visible to whoever edits
 * either.
 */

import type { CSSProperties } from 'react';
import { StatusMark } from './StatusMark';
import type { StatusRendering } from '../lib/status';

const TINTS: Record<string, string> = {
  '--status-live': 'var(--tint-live)',
  '--status-good': 'var(--tint-good)',
  '--status-neutral': 'var(--tint-neutral)',
  '--status-warn': 'var(--tint-warn)',
  '--status-fault': 'var(--tint-fault)',
  '--status-pending': 'var(--tint-pending)',
};

export interface StatusChipProps {
  status: StatusRendering;
  /**
   * Overrides the vocabulary's label. Requirement 25's mandatory qualifier arrives this
   * way, via `runChipLabel`, so the qualifier cannot be forgotten at a call site: the
   * helper always returns a complete label.
   */
  label?: string | undefined;
  title?: string | undefined;
}

export function StatusChip({ status, label, title }: StatusChipProps) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    // Requirement 32d use 1 — 12% tint, the only alpha this chip uses. Requirement 32e:
    // it is not a sole carrier of meaning, sitting beneath the chip's own mark and label.
    background: TINTS[status.hue] ?? 'transparent',
    color: `var(${status.hue})`,
    border: 'none',
    borderRadius: 'var(--radius-chip)',
    padding: '0 var(--space-2)',
    height: '20px',
    fontSize: 'var(--text-micro)',
    lineHeight: 'var(--leading-micro)',
    fontWeight: 'var(--weight-medium)' as unknown as number,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };

  return (
    <span style={style} title={title}>
      <StatusMark kind={status.mark} hue={status.hue} rotating={status.rotating === true} />
      {label ?? status.label}
    </span>
  );
}

/**
 * Requirement 50a — achromatic, lowercase, monospace, no mark. Never a status hue.
 *
 * Used for the `local` materialization flag of build-plan Requirement 11 and for
 * `tool_result` flags when P10 lands the event stream.
 */
export function FlagChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--surface-3)',
        color: 'var(--fg-muted)',
        borderRadius: 'var(--radius-chip)',
        padding: '0 var(--space-2)',
        height: '20px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-micro)',
        lineHeight: 'var(--leading-micro)',
        textTransform: 'lowercase',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
