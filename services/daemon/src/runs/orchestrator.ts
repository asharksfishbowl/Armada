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
  ModelPriority,
  RetrievalProvider,
  RunContext,
  SandboxProvider,
  ToolProvider,
} from '../kernel/types.js';
import type { AgentStore } from '../agents/store.js';
import type { ResolvedSnapshot } from '../agents/resolver.js';
import { forgeUnreachableError, verifyPinnedBinding, type LiveBinding } from '../models/binding-verifier.js';
import { runAgentLoop, type AgentLoopResult, type RunFinalizer } from '../runtime/agent-loop.js';
import type { Budgets } from '../runtime/budgets.js';
import type { ModelScheduler } from '../models/scheduler.js';
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
  /**
   * R20-R22, Team R31-R34. REQUIRED — omitting it is a compile error in index.ts, which is
   * the only thing that would have caught `ModelScheduler` being written, unit tested and
   * then called by nothing at all through the whole of P7.
   */
  scheduler: ModelScheduler;
  /** Read live so an operator restarting the daemon picks up a changed ceiling. */
  fetchLiveBindings: () => Promise<LiveBinding[]>;
}

export interface StartRunInput {
  agentId: string;
  task: string;
  workspacePath?: string | null;
}

/**
 * One Run's execution, from sandbox acquisition to release — Runtime R45-R48.
 *
 * SHARED BY SOLO RUNS, TEAM RUNS AND CHILD RUNS, which is why it is a parameter object
 * rather than three near-identical private methods. A Team Run differs from a solo Run in
 * four ways and no more: a tool provider that also offers `delegate`, a `manager`
 * scheduling priority, a token callback feeding the tree accountant, and a finalizer that
 * runs synthesis before `run_end`. A child Run differs in three: an overridden budget set
 * (R22), a shared workspace (R21), and the same token callback.
 *
 * Everything else — the sandbox, the loop, the terminal write, the release — is identical,
 * and duplicating it per Run kind is how the two would drift.
 */
export interface ExecuteRunInput {
  runId: string;
  agentVersionId: string;
  snapshot: ResolvedSnapshot;
  systemPrompt: string;
  task: string;
  controller: AbortController;
  /** Team R14 — the manager's `context` argument, as an extra system block. */
  contextBlock?: string;
  /** Team R22 — the merged per-delegation budgets. Defaults to the snapshot's own. */
  budgets?: Budgets;
  /** Team R21 — children bind-mount the Team Run's host path, not a per-Run one. */
  workspacePath?: string | null;
  /** D5 / Team R32. */
  priority?: ModelPriority;
  /** Team R11 — the manager's provider, which also offers delegate and list_workers. */
  tools?: ToolProvider;
  /** Team R25. */
  onModelTokens?: (promptTokens: number, completionTokens: number) => void;
  /** Team R35-R38. */
  finalize?: RunFinalizer;
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

  /**
   * The Kernel's ToolProvider — Team Orchestration R11.
   *
   * Exposed so the Team orchestrator can WRAP it for the manager's Run rather than
   * assembling its own. R15's rule is that the loop imports no concrete implementation, and
   * a Team-aware provider built around this one keeps that true: there is still exactly one
   * place that decides what an ordinary Run may call.
   */
  get toolProvider(): ToolProvider {
    return this.plugins.tools;
  }

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
    void this.executeRun({
      runId: run.run_id,
      agentVersionId: version.agent_version_id,
      snapshot,
      systemPrompt,
      task: input.task,
      controller,
    });

    return { runId: run.run_id };
  }

  /**
   * Run one Run to completion and write its terminal row.
   *
   * PUBLIC because the Team orchestrator drives the manager's Run and every child Run
   * through it. It NEVER throws: invariant 6 says every Run terminates, and this is the
   * only place that can guarantee it for a promise nobody is holding (R2).
   */
  async executeRun(input: ExecuteRunInput): Promise<AgentLoopResult | null> {
    const { runId, snapshot, controller } = input;
    this.active.set(runId, controller);

    const ctx: RunContext = {
      runId,
      agentVersionId: input.agentVersionId,
      mode: snapshot.mode,
      corpusId: snapshot.corpus_id,
    };

    let sandbox: Awaited<ReturnType<SandboxProvider['acquire']>> | null = null;
    try {
      // 4. R45 — one container per Run. Only reached once the binding is known servable.
      //    Team R20 — a worker acquires its OWN sandbox from its OWN Agent's profile; R21
      //    — bind-mounted at the Team Run's shared host path so workers see each other's
      //    writes.
      sandbox = await this.plugins.sandbox.acquire({
        runId,
        profile: snapshot.sandbox.profile,
        workspacePath: snapshot.sandbox.workspace_required
          ? (input.workspacePath ?? `/workspace/${runId}`)
          : null,
      });
      ctx.sandbox = sandbox;

      // 5.
      const result = await runAgentLoop(
        { ...this.plugins, ...(input.tools ? { tools: input.tools } : {}) },
        {
          ctx,
          bindingTag: snapshot.binding_tag,
          systemPrompt: input.systemPrompt,
          userMessage: input.task,
          ...(input.contextBlock ? { contextBlock: input.contextBlock } : {}),
          contextWindow: snapshot.context_window,
          reservedOutputTokens: this.config.reservedOutputTokens,
          budgets: input.budgets ?? snapshot.budgets,
          noProgressThreshold: this.config.noProgressThreshold,
          autoInjectK: snapshot.auto_inject_k,
          maxConcurrentTools: this.config.maxConcurrentTools,
          admitModelRequest: (tag, priority) => this.config.scheduler.acquire(tag, priority),
          priority: input.priority ?? 'default',
          ...(input.onModelTokens ? { onModelTokens: input.onModelTokens } : {}),
          ...(input.finalize ? { finalize: input.finalize } : {}),
          signal: controller.signal,
        },
      );

      await this.runs.terminate(runId, result.outcome, result.result);
      // R3, R57 — the counters the budget was actually enforced against, so
      // GET /api/runs/{id} reports the same numbers `run_end` recorded.
      await this.runs
        .recordCounters(runId, {
          steps: result.counters.stepsUsed,
          modelTokens: result.counters.modelTokensUsed,
          toolCalls: result.counters.toolCallsUsed,
          wallClockMs: result.counters.wallClockMsUsed,
          queuedMs: result.counters.queuedMsTotal,
        })
        .catch(() => undefined);
      return result;
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
      return null;
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
