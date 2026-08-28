/**
 * The destructive-action template — design-dashboard.md Requirements 99-105.
 *
 * THE `Retained:` SECTION IS A REQUIRED PART OF THE TEMPLATE, not a convention. Requirement
 * 99: "every confirmation dialog states what survives, not only what is destroyed", because
 * surprise about soft deletion comes from silence about survivors. It is a required prop
 * with no default, so a dialog cannot be constructed without it — and one of the design
 * spec's acceptance criteria is literally "every destructive confirmation dialog contains a
 * `Retained:` section".
 *
 * THERE IS NO UNDO AND NO UNDO-BEARING TOAST (Requirement 104). These actions commit
 * immediately. Nothing in this component or its callers may imply a window that does not
 * exist.
 *
 * CONFIRMATION IS PROPORTIONAL TO REVERSIBILITY (Requirement 99). Passing `typeToConfirm`
 * requires the operator to type that exact string — used by delete-corpus (Requirement
 * 101) and by nothing else. Delete-agent and delete-team are plain confirms (100, 102).
 *
 * A MODAL BLOCKS, and this is where the blur belongs: Requirement 14 makes
 * `backdrop-filter: blur(12px)` over `--surface-0` at 70% the ONLY blur in the
 * application, reserved for modals and popovers. Requirement 38a is the other half of that
 * rule — a drawer gets none of it.
 */

import { useEffect, useState, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  title: string;
  /** What goes away. */
  removed: ReactNode;
  /** What survives. REQUIRED — see the file comment. */
  retained: ReactNode;
  /** What this breaks elsewhere, listed by name. Requirements 100, 101, edge 33, edge 34. */
  breaks?: ReactNode;
  confirmLabel: string;
  /** Requirement 101 — the operator must type this exact value before confirm enables. */
  typeToConfirm?: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  removed,
  retained,
  breaks,
  confirmLabel,
  typeToConfirm,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const satisfied = typeToConfirm === undefined || typed === typeToConfirm;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="overlay-scrim" style={{ display: 'grid', placeItems: 'center', zIndex: 60 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel"
        style={{
          width: '560px',
          maxWidth: '90vw',
          borderRadius: 'var(--radius-overlay)',
          padding: 'var(--space-6)',
          background: 'var(--surface-2)',
        }}
      >
        <h2 className="text-section" style={{ margin: '0 0 var(--space-4)', color: 'var(--fg)' }}>
          {title}
        </h2>

        <DialogSection label="Removed:">{removed}</DialogSection>
        <DialogSection label="Retained:">{retained}</DialogSection>
        {breaks ? <DialogSection label="Breaks:">{breaks}</DialogSection> : null}

        {typeToConfirm !== undefined ? (
          <label
            className="text-body-sm"
            style={{ display: 'block', marginTop: 'var(--space-4)', color: 'var(--fg-muted)' }}
          >
            Type <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{typeToConfirm}</span> to
            confirm
            <input
              className="input"
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              style={{ marginTop: 'var(--space-2)', width: '100%', fontFamily: 'var(--font-mono)' }}
            />
          </label>
        ) : null}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-6)',
          }}
        >
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-destructive"
            onClick={onConfirm}
            disabled={!satisfied || pending}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DialogSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <span
        className="text-body-sm"
        style={{ color: 'var(--fg-muted)', fontWeight: 600, marginRight: 'var(--space-2)' }}
      >
        {label}
      </span>
      <span className="text-body-sm" style={{ color: 'var(--fg)' }}>
        {children}
      </span>
    </div>
  );
}
