/**
 * Firebase JS SDK client wrapper.
 *
 * Authority:
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/auth/firebase-client.ts → Firebase client SDK init,
 *       getIdToken() helper.
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       Firebase JS SDK; signInWithEmailAndPassword, getIdToken().
 *   - AAP §0.4.2 — frontend dependency `firebase` ^10.14.1 (modular API).
 *
 * Responsibilities:
 *   - Initialize the Firebase JS SDK exactly once (idempotently) at app
 *     bootstrap. React StrictMode double-invokes effects in development and
 *     Vite HMR can re-execute module top-level code, so the implementation
 *     uses two layers of idempotency: a module-private flag plus a
 *     defense-in-depth `getApps()` check that reuses an existing
 *     [DEFAULT] app if one is found.
 *   - Connect to the Firebase Auth emulator at http://localhost:9099 in
 *     dev mode (`import.meta.env.DEV === true`) so that local development
 *     and CI satisfy the LocalGCP Verification Rule (AAP §0.8.2): zero
 *     live GCP dependencies in tests or local dev workflows. The hard-coded
 *     emulator URL matches the `firebase-auth-emulator` service port
 *     mapping in `docker-compose.yml`. In a Vite production build the dev
 *     branch is dead code and is tree-shaken from the final bundle.
 *   - Expose a small typed surface used by:
 *       • frontend/src/App.tsx — calls `initializeFirebaseClient()` once
 *         on mount.
 *       • frontend/src/api/client.ts (post-MG1-F) — calls `getIdToken()`
 *         per outbound request to attach `Authorization: Bearer ${token}`.
 *       • Sign-in / sign-up / sign-out form components — call `signIn`,
 *         `signUp`, `signOutUser`, and `onAuthStateChanged`.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R3 (Firebase Admin SDK is backend-only). This file uses ONLY
 *     the browser-safe `firebase` JS SDK (`firebase/app`, `firebase/auth`)
 *     and never imports `firebase-admin`, `jsonwebtoken`, `jose`, or
 *     `jwt-decode`. The frontend never decodes or verifies token contents
 *     — the backend's session middleware is the SOLE authority on token
 *     validity (per AAP C2: `admin.auth().verifyIdToken(rawBearerToken)`).
 *   - Rule R2 (no credential material in logs). This module contains ZERO
 *     `console.*` calls. The Firebase SDK manages tokens internally; this
 *     wrapper returns the raw token directly to its caller without
 *     intermediate buffering, logging, or storage.
 *   - Rule R4 analog (no environment-default fallbacks). All required
 *     Firebase config values must be present in `import.meta.env.VITE_FIREBASE_*`.
 *     If any required value is missing, `initializeFirebaseClient()` throws
 *     loudly with a descriptive error that names the missing variables (NOT
 *     their values — never echo secret material in error text).
 *
 * Out of scope:
 *   - Custom JWT verification (Rule R3).
 *   - Manual token storage in localStorage / sessionStorage / cookies —
 *     Firebase manages persistence internally via IndexedDB; manual
 *     storage breaks SDK refresh logic and exposes tokens to XSS.
 *   - Phone-number / OAuth / SAML provider sign-in.
 *   - Multi-factor authentication enrollment, App Check, reCAPTCHA.
 *   - Service worker caching of auth state.
 *   - Auth-event observability (lives on the backend per ST-024-AC5).
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  browserLocalPersistence,
  type Auth,
  type User,
  type UserCredential,
  type Unsubscribe,
} from 'firebase/auth';

// ---------------------------------------------------------------------------
// Module-private singletons.
//
// These are NEVER exported. Production code never mutates them directly; tests
// that need to reset module state should use the test runner's
// `vi.resetModules()` / `jest.resetModules()` rather than reaching into this
// module. Exporting a reset helper would create a test-only API surface that
// could be misused in production code.
// ---------------------------------------------------------------------------
let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;

// ---------------------------------------------------------------------------
// Window global augmentation for test-only auth control.
//
// Declares `window.__strikeforge_test_auth__` so TypeScript recognizes the
// property in calling code (Playwright tests under `frontend/tests/e2e/`
// and `frontend/tests/visual/`). The property is optional (`?:`) because
// it only exists in DEV builds — the entire attach block in
// `initializeFirebaseClient()` is gated by `import.meta.env.DEV` and
// statically removed from production bundles by Vite's tree shaker.
//
// Why this is the correct pattern instead of localStorage seeding:
//   - localStorage seeding requires the seeded persistedUser record to
//     match Firebase v10's exact internal schema. Schema changes
//     between SDK versions break the seeding.
//   - localStorage seeding bypasses the emulator's signIn flow, leaving
//     the SDK's internal session state desynchronized from the seeded
//     localStorage record.
//   - A real signIn via this hook produces a fully-valid User instance
//     with a fresh idToken, refreshToken, and stsTokenManager — exactly
//     what the rest of the SDK and the SPA expect.
//
// Rule R3 — the hook NEVER decodes or verifies tokens. It only exposes
// the SDK's existing observable state.
// Rule R2 — the hook NEVER logs credentials. The methods are thin
// wrappers around existing exported functions.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    /**
     * Test-only auth control hook. Attached only in DEV builds to allow
     * Playwright E2E tests to perform a real sign-in from the browser
     * context — the same code path that an interactive sign-in UI would
     * exercise — via:
     *
     *     await page.evaluate(
     *       ({ email, password }) =>
     *         window.__strikeforge_test_auth__!.signIn(email, password),
     *       { email, password },
     *     );
     *
     * Undefined in production builds. Tests that depend on this hook
     * MUST run against a `vite dev` build (Playwright's webServer
     * configuration in `playwright.config.ts`).
     */
    __strikeforge_test_auth__?: {
      getCurrentUser(): User | null;
      signIn(email: string, password: string): Promise<UserCredential>;
      signOut(): Promise<void>;
      getIdToken(): Promise<string | null>;
    };
  }
}

