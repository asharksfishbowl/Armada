/**
 * AgentVersionHistory — design-dashboard.md Requirements 107-110, 132, edge cases 17-20.
 *
 * A DRAWER TAB, NOT A ROUTE (Requirement 132): 24px version rows, selecting two turns the
 * tab into a side-by-side read-only diff of the `definition`. Each row shows its RUN COUNT,
 * so versions read as load-bearing history rather than as a changelog (Requirement 107).
 *
 * THERE IS NO VERSION-LIST ENDPOINT. The daemon exposes `current_version` plus
 * `GET /api/agents/{id}?version=n` point lookups and nothing else — no
 * `/api/agents/{id}/versions`. So this walks 1..current_version. That is N requests for N
 * versions, which is acceptable for a single-operator console where N is small, and it is
 * honest: the alternative would be inventing an endpoint or showing only the current
 * version and calling it history.
 *
 * RUN COUNTS ARE COUNTED FROM `GET /api/runs?agent_id=`, WHICH IS PAGINATED. The count
 * shown is therefore "runs on the most recent page", and the component says so rather than
 * presenting a truncated count as a total. A wrong number rendered confidently is worse
 * than a qualified one.
 *
 * REQUIREMENT 110 CANNOT BE BUILT AS WRITTEN, and this is the honest version.
 * R110 asks for a before/after table shown BEFORE a version is created. But
 * `POST /api/agents/{id}/refresh-bindings` has no dry-run mode: it commits and returns
 * `{changed, version, changed_fields, warnings}`. There is no request that answers "what
 * WOULD change". So:
 *   - `changed: false` -> no dialog, an inline toast naming the unchanged current version.
 *     This satisfies R110's second half and edge case 18 exactly.
 *   - `changed: true`  -> the new version is already created, and the changed-field list
 *     renders as a POST-HOC diff naming the version that WAS created.
 * The requirement's "a version is never created silently" is honoured — the operator
 * confirms first, and the result names the version. The requirement's "before" is not, and
 * cannot be without a dry-run parameter on the endpoint.
 */

import { useState } from 'react';

import { Toast, type ToastMessage } from './Toast';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyToken } from './CopyToken';
import { StatusChip } from './StatusChip';
import { refreshAgentBindings, fetchAgentVersion, fetchRuns, type AgentVersionRecord } from '../lib/api';
import { useAction, useResource } from '../lib/useResource';
import { jsonToYaml } from '../lib/yaml-anchor';

export interface AgentVersionHistoryProps {
  agentId: string;
  currentVersion: number;
  onVersionCreated: () => void;
}

