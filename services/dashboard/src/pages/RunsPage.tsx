/**
 * RunsPage — design-dashboard.md Requirements 134, 107, 106b, 97, edge case 38a.
 *
 * Renders `GET /api/runs` with filters mirroring that endpoint's own parameters — agent,
 * status, outcome, and `parent_run_id` — showing ROOT RUNS BY DEFAULT with an
 * include-children toggle, and using cursor pagination.
 *
 * THE VERSION PIN COLUMN IS WHY THIS PHASE TOUCHED THE DAEMON. Requirement 107 puts the pin
 * badge here, and `GET /api/runs` returned only `agent_version_id` — an opaque uuid that no
 * endpoint resolved to either an agent or a version number. P9 adds `agent_id` and
 * `version` to the run row (dependency ruling 6), and the badge is derived from those two
 * plus the agent list.
 *
 * A DELETED AGENT RENDERS `v?` AND ITS uuid (Requirements 106a, 106b, edge 38a). Agent
 * Definition R26's soft delete hides an agent from LIST endpoints only, so an `agent_id`
 * present on a run but absent from `GET /api/agents` is precisely the deleted case. The
 * agent-name cell then has no value and renders the `agent_version_id` in monospace with
 * the standard copy affordance, that being the only true identifier available.
 *
 * ROOT RUNS BY DEFAULT is implemented client-side, and the reason is worth recording: the
 * endpoint's `parent_run_id` filter selects the children OF a given parent, and there is no
 * `parent_run_id=null` form to ask for roots. Filtering `parent_run_id === null` after the
 * fetch is the honest way to express "root runs only" against the API as it exists. It
 * interacts with pagination — a page of 50 may contain fewer than 50 roots — so the toggle
 * says what it is doing rather than silently shrinking the page.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { FilterRow, PageHeader } from '../components/AppShell';
import { CopyToken } from '../components/CopyToken';
import { EmptyState, LoadError, PrimaryAction } from '../components/EmptyState';
import { RunLauncherModal, type LaunchTarget } from '../components/RunLauncherModal';
import { StatusChip } from '../components/StatusChip';
import { VersionPinBadge } from '../components/VersionPinBadge';
import { fetchAgents, fetchRuns, fetchTeams, type RunFilters } from '../lib/api';
import { useResource } from '../lib/useResource';
import { RUN_STATUS, runState } from '../lib/status';
import { relativeTime } from '../lib/format';

const OUTCOMES = ['success', 'incomplete', 'failed', 'cancelled', 'budget_exhausted', 'no_progress'] as const;

export function RunsPage() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState<RunFilters>({});
  const [includeChildren, setIncludeChildren] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const [launching, setLaunching] = useState(false);

  const cursor = cursors[cursors.length - 1];
  const runs = useResource(
    () => fetchRuns(cursor === undefined ? filters : { ...filters, cursor }),
    [filters.agent_id, filters.status, filters.outcome, cursor],
  );
  const agents = useResource(fetchAgents, []);
  const teams = useResource(fetchTeams, []);

  if (runs.error) {
    return <LoadError what="runs" error={runs.error} onRetry={runs.reload} />;
  }

  const all = runs.data?.runs ?? [];
  const rows = includeChildren ? all : all.filter((run) => run.parent_run_id === null);

  // Requirement 106a's discriminator: present in the list -> current version known;
  // absent -> soft-deleted.
  const currentVersionOf = (agentId: string): number | undefined =>
    (agents.data ?? []).find((agent) => agent.agent_id === agentId)?.current_version;
  const nameOf = (agentId: string): string | undefined =>
    (agents.data ?? []).find((agent) => agent.agent_id === agentId)?.display_name ??
    (agents.data ?? []).find((agent) => agent.agent_id === agentId)?.name;

  const launchTargets: LaunchTarget[] = [
    ...(agents.data ?? []).map((agent) => ({
      kind: 'agent' as const,
      id: agent.agent_id,
      label: agent.display_name ?? agent.name,
    })),
    ...(teams.data ?? []).map((team) => ({
      kind: 'team' as const,
      id: team.team_id,
      label: team.display_name ?? team.name,
    })),
  ];

  return (
    <>
      <PageHeader
        title="Runs"
        count={rows.length}
        action={<PrimaryAction label="Start a run" onClick={() => setLaunching(true)} />}
      />

      <FilterRow>
        <select
          className="input"
          value={filters.agent_id ?? ''}
          onChange={(event) => {
            setCursors([]);
            setFilters((current) => ({ ...current, agent_id: event.target.value || undefined }));
          }}
        >
          <option value="">All agents</option>
          {(agents.data ?? []).map((agent) => (
            <option key={agent.agent_id} value={agent.agent_id}>
              {agent.display_name ?? agent.name}
            </option>
          ))}
        </select>

        <select
          className="input"
          value={filters.status ?? ''}
          onChange={(event) => {
            setCursors([]);
            setFilters((current) => ({ ...current, status: event.target.value || undefined }));
          }}
        >
          <option value="">Any status</option>
          <option value="running">running</option>
          <option value="terminal">terminal</option>
        </select>

        <select
          className="input"
          value={filters.outcome ?? ''}
          onChange={(event) => {
            setCursors([]);
            setFilters((current) => ({ ...current, outcome: event.target.value || undefined }));
          }}
        >
          <option value="">Any outcome</option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcome}
            </option>
          ))}
        </select>

        <label className="text-body-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--fg-muted)' }}>
          <input type="checkbox" checked={includeChildren} onChange={(event) => setIncludeChildren(event.target.checked)} />
          Include delegated child runs
        </label>
      </FilterRow>

      {runs.loading ? (
        <p className="text-body">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          headline="No runs yet."
          why="A run is one execution of an agent or a team. Start one from an agent, from a team, or from here."
          action={<PrimaryAction label="Start a run" onClick={() => setLaunching(true)} />}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '130px' }}>Status</th>
                <th>Agent</th>
                <th style={{ width: '90px' }}>Version</th>
                <th style={{ width: '230px' }}>Run id</th>
                <th style={{ width: '120px' }}>Started</th>
                <th style={{ width: '90px' }}>Kind</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => {
                const state = runState(run);
                const currentVersion = currentVersionOf(run.agent_id);
                const agentName = nameOf(run.agent_id);
                return (
                  <tr key={run.run_id} className="row" onClick={() => navigate(`/runs/${run.run_id}`)}>
                    <td>
                      <StatusChip status={RUN_STATUS[state]} />
                    </td>
                    <td>
                      {agentName !== undefined ? (
                        agentName
                      ) : (
                        // Requirement 106b — the agent was deleted, so the only true
                        // identifier available is the version uuid.
                        <CopyToken value={run.agent_version_id} />
                      )}
                    </td>
                    <td>
                      <VersionPinBadge executedVersion={run.version} currentVersion={currentVersion} />
                    </td>
                    <td>
                      <CopyToken value={run.run_id} />
                    </td>
                    <td style={{ color: 'var(--fg-dim)' }}>{relativeTime(Date.parse(run.started_at))} ago</td>
                    <td className="text-micro" style={{ color: 'var(--fg-muted)' }}>
                      {run.is_team_run ? 'team' : run.parent_run_id ? 'child' : 'agent'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <button type="button" className="btn" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </button>
            <button
              type="button"
              className="btn"
              disabled={runs.data?.next_cursor === undefined}
              onClick={() => {
                const next = runs.data?.next_cursor;
                if (next) setCursors((c) => [...c, next]);
              }}
            >
              Next
            </button>
            {!includeChildren && all.length !== rows.length ? (
              <span className="text-body-sm" style={{ color: 'var(--fg-muted)', alignSelf: 'center' }}>
                {all.length - rows.length} delegated child run{all.length - rows.length === 1 ? '' : 's'} hidden on this page.
              </span>
            ) : null}
          </div>
        </>
      )}

      {launching ? <RunLauncherModal targets={launchTargets} onClose={() => setLaunching(false)} /> : null}
    </>
  );
}
