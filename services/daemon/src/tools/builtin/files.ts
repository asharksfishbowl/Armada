/**
 * `read_file`, `write_file`, `list_dir` — Agent Runtime R49.
 *
 * THESE EXECUTE EXCLUSIVELY THROUGH THE Sandbox INTERFACE AND HAVE NO HOST FILESYSTEM
 * PATH. Nothing here imports node:fs. That is not stylistic: an accidental host read would
 * cross the sandbox boundary in the direction invariant 3 forbids, and it would do so
 * silently — the tool would simply return content from the wrong machine.
 *
 * Every failure is an `is_error` RESULT rather than a throw (R30). A missing file is a
 * mistake the model can correct on the next Step; terminating the Run over it would waste
 * the whole trajectory.
 */

import type { Sandbox, ToolResult, ToolSpec } from '../../kernel/types.js';
import { asRecord, messageOf, requireString, requireStringAllowEmpty } from '../args.js';

export const READ_FILE = 'read_file';
export const WRITE_FILE = 'write_file';
export const LIST_DIR = 'list_dir';

export const fileToolSpecs: ToolSpec[] = [
  {
    name: READ_FILE,
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path, absolute or relative to /workspace.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: WRITE_FILE,
    description: 'Write a file in the workspace, creating parent directories as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: LIST_DIR,
    description: 'List the entries of a directory in the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}

/** Every file tool takes a `path`; this is that step, once. */
function pathArg(args: unknown, tool: string): { ok: true; path: string } | { ok: false; result: ToolResult } {
  const record = asRecord(args, tool);
  if (!record.ok) return { ok: false, result: errorResult(record.error) };
  const path = requireString(record.value, 'path', tool);
  if (!path.ok) return { ok: false, result: errorResult(path.error) };
  return { ok: true, path: path.value };
}

export async function invokeReadFile(sandbox: Sandbox, args: unknown): Promise<ToolResult> {
  const parsed = pathArg(args, READ_FILE);
  if (!parsed.ok) return parsed.result;

  try {
    return { content: await sandbox.readFile(parsed.path) };
  } catch (err) {
    return errorResult(`cannot read \`${parsed.path}\`: ${messageOf(err)}`);
  }
}

export async function invokeWriteFile(sandbox: Sandbox, args: unknown): Promise<ToolResult> {
  const parsed = pathArg(args, WRITE_FILE);
  if (!parsed.ok) return parsed.result;

  // An EMPTY string is legitimate — truncating a file is a real operation — so this uses
  // the allow-empty form. Only a missing or non-string value is an error.
  const content = requireStringAllowEmpty(args as Record<string, unknown>, 'content', WRITE_FILE);
  if (!content.ok) return errorResult(content.error);

  try {
    await sandbox.writeFile(parsed.path, content.value);
    return { content: `wrote ${content.value.length} bytes to ${parsed.path}` };
  } catch (err) {
    return errorResult(`cannot write \`${parsed.path}\`: ${messageOf(err)}`);
  }
}

export async function invokeListDir(sandbox: Sandbox, args: unknown): Promise<ToolResult> {
  const parsed = pathArg(args, LIST_DIR);
  if (!parsed.ok) return parsed.result;

  try {
    const entries = await sandbox.listDir(parsed.path);
    return { content: entries.length > 0 ? entries.join('\n') : `(${parsed.path} is empty)` };
  } catch (err) {
    return errorResult(`cannot list \`${parsed.path}\`: ${messageOf(err)}`);
  }
}