// `connectAuthEmulator` throws if invoked after the Auth instance has already
// issued a request (e.g., during a duplicate dev-mode init triggered by HMR or
// React StrictMode). This guard ensures the call happens at most once per
// module lifetime.
let emulatorConnected = false;

// ---------------------------------------------------------------------------
// Required Firebase config environment variables.
//
// Listed once here so the validation logic and the error message stay in
// lockstep. All names are `VITE_`-prefixed because Vite only exposes
// `VITE_*`-prefixed variables to the client bundle (any other prefix is
// stripped at build time, which is the documented Vite behavior).
//
// API key, auth domain, project ID, and app ID are required for the SDK to
// initialize successfully against the local Firebase Auth emulator OR a real
// Firebase project. The remaining two — messaging sender ID and storage
// bucket — are optional and only included in the config if the developer
// has set them in their environment.
// ---------------------------------------------------------------------------
const REQUIRED_FIREBASE_ENV_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

// ---------------------------------------------------------------------------
// Firebase Auth emulator endpoint.
//
// Hard-coded by design — this URL must match the `firebase-auth-emulator`
// service in `docker-compose.yml` (port mapping `9099:9099`). Promoting this
// to a `VITE_*` env var would add deployment complexity without correctness
// benefit because:
//   1. Production builds tree-shake the `if (import.meta.env.DEV)` branch
//      entirely — the production browser bundle never references this URL.
//   2. The LocalGCP Verification Rule (AAP §0.8.2) expects the emulator to
//      live at this canonical address.
//   3. Rule R4 governs BACKEND env vars (the six listed in AAP §0.1.3); the
//      frontend's emulator URL is a development-time constant, not a runtime
//      configuration value.
// ---------------------------------------------------------------------------
const FIREBASE_AUTH_EMULATOR_URL = 'http://localhost:9099';

/**
 * Initialize the Firebase client SDK.
 *
 * Safe to call multiple times — subsequent calls return immediately via the
 * module-private idempotency guard. Designed to be called from a
 * `useEffect(() => { initializeFirebaseClient(); }, [])` in
 * `frontend/src/App.tsx`; React StrictMode's double-invocation in development
 * is handled by the guards below.
 *
 * Throws a descriptive `Error` if any required `VITE_FIREBASE_*` configuration
 * is missing. The error message names the missing variables but NEVER echoes
 * their values (Rule R2 analog) so a leaked stack trace cannot expose secret
 * material.
 *
 * In Vite dev mode (`import.meta.env.DEV === true`) this function additionally
 * connects the Auth instance to the Firebase Auth emulator at
 * `http://localhost:9099`. This branch is dead code in production builds and
 * is removed by Vite's tree shaker.
 */
