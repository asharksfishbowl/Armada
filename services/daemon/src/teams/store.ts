/**
 * Team persistence and versioning — Team Orchestration R10, R39; edge 11.
 *
 * VERSIONS ARE IMMUTABLE, exactly as Agent versions are (R10 says "the same
 * immutable-version semantics"). No code path here updates a `team_versions` row. That is
 * what makes edge 10 true: a Team Run pins `team_version_id`, and editing the Team while
 * that Run is in flight cannot change the roster it is delegating against.
 *
 * A BYTE-IDENTICAL SAVE CREATES NO VERSION. The file loader re-reads every file on every
 * change, so without this a single `touch` would inflate a Team's history with versions
 * that differ in nothing.
 */

import type { Pool } from 'pg';
import type { TeamDefinition } from './team-schema.js';
import type { ResolvedRoster } from './validator.js';

export interface TeamRecord {
  team_id: string;
  name: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TeamVersionRecord {
  team_version_id: string;
  team_id: string;
  version: number;
  definition: TeamDefinition;
  resolved_roster: ResolvedRoster;
  created_at: string;
}

export interface TeamSaveResult {
  teamId: string;
  version: number;
  teamVersionId: string;
  /** False when the definition was byte-identical and no version was created. */
  created: boolean;
}

export class TeamStore {
  constructor(private readonly pool: Pool) {}

  async getByName(name: string): Promise<TeamRecord | null> {
    const { rows } = await this.pool.query<TeamRecord>('SELECT * FROM teams WHERE name = $1', [name]);
    return rows[0] ?? null;
  }

  async getById(teamId: string): Promise<TeamRecord | null> {
    const { rows } = await this.pool.query<TeamRecord>('SELECT * FROM teams WHERE team_id = $1', [
      teamId,
    ]);
    return rows[0] ?? null;
  }

  /** R39 — a specific version, or the current one when `version` is omitted. */
  async getVersion(teamId: string, version?: number): Promise<TeamVersionRecord | null> {
    const { rows } = await this.pool.query<TeamVersionRecord>(
      version === undefined
        ? `SELECT tv.* FROM team_versions tv
             JOIN teams t ON t.team_id = tv.team_id AND t.current_version = tv.version
            WHERE tv.team_id = $1`
        : 'SELECT * FROM team_versions WHERE team_id = $1 AND version = $2',
      version === undefined ? [teamId] : [teamId, version],
    );
    return rows[0] ?? null;
  }

  async getVersionById(teamVersionId: string): Promise<TeamVersionRecord | null> {
    const { rows } = await this.pool.query<TeamVersionRecord>(
      'SELECT * FROM team_versions WHERE team_version_id = $1',
      [teamVersionId],
    );
    return rows[0] ?? null;
  }

