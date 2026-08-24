/**
 * resolved_snapshot construction — Agent Definition R24.
 *
 * INVARIANT 2 MADE CONCRETE. A Run executes against this snapshot and NEVER re-resolves
 * any reference in it. Promoting a new Adapter, editing a Corpus, or changing a config
 * default does not alter a Run in flight or a Run started later against a pinned version —
 * adopting a change is a deliberate `refresh-bindings` call (R25a).
 *
 * The snapshot therefore has to be COMPLETE. Anything the runtime would otherwise look up
 * belongs here: if the loop had to consult config for a budget or a profile value, that
 * lookup would be a live reference and the pin would be a fiction.
 */

import type { AgentDefinition, BudgetKey } from './definition-schema.js';
import { BUDGET_KEYS, BUILTIN_TOOLS } from './definition-schema.js';
import type { ModelBinding, ValidationContext } from './validator.js';

export interface ResolvedSnapshot {
  binding_tag: string;
  backend: string;
  context_window: number;
  tool_format: 'json_schema' | 'hermes';
  adapter_id: string | null;
  corpus_id: string | null;
  auto_inject_k: number;
  mode: 'standard' | 'code';
  /** Fully qualified, AFTER applying `denied`. What the loop presents to the model. */
  tools: string[];
  budgets: Record<BudgetKey, number>;
  sandbox: { profile: string; workspace_required: boolean } & Record<string, unknown>;
  warnings: string[];
}

/**
 * Build the granted tool list — R6, R7, and the data-flow step 6 ordering.
 *
 * The order matters: take the union of built-ins, MCP tools, and implicit tools, THEN
 * apply `denied`, THEN re-add `finish`. Applying denied last would let it remove finish;
 * re-adding finish afterwards is what makes it non-deniable in fact and not merely by
 * validation (edge 8).
 *
 * `search_knowledge` is implicit and conditional (R40, R43): granted only to a
 * STANDARD-mode Agent with a bound Corpus. A Code-mode Agent does not get it — a program
 * inside the sandbox has no callback channel to reach the daemon (R27a, invariant 3).
 */
export function resolveTools(
  def: AgentDefinition,
  hasCorpus: boolean,
  mode: 'standard' | 'code',
): string[] {
  const granted = new Set<string>(def.tools?.builtin ?? []);

  for (const server of def.tools?.mcp ?? []) {
    // R51 — MCP tools are namespaced. The concrete tool names are only known at Run start
    // when the server is queried, so the snapshot pins the SERVER grant; the loop expands
    // it. Recording the prefix keeps the snapshot honest about what was granted without
    // inventing tool names that may not exist.
    granted.add(`${server}__*`);
  }

  if (hasCorpus && mode === 'standard') granted.add('search_knowledge');

  for (const denied of def.tools?.denied ?? []) granted.delete(denied);

  // R7 — always, regardless of what `denied` said. Validation already rejects denying it,
  // so this is belt-and-braces for a definition that reached here another way.
  granted.add('finish');

  return [...granted].sort();
}

/** Merge an Agent's budget overrides over config defaults — data-flow step 7. */
export function resolveBudgets(
  def: AgentDefinition,
  defaults: Record<BudgetKey, number>,
): Record<BudgetKey, number> {
  const budgets = {} as Record<BudgetKey, number>;
  for (const key of BUDGET_KEYS) {
    budgets[key] = def.runtime?.budgets?.[key] ?? defaults[key];
  }
  return budgets;
}

export function buildSnapshot(
  def: AgentDefinition,
  binding: ModelBinding,
  corpusId: string | null,
  warnings: string[],
  ctx: ValidationContext,
): ResolvedSnapshot {
  const mode = def.runtime?.mode ?? 'standard';
  const profileName = def.sandbox.profile;
  const profileValues = ctx.sandboxProfiles[profileName] ?? {};

  return {
    binding_tag: binding.tag,
    // Pinned so the runtime resolves the endpoint through config/models.yaml by LOGICAL
    // name, never a URL (Training R1b).
    backend: binding.backend,
    context_window: binding.context_window,
    tool_format: binding.tool_format,
    adapter_id: binding.adapter_id,
    // R16a — pinned alongside the name. Because a Corpus name is immutable, the pinned id
    // and the referenced name cannot diverge.
    corpus_id: corpusId,
    auto_inject_k: def.corpus?.auto_inject_k ?? ctx.autoInjectK,
    mode,
    tools: resolveTools(def, corpusId !== null, mode),
    budgets: resolveBudgets(def, ctx.budgetDefaults),
    // The EFFECTIVE profile values, not just its name. A Run that had to re-read
    // config/sandbox-profiles.yaml would be following a live reference, which is exactly
    // what invariant 2 forbids.
    sandbox: {
      ...profileValues,
      profile: profileName,
      workspace_required: def.sandbox.workspace_required !== false,
    },
    warnings,
  };
}

/**
 * Compare two snapshots for `refresh-bindings` (R25a, R25b).
 *
 * Returns the names of fields that differ. An empty list means nothing changed, which is
 * what makes repeated calls idempotent rather than version-inflating (edge 19).
 */
export function diffSnapshots(previous: ResolvedSnapshot, next: ResolvedSnapshot): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ResolvedSnapshot>;

  for (const key of keys) {
    // `warnings` is commentary about the resolution, not part of it. A Corpus that gained
    // chunks since the last save drops the zero-chunk warning, and cutting a new immutable
    // version over that would inflate the history with no behavioural change.
    if (key === 'warnings') continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(key);
  }

  return changed.sort();
}

/** The built-in tool names, re-exported so callers need not reach into the schema module. */
export { BUILTIN_TOOLS };
