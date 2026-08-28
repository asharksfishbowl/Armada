/**
 * P8 — THE PHASE'S TWO EXIT CRITERIA, end to end.
 *
 *   1. a Team Run produces child Runs with `parent_run_id` AND `delegation_id` set
 *   2. a tree budget exhaustion CANCELS IN-FLIGHT CHILDREN BEFORE the Team Run's `run_end`
 *
 * Driven through the real TeamOrchestrator, the real RunOrchestrator, the real agent loop
 * and the real TeamToolProvider. The only stubs are the five plugin interfaces and a
 * `pg.Pool` that answers the handful of statements the two stores issue — no Docker, no
 * Postgres, no armada-models, so this stays a unit test under rule 9.
 *
 * ── WHY THE SECOND CRITERION NEEDS AN ORDERING ASSERTION, NOT A COUNT ───────
 * "Cancels in-flight children" is easy to satisfy accidentally and easy to break silently:
 * every child terminates eventually whatever the code does, because invariant 6 makes it
 * so. The property that is actually load-bearing is that each child's `run_end` is already
 * in the log when the Team Run's is written, so a reader of the stream never sees a Team
 * Run close over children that are still open. That is asserted on the global append
 * order, which is the only place it is visible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import { TeamOrchestrator } from '../teams/orchestrator.js';
import { TeamStore } from '../teams/store.js';
import { RunOrchestrator } from '../runs/orchestrator.js';
import { RunStore } from '../runs/store.js';
import { AgentStore } from '../agents/store.js';
import { ModelScheduler } from '../models/scheduler.js';
import type {
  ChatDelta,
  ChatRequest,
  Chunk,
  Event,
  EventInput,
  ModelCapabilities,
  RunContext,
  Sandbox,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';
import type { LiveBinding } from '../models/binding-verifier.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TAG = 'armada/qwen3-0.6b-base';

const BUDGETS = {
  max_steps: 10,
  max_model_tokens: 1_000_000,
  max_wall_clock_seconds: 600,
  max_tool_calls: 40,
};

const SNAPSHOT = {
  binding_tag: TAG,
  backend: 'ollama',
  context_window: 32768,
  tool_format: 'json_schema' as const,
  adapter_id: null,
  corpus_id: null,
  auto_inject_k: 0,
  mode: 'standard' as const,
  tools: ['finish'],
  budgets: BUDGETS,
  // No workspace, so the sandbox stub needs no path verification.
  sandbox: { profile: 'minimal', workspace_required: false },
  warnings: [],
};

const LIVE: LiveBinding[] = [
  { tag: TAG, status: 'promoted', materialized: true, materialization_status: 'materialized' },
];

function rosterMember(alias: string, capabilities: string[]) {
  return {
    alias,
    agent_name: alias,
    agent_id: `id-${alias}`,
    agent_version_id: `ver-${alias}`,
    display_name: alias,
    description: alias,
    capabilities,
    budgets: BUDGETS,
    workspace_required: false,
  };
}

/** Personas double as the model's routing key — see `scriptedModel`. */
const PERSONA: Record<string, string> = {
  'ver-lead': 'MANAGER',
  'ver-chef': 'WORKER-CHEF',
  'ver-fe': 'WORKER-FE',
};

function teamVersion(limits: Record<string, unknown>) {
  return {
    team_version_id: 'tv-1',
    team_id: 'team-1',
    version: 1,
    definition: { schema_version: 1, name: 'a-team' },
    resolved_roster: {
      manager: rosterMember('lead', ['planning']),
      synthesis_prompt: 'Write the answer.',
      workers: [rosterMember('chef', ['cooking']), rosterMember('fe', ['frontend'])],
      limits: {
        max_delegations: 6,
        max_concurrent_delegations: 2,
        per_delegation_budgets: {},
        ...limits,
      },
    },
  };
}

// ── The fake Pool ────────────────────────────────────────────────────────────

interface RunRecord {
  run_id: string;
  parent_run_id: string | null;
  delegation_id: string | null;
  is_team_run: boolean;
  team_version_id: string | null;
  status: string;
  outcome: string | null;
  result: string | null;
}

/**
 * Answers only the statements RunStore, AgentStore and TeamStore actually issue.
 *
 * Matched on distinctive fragments rather than on whole SQL strings, so reformatting a
 * query does not silently make this fake return nothing — which would show up as an
 * unrelated null-reference failure rather than as "the fake does not know this query".
 * An unmatched statement THROWS for exactly that reason.
 */
