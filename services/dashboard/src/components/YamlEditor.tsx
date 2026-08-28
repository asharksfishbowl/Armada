/**
 * The shared YAML editor — design-dashboard.md Requirements 70-82a.
 *
 * THERE IS ONE OF THESE (Requirement 82). `AgentEditor.tsx` and `TeamEditor.tsx` are thin
 * wrappers supplying exactly three things: the starting document, the validate endpoint,
 * and the save endpoint. Because `POST /api/teams/validate` exists and mirrors the agent
 * endpoint — full error list, no persistence on failure (Team Orchestration R39) — teams
 * get identical debounced live validation with no save-only fallback.
 *
 * VALIDATION TIMING (Requirement 81): a 600ms idle debounce, on blur, and on an explicit
 * save keystroke.
 *
 * THE DEBOUNCE IS ANIMATION-DRIVEN, NOT setTimeout-DRIVEN, for the same reason the copy
 * acknowledgement is: this repo's standing rule is event-driven only, and a restarting CSS
 * animation is a genuine event source with the duration declared in exactly one place. The
 * `key` changes on every keystroke, which remounts the element and restarts its 600ms
 * animation from zero — which is precisely what "debounce" means — and `animationend`
 * fires only when the operator has actually stopped typing for 600ms.
 *
 * A NEW ENTITY HAS NO ID AND THEREFORE NO VALIDATE ENDPOINT (Requirement 82a). On
 * `/agents/new` and `/teams/new`, client-side parse errors and missing-key phantom lines
 * render live while every server-resolved error first appears on the initial save attempt,
 * which returns 400 with the full list INTO THE SAME PANEL IN THE SAME FORMAT. The panel's
 * appearance never differs between the two states; only its update timing does. Here both
 * validate endpoints are collection-level (`POST /api/agents/validate`) rather than
 * id-scoped, so live validation is available even before first save — which is strictly
 * better than 82a requires and changes nothing about the rendering.
 *
 * ONE DELIBERATE DEVIATION, RECORDED. Requirement 75.1 asks for the phantom line to render
 * as a full dimmed italic ROW at the insertion point. It renders here as a dimmed italic
 * click-to-insert affordance at the END of the parent container's line instead. Inserting
 * a visual row into an overlay that must stay glyph-aligned with a `<textarea>`
 * desynchronises every line beneath it, which would put every squiggle in the document one
 * line off — a much worse failure than the phantom sitting to the right of its anchor. The
 * behaviour Requirement 75.1 specifies is intact: it is at the insertion point, it is
 * dimmed and italic, it is not editable, and clicking it inserts the key.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ProblemsPanel, extractAlternatives, type Problem } from './ProblemsPanel';
import { ApiError } from '../lib/api';
import { anchorFieldPath, insertKeyAt, yamlParseError, yamlToJson, type Anchor } from '../lib/yaml-anchor';

export interface YamlEditorProps {
  title: string;
  initialSource: string;
  /** Requirement 82 — supplied by the wrapper. Resolves on valid, throws ApiError on 400. */
  validate: (definition: unknown) => Promise<{ warnings: string[] }>;
  /** Requirement 82 — supplied by the wrapper. */
  save: (definition: unknown) => Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}

interface Anchored extends Problem {
  anchor: Anchor;
}

