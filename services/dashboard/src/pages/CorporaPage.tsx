/**
 * CorporaPage — design-dashboard.md Requirements 125-127, 97, 101, edge cases 29-31, 33.
 *
 * Columns (Requirement 125): name (monospace), description, source count, chunk count, last
 * ingested. Selecting a row opens a drawer with Sources and Ingestion history.
 *
 * INGESTION PROGRESS RENDERS INLINE IN THE ROW (Requirement 126), replacing the chunk-count
 * cell with a 2px progress line and a running chip — not a toast and not a drawer, because
 * the operator triggers an ingest, navigates away, and comes back to that row.
 *
 * A PROGRESS BAR THAT CANNOT MOVE IS NEVER RENDERED (Requirement 127). Dependency ruling 4
 * makes the live channel the specified path and forge does emit ingestion frames, so the
 * bar is real. But when no frame has arrived — the socket is down, or the job started
 * before this page loaded — there is no denominator, and the row falls back to the degraded
 * form: a running chip with `started {duration} ago` and no bar. That is Requirement 127
 * doing its job rather than being unused.
 *
 * THE FIRST-RUN STATE IS NOT EMPTY (Requirement 97). Agent Definition R36 seeds
 * `frontend-docs` and `recipes` with ZERO sources. Each row's chunk-count cell renders
 * `0 chunks` in --status-warn at weight 400 with an inline `Add source` action, and a hint
 * bar above the table explains that retrieval returns nothing until a source is added and
 * ingested. An empty-state component here would be wrong — the table has rows.
 */

import { useState } from 'react';

import { PageHeader } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyToken } from '../components/CopyToken';
import { DetailDrawer, DrawerSection, Field } from '../components/DetailDrawer';
import { EmptyState, HintBar, LoadError, PrimaryAction } from '../components/EmptyState';
import { StatusChip } from '../components/StatusChip';
import { Toast, type ToastMessage } from '../components/Toast';
import {
  ApiError,
  addSource,
  createCorpus,
  deleteCorpus,
  fetchAgents,
  fetchCorpora,
  fetchCorpus,
  fetchIngestionJobs,
  startIngest,
  type CorpusListRow,
} from '../lib/api';
import { useAction, useResource } from '../lib/useResource';
import { isJobRunning, progressFraction, useForgeProgress } from '../lib/useForgeProgress';
import { relativeTime } from '../lib/format';

