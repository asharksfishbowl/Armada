/**
 * TrainingPage — DELIBERATELY NOT BUILT IN THIS PHASE.
 *
 * build-plan Requirements 21/22 and the P9 scope fence: "This phase does not ship
 * `TrainingPage`, ModelsPage's adapter table, `GET /training/runs`, `GET /adapters`, or
 * `GET /datasets`. Those move to P11 under Requirement 21." They move WITH THEIR
 * PRODUCERS — the endpoints exist, but the training pipeline that fills them does not, so
 * a table built now would be verified only against an empty table, which is a shape test
 * rather than a test.
 *
 * WHY THIS FILE EXISTS AT ALL RATHER THAN THE RAIL HAVING FIVE ITEMS. Requirement 34 fixes
 * the navigation to six destinations ordered to teach the pipeline: Corpora → Training →
 * Models → Agents → Teams → Runs. Dropping Training would break the sequence that ordering
 * exists to communicate, and the operator would learn a five-stage pipeline that is wrong.
 * So the destination is real and the page states plainly what is not built, which is the
 * honest form of an unavailable surface.
 *
 * It renders no fabricated rows, calls no endpoint, and claims nothing about how many
 * training runs exist.
 */

import { PageHeader } from '../components/AppShell';
import { EmptyState } from '../components/EmptyState';

export function TrainingPage() {
  return (
    <>
      <PageHeader title="Training" />
      <EmptyState
        headline="Training is not part of this build."
        why={
          <>
            The training pipeline — dataset construction, the LoRA backends, the evaluation gate,
            and the stage rail that renders their progress — lands as one unit with the endpoints
            that serve it. This page is not showing an empty list of training runs, because it has
            not asked: presenting “no training runs” as a fact would be a claim nothing here has
            verified. Corpora and Models are built and usable now.
          </>
        }
      />
    </>
  );
}
