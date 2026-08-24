/**
 * Reference resolution — Agent Definition R12-R21.
 *
 * Structure is already checked by definition-schema.ts. This module answers the questions
 * that need the outside world: does this BaseModel have a binding, does this Corpus exist,
 * is this sandbox profile defined, are these MCP servers configured.
 *
 * EVERY ERROR IS RETURNED, NOT THE FIRST (R12). Both passes accumulate into one list, so
 * an operator sees structural and reference faults together rather than fixing structure,
 * saving, and discovering a bad Corpus name on the second round-trip.
 *
 * FAILING AT SAVE TIME IS THE POINT. R8's goal is that a binding which cannot resolve is
 * rejected here, in the editor, rather than mid-Run — where the same fault costs a
 * sandbox, a model call, and a confusing terminal outcome.
 */

import type { ValidationError } from './definition-schema.js';
import { BUDGET_KEYS, validateStructure, type AgentDefinition, type BudgetKey } from './definition-schema.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** What forge's GET /models/bindings returns (Training R32). */
export interface ModelBinding {
  tag: string;
  backend: string;
  base_model_id: string;
  corpus_name: string;
  adapter_id: string | null;
  version: number | null;
  context_window: number;
  tool_format: 'json_schema' | 'hermes';
  materialized: boolean;
  materialization_status: string;
  status: 'promoted' | 'retired' | 'missing';
}

/** What forge's GET /corpora returns (Training R5a). */
export interface CorpusSummary {
  corpus_id: string;
  name: string;
  chunk_count: number;
}

export interface ValidationContext {
  bindings: ModelBinding[];
  corpora: CorpusSummary[];
  sandboxProfiles: Record<string, Record<string, unknown>>;
  mcpServers: string[];
  budgetCeilings: Record<BudgetKey, number>;
  budgetDefaults: Record<BudgetKey, number>;
  codeModeMinContext: number;
  reservedOutputTokens: number;
  autoInjectK: number;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: string[];
  definition: AgentDefinition | null;
  /** Resolution outputs the resolver needs. Present only when there are no errors. */
  resolved: {
    binding: ModelBinding;
    corpusId: string | null;
  } | null;
}

