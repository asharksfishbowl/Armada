/**
 * The `shell` built-in — Agent Runtime R49, edge 5.
 *
 * Runs exclusively inside the sandbox via the Sandbox interface. There is no host
 * execution path in this file and there must never be one: a shell that could reach the
 * host would cross the boundary invariant 3 exists to hold.
 *
 * A non-zero exit is NOT an error result. A command that fails is information the model
 * asked for — `grep` finding nothing exits 1, and reporting that as a tool error would
 * teach the model to distrust its own tools. Only a timeout or a dispatch failure is
 * marked `is_error`.
 */

import type { Sandbox, ToolResult, ToolSpec } from '../../kernel/types.js';
import { asRecord, messageOf, optionalPositiveInt, requireString } from '../args.js';

export const SHELL = 'shell';

export const shellToolSpec: ToolSpec = {
  name: SHELL,
  description:
    'Run a shell command inside the sandboxed workspace. The working directory is ' +
    '/workspace. There is no network access.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run via /bin/sh -c.' },
      timeout_seconds: { type: 'integer', minimum: 1 },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export async function invokeShell(sandbox: Sandbox, args: unknown): Promise<ToolResult> {
  const record = asRecord(args, SHELL);
  if (!record.ok) return { content: record.error, isError: true };

  const command = requireString(record.value, 'command', SHELL);
  if (!command.ok) return { content: command.error, isError: true };

  const timeout = optionalPositiveInt(record.value, 'timeout_seconds', SHELL);
  if (!timeout.ok) return { content: timeout.error, isError: true };

  let result;
  try {
    // exec's second parameter is optional, so undefined takes the profile default.
    result = await sandbox.exec(command.value, timeout.value);
  } catch (err) {
    // Edge 6 — the container died. The loop terminates the Run on this; the daemon does
    // NOT silently start a replacement container.
    return {
      content: `shell dispatch failed: ${messageOf(err)}`,
      isError: true,
    };
  }

  // Edge 5 — killed at the profile timeout. Reported and the loop CONTINUES.
  if (result.timedOut) {
    return {
      content: `command timed out\n${formatStreams(result.stdout, result.stderr)}`,
      isError: true,
      timedOut: true,
    };
  }

  // A non-zero exit is reported as ordinary output with its code, not as a tool error.
  return { content: formatStreams(result.stdout, result.stderr, result.exitCode) };
}

function formatStreams(stdout: string, stderr: string, exitCode?: number): string {
  const parts: string[] = [];
  if (exitCode !== undefined && exitCode !== 0) parts.push(`exit code ${exitCode}`);
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.join('\n') || '(no output)';
}
