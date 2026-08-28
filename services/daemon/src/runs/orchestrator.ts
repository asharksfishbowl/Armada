/**
 * Run start and lifecycle — Agent Runtime R2, R4, R17-R18b, R45-R48; build-plan Req 9.
 *
 * Everything between "the dashboard asked for a Run" and "the loop is running", plus the
 * teardown that must happen whichever way it ends.
 *
 * ── THE ORDER OF THE PRE-FLIGHT IS THE DESIGN ────────────────────────────────
 *   1. load the Agent version           — nothing else is knowable without the snapshot
 *   2. VERIFY THE PINNED BINDING        — D4 / R18b, before anything is provisioned
 *   3. create the Run row               — so a failure past here is an observable Run
 *   4. acquire the sandbox              — the first step that creates a container
 *   5. run the loop
 *   6. release the sandbox, always
 *
 * Step 2 sits before step 4 deliberately. A binding that is promoted but unmaterialized
 * would otherwise acquire a container and then block behind a multi-gigabyte download —
 * and an acquired container for a Run that cannot proceed is an orphan waiting to happen.
 * Steps 1 and 2 fail with NO Run row and NO container, so the caller gets a 4xx naming the
 * tag rather than a Run that must be inspected to learn it never had a chance.
 *
 * ── THE CALL RETURNS BEFORE THE RUN COMPLETES (R2) ───────────────────────────
 * `start` awaits only the pre-flight and returns `run_id`. The loop runs detached. That is
 * why every failure AFTER the row exists must terminate the Run rather than reject a
 * promise nobody is holding — an unhandled rejection there would leave a Run `running`
 * forever, which invariant 6 forbids.
 */

import type {
  EventSink,
  ModelAdapter,
  RetrievalProvider,
  RunContext,
  SandboxProvider,
  ToolProvider,
} from '../kernel/types.js';
import type { AgentStore } from '../agents/store.js';
import type { ResolvedSnapshot } from '../agents/resolver.js';
import { forgeUnreachableError, verifyPinnedBinding, type LiveBinding } from '../models/binding-verifier.js';
import { runAgentLoop } from '../runtime/agent-loop.js';
import { RunStore } from './store.js';

export class RunStartError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface OrchestratorPlugins {
  model: ModelAdapter;
  tools: ToolProvider;
  events: EventSink;
  retrieval: RetrievalProvider;
  sandbox: SandboxProvider;
}

export interface OrchestratorConfig {
  reservedOutputTokens: number;
  noProgressThreshold: number;
  maxConcurrentTools: number;
  /** Read live so an operator restarting the daemon picks up a changed ceiling. */
  fetchLiveBindings: () => Promise<LiveBinding[]>;
}

export interface StartRunInput {
  agentId: string;
  task: string;
  workspacePath?: string | null;
}

