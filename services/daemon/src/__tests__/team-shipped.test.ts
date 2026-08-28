/**
 * P8 — the shipped example loads on a fresh installation. Team Orchestration R41, R45.
 *
 * "`teams/frontend-feature-team.yaml` ships as a WORKING example." A shipped example that
 * does not validate is worse than none: it is the first thing an operator copies, and P4
 * shipped two Agent examples specifically so that a fresh installation has something that
 * demonstrably works before anything has been trained or ingested.
 *
 * This also exercises the directory loader itself, which is the component that has been
 * written and left uncalled once already in this repo (agents/file-loader.ts, P4 through
 * P6). The loader is driven here against the real `teams/` directory, so a Team file that
 * stops parsing, or a manager Agent that gets deleted, fails a unit test rather than a
 * smoke run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { validate as validateAgent, type ModelBinding, type ValidationContext } from '../agents/validator.js';
import { buildSnapshot } from '../agents/resolver.js';
import { validateTeam, summariseAgent, type TeamValidationContext } from '../teams/validator.js';
import { loadTeamDirectory, formatTeamOutcomes } from '../teams/file-loader.js';
import type { TeamStore } from '../teams/store.js';
import type { AgentDefinition } from '../agents/definition-schema.js';

const AGENTS_DIR = new URL('../../../../agents/', import.meta.url).pathname;
const TEAMS_DIR = new URL('../../../../teams/', import.meta.url).pathname;

function binding(id: string): ModelBinding {
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
  };
}

/** A fresh installation: seeded Corpora with zero chunks, base bindings only. */
const agentCtx: ValidationContext = {
  bindings: [binding('qwen3-4b-instruct'), binding('qwen3-0.6b')],
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
    max_model_tokens: 2_000_000,
    max_wall_clock_seconds: 14_400,
    max_tool_calls: 600,
  },
  budgetDefaults: {
    max_steps: 40,
    max_model_tokens: 200_000,
    max_wall_clock_seconds: 1_800,
    max_tool_calls: 120,
  },
  codeModeMinContext: 16384,
  reservedOutputTokens: 2048,
  autoInjectK: 4,
};

/** Resolve a shipped Agent exactly as startup would, so the Team sees real values. */
function shippedAgent(name: string) {
  const raw = parseYaml(readFileSync(`${AGENTS_DIR}${name}.yaml`, 'utf8')) as AgentDefinition;
  const result = validateAgent(raw, agentCtx);
  assert.deepEqual(result.errors, [], `${name}.yaml must validate on a fresh installation`);
  assert.ok(result.definition && result.resolved);
  return summariseAgent({
    agent_id: `id-${name}`,
    name,
    deleted: false,
    agent_version_id: `ver-${name}`,
    definition: result.definition,
    resolved_snapshot: buildSnapshot(
      result.definition,
      result.resolved.binding,
      result.resolved.corpusId,
      result.warnings,
      agentCtx,
    ),
  });
}

const teamCtx: TeamValidationContext = {
  agents: ['team-lead', 'frontend-engineer', 'chef'].map(shippedAgent),
  budgetCeilings: agentCtx.budgetCeilings,
  // The values shipped in config/runtime.yaml.
  treeBudgetCeilings: { tree_max_wall_clock_seconds: 28_800, tree_max_model_tokens: 6_000_000 },
  // The value shipped in config/models.yaml.
  maxConcurrentTotal: 2,
};

describe('R45 — the shipped example Team', () => {
  test('frontend-feature-team.yaml validates against the shipped Agents', () => {
    const raw = parseYaml(readFileSync(`${TEAMS_DIR}frontend-feature-team.yaml`, 'utf8'));
    const result = validateTeam(raw, teamCtx);
    assert.deepEqual(result.errors, [], 'a shipped example must never fail to load');
    assert.ok(result.roster);
    // The acceptance criterion, stated on the roster: a pinned agent_version_id for the
    // manager and every worker.
    assert.equal(result.roster.manager.agent_version_id, 'ver-team-lead');
    assert.deepEqual(
      result.roster.workers.map((w) => w.agent_version_id),
      ['ver-frontend-engineer', 'ver-chef'],
    );
    assert.equal(result.roster.workers.length, 2, 'R45 — a manager and at least two workers');
  });

  test('R29a — the shipped manager is standard mode, or it could never delegate', () => {
    assert.equal(shippedAgent('team-lead').mode, 'standard');
  });

  test('R13 — the two workers cannot be confused by capability', () => {
    const raw = parseYaml(readFileSync(`${TEAMS_DIR}frontend-feature-team.yaml`, 'utf8'));
    const roster = validateTeam(raw, teamCtx).roster!;
    const [a, b] = roster.workers;
    const overlap = a!.capabilities.filter((c) => b!.capabilities.includes(c));
    // An overlapping capability would make `delegate` ambiguous, and edge 3's error would
    // be the shipped example's normal behaviour.
    assert.deepEqual(overlap, []);
  });

  test('invariant 4 — no generated uuid appears in a definition file', () => {
    const raw = readFileSync(`${TEAMS_DIR}frontend-feature-team.yaml`, 'utf8');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(raw));
  });
});

describe('R41 — the teams/ directory loader', () => {
  /** Records what the loader tried to save, without a database. */
  function recordingStore(): { store: TeamStore; saved: string[] } {
    const saved: string[] = [];
    return {
      saved,
      store: {
        async save(definition: { name: string }) {
          saved.push(definition.name);
          return { teamId: 'team-1', version: 1, teamVersionId: 'tv-1', created: true };
        },
      } as unknown as TeamStore,
    };
  }

  test('loads every valid file in the real teams/ directory', async () => {
    const { store, saved } = recordingStore();
    const outcomes = await loadTeamDirectory(TEAMS_DIR, store, teamCtx);

    assert.ok(
      outcomes.every((o) => o.status !== 'skipped'),
      // The startup log is what an operator reads, so it carries the reason.
      `nothing shipped may be skipped:\n${formatTeamOutcomes(outcomes)}`,
    );
    assert.ok(saved.includes('frontend-feature-team'));
  });

  test('a missing directory is legitimate, not a fault', async () => {
    const { store } = recordingStore();
    const outcomes = await loadTeamDirectory('/nonexistent/teams', store, teamCtx);
    // An installation may manage Teams purely through the API, or run none at all.
    assert.deepEqual(outcomes, []);
  });

  test('an invalid file is SKIPPED with its full error list, never fatal', async () => {
    const { store, saved } = recordingStore();
    // The real directory, validated against a context with no Agents at all: every roster
    // entry fails to resolve, so every file is skipped and the loader still returns.
    const outcomes = await loadTeamDirectory(TEAMS_DIR, store, { ...teamCtx, agents: [] });

    assert.ok(outcomes.length > 0);
    assert.ok(outcomes.every((o) => o.status === 'skipped'));
    assert.ok((outcomes[0]!.errors ?? []).length > 0, 'the full error list, not just the first');
    assert.deepEqual(saved, [], 'nothing is persisted for a file that did not validate');
  });
});
