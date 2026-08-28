/**
 * Team Run lifecycle — Team Orchestration R19-R28, R30, R35-R38, R40, R42; edges 6-8, 11, 20.
 *
 * ── A TEAM RUN *IS* THE MANAGER'S RUN ───────────────────────────────────────
 * One `runs` row, `is_team_run: true`, `agent_version_id` pointing at the manager's pinned
 * version and `team_version_id` at the Team's. Not two rows.
 *
 * Everything in the spec reads that way and could not read otherwise: R19 makes the Team
 * Run's `run_id` the parent of every child, R42 appends `delegation` Events to the Team
 * Run, R43 says subscribing to a Team Run streams "the Team Run's own Events" (which are
 * the manager's), R37 makes the synthesis result the Team Run's `result`, and R38 decides
 * the Team Run's outcome from what the MANAGER self-reported. A separate manager Run would
 * split each of those across two streams for no gain.
 *
 * ── THE ORDER AT TERMINATION IS THE PHASE'S EXIT CRITERION ──────────────────
 *   1. a tree budget trips, or the operator cancels, or R30 fires
 *   2. every in-flight child is aborted and AWAITED — each child's `run_end` lands here
 *   3. synthesis runs, or is skipped because the tree budget is already gone (R36)
 *   4. the Team Run's `run_end` is appended
 *
 * Steps 2 and 4 are the exit criterion, and they hold BY CONSTRUCTION rather than by
 * sequencing luck: the cascade and the synthesis both live inside the loop's finalizer,
 * which by contract runs before `run_end` is appended. There is no path that appends the
 * Team Run's `run_end` first, because this file cannot append it at all.
 */

import type {
  EventSink,
  ModelAdapter,
  ModelAdmission,
  ModelPriority,
  RunOutcome,
} from '../kernel/types.js';
import type { AgentStore } from '../agents/store.js';
import type { ResolvedSnapshot } from '../agents/resolver.js';
import type { RunStore } from '../runs/store.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import type { RunFinalization } from '../runtime/agent-loop.js';
import {
  forgeUnreachableError,
  verifyPinnedBinding,
  type LiveBinding,
} from '../models/binding-verifier.js';
import { TeamStore } from './store.js';
import { TeamToolProvider, type DelegationOutcome, type DelegationRequest } from './delegate-tool.js';
import { TreeAccountant } from './tree-budget.js';
import { runSynthesis, skippedSynthesis, type DigestEntry } from './synthesis.js';
import type { ResolvedRoster } from './validator.js';

export class TeamRunStartError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface TeamOrchestratorPlugins {
  model: ModelAdapter;
  events: EventSink;
}

export interface TeamOrchestratorConfig {
  reservedOutputTokens: number;
  /** R30 — reused from `no_progress_threshold` so a Team behaves like every other Run. */
  noProgressThreshold: number;
  fetchLiveBindings: () => Promise<LiveBinding[]>;
  admitModelRequest: (tag: string, priority: ModelPriority) => Promise<ModelAdmission>;
}

export interface StartTeamRunInput {
  teamId: string;
  task: string;
  workspacePath?: string | null;
}

export class TeamOrchestrator {
  constructor(
    private readonly plugins: TeamOrchestratorPlugins,
    private readonly teams: TeamStore,
    private readonly agents: AgentStore,
    private readonly runs: RunStore,
    private readonly runOrchestrator: RunOrchestrator,
    private readonly config: TeamOrchestratorConfig,
  ) {}

