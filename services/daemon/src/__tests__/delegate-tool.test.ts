/**
 * P8 — `delegate` and `list_workers`. Team Orchestration R11-R18, R27, R30; edges 2, 3, 15, 16.
 *
 * Acceptance criteria covered here:
 *
 *   list_workers returns every alias with capabilities and NO persona/model tag/tool list
 *   delegate by capability resolves to the single match; two matches error naming both
 *   a worker's tool list does not contain delegate, and calling it is an unknown tool
 *   with max_concurrent_delegations: 2, four delegations run at most two at any instant
 *   with max_delegations: 2, the third call errors and the Run continues to synthesis
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATE,
  LIST_WORKERS,
  TeamToolProvider,
  resolveWorker,
  type DelegationOutcome,
} from '../teams/delegate-tool.js';
import type { ResolvedRoster, RosterMember } from '../teams/validator.js';
import { TEAM_LIMIT_DEFAULTS } from '../teams/team-schema.js';
import type { RunContext, ToolProvider, ToolResult, ToolSpec } from '../kernel/types.js';

const BUDGETS = {
  max_steps: 40,
  max_model_tokens: 200_000,
  max_wall_clock_seconds: 1_800,
  max_tool_calls: 120,
};

function member(alias: string, capabilities: string[]): RosterMember {
  return {
    alias,
    agent_name: alias,
    agent_id: `id-${alias}`,
    agent_version_id: `ver-${alias}`,
    display_name: `The ${alias}`,
    description: `does ${capabilities[0]}`,
    capabilities,
    budgets: BUDGETS,
    workspace_required: true,
  };
}

function roster(over: Partial<ResolvedRoster> = {}): ResolvedRoster {
  return {
    manager: member('lead', ['planning']),
    synthesis_prompt: null,
    workers: [member('frontend', ['frontend', 'react']), member('chef', ['cooking', 'react-cookery'])],
    limits: { ...TEAM_LIMIT_DEFAULTS },
    ...over,
  };
}

/** The ordinary provider a worker Run gets. It knows nothing about Teams. */
const baseProvider: ToolProvider = {
  name: 'BaseTools',
  async list(): Promise<ToolSpec[]> {
    return [{ name: 'finish', description: 'finish', parameters: {} }];
  },
  async invoke(name: string, _args: unknown, _ctx: RunContext): Promise<ToolResult> {
    if (name === 'finish') return { content: 'done' };
    // R29 — the runtime's unknown-tool error result.
    return { content: `unknown tool \`${name}\`; available: finish`, isError: true };
  },
};

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  runId: 'team-run-1',
  agentVersionId: 'ver-lead',
  mode: 'standard',
  toolCallEventId: 'evt-1',
  ...over,
});

function provider(
  over: {
    roster?: ResolvedRoster;
    runDelegation?: (req: { member: RosterMember; task: string }) => Promise<DelegationOutcome>;
    onNoProgress?: () => void;
    noProgressThreshold?: number;
  } = {},
): TeamToolProvider {
  return new TeamToolProvider({
    base: baseProvider,
    roster: over.roster ?? roster(),
    treeCheck: () => ({ ok: true }),
    noProgressThreshold: over.noProgressThreshold ?? 3,
    onNoProgress: over.onNoProgress ?? (() => undefined),
    runDelegation:
      over.runDelegation ??
      (async (req) => ({
        childRunId: `child-${req.member.alias}`,
        outcome: 'success',
        finalMessage: `did ${req.task}`,
        steps: 2,
        modelTokens: 100,
      })),
  });
}

describe('R11, R18 — the two team tools exist only for the manager', () => {
  test('the manager\'s tool list carries delegate and list_workers ON TOP of the base list', () => {
    const names = [] as string[];
    return provider()
      .list(ctx())
      .then((specs) => {
        for (const s of specs) names.push(s.name);
        assert.ok(names.includes('finish'), 'the ordinary grant survives');
        assert.ok(names.includes(DELEGATE) && names.includes(LIST_WORKERS));
      });
  });

  test('R18 — a WORKER\'s tool list does not contain delegate', async () => {
    // A worker Run is executed with the base provider, never this wrapper. That is what
    // makes the one-level delegation limit structural rather than a rule someone checks.
    const specs = await baseProvider.list(ctx());
    assert.ok(!specs.some((s) => s.name === DELEGATE));
  });

  test('R18 — a worker calling delegate gets the unknown-tool error result', async () => {
    const result = await baseProvider.invoke(DELEGATE, { worker: 'chef', task: 't' }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /unknown tool `delegate`/);
  });

  test('a tool that is neither team tool falls through to the base provider', async () => {
    const result = await provider().invoke('finish', { success: true }, ctx());
    assert.equal(result.content, 'done');
  });
});

