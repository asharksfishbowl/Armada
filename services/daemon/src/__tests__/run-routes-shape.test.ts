/**
 * The `GET /api/runs` response CONTRACT — P9, design-dashboard.md dependency rulings 6 & 7.
 *
 * WHY THIS TEST EXISTS. The dashboard's version pin badge (Requirement 106) makes
 * cross-cutting invariant 2 legible: a run executed against a pinned agent version, and
 * editing the agent afterwards never changes what ran. Rendering `v1 ↑2` needs the executed
 * version INTEGER and the identity of the agent it is being compared against. The run row
 * carried neither — only `agent_version_id`, an opaque uuid that no HTTP route resolved to
 * anything.
 *
 * These two fields are therefore not decoration. Drop either one and the badge silently
 * degrades: without `version` there is no number to render, and without `agent_id` a
 * soft-deleted agent (Agent Definition R26, which hides an agent from LIST endpoints only)
 * becomes indistinguishable from an agent at version 1 — which is exactly the `↑0`
 * misreading Requirement 106a forbids.
 *
 * "A requirement enforced nowhere is decorative." This is the thing that fails when the
 * contract is violated.
 *
 * NO DATABASE. The store is faked, because what is under test is the SHAPE the route
 * emits, not the SQL. The join itself is exercised by the integration path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunRoutes } from '../gateway/routes/runs.js';
import type { RunStore, RunWithAgent } from '../runs/store.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';

const ROW: RunWithAgent = {
  run_id: '11111111-1111-4111-8111-111111111111',
  agent_version_id: '22222222-2222-4222-8222-222222222222',
  agent_id: '33333333-3333-4333-8333-333333333333',
  version: 2,
  status: 'terminal',
  outcome: 'success',
  result: 'done',
  mode: 'standard',
  workspace_path: null,
  steps_used: 4,
  model_tokens_used: 1200,
  tool_calls_used: 3,
  wall_clock_ms_used: 8400,
  queued_ms_total: 0,
  parent_run_id: null,
  delegation_id: null,
  is_team_run: true,
  team_version_id: '44444444-4444-4444-8444-444444444444',
  started_at: '2026-08-28T00:00:00.000Z',
  ended_at: '2026-08-28T00:00:08.400Z',
};

function routes() {
  const store = {
    get: async () => ROW,
    list: async () => [ROW],
  } as unknown as RunStore;
  const orchestrator = {} as unknown as RunOrchestrator;
  return createRunRoutes(orchestrator, store);
}

test('a run LIST row carries agent_id and version (dependency ruling 6)', async () => {
  const response = await routes().list(new URLSearchParams());
  assert.equal(response.status, 200);

  const body = response.body as { runs: Record<string, unknown>[] };
  const row = body.runs[0];
  assert.ok(row);

  assert.equal(
    row.version,
    2,
    'the executed version integer is gone. Requirement 106 cannot render `v1 ↑2` without it.',
  );
  assert.equal(
    row.agent_id,
    ROW.agent_id,
    'agent_id is gone. Without it a soft-deleted agent is indistinguishable from a current ' +
      'one, and Requirement 106a\'s `v?` badge collapses into the forbidden `↑0`.',
  );

  // The fields that were already there and that the dashboard also reads.
  assert.equal(row.run_id, ROW.run_id);
  assert.equal(row.agent_version_id, ROW.agent_version_id);
  assert.equal(row.status, 'terminal');
  assert.equal(row.outcome, 'success');
  assert.equal(row.parent_run_id, null);
  assert.equal(row.is_team_run, true);
});

test('a run DETAIL response carries team_version_id (dependency ruling 7)', async () => {
  const response = await routes().get(ROW.run_id);
  assert.equal(response.status, 200);
  const body = response.body as Record<string, unknown>;

  assert.equal(
    body.team_version_id,
    ROW.team_version_id,
    'team_version_id is gone. It is the third field ruling 7 names and the only one that ' +
      'was unreachable — without it a run cannot be traced back to the Team that produced it.',
  );

  // Ruling 7's other two were already on the summary and must stay on the detail too.
  assert.equal(body.is_team_run, true);
  assert.equal(body.parent_run_id, null);

  // Detail is a superset of the list row, so the badge works on both surfaces.
  assert.equal(body.version, 2);
  assert.equal(body.agent_id, ROW.agent_id);

  const counters = body.counters as Record<string, unknown>;
  assert.equal(counters.steps_used, 4);
  assert.equal(counters.model_tokens_used, 1200);
});

test('the list row stays a strict subset of the detail response', async () => {
  // The dashboard renders the pin badge from a LIST row on RunsPage and from a DETAIL
  // response on RunDetailPage. If the two ever disagree about which fields exist, one of
  // those two surfaces breaks and the other does not — the hardest kind of bug to see.
  const list = (await routes().list(new URLSearchParams())).body as {
    runs: Record<string, unknown>[];
  };
  const detail = (await routes().get(ROW.run_id)).body as Record<string, unknown>;

  for (const key of Object.keys(list.runs[0] ?? {})) {
    assert.ok(key in detail, `\`${key}\` is on the list row but missing from the detail response`);
  }
});
