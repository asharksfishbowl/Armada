/**
 * Field path -> editor location — design-dashboard.md Requirements 73-75.
 *
 * THE PROBLEM THIS SOLVES. Validation errors from `POST /api/agents/validate` and
 * `POST /api/teams/validate` carry a FIELD PATH and valid alternatives, and no line or
 * column number (Requirement 73). The server validated a parsed object; it never saw the
 * operator's text. Mapping a path back to a position is therefore necessarily client-side,
 * against a locally parsed YAML CST.
 *
 * The hard half is that a path frequently names something that IS NOT IN THE TEXT — the
 * most common validation error of all is a missing required key, and there is by
 * definition no node to underline. Requirement 75 enumerates exactly three such sub-cases
 * and this module returns one discriminated result per case:
 *
 *   1. `phantom`      — missing required key. Anchor to the parent container's line; at
 *                       document root, anchor to line 1. The editor renders a dimmed,
 *                       italic, click-to-insert phantom line there.
 *   2. `parse-error`  — the document does not parse. NO CST exists and the server never
 *                       received valid YAML, so every server error is stale. The caller
 *                       must suppress all of them and render only the parser's own line
 *                       and column (Requirement 75.2, edge case 14).
 *   3. `flow`         — the path resolves inside a flow-style node (`tools: {builtin: [x]}`).
 *                       Sub-token precision is not recoverable, so the WHOLE node is
 *                       highlighted. A wider highlight is preferable to a falsely precise
 *                       one.
 *
 * ...plus the ordinary case, `node`, where the path resolves and the exact token is
 * underlined (Requirement 74).
 *
 * PURE, AND SEPARATE FROM THE EDITOR COMPONENT, because every one of those four outcomes
 * is a rule with a wrong answer that renders plausibly. Anchoring a missing key to line 1
 * instead of its parent, or underlining a stale error against text that no longer exists,
 * both look fine on screen and are both wrong. They are testable here and are not testable
 * inside a textarea.
 */

import { isCollection, isMap, isSeq, parseDocument, stringify } from 'yaml';

export type Anchor =
  | { kind: 'node'; line: number; endLine: number; startOffset: number; endOffset: number }
  | { kind: 'flow'; line: number; endLine: number; startOffset: number; endOffset: number }
  | { kind: 'phantom'; line: number; missingKey: string; indent: number }
  | { kind: 'parse-error'; line: number; column: number; message: string }
  | { kind: 'unanchored' };

export type PathSegment = { key: string } | { index: number };

/**
 * Splits `runtime.budgets.max_steps` and `tools.builtin[0]` into segments.
 *
 * The two forms are the daemon's own, produced by `agents/definition-schema.ts`: dotted
 * keys, and `[n]` for a sequence entry. An empty path means the document root, which the
 * daemon emits for "an Agent definition must be a mapping".
 */
export function parseFieldPath(path: string): PathSegment[] {
  if (path === '') return [];
  const segments: PathSegment[] = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      segments.push({ key: part });
      continue;
    }
    const [, key, indices] = match;
    if (key) segments.push({ key });
    if (indices) {
      for (const index of indices.matchAll(/\[(\d+)\]/g)) {
        segments.push({ index: Number(index[1]) });
      }
    }
  }
  return segments;
}

/** 1-based line number of a character offset. */
export function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function indentOfLine(source: string, line: number): number {
  const lines = source.split('\n');
  const text = lines[line - 1] ?? '';
  return text.length - text.trimStart().length;
}

function rangeOf(node: unknown): [number, number] | null {
  const range = (node as { range?: [number, number, number] }).range;
  if (!Array.isArray(range)) return null;
  return [range[0], range[1]];
}

/**
 * Resolves a field path against the operator's text.
 *
 * `keepSourceTokens` is not needed — the AST nodes carry `range` offsets, which is all the
 * caller needs to place a squiggle and a gutter marker.
 */
