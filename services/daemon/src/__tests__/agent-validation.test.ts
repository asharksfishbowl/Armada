/**
 * P4 backfill — the Agent definition schema and reference resolution.
 *
 * Agent Definition R7, R11, R12, R14a, R16, R19-R21, R24; edges 1, 2, 8, 14.
 *
 * The property most worth pinning is R12's ACCUMULATION ACROSS BOTH PASSES. It regressed
 * once already during P4: an early return meant a structural fault hid every reference
 * fault, so a bad `name` concealed a nonexistent Corpus until the operator's next save.
 * Single-fault tests all passed while that was broken, which is exactly why the
 * multiple-fault test below exists.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { validateStructure } from '../agents/definition-schema.js';
import { validate, type ModelBinding, type ValidationContext } from '../agents/validator.js';
import { buildSnapshot, diffSnapshots, resolveTools } from '../agents/resolver.js';

const AGENTS_DIR = new URL('../../../../agents/', import.meta.url).pathname;

function binding(id: string, extra: Partial<ModelBinding> = {}): ModelBinding {
  return {
    tag: `armada/${id}-base`,
    backend: 'ollama',
    base_model_id: id,
    corpus_name: 'base',
    adapter_id: null,
    version: null,
    context_window: 32768,
    tool_format: 'hermes',
    materialized: false,
    materialization_status: 'absent',
    status: 'promoted',
    ...extra,
  };
}

/** A fresh installation: seeded Corpora with ZERO chunks, and a promoted Adapter present. */
const ctx: ValidationContext = {
  bindings: [
    binding('qwen3-4b-instruct'),
    binding('qwen3-0.6b'),
    {
      ...binding('qwen3-4b-instruct'),
      tag: 'armada/qwen3-4b-instruct-frontend-docs-v2',
      adapter_id: 'ad-2',
      version: 2,
      corpus_name: 'frontend-docs',
    },
  ],
  corpora: [
    { corpus_id: 'c-1', name: 'frontend-docs', chunk_count: 0 },
    { corpus_id: 'c-2', name: 'recipes', chunk_count: 0 },
  ],
  sandboxProfiles: {
    node: { image: 'node:22-bookworm-slim', read_only_root: false },
    minimal: { image: 'debian:bookworm-slim', read_only_root: true },
  },
  mcpServers: [],
  budgetCeilings: {
    max_steps: 200,
    max_model_tokens: 2000000,
    max_wall_clock_seconds: 14400,
    max_tool_calls: 600,
  },
  budgetDefaults: {
    max_steps: 40,
    max_model_tokens: 200000,
    max_wall_clock_seconds: 1800,
    max_tool_calls: 120,
  },
  codeModeMinContext: 16384,
  reservedOutputTokens: 2048,
  autoInjectK: 4,
};

function loadShipped(name: string): unknown {
  return parseYaml(readFileSync(`${AGENTS_DIR}${name}.yaml`, 'utf8'));
}

describe('R36/R37 — both shipped examples work on a FRESH installation', () => {
  for (const name of ['frontend-engineer', 'chef']) {
    test(`${name}.yaml validates with the zero-chunk WARNING, not an error`, () => {
      const result = validate(loadShipped(name), ctx);

      assert.deepEqual(result.errors, [], 'a shipped example must never fail to load');
      // R37 — seeded Corpora are empty, so both examples must be runnable immediately with
      // retrieval simply returning nothing.
      assert.ok(result.warnings.some((w) => w.includes('zero chunks')));
    });

    test(`${name}.yaml contains no generated uuid (invariant 4)`, () => {
      const raw = readFileSync(`${AGENTS_DIR}${name}.yaml`, 'utf8');
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw));
    });
  }

  test('R14a — adapter: none resolves the BASE tag, not a promoted adapter', () => {
    const result = validate(loadShipped('frontend-engineer'), ctx);
    // A promoted Adapter for this base model IS present in the context, so this would
    // silently pick it up if `none` were mishandled.
    assert.equal(result.resolved?.binding.tag, 'armada/qwen3-4b-instruct-base');
  });

  test('chef grants exactly read_file, write_file, search_knowledge, finish', () => {
    const result = validate(loadShipped('chef'), ctx);
    const snapshot = buildSnapshot(
      result.definition!,
      result.resolved!.binding,
      result.resolved!.corpusId,
      result.warnings,
      ctx,
    );
    assert.deepEqual(snapshot.tools, ['finish', 'read_file', 'search_knowledge', 'write_file']);
  });
});

