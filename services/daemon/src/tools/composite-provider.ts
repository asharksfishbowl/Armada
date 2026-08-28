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
 * MCP TOOLS (`{server}__{tool}`, R51) ARE THE THIRD SOURCE, AS OF P12. The pinned snapshot
 * grants SERVERS — `{server}__*` — and the session behind `mcp` expands each into the tools
 * that server actually offers. When no MCP source is configured, or a granted server did
 * not connect, the name is absent from the list and calling it takes the R29 unknown-tool
 * path, which names the tools that ARE available rather than pretending the call succeeded.
 */

import type {
  RetrievalProvider,
  RunContext,
  ToolProvider,
  ToolResult,
  ToolSpec,
} from '../kernel/types.js';
import { grantedMcpServers, isNamespacedToolName } from '../mcp/naming.js';
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

/**
 * The MCP half of the tool list — R51, R53. Implemented by `McpSessionManager`.
 *
 * An interface rather than the concrete class so this file stays free of transports, child
 * processes and sockets, and so the merge logic can be tested without any of them.
 *
 * NEITHER METHOD MAY THROW. An unreachable server degrades the tool list (R53) and a failed
 * call is an `is_error` result (edge 17); an exception from either would end the Run, which
 * is the one outcome an MCP fault is never allowed to produce.
 */
export interface McpToolSource {
  list(ctx: RunContext, grantedServers: string[]): Promise<ToolSpec[]>;
  invoke(
    ctx: RunContext,
    name: string,
    args: unknown,
    grantedServers: string[],
  ): Promise<ToolResult>;
}

export interface CompositeToolProviderOptions {
  grantsFor: GrantResolver;
  /**
   * A GETTER, not the provider itself.
   *
   * This provider and the RetrievalProvider are registered by the same `Kernel.register`
   * call, so at the moment this factory runs the Kernel does not exist yet. Taking the
   * resolved value here meant the factory resolved it eagerly and every boot died with
   * "Kernel accessed before registration completed" — the daemon reported it correctly and
   * exited non-zero (R14), and the smoke test caught it, but no unit test did: the suite
   * constructs this class directly and never exercises the factory.
   *
   * A getter moves the lookup to first use, by which point registration has completed or
   * the process has already exited.
   */
  retrieval: () => RetrievalProvider;
  searchOptions: SearchKnowledgeOptions;
  /**
   * Optional because MCP is OPT-IN and ships disabled: `config/mcp-servers.yaml` declares
   * no server, so a default installation needs no credential and makes no egress. Its
   * absence is a working configuration, not a missing dependency — which is why a granted
   * MCP name without it is an unknown tool and not a fault.
   */
  mcp?: McpToolSource;
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

    // R51 — the granted servers' tools, namespaced. `grantedMcpServers` reads `{server}__*`
    // entries out of the PINNED snapshot; it never consults config for which servers a Run
    // may use (invariant 2).
    const servers = grantedMcpServers(granted);
    if (this.options.mcp && servers.length > 0) {
      specs.push(...(await this.options.mcp.list(ctx, servers)));
    }

    return specs;
  }

  async invoke(name: string, args: unknown, ctx: RunContext): Promise<ToolResult> {
    const granted = await this.options.grantsFor(ctx);

    // R51 — only a namespaced name can reach MCP, and no built-in carries the `__`
    // separator, so this branch cannot capture one. A namespaced name that no MCP source
    // can serve falls through to R29 rather than being dispatched as a built-in.
    if (isNamespacedToolName(name)) {
      const servers = grantedMcpServers(granted);
      if (this.options.mcp && servers.length > 0) {
        return this.options.mcp.invoke(ctx, name, args, servers);
      }
      return unknownTool(name, granted);
    }

    if (name === SEARCH_KNOWLEDGE) {
      if (!granted.includes(name)) return unknownTool(name, granted);
      const { result } = await invokeSearchKnowledge(
        this.options.retrieval(),
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
