/**
 * PostgresEventSink — Agent Runtime R54-R59.
 *
 * INVARIANT 5: events are append-only and gapless per Run.
 *
 * Both halves of that live HERE rather than in callers, and that placement is the point:
 *
 *   * `seq` is assigned by the append_event() SQL function (migration 005), which
 *     increments a per-run counter under a row lock inside the same transaction as the
 *     insert. Two concurrent tool completions serialize instead of racing for a number
 *     (R58). No caller computes a seq, so no caller can get it wrong.
 *
 *   * Redaction (R59) runs inside append(), so a caller cannot forget it. A credential
 *     that reaches this method never reaches the database.
 *
 * The append-only guarantee is additionally enforced by triggers in migration 005, which
 * reject UPDATE and DELETE on `events` from ANY connection — including a psql session.
 * That is stronger than R54 asks for: the requirement says no code path updates or deletes
 * an Event, and the trigger makes that true of paths nobody wrote.
 */

import type { Pool } from 'pg';
import type { Event, EventInput, EventSink } from '../kernel/types.js';

/** Nothing shorter than this is treated as a secret — see redact(). */
const MIN_REDACTABLE_LENGTH = 8;

export class PostgresEventSink implements EventSink {
  readonly name = 'PostgresEventSink';

  /**
   * Values to replace with [redacted]. Populated at construction from the environment
   * variables named by every `env_keys` and `api_key_env` setting in config.
   */
  private readonly secrets: string[];

  constructor(
    private readonly pool: Pool,
    credentialEnvNames: string[],
  ) {
    // R59 — resolve NAMES to VALUES once, here. The config files hold names only
    // (invariant 8); the values exist solely in this process's environment.
    //
    // Short values are excluded deliberately: a two-character secret would match
    // constantly and redact ordinary text, which destroys the event stream's usefulness
    // while protecting nothing an attacker could not guess anyway.
    this.secrets = credentialEnvNames
      .map((envName) => process.env[envName])
      .filter((value): value is string => !!value && value.length >= MIN_REDACTABLE_LENGTH);
  }

  /**
   * Replace any configured credential value found anywhere in the payload.
   *
   * Walks the whole structure rather than checking known fields: a credential can end up
   * inside a tool result, an error message, or a nested MCP response, and enumerating
   * where it might appear is exactly the assumption that leaks.
   */
  private redact(value: unknown): unknown {
    if (this.secrets.length === 0) return value;

    if (typeof value === 'string') {
      let out = value;
      for (const secret of this.secrets) out = out.replaceAll(secret, '[redacted]');
      return out;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.redact(item);
      }
      return out;
    }

    return value;
  }

  /**
   * Append one Event. `seq` is assigned transactionally by append_event().
   *
   * R54 — append-only. There is no update() or delete() on this class, and there will not
   * be one; the database rejects both regardless.
   */
  async append(event: EventInput): Promise<Event> {
    // redact() recurses over `unknown`; the input is an object, so the result is one too.
    const payload = this.redact(event.payload ?? {}) as Record<string, unknown>;

    const result = await this.pool.query<{ event_id: string; seq: string }>(
      'SELECT event_id, seq FROM append_event($1::uuid, $2::event_type, $3::jsonb)',
      [event.runId, event.type, JSON.stringify(payload)],
    );

    const row = result.rows[0];
    if (!row) {
      // append_event raises when the run_id does not exist, so an empty result means the
      // function's contract changed rather than a missing run.
      throw new Error(`append_event returned no row for run ${event.runId}`);
    }

    return {
      eventId: row.event_id,
      runId: event.runId,
      // bigint arrives as a string from pg; seq is small enough for a JS number.
      seq: Number(row.seq),
      type: event.type,
      payload,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Read a Run's Events in `seq` order.
   *
   * `afterSeq` supports resuming a replay without re-sending what a subscriber already
   * has. Ordering is by seq, not created_at: two Events written in the same millisecond
   * have a defined order only under seq (R6).
   */
  async read(runId: string, afterSeq = 0): Promise<Event[]> {
    const result = await this.pool.query<{
      event_id: string;
      run_id: string;
      seq: string;
      type: Event['type'];
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT event_id, run_id, seq, type, payload, created_at
         FROM events
        WHERE run_id = $1::uuid AND seq > $2
        ORDER BY seq ASC`,
      [runId, afterSeq],
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      seq: Number(row.seq),
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
  }
}

/**
 * Collect every environment variable NAME that may hold a credential, from
 * config/mcp-servers.yaml `env_keys` and any `api_key_env` in the config tree.
 *
 * Returns names, never values — the values are read once inside the sink.
 */
export function collectCredentialEnvNames(configs: unknown[]): string[] {
  const names = new Set<string>();

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, item] of Object.entries(value)) {
      if (key === 'api_key_env' && typeof item === 'string' && item) {
        names.add(item);
      } else if (key === 'env_keys' && Array.isArray(item)) {
        for (const name of item) if (typeof name === 'string' && name) names.add(name);
      } else {
        walk(item);
      }
    }
  };

  configs.forEach(walk);
  return [...names];
}
