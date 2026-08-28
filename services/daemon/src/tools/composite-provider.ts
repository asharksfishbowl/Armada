/**
 * CompositeToolProvider — Agent Runtime R10, R29, R30, R43, R51.
 *
 * The single ToolProvider the Kernel registers. It merges the tool sources that exist
 * independently — built-ins that run in the sandbox, `search_knowledge` that runs against
 * the retrieval index — behind one interface, so the agent loop asks one thing "what tools
 * does this Run have" and never learns that the answer came from two places.
 *
 * R15 is why this exists rather than the loop calling both directly: the loop may not
 * import a concrete implementation. Every capability arrives through a plugin, and a
 * provider that merges sources is still one provider.
 *
 * THE GRANT LIST COMES FROM THE PINNED SNAPSHOT, NOT FROM CONFIG. Invariant 2 — an Agent
 * version captures a resolved snapshot, and a Run executes that snapshot. Re-deriving the
 * grant list from current config would let a Run gain or lose a tool that its pinned
 * version never had, which is exactly the live-reference behaviour invariant 2 forbids.
 *
 * NOTHING HERE TERMINATES A RUN. An unknown tool (R29), invalid arguments (R30), and a
 * corpus-less `search_knowledge` (R43) all produce an `is_error` result and the loop
 * continues. A model that guesses a tool name should lose a Step, not a trajectory.
 *
 * MCP tools (`{server}__{tool}`, R51) land in P12. Until then a granted MCP name simply is
 * not in the list, and calling one takes the R29 unknown-tool path — which names the tools
 * that ARE available, rather than pretending the call succeeded.
 */

import type {
  RetrievalProvider,
  RunContext,
  ToolProvider,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';
import { builtinSpecsFor, dispatchBuiltin } from './registry.js';
import {
  SEARCH_KNOWLEDGE,
  invokeSearchKnowledge,
  searchKnowledgeSpec,
  type SearchKnowledgeOptions,
} from './builtin/search-knowledge.js';

/**
 * Resolves a Run's pinned grant list and corpus binding.
 *
 * A function rather than a table lookup because the loop and the provider must agree on
 * ONE source for this — the Agent version's `resolved_snapshot` — and a second copy held
 * in the provider would be a second thing to keep in sync.
 */
export type GrantResolver = (ctx: RunContext) => Promise<string[]>;

export interface CompositeToolProviderOptions {
  grantsFor: GrantResolver;
  retrieval: RetrievalProvider;
  searchOptions: SearchKnowledgeOptions;
}

export class CompositeToolProvider implements ToolProvider {
  readonly name = 'CompositeToolProvider';

  constructor(private readonly options: CompositeToolProviderOptions) {}

  async list(ctx: RunContext): Promise<ToolSpec[]> {
    const granted = await this.options.grantsFor(ctx);
    const specs = builtinSpecsFor(granted);

    // R43 — offered ONLY when the Agent both granted it and has a Corpus bound. Offering it
    // without a corpus would invite a call that can only fail, spending a Step to learn
    // something the tool list already knew.
    if (granted.includes(SEARCH_KNOWLEDGE) && ctx.corpusId) {
      specs.push(searchKnowledgeSpec(this.options.searchOptions));
    }

    return specs;
  }

  async invoke(name: string, args: unknown, ctx: RunContext): Promise<ToolResult> {
    const granted = await this.options.grantsFor(ctx);

    if (name === SEARCH_KNOWLEDGE) {
      if (!granted.includes(name)) return unknownTool(name, granted);
      const { result } = await invokeSearchKnowledge(
        this.options.retrieval,
        ctx.corpusId,
        args,
        this.options.searchOptions,
      );
      return result;
    }

    // Built-ins own their own grant check, so it is not repeated here — two copies of the
    // same check drift, and the registry's is the one R29's tests cover.
    return dispatchBuiltin(name, args, granted, ctx);
  }
}

function unknownTool(name: string, granted: string[]): ToolResult {
  return {
    content:
      `unknown tool \`${name}\`; available: ${granted.join(', ') || '(none granted)'}`,
    isError: true,
  };
}
