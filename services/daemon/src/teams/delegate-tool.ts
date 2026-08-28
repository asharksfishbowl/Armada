/**
 * `delegate` and `list_workers` — Team Orchestration R11-R18, R27, R30; edges 2, 3, 15, 16.
 *
 * ── THESE TWO TOOLS EXIST ONLY ON A TEAM RUN, AND ONLY FOR THE MANAGER ──────
 * R11 and R18. That is enforced by CONSTRUCTION rather than by a check: `TeamToolProvider`
 * wraps the ordinary provider and is built once, for the manager's Run, by the Team
 * orchestrator. A child Run is executed with the base provider, so a worker calling
 * `delegate` takes the runtime's ordinary unknown-tool path (R29) — no separate rule, and
 * nothing to forget.
 *
 * A one-level delegation limit falls out of the same fact: a worker has no `delegate`, so
 * it cannot delegate, so there is no depth to bound.
 *
 * ── NOTHING HERE TERMINATES THE TEAM RUN EXCEPT R30 ─────────────────────────
 * An unresolvable worker (edge 2), an ambiguous capability (edge 3), an exhausted
 * `max_delegations` (edge 15), and a child that failed (R16) all produce `is_error` results
 * and the manager's loop continues. The manager is the authority on whether the task was
 * met (R38a), and it cannot exercise that authority if a bad delegation kills the Run.
 *
 * The single exception is R30's repeated-delegation detector, which is a termination
 * condition by requirement.
 */

import type { RunContext, RunOutcome, ToolProvider, ToolResult, ToolSpec } from '../kernel/types.js';
import type { RosterMember, ResolvedRoster } from './validator.js';
import type { TreeCheck } from './tree-budget.js';

export const DELEGATE = 'delegate';
export const LIST_WORKERS = 'list_workers';

/** R14, R15 — one delegation, run to a terminal outcome by the Team orchestrator. */
export interface DelegationRequest {
  member: RosterMember;
  task: string;
  context?: string;
  /** R19 — the `event_id` of the manager's `tool_call` Event. */
  delegationId: string;
}

export interface DelegationOutcome {
  childRunId: string;
  outcome: RunOutcome;
  finalMessage: string;
  steps: number;
  modelTokens: number;
  /** Present when the child ended on an infrastructure fault (R16). */
  error?: string;
}

export type DelegationRunner = (request: DelegationRequest) => Promise<DelegationOutcome>;

export const listWorkersSpec: ToolSpec = {
  name: LIST_WORKERS,
  description:
    'List the workers on this team. Returns each worker\'s alias, display name, ' +
    'description and capabilities. Use an alias, or a capability string, as the ' +
    '`worker` argument to `delegate`.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export const delegateSpec: ToolSpec = {
  name: DELEGATE,
  description:
    'Delegate a subtask to one worker and wait for its result. `worker` is matched first ' +
    'as an exact alias and then as a capability. The call returns once the worker has ' +
    'finished, carrying its outcome and final message.',
  parameters: {
    type: 'object',
    properties: {
      worker: { type: 'string', description: 'A worker alias, or a capability to match on.' },
      task: { type: 'string', description: 'The subtask, as the worker\'s user message.' },
      context: {
        type: 'string',
        description: 'Optional background supplied to the worker as an additional system block.',
      },
    },
    required: ['worker', 'task'],
    additionalProperties: false,
  },
};

export type WorkerMatch =
  | { ok: true; member: RosterMember }
  | { ok: false; error: string };

/**
 * R13 — resolve `worker`: exact alias first, then capability.
 *
 * ALIAS FIRST AND EXACTLY, so a Team can always address a specific worker unambiguously
 * however its capabilities overlap with its siblings'. Capability matching is the
 * convenience layer on top, and R13 makes it case-insensitive because a manager writing
 * "Frontend" should not silently miss a worker declaring "frontend".
 *
 * Zero and multiple matches are both errors, and BOTH START NO CHILD RUN (edges 2, 3). A
 * daemon that picked the first of two matches would give the same delegation different
 * workers on different days depending on roster order.
 */