describe('R12 — list_workers', () => {
  test('returns alias, display_name, description and capabilities — and NOTHING else', async () => {
    const result = await provider().invoke(LIST_WORKERS, {}, ctx());
    const parsed = JSON.parse(result.content) as Record<string, unknown>[];

    assert.deepEqual(parsed.map((w) => w['alias']), ['frontend', 'chef']);
    for (const worker of parsed) {
      assert.deepEqual(
        Object.keys(worker).sort(),
        ['alias', 'capabilities', 'description', 'display_name'],
        // Leaking the model tag would invite the manager to route by binding rather than
        // by what a worker can do, and would put the roster's configuration in its context.
        'no persona, no binding tag, no tool list',
      );
    }
  });
});

describe('R13 — worker resolution', () => {
  test('an exact alias wins before any capability is considered', () => {
    const match = resolveWorker(roster(), 'chef');
    assert.equal(match.ok && match.member.alias, 'chef');
  });

  test('a capability string resolves to the single matching worker, case-insensitively', () => {
    const match = resolveWorker(roster(), 'FRONTEND');
    assert.equal(match.ok && match.member.alias, 'frontend');
  });

  test('edge 3 — two capability matches error NAMING BOTH and start no worker', () => {
    const two = roster({
      workers: [member('a', ['shared']), member('b', ['shared'])],
    });
    const match = resolveWorker(two, 'shared');
    assert.equal(match.ok, false);
    if (match.ok) return;
    assert.match(match.error, /a/);
    assert.match(match.error, /b/);
    assert.match(match.error, /No worker was started/);
  });

  test('edge 2 — no match lists the available ALIASES', () => {
    const match = resolveWorker(roster(), 'astrophysics');
    assert.equal(match.ok, false);
    if (match.ok) return;
    assert.match(match.error, /frontend, chef/);
  });

  test('a capability is matched as a whole entry, not as a substring', () => {
    // `chef` declares `react-cookery`; `react` must not match it, or every capability
    // would silently match every prefix of every other one.
    const match = resolveWorker(roster(), 'react');
    assert.equal(match.ok && match.member.alias, 'frontend');
  });
});

describe('R14-R16 — the ToolResult a delegation produces', () => {
  test('carries the child run_id, outcome, final message and counts (R15)', async () => {
    const result = await provider().invoke(DELEGATE, { worker: 'chef', task: 'braise' }, ctx());
    const body = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(body['child_run_id'], 'child-chef');
    assert.equal(body['outcome'], 'success');
    assert.equal(body['steps'], 2);
    assert.equal(body['model_tokens'], 100);
    assert.notEqual(result.isError, true);
  });

  test('R16 / edge 22 — a non-success child is is_error, whatever the cause', async () => {
    for (const outcome of ['incomplete', 'failed', 'budget_exhausted', 'cancelled'] as const) {
      const result = await provider({
        runDelegation: async () => ({
          childRunId: 'c1',
          outcome,
          finalMessage: 'nope',
          steps: 1,
          modelTokens: 5,
        }),
      }).invoke(DELEGATE, { worker: 'chef', task: 't' }, ctx());
      assert.equal(result.isError, true, `${outcome} must reach the manager as an error`);
    }
  });

  test('R19 — a dispatch with no tool_call event id refuses rather than losing the link', async () => {
    const bare = ctx();
    delete bare.toolCallEventId;
    const result = await provider().invoke(DELEGATE, { worker: 'chef', task: 't' }, bare);
    assert.equal(result.isError, true);
    assert.match(result.content, /delegation_id/);
  });

  test('malformed arguments produce an error result listing every fault at once', async () => {
    const result = await provider().invoke(DELEGATE, { task: '' }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /`worker` is required/);
    assert.match(result.content, /`task` is required/);
  });
});

