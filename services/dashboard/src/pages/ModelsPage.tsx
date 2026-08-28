/**
 * ModelsPage — design-dashboard.md Requirements 129, 29, 30, 97; build-plan Requirements
 * 10-14.
 *
 * SCOPE FENCE: THIS PHASE SHIPS THE BaseModel SHORTLIST TABLE ONLY. build-plan Requirements
 * 21/22 move the ADAPTER table, `GET /adapters`, `GET /training/runs`, and `GET /datasets`
 * to P11 with their producers. Requirement 129 describes two stacked tables; the lower one
 * is deliberately absent here rather than stubbed, and the note below the table says so —
 * an empty adapter table would assert "no adapters exist", which is a claim this phase has
 * not asked the server and cannot make.
 *
 * REQUIREMENT 129'S FIVE COLUMNS ALL RENDER, and two of them are the reason this phase
 * touched forge. `base_model_id`, `context_window`, and base binding status come from
 * `GET /models/bindings`, which reads the `model_bindings` table. `quantization` and
 * `smoke_test` are properties of `config/base-models.yaml` that are NEVER written to that
 * table — so no join could recover them, and the choice was to add a read-only
 * `GET /models/base` or to render two columns as permanently unavailable. The endpoint was
 * the smaller lie.
 *
 * MATERIALIZATION USES THE INLINE-ROW TREATMENT (build-plan Requirement 10), not the
 * training stage rail: it is single-stage, and a one-segment rail is dead chrome. The
 * `Download · {n} GB` cell becomes a 2px progress line in place, then the achromatic
 * `local` flag chip (Requirement 11).
 *
 * A FAILED MATERIALIZATION RENDERS AMBER, NOT RED (build-plan Requirement 13). A failed
 * pull is a recoverable environment condition, not a system fault, and --status-fault stays
 * reserved. The cell reverts to `Download` with `retry · last attempt failed`.
 */

import { PageHeader } from '../components/AppShell';
import { CopyToken } from '../components/CopyToken';
import { EmptyState, LoadError } from '../components/EmptyState';
import { FlagChip, StatusChip } from '../components/StatusChip';
import { BINDING_STATUS, type BindingState } from '../lib/status';
import { fetchBaseModels, fetchBindings, materializeBinding, type BindingRow } from '../lib/api';
import { useAction, useResource } from '../lib/useResource';
import { isJobRunning, progressFraction, useForgeProgress } from '../lib/useForgeProgress';
import { relativeTime } from '../lib/format';

