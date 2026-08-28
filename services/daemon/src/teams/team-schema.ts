/**
 * The Team definition schema — Team Orchestration R1-R5.
 *
 * THE SCHEMA IS CLOSED, NOT PERMISSIVE (R5), for the same reason the Agent schema is: a
 * permissive schema silently ignores a typo. An operator writing `limits.max_delegation`
 * instead of `limits.max_delegations` would save cleanly and then discover at Run time
 * that the limit they set was never there.
 *
 * VALIDATION ACCUMULATES. Every structural error is returned at once, matching R39's
 * "including full-error-list responses".
 *
 * This module owns STRUCTURE only. Roster resolution — does this Agent exist, is its
 * capabilities list empty, does this budget exceed its ceiling — lives in validator.ts,
 * because those need the Agent registry and config and this does not.
 */

import type { ValidationError } from '../agents/definition-schema.js';
import { BUDGET_KEYS, type BudgetKey } from '../agents/definition-schema.js';

export const TEAM_SCHEMA_VERSION = 1;

/** R1 — the complete set of top-level keys. */
const TOP_LEVEL_KEYS = [
  'schema_version',
  'name',
  'display_name',
  'description',
  'manager',
  'workers',
  'limits',
] as const;

/** R32 — the two cross-Run budgets, accounted across a Team Run and every child. */
export const TREE_BUDGET_KEYS = ['tree_max_wall_clock_seconds', 'tree_max_model_tokens'] as const;
export type TreeBudgetKey = (typeof TREE_BUDGET_KEYS)[number];

const LIMIT_KEYS = [
  'max_delegations',
  'max_concurrent_delegations',
  ...TREE_BUDGET_KEYS,
  'per_delegation_budgets',
] as const;

const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface TeamManagerSpec {
  agent_name: string;
  /** R2 — appended to the manager's persona for the final synthesis Step (R35). */
  synthesis_prompt?: string;
}

export interface TeamWorkerSpec {
  agent_name: string;
  /** R3 — defaults to `agent_name`, unique within the Team. */
  alias?: string;
}

export interface TeamLimits {
  max_delegations: number;
  max_concurrent_delegations: number;
  tree_max_wall_clock_seconds: number;
  tree_max_model_tokens: number;
  /** R4 — overrides each worker's own budgets FOR THIS TEAM ONLY. */
  per_delegation_budgets: Partial<Record<BudgetKey, number>>;
}

export interface TeamDefinition {
  schema_version: number;
  name: string;
  display_name?: string;
  description?: string;
  manager: TeamManagerSpec;
  workers: TeamWorkerSpec[];
  limits?: Partial<TeamLimits>;
}

/** R4 — the shipped defaults, applied when `limits` omits a key. */
export const TEAM_LIMIT_DEFAULTS: TeamLimits = {
  max_delegations: 12,
  max_concurrent_delegations: 2,
  tree_max_wall_clock_seconds: 3600,
  tree_max_model_tokens: 600_000,
  per_delegation_budgets: {},
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reject any key outside `allowed`, naming its full path (R5). */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    errors.push({ path, message: `unknown key \`${path}\`; allowed: ${allowed.join(', ')}` });
  }
}

function positiveInteger(
  value: unknown,
  path: string,
  errors: ValidationError[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push({ path, message: `\`${path}\` must be an integer of at least 1` });
    return undefined;
  }
  return value;
}

/**
 * Validate structure. Returns every error found.
 *
 * Does NOT resolve the roster — that is validator.ts, which needs the Agent registry.
 */
