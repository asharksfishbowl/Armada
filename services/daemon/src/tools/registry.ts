/**
 * Tool list assembly and dispatch — Agent Runtime R29, R30, R38; edge 27.
 *
 * The registry answers two questions for the loop: what tools does this Run have, and what
 * happens when the model calls one.
 *
 * NEITHER ANSWER EVER TERMINATES A RUN. An unknown tool (R29) and arguments that fail
 * validation (R30) both produce an `is_error` tool_result and the loop continues. A model
 * that guesses a tool name should lose a Step, not a whole trajectory.
 *
 * The granted list comes from the Agent's pinned `resolved_snapshot` (invariant 2) — this
 * module never re-derives it from config.
 */

import type { RunContext, ToolResult, ToolSpec } from '../kernel/types.js';
import type { Sandbox } from '../kernel/types.js';
import { FINISH, finishToolSpec, validateFinish } from './builtin/finish.js';
import { SHELL, invokeShell, shellToolSpec } from './builtin/shell.js';
import {
  LIST_DIR,
  READ_FILE,
  WRITE_FILE,
  fileToolSpecs,
  invokeListDir,
  invokeReadFile,
  invokeWriteFile,
} from './builtin/files.js';

const SPECS_BY_NAME = new Map<string, ToolSpec>(
  [shellToolSpec, finishToolSpec, ...fileToolSpecs].map((spec) => [spec.name, spec]),
);

/**
 * The tools that operate inside the sandbox. Code mode declares exactly these (R27).
 *
 * Derived from the spec table rather than listed again: two hand-maintained lists of the
 * same five names can drift, and a Code-mode SDK declaring a tool the registry cannot
 * dispatch would fail inside the sandbox with no daemon-side trace.
 */
export const SANDBOX_LOCAL_TOOLS: readonly string[] = [...SPECS_BY_NAME.keys()];

/**
 * Build the specs to present to the model, from the pinned granted list.
 *
 * Names the snapshot grants that this registry does not implement — `search_knowledge`,
 * MCP tools — are skipped here and supplied by their own providers. Silently dropping an
 * unknown name would be wrong; it is the composite provider's job to merge them.
 */
export function builtinSpecsFor(grantedTools: string[]): ToolSpec[] {
  return grantedTools
    .map((name) => SPECS_BY_NAME.get(name))
    .filter((spec): spec is ToolSpec => spec !== undefined);
}

export interface SpillOptions {
  /** R38 — a tool result above this is truncated and spilled. */
  maxToolResultTokens: number;
  estimateTokens: (text: string) => number;
  /** The Event id the spill file is named for. */
  eventId: string;
}

/**
 * R29/R30 — dispatch one call.
 *
 * `granted` is the post-`denied` list from the snapshot. A name outside it is an unknown
 * tool even if this registry implements it: an Agent that was not granted `shell` does not
 * get one because the model asked nicely.
 */
export async function dispatchBuiltin(
  name: string,
  args: unknown,
  granted: string[],
  ctx: RunContext,
): Promise<ToolResult> {
  // RunContext already carries the sandbox. Passing it separately as well would let the
  // two disagree about which container a tool runs in.
  const sandbox = ctx.sandbox;
  if (!granted.includes(name)) {
    // R29 — an is_error result, and the loop CONTINUES.
    return {
      content: `unknown tool \`${name}\`; available: ${granted.join(', ')}`,
      isError: true,
    };
  }

  if (name === FINISH) {
    const parsed = validateFinish(args);
    // Edge 20b — a malformed finish does NOT terminate the Turn. The caller checks
    // isError before applying an outcome.
    return parsed.ok
      ? { content: parsed.value.summary }
      : { content: parsed.error, isError: true };
  }

  if (!sandbox) {
    return {
      content: `\`${name}\` needs a sandbox and this Run has none`,
      isError: true,
    };
  }

  switch (name) {
    case SHELL:
      return invokeShell(sandbox, args);
    case READ_FILE:
      return invokeReadFile(sandbox, args);
    case WRITE_FILE:
      return invokeWriteFile(sandbox, args);
    case LIST_DIR:
      return invokeListDir(sandbox, args);
    default:
      return { content: `\`${name}\` is not a built-in tool`, isError: true };
  }
}

/**
 * R38 + edge 27 — truncate an oversize result and spill the full text into the sandbox.
 *
 * The full result goes to /armada/tool-results/{event_id}.txt so the agent can read it in
 * slices, and the truncated result NAMES that path — otherwise the model is told its
 * output was cut with no way to recover the rest.
 *
 * EDGE 27: WHEN THE TMPFS IS FULL, THE SPILL FAILS AND THE RUN CONTINUES. The result is
 * returned truncated with `spillFailed: true`. A full /armada must never terminate a Run —
 * the agent loses access to the overflow, which is a degradation, not a fault.
 */
export async function spillIfOversize(
  result: ToolResult,
  sandbox: Sandbox | undefined,
  options: SpillOptions,
): Promise<ToolResult> {
  const tokens = options.estimateTokens(result.content);
  if (tokens <= options.maxToolResultTokens) return result;

  // Trim using the INJECTED estimator rather than assuming its characters-per-token
  // ratio. A proportional first guess, then shrink until it actually fits — so swapping in
  // a real tokenizer later needs no change here.
  let head = result.content.slice(
    0,
    Math.max(1, Math.floor(result.content.length * (options.maxToolResultTokens / tokens))),
  );
  while (head.length > 1 && options.estimateTokens(head) > options.maxToolResultTokens) {
    head = head.slice(0, Math.floor(head.length * 0.9));
  }

  const path = `/armada/tool-results/${options.eventId}.txt`;

  if (!sandbox) {
    return { ...result, content: head, truncated: true, spillFailed: true };
  }

  try {
    await sandbox.writeFile(path, result.content);
    return {
      ...result,
      content: `${head}\n\n[truncated — full output at ${path}]`,
      truncated: true,
    };
  } catch {
    return {
      ...result,
      content: `${head}\n\n[truncated — the full output could not be written to ${path}]`,
      truncated: true,
      spillFailed: true,
    };
  }
}
