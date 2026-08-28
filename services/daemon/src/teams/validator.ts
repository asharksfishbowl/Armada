/**
 * Roster resolution — Team Orchestration R6-R10, R29a, R33.
 *
 * Structure is already checked by team-schema.ts. This module answers the questions that
 * need the Agent registry and config: does this Agent exist, can it be matched by
 * capability, may it manage, and do these limits fit inside the platform's ceilings.
 *
 * EVERY ERROR IS RETURNED, NOT THE FIRST. Both passes accumulate into one list, matching
 * R39's full-error-list responses and the Agent surface's behaviour.
 *
 * ── THE RESOLVED ROSTER IS INVARIANT 2 MADE CONCRETE ────────────────────────
 * Saving a Team pins each member's `agent_version_id`. Every delegation in one Team Run
 * targets those pinned versions even if the underlying Agent is edited mid-Run (edge 10),
 * and a worker deleted afterwards is caught at Run start rather than silently swapped
 * (edge 11). Resolving by name at delegation time instead would make a Team Run's
 * behaviour depend on when each `delegate` call happened to fire.
 */

import type { ValidationError } from '../agents/definition-schema.js';
import { BUDGET_KEYS, type BudgetKey } from '../agents/definition-schema.js';
import type { AgentDefinition } from '../agents/definition-schema.js';
import type { ResolvedSnapshot } from '../agents/resolver.js';
import {
  TREE_BUDGET_KEYS,
  mergeDelegationBudgets,
  resolveLimits,
  validateTeamStructure,
  type TeamDefinition,
  type TeamLimits,
  type TreeBudgetKey,
} from './team-schema.js';

/** One Agent as the Team validator needs to see it. */
export interface AgentSummary {
  agent_id: string;
  name: string;
  agent_version_id: string;
  deleted: boolean;
  display_name: string | null;
  description: string | null;
  capabilities: string[];
  mode: 'standard' | 'code';
  workspace_required: boolean;
  budgets: Record<BudgetKey, number>;
}

export interface TeamValidationContext {
  agents: AgentSummary[];
  /** R9a — from `budget_ceilings` in config/runtime.yaml. */
  budgetCeilings: Record<BudgetKey, number>;
  /** R9b — from `tree_budget_ceilings` in config/runtime.yaml. */
  treeBudgetCeilings: Record<TreeBudgetKey, number>;
  /** R33 — from `scheduling.max_concurrent_total` in config/models.yaml. */
  maxConcurrentTotal: number;
}

/**
 * R10 — one pinned roster entry.
 *
 * Carries everything a delegation needs so nothing is re-resolved at Run time: the alias
 * to match on, the capabilities `delegate` searches, and the pinned version to execute.
 */
export interface RosterMember {
  alias: string;
  agent_name: string;
  agent_id: string;
  agent_version_id: string;
  display_name: string | null;
  description: string | null;
  capabilities: string[];
  /** R22 — the merged budgets this member's delegations run under. */
  budgets: Record<BudgetKey, number>;
  workspace_required: boolean;
}

export interface ResolvedRoster {
  manager: RosterMember;
  /** R2 — appended to the manager's persona for the synthesis Step. */
  synthesis_prompt: string | null;
  workers: RosterMember[];
  limits: TeamLimits;
}

export interface TeamValidationResult {
  errors: ValidationError[];
  warnings: string[];
  definition: TeamDefinition | null;
  roster: ResolvedRoster | null;
}

function toMember(
  agent: AgentSummary,
  alias: string,
  perDelegation: Partial<Record<BudgetKey, number>>,
): RosterMember {
  return {
    alias,
    agent_name: agent.name,
    agent_id: agent.agent_id,
    agent_version_id: agent.agent_version_id,
    display_name: agent.display_name,
    description: agent.description,
    capabilities: agent.capabilities,
    budgets: mergeDelegationBudgets(agent.budgets, perDelegation),
    workspace_required: agent.workspace_required,
  };
}