describe('R24 — the snapshot is complete enough to make invariant 2 real', () => {
  test('effective sandbox VALUES are pinned, not just the profile name', () => {
    const result = validate(loadShipped('chef'), ctx);
    const snapshot = buildSnapshot(
      result.definition!,
      result.resolved!.binding,
      result.resolved!.corpusId,
      [],
      ctx,
    );
    // A Run that re-read config/sandbox-profiles.yaml would be following a LIVE reference,
    // and the pin would be fiction.
    assert.equal(snapshot.sandbox['image'], 'debian:bookworm-slim');
    assert.equal(snapshot.corpus_id, 'c-2');
  });

  test('budgets merge Agent overrides over config defaults', () => {
    const withOverride = validate(loadShipped('frontend-engineer'), ctx);
    const snapshot = buildSnapshot(
      withOverride.definition!,
      withOverride.resolved!.binding,
      null,
      [],
      ctx,
    );
    assert.equal(snapshot.budgets.max_steps, 60, 'the Agent override wins');
    assert.equal(snapshot.budgets.max_tool_calls, 120, 'unset keys take the default');
  });
});

describe('R12 — every error, across BOTH passes', () => {
  test('structural AND reference faults are returned together', () => {
    const chef = loadShipped('chef') as Record<string, unknown>;
    const broken = {
      ...chef,
      name: 'BAD NAME',                       // structural
      sandbox: { profile: 'nope' },           // reference
      corpus: { name: 'missing-corpus' },     // reference
    };

    const paths = validate(broken, ctx).errors.map((e) => e.path);

    // THE REGRESSION GUARD. An early return on structural failure passes every
    // single-fault test while silently hiding these two.
    assert.ok(paths.includes('name'));
    assert.ok(paths.includes('sandbox.profile'));
    assert.ok(paths.includes('corpus.name'));
  });

  test('an unresolvable reference lists what IS available', () => {
    const chef = loadShipped('chef') as Record<string, unknown>;
    const result = validate({ ...chef, sandbox: { profile: 'nope' } }, ctx);
    const message = result.errors.find((e) => e.path === 'sandbox.profile')?.message ?? '';
    assert.ok(message.includes('minimal') && message.includes('node'));
  });
});

describe('R11 — the schema is closed at every depth', () => {
  const chef = () => loadShipped('chef') as Record<string, unknown>;

  test('an unknown top-level key names it', () => {
    assert.ok(validateStructure({ ...chef(), colour: 'blue' }).errors.some((e) => e.path === 'colour'));
  });

  test('an unknown NESTED key names the full path', () => {
    const errors = validateStructure({
      ...chef(),
      persona: { system_prompt: 'x', tone: 'warm' },
    }).errors;
    // A permissive schema would swallow this and the operator would never learn.
    assert.ok(errors.some((e) => e.path === 'persona.tone'));
  });

  test('an unknown budget key names the full path', () => {
    const errors = validateStructure({ ...chef(), runtime: { budgets: { max_stepz: 5 } } }).errors;
    assert.ok(errors.some((e) => e.path === 'runtime.budgets.max_stepz'));
  });
});

