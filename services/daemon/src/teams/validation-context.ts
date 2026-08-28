/**
 * Builds the TeamValidationContext every Team write needs — Team Orchestration R6-R9c, R33.
 *
 * Unlike an Agent write, this fans out to NOTHING. A Team resolves against Agents, and
 * Agents live in this daemon's own database — cross-service boundary 4 puts definition and
 * validation on this side of the wall. So a Team can be validated with forge unreachable,
 * which is correct: the references it makes have nothing to do with forge.
 *
 * The config-derived fields are read once at startup and closed over, for the same reason
 * the Agent context does it: they come from files that only change on restart, and
 * re-reading them per request would let a Team validate against a config the running
 * daemon is not actually enforcing.
 */

import type { Pool } from 'pg';
import type { AgentDefinition, BudgetKey } from '../agents/definition-schema.js';
import { BUDGET_KEYS } from '../agents/definition-schema.js';
import type { ResolvedSnapshot } from '../agents/resolver.js';
import { TREE_BUDGET_KEYS, type TreeBudgetKey } from './team-schema.js';
import { summariseAgent, type AgentSummary, type TeamValidationContext } from './validator.js';

export type TeamContextProvider = () => Promise<TeamValidationContext>;

/**
 * The values in `config/runtime.yaml` as shipped (R9b's stated defaults).
 *
 * Present so a config missing the key fails closed at a documented number rather than
 * `undefined` — which compares false against every budget and silently disables the ceiling
 * the check exists to enforce. That exact defect has shipped in this repo three times.
 */
const SHIPPED_TREE_CEILINGS: Record<TreeBudgetKey, number> = {
  tree_max_wall_clock_seconds: 28_800,
  tree_max_model_tokens: 6_000_000,
};

const SHIPPED_CEILINGS: Record<BudgetKey, number> = {
  max_steps: 200,
  max_model_tokens: 2_000_000,
  max_wall_clock_seconds: 14_400,
  max_tool_calls: 600,
};

export interface TeamContextOptions {
  pool: Pool;
  /** Parsed `runtime.yaml`. */
  runtimeConfig: Record<string, unknown>;
  /** Parsed `models.yaml`. */
  modelsConfig: Record<string, unknown>;
}

function numbersFor<K extends string>(
  source: Record<string, unknown> | undefined,
  keys: readonly K[],
  fallback: Record<K, number>,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const raw = source?.[key];
    out[key] = typeof raw === 'number' ? raw : fallback[key];
  }
  return out;
}

/** Every Agent, deleted ones included — R6 must be able to say a name is deleted. */
export async function listAgentSummaries(pool: Pool): Promise<AgentSummary[]> {
  const { rows } = await pool.query<{
    agent_id: string;
    name: string;
    deleted_at: string | null;
    agent_version_id: string;
    definition: AgentDefinition;
    resolved_snapshot: ResolvedSnapshot;
  }>(
    `SELECT a.agent_id, a.name, a.deleted_at,
            av.agent_version_id, av.definition, av.resolved_snapshot
       FROM agents a
       JOIN agent_versions av
         ON av.agent_id = a.agent_id AND av.version = a.current_version`,
  );

  return rows.map((row) =>
    summariseAgent({
      agent_id: row.agent_id,
      name: row.name,
      deleted: row.deleted_at !== null,
      agent_version_id: row.agent_version_id,
      definition: row.definition,
      resolved_snapshot: row.resolved_snapshot,
    }),
  );
}

export function createTeamContextProvider(options: TeamContextOptions): TeamContextProvider {
  const budgetCeilings = numbersFor(
    options.runtimeConfig['budget_ceilings'] as Record<string, unknown> | undefined,
    BUDGET_KEYS,
    SHIPPED_CEILINGS,
  );
  const treeBudgetCeilings = numbersFor(
    options.runtimeConfig['tree_budget_ceilings'] as Record<string, unknown> | undefined,
    TREE_BUDGET_KEYS,
    SHIPPED_TREE_CEILINGS,
  );

  const scheduling = (options.modelsConfig['scheduling'] ?? {}) as Record<string, unknown>;
  const maxConcurrentTotal =
    typeof scheduling['max_concurrent_total'] === 'number' ? scheduling['max_concurrent_total'] : 2;

  return async function getTeamContext(): Promise<TeamValidationContext> {
    return {
      agents: await listAgentSummaries(options.pool),
      budgetCeilings,
      treeBudgetCeilings,
      maxConcurrentTotal,
    };
  };
}
