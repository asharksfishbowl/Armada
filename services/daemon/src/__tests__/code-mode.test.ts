/**
 * P13 — Code mode. Agent Runtime R27, R27a-c, R28, R28a, R33a; edges 22, 23, 24.
 *
 * Built around the build plan's P13 EXIT CRITERIA:
 *
 *   a Code-mode Run for an Agent granting MCP servers appends ONE mode_downgraded Event
 *   listing every excluded tool;
 *
 *   a program that calls finish and crashes before writing its result file does NOT
 *   terminate the Run.
 *
 * The second is the load-bearing one. It is the whole reason `finish` in the generated SDK
 * sets a field instead of ending the process: invariant 1 says success is reachable only
 * through an explicit self-report the daemon actually READ, and a program that died before
 * writing has reported nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decideMode, isMcpTool } from '../runtime/code-mode/downgrade.js';
import { parseProgramResult } from '../runtime/code-mode/result.js';
import { generateSdk, CODE_MODE_TOOLS, resultPathFor } from '../runtime/code-mode/sdk.js';

const CAPABLE = { toolCalling: true, contextWindow: 32768 };
const RESULT_PATH = resultPathFor('step-1');

describe('P13 exit criterion 1 — R28a, MCP exclusion is recorded, not inferred', () => {
  test('Code mode stays ACTIVE and lists every excluded MCP tool', () => {
    const decision = decideMode(
      'code',
      CAPABLE,
      16384,
      ['shell', 'finish', 'github__create_issue', 'slack__post_message'],
    );
    assert.equal(decision.mode, 'code', 'the mode is NOT downgraded — only the tool set is');
    assert.equal(decision.downgradeReason, undefined);
    assert.deepEqual(decision.excludedMcpTools, ['github__create_issue', 'slack__post_message']);
  });

  test('no MCP grants means nothing to exclude and nothing to report', () => {
    const decision = decideMode('code', CAPABLE, 16384, ['shell', 'finish']);
    assert.equal(decision.mode, 'code');
    assert.deepEqual(decision.excludedMcpTools, []);
  });

  test('search_knowledge is excluded from the SDK too (R27a)', () => {
    // Not via excludedMcpTools — it is a built-in that simply cannot be declared, because
    // servicing it would need the callback channel invariant 3 forbids.
    const sdk = generateSdk(['shell', 'finish', 'search_knowledge']);
    assert.ok(!sdk.includes('export async function search_knowledge'));
    assert.ok(sdk.includes('export async function shell'));
  });
});

describe('R28 — a REFUSED Code mode is a different fact from an excluded tool', () => {
  test('toolCalling: false downgrades the mode and excludes nothing', () => {
    const decision = decideMode('code', { toolCalling: false, contextWindow: 32768 }, 16384, [
      'github__create_issue',
    ]);
    assert.equal(decision.mode, 'standard');
    assert.match(decision.downgradeReason ?? '', /toolCalling/);
    // A Run not in Code mode excludes nothing. Reporting both would tell an operator their
    // MCP tools were dropped by a mode the Run never entered.
    assert.deepEqual(decision.excludedMcpTools, []);
  });

  test('a context window below the floor names BOTH numbers', () => {
    const decision = decideMode('code', { toolCalling: true, contextWindow: 8192 }, 16384, []);
    assert.equal(decision.mode, 'standard');
    assert.match(decision.downgradeReason ?? '', /8192/);
    assert.match(decision.downgradeReason ?? '', /16384/);
  });

  test('a Standard-mode Agent is never downgraded and never reports exclusions', () => {
    const decision = decideMode('standard', CAPABLE, 16384, ['github__create_issue']);
    assert.equal(decision.mode, 'standard');
    assert.equal(decision.downgradeReason, undefined);
    assert.deepEqual(decision.excludedMcpTools, []);
  });

  test('R51 namespacing is the discriminator, and no built-in is misclassified', () => {
    for (const t of CODE_MODE_TOOLS) assert.equal(isMcpTool(t), false, t);
    assert.equal(isMcpTool('search_knowledge'), false);
    assert.equal(isMcpTool('github__create_issue'), true);
  });
});

describe('P13 exit criterion 2 — finish then crash does NOT terminate the Run', () => {
  test('no result file means no finish, however the program behaved', () => {
    const outcome = parseProgramResult(null, RESULT_PATH);
    // THE criterion. The SDK's finish() only sets a field; the outcome is applied here,
    // and only from a file that was actually read.
    assert.equal(outcome.finish, undefined);
    assert.equal(outcome.isError, true);
    assert.match(outcome.content, /step-1\.json/, 'names the expected path');
  });

  test('a truncated/corrupt result file is an error, never a partial finish', () => {
    const outcome = parseProgramResult('{"calls":[],"finish":{"summ', RESULT_PATH);
    assert.equal(outcome.finish, undefined);
    assert.equal(outcome.isError, true);
  });

  test('a well-formed finish IS applied', () => {
    const raw = JSON.stringify({ calls: [], finish: { summary: 'done', success: true } });
    const outcome = parseProgramResult(raw, RESULT_PATH);
    assert.deepEqual(outcome.finish, { summary: 'done', success: true });
    assert.equal(outcome.isError, false);
  });

  test('`success` is not coerced — a truthy string is NOT a success', () => {
    // Invariant 1: success is reachable only through an explicit affirmative self-report.
    // `"false"` is a truthy string and would otherwise record a successful Run.
    const raw = JSON.stringify({ calls: [], finish: { summary: 'x', success: 'false' } });
    const outcome = parseProgramResult(raw, RESULT_PATH);
    assert.equal(outcome.finish, undefined);
  });

  test('a missing summary is not half-applied', () => {
    const raw = JSON.stringify({ calls: [], finish: { success: true } });
    assert.equal(parseProgramResult(raw, RESULT_PATH).finish, undefined);
  });
});

describe('edges 22 and 23 — a Step is lost, never a trajectory', () => {
  test('edge 22 — a thrown program is an error result and the loop continues', () => {
    const raw = JSON.stringify({ calls: [], error: 'TypeError: x is not a function' });
    const outcome = parseProgramResult(raw, RESULT_PATH);
    assert.equal(outcome.isError, true);
    assert.match(outcome.content, /TypeError/);
    assert.equal(outcome.finish, undefined);
  });

  test('edge 23 — a program with no SDK calls is NOT an error', () => {
    // It still counts toward max_steps. A program may legitimately reason and finish
    // without touching a tool, so flagging it would train the model away from doing so.
    const outcome = parseProgramResult(JSON.stringify({ calls: [] }), RESULT_PATH);
    assert.equal(outcome.isError, false);
    assert.equal(outcome.callCount, 0);
    assert.match(outcome.content, /no SDK calls/);
  });

  test('a failing call inside a successful program is reported per call', () => {
    const raw = JSON.stringify({
      calls: [
        { name: 'shell', arguments: { command: 'ls' }, result: { exitCode: 0 } },
        { name: 'read_file', arguments: { path: '/nope' }, error: 'ENOENT' },
      ],
    });
    const outcome = parseProgramResult(raw, RESULT_PATH);
    assert.equal(outcome.callCount, 2);
    assert.match(outcome.content, /ENOENT/);
  });
});

describe('R27 — the SDK declares granted sandbox-local tools and nothing else', () => {
  test('only granted tools appear', () => {
    const sdk = generateSdk(['shell', 'finish']);
    assert.ok(sdk.includes('export async function shell'));
    assert.ok(sdk.includes('export function finish'));
    assert.ok(!sdk.includes('export async function write_file'));
  });

  test('finish does not exit the process — that is R27c', () => {
    const sdk = generateSdk(['finish']);
    assert.ok(sdk.includes('__result.finish = { summary, success }'));
    assert.ok(!/finish[\s\S]{0,200}process\.exit\(/.test(sdk), 'finish must not call process.exit');
  });

  test('an Agent granting no sandbox-local tools still gets a valid SDK', () => {
    // Degenerate but legal: the program can still reason and write a result file.
    const sdk = generateSdk(['search_knowledge', 'github__create_issue']);
    assert.ok(sdk.includes('interface ResultFile'));
    assert.ok(!sdk.includes('export async function shell'));
  });

  test('the result path is per-Step, so concurrent Steps cannot collide', () => {
    assert.notEqual(resultPathFor('step-1'), resultPathFor('step-2'));
    assert.match(resultPathFor('abc'), /\/armada\/code-mode\/abc\.json$/);
  });
});
