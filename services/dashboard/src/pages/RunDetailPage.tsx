/**
 * RunDetailPage — the P9 half of design-dashboard.md Requirement 135.
 *
 * WHAT THIS PHASE BUILDS AND WHY IT IS NOT THE WHOLE PAGE. Requirement 135 gives this route
 * three things: the run status header, the event stream, and `TeamRunTree`. The latter two
 * are P10's entire scope — the stream, Step blocks, the minimap, the filter system and its
 * fault-unfilterability guarantee, follow-and-detach, the reconnect and broken-log
 * assertions, and the delegation tree. None of that is built here.
 *
 * The header is, because it is the run launcher's landing site. Requirement 136 says the
 * launcher "redirects to `/runs/{run_id}` using the returned id", so this route has to
 * resolve to something real the moment an operator starts a run. Sending them to a 404, or
 * quietly redirecting back to the list, would make the launcher's specified behaviour a
 * lie.
 *
 * EVERYTHING RENDERED HERE IS REST-AUTHORITATIVE (Requirement 118): "REST is authoritative
 * for a run's outcome; WebSocket is authoritative for its events." This page renders only
 * the first kind. It opens no socket, so none of Requirements 111-118's connection states
 * can arise, and it claims no live counters — the numbers are as of the last fetch and the
 * page says so.
 */

import { useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyToken } from '../components/CopyToken';
import { LoadError } from '../components/EmptyState';
import { StatusChip } from '../components/StatusChip';
import { VersionPinBadge } from '../components/VersionPinBadge';
import { Toast, type ToastMessage } from '../components/Toast';
import { ApiError, cancelRun, fetchAgents, fetchRun } from '../lib/api';
import { useAction, useResource } from '../lib/useResource';
import { RUN_STATUS, runChipLabel, runState } from '../lib/status';
import { duration, relativeTime, tokens } from '../lib/format';
import { useState } from 'react';

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const run = useResource(() => fetchRun(runId ?? ''), [runId]);
  const agents = useResource(fetchAgents, []);

  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const cancel = useAction(async () => {
    try {
      await cancelRun(runId ?? '');
      setConfirming(false);
      run.reload();
    } catch (err) {
      // Requirement 105 / edge case 32 — a cancel racing a termination returns 409. That
      // renders as an INLINE TOAST naming the existing outcome, never an error modal: the
      // run terminated on its own, which is not a failure.
      if (err instanceof ApiError && err.status === 409) {
        const outcome = String((err.body as { outcome?: unknown })?.outcome ?? 'unknown');
        setConfirming(false);
        setToast({ tone: 'info', text: `This run had already terminated with outcome ${outcome}.` });
        run.reload();
        return;
      }
      throw err;
    }
  });

  if (run.error) {
    return <LoadError what="this run" error={run.error} onRetry={run.reload} />;
  }
  if (!run.data) {
    return <p className="text-body" style={{ padding: 'var(--space-6)' }}>Loading…</p>;
  }

  const data = run.data;
  const state = runState(data);
  const status = RUN_STATUS[state];
  const currentVersion = (agents.data ?? []).find((agent) => agent.agent_id === data.agent_id)?.current_version;
  const agentName = (agents.data ?? []).find((agent) => agent.agent_id === data.agent_id);
  const isRunning = data.status === 'running';

  // Requirement 148 — one composite action. When a run goes wrong the operator's next task
  // is pasting context elsewhere, and assembling it from six hover-copies is the failure
  // mode this prevents.
  const runReference = [
    `run_id: ${data.run_id}`,
    `agent: ${agentName?.name ?? '(deleted)'} v${data.version}`,
    `agent_version_id: ${data.agent_version_id}`,
    `outcome: ${data.outcome ?? data.status}`,
    `steps: ${data.counters.steps_used}`,
    `model_tokens: ${data.counters.model_tokens_used}`,
    `tool_calls: ${data.counters.tool_calls_used}`,
    `wall_clock: ${duration(data.counters.wall_clock_ms_used)}`,
  ].join('\n');

  return (
    <>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <header
        // Requirement 14 — the live bloom and shimmer render ONLY while running, and
        // Requirement 13 stops them the moment the entity is terminal.
        className={isRunning ? 'panel is-live' : 'panel'}
        style={{
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
          ['--bloom-hue' as string]: `var(${status.hue})`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <StatusChip status={status} label={runChipLabel(state, data.result ?? undefined)} />
          <VersionPinBadge executedVersion={data.version} currentVersion={currentVersion} />
          <span className="text-body">{agentName?.display_name ?? agentName?.name ?? 'Deleted agent'}</span>
          {data.is_team_run ? <span className="capability-chip">team run</span> : null}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(runReference)}>
            Copy run reference
          </button>
          {/* Requirement 105 — cancel is NOT rendered on a terminal run. */}
          {isRunning ? (
            <button type="button" className="btn btn-destructive" onClick={() => setConfirming(true)}>
              Cancel run
            </button>
          ) : null}
        </div>

        {agentName === undefined ? (
          // Requirement 106b — one line stating the agent was deleted and that the pinned
          // definition is retained, linking to the version view. That link resolves because
          // R26 hides a deleted agent from LIST endpoints only.
          <p className="text-body-sm" style={{ color: 'var(--fg-muted)', margin: 'var(--space-3) 0 0' }}>
            This agent was deleted. Its pinned version definition is retained and this run is
            unaffected — deleting an agent never removes a version or a run.
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-6)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Counter label="steps" value={String(data.counters.steps_used)} />
          <Counter label="model tokens" value={tokens(data.counters.model_tokens_used)} />
          <Counter label="tool calls" value={String(data.counters.tool_calls_used)} />
          <Counter label="wall clock" value={duration(data.counters.wall_clock_ms_used)} />
          <Counter label="queued" value={duration(data.counters.queued_ms_total)} />
          <Counter label="started" value={`${relativeTime(Date.parse(data.started_at))} ago`} />
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-6)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
            run_id <CopyToken value={data.run_id} />
          </span>
          <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
            agent_version_id <CopyToken value={data.agent_version_id} />
          </span>
          {data.team_version_id ? (
            <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
              team_version_id <CopyToken value={data.team_version_id} />
            </span>
          ) : null}
          {data.workspace_path ? (
            <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
              workspace <CopyToken value={data.workspace_path} />
            </span>
          ) : null}
        </div>
      </header>

      {data.result ? (
        <div className="panel" style={{ padding: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
          <div className="text-micro" style={{ color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
            Result
          </div>
          <p className="text-body" style={{ margin: 'var(--space-2) 0 0', whiteSpace: 'pre-wrap' }}>
            {data.result}
          </p>
        </div>
      ) : null}

      <div className="panel" style={{ padding: 'var(--space-6)' }}>
        <p className="text-body" style={{ margin: 0 }}>
          The event stream is not part of this build.
        </p>
        <p className="text-body-sm" style={{ color: 'var(--fg-muted)', margin: 'var(--space-2) 0 0', maxWidth: '70ch' }}>
          The run’s events exist and are recorded — this page simply does not render them yet. The
          stream, its Step blocks, the fault minimap, the filter system, the reconnect handling, and
          the team run tree land together as one surface, because a partial event view is the one
          thing the design spec is most explicit about not shipping: a degraded view of an event log
          must never be presented as a healthy one.
        </p>
        <p className="text-body-sm" style={{ color: 'var(--fg-muted)', margin: 'var(--space-3) 0 0' }}>
          Everything above is REST-authoritative and accurate as of the last load.
        </p>
        <button type="button" className="btn" style={{ marginTop: 'var(--space-3)' }} onClick={run.reload}>
          Refetch run
        </button>
      </div>

      <button type="button" className="btn btn-quiet" style={{ marginTop: 'var(--space-4)' }} onClick={() => navigate('/runs')}>
        ← All runs
      </button>

      {confirming ? (
        <ConfirmDialog
          title="Cancel this run?"
          // Requirement 103 — framed in MECHANICS rather than in doubt.
          removed={
            <>
              The in-flight tool is killed and the sandbox is destroyed. The run is recorded with
              outcome <span style={{ fontFamily: 'var(--font-mono)' }}>cancelled</span>.
              {data.is_team_run ? ' Every in-flight child run is cancelled with it.' : ''}
            </>
          }
          retained={
            <>
              Every event already recorded. The run stays viewable with its full history and its
              pinned agent version.
            </>
          }
          breaks={
            <>
              Cancelled runs are never used as training data — only an explicit self-reported
              success is.
            </>
          }
          confirmLabel="Cancel run"
          pending={cancel.pending}
          onConfirm={() => void cancel.run()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-micro" style={{ color: 'var(--fg-muted)', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div className="text-body counter" style={{ color: 'var(--fg)' }}>
        {value}
      </div>
    </div>
  );
}