export function initializeFirebaseClient(): void {
  // Fast-path idempotency: subsequent calls after a successful init are
  // no-ops. This is the primary guard against React StrictMode's double
  // effect invocation in development.
  if (firebaseApp !== null && firebaseAuth !== null) {
    return;
  }

  // ----- Read configuration from Vite's `import.meta.env`. ---------------
  // Vite replaces these expressions at build time with the literal values
  // from the `.env` file (or the shell environment). At runtime these are
  // simple property reads against a frozen object.
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  const messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID;
  const storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;

  // ----- Validate required values. ---------------------------------------
  // Collect every missing required name into a single list so the developer
  // sees the entire fix in one error message rather than fixing one variable
  // at a time. Names only — never values — appear in the resulting message.
  const missing: string[] = [];
  if (!apiKey) missing.push('VITE_FIREBASE_API_KEY');
  if (!authDomain) missing.push('VITE_FIREBASE_AUTH_DOMAIN');
  if (!projectId) missing.push('VITE_FIREBASE_PROJECT_ID');
  if (!appId) missing.push('VITE_FIREBASE_APP_ID');

  if (missing.length > 0) {
    throw new Error(
      'Firebase client configuration is incomplete. The following required ' +
        `environment variables are missing: ${missing.join(', ')}. ` +
        'Set them in frontend/.env (or your shell environment) before starting ' +
        `the configurator. Required variables: ${REQUIRED_FIREBASE_ENV_VARS.join(', ')}. ` +
        'Refer to .env.example at the repository root for documentation.',
    );
  }

  // ----- Build the Firebase config object. -------------------------------
  // The optional fields are spread conditionally so that absent values are
  // never present as `undefined` keys — Firebase's `initializeApp` is type-
  // strict and rejects `undefined` values for fields not in its
  // `FirebaseOptions` interface.
  const firebaseConfig = {
    apiKey,
    authDomain,
    projectId,
    appId,
    ...(messagingSenderId ? { messagingSenderId } : {}),
    ...(storageBucket ? { storageBucket } : {}),
  };

  // ----- Initialize (or reuse) the Firebase app. -------------------------
  // Defense-in-depth: if a Firebase app already exists (HMR or a duplicate
  // module instance from a stale cache), reuse it. Calling `initializeApp`
  // a second time would throw "Firebase: Firebase App named '[DEFAULT]'
  // already exists [DEFAULT]". The first item in `getApps()` is the
  // [DEFAULT] app per Firebase SDK semantics.
  const existingApps = getApps();
  if (existingApps.length > 0) {
    // Non-null assertion is safe here because `existingApps.length > 0`.
    firebaseApp = existingApps[0] as FirebaseApp;
  } else {
    firebaseApp = initializeApp(firebaseConfig);
  }

  // ----- Initialize Auth with localStorage persistence pinned at init. ---
  // Firebase JS SDK v10's default browser persistence is
  // `indexedDBLocalPersistence` (with a localStorage fallback only when
  // IndexedDB is unavailable). Persistence drives WHERE the SDK reads
  // and writes the signed-in user record under the key
  // `firebase:authUser:${apiKey}:[DEFAULT]`.
  //
  // We pin the persistence backend explicitly to `browserLocalPersistence`
  // (localStorage) at INITIALIZATION TIME (not via a post-init
  // `setPersistence` call) for the following reasons:
  //
  //   1. Test infrastructure parity. Playwright E2E specs under
  //      `frontend/tests/e2e/` and `frontend/tests/visual/` use
  //      `page.addInitScript(() => { localStorage.setItem(persistKey, ...) })`
  //      to inject a pre-authenticated session before the SPA's first
  //      auth observation. With IndexedDB persistence the SDK would
  //      ignore the localStorage seed and observe the user as
  //      unauthenticated, producing the failure mode documented in QA
  //      Final D Issue #10.
  //   2. Synchronous race avoidance. Calling `setPersistence` AFTER
  //      `getAuth(app)` produces a queued, asynchronous persistence
  //      change. The SDK's first auth-state observation
  //      (triggered by `onAuthStateChanged` subscription, which the
  //      SPA performs in App.tsx within React's first render-commit
  //      cycle) may complete BEFORE the queued persistence change
  //      resolves. In that ordering, the SDK reads from the default
  //      IndexedDB persistence on first read, finds nothing (because
  //      the test seeded localStorage, not IndexedDB), and emits an
  //      unauthenticated initial state — defeating the test seeding.
  //      `initializeAuth(app, { persistence })` sets the persistence
  //      synchronously at SDK construction time, BEFORE the first
  //      auth-state observation can occur, eliminating the race.
  //   3. Cross-engine determinism. Playwright runs both Chromium and
  //      WebKit (AAP §0.6.12 / ST-045-AC2). Both engines support
  //      IndexedDB and localStorage, but their IndexedDB
  //      transaction-commit timing differs in headless contexts —
  //      pinning to a synchronous-readable storage (localStorage)
  //      removes a class of cross-engine flakiness.
  //
  // Trade-off: localStorage and IndexedDB have equivalent security
  // characteristics for the tokens stored — both are readable by any
  // script in the same origin and neither is HttpOnly-protected. The
  // SPA does not transmit credential material itself; the persisted
  // record holds Firebase-issued ID + refresh tokens, which the
  // backend re-validates on every request via `verifyIdToken` per
  // Rule R3. The choice of storage backend therefore does not change
  // the threat model.
  //
  // `initializeAuth` MUST be called at most once per app instance.
  // If we are reusing an existing app (HMR / React StrictMode
  // double-invoke / duplicate-module-cache), `initializeAuth` would
  // throw "auth/already-initialized". In that case we use `getAuth`
  // to retrieve the previously-initialized instance, which carries
  // forward the persistence we configured on the first init.
  if (existingApps.length > 0) {
    // Reuse the existing Auth instance (already initialized with
    // browserLocalPersistence on the first call).
    firebaseAuth = getAuth(firebaseApp);
  } else {
    firebaseAuth = initializeAuth(firebaseApp, {
      persistence: browserLocalPersistence,
    });
  }

  // ----- Connect to the Firebase Auth emulator in dev. -------------------
  // `import.meta.env.DEV` is `true` during `vite dev` and `false` during
  // `vite build`. The entire if-block is statically eliminated from the
  // production bundle by Vite's tree shaker.
  //
  // `disableWarnings: true` suppresses the SDK's "you are connected to a
  // Firebase auth emulator" yellow-banner warning. Real auth errors still
  // surface unchanged — only the noisy banner is silenced.
  if (import.meta.env.DEV && !emulatorConnected) {
    connectAuthEmulator(firebaseAuth, FIREBASE_AUTH_EMULATOR_URL, {
      disableWarnings: true,
    });
    emulatorConnected = true;
  }

  // ----- Test-only window hook for E2E auth control. ---------------------
  // AAP §0.6.7 / ST-045: Playwright E2E specs need to drive authentication
  // from the browser context (the SPA does NOT render an interactive
  // sign-in form because Final D Issue #10 documented that the
  // localStorage-seeding approach is fragile). Following the existing
  // `__strikeforge_perf__` pattern in `src/configurator/preview/performance.ts`,
  // we attach a small read-only API to `window.__strikeforge_test_auth__`
  // so tests can perform a real sign-in via:
  //
  //     await page.evaluate(({ email, password }) =>
  //         window.__strikeforge_test_auth__!.signIn(email, password),
  //         { email, password },
  //     );
  //
  // After the promise resolves, the SPA's `onAuthStateChanged` observer
  // fires synchronously (Firebase fires listeners synchronously on the
  // microtask queue immediately after sign-in resolves), and the
  // auth-gated UI flips to the authenticated state.
  //
  // The entire block is gated by `import.meta.env.DEV` so it is statically
  // eliminated from the production bundle by Vite's tree shaker. In
  // production builds this block becomes `if (false) { ... }` and is
  // dropped.
  //
  // Rule R2 — none of the exposed methods log credentials. They are
  // thin wrappers that delegate to the existing exported functions
  // (`signIn`, `signOutUser`) which themselves never log.
  //
  // Rule R3 — none of the exposed methods decode or parse JWTs. They
  // only return the SDK's `User` reference (which the test inspects
  // with `user?.uid`) and the SDK-managed `idToken` string (which the
  // test passes verbatim to API calls — the backend remains the sole
  // authority on token validity).
  if (import.meta.env.DEV) {
    window.__strikeforge_test_auth__ = {
      getCurrentUser: () => firebaseAuth?.currentUser ?? null,
      signIn: (email: string, password: string): Promise<UserCredential> => {
        if (!firebaseAuth) {
          return Promise.reject(
            new Error(
              'Firebase client not initialized — cannot signIn from test hook.',
            ),
          );
        }
        return signInWithEmailAndPassword(firebaseAuth, email, password);
      },
      signOut: (): Promise<void> => {
        if (!firebaseAuth) {
          return Promise.resolve();
        }
        return signOut(firebaseAuth);
      },
      getIdToken: async (): Promise<string | null> => {
        const u = firebaseAuth?.currentUser ?? null;
        if (u === null) {
          return null;
        }
        return u.getIdToken();
      },
    };
  }
}

