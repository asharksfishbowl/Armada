/**
 * armada-daemon — process entry and Kernel bootstrap.
 *
 * P3 SCOPE: gateway, kernel, plugin registry, event log, ordered replay, health.
 * NO AGENT LOOP — that is P7, after Agent Definition (P4), so it executes real validated
 * Agents rather than fixtures.
 *
 * STARTUP ORDER MATTERS AND IS DELIBERATE:
 *   1. config -> 2. pool -> 3. Kernel.register -> 4. listen
 *
 * The Kernel registers BEFORE the listener opens, so there is no window in which the port
 * accepts requests against a half-registered Kernel. A plugin fault therefore exits
 * non-zero (R14) instead of producing a daemon that serves 503 forever and looks like a
 * database problem.
 *
 * EventSink (P3), RetrievalProvider (P6), and SandboxProvider (P5) are real. The
 * remaining two must still be REGISTERED for the Kernel to consider itself ready (R14)
 * even though nothing calls them until later phases. They are registered as explicit not-implemented stubs that THROW
 * when invoked, rather than as silent no-ops — a stub that quietly returns nothing would
 * surface later as an empty tool list rather than as a missing plugin.
 */

import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { Kernel } from './kernel/kernel.js';
import { PluginConfigError, type FactoryTables } from './kernel/plugin-registry.js';
import { PostgresEventSink, collectCredentialEnvNames } from './events/event-log.js';
import { PgVectorRetrievalProvider, DEFAULT_RETRIEVAL_OPTIONS } from './retrieval/pgvector-provider.js';
import { createEmbedClient } from './retrieval/embed-client.js';
import {
  DockerSandboxProvider,
  assertSocketMounted,
  validateProfiles,
  type SandboxProfile,
} from './sandbox/docker-sandbox.js';
import { createGateway } from './gateway/server.js';
import { PeerProbe } from './gateway/routes/health.js';

const PORT = Number(process.env.ARMADA_PORT ?? 8080);
const VERSION = process.env.ARMADA_VERSION ?? '0.1.0';
const CONFIG_DIR = process.env.ARMADA_CONFIG_DIR ?? '/config';
const FORGE_URL = process.env.ARMADA_FORGE_URL ?? 'http://armada-forge:8000';
const MODELS_URL = process.env.ARMADA_MODELS_URL ?? 'http://armada-models:11434';
// R45c — every workspace_path must resolve beneath this shared root, which Compose
// bind-mounts into the daemon at the same path it occupies on the host.
const WORKSPACE_ROOT = process.env.ARMADA_WORKSPACE_ROOT ?? '/var/lib/armada/workspaces';
const DATABASE_URL = process.env.DATABASE_URL;

