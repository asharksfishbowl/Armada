/**
 * Fan every appended Event out to its Run's WebSocket subscribers — Agent Runtime R6, R7.
 *
 * `WsRouter.publish()` was written in P3, handles the replay/live race correctly, and had
 * ZERO call sites. Its own docstring said "called by whatever appended the Event" and
 * nothing did, so `/ws` delivered replay and then silence: a client watching a running Run
 * received its history and never another frame. That is the eighth component in this repo
 * written, tested, and never called, and it is the one P10 cannot be built on top of.
 *
 * ── WHY THE SINK, AND NOT THE LOOP ───────────────────────────────────────────
 * Every Event reaches subscribers because every Event goes through the sink (invariant 5 —
 * append-only, and there is exactly one appender). Publishing from the agent loop instead
 * would cover the loop's own Events and miss `run_start` from the orchestrator, delegation
 * Events from Team synthesis, and anything a later phase appends. A seam that has to be
 * remembered at each call site is the shape of defect this file exists to fix.
 *
 * ── THE PUBLISHER IS RESOLVED PER APPEND, NOT AT CONSTRUCTION ────────────────
 * The gateway owns the WsRouter and is created AFTER the Kernel registers this sink, so at
 * wrap time there is no router to hold. This takes a getter and calls it on each append.
 *
 * That distinction is not theoretical: the identical situation with the RetrievalProvider
 * was "solved" earlier with a helper that was then invoked inside the factory body, which
 * runs during registration — every boot died with "Kernel accessed before registration
 * completed". The indirection was present and did nothing. The test suite passed, because
 * unit tests construct these directly and never exercise the factory. `publish-to-
 * subscribers.test.ts` pins the deferral itself for that reason.
 *
 * ── A BROKEN SOCKET MUST NOT BREAK THE RUN ───────────────────────────────────
 * Delivery is best-effort and failures are swallowed. The Event is already durably
 * appended before publish is attempted; a dashboard that disconnected mid-Run must not be
 * able to fail the Run it was watching. Postgres remains the record, and R7 lets a
 * reconnecting client re-subscribe and receive the full ordered stream again.
 */

import type { Event, EventInput, EventSink } from '../kernel/types.js';

export interface EventPublisher {
  publish(event: Event): void;
}

/**
 * Wrap a sink so each appended Event is also published.
 *
 * `publisher` returns null before the gateway exists — Events appended in that window are
 * durably stored and simply have no subscribers yet, which is correct: nobody can have
 * subscribed to a Run over a listener that is not open.
 */
export function publishOnAppend(
  inner: EventSink,
  publisher: () => EventPublisher | null,
): EventSink {
  return {
    // Delegated, so GET /api/health still reports the implementation
    // config/plugins.yaml selected rather than the name of this wrapper.
    get name(): string {
      return inner.name;
    },

    async append(event: EventInput): Promise<Event> {
      // Appended FIRST. The Event is durable before anyone is told about it, so a
      // subscriber can never observe an Event that failed to persist.
      const appended = await inner.append(event);
      try {
        publisher()?.publish(appended);
      } catch {
        // See the header: delivery is best-effort by design.
      }
      return appended;
    },

    read(runId: string, afterSeq?: number): Promise<Event[]> {
      return afterSeq === undefined ? inner.read(runId) : inner.read(runId, afterSeq);
    },
  };
}