export function resolveWorker(roster: ResolvedRoster, query: string): WorkerMatch {
  const byAlias = roster.workers.find((w) => w.alias === query);
  if (byAlias) return { ok: true, member: byAlias };

  const needle = query.toLowerCase();
  const matches = roster.workers.filter((w) =>
    w.capabilities.some((c) => c.toLowerCase() === needle),
  );

  if (matches.length === 1) return { ok: true, member: matches[0]! };

  if (matches.length === 0) {
    return {
      ok: false,
      error:
        `no worker matches \`${query}\` by alias or capability; ` +
        `available aliases: ${roster.workers.map((w) => w.alias).join(', ')}`,
    };
  }

  return {
    ok: false,
    error:
      `capability \`${query}\` matches ${matches.length} workers ` +
      `(${matches.map((m) => m.alias).join(', ')}); use one of those aliases instead. ` +
      'No worker was started.',
  };
}

/**
 * R17 — admit at most N delegations concurrently.
 *
 * EVENT-DRIVEN: a waiter is admitted by the completion of an earlier delegation, directly,
 * with no timer between them. There is no polling here for the same reason there is none
 * in the model scheduler — a poll adds latency proportional to its interval and buys
 * nothing.
 */
class DelegationSemaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    let released = false;
    return () => {
      // Guarded because a double release would let the limit drift upward silently, and
      // the acceptance criterion is stated as "at most two concurrently AT ANY INSTANT".
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }

  /** For tests — the concurrency the acceptance criterion is written about. */
  get inFlight(): number {
    return this.active;
  }
}

export interface TeamToolProviderOptions {
  /** The ordinary provider. Everything that is not a team tool falls through to it. */
  base: ToolProvider;
  roster: ResolvedRoster;
  runDelegation: DelegationRunner;
  /** R28 — checked before a child Run is created. */
  treeCheck: () => TreeCheck;
  /** R30 — consecutive identical delegations that terminate the Team Run. */
  noProgressThreshold: number;
  /** R30, edge 16 — cancels in-flight children and terminates the Team Run. */
  onNoProgress: () => void;
}

/**
 * The manager's ToolProvider — R11, R12, R18.
 *
 * Wraps rather than replaces: the manager is an ordinary Agent with an ordinary tool grant
 * and two extra tools, and re-implementing the base provider's list/invoke here would be a
 * second place that decides what a Run may call.
 */
export class TeamToolProvider implements ToolProvider {
  readonly name = 'TeamToolProvider';

  /** R27 — counts EVERY delegate call, including failed and cancelled ones. */
  private delegationsUsed = 0;
  /** R30 — the last (worker, task) pair and how many times it has repeated. */
  private lastSignature: string | null = null;
  private repeats = 0;
  private readonly semaphore: DelegationSemaphore;

  constructor(private readonly options: TeamToolProviderOptions) {
    this.semaphore = new DelegationSemaphore(
      Math.max(1, options.roster.limits.max_concurrent_delegations),
    );
  }

  get delegationCount(): number {
    return this.delegationsUsed;
  }

  get inFlightDelegations(): number {
    return this.semaphore.inFlight;
  }

  async list(ctx: RunContext): Promise<ToolSpec[]> {
    return [...(await this.options.base.list(ctx)), listWorkersSpec, delegateSpec];
  }

  async invoke(name: string, args: unknown, ctx: RunContext): Promise<ToolResult> {
    if (name === LIST_WORKERS) return this.listWorkers();
    if (name === DELEGATE) return this.delegate(args, ctx);
    return this.options.base.invoke(name, args, ctx);
  }

  /**
   * R12 — alias, display_name, description and capabilities. NOTHING ELSE.
   *
   * Deliberately not the worker's persona, model tag or tool list. The manager decomposes
   * a task by capability; telling it which binding a worker runs on would invite it to
   * route by model rather than by what the worker can do, and would leak the roster's
   * internal configuration into the manager's context on every Team Run.
   */
  private listWorkers(): ToolResult {
    return {
      content: JSON.stringify(
        this.options.roster.workers.map((w) => ({
          alias: w.alias,
          display_name: w.display_name,
          description: w.description,
          capabilities: w.capabilities,
        })),
        null,
        2,
      ),
    };
  }