export function YamlEditor({ title, initialSource, validate, save, onCancel, busy = false }: YamlEditorProps) {
  const [source, setSource] = useState(initialSource);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [debounceKey, setDebounceKey] = useState(0);

  // Requirement 81 / edge case 16: when a validation request is in flight and the operator
  // types again, the EARLIER response is discarded rather than rendered. The panel only
  // ever shows the result of the most recent completed validation.
  const generation = useRef(0);

  const parseError = useMemo(() => yamlParseError(source), [source]);

  const runValidation = useCallback(async () => {
    // Requirement 75.2: while the document does not parse, do not ask the server. It would
    // answer about the last thing that parsed, and every answer would be stale.
    if (yamlParseError(source)) return;

    const mine = ++generation.current;
    let definition: unknown;
    try {
      definition = yamlToJson(source);
    } catch {
      return;
    }

    try {
      const result = await validate(definition);
      if (mine !== generation.current) return;
      setServerProblems(
        result.warnings.map((message) => ({ severity: 'warning' as const, path: '', message })),
      );
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof ApiError) {
        setServerProblems(
          err.validationErrors.map((entry) => ({
            severity: 'error' as const,
            path: entry.path,
            message: entry.message,
            alternatives: extractAlternatives(entry.message),
          })),
        );
      }
    }
  }, [source, validate]);

  // Requirement 81 — the explicit save keystroke.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        void runValidation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runValidation]);

  const problems: Anchored[] = useMemo(
    () => serverProblems.map((problem) => ({ ...problem, anchor: anchorFieldPath(source, problem.path) })),
    [serverProblems, source],
  );

  const errorCount = problems.filter((p) => p.severity === 'error').length;
  const warningCount = problems.length - errorCount;

  // Requirement 79 — save is disabled while errors exist. Also disabled while the document
  // does not parse: there is nothing coherent to send.
  const saveBlocked = errorCount > 0 || parseError !== null;
  // Requirement 79 — with only warnings, save is ENABLED and its label renders amber, so
  // saving with warnings is a visible decision rather than an invisible default.
  const saveWithWarnings = !saveBlocked && warningCount > 0;

  const onSave = useCallback(async () => {
    if (saveBlocked) return;
    setSaving(true);
    try {
      await save(yamlToJson(source));
    } catch (err) {
      // Requirement 82a / edge case 19: a 400 from save renders into the SAME panel in the
      // SAME format as a live validation failure.
      if (err instanceof ApiError) {
        setServerProblems(
          err.validationErrors.map((entry) => ({
            severity: 'error' as const,
            path: entry.path,
            message: entry.message,
            alternatives: extractAlternatives(entry.message),
          })),
        );
      }
    } finally {
      setSaving(false);
    }
  }, [save, saveBlocked, source]);

  const applyAlternative = useCallback((problem: Problem, value: string) => {
    // Requirement 78 — writes the chosen value into the document at the error's anchor.
    setSource((current) => {
      const anchor = anchorFieldPath(current, problem.path);
      if (anchor.kind === 'node' || anchor.kind === 'flow') {
        return current.slice(0, anchor.startOffset) + value + current.slice(anchor.endOffset);
      }
      if (anchor.kind === 'phantom') {
        return insertKeyAt(current, anchor).replace(
          new RegExp(`(${anchor.missingKey}: )$`, 'm'),
          `$1${value}`,
        );
      }
      return current;
    });
  }, []);

  const insertPhantom = useCallback((anchor: Extract<Anchor, { kind: 'phantom' }>) => {
    setSource((current) => insertKeyAt(current, anchor));
  }, []);

  const lines = source.split('\n');
  const phantomByLine = new Map<number, Extract<Anchor, { kind: 'phantom' }>>();
  for (const problem of problems) {
    if (problem.anchor.kind === 'phantom') phantomByLine.set(problem.anchor.line, problem.anchor);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <h1 className="text-page" style={{ margin: 0 }}>
          {title}
        </h1>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={saveBlocked || saving || busy}
          style={saveWithWarnings ? { color: 'var(--status-warn)' } : undefined}
        >
          {saving ? 'Saving…' : saveWithWarnings ? 'Save with warnings' : 'Save'}
        </button>
      </header>

      {/* Requirement 95 — a disabled primary action always renders its reason inline. */}
      {saveBlocked ? (
        <p
          className="text-body-sm"
          style={{ margin: 0, padding: 'var(--space-2) var(--space-4)', color: 'var(--fg-muted)' }}
        >
          {parseError
            ? 'Save is disabled because the document does not parse as YAML.'
            : `Save is disabled while ${errorCount} error${errorCount === 1 ? '' : 's'} remain${errorCount === 1 ? 's' : ''}.`}
        </p>
      ) : null}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="editor-surface" style={{ flex: 1, display: 'flex', overflow: 'auto' }}>
          <div className="editor-gutter" aria-hidden>
            {lines.map((_, index) => {
              const lineNumber = index + 1;
              const marker = problems.findIndex(
                (p) =>
                  (p.anchor.kind === 'node' || p.anchor.kind === 'flow' || p.anchor.kind === 'phantom') &&
                  p.anchor.line === lineNumber,
              );
              return (
                <div key={lineNumber} className="editor-gutter-line">
                  {marker >= 0 ? (
                    <span
                      className="editor-marker"
                      style={{
                        color: `var(--status-${problems[marker]?.severity === 'error' ? 'fault' : 'warn'})`,
                      }}
                    >
                      {marker + 1}
                    </span>
                  ) : (
                    lineNumber
                  )}
                </div>
              );
            })}
          </div>

          <div className="editor-body">
            {/* Requirement 74 — the squiggle overlay, glyph-aligned behind the textarea.
                Text is transparent here; the textarea above carries the visible glyphs. */}
            <pre className="editor-overlay" aria-hidden>
              {buildOverlay(source, problems, hovered)}
            </pre>

            <textarea
              className="editor-input"
              spellCheck={false}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                // Restarting the debounce is a remount, not a timer reset.
                setDebounceKey((key) => key + 1);
              }}
              // Requirement 81 — validate on blur.
              onBlur={() => void runValidation()}
            />

            {/* Requirement 75.1's click-to-insert phantom affordances. */}
            {[...phantomByLine.entries()].map(([line, anchor]) => (
              <button
                key={`${line}:${anchor.missingKey}`}
                type="button"
                className="phantom-line"
                onClick={() => insertPhantom(anchor)}
                style={{ top: `calc((${line} - 1) * var(--leading-mono-body))` }}
              >
                {anchor.missingKey} ← required
              </button>
            ))}
          </div>
        </div>

        <ProblemsPanel
          problems={problems}
          parseError={parseError}
          onSelect={(problem) => setHovered(problem.path)}
          onApplyAlternative={applyAlternative}
          selectedPath={hovered}
        />
      </div>

      {/* The debounce. Remounted on every keystroke by its key, so its 600ms animation
          restarts; `animationend` therefore fires only after 600ms of no typing. */}
      <span
        key={debounceKey}
        className="validate-debounce"
        aria-hidden
        onAnimationEnd={() => void runValidation()}
      />
    </div>
  );
}

