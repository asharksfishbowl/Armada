/**
 * P7 — the Step cycle. Agent Runtime R19-R25, R31-R34, R55-R58.
 *
 * Built around the build plan's P7 EXIT CRITERIA, which are the four properties the phase
 * is defined by:
 *
 *   finish(success: true)  -> success
 *   finish(success: false) -> incomplete
 *   max_steps: 3           -> budget_exhausted naming max_steps
 *   unmaterialized binding -> fails at start naming the tag   (binding-verifier, R17/D4)
 *
 * Everything is driven through the plugin interfaces, which is also the point: this suite
 * constructs no concrete implementation, exactly as R15 requires of the loop itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runAgentLoop, type AgentLoopPlugins } from '../runtime/agent-loop.js';
import type {
  ChatDelta,
  Chunk,
  Event,
  EventInput,
  ModelCapabilities,
  RunContext,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';

/** Captures the append-only stream so tests can assert on it (invariant 5). */
class RecordingSink {
  readonly name = 'RecordingSink';
  readonly events: Event[] = [];
  private seq = 0;

  async append(event: EventInput): Promise<Event> {
    // `seq` is the SINK's to assign (R58). Mirrored here so ordering assertions are
    // meaningful.
    const e: Event = {
      eventId: `e${this.seq}`,
      runId: event.runId,
      seq: this.seq++,
      type: event.type,
      payload: event.payload ?? {},
      createdAt: new Date(0).toISOString(),
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

/** Emits a scripted sequence of turns, one per Step. */
function scriptedModel(turns: ChatDelta[][]) {
  let turn = 0;
  return {
    name: 'ScriptedModel',
    async *chat(): AsyncIterable<ChatDelta> {
      const deltas = turns[Math.min(turn++, turns.length - 1)] ?? [];
      for (const d of deltas) yield d;
      yield { done: true };
    },
    async capabilities(): Promise<ModelCapabilities> {
      return { toolCalling: true, contextWindow: 32768, toolFormat: 'json_schema' };
    },
  };
}

function toolProvider(
  invoke: (name: string, args: unknown) => Promise<ToolResult> | ToolResult,
  specs: string[] = ['finish', 'shell'],
) {
  return {
    name: 'StubTools',
    async list(): Promise<ToolSpec[]> {
      return specs.map((n) => ({ name: n, description: n, parameters: {} }));
    },
    async invoke(name: string, args: unknown): Promise<ToolResult> {
      return invoke(name, args);
    },
  };
}

const noRetrieval = {
  name: 'NoRetrieval',
  async query(): Promise<Chunk[]> {
    return [];
  },
};

const call = (name: string, args: unknown, id = 'c1'): ChatDelta => ({
  toolCall: { id, name, arguments: args },
});

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'run-1',
  agentVersionId: 'ver-1',
  mode: 'standard',
  corpusId: null,
  ...over,
});

function input(over: Partial<Parameters<typeof runAgentLoop>[1]> = {}) {
  return {
    ctx: ctx(),
    bindingTag: 'armada/qwen3-0.6b-base',
    systemPrompt: 'You are a test agent.',
    userMessage: 'do the thing',
    contextWindow: 32768,
    reservedOutputTokens: 2048,
    budgets: {
      max_steps: 40,
      max_model_tokens: 200000,
      max_wall_clock_seconds: 1800,
      max_tool_calls: 120,
    },
    noProgressThreshold: 3,
    autoInjectK: 0,
    maxConcurrentTools: 4,
    signal: new AbortController().signal,
    ...over,
  };
}

function plugins(over: Partial<AgentLoopPlugins> & { events: RecordingSink }): AgentLoopPlugins {
  return {
    model: scriptedModel([[]]),
    tools: toolProvider(() => ({ content: 'ok' })),
    retrieval: noRetrieval,
    ...over,
  } as AgentLoopPlugins;
}

describe('P7 exit criteria', () => {
  test('finish(success: true) records success — the ONLY path to it (invariant 1, R25)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('finish', { success: true, summary: 'done' })]]),
        tools: toolProvider(() => ({ content: 'done' })),
      }),
      input(),
    );
    assert.equal(result.outcome, 'success');
  });

  test('finish(success: false) records INCOMPLETE, not failed (edge 20a)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('finish', { success: false, summary: 'could not' })]]),
        tools: toolProvider(() => ({ content: 'could not' })),
      }),
      input(),
    );
    // `failed` is reserved for infrastructure faults. Conflating them would make an honest
    // negative indistinguishable from a crash.
    assert.equal(result.outcome, 'incomplete');
  });

  test('max_steps: 3 records budget_exhausted NAMING max_steps (R31, R57)', async () => {
    const events = new RecordingSink();
    // Never finishes: always asks for a tool, so only the budget can stop it.
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { command: 'a' }, 'c1')],
          [call('shell', { command: 'b' }, 'c2')],
          [call('shell', { command: 'c' }, 'c3')],
          [call('shell', { command: 'd' }, 'c4')],
        ]),
        tools: toolProvider(() => ({ content: 'ran' })),
      }),
      input({ budgets: { max_steps: 3, max_model_tokens: 200000, max_wall_clock_seconds: 1800, max_tool_calls: 120 } }),
    );
    assert.equal(result.outcome, 'budget_exhausted');
    assert.equal(result.budgetHit, 'max_steps');
    assert.equal(result.steps, 3, 'the budget is PREVENTED, never exceeded (R34)');
  });

  test('a Step with no tool calls ends the Turn as incomplete, never success (R21)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({ events, model: scriptedModel([[{ content: 'here is my answer' }]]) }),
      input(),
    );
    // The model answered instead of acting. A termination, but success is self-reported
    // and it never reported.
    assert.equal(result.outcome, 'incomplete');
  });
});

