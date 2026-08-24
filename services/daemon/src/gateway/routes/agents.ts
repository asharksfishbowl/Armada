/**
 * Agent CRUD, validate, and refresh-bindings — Agent Definition R27-R30.
 *
 * VALIDATION FAILURES RETURN THE FULL ERROR LIST AND PERSIST NOTHING (data-flow step 8).
 * A partially-saved Agent would be worse than a rejected one: the operator would have to
 * work out which half landed.
 *
 * FORGE UNREACHABLE IS 503, NOT 400 (edge 16). The distinction matters — 400 tells an
 * operator their definition is wrong, which would be a lie when the definition is fine and
 * a peer is down. Nothing is persisted either way.
 */

import type { AgentStore } from '../../agents/store.js';
import { buildSnapshot } from '../../agents/resolver.js';
import { refreshBindings } from '../../agents/refresh-bindings.js';
import { validate, type ValidationContext } from '../../agents/validator.js';
import type { AgentDefinition } from '../../agents/definition-schema.js';

export interface RouteResponse {
  status: number;
  body: unknown;
}

/** Thrown by the context provider when forge cannot be reached (edge 16). */
export class UpstreamUnavailable extends Error {
  constructor(readonly service: string, readonly detail: string) {
    super(`${service} is unreachable: ${detail}`);
  }
}

export type ContextProvider = () => Promise<ValidationContext>;

function errorBody(errors: { path: string; message: string }[]): unknown {
  return {
    error: 'validation_failed',
    // R12 — EVERY error, each anchored to a key path so the dashboard can attach it to a
    // field (R33) rather than showing one opaque string.
    errors: errors.map((e) => ({ path: e.path, message: e.message })),
  };
}

async function withContext(
  getContext: ContextProvider,
  run: (ctx: ValidationContext) => Promise<RouteResponse>,
): Promise<RouteResponse> {
  let ctx: ValidationContext;
  try {
    ctx = await getContext();
  } catch (err) {
    if (err instanceof UpstreamUnavailable) {
      return {
        status: 503,
        body: { error: 'upstream_unavailable', service: err.service, detail: err.detail },
      };
    }
    throw err;
  }
  return run(ctx);
}

export function createAgentRoutes(store: AgentStore, getContext: ContextProvider) {
  return {
    /** R27 — create or update by name. */
    async create(raw: unknown): Promise<RouteResponse> {
      return withContext(getContext, async (ctx) => {
        const result = validate(raw, ctx);
        if (result.errors.length > 0 || !result.definition || !result.resolved) {
          return { status: 400, body: errorBody(result.errors) };
        }

        const snapshot = buildSnapshot(
          result.definition,
          result.resolved.binding,
          result.resolved.corpusId,
          result.warnings,
          ctx,
        );
        const saved = await store.save(result.definition as AgentDefinition, snapshot);

        return {
          status: saved.created ? 201 : 200,
          body: {
            agent_id: saved.agentId,
            version: saved.version,
            // Edge 14 — a byte-identical update returns the EXISTING version rather than
            // cutting a new one, and says so.
            created: saved.created,
            warnings: result.warnings,
          },
        };
      });
    },

    /** R30 — validate a candidate without persisting anything. */
    async validateOnly(raw: unknown): Promise<RouteResponse> {
      return withContext(getContext, async (ctx) => {
        const result = validate(raw, ctx);
        return {
          status: result.errors.length > 0 ? 400 : 200,
          body:
            result.errors.length > 0
              ? errorBody(result.errors)
              : { valid: true, warnings: result.warnings },
        };
      });
    },

    /** R29. */
    async list(): Promise<RouteResponse> {
      return { status: 200, body: await store.list() };
    },

    /** R28 — a specific version, or the current one. */
    async get(agentId: string, version?: number): Promise<RouteResponse> {
      const agent = await store.getById(agentId);
      if (!agent || agent.deleted_at) {
        return { status: 404, body: { error: 'not_found', agent_id: agentId } };
      }

      const record = await store.getVersion(agentId, version);
      if (!record) {
        // Edge 18 — name BOTH the requested and the current version, so the operator can
        // see whether they asked for one that never existed or one long superseded.
        return {
          status: 404,
          body: {
            error: 'version_not_found',
            requested: version,
            current: agent.current_version,
          },
        };
      }

      return {
        status: 200,
        body: {
          agent_id: agent.agent_id,
          name: agent.name,
          version: record.version,
          current_version: agent.current_version,
          definition: record.definition,
          resolved_snapshot: record.resolved_snapshot,
        },
      };
    },

    /** R25a — deliberate, auditable adoption of moved references. */
    async refresh(agentId: string): Promise<RouteResponse> {
      return withContext(getContext, async (ctx) => {
        const result = await refreshBindings(store, agentId, ctx);
        if (result === null) {
          return { status: 404, body: { error: 'not_found', agent_id: agentId } };
        }
        if ('errors' in result) {
          // Edge 20 — the definition has since become invalid. No version is created and
          // the existing pinned version keeps serving Runs.
          return { status: 400, body: errorBody(result.errors) };
        }
        return { status: 200, body: result };
      });
    },

    /** R26 — soft delete. Versions and historical Runs are retained. */
    async remove(agentId: string): Promise<RouteResponse> {
      const deleted = await store.softDelete(agentId);
      return deleted
        ? { status: 200, body: { deleted: agentId, versions_retained: true, runs_retained: true } }
        : { status: 404, body: { error: 'not_found', agent_id: agentId } };
    },
  };
}