  private async delegate(args: unknown, ctx: RunContext): Promise<ToolResult> {
    const parsed = parseDelegateArgs(args);
    if (!parsed.ok) return { content: parsed.error, isError: true };

    // R19 — the delegation_id IS the manager's tool_call event_id, handed down by the loop.
    // Without it no child could be linked back to the call that created it, which is half
    // of this phase's exit criterion.
    const delegationId = ctx.toolCallEventId;
    if (!delegationId) {
      return {
        content:
          '`delegate` was dispatched without a tool_call event id, so the child Run could ' +
          'not record its delegation_id (Team Orchestration R19)',
        isError: true,
      };
    }

    // R30 / edge 16 — byte-identical `worker` and `task`, ignoring `context`. Comparing the
    // whole argument object instead would let a manager evade the detector forever by
    // varying only its own commentary.
    const signature = JSON.stringify([parsed.worker, parsed.task]);
    this.repeats = signature === this.lastSignature ? this.repeats + 1 : 0;
    this.lastSignature = signature;
    if (this.repeats + 1 >= this.options.noProgressThreshold) {
      this.options.onNoProgress();
      return {
        content:
          `the same delegation (\`${parsed.worker}\`) has been issued ` +
          `${this.repeats + 1} times in a row with an identical task; the Team Run is ` +
          'terminating with outcome `no_progress`',
        isError: true,
      };
    }

    // Data-flow step 7 — max_delegations, then the tree budgets, THEN worker resolution.
    // R27 / edge 15 — this does NOT terminate the Team Run; the manager proceeds to
    // synthesis with whatever its earlier delegations produced.
    if (this.delegationsUsed >= this.options.roster.limits.max_delegations) {
      return {
        content:
          `this Team Run has used all ${this.options.roster.limits.max_delegations} of its ` +
          '`max_delegations`; no further delegation is possible. Synthesize what you have.',
        isError: true,
      };
    }

    // R28 — checked BEFORE the child is created, so a child is never started against an
    // already-exhausted budget and then immediately cancelled.
    const tree = this.options.treeCheck();
    if (!tree.ok) {
      return {
        content: `the Team Run's \`${tree.budget}\` tree budget is exhausted; no further delegation is possible`,
        isError: true,
      };
    }

    const match = resolveWorker(this.options.roster, parsed.worker);
    if (!match.ok) return { content: match.error, isError: true };

    this.delegationsUsed += 1;

    // R17 — excess delegations queue here and are admitted as earlier ones terminate.
    const release = await this.semaphore.acquire();
    try {
      const result = await this.options.runDelegation({
        member: match.member,
        task: parsed.task,
        ...(parsed.context !== undefined ? { context: parsed.context } : {}),
        delegationId,
      });
      return delegationResult(match.member, result);
    } finally {
      release();
    }
  }
}

/**
 * R15, R16, edge 22 — the ToolResult the manager sees.
 *
 * A non-`success` child is `is_error: true` WHATEVER the cause. Edge 22 is explicit that
 * `incomplete` (the worker honestly reported it could not do the job) and `failed` (the
 * worker crashed) look the same to the manager except in the message. The manager's job is
 * to react to the outcome, not to diagnose the runtime.
 */
function delegationResult(member: RosterMember, outcome: DelegationOutcome): ToolResult {
  const body = JSON.stringify(
    {
      alias: member.alias,
      child_run_id: outcome.childRunId,
      outcome: outcome.outcome,
      result: outcome.finalMessage,
      steps: outcome.steps,
      model_tokens: outcome.modelTokens,
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    null,
    2,
  );

  return outcome.outcome === 'success' ? { content: body } : { content: body, isError: true };
}

type ParsedDelegate =
  | { ok: true; worker: string; task: string; context?: string }
  | { ok: false; error: string };

function parseDelegateArgs(args: unknown): ParsedDelegate {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: '`delegate` takes an object with `worker` and `task`' };
  }
  const raw = args as { worker?: unknown; task?: unknown; context?: unknown };

  const problems: string[] = [];
  if (typeof raw.worker !== 'string' || raw.worker.trim() === '') {
    problems.push('`worker` is required and must be a non-empty string');
  }
  if (typeof raw.task !== 'string' || raw.task.trim() === '') {
    problems.push('`task` is required and must be a non-empty string');
  }
  if (raw.context !== undefined && typeof raw.context !== 'string') {
    problems.push('`context` must be a string when present');
  }
  // Every fault at once — R30's error result is the manager's only feedback, and it costs
  // a Step to receive.
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };

  return {
    ok: true,
    worker: raw.worker as string,
    task: raw.task as string,
    ...(typeof raw.context === 'string' ? { context: raw.context } : {}),
  };
}