function fakePool(limits: Record<string, unknown>): { pool: Pool; runs: Map<string, RunRecord> } {
  const runs = new Map<string, RunRecord>();
  let nextRun = 0;

  const query = async (text: string, params: unknown[] = []): Promise<unknown> => {
    if (text.includes('FROM teams WHERE team_id')) {
      return { rows: [{ team_id: 'team-1', name: 'a-team', current_version: 1, deleted_at: null }] };
    }
    if (text.includes('FROM team_versions tv')) {
      return { rows: [teamVersion(limits)] };
    }
    if (text.includes('FROM agents WHERE agent_id')) {
      return { rows: [{ agent_id: params[0], name: 'x', current_version: 1, deleted_at: null }] };
    }
    if (text.includes('FROM agent_versions WHERE agent_version_id')) {
      const id = String(params[0]);
      return {
        rows: [
          {
            agent_version_id: id,
            agent_id: `id-${id.slice(4)}`,
            version: 1,
            definition: { persona: { system_prompt: PERSONA[id] ?? 'UNKNOWN' } },
            resolved_snapshot: SNAPSHOT,
          },
        ],
      };
    }
    if (text.includes('INSERT INTO runs')) {
      const row: RunRecord = {
        run_id: `run-${nextRun++}`,
        parent_run_id: (params[3] as string | null) ?? null,
        delegation_id: (params[4] as string | null) ?? null,
        is_team_run: Boolean(params[5]),
        team_version_id: (params[6] as string | null) ?? null,
        status: 'running',
        outcome: null,
        result: null,
      };
      runs.set(row.run_id, row);
      return { rows: [row] };
    }
    if (text.includes("SET status = 'terminal'")) {
      const row = runs.get(String(params[0]));
      if (!row || row.status === 'terminal') return { rowCount: 0 };
      row.status = 'terminal';
      row.outcome = String(params[1]);
      row.result = String(params[2]);
      return { rowCount: 1 };
    }
    if (text.includes('SET steps_used')) return { rowCount: 1 };

    throw new Error(`fakePool: unhandled statement\n${text}`);
  };

  return { pool: { query } as unknown as Pool, runs };
}

// ── Plugin stubs ─────────────────────────────────────────────────────────────

/** Records the GLOBAL append order across every Run — the ordering criterion needs it. */
class RecordingSink {
  readonly name = 'RecordingSink';
  readonly events: Event[] = [];
  private seq = 0;

  async append(event: EventInput): Promise<Event> {
    const e: Event = {
      eventId: `evt-${this.seq}`,
      runId: event.runId,
      seq: this.seq++,
      type: event.type,
      payload: event.payload ?? {},
      createdAt: '',
    };
    this.events.push(e);
    return e;
  }

  async read(): Promise<Event[]> {
    return this.events;
  }

  /** The position of a Run's run_end in the global stream. -1 when it has none. */
  runEndIndex(runId: string): number {
    return this.events.findIndex((e) => e.runId === runId && e.type === 'run_end');
  }
}

const sandbox: Sandbox = {
  id: 'sbx',
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
  },
  async readFile() {
    return '';
  },
  async writeFile() {
    /* no-op */
  },
  async listDir() {
    return [];
  },
};

const sandboxProvider = {
  name: 'StubSandbox',
  async acquire(): Promise<Sandbox> {
    return sandbox;
  },
  async release(): Promise<void> {
    /* no-op */
  },
  async sweepOrphans(): Promise<string[]> {
    return [];
  },
};

const noRetrieval = {
  name: 'NoRetrieval',
  async query(): Promise<Chunk[]> {
    return [];
  },
};

/** The ordinary provider. It knows nothing about Teams — R18 depends on that. */
const baseTools = {
  name: 'StubTools',
  async list(): Promise<ToolSpec[]> {
    return [{ name: 'finish', description: 'finish', parameters: {} }];
  },
  async invoke(name: string, args: unknown, _ctx: RunContext): Promise<ToolResult> {
    if (name === 'finish') {
      return { content: String((args as { summary?: string }).summary ?? '') };
    }
    return { content: `unknown tool \`${name}\``, isError: true };
  },
};

type Script = (request: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatDelta>;

/**
 * Routes on the system prompt, because one adapter instance serves the manager and every
 * worker — which is itself the point: R31 puts every Run in the tree on the SAME model
 * server behind the SAME scheduler.
 */
function scriptedModel(scripts: Record<string, Script>) {
  return {
    name: 'ScriptedModel',
    chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
      // R2 — the synthesis Step's system message is the persona PLUS `synthesis_prompt`,
      // so the routing key is a prefix rather than an equality.
      const persona = (request.messages[0]?.content ?? '').split('\n')[0] ?? '';
      // R35 — the synthesis Step presents no tools. That is how it is told apart from an
      // ordinary manager Step without a flag having to be threaded through.
      const key = (request.tools?.length ?? 0) === 0 && persona === 'MANAGER' ? 'SYNTHESIS' : persona;
      const script = scripts[key];
      if (!script) throw new Error(`no script for \`${key}\``);
      return script(request, signal);
    },
    async capabilities(): Promise<ModelCapabilities> {
      return { toolCalling: true, contextWindow: 32768, toolFormat: 'json_schema' };
    },
  };
}