  /**
   * R39 — non-deleted Teams with their pinned roster.
   *
   * Edge 11 — a Team whose worker Agent was deleted after the save is flagged
   * `warnings: ["worker_missing"]` rather than hidden or deleted. The Team record is still
   * valid; it just cannot start a Run until the operator restores or replaces that worker,
   * and the list is where they find out.
   */
  async list(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query<{
      team_id: string;
      name: string;
      current_version: number;
      display_name: string | null;
      description: string | null;
      resolved_roster: ResolvedRoster;
    }>(
      `SELECT t.team_id, t.name, t.current_version,
              tv.definition ->> 'display_name' AS display_name,
              tv.definition ->> 'description'  AS description,
              tv.resolved_roster               AS resolved_roster
         FROM teams t
         JOIN team_versions tv
           ON tv.team_id = t.team_id AND tv.version = t.current_version
        WHERE t.deleted_at IS NULL
        ORDER BY t.name`,
    );

    // The liveness check is TWO PLAIN QUERIES AND A SET LOOKUP, not a lateral join over
    // jsonb. It could be expressed in SQL, and that SQL would be the one statement in this
    // file no unit test could reach — it needs a live Postgres. A wrong `worker_missing`
    // flag is a wrong answer on the Teams list, which is exactly the kind of thing that
    // should fail in the suite rather than in front of an operator.
    const live = await this.pool.query<{ agent_id: string }>(
      'SELECT agent_id FROM agents WHERE deleted_at IS NULL',
    );
    const alive = new Set(live.rows.map((r) => r.agent_id));

    return rows.map((row) => {
      const roster = row.resolved_roster;
      const missing = [roster.manager, ...roster.workers]
        .filter((m) => !alive.has(m.agent_id))
        .map((m) => m.agent_name);

      return {
        team_id: row.team_id,
        name: row.name,
        current_version: row.current_version,
        display_name: row.display_name,
        description: row.description,
        manager: roster.manager.agent_name,
        workers: roster.workers.map((w) => ({
          alias: w.alias,
          agent_name: w.agent_name,
          capabilities: w.capabilities,
        })),
        limits: roster.limits,
        // Edge 11 — flagged, never hidden. The Team record is still valid; it just cannot
        // start a Run until the operator restores or replaces that member.
        warnings: missing.length > 0 ? ['worker_missing'] : [],
        ...(missing.length > 0 ? { missing_members: missing } : {}),
      };
    });
  }

  /**
   * Create or update by `name`, inserting a new immutable version.
   *
   * R41 — file-loaded and API-created Teams share ONE namespace keyed on `name`, so a file
   * whose name matches an API-created Team creates a new version of that same Team rather
   * than a second one.
   *
   * The whole save is one transaction: a version row and the `current_version` pointer that
   * names it must land together, or a crash between them would leave a Team pointing at a
   * version that does not exist.
   */
  async save(definition: TeamDefinition, roster: ResolvedRoster): Promise<TeamSaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const upserted = await client.query<{ team_id: string; current_version: number }>(
        `INSERT INTO teams (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET updated_at = now(), deleted_at = NULL
         RETURNING team_id, current_version`,
        [definition.name],
      );
      const team = upserted.rows[0]!;

      if (team.current_version > 0) {
        // Compare the DEFINITION, not the roster: a roster can differ because an Agent
        // gained a new version, and adopting that is a deliberate re-save, not a no-op.
        const current = await client.query<{ definition: TeamDefinition }>(
          'SELECT definition FROM team_versions WHERE team_id = $1 AND version = $2',
          [team.team_id, team.current_version],
        );
        const previous = current.rows[0]?.definition;
        if (previous && JSON.stringify(previous) === JSON.stringify(definition)) {
          await client.query('COMMIT');
          const existing = await this.getVersion(team.team_id, team.current_version);
          return {
            teamId: team.team_id,
            version: team.current_version,
            teamVersionId: existing!.team_version_id,
            created: false,
          };
        }
      }

      const nextVersion = team.current_version + 1;
      const inserted = await client.query<{ team_version_id: string }>(
        `INSERT INTO team_versions (team_id, version, definition, resolved_roster)
         VALUES ($1, $2, $3, $4)
         RETURNING team_version_id`,
        [team.team_id, nextVersion, JSON.stringify(definition), JSON.stringify(roster)],
      );

      await client.query('UPDATE teams SET current_version = $2, updated_at = now() WHERE team_id = $1', [
        team.team_id,
        nextVersion,
      ]);

      await client.query('COMMIT');
      return {
        teamId: team.team_id,
        version: nextVersion,
        teamVersionId: inserted.rows[0]!.team_version_id,
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
   * Soft delete — design spec R102.
   *
   * Deleting a Team deletes the DEFINITION only. Every member Agent and every Run the Team
   * produced is retained, because a Team Run's `team_version_id` must stay readable or its
   * event stream becomes uninterpretable.
   */
  async softDelete(teamId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE teams SET deleted_at = now(), updated_at = now() WHERE team_id = $1 AND deleted_at IS NULL',
      [teamId],
    );
    return (rowCount ?? 0) > 0;
  }
}
