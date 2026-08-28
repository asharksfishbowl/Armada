/**
 * The run launcher — design-dashboard.md Requirement 136.
 *
 * ONE SURFACE, TWO ENDPOINTS. It collects an agent OR a team, the task text, and an
 * optional `workspace_path`, then calls `POST /api/runs` with `agent_id` for an agent
 * (Agent Runtime R2) or `POST /api/team-runs` with `team_id` for a team (Team
 * Orchestration R40), and redirects to `/runs/{run_id}` using the returned id. "The two
 * paths differ ONLY in the endpoint called; the modal is one surface" — so the target is a
 * single discriminated value rather than two components or a mode flag.
 *
 * It is reachable from AgentsPage row actions, TeamsPage row actions, and the RunsPage
 * header. It is a modal, not a page — it blocks, and Requirement 14's blur belongs here.
 *
 * IT SURFACES THE FAIL-FAST HONESTLY. build-plan Requirement 9 / D4: `POST /api/runs`
 * refuses a Run whose pinned `binding_tag` resolves to an unmaterialized binding, naming
 * the tag and the required action, and the daemon returns 422 `binding_not_servable` or
 * 503 `binding_unverified` with that detail. Those are rendered as the message the server
 * wrote, not flattened into "failed to start" — the whole point of the fail-fast is that
 * it tells the operator what to do next.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError, startAgentRun, startTeamRun } from '../lib/api';
import { useAction } from '../lib/useResource';

export type LaunchTarget =
  | { kind: 'agent'; id: string; label: string }
  | { kind: 'team'; id: string; label: string };

export function RunLauncherModal({
  target,
  targets,
  onClose,
}: {
  /** Pre-selected when launched from a row action. */
  target?: LaunchTarget;
  /** Everything launchable, for the RunsPage header where nothing is pre-selected. */
  targets: LaunchTarget[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [selectedKey, setSelectedKey] = useState(
    target ? `${target.kind}:${target.id}` : targets[0] ? `${targets[0].kind}:${targets[0].id}` : '',
  );
  const [task, setTask] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');

  const chosen = targets.find((entry) => `${entry.kind}:${entry.id}` === selectedKey) ?? target;

  const launch = useAction(async () => {
    if (!chosen) return undefined;
    const workspace = workspacePath.trim() === '' ? null : workspacePath.trim();
    const result =
      chosen.kind === 'agent'
        ? await startAgentRun({ agent_id: chosen.id, task, workspace_path: workspace })
        : await startTeamRun({ team_id: chosen.id, task, workspace_path: workspace });
    navigate(`/runs/${result.run_id}`);
    return result;
  });

  const failure = launch.error;
  const failureText =
    failure instanceof ApiError
      ? String(
          (failure.body as { detail?: unknown } | null)?.detail ??
            (failure.body as { errors?: unknown } | null)?.errors ??
            failure.message,
        )
      : failure
        ? String(failure)
        : null;

  return (
    <div className="overlay-scrim" style={{ display: 'grid', placeItems: 'center', zIndex: 60 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Start a run"
        className="panel"
        style={{
          width: '560px',
          maxWidth: '90vw',
          borderRadius: 'var(--radius-overlay)',
          padding: 'var(--space-6)',
          background: 'var(--surface-2)',
        }}
      >
        <h2 className="text-section" style={{ margin: '0 0 var(--space-4)' }}>
          Start a run
        </h2>

        <label className="text-body-sm" style={{ display: 'block', marginBottom: 'var(--space-4)' }}>
          <span style={{ color: 'var(--fg-muted)' }}>Agent or team</span>
          <select
            className="input"
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.target.value)}
            style={{ width: '100%', marginTop: 'var(--space-1)' }}
          >
            {targets.map((entry) => (
              <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
                {entry.kind === 'team' ? 'Team · ' : 'Agent · '}
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-body-sm" style={{ display: 'block', marginBottom: 'var(--space-4)' }}>
          <span style={{ color: 'var(--fg-muted)' }}>Task</span>
          <textarea
            className="input"
            rows={5}
            autoFocus
            value={task}
            onChange={(event) => setTask(event.target.value)}
            style={{ width: '100%', marginTop: 'var(--space-1)', resize: 'vertical' }}
          />
        </label>

        <label className="text-body-sm" style={{ display: 'block' }}>
          <span style={{ color: 'var(--fg-muted)' }}>Workspace path (optional)</span>
          <input
            className="input"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            placeholder="/armada/workspaces/…"
            style={{ width: '100%', marginTop: 'var(--space-1)', fontFamily: 'var(--font-mono)' }}
          />
        </label>

        {failureText ? (
          <p
            className="text-body-sm"
            style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-3)',
              border: '1px solid var(--status-fault)',
              borderRadius: 'var(--radius-control)',
              color: 'var(--status-fault)',
            }}
          >
            {failureText}
          </p>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-6)' }}>
          <button type="button" className="btn" onClick={onClose} disabled={launch.pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void launch.run()}
            disabled={launch.pending || task.trim() === '' || !chosen}
          >
            {launch.pending ? 'Starting…' : 'Start run'}
          </button>
        </div>
        {task.trim() === '' ? (
          // Requirement 95 — a disabled primary action always renders its reason inline.
          <p className="text-body-sm" style={{ margin: 'var(--space-2) 0 0', color: 'var(--fg-muted)', textAlign: 'right' }}>
            A task is required.
          </p>
        ) : null}
      </div>
    </div>
  );
}