  /**
   * R40 — start a Team Run and return its `run_id` before it completes.
   *
   * The pre-flight order mirrors the solo path's and for the same reason: everything that
   * can fail without a Run row or a container fails FIRST, so the caller gets a 4xx naming
   * the problem rather than a Run that must be inspected to learn it never had a chance.
   */
  async start(input: StartTeamRunInput): Promise<{ runId: string }> {
    const team = await this.teams.getById(input.teamId);
    if (!team || team.deleted_at) {
      throw new TeamRunStartError(404, 'team_not_found', `no Team with team_id \`${input.teamId}\``);
    }
    const version = await this.teams.getVersion(input.teamId);
    if (!version) {
      throw new TeamRunStartError(404, 'team_not_found', `Team \`${team.name}\` has no current version`);
    }

    // Invariant 2 — the roster is FIXED at Run start from the Team's pinned version
    // (non-goal 3). Nothing below re-resolves an Agent by name.
    const roster = version.resolved_roster as unknown as ResolvedRoster;
    const workspacePath = input.workspacePath ?? null;

    // Edge 11 — a member Agent deleted since the save. Caught here, BEFORE any sandbox is
    // created, naming the member; the Team record itself survives and `GET /api/teams`
    // flags it `worker_missing`.
    const missing: string[] = [];
    for (const member of [roster.manager, ...roster.workers]) {
      const agent = await this.agents.getById(member.agent_id);
      if (!agent || agent.deleted_at) missing.push(member.agent_name);
    }
    if (missing.length > 0) {
      throw new TeamRunStartError(
        422,
        'roster_member_missing',
        `Team \`${team.name}\` cannot start: member Agent(s) ${missing.join(', ')} have been deleted`,
      );
    }

    // Edge 20 — a roster member that needs a workspace and a Team Run that has none. The
    // member is named, because "workspace_path is required" alone leaves an operator to
    // work out which of six Agents wanted it.
    if (!workspacePath) {
      const needs = [roster.manager, ...roster.workers].filter((m) => m.workspace_required);
      if (needs.length > 0) {
        throw new TeamRunStartError(
          400,
          'workspace_required',
          `\`workspace_path\` is required: ${needs.map((m) => m.agent_name).join(', ')} ` +
            'declare `sandbox.workspace_required: true`',
        );
      }
    }

    const managerVersion = await this.agents.getVersionById(roster.manager.agent_version_id);
    if (!managerVersion) {
      throw new TeamRunStartError(
        422,
        'roster_member_missing',
        `the pinned version of manager \`${roster.manager.agent_name}\` no longer exists`,
      );
    }
    const managerSnapshot = managerVersion.resolved_snapshot as unknown as ResolvedSnapshot;

    // R17/R18b — the manager's binding is verified BEFORE anything is provisioned, exactly
    // as a solo Run's is. Workers are verified at delegation time instead, because R16
    // makes a failed delegation an error result rather than the end of the Team Run.
    let live: LiveBinding[];
    try {
      live = await this.config.fetchLiveBindings();
    } catch (err) {
      throw new TeamRunStartError(
        503,
        'binding_unverified',
        forgeUnreachableError(err instanceof Error ? err.message : String(err)),
      );
    }
    const verdict = verifyPinnedBinding(
      {
        binding_tag: managerSnapshot.binding_tag,
        context_window: managerSnapshot.context_window,
        tool_format: managerSnapshot.tool_format,
      },
      live,
    );
    if (!verdict.ok) {
      throw new TeamRunStartError(422, 'binding_not_servable', verdict.error);
    }

    // Data-flow step 3 — the Team Run's row.
    const run = await this.runs.create({
      agentVersionId: managerVersion.agent_version_id,
      mode: managerSnapshot.mode,
      workspacePath,
      isTeamRun: true,
      teamVersionId: version.team_version_id,
    });

    void this.execute({
      runId: run.run_id,
      roster,
      managerVersionId: managerVersion.agent_version_id,
      managerSnapshot,
      managerSystemPrompt: managerVersion.definition.persona.system_prompt,
      task: input.task,
      workspacePath,
      live,
    });

    return { runId: run.run_id };
  }