describe('invariant 6 — every Run terminates', () => {
  test('the no-progress detector fires on repeated identical calls (R33)', async () => {
    const events = new RecordingSink();
    // Byte-identical arguments every Step. Note the tool_call ids DIFFER, which is what
    // makes this a real test: comparing the wire ToolCall (which carries a unique id)
    // would never match, and the detector would never fire.
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { command: 'ls' }, 'a')],
          [call('shell', { command: 'ls' }, 'b')],
          [call('shell', { command: 'ls' }, 'c')],
          [call('shell', { command: 'ls' }, 'd')],
        ]),
        tools: toolProvider(() => ({ content: 'same' })),
      }),
      input({ noProgressThreshold: 3 }),
    );
    assert.equal(result.outcome, 'no_progress');
    assert.ok(result.steps < 40, 'must stop well before max_steps');
  });

  test('a model fault is `failed`, distinct from an honest negative', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: {
          name: 'Broken',
          // eslint-disable-next-line require-yield
          async *chat(): AsyncIterable<ChatDelta> {
            throw new Error('model server exploded');
          },
          async capabilities(): Promise<ModelCapabilities> {
            return { toolCalling: true, contextWindow: 1024, toolFormat: 'json_schema' };
          },
        },
      }),
      input(),
    );
    assert.equal(result.outcome, 'failed');
    assert.ok(events.types().includes('error'));
  });

  test('an already-aborted signal cancels before any model call', async () => {
    const events = new RecordingSink();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentLoop(
      plugins({ events, model: scriptedModel([[call('shell', {})]]) }),
      input({ signal: controller.signal }),
    );
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.steps, 0);
  });

  test('max_tool_calls is checked BEFORE each dispatch, not once per Step (R34)', async () => {
    const events = new RecordingSink();
    let invoked = 0;
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { i: 1 }, 'a'), call('shell', { i: 2 }, 'b'), call('shell', { i: 3 }, 'c')],
        ]),
        tools: toolProvider(() => {
          invoked += 1;
          return { content: 'ran' };
        }),
      }),
      input({ budgets: { max_steps: 40, max_model_tokens: 200000, max_wall_clock_seconds: 1800, max_tool_calls: 2 } }),
    );
    assert.equal(result.outcome, 'budget_exhausted');
    assert.equal(result.budgetHit, 'max_tool_calls');
    // A Step emitting three calls must not spend three past a ceiling of two.
    assert.equal(invoked, 2);
  });
});

describe('invariant 5 — the event stream', () => {
  test('opens with run_start, closes with run_end, and seq is gapless', async () => {
    const events = new RecordingSink();
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('finish', { success: true, summary: 'ok' })]]),
        tools: toolProvider(() => ({ content: 'ok' })),
      }),
      input(),
    );
    const types = events.types();
    assert.equal(types[0], 'run_start');
    assert.equal(types[1], 'user_message');
    assert.equal(types.at(-1), 'run_end');
    assert.deepEqual(
      events.events.map((e) => e.seq),
      events.events.map((_, i) => i),
      'gapless per Run (R54)',
    );
  });

  test('every tool call is paired with a tool_result', async () => {
    const events = new RecordingSink();
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { i: 1 }, 'a'), call('shell', { i: 2 }, 'b')],
          [call('finish', { success: true, summary: 'ok' }, 'f')],
        ]),
        tools: toolProvider(() => ({ content: 'ran' })),
      }),
      input(),
    );
    const calls = events.events.filter((e) => e.type === 'tool_call').length;
    const results = events.events.filter((e) => e.type === 'tool_result').length;
    assert.equal(calls, results);
    assert.ok(calls >= 3);
  });

  test('run_end names the budget that stopped the Run (R57)', async () => {
    const events = new RecordingSink();
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('shell', { a: 1 }, 'x')], [call('shell', { b: 2 }, 'y')]]),
        tools: toolProvider(() => ({ content: 'ran' })),
      }),
      input({ budgets: { max_steps: 1, max_model_tokens: 200000, max_wall_clock_seconds: 1800, max_tool_calls: 120 } }),
    );
    const end = events.events.at(-1);
    assert.equal(end?.type, 'run_end');
    assert.equal(end?.payload['budget_hit'], 'max_steps');
  });
});