export function anchorFieldPath(source: string, path: string): Anchor {
  const doc = parseDocument(source, { keepSourceTokens: false });

  // Requirement 75.2 / edge case 14. This case OUTRANKS every server error: the server
  // never evaluated this text, so anchoring its errors would underline tokens that no
  // longer exist. The caller must collapse the panel to this one banner.
  const parseError = doc.errors[0];
  if (parseError) {
    const offset = parseError.pos?.[0] ?? 0;
    const line = lineOfOffset(source, offset);
    const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    return {
      kind: 'parse-error',
      line,
      column: offset - lineStart + 1,
      message: parseError.message,
    };
  }

  const segments = parseFieldPath(path);
  const root = doc.contents;
  if (!root) {
    // An empty document. A missing key belongs on line 1 (Requirement 75.1).
    const last = segments[segments.length - 1];
    if (last && 'key' in last) {
      return { kind: 'phantom', line: 1, missingKey: last.key, indent: 0 };
    }
    return { kind: 'unanchored' };
  }

  // The path names the document itself.
  if (segments.length === 0) {
    const range = rangeOf(root);
    if (!range) return { kind: 'unanchored' };
    return {
      kind: 'node',
      line: lineOfOffset(source, range[0]),
      endLine: lineOfOffset(source, range[1]),
      startOffset: range[0],
      endOffset: range[1],
    };
  }

  let current: unknown = root;
  /**
   * The range of the KEY that introduced `current`, e.g. the `sandbox` token in
   * `sandbox:` — NOT the range of the mapping it points at.
   *
   * This distinction is the whole of Requirement 75.1 and it is easy to get wrong. A
   * YAMLMap's own range begins at its FIRST CHILD, so anchoring a missing
   * `sandbox.workspace_required` to the map's range puts the phantom line beside
   * `profile: standard` rather than under `sandbox:`. Both are "inside sandbox" and only
   * one reads as the container's line.
   *
   * Null while `current` is the document root, which is what makes a missing ROOT key
   * anchor to line 1.
   */
  let currentKeyRange: [number, number] | null = null;
  // The outermost flow-style collection seen on the way down. Requirement 75.3 highlights
  // the whole flow node, so the OUTERMOST one is the right target: `{builtin: [shell]}`
  // highlights the mapping, not the inner sequence.
  let outermostFlow: unknown = null;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as PathSegment;

    if (isCollection(current) && (current as { flow?: boolean }).flow === true && outermostFlow === null) {
      outermostFlow = current;
    }

    let next: unknown;
    let nextKeyRange: [number, number] | null = null;
    if ('key' in segment) {
      next = isMap(current) ? current.get(segment.key, true) : undefined;
      if (next !== undefined && isMap(current)) {
        const pair = current.items.find(
          (item) => (item.key as { value?: unknown } | null)?.value === segment.key,
        );
        nextKeyRange = pair ? rangeOf(pair.key) : null;
      }
    } else {
      next = isSeq(current) ? current.get(segment.index, true) : undefined;
      // A sequence entry has no key, so the nearest named ancestor stays the anchor.
      nextKeyRange = currentKeyRange;
    }

    if (next === undefined || next === null) {
      // The path names something absent from the text.
      if ('key' in segment) {
        // Requirement 75.1: anchor to the PARENT CONTAINER's line — the line its own key
        // is on — and at document root anchor to line 1.
        if (currentKeyRange === null) {
          return { kind: 'phantom', line: 1, missingKey: segment.key, indent: 0 };
        }
        const line = lineOfOffset(source, currentKeyRange[0]);
        return {
          kind: 'phantom',
          line,
          missingKey: segment.key,
          indent: indentOfLine(source, line) + 2,
        };
      }
      // A missing SEQUENCE INDEX gets no phantom line: there is no key to insert, and
      // "insert item 3" is not a fix the operator can be offered. Fall back to the
      // container so the error still points somewhere true.
      const containerRange = rangeOf(current);
      if (!containerRange) return { kind: 'unanchored' };
      return {
        kind: 'node',
        line: lineOfOffset(source, containerRange[0]),
        endLine: lineOfOffset(source, containerRange[1]),
        startOffset: containerRange[0],
        endOffset: containerRange[1],
      };
    }

    current = next;
    currentKeyRange = nextKeyRange;
  }

  // Requirement 75.3 — anything inside a flow node highlights the whole flow node.
  const target = outermostFlow ?? current;
  const range = rangeOf(target);
  if (!range) return { kind: 'unanchored' };

  return {
    kind: outermostFlow ? 'flow' : 'node',
    line: lineOfOffset(source, range[0]),
    endLine: lineOfOffset(source, range[1]),
    startOffset: range[0],
    endOffset: range[1],
  };
}

/**
 * Requirement 75.1's click-to-insert. Returns the source with `key: ` inserted at the
 * phantom line's position.
 *
 * Inserted rather than appended: an operator who clicks a phantom line for
 * `sandbox.profile` expects it inside `sandbox:`, and appending to the end of the document
 * would produce a second top-level key with the same name — valid YAML that means
 * something else entirely.
 */
export function insertKeyAt(source: string, anchor: Extract<Anchor, { kind: 'phantom' }>): string {
  const lines = source.split('\n');
  const insertion = `${' '.repeat(anchor.indent)}${anchor.missingKey}: `;
  // After the container's own line, which is where its children begin.
  const at = Math.min(anchor.line, lines.length);
  lines.splice(at, 0, insertion);
  return lines.join('\n');
}

/** Is the document currently parseable? Requirement 75.2's gate for suppressing errors. */
export function yamlParseError(source: string): { line: number; column: number; message: string } | null {
  const anchor = anchorFieldPath(source, '');
  return anchor.kind === 'parse-error'
    ? { line: anchor.line, column: anchor.column, message: anchor.message }
    : null;
}

/** Parses to a plain object for submission. Throws when the document does not parse. */
export function yamlToJson(source: string): unknown {
  const doc = parseDocument(source);
  const first = doc.errors[0];
  if (first) throw new Error(first.message);
  return doc.toJS({ maxAliasCount: 100 }) as unknown;
}

export function jsonToYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}
