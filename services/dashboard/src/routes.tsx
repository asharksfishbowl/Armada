/**
 * THE ROUTE MANIFEST — the single place that says what this application renders.
 *
 * WHY THIS IS DATA AND NOT JSX. This repo has now shipped SEVEN components that were
 * written, unit-tested, and never called — the most recent being a ModelScheduler that
 * enforced nothing. A page component is exactly that failure waiting to happen: it
 * compiles, its logic tests pass, and it is unreachable because nobody added the `<Route>`.
 *
 * Expressing the routes as an array means `src/__tests__/routes.test.ts` can assert that
 * every page module is mounted, that every navigation destination resolves to a real
 * route, and that App.tsx renders the whole manifest rather than a hand-picked subset. A
 * page added here but never rendered fails the suite; a page rendered but missing from
 * here fails it too. That is the thing that breaks when the wiring breaks.
 *
 * ROUTES vs DRAWERS (Requirements 38-40). Selecting a row opens a 480px drawer that
 * overlays the list — NOT a route change — because every entity in Armada is inspected
 * while something else is running, and navigating away destroys that context. There are
 * exactly two kinds of full-width route exception: the four editor routes of Requirement
 * 40a, and run inspection at `/runs/:runId`.
 */

import type { ComponentType } from 'react';

import { AgentsPage } from './pages/AgentsPage';
import { CorporaPage } from './pages/CorporaPage';
import { ModelsPage } from './pages/ModelsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { TeamsPage } from './pages/TeamsPage';
import { TrainingPage } from './pages/TrainingPage';
import { AgentEditor } from './components/AgentEditor';
import { TeamEditor } from './components/TeamEditor';

export interface RouteEntry {
  path: string;
  element: ComponentType;
  /** Editor routes and run inspection render full width with no list behind them. */
  kind: 'list' | 'editor' | 'detail';
}

/**
 * Requirement 34 — navigation destinations are ordered to TEACH THE PLATFORM'S PIPELINE:
 * Corpora → Training → Models → Agents → Teams → Runs. The order is the product's own data
 * flow, so an operator learns the architecture by reading the rail top to bottom. Do not
 * reorder alphabetically.
 *
 * Six destinations, not seven: the health strip of Requirement 35a is CHROME on the rail,
 * not a destination (Requirement 35c).
 */
export const NAV_DESTINATIONS: readonly { path: string; label: string }[] = [
  { path: '/corpora', label: 'Corpora' },
  { path: '/training', label: 'Training' },
  { path: '/models', label: 'Models' },
  { path: '/agents', label: 'Agents' },
  { path: '/teams', label: 'Teams' },
  { path: '/runs', label: 'Runs' },
];

/**
 * Requirement 40a — the editor routes are EXACTLY four. They are routes rather than
 * drawers because a YAML editor plus a 320px problems panel does not fit in 480px.
 */
export const EDITOR_PATHS: readonly string[] = [
  '/agents/new',
  '/agents/:agentId/edit',
  '/teams/new',
  '/teams/:teamId/edit',
];

export const ROUTES: readonly RouteEntry[] = [
  { path: '/corpora', element: CorporaPage, kind: 'list' },
  { path: '/training', element: TrainingPage, kind: 'list' },
  { path: '/models', element: ModelsPage, kind: 'list' },

  { path: '/agents', element: AgentsPage, kind: 'list' },
  // Declared BEFORE the parameterised edit route for the same reason the forge declares
  // `/datasets/supplied` before `/datasets/{dataset_id}`: a literal must not be swallowed
  // by a pattern. React Router ranks rather than matching in order, so this is defensive
  // rather than load-bearing — but the ordering states the intent.
  { path: '/agents/new', element: AgentEditor, kind: 'editor' },
  { path: '/agents/:agentId/edit', element: AgentEditor, kind: 'editor' },

  { path: '/teams', element: TeamsPage, kind: 'list' },
  { path: '/teams/new', element: TeamEditor, kind: 'editor' },
  { path: '/teams/:teamId/edit', element: TeamEditor, kind: 'editor' },

  { path: '/runs', element: RunsPage, kind: 'list' },
  { path: '/runs/:runId', element: RunDetailPage, kind: 'detail' },
];