const call = (name: string, args: unknown, id: string): ChatDelta => ({
  toolCall: { id, name, arguments: args },
});

function steps(...turns: ChatDelta[][]): Script {
  let turn = 0;
  return async function* () {
    for (const delta of turns[Math.min(turn++, turns.length - 1)] ?? []) yield delta;
    yield { done: true };
  };
}

// ── The harness ──────────────────────────────────────────────────────────────

function build(options: { scripts: Record<string, Script>; limits: Record<string, unknown> }) {
  const { pool, runs } = fakePool(options.limits);
  const events = new RecordingSink();
  const model = scriptedModel(options.scripts);
  const scheduler = new ModelScheduler({ maxConcurrentPerTag: 4, maxConcurrentTotal: 4 });
  const runStore = new RunStore(pool);
  const agentStore = new AgentStore(pool);

  const runOrchestrator = new RunOrchestrator(
    { model, tools: baseTools, events, retrieval: noRetrieval, sandbox: sandboxProvider },
    agentStore,
    runStore,
    {
      reservedOutputTokens: 512,
      noProgressThreshold: 3,
      maxConcurrentTools: 4,
      scheduler,
      fetchLiveBindings: async () => LIVE,
    },
  );

  const teamOrchestrator = new TeamOrchestrator(
    { model, events },
    new TeamStore(pool),
    agentStore,
    runStore,
    runOrchestrator,
    {
      reservedOutputTokens: 512,
      noProgressThreshold: 3,
      fetchLiveBindings: async () => LIVE,
      admitModelRequest: (tag, priority) => scheduler.acquire(tag, priority),
    },
  );

  return { teamOrchestrator, events, runs };
}

/** Waits for every Run to leave `running` — the outcome, not a delay, is the condition. */
async function settle(runs: Map<string, RunRecord>): Promise<void> {
  for (let i = 0; i < 5000; i += 1) {
    if (runs.size > 0 && [...runs.values()].every((r) => r.status === 'terminal')) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `runs did not terminate: ${JSON.stringify([...runs.values()].map((r) => [r.run_id, r.status]))}`,
  );
}

// ── EXIT CRITERION 1 ─────────────────────────────────────────────────────────