export function AgentVersionHistory({ agentId, currentVersion, onVersionCreated }: AgentVersionHistoryProps) {
  const [selected, setSelected] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [diff, setDiff] = useState<{ version: number; fields: string[] } | null>(null);

  const versions = useResource(
    () =>
      Promise.all(
        Array.from({ length: currentVersion }, (_, index) => fetchAgentVersion(agentId, index + 1)),
      ),
    [agentId, currentVersion],
  );

  const runs = useResource(() => fetchRuns({ agent_id: agentId, limit: 200 }), [agentId]);

  const refresh = useAction(async () => {
    const result = await refreshAgentBindings(agentId);
    setConfirming(false);
    if (!result.changed) {
      // Requirement 110 / edge case 18 — no dialog, no version, an inline toast.
      setToast({
        tone: 'info',
        text: `Bindings are unchanged. The agent remains at version ${result.version}.`,
      });
      return result;
    }
    setDiff({ version: result.version, fields: result.changed_fields });
    onVersionCreated();
    return result;
  });

  const runCountFor = (version: number) =>
    (runs.data?.runs ?? []).filter((run) => run.version === version).length;

  const pair = selected.length === 2 ? selected.slice().sort((a, b) => a - b) : null;

  return (
    <div>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      {diff ? (
        <div className="panel" style={{ padding: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <div className="text-body-sm" style={{ color: 'var(--fg)' }}>
            Version {diff.version} was created. Fields that changed:
          </div>
          <ul className="text-mono-body" style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.2em', color: 'var(--fg-muted)' }}>
            {diff.fields.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{ marginBottom: 'var(--space-4)' }}>
        {versions.data?.slice().reverse().map((record) => (
          <VersionRow
            key={record.version}
            record={record}
            isCurrent={record.version === currentVersion}
            runCount={runCountFor(record.version)}
            selected={selected.includes(record.version)}
            onToggle={() =>
              setSelected((current) =>
                current.includes(record.version)
                  ? current.filter((v) => v !== record.version)
                  : [...current, record.version].slice(-2),
              )
            }
          />
        ))}
        {runs.data?.next_cursor ? (
          <p className="text-micro" style={{ color: 'var(--fg-dim)', margin: 'var(--space-2) 0 0' }}>
            Run counts are from the most recent 200 runs and may undercount older versions.
          </p>
        ) : null}
      </div>

      {/* Requirement 109: refresh-bindings is ABSENT, not disabled, on a non-current
          version. Offering it while viewing an older version would misrepresent what it
          does — it acts on the current definition and creates a new version from it. */}
      {selected.length === 1 && selected[0] !== currentVersion ? (
        <p className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
          This view is read-only. Refresh bindings acts on the current version, v{currentVersion}.
        </p>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={refresh.pending}>
          Refresh bindings
        </button>
      )}

      {pair ? (
        <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
          {pair.map((version) => {
            const record = versions.data?.find((entry) => entry.version === version);
            return (
              <pre
                key={version}
                className="panel text-mono-body"
                style={{ flex: 1, padding: 'var(--space-3)', overflow: 'auto', maxHeight: '360px', margin: 0 }}
              >
                {`# v${version}\n${record ? jsonToYaml(record.definition) : ''}`}
              </pre>
            );
          })}
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Refresh bindings for this agent?`}
          removed={
            <>
              Nothing. Refresh re-resolves the current definition against the registry and, if
              anything resolved differently, creates version {currentVersion + 1}.
            </>
          }
          retained={
            <>
              Every existing version and every run. Runs are pinned to the version they executed
              against and are never affected by a refresh (invariant 2).
            </>
          }
          breaks={
            <>
              Nothing directly. This endpoint has no dry-run, so the changed-field list can only be
              shown after the call — if anything changed, version {currentVersion + 1} will already
              exist when you see it.
            </>
          }
          confirmLabel="Refresh bindings"
          pending={refresh.pending}
          onConfirm={() => void refresh.run()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

function VersionRow({
  record,
  isCurrent,
  runCount,
  selected,
  onToggle,
}: {
  record: AgentVersionRecord;
  isCurrent: boolean;
  runCount: number;
  selected: boolean;
  onToggle: () => void;
}) {
  // Requirement 72 / edge case 17: warnings persist beyond the edit session. Agent
  // Definition R24 captures `warnings` onto the resolved_snapshot, so the same amber chips
  // render permanently against the version that was saved under them.
  const warnings = record.resolved_snapshot?.warnings ?? [];

  return (
    <div
      className="row"
      onClick={onToggle}
      style={{
        height: 'var(--row-tree)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: '0 var(--space-2)',
        cursor: 'pointer',
        background: selected ? 'var(--surface-4)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      <span className="text-mono-body" style={{ color: 'var(--fg)', width: '48px' }}>
        v{record.version}
      </span>
      {isCurrent ? (
        <span className="text-micro" style={{ color: 'var(--fg-muted)' }}>
          current
        </span>
      ) : null}
      <span className="text-micro counter" style={{ color: 'var(--fg-muted)' }}>
        {runCount} run{runCount === 1 ? '' : 's'}
      </span>
      <div style={{ flex: 1 }} />
      {warnings.length > 0 ? (
        <StatusChip
          status={{ hue: '--status-warn', mark: 'disc-hollow', label: `${warnings.length} WARNING` }}
          title={warnings.join('\n')}
        />
      ) : null}
      <CopyToken value={record.resolved_snapshot?.binding_tag ?? ''} />
    </div>
  );
}
