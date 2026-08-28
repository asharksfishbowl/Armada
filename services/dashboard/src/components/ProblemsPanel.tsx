/**
 * The problems panel — design-dashboard.md Requirements 70-72, 76-80.
 *
 * EXACTLY TWO SEVERITIES (Requirement 70): `error` blocks save, `warning` does not. The
 * "valid alternatives" that Agent Definition R11/R17/R18/R20 require each error to name is
 * NOT a third severity (Requirement 71) — it is a fix affordance layered onto an error,
 * rendered as clickable suggestion chips.
 *
 * PERSISTENT, 320px, RIGHT-HAND, AND NEVER A POPOVER (Requirement 76). Always present.
 * A popover would hide the error list at the moment the operator starts typing the fix.
 *
 * ATOMIC REPLACEMENT (Requirement 80). Agent Definition R12 returns EVERY error at once,
 * so the panel replaces the whole set in one update with a single 120ms crossfade on the
 * CONTAINER. Individual entries never animate and squiggles never animate — a list where
 * each row fades independently reads as arriving over time, which would suggest the server
 * is still thinking.
 */

import { useMemo } from 'react';

export type Severity = 'error' | 'warning';

export interface Problem {
  severity: Severity;
  /** The server's field path. Monospace, and therefore copyable (Requirement 146). */
  path: string;
  message: string;
  /** Requirement 71/78 — clickable chips that write the value into the document. */
  alternatives?: string[];
}

export interface ProblemsPanelProps {
  problems: Problem[];
  /**
   * Requirement 75.2 / edge case 14. When the document does not parse, the panel collapses
   * to a SINGLE banner carrying the parser's own line and column, and every server error is
   * suppressed — they were computed against text that no longer exists.
   */
  parseError: { line: number; column: number; message: string } | null;
  onSelect?: ((problem: Problem) => void) | undefined;
  onApplyAlternative?: ((problem: Problem, value: string) => void) | undefined;
  selectedPath?: string | undefined;
}

export function ProblemsPanel({
  problems,
  parseError,
  onSelect,
  onApplyAlternative,
  selectedPath,
}: ProblemsPanelProps) {
  // Requirement 76 — grouped by severity, then by field path.
  const ordered = useMemo(() => {
    return [...problems].sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }, [problems]);

  const errors = ordered.filter((p) => p.severity === 'error').length;
  const warnings = ordered.length - errors;

  return (
    <aside
      className="problems-panel"
      aria-label="Problems"
      style={{
        width: 'var(--problems-width)',
        flex: '0 0 var(--problems-width)',
        borderLeft: '1px solid var(--line-strong)',
        background: 'var(--surface-1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--line)',
          color: 'var(--fg-muted)',
        }}
        className="text-body-sm"
      >
        {/* Requirement 76 — "3 errors · 1 warning". */}
        {parseError
          ? 'YAML does not parse'
          : `${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`}
      </header>

      {parseError ? (
        <div
          className="text-body-sm"
          style={{
            margin: 'var(--space-4)',
            padding: 'var(--space-3)',
            border: '1px solid var(--status-fault)',
            borderRadius: 'var(--radius-control)',
            color: 'var(--status-fault)',
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Line {parseError.line}, column {parseError.column}
          </div>
          <div style={{ marginTop: 'var(--space-2)', fontFamily: 'var(--font-mono)' }}>
            {parseError.message}
          </div>
          <div style={{ marginTop: 'var(--space-3)', color: 'var(--fg-muted)' }}>
            Server-side errors are hidden while the document does not parse — the server
            never received this text, so anything it previously reported is about text that
            no longer exists.
          </div>
        </div>
      ) : (
        <div
          // Requirement 80 — one crossfade on the container, keyed on the problem set so a
          // genuinely new set animates and a re-render of the same set does not.
          key={ordered.map((p) => `${p.severity}:${p.path}:${p.message}`).join('|')}
          className="problems-swap"
          style={{ overflowY: 'auto', flex: 1, padding: 'var(--space-2)' }}
        >
          {ordered.length === 0 ? (
            <p className="text-body-sm" style={{ color: 'var(--fg-muted)', padding: 'var(--space-3)' }}>
              No problems.
            </p>
          ) : (
            ordered.map((problem) => (
              <ProblemEntry
                key={`${problem.severity}:${problem.path}:${problem.message}`}
                problem={problem}
                selected={selectedPath === problem.path}
                onSelect={onSelect}
                onApplyAlternative={onApplyAlternative}
              />
            ))
          )}
        </div>
      )}
    </aside>
  );
}

function ProblemEntry({
  problem,
  selected,
  onSelect,
  onApplyAlternative,
}: {
  problem: Problem;
  selected: boolean;
  onSelect?: ((problem: Problem) => void) | undefined;
  onApplyAlternative?: ((problem: Problem, value: string) => void) | undefined;
}) {
  const hue = problem.severity === 'error' ? '--status-fault' : '--status-warn';

  return (
    <div
      className="row"
      onMouseEnter={() => onSelect?.(problem)}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-control)',
        background: selected ? 'var(--surface-3)' : 'transparent',
        cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
        <span className="text-micro" style={{ color: `var(${hue})`, fontWeight: 600 }}>
          {problem.severity === 'error' ? 'ERROR' : 'WARNING'}
        </span>
        <span
          className="text-mono-body"
          style={{ color: 'var(--fg-muted)', overflowWrap: 'anywhere' }}
        >
          {problem.path || '(document)'}
        </span>
      </div>
      <div className="text-body-sm" style={{ color: 'var(--fg)', marginTop: 'var(--space-1)' }}>
        {problem.message}
      </div>
      {problem.alternatives && problem.alternatives.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-1)',
            marginTop: 'var(--space-2)',
          }}
        >
          {problem.alternatives.map((alternative) => (
            <button
              key={alternative}
              type="button"
              className="suggestion-chip"
              onClick={() => onApplyAlternative?.(problem, alternative)}
            >
              {alternative}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Extracts the "valid alternatives" an error names.
 *
 * Requirements 71 and 78 require alternatives to be clickable chips, but the validation
 * response has no structured field for them — the daemon puts them in the message prose.
 * Rather than fabricate a field the server does not send, this reads the two shapes the
 * daemon actually produces, and returns nothing when it recognises neither. An error with
 * no parseable alternatives simply renders without chips, which is honest; inventing
 * plausible-looking suggestions would be worse than showing none.
 */
export function extractAlternatives(message: string): string[] {
  // `one of: a, b, c` / `must be one of `a`, `b``
  const listMatch = /one of:?\s*(.+?)(?:\.|$)/i.exec(message);
  if (!listMatch?.[1]) return [];
  const candidates = listMatch[1]
    .split(/,| or /)
    .map((part) => part.trim().replace(/^[`'"]|[`'"]$/g, ''))
    .filter((part) => part.length > 0 && part.length < 64);
  return candidates.length > 1 ? candidates : [];
}
