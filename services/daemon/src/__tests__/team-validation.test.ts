/**
 * P8 — the Team schema and roster resolution. Team Orchestration R1-R10, R22, R29a, R33.
 *
 * Written against the spec's ACCEPTANCE CRITERIA, which are what the phase is defined by:
 *
 *   nonexistent worker            -> rejected naming that worker, nothing persisted
 *   manager also in workers       -> rejected naming the conflict
 *   worker with no capabilities   -> rejected naming that worker
 *   concurrency 5 vs total 2      -> rejected naming both values
 *   per_delegation over a ceiling -> rejected naming the budget and the ceiling
 *   Code-mode manager             -> rejected naming the manager and the constraint
 *   a valid Team                  -> resolved_roster pins an agent_version_id for everyone
 *
 * "Nothing persisted" is structural rather than asserted: `validateTeam` has no store and
 * cannot write. The route's only path to `save` runs through a result with zero errors.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_LIMIT_DEFAULTS,
  mergeDelegationBudgets,
  resolveLimits,
  validateTeamStructure,
} from '../teams/team-schema.js';
import { validateTeam, type AgentSummary, type TeamValidationContext } from '../teams/validator.js';
import type { BudgetKey } from '../agents/definition-schema.js';

const BUDGETS: Record<BudgetKey, number> = {
  max_steps: 40,
  max_model_tokens: 200_000,
  max_wall_clock_seconds: 1_800,
  max_tool_calls: 120,
};

function agent(over: Partial<AgentSummary> & { name: string }): AgentSummary {
  return {
    agent_id: `id-${over.name}`,
    agent_version_id: `ver-${over.name}`,
    deleted: false,
    display_name: over.name,
    description: 'an agent',
    capabilities: ['general'],
    mode: 'standard',
    workspace_required: true,
    budgets: BUDGETS,
    ...over,
  };
}

function ctx(over: Partial<TeamValidationContext> = {}): TeamValidationContext {
  return {
    agents: [
      agent({ name: 'lead', capabilities: ['planning'], mode: 'standard' }),
      agent({ name: 'fe', capabilities: ['frontend', 'react'] }),
      agent({ name: 'chef', capabilities: ['cooking'] }),
    ],
    budgetCeilings: {
      max_steps: 200,
      max_model_tokens: 2_000_000,
      max_wall_clock_seconds: 14_400,
      max_tool_calls: 600,
    },
    treeBudgetCeilings: { tree_max_wall_clock_seconds: 28_800, tree_max_model_tokens: 6_000_000 },
    maxConcurrentTotal: 2,
    ...over,
  };
}

function team(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    name: 'a-team',
    manager: { agent_name: 'lead' },
    workers: [{ agent_name: 'fe', alias: 'frontend' }, { agent_name: 'chef' }],
    ...over,
  };
}

const messages = (errors: { path: string; message: string }[]): string => JSON.stringify(errors);

describe('R1-R5 — the schema is closed', () => {
  test('an unknown key at any depth fails naming the key PATH', () => {
    const { errors } = validateTeamStructure(
      team({ limits: { max_delegation: 4 } }),
    );
    assert.ok(
      errors.some((e) => e.path === 'limits.max_delegation'),
      // A permissive schema would save this cleanly and the limit the operator thought
      // they set would simply be absent.
      `the typo must be named by path: ${messages(errors)}`,
    );
  });

  test('a missing schema_version fails NAMING it rather than defaulting to 1', () => {
    const raw = team();
    delete raw['schema_version'];
    const { errors } = validateTeamStructure(raw);
    assert.ok(errors.some((e) => e.path === 'schema_version'));
  });

  test('a future schema_version names the supported one', () => {
    const { errors } = validateTeamStructure(team({ schema_version: 2 }));
    assert.match(messages(errors), /supports 1/);
  });

  test('workers must list at least one entry', () => {
    const { errors } = validateTeamStructure(team({ workers: [] }));
    assert.ok(errors.some((e) => e.path === 'workers'));
  });

  test('R4 — omitted limits resolve to the shipped defaults', () => {
    const limits = resolveLimits({});
    assert.equal(limits.max_delegations, TEAM_LIMIT_DEFAULTS.max_delegations);
    assert.equal(limits.max_concurrent_delegations, 2);
    assert.equal(limits.tree_max_wall_clock_seconds, 3600);
    assert.equal(limits.tree_max_model_tokens, 600_000);
  });

  test('a budget below 1 is rejected — it could not admit even one Step', () => {
    const { errors } = validateTeamStructure(
      team({ limits: { per_delegation_budgets: { max_steps: 0 } } }),
    );
    assert.ok(errors.some((e) => e.path === 'limits.per_delegation_budgets.max_steps'));
  });
});

describe('R22 — merged budget precedence', () => {
  test('per_delegation_budgets wins over the worker\'s own pinned budgets', () => {
    const merged = mergeDelegationBudgets(BUDGETS, { max_steps: 5 });
    assert.equal(merged.max_steps, 5, 'the Team override applies');
    assert.equal(merged.max_model_tokens, BUDGETS.max_model_tokens, 'untouched keys keep the worker\'s value');
  });
});

describe('acceptance criteria — roster resolution', () => {
  test('a valid Team pins an agent_version_id for the manager AND every worker (R10)', () => {
    const result = validateTeam(team(), ctx());
    assert.deepEqual(result.errors, []);
    assert.ok(result.roster);
    assert.equal(result.roster.manager.agent_version_id, 'ver-lead');
    assert.deepEqual(
      result.roster.workers.map((w) => w.agent_version_id),
      ['ver-fe', 'ver-chef'],
    );
    // R3 — alias defaults to agent_name.
    assert.deepEqual(result.roster.workers.map((w) => w.alias), ['frontend', 'chef']);
  });

  test('R6 — a nonexistent worker is rejected NAMING that worker, and nothing resolves', () => {
    const result = validateTeam(
      team({ workers: [{ agent_name: 'nobody' }] }),
      ctx(),
    );
    assert.match(messages(result.errors), /nobody/);
    assert.equal(result.roster, null, 'no roster, therefore nothing to persist');
  });

  test('R6 — a SOFT-DELETED Agent does not resolve either', () => {
    const result = validateTeam(
      team(),
      ctx({
        agents: [
          agent({ name: 'lead', capabilities: ['planning'] }),
          agent({ name: 'fe', deleted: true }),
          agent({ name: 'chef', capabilities: ['cooking'] }),
        ],
      }),
    );
    assert.match(messages(result.errors), /no Agent named `fe`/);
  });

  test('R7 — the manager also appearing in workers is rejected naming the conflict', () => {
    const result = validateTeam(
      team({ workers: [{ agent_name: 'lead' }, { agent_name: 'fe' }] }),
      ctx(),
    );
    assert.match(messages(result.errors), /`lead` is the manager and cannot also be a worker/);
  });

  test('R8 — two workers resolving to the same alias is rejected naming the collision', () => {
    const result = validateTeam(
      team({ workers: [{ agent_name: 'fe', alias: 'x' }, { agent_name: 'chef', alias: 'x' }] }),
      ctx(),
    );
    const paths = result.errors.map((e) => e.path);
    // Reported against BOTH entries: an operator fixing one has to know which two collided.
    assert.ok(paths.includes('workers[0].alias') && paths.includes('workers[1].alias'));
  });

  test('R9 — a worker with an EMPTY capabilities list is rejected naming it', () => {
    const result = validateTeam(
      team(),
      ctx({
        agents: [
          agent({ name: 'lead', capabilities: ['planning'] }),
          agent({ name: 'fe', capabilities: [] }),
          agent({ name: 'chef', capabilities: ['cooking'] }),
        ],
      }),
    );
    // It could never be matched by capability, which is half of how `delegate` resolves.
    assert.match(messages(result.errors), /worker `fe` declares no `capabilities`/);
  });

  test('R29a — a Code-mode manager is rejected naming the manager AND the constraint', () => {
    const result = validateTeam(
      team(),
      ctx({
        agents: [
          agent({ name: 'lead', capabilities: ['planning'], mode: 'code' }),
          agent({ name: 'fe', capabilities: ['frontend'] }),
          agent({ name: 'chef', capabilities: ['cooking'] }),
        ],
      }),
    );
    assert.match(messages(result.errors), /manager `lead`/);
    assert.match(messages(result.errors), /no callback channel/);
  });

  test('R33 — max_concurrent_delegations 5 against max_concurrent_total 2 names BOTH', () => {
    const result = validateTeam(
      team({ limits: { max_concurrent_delegations: 5 } }),
      ctx({ maxConcurrentTotal: 2 }),
    );
    const text = messages(result.errors);
    assert.match(text, /5/);
    assert.match(text, /2/);
  });

  test('R9a / edge 25 — a per_delegation budget over its ceiling names the budget and the ceiling', () => {
    const result = validateTeam(
      team({ limits: { per_delegation_budgets: { max_steps: 500 } } }),
      ctx(),
    );
    const text = messages(result.errors);
    assert.match(text, /max_steps/);
    assert.match(text, /500/);
    assert.match(text, /200/);
  });

  test('R9b — a tree budget over its ceiling is rejected naming the ceiling', () => {
    const result = validateTeam(
      team({ limits: { tree_max_model_tokens: 9_000_000 } }),
      ctx(),
    );
    assert.match(messages(result.errors), /6000000/);
  });

  test('R9c — a tree budget one delegation could exhaust names both values', () => {
    // 100k tree budget against a worker allowed 200k in a single Run: the first delegation
    // exhausts the tree and the Team Run can never reach synthesis.
    const result = validateTeam(
      team({ limits: { tree_max_model_tokens: 100_000 } }),
      ctx(),
    );
    const text = messages(result.errors);
    assert.match(text, /100000/);
    assert.match(text, /200000/);
  });

  test('R9c is measured AFTER per_delegation_budgets, not before', () => {
    // Lowering every member to 50k makes a 100k tree budget legitimate. Checking the
    // worker's own 200k instead would reject a Team that is perfectly bounded.
    const result = validateTeam(
      team({
        limits: { tree_max_model_tokens: 100_000, per_delegation_budgets: { max_model_tokens: 50_000 } },
      }),
      ctx(),
    );
    assert.deepEqual(result.errors, []);
  });

  test('every fault is returned at once, not the first', () => {
    const result = validateTeam(
      team({
        workers: [{ agent_name: 'nobody' }, { agent_name: 'lead' }],
        limits: { max_concurrent_delegations: 9 },
      }),
      ctx(),
    );
    assert.ok(result.errors.length >= 3, `expected several errors, got ${messages(result.errors)}`);
  });
});