export function CorporaPage() {
  const corpora = useResource(fetchCorpora, []);
  const agents = useResource(fetchAgents, []);
  const progress = useForgeProgress();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CorpusListRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [creating, setCreating] = useState(false);

  const ingest = useAction(async (corpusId: string) => {
    try {
      await startIngest(corpusId);
      corpora.reload();
    } catch (err) {
      // Edge case 30 — a second ingest against a corpus that already has one in flight
      // returns 409 naming the in-flight job_id. INLINE TOAST, not an error modal: it is a
      // normal race with a defined outcome, not a fault.
      if (err instanceof ApiError && err.status === 409) {
        setToast({ tone: 'warn', text: String((err.body as { detail?: unknown })?.detail ?? err.message) });
        return;
      }
      throw err;
    }
  });

  const remove = useAction(async (corpusId: string) => {
    await deleteCorpus(corpusId);
    setDeleting(null);
    setSelectedId(null);
    corpora.reload();
  });

  if (corpora.error) {
    return <LoadError what="corpora" error={corpora.error} onRetry={corpora.reload} />;
  }

  const rows = corpora.data ?? [];
  const sourceless = rows.filter((row) => row.source_count === 0);

  return (
    <>
      <PageHeader
        title="Corpora"
        count={rows.length}
        action={<PrimaryAction label="New corpus" onClick={() => setCreating(true)} />}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      {sourceless.length > 0 ? (
        <HintBar>
          {sourceless.length} corpus{sourceless.length === 1 ? '' : 'es'} exist with no sources.
          Retrieval against {sourceless.length === 1 ? 'it' : 'them'} returns nothing until a source
          is added and ingested — an agent bound to one will run and simply retrieve zero chunks.
        </HintBar>
      ) : null}

      {corpora.loading ? (
        <p className="text-body">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          headline="No corpora."
          why="A corpus carries the domain knowledge an agent retrieves at run time. Nothing else on the platform can be built until one exists."
          action={<PrimaryAction label="New corpus" onClick={() => setCreating(true)} />}
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th style={{ width: '90px' }}>Sources</th>
              <th style={{ width: '200px' }}>Chunks</th>
              <th style={{ width: '160px' }}>Last ingested</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const job = progress.ingestion[row.corpus_id];
              const running = isJobRunning(job);
              const fraction = progressFraction(job);
              return (
                <tr
                  key={row.corpus_id}
                  className={`row${selectedId === row.corpus_id ? ' row-selected' : ''}`}
                  onClick={() => setSelectedId(row.corpus_id)}
                >
                  <td>
                    <CopyToken value={row.name} />
                  </td>
                  <td style={{ color: 'var(--fg-muted)' }}>{row.description || '—'}</td>
                  <td className="counter">{row.source_count}</td>
                  <td>
                    {running ? (
                      // Requirement 126 — inline, in place of the chunk count.
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                        <StatusChip status={{ hue: '--status-live', mark: 'disc-half', label: 'INGESTING', rotating: true }} />
                        {fraction === null ? (
                          // Requirement 127's degraded form. NO BAR — there is no
                          // denominator, and a stationary bar would be a lie.
                          <span className="text-micro" style={{ color: 'var(--fg-dim)' }}>
                            started {relativeTime(job?.lastUpdate)} ago
                          </span>
                        ) : (
                          <span
                            className="progress-line"
                            style={{ ['--progress' as string]: `${Math.round(fraction * 100)}%` }}
                          />
                        )}
                      </div>
                    ) : row.chunk_count === 0 ? (
                      // Requirement 97 — amber at weight 400 with an inline action.
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <span style={{ color: 'var(--status-warn)', fontWeight: 400 }}>0 chunks</span>
                        <button
                          type="button"
                          className="btn btn-quiet"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(row.corpus_id);
                          }}
                        >
                          Add source
                        </button>
                      </span>
                    ) : (
                      <span className="counter">{row.chunk_count.toLocaleString()} chunks</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--fg-dim)' }}>
                    {row.last_ingested_at ? `${relativeTime(Date.parse(row.last_ingested_at))} ago` : 'never'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedId ? (
        <CorpusDrawer
          corpusId={selectedId}
          onClose={() => setSelectedId(null)}
          onIngest={() => void ingest.run(selectedId)}
          onDelete={(row) => setDeleting(row)}
          onChanged={corpora.reload}
        />
      ) : null}

      {creating ? (
        <NewCorpusDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            corpora.reload();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete corpus ${deleting.name}?`}
          // Requirement 101, and edge case 33 — every affected agent listed BY NAME before
          // the operator can confirm.
          removed={<>The corpus and its {deleting.chunk_count.toLocaleString()} chunks.</>}
          retained={
            <>
              Adapters trained from this corpus keep serving and their binding tags are unaffected.
              Runs against already-pinned agent versions still start; they simply retrieve nothing.
            </>
          }
          breaks={(() => {
            const bound = (agents.data ?? []).filter(
              (agent) => agent.warnings?.some((warning) => warning.includes(deleting.name)) ?? false,
            );
            return bound.length === 0 ? (
              <>No agent currently reports a binding to this corpus.</>
            ) : (
              <>
                These agents reference it and will fail validation on their next save or refresh:{' '}
                {bound.map((agent) => agent.name).join(', ')}.
              </>
            );
          })()}
          confirmLabel="Delete corpus"
          // Requirement 101 — confirmation is proportional to reversibility, and this one
          // destroys embeddings that must be recomputed. Type the name.
          typeToConfirm={deleting.name}
          pending={remove.pending}
          onConfirm={() => void remove.run(deleting.corpus_id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

function CorpusDrawer({
  corpusId,
  onClose,
  onIngest,
  onDelete,
  onChanged,
}: {
  corpusId: string;
  onClose: () => void;
  onIngest: () => void;
  onDelete: (row: CorpusListRow) => void;
  onChanged: () => void;
}) {
  const detail = useResource(() => fetchCorpus(corpusId), [corpusId]);
  const jobs = useResource(() => fetchIngestionJobs(corpusId), [corpusId]);
  const [tab, setTab] = useState<'sources' | 'history'>('sources');
  const [location, setLocation] = useState('');
  const [type, setType] = useState('directory');

  const add = useAction(async () => {
    await addSource(corpusId, { type, location });
    setLocation('');
    detail.reload();
    onChanged();
  });

  const data = detail.data;

  return (
    <DetailDrawer
      title={data?.name ?? 'Corpus'}
      subtitle={data?.description}
      onClose={onClose}
      safeActions={
        <button type="button" className="btn" onClick={onIngest}>
          Ingest
        </button>
      }
      destructiveActions={
        data ? (
          <button type="button" className="btn btn-destructive" onClick={() => onDelete(data)}>
            Delete
          </button>
        ) : null
      }
    >
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        <button type="button" className={tab === 'sources' ? 'tab tab-active' : 'tab'} onClick={() => setTab('sources')}>
          Sources
        </button>
        <button type="button" className={tab === 'history' ? 'tab tab-active' : 'tab'} onClick={() => setTab('history')}>
          Ingestion history
        </button>
      </div>

      {tab === 'sources' ? (
        <>
          <DrawerSection title="Sources">
            {(data?.sources ?? []).length === 0 ? (
              <p className="text-body-sm" style={{ color: 'var(--status-warn)' }}>
                No sources. This corpus has nothing to ingest, so retrieval against it returns nothing.
              </p>
            ) : (
              data?.sources.map((source) => (
                <div key={source.source_id} style={{ marginBottom: 'var(--space-3)' }}>
                  <Field label={source.type}>
                    <CopyToken value={source.location} />
                  </Field>
                  {source.include_globs.length > 0 ? (
                    <div className="text-micro" style={{ color: 'var(--fg-dim)' }}>
                      include: {source.include_globs.join(', ')}
                    </div>
                  ) : null}
                  {source.exclude_globs.length > 0 ? (
                    <div className="text-micro" style={{ color: 'var(--fg-dim)' }}>
                      exclude: {source.exclude_globs.join(', ')}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </DrawerSection>

          <DrawerSection title="Add source">
            <select className="input" value={type} onChange={(event) => setType(event.target.value)} style={{ width: '100%', marginBottom: 'var(--space-2)' }}>
              <option value="directory">directory</option>
              <option value="git">git</option>
              <option value="web">web</option>
              <option value="upload">upload</option>
            </select>
            <input
              className="input"
              value={location}
              placeholder="Location"
              onChange={(event) => setLocation(event.target.value)}
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 'var(--space-2)' }}
              disabled={location.trim() === '' || add.pending}
              onClick={() => void add.run()}
            >
              Add
            </button>
            {add.error ? (
              <p className="text-body-sm" style={{ color: 'var(--status-fault)' }}>
                {String((add.error as ApiError).message)}
              </p>
            ) : null}
          </DrawerSection>
        </>
      ) : (
        <DrawerSection title="Ingestion history">
          {(jobs.data ?? []).length === 0 ? (
            <p className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
              This corpus has never been ingested.
            </p>
          ) : (
            jobs.data?.map((job) => (
              <div key={job.job_id} style={{ marginBottom: 'var(--space-4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  {/* Edge case 29 — a `partial` job renders an amber hollow mark and lists
                      each failed source with its underlying error. */}
                  <StatusChip
                    status={
                      job.status === 'partial'
                        ? { hue: '--status-warn', mark: 'disc-hollow', label: 'PARTIAL' }
                        : job.status === 'failed'
                          ? { hue: '--status-fault', mark: 'triangle', label: 'FAILED' }
                          : job.status === 'running'
                            ? { hue: '--status-live', mark: 'disc-half', label: 'RUNNING', rotating: true }
                            : { hue: '--status-good', mark: 'disc-filled', label: 'COMPLETE' }
                    }
                  />
                  <span className="text-micro counter" style={{ color: 'var(--fg-muted)' }}>
                    +{job.chunks_added} / −{job.chunks_removed}
                  </span>
                  <span className="text-micro" style={{ color: 'var(--fg-dim)' }}>
                    {relativeTime(Date.parse(job.started_at))} ago
                  </span>
                </div>
                {job.source_results
                  ? Object.entries(job.source_results)
                      .filter(([, value]) => value?.status === 'failed')
                      .map(([sourceId, value]) => (
                        <div key={sourceId} className="text-mono-body" style={{ color: 'var(--status-warn)', marginTop: 'var(--space-1)' }}>
                          {String(value.location ?? sourceId)}: {String(value.error ?? 'failed')}
                        </div>
                      ))
                  : null}
                {job.error ? (
                  <div className="text-mono-body" style={{ color: 'var(--status-fault)' }}>{job.error}</div>
                ) : null}
              </div>
            ))
          )}
        </DrawerSection>
      )}
    </DetailDrawer>
  );
}

function NewCorpusDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useAction(async () => {
    await createCorpus({ name, description });
    onCreated();
  });

  // Invariant 4 — a corpus is referenced by `name` and the name is immutable. The
  // constraint is shown while typing rather than reported after submitting, because it
  // cannot be corrected later by renaming.
  const valid = /^[a-z0-9-]+$/.test(name);

  return (
    <div className="overlay-scrim" style={{ display: 'grid', placeItems: 'center', zIndex: 60 }}>
      <div role="dialog" aria-modal="true" aria-label="New corpus" className="panel" style={{ width: '480px', borderRadius: 'var(--radius-overlay)', padding: 'var(--space-6)' }}>
        <h2 className="text-section" style={{ margin: '0 0 var(--space-4)' }}>New corpus</h2>
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="corpus-name"
          onChange={(event) => setName(event.target.value)}
          style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
        />
        <p className="text-body-sm" style={{ color: valid || name === '' ? 'var(--fg-muted)' : 'var(--status-fault)' }}>
          Lowercase letters, digits, and hyphens. The name is permanent — corpora are referenced by
          name, never by id, and it cannot be changed later.
        </p>
        <input
          className="input"
          value={description}
          placeholder="Description"
          onChange={(event) => setDescription(event.target.value)}
          style={{ width: '100%', marginTop: 'var(--space-2)' }}
        />
        {create.error ? (
          <p className="text-body-sm" style={{ color: 'var(--status-fault)' }}>
            {(create.error as ApiError).message}
          </p>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-6)' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!valid || create.pending} onClick={() => void create.run()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