  private async execute(params: {
    runId: string;
    roster: ResolvedRoster;
    managerVersionId: string;
    managerSnapshot: ResolvedSnapshot;
    managerSystemPrompt: string;
    task: string;
    workspacePath: string | null;
    live: LiveBinding[];
  }): Promise<void> {
    const { runId, roster } = params;

    // Data-flow step 3 — the tree accountant is initialized with the Team's limits and
    // shared by the manager Run and every child (R25).
    const tree = new TreeAccountant({
      tree_max_wall_clock_seconds: roster.limits.tree_max_wall_clock_seconds,
      tree_max_model_tokens: roster.limits.tree_max_model_tokens,
    });

    const managerController = new AbortController();
    /** R23, R26, edges 6, 7, 16 — every in-flight child, and how to wait for it. */
    const children = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
    const digest: DigestEntry[] = [];
    /** R30 — set when repeated identical delegations terminated the Team Run. */
    let noProgress = false;

    // R26 / edge 6 — the moment a tree budget trips, the manager is aborted. Aborting the
    // MANAGER rather than each child directly is what makes one mechanism cover three
    // causes: the tree budget, R30's detector, and the operator's cancel all reach the
    // children through the same signal, so none of them can forget a child.
    tree.onExhausted(() => managerController.abort());

    const cascade = (): void => managerController.abort();

    const teamTools = new TeamToolProvider({
      base: this.runOrchestrator.toolProvider,
      roster,
      treeCheck: () => tree.check(),
      noProgressThreshold: this.config.noProgressThreshold,
      onNoProgress: () => {
        noProgress = true;
        cascade();
      },
      runDelegation: (request) =>
        this.runDelegation({
          request,
          teamRunId: runId,
          roster,
          tree,
          managerSignal: managerController.signal,
          children,
          digest,
          workspacePath: params.workspacePath,
          live: params.live,
        }),
    });

    await this.runOrchestrator.executeRun({
      runId,
      agentVersionId: params.managerVersionId,
      snapshot: params.managerSnapshot,
      systemPrompt: params.managerSystemPrompt,
      task: params.task,
      controller: managerController,
      workspacePath: params.workspacePath,
      // D5 / R32 — a manager waiting to synthesize is not starved behind queued workers.
      priority: 'manager',
      tools: teamTools,
      onModelTokens: (prompt, completion) => tree.recordModelTokens(prompt, completion),
      finalize: async (resolution): Promise<RunFinalization> => {
        // ── STEP 2 OF THE TERMINATION ORDER ────────────────────────────────
        // R23, edge 7 — every in-flight child's `run_end` lands BEFORE the Team Run's,
        // because this await sits inside the finalizer and the finalizer runs before the
        // loop appends `run_end`. `allSettled`: a child that ended badly must not stop the
        // Team Run from terminating (invariant 6).
        for (const child of children.values()) child.controller.abort();
        await Promise.allSettled([...children.values()].map((c) => c.done));

        const exhausted = tree.exhaustedBudget;
        const counters = tree.snapshot();

        // ── STEP 3: SYNTHESIS (R35, R36) ───────────────────────────────────
        const synthesis = exhausted
          ? skippedSynthesis(digest)
          : await runSynthesis({
              runId,
              model: this.plugins.model,
              events: this.plugins.events,
              bindingTag: params.managerSnapshot.binding_tag,
              systemPrompt: params.managerSystemPrompt,
              synthesisPrompt: roster.synthesis_prompt,
              task: params.task,
              entries: digest,
              contextWindow: params.managerSnapshot.context_window,
              reservedOutputTokens: this.config.reservedOutputTokens,
              admitModelRequest: this.config.admitModelRequest,
              onModelTokens: (prompt, completion) => tree.recordModelTokens(prompt, completion),
              // A fresh signal: the manager's is already aborted on every cancellation
              // path, and R36 makes the tree budget — not the manager's abort — the thing
              // that decides whether synthesis runs.
              signal: new AbortController().signal,
            });

        const runEnd: Record<string, unknown> = {
          is_team_run: true,
          synthesis_skipped: synthesis.skipped,
          delegations: digest.length,
          tree_counters: counters,
          ...(exhausted ? { tree_budget_hit: exhausted } : {}),
        };

        // ── STEP 4's PAYLOAD: THE OUTCOME (R26, R38, edge 17) ───────────────
        // Every branch here DEMOTES. `success` survives only when the manager self-reported
        // it and synthesis completed, which is R38 stated exactly — and invariant 1 makes
        // it impossible to reach any other way, because a finalizer cannot award it.
        return {
          result: synthesis.result,
          runEnd,
          ...(exhausted
            ? { demoteTo: 'budget_exhausted' as const }
            : noProgress
              ? { demoteTo: 'no_progress' as const }
              : synthesis.error !== undefined
                ? { demoteTo: 'failed' as const }
                : resolution.outcome === 'success'
                  ? {}
                  : { demoteTo: resolution.outcome as Exclude<RunOutcome, 'success'> }),
        };
      },
    });
  }

