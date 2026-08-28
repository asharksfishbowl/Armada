/**
 * Inline toasts — design-dashboard.md Requirements 104, 105, 110, edge cases 30 and 32.
 *
 * THERE IS NO UNDO AND NO UNDO-BEARING TOAST (Requirement 104). These actions commit
 * immediately, and an undo window that does not exist must not be implied. So this
 * component has no action slot at all: it carries words and a dismiss control, nothing
 * else. There is nothing here for an "Undo" button to be added to without the addition
 * being deliberate.
 *
 * IT DOES NOT AUTO-DISMISS, and that is a decision rather than an omission. Every toast in
 * the specified surfaces reports something the operator needs to read and act on: the
 * outcome a cancel raced (edge 32), the in-flight `job_id` a second ingest collided with
 * (edge 30), the current version that `refresh-bindings` left unchanged (R110/edge 18). A
 * timed dismissal would race the operator's reading of exactly the message that matters,
 * and it would be a wall-clock timer doing it.
 *
 * These are the three places the spec insists a condition renders as an INLINE TOAST rather
 * than an error modal, because none of them is a fault — each is a normal race with a
 * defined outcome.
 */

import type { ReactNode } from 'react';

export type ToastTone = 'info' | 'warn';

export interface ToastMessage {
  tone: ToastTone;
  text: ReactNode;
}

export function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const hue = message.tone === 'warn' ? '--status-warn' : '--fg-muted';
  return (
    <div
      role="status"
      className="panel"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        marginBottom: 'var(--space-4)',
        borderColor: `var(${hue})`,
      }}
    >
      <span className="text-body-sm" style={{ flex: 1, color: 'var(--fg)' }}>
        {message.text}
      </span>
      <button type="button" className="btn btn-quiet" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
