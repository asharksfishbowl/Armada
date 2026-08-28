/**
 * armada-daemon — process entry and Kernel bootstrap.
 *
 * P7 SCOPE: gateway, kernel, plugin registry, event log, ordered replay, health, the
 * Agent surface (routes + agents/ loaded at startup), the model adapter and the tool
 * provider. The Step loop and POST /api/runs are the remainder of P7.
 *
 * STARTUP ORDER MATTERS AND IS DELIBERATE:
 *   1. config -> 2. pool -> 3. Kernel.register -> 4. listen
 *
 * The Kernel registers BEFORE the listener opens, so there is no window in which the port
 * accepts requests against a half-registered Kernel. A plugin fault therefore exits
 * non-zero (R14) instead of producing a daemon that serves 503 forever and looks like a
 * database problem.
 *
 * ALL FIVE PLUGIN INTERFACES ARE NOW REAL. EventSink (P3), SandboxProvider (P5),
 * RetrievalProvider (P6), and as of P7 both ModelAdapter and ToolProvider. The
 * not-implemented stubs the last two used to carry are gone with them.
 *
 * Those stubs THREW rather than returning empty, which is why their absence was never
 * mistaken for working code — an interface that silently answers "nothing" surfaces as an
 * Agent with no tools rather than as a missing plugin. Worth remembering now that they are
 * gone: it is the same failure the routes and the file loader DID hit, twice, because a
 * component that is merely unreachable throws nothing at all.
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
import { createAgentRoutes } from './gateway/routes/agents.js';
import { AgentStore } from './agents/store.js';
import { createContextProvider } from './agents/validation-context.js';
import { loadAgentDirectory, formatOutcomes } from './agents/file-loader.js';
import { OpenAICompatibleAdapter } from './models/openai-adapter.js';
import { RunStore } from './runs/store.js';
import { RunOrchestrator } from './runs/orchestrator.js';
import { createRunRoutes } from './gateway/routes/runs.js';
import type { LiveBinding } from './models/binding-verifier.js';
import { CompositeToolProvider } from './tools/composite-provider.js';
import type { ResolvedSnapshot } from './agents/resolver.js';
import { ModelScheduler } from './models/scheduler.js';
import { TeamStore } from './teams/store.js';
import { TeamOrchestrator } from './teams/orchestrator.js';
import { createTeamContextProvider } from './teams/validation-context.js';
import { loadTeamDirectory, formatTeamOutcomes } from './teams/file-loader.js';
import { createTeamRoutes } from './gateway/routes/teams.js';

const PORT = Number(process.env.ARMADA_PORT ?? 8080);
const VERSION = process.env.ARMADA_VERSION ?? '0.1.0';
const CONFIG_DIR = process.env.ARMADA_CONFIG_DIR ?? '/config';
const FORGE_URL = process.env.ARMADA_FORGE_URL ?? 'http://armada-forge:8000';
const MODELS_URL = process.env.ARMADA_MODELS_URL ?? 'http://armada-models:11434';
// R45c — every workspace_path must resolve beneath this shared root, which Compose
// bind-mounts into the daemon at the same path it occupies on the host.
const WORKSPACE_ROOT = process.env.ARMADA_WORKSPACE_ROOT ?? '/var/lib/armada/workspaces';
// R31 — the directory of shipped Agent definitions, loaded into the registry at startup.
const AGENTS_DIR = process.env.ARMADA_AGENTS_DIR ?? '/agents';
// Team Orchestration R41 — the same, for Teams. Mounted read-only by docker-compose.yml.
const TEAMS_DIR = process.env.ARMADA_TEAMS_DIR ?? '/teams';
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

// build-plan Req 29 — a profile declaring `network: egress_allowlist` is validated HERE,
// at config load, and REFUSED naming every fault when the subsystem behind it cannot be
// provisioned — never downgraded to `none`, which would leave a profile that appears to
// filter egress while filtering nothing. P14 makes the mode real; the `egress:` block
// carries the proxy image it needs.
let sandboxProfiles: Record<string, SandboxProfile>;
try {
  sandboxProfiles = validateProfiles(
    (sandboxConfig['profiles'] ?? {}) as Record<string, Partial<SandboxProfile>>,
    sandboxConfig['egress'],
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

const factories: FactoryTables = {
  ModelAdapter: {
    // Real from P7. Cross-service boundary 2 — the daemon consumes ModelBindings by tag
    // over the OpenAI-compatible API and never reaches into training. Capabilities come
    // from forge rather than the model server: the binding is the pinned contract, the
    // server is one implementation of it, and they can disagree.
    OpenAICompatibleAdapter: () =>
      new OpenAICompatibleAdapter({ modelsUrl: MODELS_URL, forgeUrl: FORGE_URL }),
  },
  ToolProvider: {
    // Real from P7. Merges built-ins with search_knowledge behind one interface, so the
    // loop asks one thing what tools a Run has (R15 — the loop imports no concrete
    // implementation). MCP tools join in P12.
    CompositeToolProvider: (deps) =>
      new CompositeToolProvider({
        // The grant list is read from the Run's PINNED snapshot (invariant 2), never
        // re-derived from current config — that would let a Run gain or lose a tool its
        // pinned version never had.
        grantsFor: async (ctx) => {
          const rows = await deps.pool.query<{ resolved_snapshot: ResolvedSnapshot }>(
            'SELECT resolved_snapshot FROM agent_versions WHERE agent_version_id = $1',
            [ctx.agentVersionId],
          );
          return rows.rows[0]?.resolved_snapshot?.tools ?? [];
        },
        // Called at USE, not here. Invoking it in this factory body is exactly what broke
        // boot: the factory runs DURING Kernel.register, when `kernel` is still unassigned.
        retrieval: () => kernelRef().get('RetrievalProvider'),
        searchOptions: {
          searchMaxK: Number(
            (runtimeConfig['retrieval'] as { search_max_k?: number } | undefined)?.search_max_k ?? 10,
          ),
          defaultK: Number(
            (runtimeConfig['retrieval'] as { auto_inject_k?: number } | undefined)?.auto_inject_k ?? 4,
          ),
        },
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

/**
 * Lets one plugin depend on another without the factory table needing them in order.
 *
 * CompositeToolProvider needs the RetrievalProvider, and both are registered by the same
 * Kernel.register call — so at factory-table construction time neither exists. Reading
 * through this closure defers the lookup to first use, by which point registration has
 * completed or the process has already exited non-zero (R14).
 *
 * A direct `kernel.get(...)` in the factory would throw on a variable used before
 * assignment, which would surface as a plugin fault rather than as the ordering problem
 * it actually is.
 */
