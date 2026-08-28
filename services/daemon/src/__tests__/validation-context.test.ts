/**
 * P7 — the ValidationContext an Agent write resolves against. Agent Definition R12, edge 16.
 *
 * THE PROPERTY WORTH PINNING IS THE FAILURE MODE, NOT THE SUCCESS PATH. If forge is
 * unreachable and this returned empty lists instead of throwing, validation would still
 * "work": every binding and corpus reference would resolve to "does not exist", and a
 * perfectly good definition would be rejected with a confident, specific, and entirely
 * wrong list of errors. The operator would go and edit a correct file.
 *
 * That is the same shape as three defects already in this repo's history — a true-looking
 * report naming the wrong cause. So the unreachable cases below outnumber the happy one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createContextProvider } from '../agents/validation-context.js';
import { UpstreamUnavailable } from '../gateway/routes/agents.js';

const BINDINGS = [{ tag: 'armada/qwen3-0.6b-base', status: 'promoted', materialized: true }];
const CORPORA = [{ corpus_id: 'c1', name: 'recipes', chunk_count: 12 }];

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((input: unknown) => Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function provider(fetchImpl: typeof fetch, runtimeConfig: Record<string, unknown> = {}) {
  return createContextProvider({
    forgeUrl: 'http://forge:8000',
    runtimeConfig,
    sandboxProfiles: { default: {} },
    mcpServers: [],
    fetchImpl,
  });
}

describe('validation context', () => {
  test('fans out to both forge endpoints and merges with config', async () => {
    const seen: string[] = [];
    const getContext = provider(
      fakeFetch((url) => {
        seen.push(url);
        return url.endsWith('/models/bindings') ? ok(BINDINGS) : ok(CORPORA);
      }),
      {
        budgets: { max_steps: 40, max_model_tokens: 200000, max_wall_clock_seconds: 1800, max_tool_calls: 120 },
        budget_ceilings: { max_steps: 200, max_model_tokens: 2000000, max_wall_clock_seconds: 14400, max_tool_calls: 600 },
        context: { reserved_output_tokens: 2048 },
        retrieval: { auto_inject_k: 4 },
      },
    );

    const ctx = await getContext();

    assert.deepEqual(seen.sort(), [
      'http://forge:8000/corpora',
      'http://forge:8000/models/bindings',
    ]);
    assert.equal(ctx.bindings.length, 1);
    assert.equal(ctx.corpora[0]?.name, 'recipes');
    assert.equal(ctx.budgetCeilings.max_steps, 200);
    assert.equal(ctx.budgetDefaults.max_steps, 40);
    assert.equal(ctx.reservedOutputTokens, 2048);
    assert.equal(ctx.autoInjectK, 4);
  });

  test('a refused connection is UpstreamUnavailable, never an empty context', async () => {
    const getContext = provider(
      fakeFetch(() => {
        throw new Error('connect ECONNREFUSED 172.18.0.3:8000');
      }),
    );

    await assert.rejects(getContext(), (err: unknown) => {
      assert.ok(err instanceof UpstreamUnavailable);
      assert.equal(err.service, 'forge');
      // The transport detail survives, so an operator sees the cause and not just "503".
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    });
  });

  test('a 5xx from forge is also UpstreamUnavailable, naming the status', async () => {
    const getContext = provider(fakeFetch(() => new Response('nope', { status: 502 })));
    await assert.rejects(getContext(), (err: unknown) => {
      assert.ok(err instanceof UpstreamUnavailable);
      assert.match(err.message, /502/);
      return true;
    });
  });

  test('ONE endpoint failing fails the whole context', async () => {
    // Bindings resolve and corpora do not. A context built from the half that answered
    // would reject every `corpus.name` as nonexistent while accepting bindings — the
    // partially-true report that is worse than no report.
    const getContext = provider(
      fakeFetch((url) =>
        url.endsWith('/models/bindings') ? ok(BINDINGS) : new Response('down', { status: 503 }),
      ),
    );
    await assert.rejects(getContext(), (err: unknown) => err instanceof UpstreamUnavailable);
  });

  test('a config missing budget keys falls back to shipped numbers, not undefined', async () => {
    // `undefined` compares false against every ceiling check, which would silently disable
    // the R31a clamp rather than enforcing a documented value.
    const getContext = provider(
      fakeFetch((url) => (url.endsWith('/models/bindings') ? ok(BINDINGS) : ok(CORPORA))),
      {},
    );
    const ctx = await getContext();
    for (const key of ['max_steps', 'max_model_tokens', 'max_wall_clock_seconds', 'max_tool_calls'] as const) {
      assert.equal(typeof ctx.budgetCeilings[key], 'number', `${key} ceiling`);
      assert.equal(typeof ctx.budgetDefaults[key], 'number', `${key} default`);
      assert.ok(ctx.budgetCeilings[key] >= ctx.budgetDefaults[key], `${key}: ceiling >= default`);
    }
  });
});