/**
 * Return the current user's Firebase ID token, or `null` if no user is signed
 * in or the SDK has not yet been initialized.
 *
 * Used by `frontend/src/api/client.ts` to attach the
 * `Authorization: Bearer ${token}` header to outbound requests. The backend's
 * session middleware (`backend/src/middleware/session.ts`) calls
 * `admin.auth().verifyIdToken(token)` to validate the resulting JWT — see
 * Rule R3 / AAP C2.
 *
 * This function does NOT force-refresh the token (`getIdToken(true)`). The
 * Firebase SDK auto-refreshes within roughly five minutes of expiry; passing
 * `true` would impose an unnecessary network round-trip on every API call,
 * which is unacceptable for a configurator with frequent auto-saves and
 * carries rate-limit risk against the Firebase Auth backend.
 *
 * Rule R2 — this function NEVER logs the returned token. The token is
 * returned directly to its caller; intermediate logging would violate the
 * credential-material exclusion. The caller is responsible for using the
 * token only as an `Authorization: Bearer` header value.
 */
export async function getIdToken(): Promise<string | null> {
  if (!firebaseAuth) {
    return null;
  }

  const currentUser = firebaseAuth.currentUser;
  if (!currentUser) {
    return null;
  }

  // Default `forceRefresh = false` — see commentary above.
  return currentUser.getIdToken();
}