/** Rough token estimate, matching the forge chunker's ratio. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

export function validate(raw: unknown, ctx: ValidationContext): ValidationResult {
  const structural = validateStructure(raw);
  const errors = [...structural.errors];
  const warnings: string[] = [];

  // R12 — reference resolution runs EVEN WHEN STRUCTURAL ERRORS EXIST, so an operator sees
  // both kinds at once. Returning early here would mean a bad `name` hid a nonexistent
  // Corpus until the next save, turning one round-trip into several — and the EXIT
  // condition ("a definition with three errors returns all three in one response") is
  // specifically about errors that span both passes.
  //
  // Every reference check below guards its own field, so a malformed value is skipped
  // rather than crashing the pass that already reported it.
  if (!isObject(raw)) {
    return { errors, warnings, definition: null, resolved: null };
  }

  const def = raw as unknown as AgentDefinition;
  let binding: ModelBinding | null = null;
  let corpusId: string | null = null;

  // ── R13, R14, R14a, R15 — the model reference ──────────────────────────────
  // Skipped when base_model_id is not a usable string; the structural pass already
  // reported that, and re-reporting it as "no binding exists for undefined" would be noise.
  const baseModelId = typeof def.model?.base_model_id === 'string' ? def.model.base_model_id : null;
  const forBase = baseModelId ? ctx.bindings.filter((b) => b.base_model_id === baseModelId) : [];

  if (baseModelId === null) {
    // Already reported by the structural pass. Skip this block only — the Corpus, sandbox,
    // and MCP checks below are independent and still have something useful to say.
  } else if (forBase.length === 0) {
    errors.push({
      path: 'model.base_model_id',
      message:
        `no ModelBinding exists for base_model_id \`${baseModelId}\`; ` +
        `known: ${[...new Set(ctx.bindings.map((b) => b.base_model_id))].join(', ') || '(none)'}`,
    });
  } else {
    const adapter = def.model.adapter ?? 'latest_promoted';

    if (adapter === 'none') {
      // R14a — resolve the base binding forge registers for every shortlist entry.
      const base = forBase.find((b) => b.adapter_id === null);
      if (!base) {
        errors.push({
          path: 'model.adapter',
          message: `no base ModelBinding \`armada/${baseModelId}-base\` exists`,
        });
      } else if (base.status === 'retired') {
        // Edge 24 — the entry was removed from the shortlist.
        errors.push({
          path: 'model.base_model_id',
          message: `the base binding for \`${baseModelId}\` is retired; it was removed from config/base-models.yaml`,
        });
      } else {
        binding = base;
      }
    } else if (adapter === 'latest_promoted') {
      // R14 — highest version promoted Adapter, PREFERRING one whose corpus_name matches
      // the bound Corpus. `latest_promoted` describes resolution at SAVE TIME, not a live
      // subscription (edge 5) — which is what invariant 2 means in practice.
      const promoted = forBase.filter((b) => b.adapter_id !== null && b.status === 'promoted');
      const boundCorpus = def.corpus?.name ?? null;
      const preferred = boundCorpus
        ? promoted.filter((b) => b.corpus_name === boundCorpus)
        : [];
      const pool = preferred.length > 0 ? preferred : promoted;

      if (pool.length === 0) {
        errors.push({
          path: 'model.adapter',
          message:
            `no promoted Adapter exists for \`${baseModelId}\`; ` +
            'use `adapter: none` to bind the base model',
        });
      } else {
        binding = pool.reduce((best, b) => ((b.version ?? 0) > (best.version ?? 0) ? b : best));
      }
    } else {
      // R15 — an explicit adapter_id.
      const explicit = ctx.bindings.find((b) => b.adapter_id === adapter);
      if (!explicit) {
        errors.push({ path: 'model.adapter', message: `no Adapter with id \`${adapter}\`` });
      } else if (explicit.status !== 'promoted') {
        errors.push({
          path: 'model.adapter',
          message: `Adapter \`${adapter}\` has status \`${explicit.status}\`; only promoted Adapters may be bound`,
        });
      } else if (explicit.base_model_id !== baseModelId) {
        errors.push({
          path: 'model.adapter',
          message:
            `Adapter \`${adapter}\` belongs to base model \`${explicit.base_model_id}\`, ` +
            `not \`${baseModelId}\``,
        });
      } else {
        binding = explicit;
      }
    }
  }

  // ── R16, R16a — the Corpus reference ───────────────────────────────────────
  const corpusName = typeof def.corpus?.name === 'string' ? def.corpus.name : null;
  if (corpusName) {
    const found = ctx.corpora.find((c) => c.name === corpusName);
    if (!found) {
      errors.push({
        path: 'corpus.name',
        message:
          `no Corpus named \`${corpusName}\`; ` +
          `available: ${ctx.corpora.map((c) => c.name).join(', ') || '(none)'}`,
      });
    } else {
      corpusId = found.corpus_id;
      if (found.chunk_count === 0) {
        // R16/R37 — a WARNING, not an error. Both shipped examples hit this on a fresh
        // install against seeded Corpora, and they must be runnable immediately with
        // retrieval simply returning nothing.
        warnings.push(
          `corpus \`${corpusName}\` has zero chunks; retrieval will return nothing until Sources are ingested`,
        );
      }
    }
  }

  // ── R17 — sandbox profile ──────────────────────────────────────────────────
  const profile = typeof def.sandbox?.profile === 'string' ? def.sandbox.profile : null;
  if (profile && !(profile in ctx.sandboxProfiles)) {
    errors.push({
      path: 'sandbox.profile',
      message:
        `no sandbox profile \`${profile}\`; ` +
        `available: ${Object.keys(ctx.sandboxProfiles).join(', ') || '(none)'}`,
    });
  }

  // ── R18 — MCP servers ──────────────────────────────────────────────────────
  const mcpNames = Array.isArray(def.tools?.mcp) ? def.tools.mcp : [];
  for (const [index, server] of mcpNames.entries()) {
    if (!ctx.mcpServers.includes(server)) {
      errors.push({
        path: `tools.mcp[${index}]`,
        message:
          `no MCP server \`${server}\` in config/mcp-servers.yaml; ` +
          `available: ${ctx.mcpServers.join(', ') || '(none)'}`,
      });
    }
  }

  // R16b / edge 23 — Code mode plus MCP is a WARNING, not an error, so an Agent can be
  // switched between modes without editing its tool grants.
  if (def.runtime?.mode === 'code' && mcpNames.length > 0) {
    warnings.push(
      `runtime.mode is \`code\`, so MCP tools from ${mcpNames.join(', ')} ` +
        'will be unavailable inside the generated program',
    );
  }

  // ── R19 — Code mode against a small context window ─────────────────────────
  if (def.runtime?.mode === 'code' && binding && binding.context_window < ctx.codeModeMinContext) {
    errors.push({
      path: 'runtime.mode',
      message:
        `runtime.mode \`code\` requires a context_window of at least ` +
        `${ctx.codeModeMinContext} (code_mode_min_context); \`${binding.tag}\` has ${binding.context_window}`,
    });
  }

  // ── R20 — budget ceilings ──────────────────────────────────────────────────
  for (const key of BUDGET_KEYS) {
    const requested = def.runtime?.budgets?.[key];
    if (requested === undefined) continue;
    const ceiling = ctx.budgetCeilings[key];
    if (ceiling !== undefined && requested > ceiling) {
      errors.push({
        path: `runtime.budgets.${key}`,
        message: `\`${key}\` of ${requested} exceeds the ceiling of ${ceiling} in config/runtime.yaml`,
      });
    }
  }

  // ── Edge 13 — a persona that cannot fit its own context window ─────────────
  if (binding && typeof def.persona?.system_prompt === 'string') {
    const personaTokens = estimateTokens(def.persona.system_prompt);
    const available = binding.context_window - ctx.reservedOutputTokens;
    if (personaTokens > available) {
      errors.push({
        path: 'persona.system_prompt',
        message:
          `persona.system_prompt is roughly ${personaTokens} tokens, which exceeds the ` +
          `${available} available (context_window ${binding.context_window} minus ` +
          `reserved_output_tokens ${ctx.reservedOutputTokens})`,
      });
    }
  }

  return {
    errors,
    warnings,
    definition: errors.length === 0 ? def : null,
    resolved: errors.length === 0 && binding ? { binding, corpusId } : null,
  };
}
