/**
 * POST /api/agents/{agent_id}/refresh-bindings — Agent Definition R25a, R25b; edges 19-21.
 *
 * ARMADA NEVER REFRESHES BINDINGS AUTOMATICALLY. Promoting a new Adapter changes no
 * existing Agent's behaviour; adopting it is this explicit, auditable call. That is
 * invariant 2 in operational form — `latest_promoted` describes resolution at SAVE TIME,
 * not a live subscription (edge 5).
 *
 * A VERSION IS CREATED ONLY WHEN SOMETHING ACTUALLY DIFFERS (R25a). Repeated calls are
 * therefore idempotent and do not inflate version numbers (edge 19) — which matters
 * because the obvious operator habit is to run this after every promotion, on every Agent.
 */

import type { AgentDefinition } from './definition-schema.js';
import { diffSnapshots, buildSnapshot } from './resolver.js';
import type { AgentStore } from './store.js';
import { validate, type ValidationContext } from './validator.js';
import type { ValidationError } from './definition-schema.js';

export interface RefreshResult {
  changed: boolean;
  version: number;
  /** R25b — every field that differed, so adoption is auditable rather than silent. */
  changed_fields: string[];
  warnings: string[];
}

export interface RefreshFailure {
  errors: ValidationError[];
}

export async function refreshBindings(
  store: AgentStore,
  agentId: string,
  ctx: ValidationContext,
): Promise<RefreshResult | RefreshFailure | null> {
  const agent = await store.getById(agentId);
  if (!agent || agent.deleted_at) return null;

  const current = await store.getVersion(agentId);
  if (!current) return null;

  // Re-resolve the SAME definition against the world as it is now. The definition is not
  // re-read from disk or re-validated structurally by the caller — this call is about
  // references moving, not about the document changing.
  const definition = current.definition as AgentDefinition;
  const result = validate(definition, ctx);

  if (result.errors.length > 0 || !result.resolved) {
    // Edge 20 — a definition that has since become invalid (its sandbox profile was
    // removed from config, say) returns the error list and creates NO version. The
    // existing pinned version keeps serving Runs, which is the safe outcome: an operator
    // who broke config should not also lose the Agent that was working.
    return { errors: result.errors };
  }

  const next = buildSnapshot(
    definition,
    result.resolved.binding,
    result.resolved.corpusId,
    result.warnings,
    ctx,
  );

  const changedFields = diffSnapshots(current.resolved_snapshot, next);

  if (changedFields.length === 0) {
    // R25a — nothing differs, so nothing is written.
    return { changed: false, version: current.version, changed_fields: [], warnings: result.warnings };
  }

  // Something moved. Cut a new immutable version carrying the updated snapshot; the
  // previous version keeps serving any Run already pinned to it.
  const saved = await store.save(definition, next);

  return {
    changed: true,
    version: saved.version,
    changed_fields: changedFields,
    warnings: result.warnings,
  };
}
