/**
 * Field-path anchoring — design-dashboard.md Requirements 73-75, edge cases 13 and 14.
 *
 * Every case here is one where the WRONG answer renders plausibly. A missing key anchored
 * to line 1 instead of to its parent container looks like a working editor; a stale server
 * error underlined against text the server never saw looks like a working editor. Neither
 * is visible in a screenshot, so both are asserted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorFieldPath,
  insertKeyAt,
  jsonToYaml,
  parseFieldPath,
  yamlParseError,
  yamlToJson,
} from '../lib/yaml-anchor';

const AGENT = [
  'schema_version: 1',
  'name: docs-helper',
  'persona:',
  '  system_prompt: You help.',
  'model:',
  '  base_model_id: qwen3-0.6b',
  'sandbox:',
  '  profile: standard',
  'tools:',
  '  builtin:',
  '    - shell',
  '    - read_file',
  '',
].join('\n');

test('parseFieldPath handles the daemon’s two path forms', () => {
  assert.deepEqual(parseFieldPath('sandbox.profile'), [{ key: 'sandbox' }, { key: 'profile' }]);
  assert.deepEqual(parseFieldPath('tools.builtin[0]'), [
    { key: 'tools' },
    { key: 'builtin' },
    { index: 0 },
  ]);
  assert.deepEqual(parseFieldPath('runtime.budgets.max_steps'), [
    { key: 'runtime' },
    { key: 'budgets' },
    { key: 'max_steps' },
  ]);
  // The daemon emits an empty path for "an Agent definition must be a mapping".
  assert.deepEqual(parseFieldPath(''), []);
});

test('a path present in the text anchors to its own token (Requirement 74)', () => {
  const anchor = anchorFieldPath(AGENT, 'sandbox.profile');
  assert.equal(anchor.kind, 'node');
  if (anchor.kind !== 'node') return;
  // `profile: standard` is line 8.
  assert.equal(anchor.line, 8);
  assert.equal(AGENT.slice(anchor.startOffset, anchor.endOffset), 'standard');
});

test('a sequence entry anchors to the entry, not the sequence', () => {
  const anchor = anchorFieldPath(AGENT, 'tools.builtin[1]');
  assert.equal(anchor.kind, 'node');
  if (anchor.kind !== 'node') return;
  assert.equal(AGENT.slice(anchor.startOffset, anchor.endOffset), 'read_file');
});

test('a missing key anchors to its PARENT container, not to line 1 (Requirement 75.1)', () => {
  // `sandbox:` exists but has no `workspace_required`. The phantom line belongs inside
  // sandbox — anchoring it to the document root would put the fix in the wrong place and
  // clicking it would produce a second top-level key.
  const anchor = anchorFieldPath(AGENT, 'sandbox.workspace_required');
  assert.equal(anchor.kind, 'phantom');
  if (anchor.kind !== 'phantom') return;
  assert.equal(anchor.missingKey, 'workspace_required');
  assert.equal(anchor.line, 7, 'should anchor to the `sandbox:` line');
  assert.ok(anchor.indent > 0, 'a nested key is indented under its parent');
});

test('a missing ROOT key anchors to line 1 (Requirement 75.1, acceptance criterion)', () => {
  // "Submitting a definition missing `schema_version` renders a click-to-insert phantom
  // line at line 1."
  const withoutSchema = AGENT.split('\n').slice(1).join('\n');
  const anchor = anchorFieldPath(withoutSchema, 'schema_version');
  assert.equal(anchor.kind, 'phantom');
  if (anchor.kind !== 'phantom') return;
  assert.equal(anchor.line, 1);
  assert.equal(anchor.indent, 0);
});

test('clicking a phantom line inserts the key inside its container (edge case 13)', () => {
  const anchor = anchorFieldPath(AGENT, 'sandbox.workspace_required');
  assert.equal(anchor.kind, 'phantom');
  if (anchor.kind !== 'phantom') return;

  const updated = insertKeyAt(AGENT, anchor);
  const lines = updated.split('\n');
  // Inserted directly after `sandbox:`, indented under it.
  assert.equal(lines[6], 'sandbox:');
  assert.match(lines[7] ?? '', /^\s+workspace_required: $/);

  // And it must actually be a child of sandbox, not a new root key. This is the assertion
  // that would have caught an append-to-end implementation.
  const parsed = yamlToJson(`${updated}placeholder`.replace(/placeholder$/, '')) as Record<
    string,
    Record<string, unknown>
  >;
  assert.ok('workspace_required' in (parsed.sandbox ?? {}));
});

test('a path inside a FLOW node highlights the whole node (Requirement 75.3)', () => {
  // Sub-token precision is not recoverable in flow style, and a wider highlight is
  // preferable to a falsely precise one.
  const flow = ['schema_version: 1', 'tools: {builtin: [shell], denied: [finish]}', ''].join('\n');
  const anchor = anchorFieldPath(flow, 'tools.builtin[0]');
  assert.equal(anchor.kind, 'flow');
  if (anchor.kind !== 'flow') return;
  assert.equal(flow.slice(anchor.startOffset, anchor.endOffset), '{builtin: [shell], denied: [finish]}');
});

test('unparseable YAML returns the parser’s own line and column (Requirement 75.2)', () => {
  // The server never received this text, so every server-side error against it is stale.
  // The caller suppresses them all and shows only this.
  const broken = ['schema_version: 1', 'tools: {builtin: [shell', ''].join('\n');
  const anchor = anchorFieldPath(broken, 'sandbox.profile');
  assert.equal(anchor.kind, 'parse-error');
  if (anchor.kind !== 'parse-error') return;
  assert.ok(anchor.line >= 1);
  assert.ok(anchor.column >= 1);
  assert.ok(anchor.message.length > 0);

  // The same fact reached through the gate the editor actually calls.
  assert.notEqual(yamlParseError(broken), null);
  assert.equal(yamlParseError(AGENT), null);
});

test('a parse error outranks every field path, whatever the path names', () => {
  // Requirement 75.2 is a precedence rule, not a fallback. Even a path that WOULD resolve
  // in a valid document must not anchor while the document does not parse.
  const broken = 'tools: {builtin: [shell';
  for (const path of ['', 'tools', 'tools.builtin[0]', 'nonexistent.key']) {
    assert.equal(anchorFieldPath(broken, path).kind, 'parse-error', `path ${JSON.stringify(path)}`);
  }
});

test('a path naming nothing in a valid document still anchors somewhere true', () => {
  // `runtime` is absent entirely. The error must not vanish — an unanchored error is an
  // error the operator cannot find.
  const anchor = anchorFieldPath(AGENT, 'runtime.mode');
  assert.equal(anchor.kind, 'phantom');
  if (anchor.kind !== 'phantom') return;
  assert.equal(anchor.missingKey, 'runtime');
  assert.equal(anchor.line, 1, 'a missing ROOT container anchors to line 1');
});

test('yaml round-trips through the editor’s own conversions', () => {
  const value = { schema_version: 1, name: 'x', tools: { builtin: ['shell'] } };
  assert.deepEqual(yamlToJson(jsonToYaml(value)), value);
});

test('yamlToJson refuses to return a value for a document that does not parse', () => {
  // Submitting a half-parsed object would send the server something the operator never
  // wrote. Throwing is the only correct outcome.
  assert.throws(() => yamlToJson('tools: {builtin: [shell'));
});
