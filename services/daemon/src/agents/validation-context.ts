/**
 * Builds the ValidationContext every Agent write needs — Agent Definition R12, R27-R30.
 *
 * Validation resolves an Agent's references against LIVE state: does `model.binding` name
 * a promoted ModelBinding, does `corpus.name` name a Corpus that exists. Both live in
 * forge, per cross-service boundary 2 (forge registers bindings, the daemon only consumes
 * them by tag) and boundary 1 (forge owns the corpus index). The daemon holds neither, so
 * every write fans out to forge first.
 *
 * FORGE UNREACHABLE IS NOT A VALIDATION FAILURE. It throws UpstreamUnavailable, which the
 * route turns into 503 and persists nothing (edge 16). Returning empty lists instead would
 * be far worse than a 5xx: every binding and corpus reference would resolve to "does not
 * exist", so a perfectly good definition would be rejected with a confident, specific, and
 * completely wrong list of errors naming references that are fine. A peer being down must
 * never read as the operator's definition being wrong.
 *
 * The config-derived fields are read once at startup and closed over. They come from files
 * that only change on restart, and re-reading them per request would let a Run validate
 * against a config the running daemon is not actually enforcing.
 */

import type { ContextProvider } from '../gateway/routes/agents.js';
import { UpstreamUnavailable } from '../gateway/routes/agents.js';
import type {
  CorpusSummary,
  ModelBinding,
  ValidationContext,
} from './validator.js';
import { BUDGET_KEYS, type BudgetKey } from './definition-schema.js';

/**
 * Below this context window, Code mode has no room to work — the generated program, its
 * output, and the conversation cannot coexist. Agent Definition rejects `mode: code` on a
 * smaller binding rather than letting the Run discover it mid-Step.
 */
export const DEFAULT_CODE_MODE_MIN_CONTEXT = 16384;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ContextProviderOptions {
  forgeUrl: string;
  /** Parsed `runtime.yaml`. */
  runtimeConfig: Record<string, unknown>;
  /** Already validated by `validateProfiles` at startup — names are what validation needs. */
  sandboxProfiles: Record<string, Record<string, unknown>>;
  /** Server NAMES from `mcp-servers.yaml`. Never credentials — those are env var names. */
  mcpServers: string[];
  timeoutMs?: number;
  /** Injectable so tests need no network. */
  fetchImpl?: typeof fetch;
}

function numbersFor(
  source: Record<string, unknown> | undefined,
  fallback: Record<BudgetKey, number>,
): Record<BudgetKey, number> {
  const out = {} as Record<BudgetKey, number>;
  for (const key of BUDGET_KEYS) {
    const raw = source?.[key];
    out[key] = typeof raw === 'number' ? raw : fallback[key];
  }
  return out;
}

/**
 * The values in `config/runtime.yaml` as shipped.
 *
 * Present so a config missing a key fails closed at a documented number rather than
 * `undefined` — which would compare false against every budget and silently disable the
 * ceiling that R31a exists to enforce.
 */
const SHIPPED_CEILINGS: Record<BudgetKey, number> = {
  max_steps: 200,
  max_model_tokens: 2_000_000,
  max_wall_clock_seconds: 14_400,
  max_tool_calls: 600,
};

const SHIPPED_DEFAULTS: Record<BudgetKey, number> = {
  max_steps: 40,
  max_model_tokens: 200_000,
  max_wall_clock_seconds: 1_800,
  max_tool_calls: 120,
};

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new UpstreamUnavailable('forge', `GET ${url} returned ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof UpstreamUnavailable) throw err;
    // AbortError, ECONNREFUSED, DNS failure, malformed JSON — all the same fact to a
    // caller: forge could not answer, so nothing can be validated against it.
    throw new UpstreamUnavailable('forge', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export function createContextProvider(options: ContextProviderOptions): ContextProvider {
  const {
    forgeUrl,
    runtimeConfig,
    sandboxProfiles,
    mcpServers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const context = (runtimeConfig['context'] ?? {}) as Record<string, unknown>;
  const retrieval = (runtimeConfig['retrieval'] ?? {}) as Record<string, unknown>;

  const budgetCeilings = numbersFor(
    runtimeConfig['budget_ceilings'] as Record<string, unknown> | undefined,
    SHIPPED_CEILINGS,
  );
  const budgetDefaults = numbersFor(
    runtimeConfig['budgets'] as Record<string, unknown> | undefined,
    SHIPPED_DEFAULTS,
  );

  const reservedOutputTokens =
    typeof context['reserved_output_tokens'] === 'number' ? context['reserved_output_tokens'] : 2048;
  const autoInjectK =
    typeof retrieval['auto_inject_k'] === 'number' ? retrieval['auto_inject_k'] : 4;
  const codeModeMinContext =
    typeof context['code_mode_min_context'] === 'number'
      ? context['code_mode_min_context']
      : DEFAULT_CODE_MODE_MIN_CONTEXT;

  return async function getContext(): Promise<ValidationContext> {
    // Concurrently — they are independent, and a write already costs one round trip too
    // many to make it two sequential ones.
    const [bindings, corpora] = await Promise.all([
      getJson(fetchImpl, `${forgeUrl}/models/bindings`, timeoutMs) as Promise<ModelBinding[]>,
      getJson(fetchImpl, `${forgeUrl}/corpora`, timeoutMs) as Promise<CorpusSummary[]>,
    ]);

    return {
      bindings,
      corpora,
      sandboxProfiles,
      mcpServers,
      budgetCeilings,
      budgetDefaults,
      codeModeMinContext,
      reservedOutputTokens,
      autoInjectK,
    };
  };
}
