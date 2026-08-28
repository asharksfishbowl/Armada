/**
 * P7 — the single ToolProvider the Kernel registers. Agent Runtime R10, R29, R30, R43.
 *
 * The property under test is MERGING WITHOUT LEAKING THE SEAM: the loop asks one thing
 * what tools a Run has, and never learns the answer came from two sources. The failure
 * modes worth pinning are the ones where a seam shows — a tool offered that cannot work,
 * and a granted name that no source implements.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CompositeToolProvider } from '../tools/composite-provider.js';
import type { Chunk, RetrievalProvider, RunContext } from '../kernel/types.js';

const retrieval: RetrievalProvider = {
  name: 'stub',
  async query(_corpusId: string, _text: string, k: number): Promise<Chunk[]> {
    return Array.from({ length: k }, (_, i) => ({
      chunkId: `c${i}`,
      content: `chunk ${i}`,
      sourcePath: 'doc.md',
      score: 1 - i / 10,
    }));
  },
};

function provider(granted: string[]) {
  return new CompositeToolProvider({
    grantsFor: async () => granted,
    retrieval: () => retrieval,
    searchOptions: { searchMaxK: 10, defaultK: 4 },
  });
}

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'r1',
  agentVersionId: 'v1',
  mode: 'standard',
  corpusId: 'corpus-1',
  ...over,
});

describe('plugin construction order', () => {
  test('the RetrievalProvider is NOT resolved at construction', () => {
    // THE TEST THAT WAS MISSING. This provider and the RetrievalProvider are registered by
    // the same `Kernel.register` call, so while a factory is running the Kernel does not
    // exist. The first version resolved the dependency in the factory body and every boot
    // died with "Kernel accessed before registration completed".
    //
    // The whole suite passed anyway — 187 tests — because they construct this class
    // directly with a real provider and never exercise the factory. Only the smoke test
    // found it. This pins the property those tests could not see.
    let resolved = 0;
    const provider = new CompositeToolProvider({
      grantsFor: async () => ['shell'],
      retrieval: () => {
        resolved += 1;
        return retrieval;
      },
      searchOptions: { searchMaxK: 10, defaultK: 4 },
    });

    assert.equal(resolved, 0, 'constructing must not resolve the RetrievalProvider');
    assert.ok(provider);
  });

  test('and it is not resolved by listing tools either', async () => {
    // list() runs on every Step. Resolving a plugin there would be wasteful, but more to
    // the point it would reintroduce the ordering coupling by a different route.
    let resolved = 0;
    const provider = new CompositeToolProvider({
      grantsFor: async () => ['shell', 'search_knowledge'],
      retrieval: () => {
        resolved += 1;
        return retrieval;
      },
      searchOptions: { searchMaxK: 10, defaultK: 4 },
    });

    await provider.list(ctx());
    assert.equal(resolved, 0, 'listing must not resolve the RetrievalProvider');

    // Only an actual search does.
    await provider.invoke('search_knowledge', { query: 'x' }, ctx());
    assert.equal(resolved, 1);
  });
});

describe('CompositeToolProvider.list', () => {
  test('merges built-ins and search_knowledge behind one interface', async () => {
    const names = (await provider(['shell', 'finish', 'search_knowledge']).list(ctx())).map((s) => s.name);
    assert.ok(names.includes('shell'));
    assert.ok(names.includes('finish'));
    assert.ok(names.includes('search_knowledge'));
  });

  test('only the granted built-ins are offered', async () => {
    const names = (await provider(['finish']).list(ctx())).map((s) => s.name);
    assert.deepEqual(names, ['finish']);
  });

  test('search_knowledge is withheld when no Corpus is bound (R43)', async () => {
    // Offering it would invite a call that can only fail, spending a Step to learn
    // something the tool list already knew.
    const names = (await provider(['shell', 'search_knowledge']).list(ctx({ corpusId: null })))
      .map((s) => s.name);
    assert.deepEqual(names, ['shell']);
  });

  test('a granted MCP server is absent when no MCP source is configured, not faked', async () => {
    // MCP is OPT-IN and ships disabled: config/mcp-servers.yaml declares no server, so a
    // default installation constructs no session manager work at all. A grant that cannot
    // be served must produce a name the model never sees, never a placeholder.
    const names = (await provider(['shell', 'github__*']).list(ctx())).map((s) => s.name);
    assert.deepEqual(names, ['shell']);
  });
});

describe('R51 — the MCP source is the third tool source', () => {
  /** Stands in for McpSessionManager. Its own behaviour is covered by mcp-session.test.ts. */
  function withMcp(granted: string[], seen: { servers?: string[]; invoked?: string } = {}) {
    return new CompositeToolProvider({
      grantsFor: async () => granted,
      retrieval: () => retrieval,
      searchOptions: { searchMaxK: 10, defaultK: 4 },
      mcp: {
        async list(_ctx, servers) {
          seen.servers = servers;
          return servers.map((server) => ({
            name: `${server}__ping`,
            description: 'ping',
            parameters: { type: 'object' },
          }));
        },
        async invoke(_ctx, name) {
          seen.invoked = name;
          return { content: `dispatched ${name}` };
        },
      },
    });
  }

  test('merges MCP tools with built-ins behind ONE interface', async () => {
    const names = (await withMcp(['shell', 'finish', 'github__*', 'docs__*']).list(ctx())).map(
      (s) => s.name,
    );
    assert.deepEqual(names, ['shell', 'finish', 'github__ping', 'docs__ping']);
  });

  test('the SERVERS come from the pinned snapshot, never from config (invariant 2)', async () => {
    const seen: { servers?: string[] } = {};
    await withMcp(['finish', 'github__*'], seen).list(ctx());
    assert.deepEqual(seen.servers, ['github']);
  });

  test('a namespaced call is dispatched to the MCP source', async () => {
    const seen: { invoked?: string } = {};
    const result = await withMcp(['github__*'], seen).invoke('github__ping', {}, ctx());
    assert.equal(seen.invoked, 'github__ping');
    assert.equal(result.content, 'dispatched github__ping');
  });

  test('a namespaced call with no MCP grant takes the R29 path, not the built-in one', async () => {
    // `dispatchBuiltin` would answer "is not a built-in tool", which tells a model nothing
    // about why its MCP call failed.
    const result = await withMcp(['shell']).invoke('github__ping', {}, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /unknown tool `github__ping`/);
    assert.match(result.content, /shell/);
  });

  test('the MCP branch cannot capture a built-in — none carries the `__` separator', async () => {
    const seen: { invoked?: string } = {};
    const result = await withMcp(['finish', 'github__*'], seen).invoke(
      'finish',
      { success: true, summary: 'done' },
      ctx(),
    );
    assert.equal(seen.invoked, undefined);
    assert.equal(result.content, 'done');
  });
});

describe('CompositeToolProvider.invoke', () => {
  test('search_knowledge reaches the retrieval provider', async () => {
    const result = await provider(['search_knowledge']).invoke(
      'search_knowledge',
      { query: 'braising' },
      ctx(),
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content, /chunk 0/);
  });

  test('an ungranted search_knowledge is an error result, not a throw (R29)', async () => {
    const result = await provider(['shell']).invoke('search_knowledge', { query: 'x' }, ctx());
    assert.equal(result.isError, true);
    // Names what IS available, so the model can correct itself rather than guess again.
    assert.match(result.content, /shell/);
  });

  test('search_knowledge without a Corpus errors and the Run continues (R43)', async () => {
    const result = await provider(['search_knowledge']).invoke(
      'search_knowledge',
      { query: 'x' },
      ctx({ corpusId: null }),
    );
    assert.equal(result.isError, true);
  });

  test('an unknown tool never terminates the Run (R29)', async () => {
    const result = await provider(['shell']).invoke('teleport', {}, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /unknown tool/);
  });

  test('invalid arguments are an error result, not a throw (R30)', async () => {
    const result = await provider(['search_knowledge']).invoke('search_knowledge', { query: 42 }, ctx());
    assert.equal(result.isError, true);
  });
});
