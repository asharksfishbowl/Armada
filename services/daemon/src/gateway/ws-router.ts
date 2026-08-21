/**
 * WebSocket subscription and ordered Event replay — Agent Runtime R6, R7.
 *
 * A client sends `{"subscribe": {"run_id": "..."}}` and receives EVERY Event already
 * recorded for that Run, in `seq` order, BEFORE any new one — then live Events as they
 * are appended.
 *
 * R7 — THE GATEWAY HOLDS NO PER-CONNECTION RUN STATE. Run state lives in Postgres. What
 * this router keeps is routing state only: which sockets asked about which run_id. A
 * client that reconnects and re-subscribes gets the full ordered stream again, because
 * the stream is reconstructed from the event log rather than remembered here.
 *
 * The replay-then-live handoff is the one ordering hazard. An Event appended DURING the
 * replay read must not be dropped, and must not arrive before the replayed Events that
 * precede it. Live Events are therefore buffered while the replay is in flight and
 * flushed afterwards, filtered by `seq` so anything the replay already covered is not
 * sent twice. Ordering is by seq, never by arrival.
 */

import type { WebSocket } from 'ws';
import type { Event, EventSink } from '../kernel/types.js';

interface Subscription {
  /** Highest seq delivered so far. Everything at or below this has been sent. */
  deliveredThrough: number;
  /**
   * Events that arrived while the initial replay was still reading, or null once the
   * subscription is live. Null IS the live marker — a separate boolean would be a second
   * field tracking one fact, and the two could disagree.
   */
  pending: Event[] | null;
}

export class WsRouter {
  /**
   * socket -> run_id -> subscription. Routing state only; no Run state (R7).
   *
   * Keyed by socket first because disconnect is the common mutation and becomes a single
   * delete. Keying the inner map by run_id also makes a repeat subscribe to the same Run
   * idempotent rather than creating a second subscription that double-delivers.
   */
  private readonly subs = new Map<WebSocket, Map<string, Subscription>>();

  constructor(private readonly events: EventSink) {}

  /**
   * Handle one client frame.
   *
   * Unknown frames are answered with an error rather than ignored, so a client using the
   * wrong shape learns immediately instead of waiting forever for events.
   */
  async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(socket, { error: 'invalid_json' });
      return;
    }

    const runId = (parsed as { subscribe?: { run_id?: unknown } })?.subscribe?.run_id;
    if (typeof runId !== 'string' || !runId) {
      this.send(socket, { error: 'expected {"subscribe": {"run_id": "..."}}' });
      return;
    }

    await this.subscribe(socket, runId);
  }

  private async subscribe(socket: WebSocket, runId: string): Promise<void> {
    let forSocket = this.subs.get(socket);
    if (!forSocket) {
      forSocket = new Map();
      this.subs.set(socket, forSocket);
    }

    const subscription: Subscription = { deliveredThrough: 0, pending: [] };
    forSocket.set(runId, subscription);

    // R6 — replay everything recorded, in seq order, before any live Event.
    let recorded: Event[];
    try {
      recorded = await this.events.read(runId);
    } catch (err) {
      this.send(socket, {
        error: 'replay_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      forSocket.delete(runId);
      return;
    }

    for (const event of recorded) this.send(socket, event);
    // read() returns ORDER BY seq ASC, so the last is the highest.
    subscription.deliveredThrough = recorded.at(-1)?.seq ?? 0;

    // Flush anything that arrived mid-replay, dropping what the replay already covered.
    // Sorting by seq rather than trusting arrival order is what makes two subscribers to
    // the same Run receive IDENTICAL sequences regardless of when each connected.
    const buffered = (subscription.pending ?? []).sort((a, b) => a.seq - b.seq);
    subscription.pending = null;
    for (const event of buffered) {
      if (event.seq <= subscription.deliveredThrough) continue;
      this.send(socket, event);
      subscription.deliveredThrough = event.seq;
    }

    // Edge 14 — a client subscribing to an already-completed Run receives the full stream
    // and then a close signal, not an error.
    if (recorded.some((event) => event.type === 'run_end')) {
      this.send(socket, { run_id: runId, closed: true, reason: 'run_terminal' });
    }
  }

  /**
   * Fan a newly appended Event out to its Run's subscribers.
   *
   * Called by whatever appended the Event. Buffering during replay is what prevents the
   * live/replay race from either dropping or reordering an Event.
   */
  publish(event: Event): void {
    for (const [socket, forSocket] of this.subs) {
      const subscription = forSocket.get(event.runId);
      if (!subscription) continue;

      if (subscription.pending) {
        subscription.pending.push(event);
        continue;
      }
      if (event.seq <= subscription.deliveredThrough) continue;
      this.send(socket, event);
      subscription.deliveredThrough = event.seq;
    }
  }

  /** Drop every subscription for a closed socket. */
  disconnect(socket: WebSocket): void {
    this.subs.delete(socket);
  }

  private send(socket: WebSocket, message: unknown): void {
    // readyState 1 is OPEN. A send to a closing socket throws, and a dead client is not
    // an error worth propagating into whatever appended the Event.
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* client vanished mid-send; disconnect() cleans up on close */
    }
  }
}
