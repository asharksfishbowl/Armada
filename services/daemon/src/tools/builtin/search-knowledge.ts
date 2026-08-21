/**
 * The built-in `search_knowledge` tool — Agent Runtime R40, R42, R43.
 *
 * Granted to every STANDARD-mode Agent with a bound Corpus, callable on any Step, with `k`
 * capped at `search_max_k`.
 *
 * CODE-MODE AGENTS DO NOT RECEIVE IT (R27a, invariant 3). A Code-mode program executes
 * inside the sandbox and there is no callback channel out, so a `search_knowledge` call
 * from inside one could never reach the daemon. The generated SDK therefore does not
 * declare it, and a program that calls something by that name fails as an undefined
 * reference inside the sandbox rather than hanging on a request nothing will answer
 * (edge 26). Code-mode Agents still receive the AUTO-INJECTED block (R27b) — injection
 * happens daemon-side before the program is generated.
 *
 * An Agent with no bound Corpus gets neither the block nor this tool (R43).
 */

import type { Chunk, RetrievalProvider, ToolResult, ToolSpec } from '../../kernel/types.js';

export const SEARCH_KNOWLEDGE = 'search_knowledge';

export interface SearchKnowledgeOptions {
  /** R40 — hard ceiling on the `k` an Agent may request. */
  searchMaxK: number;
  /** Falls back to this when the model omits `k`. */
  defaultK: number;
}

export function searchKnowledgeSpec(options: SearchKnowledgeOptions): ToolSpec {
  return {
    name: SEARCH_KNOWLEDGE,
    description:
      'Search the bound knowledge corpus for passages relevant to a query. ' +
      'Returns matching passages with the file each came from.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        k: {
          type: 'integer',
          minimum: 1,
          maximum: options.searchMaxK,
          description: `How many passages to return (max ${options.searchMaxK}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

export interface SearchKnowledgeArgs {
  query: string;
  k?: number;
}

/**
 * Validate the model's arguments.
 *
 * Returns an error STRING rather than throwing: R30 requires a tool call that fails schema
 * validation to append an `is_error` tool_result and let the loop CONTINUE. Throwing would
 * terminate a Run over a recoverable mistake the model can correct on the next Step.
 */
export function validateArgs(args: unknown): { ok: true; value: SearchKnowledgeArgs } | { ok: false; error: string } {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'search_knowledge expects an object with a `query` string' };
  }

  const { query, k } = args as { query?: unknown; k?: unknown };

  if (typeof query !== 'string' || !query.trim()) {
    return { ok: false, error: 'search_knowledge requires a non-empty `query` string' };
  }
  if (k !== undefined && (typeof k !== 'number' || !Number.isInteger(k) || k < 1)) {
    return { ok: false, error: '`k` must be a positive integer when provided' };
  }

  return { ok: true, value: k === undefined ? { query } : { query, k } };
}

export interface SearchKnowledgeResult {
  result: ToolResult;
  /** For the caller's `retrieval` Event (R42). Empty when validation failed. */
  chunks: Chunk[];
  effectiveK: number;
}

/**
 * Execute one search_knowledge call.
 *
 * The caller appends the `retrieval` Event (R42) from `chunks` — the tool does not write
 * events itself, because the event log is reached through the Kernel's EventSink and the
 * loop owns Step bookkeeping.
 */
export async function invokeSearchKnowledge(
  retrieval: RetrievalProvider,
  corpusId: string | null | undefined,
  args: unknown,
  options: SearchKnowledgeOptions,
): Promise<SearchKnowledgeResult> {
  // R43 — no Corpus means this tool should not have been in the list at all. Reaching it
  // anyway is an unknown-tool situation, answered as an error result so the loop continues
  // (R29) rather than terminating.
  if (!corpusId) {
    return {
      result: { content: 'This agent has no bound corpus, so search_knowledge is unavailable.', isError: true },
      chunks: [],
      effectiveK: 0,
    };
  }

  const parsed = validateArgs(args);
  if (!parsed.ok) {
    return { result: { content: parsed.error, isError: true }, chunks: [], effectiveK: 0 };
  }

  // R40 — clamp rather than reject. A model asking for 50 gets search_max_k and a usable
  // answer; rejecting would spend a Step teaching it a limit the schema already states.
  const effectiveK = Math.min(parsed.value.k ?? options.defaultK, options.searchMaxK);

  let chunks: Chunk[];
  try {
    chunks = await retrieval.query(corpusId, parsed.value.query, effectiveK);
  } catch (err) {
    // Edge 10 — a retrieval failure is an error RESULT, never a terminated Run. The caller
    // additionally appends an `error` Event.
    return {
      result: {
        content: `Retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      },
      chunks: [],
      effectiveK,
    };
  }

  // Edge 9 — a zero-chunk corpus is not an error. Say so plainly so the model stops
  // searching and proceeds, rather than retrying the same query and tripping the
  // no-progress detector.
  if (chunks.length === 0) {
    return {
      result: { content: 'No matching passages found in the corpus.' },
      chunks: [],
      effectiveK,
    };
  }

  return { result: { content: formatChunks(chunks) }, chunks, effectiveK };
}

/** Each passage carries its source_path so the model can cite it and an operator can check it. */
function formatChunks(chunks: Chunk[]): string {
  return chunks.map((chunk) => `--- ${chunk.sourcePath}\n${chunk.content}`).join('\n\n');
}