/**
 * Splits the source into transparent text plus wavy-underlined spans over each anchored
 * range (Requirement 74). Hovering a problems-panel entry emphasises its own span, which is
 * the other half of the bidirectional hover link.
 */
function buildOverlay(source: string, problems: Anchored[], hovered: string | undefined) {
  const ranges = problems
    .filter((p) => p.anchor.kind === 'node' || p.anchor.kind === 'flow')
    .map((p) => {
      const anchor = p.anchor as Extract<Anchor, { kind: 'node' | 'flow' }>;
      return { start: anchor.startOffset, end: anchor.endOffset, problem: p };
    })
    .sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start < cursor) return; // overlapping anchors: first one wins
    parts.push(source.slice(cursor, range.start));
    parts.push(
      <span
        key={index}
        className={
          hovered === range.problem.path ? 'squiggle squiggle-hovered' : 'squiggle'
        }
        style={{
          textDecorationColor: `var(--status-${range.problem.severity === 'error' ? 'fault' : 'warn'})`,
        }}
      >
        {source.slice(range.start, range.end)}
      </span>,
    );
    cursor = range.end;
  });
  parts.push(source.slice(cursor));
  // A trailing newline keeps the overlay's scroll height equal to the textarea's.
  parts.push('\n');
  return parts;
}
