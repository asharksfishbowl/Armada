/**
 * Argument validation shared by the built-in tools.
 *
 * Every tool validates model-supplied arguments the same way and must fail the same way:
 * an `is_error` RESULT, never a throw (R30). A tool call with bad arguments is a mistake
 * the model can correct on the next Step; terminating the Run over it would discard the
 * whole trajectory.
 *
 * These live in one place because `shell`, `read_file`/`write_file`/`list_dir`,
 * `search_knowledge`, and `finish` were each carrying their own copy of the same three
 * checks — and three copies of a validation rule is three chances for one of them to drift
 * into accepting something the others reject.
 */

/** The result shape every tool validator returns. */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Narrow to a plain object, which every tool's arguments must be. */
export function asRecord(args: unknown, tool: string): Validated<Record<string, unknown>> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return invalid(`${tool} expects an object of arguments`);
  }
  return { ok: true, value: args as Record<string, unknown> };
}

/** A required, non-empty string. */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Validated<string> {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(`${tool} requires a non-empty \`${key}\` string`);
  }
  return { ok: true, value };
}

/**
 * A required string that MAY be empty.
 *
 * Distinct from requireString because an empty value is meaningful for some arguments —
 * `write_file` truncating a file, `finish` with an empty summary (edge 20) — and rejecting
 * those would refuse a legitimate operation.
 */
export function requireStringAllowEmpty(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Validated<string> {
  const value = args[key];
  if (typeof value !== 'string') return invalid(`${tool} requires a \`${key}\` string`);
  return { ok: true, value };
}

/** An optional positive integer. Absent is fine; present-and-wrong is not. */
export function optionalPositiveInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Validated<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return invalid(`${tool} requires \`${key}\` to be a positive integer when provided`);
  }
  return { ok: true, value };
}

/** A required boolean. No coercion — see finish.ts for why that matters. */
export function requireBoolean(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Validated<boolean> {
  const value = args[key];
  if (typeof value !== 'boolean') return invalid(`${tool} requires a \`${key}\` boolean`);
  return { ok: true, value };
}

/** Render any thrown value as a message. This tail appeared in a dozen catch blocks. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