describe('edges 1 and 2 — the version gate', () => {
  test('an omitted schema_version fails naming the missing key rather than defaulting', () => {
    const { schema_version, ...rest } = loadShipped('chef') as Record<string, unknown>;
    void schema_version;
    assert.ok(
      validateStructure(rest).errors.some(
        (e) => e.path === 'schema_version' && e.message.includes('missing'),
      ),
    );
  });

  test('a FUTURE schema_version fails naming the supported one', () => {
    const errors = validateStructure({ ...(loadShipped('chef') as object), schema_version: 2 }).errors;
    // A future format must never be silently misread as this one.
    assert.ok(errors.some((e) => e.message.includes('supports 1')));
  });
});

describe('R7 / edge 8 — finish is non-deniable', () => {
  test('tools.denied: [finish] is rejected naming why', () => {
    const chef = loadShipped('chef') as Record<string, unknown>;
    const tools = { ...(chef['tools'] as object), denied: ['finish'] };
    const errors = validateStructure({ ...chef, tools }).errors;
    assert.ok(errors.some((e) => e.message.includes('non-deniable')));
  });

  test('and it is re-added even if a definition reached the resolver another way', () => {
    // Invariant 1 makes finish the ONLY route to a `success` outcome, so an Agent without
    // it would be structurally incapable of succeeding while looking valid.
    const tools = resolveTools(
      { tools: { builtin: ['read_file'], denied: ['finish'] } } as never,
      false,
      'standard',
    );
    assert.ok(tools.includes('finish'));
  });

  test('search_knowledge is granted only to a Standard-mode Agent with a corpus', () => {
    assert.ok(resolveTools({ tools: {} } as never, true, 'standard').includes('search_knowledge'));
    // R27a — a Code-mode program has no callback channel to reach the daemon.
    assert.ok(!resolveTools({ tools: {} } as never, true, 'code').includes('search_knowledge'));
    // R43 — no corpus, no tool.
    assert.ok(!resolveTools({ tools: {} } as never, false, 'standard').includes('search_knowledge'));
  });
});

describe('R19-R21 — save-time rejections', () => {
  test('Code mode against a context window below code_mode_min_context is rejected', () => {
    const small = { ...ctx, bindings: [binding('qwen3-4b-instruct', { context_window: 8192 })] };
    const chef = loadShipped('chef') as Record<string, unknown>;
    const errors = validate({ ...chef, runtime: { mode: 'code' } }, small).errors;
    assert.ok(errors.some((e) => e.message.includes('code_mode_min_context')));
  });

  test('a budget above its ceiling is rejected naming the ceiling', () => {
    const chef = loadShipped('chef') as Record<string, unknown>;
    const errors = validate({ ...chef, runtime: { budgets: { max_steps: 9999 } } }, ctx).errors;
    assert.ok(errors.some((e) => e.message.includes('200')));
  });

  test('workspace_required with no workspace tool granted is rejected', () => {
    const chef = loadShipped('chef') as Record<string, unknown>;
    assert.ok(validateStructure({ ...chef, tools: { builtin: [] } }).errors.some((e) => e.path === 'tools.builtin'));
  });
});

describe('R25a — refresh-bindings only versions on a real change', () => {
  const snapshotOf = () => {
    const result = validate(loadShipped('chef'), ctx);
    return buildSnapshot(result.definition!, result.resolved!.binding, result.resolved!.corpusId, [], ctx);
  };

  test('identical snapshots diff to nothing, so repeated calls are idempotent', () => {
    const snap = snapshotOf();
    assert.deepEqual(diffSnapshots(snap, snap), []);
  });

  test('a moved binding_tag IS reported', () => {
    const snap = snapshotOf();
    assert.ok(diffSnapshots(snap, { ...snap, binding_tag: 'other' }).includes('binding_tag'));
  });

  test('warnings alone do NOT cut a version', () => {
    // A Corpus that gained chunks drops its zero-chunk warning; versioning over that would
    // inflate history with no behavioural change.
    const snap = snapshotOf();
    assert.deepEqual(diffSnapshots(snap, { ...snap, warnings: ['different'] }), []);
  });
});
