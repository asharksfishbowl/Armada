/**
 * P7 — the daemon's only path to a model. Agent Runtime R9, R16, R17.
 *
 * THE PROPERTIES THAT MATTER ARE THE STREAMING EDGE CASES, not the happy path. A model
 * server that returns one tidy chunk works under any implementation; the ones that break
 * naive parsers are frames split across TCP reads and tool-call arguments split across
 * deltas. Both produce silent corruption rather than an error — a dropped frame looks like
 * a shorter response, and a half-parsed argument object looks like the model asked for
 * something it did not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleAdapter, ModelUnavailableError } from '../models/openai-adapter.js';
import type { ChatDelta } from '../kernel/types.js';

/** Streams the given byte groups, so a test controls exactly where the reads split. */
function sseResponse(groups: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const g of groups) controller.enqueue(encoder.encode(g));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

function adapterOver(handler: (url: string, init?: RequestInit) => Response): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    modelsUrl: 'http://models:11434',
    forgeUrl: 'http://forge:8000',
    fetchImpl: ((input: unknown, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init))) as unknown as typeof fetch,
  });
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

const req = { tag: 'armada/qwen3-0.6b-base', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('OpenAICompatibleAdapter.chat', () => {
  test('streams content deltas and terminates with done', async () => {
    const adapter = adapterOver(() =>
      sseResponse([
        frame({ choices: [{ delta: { content: 'Hel' } }] }),
        frame({ choices: [{ delta: { content: 'lo' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const deltas = await collect(adapter.chat(req, new AbortController().signal));
    assert.deepEqual(
      deltas.filter((d) => d.content).map((d) => d.content),
      ['Hel', 'lo'],
    );
    assert.equal(deltas.at(-1)?.done, true);
  });

  test('a frame split across reads is not dropped', async () => {
    // The exact failure a per-chunk decoder produces: the tail of one frame and the head
    // of the next are lost, and the response is silently shorter.
    const whole = frame({ choices: [{ delta: { content: 'complete' } }] });
    const cut = Math.floor(whole.length / 2);
    const adapter = adapterOver(() => sseResponse([whole.slice(0, cut), whole.slice(cut)]));
    const deltas = await collect(adapter.chat(req, new AbortController().signal));
    assert.deepEqual(deltas.filter((d) => d.content).map((d) => d.content), ['complete']);
  });

  test('tool call arguments split across deltas are reassembled once, not parsed early', async () => {
    const adapter = adapterOver(() =>
      sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const calls = (await collect(adapter.chat(req, new AbortController().signal)))
      .map((d) => d.toolCall)
      .filter(Boolean);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'shell');
    // Parsed once whole. `{"comm` alone would throw; worse, a fragment that happened to be
    // valid JSON would yield a truncated object the loop would dispatch.
    assert.deepEqual(calls[0]?.arguments, { command: 'ls' });
  });

  test('multiple tool calls are emitted in index order', async () => {
    // R24 — history is appended in MODEL-EMISSION order so a Run replays identically from
    // its event stream, regardless of which call completed first.
    const adapter = adapterOver(() =>
      sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const names = (await collect(adapter.chat(req, new AbortController().signal)))
      .map((d) => d.toolCall?.name)
      .filter(Boolean);
    assert.deepEqual(names, ['first', 'second']);
  });

  test('usage is surfaced, because max_model_tokens is unenforceable without it', async () => {
    const adapter = adapterOver(() =>
      sseResponse([
        frame({ choices: [{ delta: { content: 'x' } }] }),
        frame({ usage: { prompt_tokens: 11, completion_tokens: 4 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const deltas = await collect(adapter.chat(req, new AbortController().signal));
    const usage = deltas.find((d) => d.promptTokens !== undefined);
    assert.equal(usage?.promptTokens, 11);
    assert.equal(usage?.completionTokens, 4);
  });

  test('include_usage is requested, or the budget would count zero forever', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = adapterOver((_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['data: [DONE]\n\n']);
    });
    await collect(adapter.chat(req, new AbortController().signal));
    assert.deepEqual(sent['stream_options'], { include_usage: true });
    assert.equal(sent['model'], 'armada/qwen3-0.6b-base');
  });

  test('an empty tool list is omitted rather than sent as []', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = adapterOver((_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse(['data: [DONE]\n\n']);
    });
    await collect(adapter.chat({ ...req, tools: [] }, new AbortController().signal));
    // Some servers read `tools: []` as "tool calling available, nothing offered" and emit
    // a call to a tool that does not exist.
    assert.ok(!('tools' in sent), 'tools key must be absent');
  });

  test('a malformed frame is skipped, not fatal', async () => {
    const adapter = adapterOver(() =>
      sseResponse([
        'data: {not json\n\n',
        frame({ choices: [{ delta: { content: 'survived' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const deltas = await collect(adapter.chat(req, new AbortController().signal));
    assert.deepEqual(deltas.filter((d) => d.content).map((d) => d.content), ['survived']);
  });

  test('a non-2xx names the tag', async () => {
    const adapter = adapterOver(() => new Response('nope', { status: 503 }));
    await assert.rejects(collect(adapter.chat(req, new AbortController().signal)), (err: unknown) => {
      assert.ok(err instanceof ModelUnavailableError);
      assert.match(err.message, /armada\/qwen3-0\.6b-base/);
      return true;
    });
  });
});

describe('OpenAICompatibleAdapter.capabilities', () => {
  const BINDINGS = [
    { tag: 'armada/qwen3-0.6b-base', context_window: 32768, tool_format: 'json_schema', status: 'promoted', materialized: true },
  ];

  test('reads the binding from forge, which owns the registry', async () => {
    const adapter = adapterOver((url) => {
      // NOT the model server: the binding is the pinned contract, the server is one
      // implementation of it, and they can disagree.
      assert.equal(url, 'http://forge:8000/models/bindings');
      return new Response(JSON.stringify(BINDINGS), { status: 200 });
    });
    const caps = await adapter.capabilities('armada/qwen3-0.6b-base');
    assert.equal(caps.contextWindow, 32768);
    assert.equal(caps.toolFormat, 'json_schema');
  });

  test('an unregistered tag is named, with the action to take', async () => {
    const adapter = adapterOver(() => new Response(JSON.stringify(BINDINGS), { status: 200 }));
    await assert.rejects(adapter.capabilities('armada/gone-v3'), (err: unknown) => {
      assert.ok(err instanceof ModelUnavailableError);
      assert.match(err.message, /armada\/gone-v3/);
      assert.match(err.message, /refresh-bindings/);
      return true;
    });
  });

  test('forge unreachable is ModelUnavailableError, not a silent default', async () => {
    const adapter = adapterOver(() => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(adapter.capabilities('any'), (e: unknown) => e instanceof ModelUnavailableError);
  });
});
