/**
 * Reading a Code-mode program's result — Agent Runtime R27c; edges 22, 23, 24.
 *
 * THE DAEMON NEVER INFERS A RESULT FROM STDOUT (edge 24). A program's stdout is whatever
 * it chose to print; the result file is a structured statement of what it did. Treating
 * printed text as an outcome would let a program that crashed mid-way look successful
 * because it happened to log something hopeful before dying.
 *
 * THIS IS WHERE THE PHASE'S EXIT CRITERION LIVES: a program that calls `finish` and then
 * crashes before its result is written does not terminate the Run. `finish` inside the
 * SDK only sets a field; the outcome is applied here, and only from a file that was
 * actually read and parsed. No file, no finish.
 */

export interface CodeModeCall {
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
}

export interface CodeModeResult {
  calls: CodeModeCall[];
  finish?: { summary: string; success: boolean };
  /** Set by the SDK's uncaughtException handler. */
  error?: string;
}

export interface ParsedProgramOutcome {
  /** What the Step reports back to the loop as its tool result. */
  content: string;
  isError: boolean;
  /** Applied ONLY when a well-formed finish was read from the file. */
  finish?: { summary: string; success: boolean };
  callCount: number;
}

/**
 * Interpret what a finished program left behind.
 *
 * `raw` is the file contents, or null when the file is absent — which is a normal
 * outcome, not an exception. A killed program, a program that exits before its handler
 * runs, and a read-only mount all produce it.
 */
export function parseProgramResult(raw: string | null, resultPath: string): ParsedProgramOutcome {
  // Edge 24 — no file. NAMED, so an operator sees which path was expected rather than a
  // generic failure. The Run continues.
  if (raw === null) {
    return {
      content:
        `the program exited without writing its result to ${resultPath}. ` +
        'No outcome was recorded — a program that called `finish` and then crashed has ' +
        'not finished. Write the result file before exiting.',
      isError: true,
      callCount: 0,
    };
  }

  let parsed: CodeModeResult;
  try {
    parsed = JSON.parse(raw) as CodeModeResult;
  } catch (err) {
    return {
      content:
        `the result file at ${resultPath} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      isError: true,
      callCount: 0,
    };
  }

  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];

  // Edge 22 — the program threw. Its error is the Step's result and the loop CONTINUES; a
  // program that fails should cost a Step, not a trajectory.
  if (typeof parsed.error === 'string' && parsed.error !== '') {
    return {
      content: `the program threw: ${parsed.error}`,
      isError: true,
      callCount: calls.length,
    };
  }

  // A finish is applied only if BOTH fields are the right type. Coercion here would let
  // `success: "false"` — a truthy string — record a successful Run, and invariant 1 says
  // success is reachable only through an explicit affirmative self-report.
  const finish =
    parsed.finish &&
    typeof parsed.finish.summary === 'string' &&
    typeof parsed.finish.success === 'boolean'
      ? parsed.finish
      : undefined;

  // Edge 23 — no SDK calls at all. Still a Step, still counts, loop continues. Not an
  // error: a program may legitimately reason and then finish without touching a tool.
  const summary =
    calls.length === 0
      ? 'the program made no SDK calls'
      : calls.map((c) => renderCall(c)).join('\n');

  return {
    content: finish ? `${summary}\n\nfinish: ${finish.summary}` : summary,
    isError: false,
    ...(finish ? { finish } : {}),
    callCount: calls.length,
  };
}

function renderCall(call: CodeModeCall): string {
  if (call.error !== undefined) return `${call.name}: ERROR ${call.error}`;
  return `${call.name}: ${truncate(JSON.stringify(call.result ?? null))}`;
}

/** Long results are spilled by the caller (R38); this only keeps one line readable. */
function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} bytes)`;
}
