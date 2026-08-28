/**
 * P10 — every appended Event reaches its Run's subscribers. Agent Runtime R6, R7.
 *
 * `WsRouter.publish()` shipped in P3 with zero call sites, so `/ws` delivered replay and
 * then silence. These tests pin the wiring, not the router — the router was always
 * correct. What was missing was anything calling it, and unit tests happily pass on
 * unreachable code, which is how eight components got through.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { publishOnAppend, type EventPublisher } from '../events/publish-to-subscribers.js';
import type { Event, EventInput, EventSink } from '../kernel/types.js';

function fakeSink(onAppend?: () => void): EventSink & { appended: EventInput[] } {
  let seq = 0;
  const appended: EventInput[] = [];
  return {
    appended,
    name: 'PostgresEventSink',
    async append(event: EventInput): Promise<Event> {
      onAppend?.();
      appended.push(event);
      return {
        eventId: `e${seq}`,
        runId: event.runId,
        seq: seq++,
        type: event.type,
        payload: event.payload ?? {},
        createdAt: new Date(0).toISOString(),
      };
    },
    async read(): Promise<Event[]> {
      return [];
    },
  };
}

const recorder = (): EventPublisher & { seen: Event[] } => {
  const seen: Event[] = [];
  return { seen, publish: (e) => seen.push(e) };
};

describe('publish on append', () => {
  test('every appended Event is published', async () => {
    const pub = recorder();
    const sink = publishOnAppend(fakeSink(), () => pub);
    await sink.append({ runId: 'r1', type: 'run_start' });
    await sink.append({ runId: 'r1', type: 'run_end' });
    assert.deepEqual(pub.seen.map((e) => e.type), ['run_start', 'run_end']);
  });

  test('the PUBLISHED value is the appended one, with the sink-assigned seq', async () => {
    // R58 — seq is the sink's to assign. A subscriber receiving an Event without it could
    // not detect a gap, which is exactly what P10's broken-log banner depends on.
    const pub = recorder();
    const sink = publishOnAppend(fakeSink(), () => pub);
    const returned = await sink.append({ runId: 'r1', type: 'run_start' });
    assert.equal(pub.seen[0]?.seq, returned.seq);
    assert.equal(pub.seen[0]?.eventId, returned.eventId);
  });

  test('the publisher is resolved PER APPEND, not at construction', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The gateway is created after this sink is
    // registered, so resolving eagerly captures null forever — and the identical mistake
    // with the RetrievalProvider killed every boot with "Kernel accessed before
    // registration completed" while the whole suite stayed green.
    let resolved = 0;
    let publisher: EventPublisher | null = null;
    const sink = publishOnAppend(fakeSink(), () => {
      resolved += 1;
      return publisher;
    });

    assert.equal(resolved, 0, 'constructing must not resolve the publisher');

    // Appending before the gateway exists is fine — nobody can have subscribed yet.
    await sink.append({ runId: 'r1', type: 'run_start' });
    assert.equal(resolved, 1);

    const pub = recorder();
    publisher = pub;
    await sink.append({ runId: 'r1', type: 'user_message' });
    assert.deepEqual(pub.seen.map((e) => e.type), ['user_message']);
  });

  test('the Event is durable BEFORE anyone is told about it', async () => {
    // A subscriber must never observe an Event that failed to persist.
    const order: string[] = [];
    const sink = publishOnAppend(fakeSink(() => order.push('appended')), () => ({
      publish: () => order.push('published'),
    }));
    await sink.append({ runId: 'r1', type: 'run_start' });
    assert.deepEqual(order, ['appended', 'published']);
  });

  test('a failed append publishes NOTHING', async () => {
    const pub = recorder();
    const broken: EventSink = {
      name: 'Broken',
      async append(): Promise<Event> {
        throw new Error('database unreachable');
      },
      async read(): Promise<Event[]> {
        return [];
      },
    };
    const sink = publishOnAppend(broken, () => pub);
    await assert.rejects(sink.append({ runId: 'r1', type: 'run_start' }));
    assert.deepEqual(pub.seen, []);
  });

  test('a throwing subscriber does NOT fail the Run', async () => {
    // The Event is already durable. A dashboard that disconnected mid-Run must not be able
    // to fail the Run it was watching; R7 lets it re-subscribe and replay.
    const sink = publishOnAppend(fakeSink(), () => ({
      publish: () => {
        throw new Error('socket closed');
      },
    }));
    const appended = await sink.append({ runId: 'r1', type: 'run_start' });
    assert.equal(appended.type, 'run_start');
  });

  test('the wrapper delegates `name`, so health reports the real implementation', async () => {
    // Two wrappers deep (P12's MCP teardown, then this) — health must still report what
    // config/plugins.yaml selected, not the outermost wrapper.
    const sink = publishOnAppend(fakeSink(), () => null);
    assert.equal(sink.name, 'PostgresEventSink');
  });
});
