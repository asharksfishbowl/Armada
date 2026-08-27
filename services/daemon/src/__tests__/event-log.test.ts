/**
 * P3 backfill — the event log. Agent Runtime R54-R59, invariant 5.
 *
 * Redaction and seq assignment are properties of the SINK rather than of its callers, so
 * both are unit-testable against a fake pool with no Postgres. The gapless-seq guarantee
 * itself lives in the append_event() SQL function and its trigger, which are integration
 * territory — noted at the bottom rather than faked here.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import { PostgresEventSink, collectCredentialEnvNames } from '../events/event-log.js';

const SECRET = 'sk-supersecret-abcdef123456';

interface Call {
  sql: string;
  params: unknown[];
}

function fakePool(): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ event_id: 'e1', seq: '1' }] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('R59 — redaction lives in the sink, so no caller can forget it', () => {
  beforeEach(() => {
    process.env['TEST_SECRET_TOKEN'] = SECRET;
  });

  test('collects env NAMES from env_keys and api_key_env, never values', () => {
    const names = collectCredentialEnvNames([
      { servers: [{ name: 'github', env_keys: ['TEST_SECRET_TOKEN'] }] },
      { backends: { ollama: { api_key_env: 'TEST_SECRET_TOKEN' } } },
    ]);
    // Config files hold names only (invariant 8); the value lives in the environment.
    assert.deepEqual(names, ['TEST_SECRET_TOKEN']);
  });

  test('a secret is redacted anywhere in the payload, including nested structures', async () => {
    const { pool, calls } = fakePool();
    const sink = new PostgresEventSink(pool, ['TEST_SECRET_TOKEN']);

    await sink.append({
      runId: 'r1',
      type: 'tool_call',
      payload: {
        cmd: `curl -H "Authorization: Bearer ${SECRET}"`,
        nested: { deep: [{ token: SECRET }] },
        safe: 'ordinary text',
      },
    });

    const written = String(calls[0]!.params[2]);
    // Enumerating WHERE a credential might appear is the assumption that leaks, so the
    // sink walks the whole structure rather than checking known fields.
    assert.ok(!written.includes('sk-supersecret'), 'no secret may reach the database');
    assert.equal((written.match(/\[redacted\]/g) ?? []).length, 2);
    assert.ok(written.includes('ordinary text'), 'non-secret text is untouched');
  });

  test('a short env value is NOT treated as a secret', async () => {
    process.env['TEST_SHORT'] = 'ab';
    const { pool, calls } = fakePool();
    const sink = new PostgresEventSink(pool, ['TEST_SHORT']);

    await sink.append({ runId: 'r1', type: 'error', payload: { msg: 'about a table' } });

    // A two-character "secret" would match constantly and shred the event stream while
    // protecting nothing an attacker could not guess.
    assert.ok(String(calls[0]!.params[2]).includes('about a table'));
  });

  test('with no credentials configured the payload passes through unchanged', async () => {
    const { pool, calls } = fakePool();
    const sink = new PostgresEventSink(pool, []);
    await sink.append({ runId: 'r1', type: 'error', payload: { msg: 'hello' } });
    assert.ok(String(calls[0]!.params[2]).includes('hello'));
  });
});

describe('R58 — seq is assigned by the sink, never by a caller', () => {
  test('append goes through append_event() and passes no seq', async () => {
    const { pool, calls } = fakePool();
    const sink = new PostgresEventSink(pool, []);

    await sink.append({ runId: 'r1', type: 'run_start' });

    assert.match(calls[0]!.sql, /append_event/);
    // run_id, type, payload — and nothing else. A caller-supplied seq is exactly what R58
    // exists to make impossible.
    assert.equal(calls[0]!.params.length, 3);
  });

  test('a missing row from append_event raises rather than inventing a seq', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    const sink = new PostgresEventSink(pool, []);
    await assert.rejects(() => sink.append({ runId: 'r1', type: 'run_start' }));
  });

  test('read() orders by seq, not created_at', async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    } as unknown as Pool;

    await new PostgresEventSink(pool, []).read('r1');

    // Two Events written in the same millisecond have a defined order only under seq.
    assert.match(calls[0]!, /ORDER BY seq ASC/);
  });

  test('the sink exposes no update or delete — invariant 5 by construction', () => {
    const sink = new PostgresEventSink({} as Pool, []);
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(sink));
    assert.ok(!surface.some((m) => /update|delete|remove/i.test(m)));
  });
});

// NOT COVERED HERE, and deliberately not faked:
//   - gapless `seq` under real concurrency, which append_event() guarantees with a row
//     lock inside the insert's transaction
//   - the events_no_update / events_no_delete triggers actually rejecting a mutation
// Both need Postgres. A unit test asserting them against a fake pool would prove only that
// the fake behaves as written, which is worse than an honest gap.
