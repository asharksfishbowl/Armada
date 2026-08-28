/**
 * Code-mode admission and downgrade — Agent Runtime R28, R28a.
 *
 * Two DIFFERENT things share the `mode_downgraded` Event type and must not be conflated:
 *
 *   R28  — the Agent asked for Code mode and CANNOT HAVE IT. The Run starts in Standard
 *          mode. The binding cannot tool-call, or its context window is too small for a
 *          program plus its output plus the conversation.
 *
 *   R28a — the Agent asked for Code mode and GETS IT, but its MCP tools are excluded for
 *          the duration. The mode is not downgraded; the TOOL SET is.
 *
 * They are one Event type because both answer "why does this Run not do what the Agent
 * definition says", which is the question an operator reading the stream is asking. They
 * are separate functions because conflating them would let a Run report a mode downgrade
 * it did not have, or silently drop MCP tools while claiming the mode was intact.
 *
 * BOTH ARE APPENDED AT RUN START, ONCE. Not per Step — the exclusion is a property of the
 * Run, and repeating it every Step would bury the stream in a fact that never changes.
 */

import type { ModelCapabilities, RunMode } from '../../kernel/types.js';

export interface ModeDecision {
  mode: RunMode;
  /** R28 — present only when Code mode was requested and refused. */
  downgradeReason?: string;
  /** R28a — MCP tool names excluded because Code mode is active. Empty when none. */
  excludedMcpTools: string[];
}

/**
 * Decide the mode a Run actually executes in.
 *
 * `requested` comes from the Agent's PINNED snapshot (invariant 2). `capabilities` is what
 * the binding reports now — a liveness fact, not a re-resolution.
 */
export function decideMode(
  requested: RunMode,
  capabilities: Pick<ModelCapabilities, 'toolCalling' | 'contextWindow'>,
  codeModeMinContext: number,
  grantedTools: string[],
): ModeDecision {
  if (requested !== 'code') {
    // Standard mode grants MCP tools normally, so nothing is excluded and no Event is due.
    return { mode: 'standard', excludedMcpTools: [] };
  }

  // R28 — refused. Checked before the MCP exclusion, because a Run that is not in Code
  // mode excludes nothing: reporting both would tell an operator their MCP tools were
  // dropped by a mode the Run never entered.
  if (!capabilities.toolCalling) {
    return {
      mode: 'standard',
      downgradeReason:
        'the pinned ModelBinding reports `toolCalling: false`, and Code mode requires the ' +
        'model to emit a program through a tool call',
      excludedMcpTools: [],
    };
  }

  if (capabilities.contextWindow < codeModeMinContext) {
    return {
      mode: 'standard',
      // Names both numbers. "Context window too small" alone leaves an operator to guess
      // whether to raise the ceiling or pick a different base model.
      downgradeReason:
        `the pinned ModelBinding's context window (${capabilities.contextWindow}) is below ` +
        `code_mode_min_context (${codeModeMinContext}); a Code-mode Step must hold the ` +
        'generated program, its output, and the conversation at once',
      excludedMcpTools: [],
    };
  }

  // R28a — Code mode is ACTIVE. MCP tools are `{server}__{tool}` (R51) and cannot work
  // here: there is no callback channel out of the sandbox (invariant 3, R27a).
  return { mode: 'code', excludedMcpTools: grantedTools.filter(isMcpTool) };
}

/**
 * R51's namespacing is the discriminator.
 *
 * A built-in name never contains `__`, so this cannot misclassify one. Deliberately not a
 * lookup against the configured server list: a tool granted for a server that has since
 * been removed from config is still an MCP tool, and should be REPORTED as excluded
 * rather than silently treated as a built-in that does not exist.
 */
export function isMcpTool(name: string): boolean {
  return name.includes('__');
}
