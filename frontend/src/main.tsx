/**
 * main.tsx — React 18 application entry point.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/main.tsx | React 18
 *     `createRoot` bootstrap".
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *     Firebase JS SDK; signInWithEmailAndPassword, getIdToken().
 *   - QA Report Issue #7 (CRITICAL) — `initializeFirebaseClient()` is
 *     never called, causing `getIdToken()` to return null and the
 *     `Authorization: Bearer ${idToken}` header to never be attached.
 *     Without auth, every authenticated API call (POST /api/designs,
 *     GET /api/designs, POST /api/designs/:id/share-link, GET /api/cart,
 *     POST /api/orders) returns 401. The fix below calls
 *     `initializeFirebaseClient()` exactly once at module top-level
 *     BEFORE `ReactDOM.createRoot().render()`. The call is idempotent
 *     and StrictMode-safe (firebase-client.ts has both a
 *     module-private guard and a defense-in-depth `getApps()` check).
 *   - ST-001-AC4 — ZERO console errors during initial render. The
 *     bootstrap remains minimal — `initializeFirebaseClient()` is
 *     synchronous, throws ONLY when required `VITE_FIREBASE_*`
 *     variables are missing (which is a developer configuration
 *     issue, not a runtime user-facing concern), and emits no logs.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched (texture pipeline is unaffected by
 *     Firebase init).
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: this file imports ONLY the JS SDK wrapper
 *     (`./auth/firebase-client`) which itself uses ONLY the
 *     browser-safe `firebase` package — never `firebase-admin`,
 *     `jsonwebtoken`, `jose`, or `jwt-decode`.
 *
 * StrictMode:
 *   We wrap `<App />` in `<React.StrictMode>` so that React 18's
 *   double-invocation check exercises the texture pipeline / hook
 *   cleanup / `useEffect` cleanup paths during development. Every
 *   effect in this codebase has been authored to be StrictMode-safe;
 *   the `performance.ts` instrumentation is the most sensitive
 *   surface, and its module-level helpers explicitly handle the
 *   mount → cleanup → mount sequence. `initializeFirebaseClient()`
 *   is also StrictMode-safe via its module-private idempotency guard.
 *
 * Why init at main.tsx scope rather than in <App />'s useEffect:
 *   Calling init at module top-level (synchronously, BEFORE
 *   `createRoot().render()`) means:
 *     1. The Firebase SDK is fully ready by the time the FIRST render
 *        runs, so children that call `getIdToken()` during their
 *        initial render do not race against init.
 *     2. Errors (missing `VITE_FIREBASE_*` config) surface BEFORE
 *        React mounts — the developer sees a clear "Firebase config
 *        is incomplete" error in the dev console rather than a
 *        cascade of downstream undefined-token failures.
 *     3. There is exactly ONE call site, eliminating the StrictMode
 *        double-invocation concern entirely (synchronous module-top
 *        code does not double-execute).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { initializeFirebaseClient } from './auth/firebase-client';
import './styles/global.css';

// ---------------------------------------------------------------------------
// Firebase client SDK initialization — QA Issue #7 fix (CRITICAL).
// ---------------------------------------------------------------------------
//
// Synchronous, idempotent, called exactly once before any React render.
// Reads `VITE_FIREBASE_*` from `import.meta.env` (Vite-injected at build
// time). Connects to the Firebase Auth emulator in dev mode
// (`import.meta.env.DEV === true`) — production builds tree-shake the
// emulator branch.
//
// Throws synchronously if any required `VITE_FIREBASE_*` variable is
// missing. The throw is intentional: it surfaces a developer-facing
// configuration error in the browser console BEFORE React attempts to
// mount, making the fix obvious. See frontend/.env.example for the
// required variables.
initializeFirebaseClient();

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
