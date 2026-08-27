/**
 * P6 backfill — hybrid retrieval, injection, and search_knowledge.
 *
 * Agent Runtime R39-R43; edges 9, 10, 11.
 *
 * The SQL is asserted structurally rather than executed: without Postgres, running it would
 * prove nothing, but the shape carries the requirements. R41 is specific — both channels,
 * k*3 candidates each, RRF fusion at rrf_k — and a refactor that quietly dropped the
 * full-text half would still return plausible results, which is the failure mode worth
 * guarding.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import { PgVectorRetrievalProvider, buildInjectionBlock } from '../retrieval/pgvector-provider.js';
import {
  invokeSearchKnowledge,
  validateArgs,
  searchKnowledgeSpec,
} from '../tools/builtin/search-knowledge.js';
import type { Chunk, RetrievalProvider } from '../kernel/types.js';

const estimate = (text: string): number => Math.max(1, Math.floor(text.length / 4));

function capturingPool(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('R41 — hybrid retrieval fused with RRF', () => {
  test('one statement queries BOTH channels and fuses them by rank', async () => {
    const { pool, calls } = capturingPool([
      { chunk_id: 'c1', content: 'alpha', source_path: 'a.md', fused: '0.032', rank: '1' },
    ]);
    const provider = new PgVectorRetrievalProvider(pool, async () => [0.1, 0.2, 0.3]);

    await provider.query('corpus-1', 'how do I configure it', 4);
    const { sql, params } = calls[0]!;

    assert.match(sql, /vector_hits/);
    assert.match(sql, /text_hits/);
    assert.match(sql, /<=>/, 'the vector channel uses cosine distance');
    assert.match(sql, /plainto_tsquery/, 'the full-text channel is present');
    // A chunk found by only ONE channel must still score; an inner join would drop it.
    assert.match(sql, /FULL OUTER JOIN/);
    // RRF fuses RANKS, not scores — cosine distance and ts_rank are incomparable.
    assert.match(sql, /1\.0 \/ \(\$5 \+ v\.rank\)/);
    assert.match(sql, /1\.0 \/ \(\$5 \+ t\.rank\)/);

    assert.equal(params[2], 12, 'k*3 candidates per channel (R41)');
    assert.equal(params[4], 60, 'rrf_k');
    assert.equal(params[5], 4, 'top k returned');
    assert.equal(params[1], '[0.1,0.2,0.3]', 'pgvector literal form');
  });

  test('the provider is READ-ONLY — platform boundary 1', () => {
    const { pool, calls } = capturingPool();
    void new PgVectorRetrievalProvider(pool, async () => [0.1]).query('c', 'q', 1).then(() => {
      // armada-forge owns writing the vector index; the daemon only queries it.
      assert.ok(!/INSERT|UPDATE|DELETE/i.test(calls[0]!.sql));
    });
  });

  test('edge 9 — a zero-chunk corpus returns an empty list rather than throwing', async () => {
    const { pool } = capturingPool([]);
    const provider = new PgVectorRetrievalProvider(pool, async () => [0.1]);
    // Both shipped Agents hit this on a fresh install, so it is the common case at first
    // run, not an error.
    assert.deepEqual(await provider.query('c', 'q', 4), []);
  });

  test('k <= 0 short-circuits without issuing a query', async () => {
    const { pool, calls } = capturingPool();
    await new PgVectorRetrievalProvider(pool, async () => [0.1]).query('c', 'q', 0);
    assert.equal(calls.length, 0);
  });
});

describe('R39 / edge 11 — the injected block', () => {
  const chunk = (n: number, score: number, length = 40): Chunk => ({
    chunkId: `c${n}`,
    content: 'x'.repeat(length),
    sourcePath: `f${n}.md`,
    score,
  });

  const four = [chunk(1, 0.9), chunk(2, 0.5), chunk(3, 0.3), chunk(4, 0.1)];

  test('every chunk is included when the block fits, each citing its source_path', () => {
    const built = buildInjectionBlock(four, 10_000, estimate);
    assert.equal(built.used.length, 4);
    assert.equal(built.chunksDropped, 0);
    // The path is what lets a model cite a claim and an operator check it.
    assert.ok(four.every((c) => built.block!.includes(c.sourcePath)));
  });

  test('an oversize block drops the LOWEST fused scores first', () => {
    const built = buildInjectionBlock(four, 25, estimate);

    assert.ok(built.chunksDropped > 0);
    const droppedScores = four.filter((c) => !built.used.includes(c)).map((c) => c.score);
    // Dropping the worst matches is the only ordering that preserves the point of ranking.
    assert.ok(built.used.every((kept) => kept.score >= Math.max(...droppedScores)));
    assert.ok(estimate(built.block!) <= 25);
  });

  test('edge 9 — zero chunks injects NO block at all', () => {
    // An empty "here is what I found" header spends context to say nothing.
    assert.equal(buildInjectionBlock([], 1000, estimate).block, null);
  });

  test('a single chunk that cannot fit injects nothing rather than a fragment', () => {
    const built = buildInjectionBlock([chunk(1, 0.9, 100_000)], 5, estimate);
    // A truncated fragment would give the model a source_path pointing at content it
    // cannot see.
    assert.equal(built.block, null);
    assert.equal(built.chunksDropped, 1);
  });
});

describe('R40 / R43 — search_knowledge', () => {
  const options = { searchMaxK: 10, defaultK: 4 };
  const hit: Chunk = { chunkId: 'c1', content: 'body', sourcePath: 'f1.md', score: 0.9 };

  function recordingRetrieval(): { provider: RetrievalProvider; asked: number[] } {
    const asked: number[] = [];
    const provider = {
      name: 'stub',
      query: async (_c: string, _q: string, k: number) => {
        asked.push(k);
        return [hit];
      },
    };
    return { provider, asked };
  }

  test('the schema states the ceiling', () => {
    const spec = searchKnowledgeSpec(options);
    const params = spec.parameters as { properties: { k: { maximum: number } } };
    assert.equal(params.properties.k.maximum, 10);
  });

  test('k is CLAMPED to search_max_k, not rejected', async () => {
    const { provider, asked } = recordingRetrieval();
    await invokeSearchKnowledge(provider, 'corpus-1', { query: 'x', k: 50 }, options);
    // A model asking for 50 gets a usable answer instead of spending a Step learning a
    // limit the schema already states.
    assert.equal(asked[0], 10);
  });

  test('an omitted k falls back to the default', async () => {
    const { provider, asked } = recordingRetrieval();
    await invokeSearchKnowledge(provider, 'corpus-1', { query: 'x' }, options);
    assert.equal(asked[0], 4);
  });

  test('R43 — no bound corpus returns an error RESULT, never a throw', async () => {
    const { provider } = recordingRetrieval();
    const result = await invokeSearchKnowledge(provider, null, { query: 'x' }, options);
    assert.equal(result.result.isError, true);
  });

  test('R30 — bad arguments are an error result so the loop continues', async () => {
    const { provider } = recordingRetrieval();
    const result = await invokeSearchKnowledge(provider, 'c', { query: '' }, options);
    assert.equal(result.result.isError, true);
    assert.equal(validateArgs('nope').ok, false);
    assert.equal(validateArgs({ query: 'x', k: 1.5 }).ok, false);
  });

  test('edge 10 — a retrieval failure is an error result naming the cause', async () => {
    const failing: RetrievalProvider = {
      name: 'failing',
      query: async () => {
        throw new Error('db unreachable');
      },
    };
    const result = await invokeSearchKnowledge(failing, 'c', { query: 'x' }, options);
    // The Run is NOT terminated; the caller additionally appends an `error` Event.
    assert.equal(result.result.isError, true);
    assert.match(result.result.content, /db unreachable/);
  });

  test('edge 9 — zero hits is NOT an error', async () => {
    const empty: RetrievalProvider = { name: 'empty', query: async () => [] };
    const result = await invokeSearchKnowledge(empty, 'c', { query: 'x' }, options);
    // Saying so plainly stops the model retrying the same query and tripping no-progress.
    assert.notEqual(result.result.isError, true);
    assert.deepEqual(result.chunks, []);
  });

  test('a successful call returns chunks for the R42 retrieval Event and cites the path', async () => {
    const { provider } = recordingRetrieval();
    const result = await invokeSearchKnowledge(provider, 'c', { query: 'x' }, options);
    assert.equal(result.chunks.length, 1);
    assert.match(result.result.content, /f1\.md/);
  });
});
