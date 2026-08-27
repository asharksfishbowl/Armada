/**
 * P3 backfill — plugin registration. Agent Runtime R14, R15.
 *
 * Unit tests: no Docker, no Postgres, no armada-models. Run on every push.
 *
 * R14's contract is that a declared plugin which is missing or fails to load EXITS
 * STARTUP NON-ZERO NAMING THE PLUGIN. A daemon that started with a missing
 * RetrievalProvider would fail on the first Step of the first corpus-bound Run — long
 * after startup reported healthy, and with an error naming a retrieval failure rather than
 * a configuration fault.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadPluginsConfig,
  resolveFactories,
  PluginConfigError,
  type FactoryTables,
} from '../kernel/plugin-registry.js';
import { Kernel } from '../kernel/kernel.js';

const dir = mkdtempSync(join(tmpdir(), 'armada-kernel-'));

function config(retrieval = 'PgVectorRetrievalProvider'): string {
  return `plugins:
  ModelAdapter: OpenAICompatibleAdapter
  ToolProvider: CompositeToolProvider
  SandboxProvider: DockerSandboxProvider
  RetrievalProvider: ${retrieval}
  EventSink: PostgresEventSink
`;
}

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const stub = (name: string, result: unknown[]) => () => ({
  name,
  query: async () => result,
});

const TABLES: FactoryTables = {
  ModelAdapter: { OpenAICompatibleAdapter: () => ({ name: 'OpenAICompatibleAdapter' }) },
  ToolProvider: { CompositeToolProvider: () => ({ name: 'CompositeToolProvider' }) },
  SandboxProvider: { DockerSandboxProvider: () => ({ name: 'DockerSandboxProvider' }) },
  RetrievalProvider: {
    PgVectorRetrievalProvider: stub('PgVectorRetrievalProvider', [{ chunkId: 'real' }]),
    StubRetrievalProvider: stub('StubRetrievalProvider', []),
  },
  EventSink: { PostgresEventSink: () => ({ name: 'PostgresEventSink' }) },
};

function options(path: string, factories: FactoryTables = TABLES) {
  return {
    pluginsConfigPath: path,
    pool: {} as never,
    credentialEnvNames: [],
    config: {},
    factories,
  };
}

describe('R14 — a missing or unloadable plugin fails startup, naming it', () => {
  test('a valid config resolves all five interfaces', () => {
    assert.equal(Object.keys(loadPluginsConfig(write('ok.yaml', config()))).length, 5);
  });

  test('an undeclared interface is rejected NAMING that interface', () => {
    const body = config()
      .split('\n')
      .filter((line) => !line.includes('RetrievalProvider'))
      .join('\n');

    assert.throws(
      () => loadPluginsConfig(write('missing.yaml', body)),
      (err: unknown) => {
        assert.ok(err instanceof PluginConfigError);
        // "a plugin is missing" is not actionable; the interface name is.
        assert.ok(err.problems.some((p) => p.includes('RetrievalProvider')));
        return true;
      },
    );
  });

  test('every undeclared interface is reported, not just the first', () => {
    assert.throws(
      () => loadPluginsConfig(write('many.yaml', 'plugins:\n  ModelAdapter: OpenAICompatibleAdapter\n')),
      (err: unknown) => (err as PluginConfigError).problems.length === 4,
    );
  });

  test('an unknown interface KEY is rejected — a typo would silently leave one unregistered', () => {
    assert.throws(
      () => loadPluginsConfig(write('typo.yaml', `${config()}  EvenSink: Typo\n`)),
      (err: unknown) => (err as PluginConfigError).problems.some((p) => p.includes('EvenSink')),
    );
  });

  test('an unknown implementation name is rejected', () => {
    const selection = loadPluginsConfig(write('ok2.yaml', config()));
    assert.throws(
      () => resolveFactories(selection, { ...TABLES, RetrievalProvider: {} }),
      (err: unknown) =>
        (err as PluginConfigError).problems.some((p) => p.includes('PgVectorRetrievalProvider')),
    );
  });

  test('a plugin that throws while constructing is named with its cause', () => {
    const factories: FactoryTables = {
      ...TABLES,
      EventSink: {
        PostgresEventSink: () => {
          throw new Error('bad connection string');
        },
      },
    };

    assert.throws(
      () => Kernel.register(options(write('boom.yaml', config()), factories)),
      (err: unknown) =>
        (err as PluginConfigError).problems.some(
          (p) => p.includes('EventSink') && p.includes('bad connection string'),
        ),
    );
  });

  test('a missing plugins.yaml is a startup fault, not a silent default', () => {
    assert.throws(() => loadPluginsConfig(join(dir, 'does-not-exist.yaml')), PluginConfigError);
  });
});

describe('R15 — a capability is swappable through config alone', () => {
  test('changing only plugins.yaml changes retrieval BEHAVIOUR', async () => {
    const withReal = Kernel.register(options(write('real.yaml', config())));
    const withStub = Kernel.register(options(write('stub.yaml', config('StubRetrievalProvider'))));

    const realHits = await withReal.get('RetrievalProvider').query('c', 'q', 4);
    const stubHits = await withStub.get('RetrievalProvider').query('c', 'q', 4);

    assert.equal(realHits.length, 1);
    assert.equal(stubHits.length, 0, 'the stub must actually behave differently');
    // No consumer imported a concrete class to achieve this. That is the property R15
    // exists to guarantee, and what the Runtime spec's final acceptance criterion tests.
  });

  test('health reports which implementation is live', () => {
    const kernel = Kernel.register(options(write('desc.yaml', config('StubRetrievalProvider'))));
    const entry = kernel.describe().find((p) => p.interface === 'RetrievalProvider');
    assert.equal(entry?.implementation, 'StubRetrievalProvider');
  });

  test('isReady is true only once every interface is registered', () => {
    assert.equal(Kernel.register(options(write('ready.yaml', config()))).isReady, true);
  });

  test('resolving an unregistered interface throws rather than returning undefined', () => {
    const kernel = Kernel.register(options(write('r2.yaml', config())));
    // @ts-expect-error — deliberately outside the interface union.
    assert.throws(() => kernel.get('NotAnInterface'));
  });
});