export function ModelsPage() {
  const shortlist = useResource(fetchBaseModels, []);
  const bindings = useResource(fetchBindings, []);
  const progress = useForgeProgress();

  const materialize = useAction(async (tag: string) => {
    await materializeBinding(tag);
    bindings.reload();
  });

  if (shortlist.error) {
    return <LoadError what="the BaseModel shortlist" error={shortlist.error} onRetry={shortlist.reload} />;
  }
  if (bindings.error) {
    return <LoadError what="model bindings" error={bindings.error} onRetry={bindings.reload} />;
  }

  const rows = shortlist.data ?? [];
  const bindingByTag = new Map((bindings.data ?? []).map((binding) => [binding.tag, binding]));

  return (
    <>
      <PageHeader title="Models" count={rows.length} />

      {shortlist.loading ? (
        <p className="text-body">Loading…</p>
      ) : rows.length === 0 ? (
        // Requirement 97 says Models is NEVER empty — R4a registers one base binding per
        // shortlist entry at startup. Reaching this state means the shortlist itself is
        // empty, which forge's own startup validation rejects, so it is reported as the
        // anomaly it is rather than as a normal empty page.
        <EmptyState
          headline="The BaseModel shortlist is empty."
          why="config/base-models.yaml requires at least one entry and armada-forge refuses to start without one, so an empty shortlist here means the dashboard is talking to a forge that did not load its config."
        />
      ) : (
        <>
          <h2 className="text-section" style={{ margin: '0 0 var(--space-3)' }}>
            BaseModel shortlist
          </h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>base_model_id</th>
                <th style={{ width: '130px' }}>Context window</th>
                <th style={{ width: '120px' }}>Quantization</th>
                <th style={{ width: '110px' }}>Smoke test</th>
                <th style={{ width: '150px' }}>Binding status</th>
                <th style={{ width: '240px' }}>Weights</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((model) => {
                const binding = bindingByTag.get(model.base_tag);
                const job = progress.materialization[model.base_tag];
                return (
                  <tr
                    key={model.base_model_id}
                    className="row"
                    // Requirement 29 — a `missing` binding carries a 2px fault row edge.
                    style={
                      binding?.status === 'missing'
                        ? { boxShadow: 'inset 2px 0 0 var(--status-fault)' }
                        : undefined
                    }
                  >
                    <td>
                      <CopyToken value={model.base_model_id} />
                    </td>
                    <td className="counter">{model.context_window.toLocaleString()}</td>
                    <td>
                      <FlagChip>{model.quantization}</FlagChip>
                    </td>
                    <td>
                      {model.smoke_test ? (
                        <FlagChip>smoke</FlagChip>
                      ) : (
                        <span style={{ color: 'var(--fg-dim)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {binding ? (
                        <span
                          style={
                            // Requirement 29 — a `retired` binding's tag renders struck
                            // through. Applied to the chip's row cell so the tag below
                            // carries it too.
                            binding.status === 'retired' ? { textDecoration: 'line-through' } : undefined
                          }
                        >
                          <StatusChip status={BINDING_STATUS[(binding.status as BindingState) ?? 'promoted']} />
                        </span>
                      ) : (
                        <span style={{ color: 'var(--fg-dim)' }}>not registered</span>
                      )}
                    </td>
                    <td>
                      <WeightsCell
                        binding={binding}
                        tag={model.base_tag}
                        minDiskGb={model.min_disk_gb}
                        job={job}
                        onMaterialize={() => void materialize.run(model.base_tag)}
                        pending={materialize.pending}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {(bindings.data ?? []).some((binding) => binding.status === 'missing') ? (
            <p className="text-body-sm" style={{ color: 'var(--status-fault)', marginTop: 'var(--space-3)' }}>
              A binding is recorded as promoted while armada-models does not serve it. This is the
              only status in the platform that is never an expected state, and it is the only one
              that raises a badge on the navigation rail.
            </p>
          ) : null}

          {/* The scope fence, stated to the operator rather than left as a blank region. */}
          <p className="text-body-sm" style={{ color: 'var(--fg-muted)', marginTop: 'var(--space-8)' }}>
            The Adapter table is not part of this build. Adapters come from training runs, and the
            endpoints that list them ship with the training pipeline. This page is deliberately not
            showing an empty adapter table, because that would assert no adapters exist — a claim
            nothing here has asked the server.
          </p>
        </>
      )}
    </>
  );
}

function WeightsCell({
  binding,
  tag,
  minDiskGb,
  job,
  onMaterialize,
  pending,
}: {
  binding: BindingRow | undefined;
  tag: string;
  minDiskGb: number;
  job: ReturnType<typeof useForgeProgress>['materialization'][string] | undefined;
  onMaterialize: () => void;
  pending: boolean;
}) {
  const running = isJobRunning(job) || binding?.materialization_status === 'materializing';
  const fraction = progressFraction(job);

  if (binding?.materialized && !running) {
    // Requirement 11 — on completion the cell becomes the achromatic `local` flag chip and
    // all motion stops. Achromatic because "the weights are here" is not a status.
    return <FlagChip>local</FlagChip>;
  }

  if (running) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <span className="text-micro counter" style={{ color: 'var(--fg-muted)' }}>
          {fraction === null
            ? 'downloading'
            : `downloading · ${(((job?.completed ?? 0) / 1024 ** 3)).toFixed(1)} / ${(((job?.total ?? 0) / 1024 ** 3)).toFixed(1)} GB`}
        </span>
        {fraction === null ? null : (
          <span className="progress-line" style={{ ['--progress' as string]: `${Math.round(fraction * 100)}%` }} />
        )}
        {/* build-plan Requirement 12 — the staleness timestamp matters MORE here than for
            training, because the forge channel is lossy: a stalled download and a dropped
            message are indistinguishable without it. */}
        <span className="text-micro" style={{ color: 'var(--fg-dim)' }}>
          last update {relativeTime(job?.lastUpdate)} ago
        </span>
      </div>
    );
  }

  const failed =
    binding?.materialization_status === 'failed' || job?.status === 'failed' || binding?.materialization_error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <button type="button" className="btn btn-quiet" onClick={onMaterialize} disabled={pending} title={tag}>
        Download · ~{minDiskGb} GB
      </button>
      {failed ? (
        // build-plan Requirement 13 — AMBER, not red. A failed pull is a recoverable
        // environment condition; --status-fault stays reserved for a system fault.
        <span className="text-micro" style={{ color: 'var(--status-warn)' }}>
          retry · last attempt failed
        </span>
      ) : null}
    </div>
  );
}