function fail(message: string, detail?: string[]): never {
  process.stderr.write(`\n🛑 armada-daemon: ${message}\n`);
  for (const line of detail ?? []) process.stderr.write(`  - ${line}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

if (!DATABASE_URL) fail('DATABASE_URL is unset');

function readYaml(name: string): Record<string, unknown> {
  try {
    return (parseYaml(readFileSync(`${CONFIG_DIR}/${name}`, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch (err) {
    // A missing or malformed config file is a startup fault for the same reason a missing
    // plugin is: the alternative is discovering it mid-Run.
    fail(`cannot read ${CONFIG_DIR}/${name}`, [err instanceof Error ? err.message : String(err)]);
  }
}

const runtimeConfig = readYaml('runtime.yaml');
const sandboxConfig = readYaml('sandbox-profiles.yaml');
const mcpConfig = readYaml('mcp-servers.yaml');
const modelsConfig = readYaml('models.yaml');

// R59 — NAMES only. Values are read inside the sink, from this process's environment.
const credentialEnvNames = collectCredentialEnvNames([mcpConfig, modelsConfig, runtimeConfig]);

// build-plan Req 29 — a profile declaring `network: egress_allowlist` is REJECTED here,
// at config load, rather than downgraded to `none`. A downgrade would leave a profile
// that appears to filter egress while filtering nothing.
let sandboxProfiles: Record<string, SandboxProfile>;
try {
  sandboxProfiles = validateProfiles(
    (sandboxConfig['profiles'] ?? {}) as Record<string, Partial<SandboxProfile>>,
  );
} catch (err) {
  fail('sandbox profiles are invalid', [err instanceof Error ? err.message : String(err)]);
}

// R45b — the daemon fails at STARTUP naming the missing mount, not at the first Run.
// Sandboxes are sibling containers over the host socket (R45a), so without it the daemon
// can provision nothing — and discovering that mid-Run looks like a Docker fault on a
// daemon that already reported healthy.
await assertSocketMounted().catch((err: Error) =>
  fail('cannot provision sandboxes', [err.message]),
);

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
});

/**
 * A plugin that is declared but not yet implemented.
 *
 * Throws on use rather than returning an empty result. An interface that silently answers
 * "nothing" would make a later phase's bug look like ordinary behaviour — an Agent with no
 * tools, a corpus with no chunks — instead of naming the phase that has not landed.
 */
function notImplemented(iface: string, phase: string): never {
  throw new Error(`${iface} is not implemented until ${phase}`);
}

const factories: FactoryTables = {
  ModelAdapter: {
    OpenAICompatibleAdapter: () => ({
      name: 'OpenAICompatibleAdapter',
      chat: () => notImplemented('ModelAdapter.chat', 'P7'),
      capabilities: () => notImplemented('ModelAdapter.capabilities', 'P7'),
    }),
  },
  ToolProvider: {
    CompositeToolProvider: () => ({
      name: 'CompositeToolProvider',
      list: () => notImplemented('ToolProvider.list', 'P7 (the agent loop)'),
      invoke: () => notImplemented('ToolProvider.invoke', 'P7 (the agent loop)'),
    }),
  },
  SandboxProvider: {
    // Real from P5. One sibling container per Run, non-root, all capabilities dropped,
    // network none, and NEVER holding the Docker socket (R46).
    DockerSandboxProvider: () => new DockerSandboxProvider(sandboxProfiles, WORKSPACE_ROOT),
  },
  RetrievalProvider: {
    // Real from P6. The query vector comes from forge (platform boundary 1) — the daemon
    // has no embedding model, and a second copy could drift out of sync with the one that
    // indexed the corpus, making query and indexed vectors incomparable.
    PgVectorRetrievalProvider: (deps) =>
      new PgVectorRetrievalProvider(
        deps.pool,
        createEmbedClient({ forgeUrl: FORGE_URL }),
        {
          ...DEFAULT_RETRIEVAL_OPTIONS,
          rrfK: Number(
            (deps.config['retrieval'] as { rrf_k?: number } | undefined)?.rrf_k ??
              DEFAULT_RETRIEVAL_OPTIONS.rrfK,
          ),
        },
      ),
  },
  EventSink: {
    // The one real implementation in P3. Invariant 5 lives here.
    PostgresEventSink: (deps) => new PostgresEventSink(deps.pool, deps.credentialEnvNames),
  },
};

let kernel: Kernel;
try {
  kernel = Kernel.register({
    pluginsConfigPath: `${CONFIG_DIR}/plugins.yaml`,
    pool,
    credentialEnvNames,
    config: runtimeConfig,
    factories,
  });
} catch (err) {
  // R14 — exit non-zero NAMING the plugin. Every problem at once, so an operator with two
  // bad entries fixes both in one restart.
  fail(
    'plugin registration failed',
    err instanceof PluginConfigError
      ? err.problems
      : [err instanceof Error ? err.message : String(err)],
  );
}

const probe = new PeerProbe(
  [
    { name: 'forge', url: `${FORGE_URL}/health` },
    { name: 'models', url: `${MODELS_URL}/api/tags` },
  ],
  Number((runtimeConfig['health'] as { probe_interval_seconds?: number } | undefined)
    ?.probe_interval_seconds ?? 15),
);

// Edge 13 / R48 — sweep containers left by a crashed daemon BEFORE serving. Shutdown
// cleanup is best-effort; this is the guarantee. No Run is active at startup, so every
// labelled container is by definition an orphan.
void kernel
  .get('SandboxProvider')
  .sweepOrphans()
  .catch(() => {
    // A sweep failure must not prevent the daemon from serving — the containers are inert
    // and the next restart tries again.
  });

const gateway = createGateway({ port: PORT, version: VERSION, pool, probe, kernel });

/**
 * Compose sends SIGTERM on `docker compose down`. Close the listener, drop WebSocket
 * clients, and drain the pool so a restart is not racing a half-open connection.
 *
 * P5 extends this to release sandbox containers. A daemon that exits without releasing
 * leaves orphans, which is why R48 also requires a sweep on the NEXT startup — shutdown
 * cleanup is best-effort and the sweep is the guarantee.
 */
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void gateway
    .close()
    .then(() => pool.end())
    .then(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
