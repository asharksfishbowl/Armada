/**
 * The service health strip — design-dashboard.md Requirements 35a-35d.
 *
 * EXACTLY THREE DOTS: daemon, forge, models. Requirement 35c rules out the other two
 * candidates and the reasoning is worth keeping in front of whoever adds a fourth: a `db`
 * dot could only ever mirror `daemon`, because a daemon answering `GET /api/health` has a
 * reachable database by definition; and `sandbox` has no persistent process to be up or
 * down, Docker availability being a daemon-health property. A dot that cannot
 * independently change state is decoration wearing a status mark.
 *
 * IT REUSES THE LOCKED VOCABULARY AND INTRODUCES NO MARK (Requirement 35b): `●` reachable,
 * `▲` unreachable, `◌` unknown. `◌` stays a connection mark rather than an outcome, which
 * holds here because the strip is chrome and not a list.
 *
 * IT RAISES NO NAVIGATION BADGE (Requirement 35d). A `missing` ModelBinding remains the
 * only status in the product that escalates to the rail (Requirement 30).
 *
 * The strip is one of exactly two exemptions from "no bare status dot" (Requirement 32),
 * because it is a spatial status index rather than a labelled readout. Hover reveals the
 * label, and the strip is one tooltip target listing all three with their last-checked
 * time.
 */

import { fetchHealth, type Health } from '../lib/api';
import { HEALTH_STATUS, type HealthState } from '../lib/status';
import { StatusMark } from './StatusMark';
import { useResource } from '../lib/useResource';

/** Requirement 35a — the strip's order is fixed and its membership is not data-driven. */
const DOTS = ['daemon', 'forge', 'models'] as const;

function stateOf(health: Health | undefined, service: string): HealthState {
  if (!health) return 'unknown';
  const entry = health.services?.[service];
  if (!entry) return 'unknown';
  // The daemon reports a peer as `unknown` until its first probe completes. Mapping that
  // to `unreachable` would flash two false faults on every dashboard load, so the three
  // states are carried through unflattened.
  if (entry.reachable === 'reachable') return 'reachable';
  if (entry.reachable === 'unreachable') return 'unreachable';
  return 'unknown';
}

export function HealthStrip() {
  // No polling. Requirement 121's principle — driven by events and navigation, not timers —
  // and the health fan-out is a probe the DAEMON already runs on its own schedule. A
  // client-side interval here would add load without adding freshness, and
  // `last_checked` already tells the operator how stale the answer is.
  const { data } = useResource(fetchHealth, []);

  const summary = DOTS.map((service) => {
    const state = stateOf(data, service);
    const checked = data?.services?.[service]?.last_checked;
    return `${service}: ${HEALTH_STATUS[state].label.toLowerCase()}${
      checked ? ` (checked ${new Date(checked).toLocaleTimeString()})` : ''
    }`;
  }).join('\n');

  return (
    <div
      className="health-strip"
      // One tooltip target listing all three with their last-checked time (R35a).
      title={summary}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-3) var(--space-4)',
      }}
    >
      {DOTS.map((service) => {
        const state = stateOf(data, service);
        const status = HEALTH_STATUS[state];
        return (
          <span
            key={service}
            className="health-dot"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}
          >
            <StatusMark kind={status.mark} hue={status.hue} size={8} />
            <span className="health-dot-label text-micro" style={{ color: 'var(--fg-muted)' }}>
              {service}
            </span>
          </span>
        );
      })}
    </div>
  );
}
