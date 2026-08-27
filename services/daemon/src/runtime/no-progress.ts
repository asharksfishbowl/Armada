/**
 * The no-progress detector — Agent Runtime R33, R33a; edge 4.
 *
 * Terminates a Run when the same tool name and BYTE-IDENTICAL arguments recur across
 * `no_progress_threshold` consecutive Steps.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BUDGETS. A model stuck in a loop — calling the same
 * failing tool with the same arguments — will eventually hit `max_steps`, so termination is
 * already guaranteed by invariant 6. But it will burn the entire step and token budget
 * getting there, and it will produce a transcript that is 90% identical repetitions.
 * Catching it at three Steps rather than forty is the difference between a cheap failure
 * and an expensive one, and between a diagnosable transcript and a wall of noise.
 *
 * R33a — IN CODE MODE A STEP IS A PROGRAM, NOT A TOOL CALL, so the detector compares the
 * byte-identical SOURCE of the generated program instead. Same threshold, same idea:
 * a model regenerating the same program is no more productive than one repeating a call.
 */

/** What a Step contributed, from the detector's point of view. */
export type StepSignature =
  | { kind: 'tool_calls'; calls: { name: string; args: unknown }[] }
  | { kind: 'program'; source: string };

/**
 * Canonical form of a Step, for comparison.
 *
 * Arguments are serialized with SORTED KEYS so that `{a:1,b:2}` and `{b:2,a:1}` compare
 * equal. Without that, a model that reorders its JSON — which they do — would defeat the
 * detector while making no progress at all.
 */
export function signatureOf(step: StepSignature): string {
  if (step.kind === 'program') return `program:${step.source}`;
  return `tools:${step.calls.map((c) => `${c.name}(${stableStringify(c.args)})`).join('|')}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class NoProgressDetector {
  private lastSignature: string | null = null;
  private repeatCount = 0;

  constructor(private readonly threshold: number) {}

  /**
   * Record a Step and report whether the Run should terminate.
   *
   * Returns true on the threshold-th CONSECUTIVE identical Step — so a threshold of 3
   * terminates on the third, having seen exactly three identical Steps.
   */
  record(step: StepSignature): boolean {
    const signature = signatureOf(step);

    if (signature === this.lastSignature) {
      this.repeatCount += 1;
    } else {
      // Any different Step resets the count. Progress is progress even if the model
      // returns to the earlier call later — an A,B,A,B oscillation is not caught here, and
      // deliberately so: it may be legitimate (read, write, read, write).
      this.lastSignature = signature;
      this.repeatCount = 1;
    }

    return this.repeatCount >= this.threshold;
  }

  /** A Step with no tool calls ends the Turn, so the streak is irrelevant afterwards. */
  reset(): void {
    this.lastSignature = null;
    this.repeatCount = 0;
  }

  get consecutiveRepeats(): number {
    return this.repeatCount;
  }
}
