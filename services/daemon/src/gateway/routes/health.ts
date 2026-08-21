/**
 * GET /api/health — Agent Runtime R3a, extended with the design spec's health strip
 * (design R35a-R35d, ruled ACCEPTED).
 *
 * ⚠ ROADMAP F13 — THE PEER FAN-OUT MUST NOT AFFECT THIS ENDPOINT'S STATUS CODE.
 *
 * The 200/503 decision is exactly R3a's: every declared plugin registered, and the
 * database reachable. Daemon-local facts only. Reachability of forge or models is
 * REPORTED in the body and never consulted for the status code.
 *
 * That separation is load-bearing rather than fastidious. Compose gates dependent services
 * on this healthcheck, so a fan-out that could 503 the daemon would turn any peer hiccup
 * into a cascade — forge blips, the daemon reports unhealthy, Compose restarts it, and the
 * dashboard loses the very endpoint that would have explained why. The strip reports a
 * degraded PEER; it must never manufacture a degraded SELF.
 *
 * PROBING IS DEMAND-DRIVEN AND CACHED, NOT INLINE AND NOT TIMED.
 *
 * A health request refreshes a peer's status only when the cached value is older than
 * `health_probe_interval_seconds`, and the response is served from cache either way —
 * it never awaits a peer. So:
 *
 *   - a dashboard polling the strip does NOT stampede forge (the acceptance criterion:
 *     repeated requests inside one interval issue no extra probes)
 *   - no background timer runs, so nothing probes a peer while nobody is looking
 *   - the daemon's own response time never depends on a peer being up, which is the
 *     latency half of the same rule F13 states for status codes
 *
 * There is no event source for "is another container up", so this cannot be made
 * edge-triggered; making it request-triggered is the closest honest equivalent, and it
 * removes the timer entirely rather than dressing one up.
 */

import type { Pool } from 'pg';
import type { Kernel } from '../../kernel/kernel.js';

export type Reachability = 'reachable' | 'unreachable' | 'unknown';

export interface ServiceStatus {
  reachable: Reachability;
  /** ISO timestamp of the last completed probe, or null before the first one. */
  last_checked: string | null;
}

interface PeerConfig {
  name: 'forge' | 'models';
  url: string;
}

interface PeerState {
  status: ServiceStatus;
  /** 0 = never probed. */
  lastProbedMs: number;
  /** Single-flight guard: one in-flight probe per peer, never a herd. */
  inFlight: boolean;
}

/**
 * Demand-driven, cached peer prober.
 *
 * Holds the last result per peer and serves it from cache. Before the first probe
 * completes a peer reports `unknown`, which the dashboard renders as `◌` — deliberately
 * distinct from `unreachable`, because "we have not looked yet" and "we looked and it was
 * down" are different facts, and collapsing them would show a false outage at every boot.
 */
export class PeerProbe {
  private readonly state = new Map<string, PeerState>();

  constructor(
    private readonly peers: PeerConfig[],
    private readonly intervalSeconds: number,
    private readonly timeoutMs = 3000,
  ) {
    for (const peer of this.peers) {
      this.state.set(peer.name, {
        status: { reachable: 'unknown', last_checked: null },
        lastProbedMs: 0,
        inFlight: false,
      });
    }
  }

  /**
   * Refresh any peer whose cached status is stale, WITHOUT awaiting the result.
   *
   * Called from the health handler. Returning immediately is what keeps a peer's latency
   * out of the daemon's own response — the same separation F13 requires for status codes.
   * The refreshed value lands in the cache and is served by the next request.
   */
  refreshIfStale(): void {
    const now = Date.now();
    const staleAfterMs = this.intervalSeconds * 1000;

    for (const peer of this.peers) {
      const state = this.state.get(peer.name);
      if (!state || state.inFlight) continue;
      if (state.lastProbedMs !== 0 && now - state.lastProbedMs < staleAfterMs) continue;

      // Stamp BEFORE probing so concurrent requests during a slow probe do not each
      // start their own — this is the "no extra probes inside one interval" guarantee.
      state.lastProbedMs = now;
      state.inFlight = true;
      void this.probe(peer).finally(() => {
        state.inFlight = false;
      });
    }
  }

  private async probe(peer: PeerConfig): Promise<void> {
    let reachable: Reachability = 'unreachable';
    try {
      const response = await fetch(peer.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // A peer that answers 503 is REACHABLE but unhealthy. The strip reports whether we
      // can talk to it; its own health endpoint reports how it feels.
      if (response.status < 500 || response.status === 503) reachable = 'reachable';
    } catch {
      reachable = 'unreachable';
    }
    const state = this.state.get(peer.name);
    if (state) state.status = { reachable, last_checked: new Date().toISOString() };
  }

  snapshot(): Record<string, ServiceStatus> {
    return Object.fromEntries([...this.state].map(([name, s]) => [name, s.status]));
  }
}

export interface HealthBody {
  status: 'ok' | 'unavailable';
  version: string;
  plugins: ReturnType<Kernel['describe']>;
  checks: { database: 'ok' | 'unreachable'; kernel: 'ok' | 'incomplete' };
  services: Record<string, ServiceStatus>;
}

export async function buildHealth(
  kernel: Kernel,
  pool: Pool,
  version: string,
  probe: PeerProbe,
): Promise<{ status: number; body: HealthBody }> {
  // Kick off a peer refresh if the cache has aged out. Deliberately not awaited: this
  // response is served from whatever is cached now.
  probe.refreshIfStale();

  let databaseOk = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    databaseOk = false;
  }

  const kernelReady = kernel.isReady;

  // R3a — and ONLY R3a. Note what is absent from this expression: anything about a peer.
  const ready = databaseOk && kernelReady;

  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? 'ok' : 'unavailable',
      version,
      plugins: kernel.describe(),
      checks: {
        database: databaseOk ? 'ok' : 'unreachable',
        kernel: kernelReady ? 'ok' : 'incomplete',
      },
      services: {
        // The daemon is answering this request, so it is trivially reachable. Included so
        // the strip renders uniformly rather than special-casing self.
        daemon: { reachable: 'reachable', last_checked: new Date().toISOString() },
        ...probe.snapshot(),
      },
    },
  };
}
