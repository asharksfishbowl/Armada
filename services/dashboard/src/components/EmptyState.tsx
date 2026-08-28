/**
 * Empty states and disabled actions — design-dashboard.md Requirements 95-97.
 *
 * THE SHAPE IS FIXED: one `body`-size line stating what is true, one `body-sm`
 * `--fg-muted` line stating WHY, and one primary action. No illustrations.
 *
 * The `why` line is required, not optional, because Requirement 96 says empty states form
 * a directed graph back to Corpora — an operator must be able to walk backwards from any
 * blocked page to the real blocker. An empty state that only says "nothing here" is a dead
 * end in that graph.
 *
 * A DISABLED PRIMARY ACTION ALWAYS RENDERS ITS REASON INLINE (Requirement 95). This is
 * enforced by the type: `disabledReason` and `disabled` are one field, so a control cannot
 * be disabled without supplying words. A disabled-and-silent control is not permitted, and
 * "every disabled primary action in the application renders its reason inline" is one of
 * the design spec's acceptance criteria.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface PrimaryActionProps {
  label: string;
  onClick?: () => void;
  /** Renders as a router link instead of a button when supplied. */
  to?: string;
  /**
   * Supplying this disables the control AND renders the words beside it. There is no
   * separate `disabled` boolean, so the two cannot come apart.
   */
  disabledReason?: string;
  /** Optional route the reason links to — Requirement 96's walk back to the blocker. */
  reasonLinkTo?: string;
  reasonLinkLabel?: string;
}

export function PrimaryAction({
  label,
  onClick,
  to,
  disabledReason,
  reasonLinkTo,
  reasonLinkLabel,
}: PrimaryActionProps) {
  const disabled = disabledReason !== undefined;

  const button = disabled ? (
    <button type="button" className="btn btn-primary" disabled>
      {label}
    </button>
  ) : to !== undefined ? (
    <Link className="btn btn-primary" to={to}>
      {label}
    </Link>
  ) : (
    <button type="button" className="btn btn-primary" onClick={onClick}>
      {label}
    </button>
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)' }}>
      {button}
      {disabled ? (
        <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
          {disabledReason}
          {reasonLinkTo ? (
            <>
              {' '}
              <Link to={reasonLinkTo}>{reasonLinkLabel ?? 'Go there'}</Link>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export interface EmptyStateProps {
  /** What is true. One line, `body` size. */
  headline: string;
  /** Why, and what the upstream blocker is. One line, `body-sm`, `--fg-muted`. */
  why: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ headline, why, action }: EmptyStateProps) {
  return (
    <div
      className="panel"
      style={{
        padding: 'var(--space-12)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
      }}
    >
      <p className="text-body" style={{ margin: 0, color: 'var(--fg)' }}>
        {headline}
      </p>
      <p className="text-body-sm" style={{ margin: 0, color: 'var(--fg-muted)', maxWidth: '60ch' }}>
        {why}
      </p>
      {action ? <div style={{ marginTop: 'var(--space-2)' }}>{action}</div> : null}
    </div>
  );
}

/**
 * The hint bar above a table — Requirement 97's Corpora and Agents first-run states.
 *
 * Distinct from an empty state: the table below it is NOT empty. A fresh installation has
 * two seeded corpora and two shipped agents, and the thing an operator needs to be told is
 * that they are inert, not that they are absent.
 */
export function HintBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="hint-bar text-body-sm"
      style={{
        // Requirement 32b: this is chrome, not status. It carries --line-strong and the
        // --fg-muted ramp, never a status hue, because "you have not added a source yet"
        // is not a state of any entity.
        border: '1px solid var(--line-strong)',
        borderRadius: 'var(--radius-control)',
        background: 'var(--surface-2)',
        color: 'var(--fg-muted)',
        padding: 'var(--space-3) var(--space-4)',
        marginBottom: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Never present a degraded view as a healthy one (design spec Goal 7).
 *
 * A list whose fetch failed renders THIS, never an empty state — "no corpora exist" and
 * "we could not ask" are different facts and an operator acts differently on each.
 */
export function LoadError({ what, error, onRetry }: { what: string; error: Error; onRetry: () => void }) {
  return (
    <div
      className="panel"
      style={{
        padding: 'var(--space-6)',
        borderColor: 'var(--status-fault)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
      }}
    >
      <p className="text-body" style={{ margin: 0, color: 'var(--status-fault)' }}>
        Could not load {what}.
      </p>
      <p className="text-body-sm" style={{ margin: 0, color: 'var(--fg-muted)' }}>
        This is not an empty {what} list — the request failed, so what exists is unknown.
      </p>
      <p className="text-mono-body" style={{ margin: 0, color: 'var(--fg-muted)' }}>
        {error.message}
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
