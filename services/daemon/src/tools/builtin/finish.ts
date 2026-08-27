/**
 * The `finish` built-in — Agent Runtime R25, R25a; edges 20, 20a, 20b.
 *
 * ── INVARIANT 1 LIVES HERE ──────────────────────────────────────────────────
 * `finish(success: true)` is the ONLY way a Run can reach outcome `success`. Nothing
 * infers success from termination.
 *
 * That is not defensive pedantry: armada-forge builds trajectory training data
 * EXCLUSIVELY from Runs whose outcome is `success` (R25b). Defaulting a merely-terminated
 * Run to success would train the next Adapter on every run that managed not to crash.
 *
 * Two consequences the schema has to carry:
 *   - `success` is REQUIRED. A malformed finish fails validation, returns an is_error
 *     result, and does NOT terminate the Turn (edge 20b) — otherwise a model could end a
 *     Run by emitting a broken call.
 *   - `finish(success: false)` yields `incomplete`, NOT `failed` (edge 20a). `failed` is
 *     reserved for infrastructure faults; `incomplete` means the agent ran correctly and
 *     honestly reported it did not achieve the task.
 */

import type { ToolSpec } from '../../kernel/types.js';

export const FINISH = 'finish';

export const finishToolSpec: ToolSpec = {
  name: FINISH,
  description:
    'End the task. Call with success: true ONLY if the task is genuinely complete. ' +
    'If you could not complete it, call with success: false and say what is missing — ' +
    'a truthful negative is more useful than an optimistic one.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What was done, or what was not.' },
      success: { type: 'boolean', description: 'Whether the task was genuinely achieved.' },
    },
    // Both required. `success` especially: it is the sole source of a success outcome.
    required: ['summary', 'success'],
    additionalProperties: false,
  },
};

export interface FinishCall {
  summary: string;
  success: boolean;
}

/**
 * Validate a finish call.
 *
 * Returns an error rather than throwing, and the caller must NOT terminate the Turn on a
 * failure (edge 20b). An empty `summary` is accepted — edge 20 says the Turn still
 * terminates and `run_end` records the outcome with an empty result.
 */
export function validateFinish(
  args: unknown,
): { ok: true; value: FinishCall } | { ok: false; error: string } {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'finish requires an object with `summary` and `success`' };
  }

  const { summary, success } = args as { summary?: unknown; success?: unknown };

  if (typeof summary !== 'string') {
    return { ok: false, error: 'finish requires a `summary` string' };
  }
  if (typeof success !== 'boolean') {
    // The load-bearing check. Without it a missing `success` could be coerced to false —
    // or worse, to true — and invariant 1 would be decided by a type coercion.
    return {
      ok: false,
      error: 'finish requires an explicit `success` boolean; it is the only way a Run reports success',
    };
  }

  return { ok: true, value: { summary, success } };
}
