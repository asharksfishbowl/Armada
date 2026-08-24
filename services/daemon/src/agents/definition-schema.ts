/**
 * The Agent definition schema — Agent Definition R1-R11.
 *
 * THE SCHEMA IS CLOSED, NOT PERMISSIVE (R11). Any key not listed, at ANY nesting depth,
 * fails validation naming the offending key PATH.
 *
 * That strictness is deliberate. A permissive schema silently ignores a typo — an operator
 * writes `runtime.budget` instead of `runtime.budgets`, the Agent saves cleanly, and the
 * budget they thought they set is simply absent until a Run overruns it. Naming the path
 * turns a silent misconfiguration into a save-time error.
 *
 * VALIDATION ACCUMULATES (R12). Every error is returned, never just the first, because an
 * operator fixing a definition in the dashboard editor should see the whole list in one
 * round-trip rather than discovering errors one save at a time.
 *
 * This module owns STRUCTURE only. Reference resolution — does this Corpus exist, is this
 * binding promoted — lives in validator.ts, because those need forge and config and this
 * does not.
 */

export const SCHEMA_VERSION = 1;

/** R1 — the complete set of top-level keys. */
const TOP_LEVEL_KEYS = [
  'schema_version',
  'name',
  'display_name',
  'description',
  'persona',
  'model',
  'corpus',
  'tools',
  'sandbox',
  'runtime',
  'capabilities',
] as const;

/** R6 — the only built-in tools an Agent may name. */
export const BUILTIN_TOOLS = ['shell', 'read_file', 'write_file', 'list_dir', 'finish'] as const;

/** R6 — the workspace-touching subset, used by R21's workspace_required check. */
const WORKSPACE_TOOLS = ['shell', 'read_file', 'write_file', 'list_dir'] as const;

/** R9 — the four per-Run budget keys. */
export const BUDGET_KEYS = [
  'max_steps',
  'max_model_tokens',
  'max_wall_clock_seconds',
  'max_tool_calls',
] as const;

export type BudgetKey = (typeof BUDGET_KEYS)[number];

const NAME_PATTERN = /^[a-z0-9-]+$/;

export interface AgentDefinition {
  schema_version: number;
  name: string;
  display_name?: string;
  description?: string;
  persona: { system_prompt: string };
  model: { base_model_id: string; adapter?: string };
  corpus?: { name: string | null; auto_inject_k?: number } | null;
  tools?: { builtin?: string[]; mcp?: string[]; denied?: string[] };
  sandbox: { profile: string; workspace_required?: boolean };
  runtime?: { mode?: 'standard' | 'code'; budgets?: Partial<Record<BudgetKey, number>> };
  capabilities?: string[];
}

export interface ValidationError {
  /** Dotted key path, e.g. `tools.denied[0]`. Empty for whole-document faults. */
  path: string;
  message: string;
}

/** Reject any key outside `allowed`, naming its full path (R11). */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({
        path: prefix ? `${prefix}.${key}` : key,
        message: `unknown key \`${prefix ? `${prefix}.${key}` : key}\`; allowed: ${allowed.join(', ')}`,
      });
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireStringArray(
  value: unknown,
  path: string,
  errors: ValidationError[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push({ path, message: `\`${path}\` must be a list of strings` });
    return [];
  }
  return value as string[];
}

/**
 * Validate structure. Returns every error found.
 *
 * Does NOT resolve references — that is validator.ts, which needs forge and config.
 */
