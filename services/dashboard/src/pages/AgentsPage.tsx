/**
 * AgentsPage — design-dashboard.md Requirements 131, 131a, 131b, 97, 100, edge case 34.
 *
 * Columns (Requirement 131): display_name, name, binding_tag (monospace), capability chips,
 * current version, warning count.
 *
 * THE FIRST-RUN STATE IS TWO ROWS, EACH WITH A WARNING COUNT OF 1 (Requirement 97). Agent
 * Definition R36 ships two agents, and both validate with a zero-chunk-corpus warning. The
 * hint bar says so: they run, and retrieval returns nothing. This is not an error state and
 * must not render as one.
 *
 * THE DRAWER FOOTER IS SPLIT INTO TWO ZONES THAT ARE NEVER ADJACENT (Requirement 131a):
 * Clone and Refresh bindings on the left, Delete in --status-fault on the right.
 * `DetailDrawer` enforces the separation; this page only supplies the contents.
 *
 * NO DESTRUCTIVE ACTION IS REACHABLE FROM A ROW-HOVER CONTROL (Requirement 41). Delete
 * lives in the drawer footer only. The row's `Run` and `Clone` buttons are explicit
 * affordances rather than hover icons, and neither is destructive.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '../components/AppShell';
import { AgentVersionHistory } from '../components/AgentVersionHistory';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyToken } from '../components/CopyToken';
import { DetailDrawer, DrawerSection, Field } from '../components/DetailDrawer';
import { EmptyState, HintBar, LoadError, PrimaryAction } from '../components/EmptyState';
import { RunLauncherModal, type LaunchTarget } from '../components/RunLauncherModal';
import { StatusChip } from '../components/StatusChip';
import {
  deleteAgent,
  fetchAgentVersion,
  fetchAgents,
  fetchTeams,
  type AgentListRow,
} from '../lib/api';
import { useAction, useResource } from '../lib/useResource';

export function AgentsPage() {
  const navigate = useNavigate();
  const agents = useResource(fetchAgents, []);
  const teams = useResource(fetchTeams, []);

  const [selected, setSelected] = useState<AgentListRow | null>(null);
  const [deleting, setDeleting] = useState<AgentListRow | null>(null);
  const [launching, setLaunching] = useState<LaunchTarget | null>(null);

  const remove = useAction(async (agentId: string) => {
    await deleteAgent(agentId);
    setDeleting(null);
    setSelected(null);
    agents.reload();
  });

  if (agents.error) {
    return <LoadError what="agents" error={agents.error} onRetry={agents.reload} />;
  }

  const rows = agents.data ?? [];
  const warned = rows.filter((row) => (row.warnings?.length ?? 0) > 0);

  const launchTargets: LaunchTarget[] = [
    ...rows.map((row) => ({ kind: 'agent' as const, id: row.agent_id, label: row.display_name ?? row.name })),
    ...(teams.data ?? []).map((team) => ({ kind: 'team' as const, id: team.team_id, label: team.display_name ?? team.name })),
  ];

  return (
    <>
      <PageHeader
        title="Agents"
        count={rows.length}
        action={<PrimaryAction label="New agent" to="/agents/new" />}
      />

      {warned.length > 0 ? (
        <HintBar>
          {warned.length} agent{warned.length === 1 ? '' : 's'} validate with warnings. An agent bound
          to a corpus that has no chunks still runs — retrieval simply returns nothing. Add a source
          and ingest to change that.
        </HintBar>
      ) : null}

      {agents.loading ? (
        <p className="text-body">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          headline="No agents."
          why="An agent binds a persona, a model, tool grants, and optionally a corpus. It is what a run executes."
          action={<PrimaryAction label="New agent" to="/agents/new" />}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th style={{ width: '160px' }}>Name</th>
              <th style={{ width: '220px' }}>Binding tag</th>
              <th>Capabilities</th>
              <th style={{ width: '80px' }}>Version</th>
              <th style={{ width: '110px' }}>Warnings</th>
              <th style={{ width: '140px' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.agent_id}
                className={`row${selected?.agent_id === row.agent_id ? ' row-selected' : ''}`}
                onClick={() => setSelected(row)}
              >
                <td>{row.display_name ?? row.name}</td>
                <td>
                  <CopyToken value={row.name} />
                </td>
                <td>
                  <CopyToken value={row.binding_tag} />
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                    {(row.capabilities ?? []).map((capability) => (
                      <span key={capability} className="capability-chip">
                        {capability}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="counter">v{row.current_version}</td>
                <td>
                  {(row.warnings?.length ?? 0) > 0 ? (
                    <StatusChip
                      status={{
                        hue: '--status-warn',
                        mark: 'disc-hollow',
                        label: `${row.warnings?.length} WARNING`,
                      }}
                      title={row.warnings?.join('\n')}
                    />
                  ) : (
                    <span style={{ color: 'var(--fg-dim)' }}>—</span>
                  )}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={(event) => {
                        event.stopPropagation();
                        setLaunching({ kind: 'agent', id: row.agent_id, label: row.display_name ?? row.name });
                      }}
                    >
                      Run
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={(event) => {
                        event.stopPropagation();
                        // Requirement 131b — a pre-fill, not a server action. No request is
                        // issued and nothing is persisted until the operator saves.
                        navigate(`/agents/new?from=${row.agent_id}&version=${row.current_version}`);
                      }}
                    >
                      Clone
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <AgentDrawer
          agent={selected}
          onClose={() => setSelected(null)}
          onDelete={() => setDeleting(selected)}
          onEdit={() => navigate(`/agents/${selected.agent_id}/edit`)}
          onClone={() => navigate(`/agents/new?from=${selected.agent_id}&version=${selected.current_version}`)}
          onReload={agents.reload}
        />
      ) : null}

      {launching ? (
        <RunLauncherModal target={launching} targets={launchTargets} onClose={() => setLaunching(null)} />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete agent ${deleting.name}?`}
          removed={<>The agent from list views.</>}
          // Requirement 100 — delete is SOFT (Agent Definition R26).
          retained={
            <>
              All versions and all historical runs. Every run this agent produced stays viewable in
              Runs, with its pinned version definition intact.
            </>
          }
          breaks={(() => {
            // Edge case 34 — every affected team listed by name.
            const affected = (teams.data ?? []).filter(
              (team) =>
                team.manager === deleting.name ||
                team.workers.some((worker) => worker.agent_name === deleting.name),
            );
            return affected.length === 0 ? (
              <>No team references this agent.</>
            ) : (
              <>
                These teams reference it and will fail validation:{' '}
                {affected.map((team) => team.name).join(', ')}.
              </>
            );
          })()}
          confirmLabel="Delete agent"
          pending={remove.pending}
          onConfirm={() => void remove.run(deleting.agent_id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

function AgentDrawer({
  agent,
  onClose,
  onDelete,
  onEdit,
  onClone,
  onReload,
}: {
  agent: AgentListRow;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onClone: () => void;
  onReload: () => void;
}) {
  const [tab, setTab] = useState<'detail' | 'versions'>('detail');
  const record = useResource(() => fetchAgentVersion(agent.agent_id), [agent.agent_id]);

  return (
    <DetailDrawer
      title={agent.display_name ?? agent.name}
      subtitle={agent.description}
      onClose={onClose}
      safeActions={
        <>
          <button type="button" className="btn" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn" onClick={onClone}>
            Clone
          </button>
        </>
      }
      destructiveActions={
        <button type="button" className="btn btn-destructive" onClick={onDelete}>
          Delete
        </button>
      }
    >
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <button type="button" className={tab === 'detail' ? 'tab tab-active' : 'tab'} onClick={() => setTab('detail')}>
          Detail
        </button>
        {/* Requirement 132 — version history is a drawer TAB, not a route. */}
        <button type="button" className={tab === 'versions' ? 'tab tab-active' : 'tab'} onClick={() => setTab('versions')}>
          Versions
        </button>
      </div>

      {tab === 'detail' ? (
        <>
          <Field label="Name">
            <CopyToken value={agent.name} />
          </Field>
          <Field label="Binding tag">
            <CopyToken value={agent.binding_tag} />
          </Field>
          <Field label="Current version">v{agent.current_version}</Field>
          {record.data ? (
            <>
              <Field label="Mode">{record.data.resolved_snapshot.mode}</Field>
              <DrawerSection title="Resolved tools">
                <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                  {record.data.resolved_snapshot.tools.map((tool) => (
                    <span key={tool} className="capability-chip">
                      {tool}
                    </span>
                  ))}
                </div>
              </DrawerSection>
              <DrawerSection title="Budgets">
                {Object.entries(record.data.resolved_snapshot.budgets).map(([key, value]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between' }} className="text-body-sm">
                    <span style={{ color: 'var(--fg-muted)' }}>{key}</span>
                    <span className="counter">{value}</span>
                  </div>
                ))}
              </DrawerSection>
            </>
          ) : null}
          {(agent.warnings?.length ?? 0) > 0 ? (
            <DrawerSection title="Warnings">
              {agent.warnings?.map((warning) => (
                <p key={warning} className="text-body-sm" style={{ color: 'var(--status-warn)', margin: '0 0 var(--space-2)' }}>
                  {warning}
                </p>
              ))}
            </DrawerSection>
          ) : null}
        </>
      ) : (
        <AgentVersionHistory
          agentId={agent.agent_id}
          currentVersion={agent.current_version}
          onVersionCreated={onReload}
        />
      )}
    </DetailDrawer>
  );
}
