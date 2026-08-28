/**
 * Entry point.
 *
 * THE THREE STYLESHEETS ARE IMPORTED HERE AND NOWHERE ELSE. No component imports CSS,
 * which is what lets `npm test` compile and run the same source files under node: a `.css`
 * import is meaningless outside a bundler, and one buried in a component would make every
 * module that transitively imports it untestable. It also keeps the token set global and
 * single-sourced, which Requirement 2's "no component introduces a colour outside that
 * set" depends on.
 *
 * This file is excluded from tsconfig.test.json for the same reason.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './styles/tokens.css';
import './styles/motion.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* BrowserRouter, not HashRouter: nginx.conf serves index.html for unknown paths, so
        a client-side route survives a page reload. The two have to agree — a HashRouter
        here would make that SPA fallback dead configuration. */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