/**
 * Sign in with email and password. Wraps `signInWithEmailAndPassword`.
 *
 * Throws if the Firebase client has not been initialized; otherwise propagates
 * Firebase errors verbatim to the caller. The caller is responsible for
 * mapping Firebase error codes (e.g., `auth/wrong-password`,
 * `auth/user-not-found`) to user-friendly messages without echoing the
 * cleartext password.
 *
 * Rule R2 — this function NEVER logs the password or the email. Both are
 * passed directly to the Firebase SDK, which is the single authoritative
 * point that touches the cleartext password.
 */
export async function signIn(email: string, password: string): Promise<UserCredential> {
  if (!firebaseAuth) {
    throw new Error(
      'Firebase client not initialized. Call initializeFirebaseClient() before signIn().',
    );
  }
  return signInWithEmailAndPassword(firebaseAuth, email, password);
}

/**
 * Create a new user with email and password. Wraps
 * `createUserWithEmailAndPassword`.
 *
 * Same constraints as `signIn`:
 *   - Throws if Firebase has not been initialized.
 *   - Propagates Firebase errors verbatim (`auth/email-already-in-use`,
 *     `auth/weak-password`, etc.) without logging credentials.
 *   - The Firebase SDK is the single point that touches the cleartext
 *     password (Rule R2).
 *
 * On success, the returned `UserCredential` is the freshly-created account
 * AND the user is automatically signed in by the Firebase SDK — subsequent
 * `getIdToken()` calls return a token for the new user without an additional
 * `signIn()` call.
 */
export async function signUp(email: string, password: string): Promise<UserCredential> {
  if (!firebaseAuth) {
    throw new Error(
      'Firebase client not initialized. Call initializeFirebaseClient() before signUp().',
    );
  }
  return createUserWithEmailAndPassword(firebaseAuth, email, password);
}

/**
 * Sign out the current user. No-op if Firebase has not been initialized or
 * the user was never signed in.
 *
 * Named `signOutUser` (not `signOut`) to disambiguate from the `signOut`
 * named import from `firebase/auth` which is in scope inside this module.
 * Callers may also unsubscribe from auth-state listeners returned by
 * `onAuthStateChanged` after sign-out, but that is a UI-layer concern.
 */
export async function signOutUser(): Promise<void> {
  if (!firebaseAuth) {
    return;
  }
  await signOut(firebaseAuth);
}

/**
 * Subscribe to Firebase auth state changes. Returns the Firebase
 * `Unsubscribe` function which is safe to call from a React `useEffect`
 * cleanup function.
 *
 * If Firebase has not been initialized, returns a no-op unsubscribe so that
 * callers don't need to null-check before subscribing — this matches the
 * "graceful degradation during Track 2" requirement where components can be
 * authored before MG1-F wires the real Firebase config.
 *
 * The aliased import `firebaseOnAuthStateChanged` avoids a name conflict
 * with this exported function.
 */
export function onAuthStateChanged(callback: (user: User | null) => void): Unsubscribe {
  if (!firebaseAuth) {
    return (): void => {
      // No-op unsubscribe — Firebase not initialized, nothing to clean up.
    };
  }
  return firebaseOnAuthStateChanged(firebaseAuth, callback);
}
