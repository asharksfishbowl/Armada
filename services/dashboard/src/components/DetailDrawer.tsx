/**
 * The detail drawer — design-dashboard.md Requirements 37-41, 38a-38c.
 *
 * DRAWERS DO NOT BLOCK. There is no scrim, no blur, and no dimming behind this component,
 * and that is not an omission — Requirement 38a reserves the blur-plus-70%-wash treatment
 * for modals and popovers, because that is the "deal with this before continuing"
 * signal. A drawer is additive detail: the list behind it stays fully legible, fully
 * scrolled, and FULLY INTERACTIVE.
 *
 * That is also why this component does not close when the list is clicked. Requirement
 * 38c: clicking another row SWAPS the drawer's contents rather than closing it, so an
 * operator comparing several agents never closes and reopens. Implemented by the parent
 * simply changing `selected` — the drawer stays mounted and its children change.
 *
 * Separation is carried entirely by the drawer's own surface (Requirement 38b):
 * `--surface-2` over the page's `--surface-1`, a 1px `--line-strong` left edge, and a
 * left-edge shadow — the only shadow outside a modal or popover.
 *
 * `Esc` and an explicit close control both close it (Requirement 37).
 */

import { useEffect, type ReactNode } from 'react';

export interface DetailDrawerProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /**
   * Requirement 41 / 131a — destructive actions live in the drawer FOOTER, never as a
   * row-hover icon, so the operator is looking at the entity's detail when triggering one.
   * The footer is split into a safe zone and a destructive zone that are never adjacent.
   */
  safeActions?: ReactNode;
  destructiveActions?: ReactNode;
}

export function DetailDrawer({
  title,
  subtitle,
  onClose,
  children,
  safeActions,
  destructiveActions,
}: DetailDrawerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      className="drawer-surface"
      // NOT role="dialog" and NOT aria-modal. Both would announce that the content behind
      // is inert, which is the opposite of Requirement 38a — the list stays interactive.
      role="complementary"
      aria-label={typeof title === 'string' ? title : 'Detail'}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'var(--drawer-width)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
    >
      <header
        style={{
          padding: 'var(--space-4)',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--space-3)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-section" style={{ color: 'var(--fg)' }}>
            {title}
          </div>
          {subtitle ? (
            <div className="text-body-sm" style={{ color: 'var(--fg-muted)', marginTop: 'var(--space-1)' }}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>{children}</div>

      {safeActions || destructiveActions ? (
        <footer
          style={{
            borderTop: '1px solid var(--line)',
            padding: 'var(--space-3) var(--space-4)',
            display: 'flex',
            alignItems: 'center',
            // The hairline divider of Requirement 131a. `space-between` is what keeps the
            // two zones from ever being adjacent — Delete never sits next to Clone.
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
          }}
        >
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{safeActions}</div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{destructiveActions}</div>
        </footer>
      ) : null}
    </aside>
  );
}

/** A labelled field inside a drawer body. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div
        className="text-micro"
        style={{ color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
      >
        {label}
      </div>
      <div className="text-body-sm" style={{ color: 'var(--fg)', marginTop: 'var(--space-1)' }}>
        {children}
      </div>
    </div>
  );
}

/** A section heading inside a drawer body, on the brass-warm seam of Requirement 2. */
export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-6)' }}>
      <h3
        className="text-body-sm"
        style={{
          margin: '0 0 var(--space-3)',
          paddingBottom: 'var(--space-2)',
          borderBottom: '1px solid var(--line-strong)',
          color: 'var(--fg-muted)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}
