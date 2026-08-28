/**
 * The forge progress channel — one WebSocket, two consumers.
 *
 * design-dashboard.md dependency ruling 4: armada-forge already emits a dashboard
 * WebSocket channel, and ingestion rides it. That ruling is what makes Requirement 126's
 * LIVE inline progress bar the specified behaviour and Requirement 127's degraded form a
 * fallback that is not used on this path. Requirement 127 still matters and is honoured
 * below: when no frame has ever arrived for a job there is no denominator, so the row
 * renders the degraded `running · started {duration} ago` form. **A progress bar that
 * cannot move is never rendered** — that is the rule, and it is enforced by only ever
 * emitting a fraction when `total` is a positive number.
 *
 * ONE SOCKET FOR THE WHOLE APPLICATION, not one per row. The forge broadcasts every frame
 * to every client, so a socket per corpus row would multiply the same traffic by the row
 * count and buy nothing.
 *
 * `lastUpdate` is recorded per job because build-plan Requirement 12 says the staleness
 * timestamp matters MORE here than for training: the channel is lossy, and a stalled
 * transfer is indistinguishable from a dropped message without a relative timestamp.
 */

import { useEffect, useState } from 'react';

export interface JobProgress {
  status: string;
  /** Completed units, when the producer reports them. */
  completed: number | null;
  /** Total units. Null means NO BAR — see the file comment. */
  total: number | null;
  detail: string | null;
  error: string | null;
  /** Epoch ms of the most recent frame, for the `last update … ago` escalation (R89, R90). */
  lastUpdate: number;
}

export interface ForgeProgress {
  /** Ingestion progress keyed by `corpus_id` (Requirement 126, inline in the corpus row). */
  ingestion: Record<string, JobProgress>;
  /** Materialization progress keyed by binding `tag` (build-plan Requirements 10-14). */
  materialization: Record<string, JobProgress>;
  /** False while the socket is not open. Callers must not render live chrome when false. */
  connected: boolean;
}

const EMPTY: ForgeProgress = { ingestion: {}, materialization: {}, connected: false };

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function useForgeProgress(): ForgeProgress {
  const [state, setState] = useState<ForgeProgress>(EMPTY);

  useEffect(() => {
    // Same-origin, so the scheme follows the page's. Deriving it rather than hardcoding
    // `ws:` means an operator who puts the console behind TLS does not get a mixed-content
    // failure that looks like the forge being down.
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/forge/ws`);
    let closed = false;

    socket.addEventListener('open', () => {
      if (!closed) setState((prev) => ({ ...prev, connected: true }));
    });

    // Requirement 13 read in reverse: the socket dropping must stop live chrome rather
    // than freeze it mid-animation looking healthy. `connected: false` is what every
    // consumer keys its motion off.
    const disconnect = () => {
      if (!closed) setState((prev) => ({ ...prev, connected: false }));
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', disconnect);

    socket.addEventListener('message', (event) => {
      if (closed) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      const now = Date.now();

      if (frame.channel === 'ingestion') {
        const corpusId = stringOrNull(frame.corpus_id);
        if (!corpusId) return;
        setState((prev) => ({
          ...prev,
          ingestion: {
            ...prev.ingestion,
            [corpusId]: {
              status: String(frame.status ?? 'running'),
              completed: numberOrNull(frame.sources_done),
              total: numberOrNull(frame.sources_total),
              detail: stringOrNull(frame.detail),
              error: stringOrNull(frame.error),
              lastUpdate: now,
            },
          },
        }));
        return;
      }

      if (frame.channel === 'job' && frame.job_kind === 'materialization') {
        const tag = stringOrNull(frame.tag);
        if (!tag) return;
        setState((prev) => ({
          ...prev,
          materialization: {
            ...prev.materialization,
            [tag]: {
              status: String(frame.status ?? 'materializing'),
              completed: numberOrNull(frame.completed),
              total: numberOrNull(frame.total),
              detail: stringOrNull(frame.detail),
              error: stringOrNull(frame.error),
              lastUpdate: now,
            },
          },
        }));
      }
    });

    return () => {
      closed = true;
      socket.close();
    };
  }, []);

  return state;
}

/**
 * Requirement 88 — a determinate job never renders an indeterminate spinner, and its
 * inverse: an indeterminate job never renders a determinate bar.
 *
 * Returns a 0..1 fraction only when both endpoints are known and the total is positive.
 * Null means the caller must render Requirement 127's degraded form instead.
 */
export function progressFraction(job: JobProgress | undefined): number | null {
  if (!job) return null;
  if (job.total === null || job.total <= 0) return null;
  if (job.completed === null) return null;
  return Math.max(0, Math.min(1, job.completed / job.total));
}

/** Requirement 13 — motion belongs to a running entity and stops within 200ms of terminal. */
export function isJobRunning(job: JobProgress | undefined): boolean {
  if (!job) return false;
  return job.status === 'running' || job.status === 'materializing';
}