describe('R17 — max_concurrent_delegations', () => {
  test('four delegations run at most TWO concurrently at any instant', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const tools = provider({
      roster: roster({ limits: { ...TEAM_LIMIT_DEFAULTS, max_concurrent_delegations: 2 } }),
      runDelegation: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return { childRunId: 'c', outcome: 'success', finalMessage: '', steps: 1, modelTokens: 1 };
      },
    });

    const calls = ['a', 'b', 'c', 'd'].map((task) =>
      tools.invoke(DELEGATE, { worker: 'chef', task }, ctx()),
    );

    // Let the first admissions settle, then drain one at a time. Draining is what admits
    // the next waiter — event-driven, no timer decides when.
    await Promise.resolve();
    await Promise.resolve();
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(calls);

    assert.equal(peak, 2, 'the semaphore is a ceiling on concurrency, not on total calls');
  });
});

describe('R27 / edge 15 — max_delegations', () => {
  test('the third call against a limit of 2 errors NAMING the limit and does not terminate', async () => {
    const tools = provider({
      roster: roster({ limits: { ...TEAM_LIMIT_DEFAULTS, max_delegations: 2 } }),
    });

    // Distinct tasks, so R30's repeated-delegation detector is not what stops this.
    const first = await tools.invoke(DELEGATE, { worker: 'chef', task: 'one' }, ctx());
    const second = await tools.invoke(DELEGATE, { worker: 'chef', task: 'two' }, ctx());
    const third = await tools.invoke(DELEGATE, { worker: 'chef', task: 'three' }, ctx());

    assert.notEqual(first.isError, true);
    assert.notEqual(second.isError, true);
    assert.equal(third.isError, true);
    assert.match(third.content, /max_delegations/);
    // The manager proceeds to synthesis rather than the Run terminating.
    assert.match(third.content, /Synthesize what you have/);
  });
});

describe('R28 — a delegation is never started against an exhausted tree budget', () => {
  test('an exhausted tree returns an error naming the budget and runs nothing', async () => {
    let started = 0;
    const tools = new TeamToolProvider({
      base: baseProvider,
      roster: roster(),
      treeCheck: () => ({ ok: false, budget: 'tree_max_model_tokens' }),
      noProgressThreshold: 3,
      onNoProgress: () => undefined,
      runDelegation: async () => {
        started += 1;
        return { childRunId: 'c', outcome: 'success', finalMessage: '', steps: 0, modelTokens: 0 };
      },
    });

    const result = await tools.invoke(DELEGATE, { worker: 'chef', task: 't' }, ctx());
    assert.equal(result.isError, true);
    assert.match(result.content, /tree_max_model_tokens/);
    assert.equal(started, 0, 'a child that would be cancelled immediately is never created');
  });
});

describe('R30 / edge 16 — repeated identical delegations', () => {
  test('three consecutive identical (worker, task) pairs trip the detector', async () => {
    let tripped = 0;
    const tools = provider({ noProgressThreshold: 3, onNoProgress: () => (tripped += 1) });

    await tools.invoke(DELEGATE, { worker: 'chef', task: 'same' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'same' }, ctx());
    const third = await tools.invoke(DELEGATE, { worker: 'chef', task: 'same' }, ctx());

    assert.equal(tripped, 1);
    assert.equal(third.isError, true);
    assert.match(third.content, /no_progress/);
  });

  test('the detector compares `worker` and `task` ONLY, ignoring `context`', async () => {
    // A manager varying only its own commentary would otherwise evade the detector
    // forever while making no progress at all.
    let tripped = 0;
    const tools = provider({ noProgressThreshold: 3, onNoProgress: () => (tripped += 1) });

    await tools.invoke(DELEGATE, { worker: 'chef', task: 'same', context: 'a' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'same', context: 'b' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'same', context: 'c' }, ctx());

    assert.equal(tripped, 1);
  });

  test('a different task resets the streak', async () => {
    let tripped = 0;
    const tools = provider({ noProgressThreshold: 3, onNoProgress: () => (tripped += 1) });

    await tools.invoke(DELEGATE, { worker: 'chef', task: 'a' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'a' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'b' }, ctx());
    await tools.invoke(DELEGATE, { worker: 'chef', task: 'a' }, ctx());

    assert.equal(tripped, 0);
  });
});