  /**
   * One delegation — R14, R15, R19, R20-R22, R42; edge 8.
   *
   * Returns only after the child reaches a terminal outcome (R15), because the manager's
   * next Step has to be able to reason about the result. That is why `max_concurrent_delegations`
   * exists at all: without it, "wait for the child" would serialize a Team completely.
   */
  private async runDelegation(params: {
    request: DelegationRequest;
    teamRunId: string;
    roster: ResolvedRoster;
    tree: TreeAccountant;
    managerSignal: AbortSignal;
    children: Map<string, { controller: AbortController; done: Promise<unknown> }>;
    digest: DigestEntry[];
    workspacePath: string | null;
    live: LiveBinding[];
  }): Promise<DelegationOutcome> {
    const { request, teamRunId, tree } = params;
    const member = request.member;

    const version = await this.agents.getVersionById(member.agent_version_id);
    if (!version) {
      return failedDelegation(
        `the pinned version of worker \`${member.agent_name}\` no longer exists`,
      );
    }
    const snapshot = version.resolved_snapshot as unknown as ResolvedSnapshot;

    // R16 — an unservable worker binding is a FAILED DELEGATION, not a failed Team Run. The
    // manager may delegate the same subtask to a different worker.
    const verdict = verifyPinnedBinding(
      {
        binding_tag: snapshot.binding_tag,
        context_window: snapshot.context_window,
        tool_format: snapshot.tool_format,
      },
      params.live,
    );
    if (!verdict.ok) {
      return failedDelegation(verdict.error);
    }

    // R19 — parent_run_id and delegation_id, both written at creation and never updated.
    const child = await this.runs.create({
      agentVersionId: member.agent_version_id,
      mode: snapshot.mode,
      // R21 — the SAME host path as the Team Run, so workers see each other's writes. The
      // manager is responsible for sequencing conflicting work (edge 9).
      workspacePath: params.workspacePath,
      parentRunId: teamRunId,
      delegationId: request.delegationId,
    });

    // R42 — the first `delegation` Event, on the TEAM Run. R43 — a client following the
    // Team Run gets this and no child Events; it subscribes to `child_run_id` to follow the
    // child's own ordered stream.
    await this.plugins.events.append({
      runId: teamRunId,
      type: 'delegation',
      payload: {
        delegation_id: request.delegationId,
        alias: member.alias,
        child_run_id: child.run_id,
        agent_version_id: member.agent_version_id,
        task: request.task,
      },
    });

    const controller = new AbortController();
    // R23, edge 7 — one signal, three causes. The manager's abort reaches every child
    // through this listener, so an operator cancel, a tree budget and R30 all cascade
    // identically and none of them has to enumerate the children itself.
    if (params.managerSignal.aborted) controller.abort();
    else params.managerSignal.addEventListener('abort', () => controller.abort(), { once: true });

    const done = this.runOrchestrator.executeRun({
      runId: child.run_id,
      agentVersionId: member.agent_version_id,
      snapshot,
      systemPrompt: version.definition.persona.system_prompt,
      task: request.task,
      ...(request.context !== undefined ? { contextBlock: request.context } : {}),
      controller,
      // R22 — per_delegation_budgets over the worker's own over config defaults, merged
      // when the roster was pinned.
      budgets: member.budgets,
      workspacePath: params.workspacePath,
      // R31, R32 — the same scheduler, at WORKER priority.
      priority: 'default',
      // R25 — reported as it accrues, so the tree notices before the child terminates.
      onModelTokens: (prompt, completion) => tree.recordModelTokens(prompt, completion),
    });
    params.children.set(child.run_id, { controller, done });

    let outcome: DelegationOutcome;
    try {
      const result = await done;
      outcome = result
        ? {
            childRunId: child.run_id,
            outcome: result.outcome,
            finalMessage: result.result,
            steps: result.steps,
            modelTokens: result.counters.modelTokensUsed,
            ...(result.error ? { error: result.error } : {}),
          }
        : {
            // Edge 8 — executeRun swallowed an infrastructure fault and terminated the row
            // `failed`. NO child Run is left `running`, which is the half of edge 8 that
            // matters; the profile is named so an operator knows where to look.
            childRunId: child.run_id,
            outcome: 'failed',
            finalMessage: '',
            steps: 0,
            modelTokens: 0,
            error: `child Run failed before completion (sandbox profile \`${snapshot.sandbox.profile}\`)`,
          };
    } finally {
      params.children.delete(child.run_id);
    }

    // R42 — the second `delegation` Event, with the outcome and consumption counts.
    await this.plugins.events.append({
      runId: teamRunId,
      type: 'delegation',
      payload: {
        delegation_id: request.delegationId,
        alias: member.alias,
        child_run_id: child.run_id,
        outcome: outcome.outcome,
        steps: outcome.steps,
        model_tokens: outcome.modelTokens,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    });

    // R35 — the digest synthesis reads. Recorded for EVERY delegation including failures,
    // because edge 5 requires synthesis to run over a digest of failures.
    params.digest.push({
      alias: member.alias,
      task: request.task,
      outcome: outcome.outcome,
      final_message: outcome.finalMessage,
      child_run_id: child.run_id,
    });

    return outcome;
  }
}

/** A delegation that never produced a child Run. No `child_run_id`, because there is none. */
function failedDelegation(error: string): DelegationOutcome {
  return {
    childRunId: '',
    outcome: 'failed',
    finalMessage: '',
    steps: 0,
    modelTokens: 0,
    error,
  };
}
