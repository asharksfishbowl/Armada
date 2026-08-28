/**
 * TeamsPage — design-dashboard.md Requirements 133, 97, 102.
 *
 * Columns (Requirement 133): display_name, name, manager agent, worker count, limits. The
 * drawer renders the resolved roster, the limits, and any warnings.
 *
 * THE EMPTY STATE'S PRIMARY ACTION IS ENABLED (Requirement 97), which is the one detail
 * here worth stating: both shipped agents declare `capabilities` (Agent Definition R34,
 * R35), so a valid team IS constructible on a fresh installation. Disabling the action
 * would be wrong, and Requirement 95 would then demand a reason that does not exist.
 *
 * `DELETE /api/teams/{team_id}` — dependency ruling 3. It shipped with P8; this page is
 * its first consumer.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyToken } from '../components/CopyToken';
import { DetailDrawer, DrawerSection, Field } from '../components/DetailDrawer';
import { EmptyState, LoadError, PrimaryAction } from '../components/EmptyState';
import { RunLauncherModal, type LaunchTarget } from '../components/RunLauncherModal';
import { StatusChip } from '../components/StatusChip';
import { deleteTeam, fetchAgents, fetchTeams, type TeamListRow } from '../lib/api';
import { useAction, useResource } from '../lib/useResource';

export function TeamsPage() {
  const navigate = useNavigate();
  const teams = useResource(fetchTeams, []);
  const agents = useResource(fetchAgents, []);

  const [selected, setSelected] = useState<TeamListRow | null>(null);
  const [deleting, setDeleting] = useState<TeamListRow | null>(null);
  const [launching, setLaunching] = useState<LaunchTarget | null>(null);

  const remove = useAction(async (teamId: string) => {
    await deleteTeam(teamId);
    setDeleting(null);
    setSelected(null);
    teams.reload();
  });

  if (teams.error) {
    return <LoadError what="teams" error={teams.error} onRetry={teams.reload} />;
  }

  const rows = teams.data ?? [];
  const launchTargets: LaunchTarget[] = [
    ...(agents.data ?? []).map((agent) => ({
      kind: 'agent' as const,
      id: agent.agent_id,
      label: agent.display_name ?? agent.name,
    })),
    ...rows.map((team) => ({ kind: 'team' as const, id: team.team_id, label: team.display_name ?? team.name })),
  ];

  return (
    <>
      <PageHeader
        title="Teams"
        count={rows.length}
        // ENABLED on a fresh installation — see the file comment.
        action={<PrimaryAction label="New team" to="/teams/new" />}
      />

      {teams.loading ? (
        <p className="text-body">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          headline="No teams."
          why="A team is one manager agent delegating to workers under explicit limits. Both shipped agents declare capabilities, so a valid team can be built now."
          action={<PrimaryAction label="New team" to="/teams/new" />}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th style={{ width: '160px' }}>Name</th>
              <th style={{ width: '180px' }}>Manager</th>
              <th style={{ width: '90px' }}>Workers</th>
              <th>Limits</th>
              <th style={{ width: '110px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.team_id}
                className={`row${selected?.team_id === row.team_id ? ' row-selected' : ''}`}
                onClick={() => setSelected(row)}
              >
                <td>
                  {row.display_name ?? row.name}
                  {row.warnings.length > 0 ? (
                    <span style={{ marginLeft: 'var(--space-2)' }}>
                      <StatusChip
                        status={{ hue: '--status-warn', mark: 'disc-hollow', label: `${row.warnings.length} WARNING` }}
                        title={[...row.warnings, ...(row.missing_members ?? [])].join('\n')}
                      />
                    </span>
                  ) : null}
                </td>
                <td>
                  <CopyToken value={row.name} />
                </td>
                <td>
                  <CopyToken value={row.manager} />
                </td>
                <td className="counter">{row.workers.length}</td>
                <td className="text-body-sm counter" style={{ color: 'var(--fg-muted)' }}>
                  {row.limits.max_delegations} delegations · {row.limits.max_concurrent_delegations} concurrent
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLaunching({ kind: 'team', id: row.team_id, label: row.display_name ?? row.name });
                    }}
                  >
                    Run
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <DetailDrawer
          title={selected.display_name ?? selected.name}
          subtitle={selected.description}
          onClose={() => setSelected(null)}
          safeActions={
            <button type="button" className="btn" onClick={() => navigate(`/teams/${selected.team_id}/edit`)}>
              Edit
            </button>
          }
          destructiveActions={
            <button type="button" className="btn btn-destructive" onClick={() => setDeleting(selected)}>
              Delete
            </button>
          }
        >
          <Field label="Name">
            <CopyToken value={selected.name} />
          </Field>
          <Field label="Current version">v{selected.current_version}</Field>

          <DrawerSection title="Roster">
            <Field label="Manager">
              <CopyToken value={selected.manager} />
            </Field>
            {selected.workers.map((worker) => (
              <div key={worker.alias} style={{ marginBottom: 'var(--space-3)' }}>
                <Field label={worker.alias}>
                  <CopyToken value={worker.agent_name} />
                </Field>
                <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                  {worker.capabilities.map((capability) => (
                    <span key={capability} className="capability-chip">
                      {capability}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </DrawerSection>

          <DrawerSection title="Limits">
            {Object.entries(selected.limits).map(([key, value]) => (
              <div key={key} className="text-body-sm" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--fg-muted)' }}>{key}</span>
                <span className="counter">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </DrawerSection>

          {selected.warnings.length > 0 ? (
            <DrawerSection title="Warnings">
              {selected.warnings.map((warning) => (
                <p key={warning} className="text-body-sm" style={{ color: 'var(--status-warn)' }}>
                  {warning}
                </p>
              ))}
              {(selected.missing_members ?? []).length > 0 ? (
                <p className="text-body-sm" style={{ color: 'var(--status-warn)' }}>
                  Missing members: {(selected.missing_members ?? []).join(', ')}
                </p>
              ) : null}
            </DrawerSection>
          ) : null}
        </DetailDrawer>
      ) : null}

      {launching ? (
        <RunLauncherModal target={launching} targets={launchTargets} onClose={() => setLaunching(null)} />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete team ${deleting.name}?`}
          // Requirement 102 — a plain confirm. Proportional to reversibility: this destroys
          // a definition, not embeddings, and every member and run survives.
          removed={<>The team definition.</>}
          retained={
            <>
              Every member agent and every run the team produced. The agents are untouched — a team
              is a binding over them, not a container of them.
            </>
          }
          confirmLabel="Delete team"
          pending={remove.pending}
          onConfirm={() => void remove.run(deleting.team_id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}
