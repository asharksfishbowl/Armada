/**
 * Pinned-binding liveness — Agent Runtime R17, R17a, R18, R18a, R18b; build-plan Req 9.
 *
 * ── LIVENESS ONLY. NEVER RE-RESOLUTION (invariant 2) ────────────────────────
 * The Run reads `binding_tag`, `context_window` and `tool_format` from the Agent version's
 * PINNED resolved_snapshot and asks forge one question: is that tag still usable? It does
 * NOT ask which binding the Agent should have. Re-resolving would mean a newly promoted
 * Adapter silently changed an existing Agent's behaviour — which is exactly what
 * refresh-bindings exists to make deliberate and auditable (R17a).
 *
 * ── D4: `materialized` IS PART OF THE CHECK ─────────────────────────────────
 * Registration and materialization are separate (Training R4c), so a binding can be
 * `promoted` with no weights present. The original check tested only presence and status,
 * which such a binding PASSES — and the Run would then block behind a multi-gigabyte
 * transfer with no indication why.
 *
 * R18b makes that a fail-fast: the Run fails at start, naming the tag AND the action that
 * fixes it, with NO SANDBOX ACQUIRED. Failing before provisioning matters — an acquired
 * container for a Run that cannot proceed is an orphan waiting to happen.
 */

export interface PinnedBinding {
  binding_tag: string;
  context_window: number;
  tool_format: 'json_schema' | 'hermes';
}

/** The subset of forge's GET /models/bindings this check reads. */
export interface LiveBinding {
  tag: string;
  status: 'promoted' | 'retired' | 'missing';
  materialized: boolean;
  materialization_status: string;
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Verify a pinned tag against what forge currently reports.
 *
 * `bindings` is the whole list from one GET; passing it in rather than fetching here keeps
 * this pure and makes every branch unit-testable without a network.
 */
export function verifyPinnedBinding(
  pinned: PinnedBinding,
  bindings: LiveBinding[],
): VerificationResult {
  const live = bindings.find((b) => b.tag === pinned.binding_tag);

  // R18 — absent. The Adapter or shortlist entry behind it is gone.
  if (!live) {
    return {
      ok: false,
      error:
        `the pinned ModelBinding \`${pinned.binding_tag}\` no longer exists. ` +
        'Call POST /api/agents/{agent_id}/refresh-bindings to adopt a current binding.',
    };
  }

  // R18 — present but not servable. Naming the observed status matters: `retired` means an
  // operator removed a shortlist entry, `missing` means armada-models lost a model that
  // the database still believes is promoted. Different causes, different fixes.
  if (live.status !== 'promoted') {
    return {
      ok: false,
      error:
        `the pinned ModelBinding \`${pinned.binding_tag}\` has status \`${live.status}\` ` +
        'and cannot serve a Run.' +
        (live.status === 'retired'
          ? ' It was removed from config/base-models.yaml.'
          : ' armada-models no longer reports this model.'),
    };
  }

  // R18b / build-plan Req 9 — THE FAIL-FAST. Promoted but unmaterialized.
  if (!live.materialized) {
    return {
      ok: false,
      error:
        `the pinned ModelBinding \`${pinned.binding_tag}\` is promoted but NOT materialized ` +
        `(materialization_status: ${live.materialization_status}), so it cannot answer. ` +
        `Run \`POST /models/bindings/${pinned.binding_tag}/materialize\` and retry. ` +
        'The Run is failed here rather than started, so it does not block behind a ' +
        'multi-gigabyte transfer.',
    };
  }

  return { ok: true };
}

/**
 * R18a — forge unreachable.
 *
 * The daemon does NOT proceed on an unverified binding. Starting a Run against a tag that
 * might be retired would burn a sandbox and a model call to discover what one failed HTTP
 * call already told us.
 */
export function forgeUnreachableError(detail: string): string {
  return (
    `armada-forge is unreachable, so the pinned ModelBinding could not be verified: ${detail}. ` +
    'The Run is failed rather than started against an unverified binding.'
  );
}
