/**
 * main.tsx — React 18 application entry point.
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/main.tsx | React 18 createRoot
 *     bootstrap".
 *   - AAP §0.5.2 (Composition Sequence) — main.tsx is the FRONTEND
 *     composition root: it resolves the DOM mount node, wraps <App />
 *     in <StrictMode>, and hands off the React tree to React 18's
 *     concurrent root API.
 *   - AAP §0.6.14 ("User Interface Design") — the configurator is a
 *     single-page experience; no router is required at the bootstrap
 *     layer. Any future deep-linking (e.g., share-link URLs that
 *     auto-load a design) is added inside <App /> rather than here.
 *   - frontend/index.html — declares <div id="root"></div> and
 *     <script type="module" src="/src/main.tsx"></script>; this file
 *     is the contract that index.html references.
 *
 * ============================================================================
 * Responsibilities
 * ============================================================================
 *
 *   1. Resolve the DOM mount node (#root) emitted by index.html.
 *   2. Mount <App /> via React 18's createRoot() — the legacy
 *      ReactDOM.render() API is deprecated and disables concurrent
 *      features (Suspense transitions, automatic batching).
 *   3. Wrap <App /> in <StrictMode> so that React 18's runtime
 *      invariants (double-invocation of effects, unsafe lifecycle
 *      detection) surface impure setup during development. <StrictMode>
 *      is a no-op in production builds.
 *   4. Load the global stylesheet (./styles/global.css) once at the
 *      bootstrap layer so the Blitzy brand tokens, layout grid, and
 *      typography reset are applied before any component renders.
 *      Per global.css's own authority block: "this stylesheet is the
 *      single style entry point imported by frontend/src/main.tsx".
 *
 * ============================================================================
 * Cross-cutting rules enforced here
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO console.* calls. The
 *     bootstrap is silent on the happy path; the only failure path is
 *     a descriptive Error throw when #root is missing — and that error
 *     never contains credential material.
 *   - Rule R3 (Firebase Admin SDK is backend-only): this file imports
 *     ONLY from `react`, `react-dom/client`, the local `./App` module,
 *     and the global stylesheet. It never imports `firebase-admin`,
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. Firebase JS SDK
 *     initialization is owned by `<App />` via its mount-time
 *     `useEffect(() => { initializeFirebaseClient(); }, [])` call —
 *     keeping bootstrap concerns separate from authentication
 *     concerns.
 *   - Rule R7 / C6 (texture pipeline ordering): untouched here. The
 *     bootstrap does not import from `configurator/texture/` or call
 *     any pipeline coordinator.
 *   - Rule R9 (no payment processing): no payment SDK imports.
 *
 * ============================================================================
 * StrictMode safety
 * ============================================================================
 *
 *   React 18's <StrictMode> double-invokes effects during development to
 *   surface impure setup. Every hook in this codebase has been authored
 *   to be idempotent under double-invocation:
 *
 *     - `useDragRotation`     — pointer event listeners attached and
 *                               cleaned up on each effect cycle.
 *     - `useIdleAutoRotate`   — rAF handles cleared in the cleanup
 *                               return, so a second mount picks up a
 *                               fresh frame budget.
 *     - `texturePipeline.update()` — guarded against duplicate
 *                                    `needsUpdate = true` flags via
 *                                    its FIFO queue (Rule R7 / C6).
 *     - `initializeFirebaseClient()` (called by <App />, not here) —
 *       module-private guard plus `getApps()` defense-in-depth.
 *
 *   Disabling <StrictMode> would mask these invariants and is therefore
 *   not an option even if a downstream effect appears "noisy" during
 *   development.
 *
 * ============================================================================
 * Why this file stays minimal
 * ============================================================================
 *
 *   The agent action plan explicitly directs that any cross-cutting
 *   bootstrap (Firebase init, OpenTelemetry web SDK, error reporting,
 *   feature-flag SDKs) must live inside <App /> or its child providers
 *   — never here. Keeping main.tsx trivial means:
 *
 *     - Vite tree-shakes only the imports used by the bootstrap layer.
 *     - The audit surface for Rule R2 / Rule R3 / Rule R9 violations
 *       is reduced to a single screen of code.
 *     - Future refactors that introduce lazy-loaded routes or service
 *       workers do not need to disturb the bootstrap contract.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/global.css';

// ---------------------------------------------------------------------------
// Mount node lookup — fail fast with a descriptive error.
// ---------------------------------------------------------------------------
//
// `index.html` declares `<div id="root"></div>` immediately above the
// `<script type="module" src="/src/main.tsx">` tag. Under normal
// operation `getElementById('root')` returns the element synchronously
// because the script is a module and module scripts are parsed AFTER
// the document body. If a future host page omits the #root element,
// the throw below surfaces an actionable developer-facing message in
// the browser's error overlay rather than letting React's createRoot()
// reject with a confusing "Target container is not a DOM element" line.
//
// This is the analogue of Rule R4's fail-fast policy on missing env
// vars — fail loudly on misconfiguration, never silently degrade.

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    'StrikeForge configurator: unable to mount React. ' +
      'No element with id="root" was found in the document. ' +
      'Verify that frontend/index.html declares <div id="root"></div> ' +
      'before the <script type="module" src="/src/main.tsx"> tag.',
  );
}

// ---------------------------------------------------------------------------
// React 18 concurrent root mount.
// ---------------------------------------------------------------------------
//
// createRoot() returns a Root handle that owns the reconciliation tree.
// We do not retain a reference to the handle: there is no use case in
// this application for `root.unmount()` (the tab close path implicitly
// unmounts) and storing the handle as a module-level variable would
// expose a hot-reload hazard during Vite HMR. Calling `.render()`
// inline keeps the bootstrap stateless from the host module's
// perspective.

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
