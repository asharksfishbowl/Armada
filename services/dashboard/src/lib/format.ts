/**
 * Formatting helpers.
 *
 * `relativeTime` is not cosmetic. Requirement 89 makes a live `last update {duration} ago`
 * "the load-bearing element of a long-running card — the only element that distinguishes a
 * slow run from a stuck one", and build-plan Requirement 12 says it matters MORE for
 * materialization than for training because the forge channel is lossy: a stalled download
 * and a dropped message are indistinguishable from the client without it.
 *
 * So the phrasing is deliberate. It never rounds up to a unit that hides a stall — 90
 * seconds reads `1m 30s`, not `2m` — because the operator is reading this number to decide
 * whether something has stopped.
 */

export function relativeTime(since: number | undefined | null): string {
  if (since === undefined || since === null || Number.isNaN(since)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A wall-clock duration in ms, for run counters. Tabular-nums makes the width stable. */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Token counts. `84.2k` rather than `84200` — the magnitude is what is being read. */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Requirement 90's staleness escalation, against the OBSERVED median update interval.
 *
 * Returned as a token name plus words rather than a colour, so the caller cannot render
 * the amber without also rendering the sentence. Requirement 90 is explicit that this is
 * "the only place where amber means 'possibly stuck', and it says so in text so the meaning
 * is not inferred".
 */
export function staleness(
  lastUpdate: number | undefined,
  medianIntervalMs: number,
): { hue: string; text: string } | null {
  if (lastUpdate === undefined || medianIntervalMs <= 0) return null;
  const elapsed = Date.now() - lastUpdate;
  const ratio = elapsed / medianIntervalMs;
  if (ratio > 5) {
    return { hue: '--status-warn', text: `no progress reported in ${relativeTime(lastUpdate)}` };
  }
  if (ratio > 2) return { hue: '--fg', text: `last update ${relativeTime(lastUpdate)} ago` };
  return { hue: '--fg-dim', text: `last update ${relativeTime(lastUpdate)} ago` };
}
