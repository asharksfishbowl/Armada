/**
 * The copy affordance — design-dashboard.md Requirements 143-146.
 *
 * THE RULE IS ONE SENTENCE: anything set in JetBrains Mono is copyable, and monospace is
 * the signal that it is. So there is one component for every monospace identifier in the
 * product rather than a `copyable` prop sprinkled across a dozen call sites, and the
 * monospace family is applied HERE — you cannot render a mono identifier without also
 * getting its copy control.
 *
 * TWO DETAILS THAT LOOK LIKE POLISH AND ARE NOT:
 *
 * 1. The control lives in a RESERVED GUTTER (Requirement 144). The 16px slot is always
 *    present and only its opacity changes, so nothing shifts on hover. A control that
 *    appears on hover and takes up space moves the row under the cursor.
 *
 * 2. Double-click selects the WHOLE token (Requirement 145). Browsers break on hyphens, so
 *    double-clicking a uuid selects one of its five fragments — which is silently wrong in
 *    the exact case the operator is trying to copy a run_id. This needs an explicit
 *    handler; there is no CSS for it.
 */

import { useCallback, useRef, useState } from 'react';

/**
 * THE 900ms ACKNOWLEDGEMENT IS DRIVEN BY THE ANIMATION, NOT BY A TIMER.
 *
 * Requirement 144 says the control "renders a check mark for 900ms". The obvious
 * implementation is `setTimeout(clear, 900)`, and it is wrong twice over: it is a
 * wall-clock guess running beside a CSS animation that already knows exactly when it
 * finished, and the two drift — a backgrounded tab throttles the timer while the animation
 * is suspended, so the check can clear early or hang. `animationend` IS the event that the
 * acknowledgement has finished playing, so the state clears from that and the duration
 * lives in exactly one place: the `copy-ack` keyframe in styles/motion.css.
 */

export interface CopyTokenProps {
  value: string;
  /** Rendered instead of `value` when the full identifier is too long for its column. */
  display?: string;
  title?: string;
}

export function CopyToken({ value, display, title }: CopyTokenProps) {
  const [copied, setCopied] = useState(false);
  const tokenRef = useRef<HTMLSpanElement>(null);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // A clipboard permission failure must not throw into the render tree. The check mark
      // simply does not appear, which is the honest outcome: nothing was copied.
      return;
    }
    setCopied(true);
  }, [value]);

  const selectWholeToken = useCallback(() => {
    const node = tokenRef.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  return (
    <span
      className="copy-token"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', maxWidth: '100%' }}
    >
      <span
        ref={tokenRef}
        onDoubleClick={selectWholeToken}
        title={title ?? value}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-mono-body)',
          lineHeight: 'var(--leading-mono-body)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {display ?? value}
      </span>
      {/* The reserved gutter. Always 16px wide, occupied or not. */}
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${value}`}
        className={copied ? 'copy-token-control copy-ack' : 'copy-token-control'}
        // The acknowledgement ends when its animation ends. No timer, and no second
        // source of truth for the 900ms.
        onAnimationEnd={() => setCopied(false)}
        style={{
          width: '16px',
          height: '16px',
          flex: '0 0 16px',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: copied ? 'var(--status-good)' : 'var(--fg-dim)',
          cursor: 'pointer',
          lineHeight: 0,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden focusable="false">
          {copied ? (
            <path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          ) : (
            <>
              <rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M11 5 V3.5 A1 1 0 0 0 10 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V10 A1 1 0 0 0 3.5 11 H5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </>
          )}
        </svg>
      </button>
    </span>
  );
}

/** Plain monospace with no copy control — for values that are not identifiers. */
export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-mono-body)',
        lineHeight: 'var(--leading-mono-body)',
      }}
    >
      {children}
    </span>
  );
}
