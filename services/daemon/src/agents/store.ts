/**
 * Agent persistence and versioning — Agent Definition R22, R23, R26; edge 14.
 *
 * VERSIONS ARE IMMUTABLE. No code path in this module updates an `agent_versions` row.
 * That is what makes a Run reproducible: `runs.agent_version_id` points at a row whose
 * `definition` and `resolved_snapshot` can never change underneath it.
 *
 * A BYTE-IDENTICAL UPDATE CREATES NO VERSION (edge 14). The file loader re-reads every
 * file on every change event, so without this a single `touch` would inflate an Agent's
 * history with versions that differ in nothing.
 */

import type { Pool } from 'pg';
import type { AgentDefinition } from './definition-schema.js';
import type { ResolvedSnapshot } from './resolver.js';

export interface AgentRecord {
  agent_id: string;
  name: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgentVersionRecord {
  agent_version_id: string;
  agent_id: string;
  version: number;
  definition: AgentDefinition;
  resolved_snapshot: ResolvedSnapshot;
  created_at: string;
}

export interface SaveResult {
  agentId: string;
  version: number;
  agentVersionId: string;
  /** False when the definition was byte-identical and no version was created. */
  created: boolean;
}

export class AgentStore {
  constructor(private readonly pool: Pool) {}

  async getByName(name: string): Promise<AgentRecord | null> {
    const result = await this.pool.query<AgentRecord>(
      'SELECT * FROM agents WHERE name = $1',
      [name],
    );
    return result.rows[0] ?? null;
  }

  async getById(agentId: string): Promise<AgentRecord | null> {
    const result = await this.pool.query<AgentRecord>(
      'SELECT * FROM agents WHERE agent_id = $1',
      [agentId],
    );
    return result.rows[0] ?? null;
  }

  /** R28 — a specific version, or the current one when `version` is omitted. */
  async getVersion(agentId: string, version?: number): Promise<AgentVersionRecord | null> {
    const result = await this.pool.query<AgentVersionRecord>(
      version === undefined
        ? `SELECT av.* FROM agent_versions av
             JOIN agents a ON a.agent_id = av.agent_id AND a.current_version = av.version
            WHERE av.agent_id = $1`
        : `SELECT * FROM agent_versions WHERE agent_id = $1 AND version = $2`,
      version === undefined ? [agentId] : [agentId, version],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Team Orchestration R10, invariant 2 — read a PINNED version directly by its id.
   *
   * A Team's `resolved_roster` pins `agent_version_id` for every member, and a delegation
   * executes that exact row. Going back through `(agent_id, current_version)` would follow
   * the Agent as it moves, which is precisely what edge 10 forbids: all delegations within
   * one Team Run target the same worker version even if the Agent is edited mid-Run.
   */
  async getVersionById(agentVersionId: string): Promise<AgentVersionRecord | null> {
    const result = await this.pool.query<AgentVersionRecord>(
      'SELECT * FROM agent_versions WHERE agent_version_id = $1',
      [agentVersionId],
    );
    return result.rows[0] ?? null;
  }

  /** R29 — non-deleted Agents, with the resolved binding tag for the list view. */
  async list(): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT a.agent_id, a.name, a.current_version,
              av.definition ->> 'display_name'   AS display_name,
              av.definition ->> 'description'    AS description,
              av.definition -> 'capabilities'    AS capabilities,
              av.resolved_snapshot ->> 'binding_tag' AS binding_tag,
              av.resolved_snapshot -> 'warnings'     AS warnings
         FROM agents a
         JOIN agent_versions av
           ON av.agent_id = a.agent_id AND av.version = a.current_version
        WHERE a.deleted_at IS NULL
        ORDER BY a.name`,
    );
    return result.rows;
  }

  /**
   * Create or update by `name`, inserting a new immutable version.
   *
   * R32 — file-loaded and API-created Agents share ONE namespace keyed on `name`, so a
   * file whose name matches an API-created Agent creates a new version of that same Agent
   * rather than a second one. Upserting on `name` is what implements that.
   *
   * The whole save is one transaction: a version row and the `current_version` pointer
   * that names it must land together, or a crash between them would leave an Agent
   * pointing at a version that does not exist.
   */
  async save(
    definition: AgentDefinition,
    snapshot: ResolvedSnapshot,
  ): Promise<SaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const upserted = await client.query<{ agent_id: string; current_version: number }>(
        `INSERT INTO agents (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now(), deleted_at = NULL
         RETURNING agent_id, current_version`,
        [definition.name],
      );
      const agent = upserted.rows[0]!;

      // Edge 14 — compare against the CURRENT version's definition. Comparing the
      // definition rather than the snapshot is deliberate: a snapshot can differ because
      // the world moved (a new Adapter was promoted), and adopting that is
      // refresh-bindings' job, not a save's.
      if (agent.current_version > 0) {
        const current = await client.query<{ definition: AgentDefinition }>(
          'SELECT definition FROM agent_versions WHERE agent_id = $1 AND version = $2',
          [agent.agent_id, agent.current_version],
        );
        const previous = current.rows[0]?.definition;
        if (previous && JSON.stringify(previous) === JSON.stringify(definition)) {
          await client.query('COMMIT');
          const existing = await this.getVersion(agent.agent_id, agent.current_version);
          return {
            agentId: agent.agent_id,
            version: agent.current_version,
            agentVersionId: existing!.agent_version_id,
            created: false,
          };
        }
      }

      const nextVersion = agent.current_version + 1;
      const inserted = await client.query<{ agent_version_id: string }>(
        `INSERT INTO agent_versions (agent_id, version, definition, resolved_snapshot)
         VALUES ($1, $2, $3, $4)
         RETURNING agent_version_id`,
        [agent.agent_id, nextVersion, JSON.stringify(definition), JSON.stringify(snapshot)],
      );

      await client.query(
        'UPDATE agents SET current_version = $2, updated_at = now() WHERE agent_id = $1',
        [agent.agent_id, nextVersion],
      );

      await client.query('COMMIT');
      return {
        agentId: agent.agent_id,
        version: nextVersion,
        agentVersionId: inserted.rows[0]!.agent_version_id,
        created: true,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * R26 — soft delete.
   *
   * `agent_versions` rows and historical Runs are RETAINED. A Run's pinned definition must
   * stay readable after its Agent is deleted, or the event stream becomes uninterpretable
   * for every Run that Agent ever produced.
   */
  async softDelete(agentId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE agents SET deleted_at = now(), updated_at = now() WHERE agent_id = $1 AND deleted_at IS NULL',
      [agentId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