describe('tool dispatch', () => {
  test('results are appended in MODEL-EMISSION order, not completion order (R24)', async () => {
    const events = new RecordingSink();
    // The FIRST call resolves last. Completion order would put `b` before `a`, and the Run
    // would no longer replay identically from its event stream.
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { n: 'a' }, 'a'), call('shell', { n: 'b' }, 'b')],
          [call('finish', { success: true, summary: 'ok' }, 'f')],
        ]),
        tools: toolProvider(async (name, args) => {
          if (name === 'finish') return { content: 'done' };
          const n = (args as { n?: string }).n;
          // The FIRST call resolves LAST. Completion order would emit b before a.
          if (n === 'a') await new Promise((r) => setTimeout(r, 25));
          return { content: `result-${n}` };
        }),
      }),
      input({ maxConcurrentTools: 4 }),
    );
    const order = events.events
      .filter((e) => e.type === 'tool_result' && String(e.payload['content']).startsWith('result-'))
      .map((e) => e.payload['content']);
    assert.deepEqual(order, ['result-a', 'result-b']);
  });

  test('a throwing tool becomes an error result and the Run continues (R29, R30)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', {}, 'a')],
          [call('finish', { success: true, summary: 'recovered' }, 'f')],
        ]),
        tools: toolProvider((name) => {
          if (name === 'shell') throw new Error('boom');
          return { content: 'recovered' };
        }),
      }),
      input(),
    );
    // A failing tool costs a Step, not a trajectory.
    assert.equal(result.outcome, 'success');
    const errored = events.events.find((e) => e.type === 'tool_result' && e.payload['is_error']);
    assert.ok(errored, 'the failure is recorded as an is_error tool_result');
  });

  test('a MALFORMED finish does not terminate the Turn (edge 20b)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('finish', { summary: 'no success field' }, 'bad')],
          [call('finish', { success: true, summary: 'proper' }, 'good')],
        ]),
        tools: toolProvider((_name, args) => {
          const ok = typeof (args as { success?: unknown }).success === 'boolean';
          return ok ? { content: 'proper' } : { content: '`success` is required', isError: true };
        }),
      }),
      input(),
    );
    assert.equal(result.outcome, 'success');
    assert.equal(result.steps, 2, 'the malformed finish cost a Step and the Turn continued');
  });
});

describe('retrieval auto-injection (R39)', () => {
  test('runs once per Turn when a Corpus is bound', async () => {
    const events = new RecordingSink();
    let queries = 0;
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([
          [call('shell', { a: 1 }, 'a')],
          [call('finish', { success: true, summary: 'ok' }, 'f')],
        ]),
        tools: toolProvider(() => ({ content: 'ok' })),
        retrieval: {
          name: 'Counting',
          async query(_c: string, _t: string, k: number): Promise<Chunk[]> {
            queries += 1;
            return Array.from({ length: k }, (_, i) => ({
              chunkId: `k${i}`,
              content: 'grounding',
              sourcePath: 'a.md',
              score: 1,
            }));
          },
        },
      }),
      input({ ctx: ctx({ corpusId: 'corpus-1' }), autoInjectK: 2 }),
    );
    // Once per TURN, not per Step — re-running against an unchanged query would spend
    // context on duplicates.
    assert.equal(queries, 1);
    assert.ok(events.types().includes('retrieval'));
  });

  test('a retrieval fault DEGRADES the Run rather than ending it (R43)', async () => {
    const events = new RecordingSink();
    const result = await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('finish', { success: true, summary: 'ok' }, 'f')]]),
        tools: toolProvider(() => ({ content: 'ok' })),
        retrieval: {
          name: 'Broken',
          async query(): Promise<Chunk[]> {
            throw new Error('pgvector unreachable');
          },
        },
      }),
      input({ ctx: ctx({ corpusId: 'corpus-1' }), autoInjectK: 4 }),
    );
    // Ungrounded is worse than grounded, and far better than dead.
    assert.equal(result.outcome, 'success');
    const degraded = events.events.find((e) => e.type === 'error' && e.payload['degraded'] === true);
    assert.ok(degraded, 'the degradation is recorded, not swallowed');
  });

  test('no Corpus means no retrieval call at all', async () => {
    const events = new RecordingSink();
    let queries = 0;
    await runAgentLoop(
      plugins({
        events,
        model: scriptedModel([[call('finish', { success: true, summary: 'ok' }, 'f')]]),
        tools: toolProvider(() => ({ content: 'ok' })),
        retrieval: {
          name: 'Counting',
          async query(): Promise<Chunk[]> {
            queries += 1;
            return [];
          },
        },
      }),
      input({ autoInjectK: 4 }),
    );
    assert.equal(queries, 0);
  });
});