describe('P8 exit criterion 1 — child Runs carry parent_run_id and delegation_id', () => {
  test('a delegation produces a child whose two links point at the Team Run and the tool_call', async () => {
    const { teamOrchestrator, events, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 },
      scripts: {
        MANAGER: steps(
          [call('delegate', { worker: 'cooking', task: 'braise it' }, 'd1')],
          [call('finish', { success: true, summary: 'delegated and done' }, 'f1')],
        ),
        'WORKER-CHEF': steps([call('finish', { success: true, summary: 'braised' }, 'wf')]),
        SYNTHESIS: steps([{ content: 'the synthesized answer' }]),
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 'make dinner' });
    await settle(runs);

    const team = runs.get(runId)!;
    assert.equal(team.is_team_run, true, 'the Team Run IS the manager Run, flagged as such');
    assert.equal(team.team_version_id, 'tv-1', 'pinned, so editing the Team mid-Run changes nothing');

    const children = [...runs.values()].filter((r) => r.run_id !== runId);
    assert.equal(children.length, 1);
    const child = children[0]!;

    // ── THE CRITERION ────────────────────────────────────────────────────────
    assert.equal(child.parent_run_id, runId, 'parent_run_id is the Team Run');

    const toolCall = events.events.find(
      (e) => e.runId === runId && e.type === 'tool_call' && e.payload['name'] === 'delegate',
    );
    assert.ok(toolCall, 'the manager\'s delegate tool_call Event exists');
    assert.equal(
      child.delegation_id,
      toolCall.eventId,
      // R19 — the id had to exist BEFORE the tool ran, which is why tool_call is now
      // appended at reservation rather than after dispatch.
      'delegation_id is the event_id of the manager tool_call that created the child',
    );
    assert.equal(child.is_team_run, false, 'a child is an ordinary Run');
  });

  test('R42 — a delegation Event is appended to the TEAM Run on creation and on termination', async () => {
    const { teamOrchestrator, events, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 },
      scripts: {
        MANAGER: steps(
          [call('delegate', { worker: 'chef', task: 'braise' }, 'd1')],
          [call('finish', { success: true, summary: 'ok' }, 'f1')],
        ),
        'WORKER-CHEF': steps([call('finish', { success: true, summary: 'braised' }, 'wf')]),
        SYNTHESIS: steps([{ content: 'answer' }]),
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    const delegations = events.events.filter((e) => e.type === 'delegation');
    assert.equal(delegations.length, 2, 'one on creation, one on termination');
    for (const event of delegations) {
      assert.equal(event.runId, runId, 'both belong to the Team Run, not the child');
      assert.equal(event.payload['alias'], 'chef');
      assert.ok(event.payload['child_run_id']);
    }
    assert.equal(delegations[1]!.payload['outcome'], 'success');

    // R43 — child Events are NOT interleaved into the Team Run's stream. A client follows a
    // child by subscribing to the child_run_id it read from the delegation Event.
    const childRunId = String(delegations[0]!.payload['child_run_id']);
    const leaked = events.events.filter((e) => e.runId === runId && e.payload['from_child']);
    assert.equal(leaked.length, 0);
    assert.ok(events.events.some((e) => e.runId === childRunId && e.type === 'run_start'));
  });

  test('R37, R38 — synthesis writes the result and the manager\'s self-report decides the outcome', async () => {
    const { teamOrchestrator, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 },
      scripts: {
        MANAGER: steps(
          [call('delegate', { worker: 'chef', task: 'braise' }, 'd1')],
          [call('finish', { success: true, summary: 'the manager summary' }, 'f1')],
        ),
        'WORKER-CHEF': steps([call('finish', { success: true, summary: 'braised' }, 'wf')]),
        SYNTHESIS: steps([{ content: 'the synthesized answer' }]),
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    const team = runs.get(runId)!;
    assert.equal(team.outcome, 'success', 'finish(success: true) AND synthesis completed');
    assert.equal(team.result, 'the synthesized answer', 'R37 — not the manager\'s own summary');
  });

  test('edge 21 — a manager that never calls finish is INCOMPLETE despite a synthesis result', async () => {
    const { teamOrchestrator, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 },
      scripts: {
        // Answers instead of acting. A termination, never a success (invariant 1).
        MANAGER: steps([{ content: 'I think we are done here.' }]),
        SYNTHESIS: steps([{ content: 'a synthesized answer over an empty digest' }]),
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    const team = runs.get(runId)!;
    assert.equal(team.outcome, 'incomplete');
    // It produced an answer and is still excluded from trajectory training data, which is
    // the entire point of invariant 1.
    assert.equal(team.result, 'a synthesized answer over an empty digest');
  });

  test('edge 5, R38a — every delegation failing is still `success` if the manager says so', async () => {
    const { teamOrchestrator, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 },
      scripts: {
        MANAGER: steps(
          [call('delegate', { worker: 'chef', task: 'braise' }, 'd1')],
          [call('finish', { success: true, summary: 'I handled it myself' }, 'f1')],
        ),
        // finish(success: false) — an honest negative, which is `incomplete`, not `failed`.
        'WORKER-CHEF': steps([call('finish', { success: false, summary: 'could not' }, 'wf')]),
        SYNTHESIS: steps([{ content: 'answer despite the failure' }]),
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    // The manager is the authority on whether the task was met; the delegations are
    // evidence, not a verdict.
    assert.equal(runs.get(runId)!.outcome, 'success');
    const child = [...runs.values()].find((r) => r.run_id !== runId)!;
    assert.equal(child.outcome, 'incomplete', 'the child is judged on its own self-report');
  });
});

// ── EXIT CRITERION 2 ─────────────────────────────────────────────────────────

describe('P8 exit criterion 2 — tree exhaustion cancels children BEFORE the Team Run run_end', () => {
  test('two in-flight children are cancelled, and both run_ends precede the Team Run\'s', async () => {
    // `chef` spends the whole tree budget in one Step. `fe` is still inside its model call
    // when that happens, so it is genuinely in flight when the cascade fires.
    const { teamOrchestrator, events, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000 },
      scripts: {
        MANAGER: steps([
          call('delegate', { worker: 'cooking', task: 'a' }, 'd1'),
          call('delegate', { worker: 'frontend', task: 'b' }, 'd2'),
        ]),
        'WORKER-CHEF': steps([{ promptTokens: 5_000, completionTokens: 0, content: 'spent it' }]),
        'WORKER-FE': async function* (_request, signal) {
          // Hangs until the cascade reaches it. No timer decides when: the abort does.
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('model call aborted');
        },
      },
    });

    const { runId } = await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    const team = runs.get(runId)!;
    const children = [...runs.values()].filter((r) => r.run_id !== runId);
    assert.equal(children.length, 2);

    // R26 — the Team Run names the tree budget that stopped it.
    assert.equal(team.outcome, 'budget_exhausted');
    const runEnd = events.events.find((e) => e.runId === runId && e.type === 'run_end');
    assert.equal(runEnd?.payload['tree_budget_hit'], 'tree_max_model_tokens');
    // R36 — synthesis is subject to the tree budgets, so an exhausted tree skips it.
    assert.equal(runEnd?.payload['synthesis_skipped'], true);

    // ── THE CRITERION ────────────────────────────────────────────────────────
    const teamEnd = events.runEndIndex(runId);
    assert.ok(teamEnd >= 0, 'the Team Run terminated (invariant 6)');
    for (const child of children) {
      const childEnd = events.runEndIndex(child.run_id);
      assert.ok(childEnd >= 0, `child ${child.run_id} terminated`);
      assert.ok(
        childEnd < teamEnd,
        `child ${child.run_id} run_end (${childEnd}) must precede the Team Run's (${teamEnd})`,
      );
      assert.equal(child.status, 'terminal', 'no child is left running');
    }
  });

  test('R28 — once the tree is exhausted no FURTHER child Run is created', async () => {
    const { teamOrchestrator, runs } = build({
      limits: { tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000 },
      scripts: {
        MANAGER: steps(
          [call('delegate', { worker: 'chef', task: 'a' }, 'd1')],
          // Never reached: the cascade aborts the manager first. If it were, this second
          // delegation would be refused rather than started and immediately cancelled.
          [call('delegate', { worker: 'fe', task: 'b' }, 'd2')],
        ),
        'WORKER-CHEF': steps([{ promptTokens: 5_000, completionTokens: 0, content: 'spent it' }]),
        'WORKER-FE': steps([call('finish', { success: true, summary: 'should not run' }, 'x')]),
      },
    });

    await teamOrchestrator.start({ teamId: 'team-1', task: 't' });
    await settle(runs);

    assert.equal(runs.size, 2, 'the Team Run and exactly one child');
  });
});

// ── Start-time refusals ──────────────────────────────────────────────────────

describe('Team Run start refuses before anything is provisioned', () => {
  test('edge 20 — a missing workspace_path names the members that require one', async () => {
    const { pool } = fakePool({ tree_max_wall_clock_seconds: 600, tree_max_model_tokens: 1_000_000 });
    // Rebuild the roster with a worker that needs a workspace.
    const withWorkspace = {
      query: async (text: string, params: unknown[] = []) => {
        if (text.includes('FROM team_versions tv')) {
          const version = teamVersion({});
          version.resolved_roster.workers[0]!.workspace_required = true;
          return { rows: [version] };
        }
        return (pool as unknown as { query: (t: string, p?: unknown[]) => Promise<unknown> }).query(
          text,
          params,
        );
      },
    } as unknown as Pool;

    const events = new RecordingSink();
    const scheduler = new ModelScheduler({ maxConcurrentPerTag: 1, maxConcurrentTotal: 1 });
    const model = scriptedModel({});
    const runOrchestrator = new RunOrchestrator(
      { model, tools: baseTools, events, retrieval: noRetrieval, sandbox: sandboxProvider },
      new AgentStore(withWorkspace),
      new RunStore(withWorkspace),
      {
        reservedOutputTokens: 512,
        noProgressThreshold: 3,
        maxConcurrentTools: 4,
        scheduler,
        fetchLiveBindings: async () => LIVE,
      },
    );
    const orchestrator = new TeamOrchestrator(
      { model, events },
      new TeamStore(withWorkspace),
      new AgentStore(withWorkspace),
      new RunStore(withWorkspace),
      runOrchestrator,
      {
        reservedOutputTokens: 512,
        noProgressThreshold: 3,
        fetchLiveBindings: async () => LIVE,
        admitModelRequest: (tag, priority) => scheduler.acquire(tag, priority),
      },
    );

    await assert.rejects(
      () => orchestrator.start({ teamId: 'team-1', task: 't' }),
      (err: Error) => {
        // Named, because "workspace_path is required" alone leaves an operator to work out
        // which of six Agents wanted it.
        assert.match(err.message, /chef/);
        assert.match(err.message, /workspace_required/);
        return true;
      },
    );
    assert.equal(events.events.length, 0, 'no Run row, no Events, no container');
  });
});
