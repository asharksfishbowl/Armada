/**
 * The application shell — design-dashboard.md Requirements 33-36.
 *
 * A FIXED 200px LEFT NAVIGATION RAIL against `--surface-1`, not a top bar. Six
 * destinations ordered to teach the pipeline (Requirement 34), plus the three-dot health
 * strip which is chrome on the rail rather than a seventh destination (Requirement 35c).
 *
 * The active item is a 2px accent left edge plus `--accent-wash`, with the indicator
 * sliding on `transform` over 180ms (Requirements 14, 35). That slide is one of only two
 * pieces of navigation motion in the product; there is NO page transition between routes
 * (Requirement 15) — navigation is instant.
 *
 * THE ONLY NAVIGATION BADGE IN THE APPLICATION is the `missing` ModelBinding count on
 * Models (Requirement 30). `missing` is the only status that is never an expected state —
 * the database reports a binding promoted while armada-models does not serve it — so it is
 * the only one entitled to escalate beyond its own row. The health strip explicitly raises
 * none (Requirement 35d).
 *
 * DESKTOP ONLY, >=1280px (Requirement 21 non-goal, edge 39). Below that the content area
 * scrolls horizontally; it does not reflow. There is no mobile layout and no breakpoint.
 */

import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { HealthStrip } from './HealthStrip';
import { NAV_DESTINATIONS } from '../routes';
import { fetchBindings } from '../lib/api';
import { useResource } from '../lib/useResource';

const ITEM_HEIGHT = 36;

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  // Requirement 30 / edge 27. Fetched here rather than passed down from ModelsPage,
  // because the badge must be visible from every page — an operator on Runs needs to learn
  // that a binding stopped being served without navigating to Models to find out.
  const { data: bindings } = useResource(fetchBindings, []);
  const missingCount = (bindings ?? []).filter((binding) => binding.status === 'missing').length;

  const activeIndex = NAV_DESTINATIONS.findIndex((destination) =>
    location.pathname.startsWith(destination.path),
  );

  return (
    <div className="app-shell">
      <nav className="nav-rail" aria-label="Primary">
        <div className="nav-brand text-section">Armada</div>

        <div className="nav-items" style={{ position: 'relative' }}>
          {/* The sliding indicator. One element that moves, rather than a border that
              appears and disappears per item — Requirement 14 specifies a slide on
              `transform`, and a per-item border cannot slide. Hidden entirely when no
              destination matches, so an editor route does not leave it pointing at a
              parent the operator is not on. */}
          {activeIndex >= 0 ? (
            <span
              className="nav-indicator"
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '2px',
                height: `${ITEM_HEIGHT}px`,
                background: 'var(--accent)',
                transform: `translateY(${activeIndex * ITEM_HEIGHT}px)`,
              }}
            />
          ) : null}

          {NAV_DESTINATIONS.map((destination) => (
            <NavLink
              key={destination.path}
              to={destination.path}
              className={({ isActive }) => (isActive ? 'nav-item nav-item-active' : 'nav-item')}
              style={{ height: `${ITEM_HEIGHT}px` }}
            >
              <span>{destination.label}</span>
              {destination.path === '/models' && missingCount > 0 ? (
                <span
                  className="nav-badge"
                  title={`${missingCount} ModelBinding${missingCount === 1 ? '' : 's'} reported promoted but not served by armada-models`}
                >
                  {missingCount}
                </span>
              ) : null}
            </NavLink>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <HealthStrip />
      </nav>

      <main className="app-content">{children}</main>
    </div>
  );
}

/**
 * Requirement 36 — the page header: title, entity count, primary action. Every list page
 * uses this one, so the count is never omitted on one page and present on another.
 */
export function PageHeader({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        marginBottom: 'var(--space-4)',
      }}
    >
      <h1 className="text-page" style={{ margin: 0, color: 'var(--fg)' }}>
        {title}
      </h1>
      {count !== undefined ? (
        <span className="text-body-sm counter" style={{ color: 'var(--fg-muted)' }}>
          {count}
        </span>
      ) : null}
      <div style={{ flex: 1 }} />
      {action}
    </header>
  );
}

/** Requirement 36 — the filter row, between the header and the page body. */
export function FilterRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-4)',
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  );
}
