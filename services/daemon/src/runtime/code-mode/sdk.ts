/**
 * Code-mode SDK generation — Agent Runtime R27, R27a, R27c.
 *
 * The daemon writes a TypeScript file into the sandbox declaring the Agent's granted
 * SANDBOX-LOCAL tools, and nothing else. The model returns a program; the program runs
 * entirely inside the container; the daemon reads a result file after the process exits.
 *
 * ── WHY THE SDK IS GENERATED RATHER THAN SHIPPED ─────────────────────────────
 * It declares exactly the tools THIS Agent granted. A fixed SDK would declare tools an
 * Agent was never given, and the model would call them — producing a runtime failure
 * inside the sandbox that the daemon cannot see, instead of a tool that simply does not
 * exist in the type it was handed.
 *
 * ── R27a IS A STRUCTURAL PROPERTY, NOT A CONVENTION ──────────────────────────
 * There is NO callback channel from a sandbox into the daemon (invariant 3). So a
 * generated `search_knowledge` or an MCP tool could not work even if declared — the
 * program has no way to reach the daemon to service it. Excluding them from the SDK is
 * therefore not a policy choice that could be relaxed later; it is the only honest
 * description of what the program can actually do.
 *
 * ── finish() DOES NOT TERMINATE ANYTHING (R27c) ──────────────────────────────
 * It sets a field on the result object. The program writes that object on exit and the
 * daemon applies the outcome only after READING the file. A program that calls finish and
 * then crashes has therefore not finished — which is precisely the exit criterion for this
 * phase, and the reason finish cannot be `process.exit`.
 */

/** R27 — the five tools that exist inside a sandbox. Never MCP, never search_knowledge. */
export const CODE_MODE_TOOLS = ['shell', 'read_file', 'write_file', 'list_dir', 'finish'] as const;

export type CodeModeTool = (typeof CODE_MODE_TOOLS)[number];

/** Where the program writes its result. `{step_id}` keeps concurrent Steps from colliding. */
export const RESULT_DIR = '/armada/code-mode';
export const resultPathFor = (stepId: string): string => `${RESULT_DIR}/${stepId}.json`;
export const SDK_PATH = `${RESULT_DIR}/armada.ts`;
export const PROGRAM_PATH = `${RESULT_DIR}/program.ts`;

const DECLARATIONS: Record<CodeModeTool, string> = {
  shell: `/** Run a shell command inside this sandbox. */
export async function shell(command: string, timeoutSeconds?: number): Promise<ExecResult> {
  return call('shell', { command, timeout_seconds: timeoutSeconds });
}`,
  read_file: `/** Read a file from the sandbox filesystem. */
export async function read_file(path: string): Promise<string> {
  return call('read_file', { path });
}`,
  write_file: `/** Write a file to the sandbox filesystem. */
export async function write_file(path: string, content: string): Promise<void> {
  await call('write_file', { path, content });
}`,
  list_dir: `/** List a directory in the sandbox filesystem. */
export async function list_dir(path: string): Promise<string[]> {
  return call('list_dir', { path });
}`,
  finish: `/**
 * Report the outcome of the task.
 *
 * THIS DOES NOT END THE PROGRAM. It records the outcome on the result object, which is
 * written when the program exits normally. If the program throws after calling this, the
 * result file is still written by the exit handler — but if the process is KILLED, no
 * result is recorded and the Run continues (R27c). Call it and then return.
 */
export function finish(summary: string, success: boolean): void {
  __result.finish = { summary, success };
}`,
};

/**
 * Generate the SDK for one Run.
 *
 * `granted` is the Agent's PINNED tool list (invariant 2). Anything in it that is not
 * sandbox-local is silently absent here and reported separately as a `mode_downgraded`
 * Event (R28a) — the omission is recorded explicitly rather than inferred from absence.
 */
export function generateSdk(granted: string[]): string {
  const available = CODE_MODE_TOOLS.filter((t) => granted.includes(t));

  return `// GENERATED PER RUN by armada-daemon. Do not edit.
//
// Declares exactly the sandbox-local tools this Agent granted: ${available.join(', ') || '(none)'}.
//
// There is no callback channel from this sandbox to the daemon (invariant 3), so tools
// that would need one — search_knowledge, any MCP tool — cannot be offered here and are
// not declared. Their exclusion is recorded as a mode_downgraded Event on the Run.

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface ResultFile {
  calls: { name: string; arguments: unknown; result?: unknown; error?: string }[];
  finish?: { summary: string; success: boolean };
  error?: string;
}

const __result: ResultFile = { calls: [] };

// Each call shells out to the in-sandbox bridge, which the daemon reads from the result
// file after the process exits. Nothing here reaches the daemon while the program runs.
async function call(name: string, args: Record<string, unknown>): Promise<never | any> {
  const entry: { name: string; arguments: unknown; result?: unknown; error?: string } = {
    name,
    arguments: args,
  };
  __result.calls.push(entry);
  const { execFileSync } = await import('node:child_process');
  try {
    const raw = execFileSync('/armada/code-mode/bridge', [name], {
      input: JSON.stringify(args),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    entry.result = JSON.parse(raw);
    return entry.result;
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

${available.map((t) => DECLARATIONS[t]).join('\n\n')}

// R27c — the result is written ON EXIT, not by finish(). A program that calls finish and
// then crashes hard leaves no file, and the daemon treats that as "no result", not as a
// completed Run.
import { writeFileSync } from 'node:fs';
const __write = (): void => {
  try {
    writeFileSync(process.env['ARMADA_RESULT_PATH'] ?? '${RESULT_DIR}/result.json', JSON.stringify(__result));
  } catch {
    // Nothing useful can be done here — the daemon reports the missing file (edge 24).
  }
};
process.on('exit', __write);
process.on('uncaughtException', (err) => {
  __result.error = err instanceof Error ? err.stack ?? err.message : String(err);
  process.exitCode = 1;
});
`;
}
