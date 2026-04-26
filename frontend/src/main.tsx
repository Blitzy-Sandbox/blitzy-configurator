/**
 * main.tsx — React 18 application entry point.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/main.tsx | React 18
 *     `createRoot` bootstrap".
 *   - QA Report Issue #1 — Without this file, `index.html`'s
 *     `<script type="module" src="/src/main.tsx">` tag returns HTTP
 *     404 and the React module loader fails, leaving the
 *     `<div id="root">` empty (the documented blank-viewport
 *     symptom). This file is the entry that resolves Issue #1 and
 *     unblocks every downstream Track 2 finding.
 *   - ST-001-AC4 — ZERO console errors during initial render. The
 *     bootstrap below is intentionally minimal (no error-prone side
 *     effects, no Firebase init at this scope) so the first render
 *     has a clean console.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports here. Firebase client initialization
 *     is the responsibility of MG1-F (per AAP §0.6.9), not Track 2's
 *     application bootstrap.
 *
 * StrictMode:
 *   We wrap `<App />` in `<React.StrictMode>` so that React 18's
 *   double-invocation check exercises the texture pipeline / hook
 *   cleanup / `useEffect` cleanup paths during development. Every
 *   effect in this codebase has been authored to be StrictMode-safe;
 *   the `performance.ts` instrumentation is the most sensitive
 *   surface, and its module-level helpers explicitly handle the
 *   mount → cleanup → mount sequence.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './styles/global.css';

// ---------------------------------------------------------------------------
// Mount point lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the mount element. `index.html` declares
 * `<div id="root"></div>` as the React mount point. If the element is
 * missing (e.g. a misconfigured shell host page), throw a descriptive
 * error rather than failing silently — this surfaces an actionable
 * developer-facing message in the browser's error overlay.
 *
 * The throw is the only failure path, so under normal operation
 * (`index.html` unchanged) this function returns immediately with the
 * resolved Element.
 */
function resolveRootElement(): HTMLElement {
  const rootElement = document.getElementById('root');
  if (rootElement === null) {
    throw new Error(
      'StrikeForge configurator: unable to mount React. ' +
        'No element with id="root" was found in the document. ' +
        'Verify that frontend/index.html declares <div id="root"></div> ' +
        'before the <script type="module" src="/src/main.tsx"> tag.',
    );
  }
  return rootElement;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const root = ReactDOM.createRoot(resolveRootElement());

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