export function validateStructure(raw: unknown): {
  errors: ValidationError[];
  definition: AgentDefinition | null;
} {
  const errors: ValidationError[] = [];

  if (!isObject(raw)) {
    return { errors: [{ path: '', message: 'an Agent definition must be a mapping' }], definition: null };
  }

  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, '', errors);

  // R1 / edges 1 and 2 — the version gate runs FIRST and is checked explicitly rather than
  // defaulted. A definition omitting schema_version must fail naming the missing key, not
  // be assumed to be version 1; and a future version must fail naming the supported one,
  // so a newer format cannot be silently misread as this one.
  if (raw['schema_version'] === undefined) {
    errors.push({ path: 'schema_version', message: 'missing required key `schema_version`' });
  } else if (raw['schema_version'] !== SCHEMA_VERSION) {
    errors.push({
      path: 'schema_version',
      message: `schema_version ${String(raw['schema_version'])} is not supported; this Armada supports ${SCHEMA_VERSION}`,
    });
  }

  // R2 — `name` is the identity an Agent is upserted by, so it is constrained like every
  // other platform name (invariant 4).
  const name = raw['name'];
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    errors.push({ path: 'name', message: '`name` must be a string matching ^[a-z0-9-]+$' });
  }

  for (const key of ['display_name', 'description'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      errors.push({ path: key, message: `\`${key}\` must be a string` });
    }
  }

  // R3 — persona has EXACTLY one key.
  const persona = raw['persona'];
  if (!isObject(persona)) {
    errors.push({ path: 'persona', message: '`persona` is required and must be a mapping' });
  } else {
    rejectUnknownKeys(persona, ['system_prompt'], 'persona', errors);
    if (typeof persona['system_prompt'] !== 'string' || !persona['system_prompt'].trim()) {
      errors.push({
        path: 'persona.system_prompt',
        message: '`persona.system_prompt` is required and must be a non-empty string',
      });
    }
  }

  // R4 — exactly two keys. There is deliberately NO way to name a ModelBinding tag
  // directly: a tag is always derived by resolution, so every Agent's model provenance
  // traces back to a BaseModel entry and an Adapter row.
  const model = raw['model'];
  if (!isObject(model)) {
    errors.push({ path: 'model', message: '`model` is required and must be a mapping' });
  } else {
    rejectUnknownKeys(model, ['base_model_id', 'adapter'], 'model', errors);
    if (typeof model['base_model_id'] !== 'string' || !model['base_model_id']) {
      errors.push({ path: 'model.base_model_id', message: '`model.base_model_id` is required' });
    }
    const adapter = model['adapter'];
    if (adapter !== undefined && typeof adapter !== 'string') {
      errors.push({
        path: 'model.adapter',
        message: '`model.adapter` must be `latest_promoted`, `none`, or an adapter_id',
      });
    }
  }

  // R5 — Corpora are referenced by NAME, never by corpus_id (invariant 4), so a definition
  // authored on one installation stays valid on another that has a Corpus of that name.
  const corpus = raw['corpus'];
  if (corpus !== undefined && corpus !== null) {
    if (!isObject(corpus)) {
      errors.push({ path: 'corpus', message: '`corpus` must be a mapping or null' });
    } else {
      rejectUnknownKeys(corpus, ['name', 'auto_inject_k'], 'corpus', errors);
      const corpusName = corpus['name'];
      if (corpusName !== null && (typeof corpusName !== 'string' || !NAME_PATTERN.test(corpusName))) {
        errors.push({ path: 'corpus.name', message: '`corpus.name` must match ^[a-z0-9-]+$ or be null' });
      }
      const k = corpus['auto_inject_k'];
      if (k !== undefined && (typeof k !== 'number' || !Number.isInteger(k) || k < 1)) {
        errors.push({ path: 'corpus.auto_inject_k', message: '`corpus.auto_inject_k` must be a positive integer' });
      }
    }
  }

  // R6, R7 — tools.
  const tools = raw['tools'];
  if (tools !== undefined) {
    if (!isObject(tools)) {
      errors.push({ path: 'tools', message: '`tools` must be a mapping' });
    } else {
      rejectUnknownKeys(tools, ['builtin', 'mcp', 'denied'], 'tools', errors);
      const builtin = requireStringArray(tools['builtin'], 'tools.builtin', errors);
      for (const [index, tool] of builtin.entries()) {
        if (!BUILTIN_TOOLS.includes(tool as (typeof BUILTIN_TOOLS)[number])) {
          errors.push({
            path: `tools.builtin[${index}]`,
            message: `\`${tool}\` is not a built-in tool; allowed: ${BUILTIN_TOOLS.join(', ')}`,
          });
        }
      }
      requireStringArray(tools['mcp'], 'tools.mcp', errors);

      // R7 / edge 8 — `finish` is granted to EVERY Agent and may not be denied. Without it
      // a Run could never self-report success, and invariant 1 makes `success` reachable
      // only through finish — so denying it would make the Agent structurally incapable of
      // succeeding while looking perfectly valid.
      const denied = requireStringArray(tools['denied'], 'tools.denied', errors);
      const finishIndex = denied.indexOf('finish');
      if (finishIndex >= 0) {
        errors.push({
          path: `tools.denied[${finishIndex}]`,
          message:
            '`finish` is non-deniable: it is granted to every Agent, and it is the only way ' +
            'a Run can report success',
        });
      }
    }
  }

  // R8.
  const sandbox = raw['sandbox'];
  if (!isObject(sandbox)) {
    errors.push({ path: 'sandbox', message: '`sandbox` is required and must be a mapping' });
  } else {
    rejectUnknownKeys(sandbox, ['profile', 'workspace_required'], 'sandbox', errors);
    if (typeof sandbox['profile'] !== 'string' || !sandbox['profile']) {
      errors.push({ path: 'sandbox.profile', message: '`sandbox.profile` is required' });
    }
    if (sandbox['workspace_required'] !== undefined && typeof sandbox['workspace_required'] !== 'boolean') {
      errors.push({ path: 'sandbox.workspace_required', message: '`sandbox.workspace_required` must be a boolean' });
    }
  }

  // R9.
  const runtime = raw['runtime'];
  if (runtime !== undefined) {
    if (!isObject(runtime)) {
      errors.push({ path: 'runtime', message: '`runtime` must be a mapping' });
    } else {
      rejectUnknownKeys(runtime, ['mode', 'budgets'], 'runtime', errors);
      const mode = runtime['mode'];
      if (mode !== undefined && mode !== 'standard' && mode !== 'code') {
        errors.push({ path: 'runtime.mode', message: '`runtime.mode` must be `standard` or `code`' });
      }
      const budgets = runtime['budgets'];
      if (budgets !== undefined) {
        if (!isObject(budgets)) {
          errors.push({ path: 'runtime.budgets', message: '`runtime.budgets` must be a mapping' });
        } else {
          rejectUnknownKeys(budgets, BUDGET_KEYS, 'runtime.budgets', errors);
          for (const key of BUDGET_KEYS) {
            const value = budgets[key];
            if (value === undefined) continue;
            // R20's ceiling check needs config, so it lives in validator.ts. The floor is
            // structural: a budget below 1 cannot admit even one Step.
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
              errors.push({
                path: `runtime.budgets.${key}`,
                message: `\`runtime.budgets.${key}\` must be an integer of at least 1`,
              });
            }
          }
        }
      }
    }
  }

  // R10 / edge 15 — free-form strings used only by Team Orchestration worker matching.
  // Omitted defaults to empty, which simply means the Agent is never matched as a worker.
  if (raw['capabilities'] !== undefined) {
    requireStringArray(raw['capabilities'], 'capabilities', errors);
  }

  // R21 — a workspace the Agent cannot touch is a misconfiguration, not a preference.
  if (isObject(sandbox) && isObject(tools)) {
    const workspaceRequired = sandbox['workspace_required'] !== false;
    const builtin = Array.isArray(tools['builtin']) ? (tools['builtin'] as string[]) : [];
    const grantsWorkspaceTool = builtin.some((tool) =>
      WORKSPACE_TOOLS.includes(tool as (typeof WORKSPACE_TOOLS)[number]),
    );
    if (workspaceRequired && !grantsWorkspaceTool) {
      errors.push({
        path: 'tools.builtin',
        message:
          '`sandbox.workspace_required` is true but no workspace tool is granted; ' +
          `grant at least one of ${WORKSPACE_TOOLS.join(', ')} or set workspace_required: false`,
      });
    }
  }

  return {
    errors,
    definition: errors.length === 0 ? (raw as unknown as AgentDefinition) : null,
  };
}
