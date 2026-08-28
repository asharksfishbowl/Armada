/**
 * THE WIRING TEST.
 *
 * This repo has shipped SEVEN components that were written, unit-tested, and never called —
 * `min_ram_gb` read by nothing, `min_disk_gb` unknown to the schema, a directory validator
 * never invoked, agent routes never mounted, an agent file loader never called, and most
 * recently a ModelScheduler enforcing nothing. The forge has a test for exactly this
 * failure (`tests/test_routes_registered.py`) whose docstring says the defect keeps
 * recurring. This is the dashboard's equivalent.
 *
 * The failure mode is specific and quiet: a page module compiles, its logic tests pass, and
 * it is unreachable because nobody added the `<Route>`. Nothing else in a test suite
 * notices, because every test that imports the module directly still passes.
 *
 * So three things are asserted, and each fails on a different half of the mistake:
 *   1. Every page module in `src/pages` appears in the manifest.       (written but unrouted)
 *   2. Every navigation destination resolves to a manifest route.      (linked but unrouted)
 *   3. App.tsx renders the manifest by ITERATION, not as a literal list. (routed today,
 *      silently droppable tomorrow)
 *
 * The third is the one that keeps the other two honest. A hand-written list of `<Route>`
 * elements would satisfy 1 and 2 today and would be the exact place a future page goes
 * missing, so the shape of App.tsx is asserted rather than trusted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { sourceFile } from './source-root';
import { EDITOR_PATHS, NAV_DESTINATIONS, ROUTES } from '../routes';

test('every page module in src/pages is mounted on a route', () => {
  const pageFiles = readdirSync(sourceFile('pages'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => name.replace(/\.tsx$/, ''));

  const mounted = new Set(ROUTES.map((entry) => entry.element.name));

  for (const page of pageFiles) {
    assert.ok(
      mounted.has(page),
      `src/pages/${page}.tsx exists but is not in ROUTES. A page that compiles and is never ` +
        'rendered is this repo\'s most-repeated defect.',
    );
  }
});

test('every route entry has a real component', () => {
  for (const entry of ROUTES) {
    assert.equal(typeof entry.element, 'function', `${entry.path} has no component`);
    assert.ok(entry.element.name.length > 0, `${entry.path}'s component is anonymous`);
  }
});

test('every navigation destination resolves to a mounted route', () => {
  // Requirement 34's six destinations, in pipeline order. A nav item pointing at a path
  // with no route renders a blank page and reports nothing.
  const paths = new Set(ROUTES.map((entry) => entry.path));
  for (const destination of NAV_DESTINATIONS) {
    assert.ok(
      paths.has(destination.path),
      `nav destination ${destination.path} (${destination.label}) has no route`,
    );
  }
});

test('the navigation rail has exactly six destinations in pipeline order', () => {
  // Requirement 34 — the order teaches the platform's data flow and is not alphabetical.
  // Requirement 35c — the health strip is chrome, NOT a seventh destination.
  assert.deepEqual(
    NAV_DESTINATIONS.map((destination) => destination.label),
    ['Corpora', 'Training', 'Models', 'Agents', 'Teams', 'Runs'],
  );
});

test('there are exactly four editor routes and all are mounted (Requirement 40a)', () => {
  const editorRoutes = ROUTES.filter((entry) => entry.kind === 'editor').map((entry) => entry.path);
  assert.equal(editorRoutes.length, 4);
  assert.deepEqual([...editorRoutes].sort(), [...EDITOR_PATHS].sort());
});

test('run inspection is the only non-editor full-width route (Requirement 40)', () => {
  // "There are exactly two kinds of exception that are full-width routes rather than
  // drawers: editor routes and run inspection at /runs/:runId." Everything else is a
  // drawer over its list, because navigating away destroys the context an operator is
  // inspecting the entity from.
  const detail = ROUTES.filter((entry) => entry.kind === 'detail').map((entry) => entry.path);
  assert.deepEqual(detail, ['/runs/:runId']);
});

test('App.tsx renders the manifest by iteration rather than a literal route list', () => {
  const app = readFileSync(sourceFile('App.tsx'), 'utf8');

  assert.match(
    app,
    /ROUTES\.map\(/,
    'App.tsx must map over ROUTES. A hand-written list of <Route> elements is exactly where ' +
      'a page silently stops being mounted, and the other tests in this file would still pass.',
  );

  // Nothing may be routed that is not in the manifest, or the manifest stops being the
  // single source of truth and these assertions stop meaning anything.
  const literalPaths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
  for (const path of literalPaths) {
    assert.ok(
      path === '/' || path === '*',
      `App.tsx routes ${path} literally. Every real route belongs in src/routes.tsx.`,
    );
  }
});

test('no route path is declared twice', () => {
  const paths = ROUTES.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, `duplicate route path in the manifest: ${paths}`);
});
