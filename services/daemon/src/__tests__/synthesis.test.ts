/**
 * P8 — the delegation digest and the synthesis Step. Team Orchestration R35-R37; edges 1, 5, 17, 18.
 *
 * The outcome rules of R38 are exercised end to end in team-run.test.ts, because they are a
 * property of the Team Run rather than of this module. What is tested here is what
 * synthesis itself produces, and — the part that is easy to get quietly wrong — what it
 * produces when it CANNOT run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, compactDigest, runSynthesis, skippedSynthesis, type DigestEntry } from '../teams/synthesis.js';
import type { ChatDelta, Event, EventInput, ModelCapabilities } from '../kernel/types.js';

function entry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    alias: 'chef',
    task: 'braise it',
    outcome: 'success',
    final_message: 'braised',
    child_run_id: 'child-1',
    ...over,
  };
}

class RecordingSink {
  readonly name = 'RecordingSink';
  readonly events: Event[] = [];
  private seq = 0;

  async append(event: EventInput): Promise<Event> {
    const e: Event = {
      eventId: `e${this.seq}`,
      runId: event.runId,
      seq: this.seq++,
      type: event.type,
      payload: event.payload ?? {},
      createdAt: '',
    };
    this.events.push(e);
    return e;
  }

  async read(): Promise<Event[]> {
    return this.events;
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

function model(deltas: ChatDelta[] | Error) {
  return {
    name: 'Model',
    async *chat(): AsyncIterable<ChatDelta> {
      if (deltas instanceof Error) throw deltas;
      for (const d of deltas) yield d;
    },
    async capabilities(): Promise<ModelCapabilities> {
      return { toolCalling: true, contextWindow: 32768, toolFormat: 'json_schema' };
    },
  };
}

function input(over: Partial<Parameters<typeof runSynthesis>[0]> = {}) {
  return {
    runId: 'team-run-1',
    model: model([{ content: 'the answer' }]),
    events: new RecordingSink(),
    bindingTag: 'armada/qwen3-0.6b-base',
    systemPrompt: 'You are a manager.',
    synthesisPrompt: 'Write the answer now.',
    task: 'make dinner',
    entries: [entry()],
    contextWindow: 32768,
    reservedOutputTokens: 2048,
    admitModelRequest: async () => ({ queuedMs: 0, release: () => undefined }),
    onModelTokens: () => undefined,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('R35 — the digest', () => {
  test('carries alias, task, outcome and final message for every delegation', () => {
    const digest = JSON.parse(buildDigest([entry(), entry({ alias: 'fe', outcome: 'failed' })]));
    assert.equal(digest.length, 2);
    assert.deepEqual(Object.keys(digest[0]).sort(), [
      'alias',
      'child_run_id',
      'final_message',
      'outcome',
      'task',
    ]);
  });

  test('edge 1 — a manager that never delegated synthesizes over an EMPTY digest', () => {
    // Not an error and not a skip: the Team Run completes as an ordinary Run would.
    assert.match(buildDigest([]), /No subtasks were delegated/);
  });

  test('edge 5 — a digest of nothing but failures is still a digest', () => {
    const digest = buildDigest([
      entry({ outcome: 'failed', final_message: 'crashed' }),
      entry({ outcome: 'incomplete', final_message: 'could not' }),
    ]);
    assert.match(digest, /failed/);
    assert.match(digest, /incomplete/);
  });
});

describe('edge 18 — a digest larger than the manager\'s context', () => {
  test('is compacted OLDEST-FIRST and the newest entry keeps its verbatim message', () => {
    const entries = [
      entry({ alias: 'a', final_message: 'x'.repeat(4000) }),
      entry({ alias: 'b', final_message: 'y'.repeat(4000) }),
      entry({ alias: 'c', final_message: 'z'.repeat(200) }),
    ];
    const { entries: compacted, event } = compactDigest(entries, 200);

    assert.ok(event, 'a compaction Event payload is produced so the caller can append it');
    assert.ok(event.tokens_after < event.tokens_before);
    assert.match(compacted[0]!.final_message, /elided/);
    // The most recent delegation is what the manager is reasoning about.
    assert.equal(compacted[2]!.final_message, 'z'.repeat(200));
  });

  test('an elision names the child run, so the full text stays reachable', () => {
    const { entries } = compactDigest([entry({ final_message: 'q'.repeat(5000) })], 50);
    assert.match(entries[0]!.final_message, /child-1/);
  });

  test('a digest that fits is left exactly alone and appends nothing', () => {
    const entries = [entry()];
    const result = compactDigest(entries, 100_000);
    assert.equal(result.event, null);
    assert.deepEqual(result.entries, entries);
  });

  test('the compaction Event is appended BEFORE the synthesis model request', async () => {
    const events = new RecordingSink();
    await runSynthesis(
      input({ events, entries: [entry({ final_message: 'w'.repeat(200_000) })] }),
    );
    const types = events.types();
    assert.ok(types.indexOf('compaction') >= 0);
    assert.ok(
      types.indexOf('compaction') < types.indexOf('model_request'),
      'the model must see the compacted digest, not be told about it afterwards',
    );
  });
});

describe('R35, R37 — a completed synthesis Step', () => {
  test('returns the model\'s output as the Team Run\'s result', async () => {
    const result = await runSynthesis(input());
    assert.equal(result.result, 'the answer');
    assert.equal(result.skipped, false);
    assert.equal(result.error, undefined);
  });

  test('appends model_request and model_response marked as the synthesis phase', async () => {
    const events = new RecordingSink();
    await runSynthesis(input({ events }));
    const request = events.events.find((e) => e.type === 'model_request');
    assert.equal(request?.payload['phase'], 'synthesis');
    // R35 — synthesis dispatches no tools. The manager has already decided what to do.
    assert.deepEqual(request?.payload['tools'], []);
    // R32 — it is a manager request, so it outranks any worker still queued for the tag.
    assert.equal(request?.payload['priority'], 'manager');
  });

  test('R2 — synthesis_prompt is appended to the persona for this Step only', async () => {
    let seen = '';
    await runSynthesis(
      input({
        model: {
          name: 'Capturing',
          async *chat(request: { messages: { content: string }[] }): AsyncIterable<ChatDelta> {
            seen = request.messages[0]?.content ?? '';
            yield { content: 'ok' };
          },
          async capabilities(): Promise<ModelCapabilities> {
            return { toolCalling: true, contextWindow: 32768, toolFormat: 'json_schema' };
          },
        } as never,
      }),
    );
    assert.match(seen, /You are a manager\./);
    assert.match(seen, /Write the answer now\./);
  });

  test('a model that returns nothing falls back to the digest, never an empty result', async () => {
    const result = await runSynthesis(input({ model: model([{ content: '' }]) }));
    // R37 makes `result` the Team Run's answer; an empty string is not one.
    assert.match(result.result, /braised/);
  });

  test('R25 — synthesis reports its tokens, because it spends tree budget like anything else', async () => {
    let reported = 0;
    await runSynthesis(
      input({
        model: model([{ content: 'ok', promptTokens: 40, completionTokens: 60 }]),
        onModelTokens: (p, c) => (reported = p + c),
      }),
    );
    assert.equal(reported, 100);
  });

  test('the scheduler slot is released even when the model throws', async () => {
    let released = 0;
    await runSynthesis(
      input({
        model: model(new Error('model server unreachable')),
        admitModelRequest: async () => ({ queuedMs: 0, release: () => (released += 1) }),
      }),
    );
    // A leaked slot stalls every subsequent request for the tag with no error to diagnose.
    assert.equal(released, 1);
  });
});

describe('R36, edge 17 — synthesis that does not complete', () => {
  test('R36 — an exhausted tree budget SKIPS synthesis and the digest becomes the output', () => {
    const result = skippedSynthesis([entry()]);
    assert.equal(result.skipped, true);
    assert.match(result.result, /braised/);
    assert.equal(result.error, undefined);
  });

  test('edge 17 — an unreachable model keeps the digest and reports skipped: FALSE', async () => {
    const events = new RecordingSink();
    const result = await runSynthesis(
      input({ events, model: model(new Error('model server unreachable')) }),
    );

    assert.equal(result.skipped, false, 'attempted-and-failed is a different fact from budget-skipped');
    assert.match(result.error ?? '', /unreachable/);
    assert.match(result.result, /braised/, 'the digest is retained as the final message');
    assert.ok(events.events.some((e) => e.type === 'error' && e.payload['phase'] === 'synthesis'));
  });
});