export function validateTeam(raw: unknown, ctx: TeamValidationContext): TeamValidationResult {
  const structural = validateTeamStructure(raw);
  const errors = [...structural.errors];
  const warnings: string[] = [];

  // Reference resolution runs EVEN WHEN STRUCTURAL ERRORS EXIST, so an operator sees both
  // kinds at once. Every check below guards its own field.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors, warnings, definition: null, roster: null };
  }

  const def = raw as unknown as TeamDefinition;
  const limits = resolveLimits(def);
  const byName = new Map(ctx.agents.map((a) => [a.name, a]));

  // ── R6 — every named Agent must resolve to a non-deleted Agent ─────────────
  const known = ctx.agents.filter((a) => !a.deleted).map((a) => a.name);
  const resolveAgent = (name: unknown, path: string): AgentSummary | null => {
    if (typeof name !== 'string' || !name) return null;
    const found = byName.get(name);
    if (!found || found.deleted) {
      errors.push({
        path,
        message: `no Agent named \`${name}\`; available: ${known.join(', ') || '(none)'}`,
      });
      return null;
    }
    return found;
  };

  const managerAgent = resolveAgent(def.manager?.agent_name, 'manager.agent_name');
  const workerSpecs = Array.isArray(def.workers) ? def.workers : [];

  // ── R7 — the manager may not also be a worker ──────────────────────────────
  // A manager delegating to itself is a recursion the one-level rule (non-goal 2) forbids,
  // and it would give one Agent two roster identities in the same Run.
  const managerName = typeof def.manager?.agent_name === 'string' ? def.manager.agent_name : null;
  for (const [index, worker] of workerSpecs.entries()) {
    if (managerName && worker?.agent_name === managerName) {
      errors.push({
        path: `workers[${index}].agent_name`,
        message:
          `\`${managerName}\` is the manager and cannot also be a worker; ` +
          'all coordination passes through the manager',
      });
    }
  }

  // ── R8 — aliases are unique within the Team ────────────────────────────────
  // Resolved BEFORE use so a collision is reported once against every colliding entry
  // rather than letting the last one win silently.
  const aliasCounts = new Map<string, number[]>();
  for (const [index, worker] of workerSpecs.entries()) {
    const alias = worker?.alias ?? worker?.agent_name;
    if (typeof alias !== 'string' || !alias) continue;
    aliasCounts.set(alias, [...(aliasCounts.get(alias) ?? []), index]);
  }
  for (const [alias, indexes] of aliasCounts) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      errors.push({
        path: `workers[${index}].alias`,
        message:
          `alias \`${alias}\` is declared by workers ${indexes.join(', ')}; ` +
          'aliases must be unique within a Team because `delegate` resolves by alias first',
      });
    }
  }

  const workers: RosterMember[] = [];
  for (const [index, worker] of workerSpecs.entries()) {
    const agent = resolveAgent(worker?.agent_name, `workers[${index}].agent_name`);
    if (!agent) continue;

    // ── R9 — a worker with no capabilities could never be matched ────────────
    // `delegate` resolves by alias and then by capability. A worker declaring neither a
    // reason to exist nor a way to be found is a definition mistake, not a preference.
    if (agent.capabilities.length === 0) {
      errors.push({
        path: `workers[${index}].agent_name`,
        message:
          `worker \`${agent.name}\` declares no \`capabilities\`, so it could never be ` +
          'matched by capability; give the Agent at least one capability',
      });
    }

    workers.push(toMember(agent, worker?.alias ?? agent.name, limits.per_delegation_budgets));
  }

  // ── R29a — a Code-mode manager could never delegate ────────────────────────
  // `delegate` and `list_workers` dispatch DAEMON-SIDE, and a Code-mode program runs
  // inside the sandbox with no callback channel out of it (invariant 3). Such a Team is
  // structurally incapable of delegating while looking perfectly valid, so it is rejected
  // at save time rather than producing a Team Run that silently behaves like a solo one.
  if (managerAgent && managerAgent.mode === 'code') {
    errors.push({
      path: 'manager.agent_name',
      message:
        `manager \`${managerAgent.name}\` has \`runtime.mode: code\`; a manager must be ` +
        '`standard`, because `delegate` and `list_workers` are daemon-side tools and a ' +
        'Code-mode program executes inside the sandbox with no callback channel into the daemon',
    });
  }

  // ── R9a — per-delegation budgets sit between 1 and the platform ceiling ────
  // A Team may LOWER a worker's budget; it may never raise one past the ceiling, matching
  // the Agent Definition constraint exactly (edge 25).
  for (const key of BUDGET_KEYS) {
    const requested = limits.per_delegation_budgets[key];
    if (requested === undefined) continue;
    const ceiling = ctx.budgetCeilings[key];
    if (ceiling !== undefined && requested > ceiling) {
      errors.push({
        path: `limits.per_delegation_budgets.${key}`,
        message: `\`${key}\` of ${requested} exceeds the ceiling of ${ceiling} in config/runtime.yaml`,
      });
    }
  }

  // ── R9b — tree budgets sit inside `tree_budget_ceilings` ───────────────────
  for (const key of TREE_BUDGET_KEYS) {
    const requested = limits[key];
    const ceiling = ctx.treeBudgetCeilings[key];
    if (ceiling !== undefined && requested > ceiling) {
      errors.push({
        path: `limits.${key}`,
        message: `\`${key}\` of ${requested} exceeds the ceiling of ${ceiling} in config/runtime.yaml`,
      });
    }
  }

  // ── R9c — one delegation must not be able to exhaust the whole tree ────────
  // The tree budget is what makes a Team Run terminate (invariant 6). If a single roster
  // member's own `max_model_tokens` already exceeds it, the first delegation exhausts the
  // tree and the Team Run can never reach synthesis — a Team that is dead on arrival while
  // every individual number looks reasonable.
  const rosterForTree = managerAgent
    ? [toMember(managerAgent, managerAgent.name, limits.per_delegation_budgets), ...workers]
    : workers;
  const largest = rosterForTree.reduce<{ name: string; tokens: number } | null>((best, member) => {
    const tokens = member.budgets.max_model_tokens;
    return best === null || tokens > best.tokens ? { name: member.agent_name, tokens } : best;
  }, null);
  if (largest && limits.tree_max_model_tokens < largest.tokens) {
    errors.push({
      path: 'limits.tree_max_model_tokens',
      message:
        `\`tree_max_model_tokens\` of ${limits.tree_max_model_tokens} is lower than the ` +
        `${largest.tokens} that \`${largest.name}\` may consume in a single Run under the ` +
        'merged budget precedence, so one delegation would exhaust the tree budget',
    });
  }

  // ── R33 — concurrency the model server could never serve ───────────────────
  if (limits.max_concurrent_delegations > ctx.maxConcurrentTotal) {
    errors.push({
      path: 'limits.max_concurrent_delegations',
      message:
        `\`max_concurrent_delegations\` of ${limits.max_concurrent_delegations} exceeds ` +
        `\`scheduling.max_concurrent_total\` of ${ctx.maxConcurrentTotal} in ` +
        'config/models.yaml; the excess delegations could never make progress concurrently',
    });
  }

  if (errors.length > 0 || !managerAgent) {
    return { errors, warnings, definition: null, roster: null };
  }

  return {
    errors,
    warnings,
    definition: def,
    roster: {
      manager: toMember(managerAgent, managerAgent.name, limits.per_delegation_budgets),
      synthesis_prompt: def.manager.synthesis_prompt ?? null,
      workers,
      limits,
    },
  };
}

/**
 * Build the validator's view of one Agent from its stored version.
 *
 * Reads the DEFINITION for `capabilities` and the SNAPSHOT for budgets and mode, because
 * that is where each is authoritative — capabilities resolve to nothing so they stay on
 * the definition, while budgets and the sandbox profile are resolved values pinned into
 * the snapshot.
 */
export function summariseAgent(input: {
  agent_id: string;
  name: string;
  deleted: boolean;
  agent_version_id: string;
  definition: AgentDefinition;
  resolved_snapshot: ResolvedSnapshot;
}): AgentSummary {
  return {
    agent_id: input.agent_id,
    name: input.name,
    agent_version_id: input.agent_version_id,
    deleted: input.deleted,
    display_name: input.definition.display_name ?? null,
    description: input.definition.description ?? null,
    capabilities: input.definition.capabilities ?? [],
    mode: input.resolved_snapshot.mode,
    workspace_required: input.resolved_snapshot.sandbox.workspace_required,
    budgets: input.resolved_snapshot.budgets,
  };
}