export function validateTeamStructure(raw: unknown): {
  errors: ValidationError[];
  definition: TeamDefinition | null;
} {
  const errors: ValidationError[] = [];

  if (!isObject(raw)) {
    return {
      errors: [{ path: '', message: 'a Team definition must be a mapping' }],
      definition: null,
    };
  }

  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, '', errors);

  // R1 — the version gate runs first and is checked explicitly rather than defaulted, so a
  // future format cannot be silently misread as this one.
  if (raw['schema_version'] === undefined) {
    errors.push({ path: 'schema_version', message: 'missing required key `schema_version`' });
  } else if (raw['schema_version'] !== TEAM_SCHEMA_VERSION) {
    errors.push({
      path: 'schema_version',
      message:
        `schema_version ${String(raw['schema_version'])} is not supported; ` +
        `this Armada supports ${TEAM_SCHEMA_VERSION}`,
    });
  }

  // R1 — invariant 4: a Team is referenced by an immutable name, never a generated uuid.
  if (typeof raw['name'] !== 'string' || !NAME_PATTERN.test(raw['name'])) {
    errors.push({ path: 'name', message: '`name` must be a string matching ^[a-z0-9-]+$' });
  }

  for (const key of ['display_name', 'description'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      errors.push({ path: key, message: `\`${key}\` must be a string` });
    }
  }

  // R2.
  const manager = raw['manager'];
  if (!isObject(manager)) {
    errors.push({ path: 'manager', message: '`manager` is required and must be a mapping' });
  } else {
    rejectUnknownKeys(manager, ['agent_name', 'synthesis_prompt'], 'manager', errors);
    if (typeof manager['agent_name'] !== 'string' || !manager['agent_name']) {
      errors.push({ path: 'manager.agent_name', message: '`manager.agent_name` is required' });
    }
    if (manager['synthesis_prompt'] !== undefined && typeof manager['synthesis_prompt'] !== 'string') {
      errors.push({
        path: 'manager.synthesis_prompt',
        message: '`manager.synthesis_prompt` must be a string',
      });
    }
  }

  // R3 — at least one worker. A Team with none is an Agent with extra machinery, and
  // `delegate` would have nothing to resolve against.
  const workers = raw['workers'];
  if (!Array.isArray(workers) || workers.length === 0) {
    errors.push({ path: 'workers', message: '`workers` is required and must list at least one worker' });
  } else {
    for (const [index, worker] of workers.entries()) {
      const path = `workers[${index}]`;
      if (!isObject(worker)) {
        errors.push({ path, message: `\`${path}\` must be a mapping` });
        continue;
      }
      rejectUnknownKeys(worker, ['agent_name', 'alias'], path, errors);
      if (typeof worker['agent_name'] !== 'string' || !worker['agent_name']) {
        errors.push({ path: `${path}.agent_name`, message: `\`${path}.agent_name\` is required` });
      }
      if (worker['alias'] !== undefined && (typeof worker['alias'] !== 'string' || !worker['alias'])) {
        errors.push({ path: `${path}.alias`, message: `\`${path}.alias\` must be a non-empty string` });
      }
    }
  }

  // R4.
  const limits = raw['limits'];
  if (limits !== undefined) {
    if (!isObject(limits)) {
      errors.push({ path: 'limits', message: '`limits` must be a mapping' });
    } else {
      rejectUnknownKeys(limits, LIMIT_KEYS, 'limits', errors);
      positiveInteger(limits['max_delegations'], 'limits.max_delegations', errors);
      positiveInteger(limits['max_concurrent_delegations'], 'limits.max_concurrent_delegations', errors);
      for (const key of TREE_BUDGET_KEYS) {
        // R9b's floor. Its ceiling needs config/runtime.yaml and lives in validator.ts.
        positiveInteger(limits[key], `limits.${key}`, errors);
      }

      const perDelegation = limits['per_delegation_budgets'];
      if (perDelegation !== undefined) {
        if (!isObject(perDelegation)) {
          errors.push({
            path: 'limits.per_delegation_budgets',
            message: '`limits.per_delegation_budgets` must be a mapping',
          });
        } else {
          // R4 — "any subset of the Agent Runtime budget keys". Anything else is a typo,
          // and a typo here silently fails to override the budget the operator meant.
          rejectUnknownKeys(perDelegation, BUDGET_KEYS, 'limits.per_delegation_budgets', errors);
          for (const key of BUDGET_KEYS) {
            // R9a's floor; its ceiling is validator.ts's.
            positiveInteger(perDelegation[key], `limits.per_delegation_budgets.${key}`, errors);
          }
        }
      }
    }
  }

  return {
    errors,
    definition: errors.length === 0 ? (raw as unknown as TeamDefinition) : null,
  };
}

/** R4 — the effective limits: the definition's values over the shipped defaults. */
export function resolveLimits(def: Pick<TeamDefinition, 'limits'>): TeamLimits {
  return {
    ...TEAM_LIMIT_DEFAULTS,
    ...(def.limits ?? {}),
    per_delegation_budgets: { ...(def.limits?.per_delegation_budgets ?? {}) },
  };
}

/**
 * R22 — the merged budgets one delegation runs under.
 *
 * PRECEDENCE, HIGHEST FIRST: `limits.per_delegation_budgets`, then the worker Agent's own
 * `runtime.budgets`, then `config/runtime.yaml` defaults. The worker's pinned
 * `resolved_snapshot.budgets` already carries the lower two merged, which is why only one
 * layer is applied here — re-deriving the worker's own would be a live reference into
 * current config and invariant 2 forbids it.
 */
export function mergeDelegationBudgets(
  workerBudgets: Record<BudgetKey, number>,
  perDelegation: Partial<Record<BudgetKey, number>>,
): Record<BudgetKey, number> {
  const merged = { ...workerBudgets };
  for (const key of BUDGET_KEYS) {
    const override = perDelegation[key];
    if (override !== undefined) merged[key] = override;
  }
  return merged;
}