export class RunOrchestrator {
  /** In-flight controllers, so R4's cancel can abort a model call mid-stream. */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly plugins: OrchestratorPlugins,
    private readonly agents: AgentStore,
    private readonly runs: RunStore,
    private readonly config: OrchestratorConfig,
  ) {}

  async start(input: StartRunInput): Promise<{ runId: string }> {
    // 1. The pinned snapshot. Invariant 2 — a Run executes the version's captured
    //    resolution, never a fresh one.
    const agent = await this.agents.getById(input.agentId);
    if (!agent || agent.deleted_at) {
      throw new RunStartError(404, 'agent_not_found', `no Agent with agent_id \`${input.agentId}\``);
    }
    const version = await this.agents.getVersion(input.agentId);
    if (!version) {
      throw new RunStartError(404, 'agent_not_found', `Agent \`${input.agentId}\` has no current version`);
    }
    const snapshot = version.resolved_snapshot as unknown as ResolvedSnapshot;
    // R5 — the persona lives on the DEFINITION, not the resolved snapshot: the snapshot
    // captures RESOLUTION (which binding, which corpus, which tools), and the persona
    // resolves to nothing. Both are pinned on the same version row, so reading it here is
    // still the pinned value and not a live one.
    const systemPrompt = version.definition.persona.system_prompt;

    // 2. Liveness — BEFORE any provisioning (D4, R18b, build-plan Req 9).
    let live: LiveBinding[];
    try {
      live = await this.config.fetchLiveBindings();
    } catch (err) {
      // R18a — the daemon does NOT proceed on an unverified binding. Starting anyway would
      // burn a sandbox and a model call to discover what one failed HTTP call already said.
      throw new RunStartError(
        503,
        'binding_unverified',
        forgeUnreachableError(err instanceof Error ? err.message : String(err)),
      );
    }

    const verdict = verifyPinnedBinding(
      {
        binding_tag: snapshot.binding_tag,
        context_window: snapshot.context_window,
        tool_format: snapshot.tool_format,
      },
      live,
    );
    if (!verdict.ok) {
      // 422, not 500: the request is well-formed and the daemon is healthy — the Agent's
      // pinned reference is not currently servable, and the message names the tag and the
      // action that fixes it.
      throw new RunStartError(422, 'binding_not_servable', verdict.error);
    }

    // 3. The Run row. Past this point every failure TERMINATES rather than throws.
    const run = await this.runs.create({
      agentVersionId: version.agent_version_id,
      mode: snapshot.mode,
      workspacePath: input.workspacePath ?? null,
    });

    const controller = new AbortController();
    this.active.set(run.run_id, controller);

    // R2 — returns before the Run completes. Deliberately not awaited.
    void this.execute(run.run_id, version.agent_version_id, snapshot, systemPrompt, input.task, controller);

    return { runId: run.run_id };
  }

  private async execute(
    runId: string,
    agentVersionId: string,
    snapshot: ResolvedSnapshot,
    systemPrompt: string,
    task: string,
    controller: AbortController,
  ): Promise<void> {
    const ctx: RunContext = {
      runId,
      agentVersionId,
      mode: snapshot.mode,
      corpusId: snapshot.corpus_id,
    };

    let sandbox: Awaited<ReturnType<SandboxProvider['acquire']>> | null = null;
    try {
      // 4. R45 — one container per Run. Only reached once the binding is known servable.
      sandbox = await this.plugins.sandbox.acquire({
        runId,
        profile: snapshot.sandbox.profile,
        workspacePath: snapshot.sandbox.workspace_required ? `/workspace/${runId}` : null,
      });
      ctx.sandbox = sandbox;

      // 5.
      const result = await runAgentLoop(this.plugins, {
        ctx,
        bindingTag: snapshot.binding_tag,
        systemPrompt,
        userMessage: task,
        contextWindow: snapshot.context_window,
        reservedOutputTokens: this.config.reservedOutputTokens,
        budgets: snapshot.budgets,
        noProgressThreshold: this.config.noProgressThreshold,
        autoInjectK: snapshot.auto_inject_k,
        maxConcurrentTools: this.config.maxConcurrentTools,
        signal: controller.signal,
      });

      await this.runs.terminate(runId, result.outcome, result.result);
    } catch (err) {
      // INVARIANT 6 — every Run terminates. A throw here would otherwise leave the row
      // `running` forever, because nothing is awaiting this promise (R2).
      const message = err instanceof Error ? err.message : String(err);
      await this.runs
        .terminate(runId, 'failed', `run failed before completion: ${message}`)
        .catch(() => {
          // Terminating failed too — the database is unreachable. Nothing further can be
          // recorded, and throwing from a detached promise would take the daemon down.
        });
    } finally {
      this.active.delete(runId);
      if (sandbox) {
        // R48 — release whichever way it ended. Shutdown cleanup is best-effort and the
        // startup sweep is the guarantee, but leaking here would make that sweep the only
        // thing standing between a busy daemon and a host full of containers.
        await this.plugins.sandbox.release(sandbox).catch(() => undefined);
      }
    }
  }

  /**
   * R4 — cancel. Aborts the in-flight model request; the loop observes the signal, appends
   * `run_end`, and the sandbox is released by `execute`'s finally.
   *
   * Edge 16 — an already-terminal Run returns 409 naming the existing outcome and appends
   * NO second `run_end`. That decision is the store's conditional UPDATE, not a read here.
   */
  async cancel(runId: string): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> {
    const run = await this.runs.get(runId);
    if (!run) {
      return { ok: false, status: 404, body: { error: 'not_found', run_id: runId } };
    }
    if (run.status === 'terminal') {
      return {
        ok: false,
        status: 409,
        body: { error: 'already_terminal', run_id: runId, outcome: run.outcome },
      };
    }

    this.active.get(runId)?.abort();

    // A Run with no live controller is one this daemon did not start — it survived a
    // restart with status `running`. Terminating it directly is the only way it can ever
    // reach a terminal state, and invariant 6 says it must.
    if (!this.active.has(runId)) {
      await this.runs.terminate(runId, 'cancelled', 'cancelled; no in-flight execution on this daemon');
    }

    return { ok: true };
  }
}