const kernelRef = (): Kernel => {
  if (!kernel) throw new Error('Kernel accessed before registration completed');
  return kernel;
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

/**
 * The Agent surface — Agent Definition R26-R30.
 *
 * P4 wrote every handler and left this line out, so `/api/agents` answered 404 through
 * P4, P5 and P6 while the smoke test recorded it as "routes wire up in P7". The handlers
 * were never the missing part.
 *
 * The context provider fans out to forge on every write, because bindings and corpora live
 * there (cross-service boundaries 1 and 2) and validation resolves against live state. A
 * forge that cannot answer yields 503 and persists nothing — never a validation error,
 * which would blame the operator's definition for a peer being down.
 */
const agentStore = new AgentStore(pool);
const agentContext = createContextProvider({
  forgeUrl: FORGE_URL,
  runtimeConfig,
  sandboxProfiles: sandboxProfiles as unknown as Record<string, Record<string, unknown>>,
  // NAMES only. The values behind them are env var names, never secrets (R59).
  mcpServers: Object.keys((mcpConfig['servers'] ?? {}) as Record<string, unknown>),
});

const agentRoutes = createAgentRoutes(agentStore, agentContext);

/**
 * Load agents/ into the registry — Agent Definition R31, edges 3 and 17.
 *
 * ALSO WRITTEN IN P4 AND ALSO NEVER CALLED. Mounting the routes made GET /api/agents
 * answer 200 with an EMPTY list, which the smoke test caught immediately:
 *
 *   FAIL both shipped example Agents loaded
 *         expected: chef,frontend-engineer
 *         observed: <none>
 *
 * Two components, written and tested, neither reachable. The route was the first layer;
 * this was underneath it.
 *
 * NON-FATAL BY DESIGN. A bad file is skipped with its path and full error list (R31), and
 * the daemon still serves — an operator with one broken YAML should not lose the whole
 * runtime. But forge being unreachable is different: NOTHING can be validated, so every
 * shipped Agent would be skipped as invalid and the daemon would come up empty while
 * looking healthy. That is reported as the peer fault it is, and the daemon still starts,
 * because the health endpoint's peer strip is what an operator reads next.
 */
try {
  const outcomes = await loadAgentDirectory(AGENTS_DIR, agentStore, await agentContext());
  const text = formatOutcomes(outcomes);
  if (text.trim() !== '') process.stdout.write(`\n${text}\n\n`);
} catch (err) {
  process.stderr.write(
    `\n⚠️  armada-daemon: agents/ could not be loaded — ${err instanceof Error ? err.message : String(err)}\n` +
      `  Agent definitions are validated against ModelBindings and Corpora in armada-forge.\n` +
      `  GET /api/agents will be empty until forge is reachable and the daemon restarts.\n\n`,
  );
}

/**
 * The Run surface — R2, R3, R3b, R4. The last of P7.
 *
 * Mounted in the SAME statement that creates it, and covered by a smoke assertion, because
 * this repo has now shipped five components that were written, tested, and never called.
 */
/**
 * ONE scheduler for the whole process — Runtime R20-R22, Team R31-R33, D5.
 *
 * `ModelScheduler` shipped in P7 fully written and fully unit tested, and nothing ever
 * called it: every model request went straight to the adapter, so `max_concurrent_per_tag`
 * and `max_concurrent_total` were configuration that enforced nothing. It is a constructor
 * argument of `RunOrchestrator` rather than an optional one precisely so that omitting this
 * line does not compile.
 *
 * One instance, because the limits are the MODEL SERVER's, not a Run's. A per-Run scheduler
 * would let ten Runs each admit `max_concurrent_total` requests.
 *
 * Edge 7 of the build plan — these must agree with OLLAMA_MAX_LOADED_MODELS and
 * OLLAMA_NUM_PARALLEL, or the daemon admits requests Ollama then serializes, and the
 * unexplained latency shows up first under Teams where a manager and its workers hold
 * different tags at once.
 */
const scheduling = (modelsConfig['scheduling'] ?? {}) as Record<string, unknown>;
const modelScheduler = new ModelScheduler({
  maxConcurrentPerTag: Number(scheduling['max_concurrent_per_tag'] ?? 1),
  maxConcurrentTotal: Number(scheduling['max_concurrent_total'] ?? 2),
});

const reservedOutputTokens = Number(
  (runtimeConfig['context'] as { reserved_output_tokens?: number } | undefined)
    ?.reserved_output_tokens ?? 2048,
);
const noProgressThreshold = Number(runtimeConfig['no_progress_threshold'] ?? 3);

// Read LIVE on every Run start (R17). Caching would let a retired binding keep starting
// Runs until the daemon restarted — the exact staleness R18 exists to catch.
const fetchLiveBindings = async (): Promise<LiveBinding[]> => {
  const res = await fetch(`${FORGE_URL}/models/bindings`);
  if (!res.ok) throw new Error(`forge returned HTTP ${res.status}`);
  return (await res.json()) as LiveBinding[];
};

const runStore = new RunStore(pool);

const runOrchestrator = new RunOrchestrator(
  {
    model: kernel.get('ModelAdapter'),
    tools: kernel.get('ToolProvider'),
    events: kernel.get('EventSink'),
    retrieval: kernel.get('RetrievalProvider'),
    sandbox: kernel.get('SandboxProvider'),
  },
  agentStore,
  runStore,
  {
    reservedOutputTokens,
    noProgressThreshold,
    maxConcurrentTools: Number(runtimeConfig['max_concurrent_tools'] ?? 4),
    scheduler: modelScheduler,
    fetchLiveBindings,
  },
);

const runRoutes = createRunRoutes(runOrchestrator, runStore);

/**
 * The Team surface — Team Orchestration R39-R41. All of P8.
 *
 * Constructed, MOUNTED, and file-loaded in one place, because the alternative has now cost
 * this repo six components. The teams/ loader below is the exact analogue of the agents/
 * one that was written in P4 and called by nothing until P7 noticed `GET /api/agents`
 * answering 200 with an empty list.
 */
const teamStore = new TeamStore(pool);
const teamContext = createTeamContextProvider({ pool, runtimeConfig, modelsConfig });

const teamOrchestrator = new TeamOrchestrator(
  { model: kernel.get('ModelAdapter'), events: kernel.get('EventSink') },
  teamStore,
  agentStore,
  runStore,
  runOrchestrator,
  {
    reservedOutputTokens,
    noProgressThreshold,
    fetchLiveBindings,
    // R32 — synthesis is a manager request, so it is admitted ahead of any worker still
    // queued for the same tag.
    admitModelRequest: (tag, priority) => modelScheduler.acquire(tag, priority),
  },
);

const teamRoutes = createTeamRoutes(teamStore, teamContext, teamOrchestrator);

/**
 * Load teams/ into the registry — R41, R45.
 *
 * NON-FATAL BY DESIGN, exactly like agents/: a bad file is skipped with its path and full
 * error list and the daemon still serves. It runs AFTER the Agent load because a Team
 * resolves its roster against Agents, and a Team file loaded first would be skipped for
 * naming workers that had not been read yet.
 */
try {
  const outcomes = await loadTeamDirectory(TEAMS_DIR, teamStore, await teamContext());
  const text = formatTeamOutcomes(outcomes);
  if (text.trim() !== '') process.stdout.write(`\n${text}\n\n`);
} catch (err) {
  process.stderr.write(
    `\n⚠️  armada-daemon: teams/ could not be loaded — ${err instanceof Error ? err.message : String(err)}\n` +
      '  Team definitions resolve their roster against Agents in this daemon\'s database.\n' +
      '  GET /api/teams will be empty until that succeeds and the daemon restarts.\n\n',
  );
}

const gateway = createGateway({
  port: PORT,
  version: VERSION,
  pool,
  probe,
  kernel,
  agentRoutes,
  runRoutes,
  teamRoutes,
});

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
