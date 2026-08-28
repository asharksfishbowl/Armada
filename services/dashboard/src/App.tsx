/**
 * The application root.
 *
 * IT RENDERS THE WHOLE MANIFEST, BY ITERATION, NOT BY A HAND-WRITTEN LIST OF `<Route>`
 * ELEMENTS. That is the point: a hand-written list is where a page goes missing, and
 * `src/__tests__/routes.test.ts` asserts that this file maps over `ROUTES` rather than
 * enumerating them. If a page is added to the manifest, it is mounted here with no further
 * edit; if someone replaces this with a literal list, the test fails and says why.
 *
 * Editor routes render OUTSIDE the shell's content padding (Requirement 40a): a YAML editor
 * plus a 320px problems panel needs the full width, which is the reason they are routes
 * rather than drawers in the first place.
 */

import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { ROUTES } from './routes';

export function App() {
  return (
    <AppShell>
      <Routes>
        {/* Corpora is the root because Requirement 96 makes it the terminus of every
            empty state's directed graph — it is where an operator blocked anywhere else
            is ultimately sent. */}
        <Route path="/" element={<Navigate to="/corpora" replace />} />
        {ROUTES.map((entry) => {
          const Element = entry.element;
          return <Route key={entry.path} path={entry.path} element={<Element />} />;
        })}
        <Route path="*" element={<Navigate to="/corpora" replace />} />
      </Routes>
    </AppShell>
  );
}
