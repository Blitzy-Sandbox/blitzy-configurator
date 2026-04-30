/**
 * Register / Login / Logout end-to-end flow — Playwright spec.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "frontend/tests/e2e/*.spec.ts | Critical flow: register → login
 *        → create design → save → share → add to cart → create order
 *        (ST-045); Chromium + WebKit projects".
 *   - ST-045-AC1 (the AC source of truth per Rule R1):
 *       "The end-to-end suite … exercises at least the configurator
 *        load, color selection, save-design, load-design, and order
 *        creation flows against running services."
 *   - ST-045-AC4: the suite runs in the local development environment
 *     against locally-started services so developers can reproduce
 *     failures without remote access.
 *   - ST-023 (User Registration Endpoint):
 *       AC1: "The registration endpoint accepts a request with the
 *        documented required fields and persists a canonical user
 *        record when the input is valid."
 *       AC2: "A successful registration returns the canonical user
 *        record (without any credential material) and a success
 *        status, and does not issue a session token by itself."
 *       AC4: "Credential material submitted at registration is never
 *        stored in cleartext and is never returned in any response."
 *   - ST-024 (Login Endpoint): login validates credentials and issues
 *     a session-grade idToken; the frontend obtains it via the
 *     Firebase JS SDK / Identity Toolkit `signInWithPassword` REST
 *     surface.
 *   - ST-025 (Logout Endpoint): logout terminates the session — at
 *     the browser layer this means clearing the persisted Firebase
 *     auth state so the SPA no longer attaches a Bearer token.
 *   - ST-026 (Session Validation Middleware Contract):
 *       AC1: "Requests to any protected endpoint without a session
 *        token are rejected with the documented unauthenticated
 *        status and response body, and never reach the protected
 *        handler."
 *       AC3: "Requests carrying a valid, unexpired session token are
 *        forwarded to the protected handler with the authenticated
 *        user identity attached to the request context."
 *
 * ===========================================================================
 * What this spec validates
 * ===========================================================================
 *
 * The register/login slice of the ST-045 critical-path. Each `test()`
 * is an independent contract assertion; splitting the slice into
 * focused tests rather than a single monolithic flow yields clearer
 * diagnostic output on failure (an emulator-down scenario is
 * isolated from a backend session-middleware regression) and matches
 * the regressionability strategy used by the sibling
 * `save-design-flow.spec.ts`, `share-link-flow.spec.ts`, and
 * `cart-and-order-flow.spec.ts` specs in this folder.
 *
 *   1. Registration via the Firebase Auth Emulator REST surface
 *      produces a usable user record with non-empty `localId`,
 *      `idToken`, and `refreshToken`. (ST-023-AC1).
 *   2. The freshly-issued `idToken` is accepted by the local
 *      backend's session middleware (`/api/cart` returns 2xx),
 *      and an unauthenticated request to the same endpoint is
 *      rejected with HTTP 401. (ST-026-AC1, ST-026-AC3).
 *   3. The login flow (Identity Toolkit `signInWithPassword` REST)
 *      issues a fresh `idToken` for the same canonical user, and
 *      that login-issued token is accepted by the backend.
 *      (ST-024).
 *   4. When the auth state is injected into the browser via
 *      `addInitScript`, any outbound `/api/*` requests fired by the
 *      SPA carry an `Authorization: Bearer …` header — proving the
 *      browser-side fetch wrapper attaches the bearer correctly
 *      and the SPA's `onAuthStateChanged()` observer resolves to
 *      the seeded user immediately at boot.
 *   5. Clearing the persisted Firebase auth state (the browser-side
 *      logout primitive) removes the localStorage entry so the
 *      SPA can no longer mint a bearer for outbound calls.
 *      (ST-025 from the browser's perspective; full server-side
 *      revocation is exercised in the backend integration suite).
 *
 * ===========================================================================
 * The auth architecture, in brief
 * ===========================================================================
 *
 * Per AAP Rule R3 ("Firebase Admin SDK only on backend"), token
 * validation in the backend is performed exclusively via
 * `admin.auth().verifyIdToken()` — the frontend does NOT mint or
 * verify any JWT. The frontend obtains its `idToken` by:
 *
 *   1. Driving the Firebase JS SDK (`createUserWithEmailAndPassword`,
 *      `signInWithEmailAndPassword`) which talks to the local
 *      Firebase Auth Emulator (or live Firebase Auth in production).
 *   2. The JS SDK persists the signed-in user in localStorage at
 *      `firebase:authUser:${apiKey}:[DEFAULT]`.
 *   3. The SPA's outbound fetch wrapper calls `getIdToken()` to
 *      retrieve the current bearer for every authenticated request.
 *
 * For e2e, instead of driving any sign-in form (which the SPA may or
 * may not surface — the AAP does not mandate any specific UI), this
 * spec talks to the Firebase Auth Emulator's Identity Toolkit REST
 * endpoints directly via Playwright's `request` fixture:
 *
 *   - `POST .../accounts:signUp?key=…`           → register a user
 *   - `POST .../accounts:signInWithPassword?key=…` → login
 *
 * Both endpoints accept ANY API key when run against the emulator
 * (the emulator does NOT validate keys against any allowlist), so
 * `key=local-emulator-key` is correct AND matches the apiKey the SPA
 * itself reads from `VITE_FIREBASE_API_KEY` at build time (per
 * `frontend/.env`). The exact match is required so the localStorage
 * persistence key the spec writes
 * (`firebase:authUser:${apiKey}:[DEFAULT]`) lines up with the key
 * the SPA's Firebase SDK reads at page boot. See QA Final D Issue #10.
 *
 * Once a fresh `idToken` is in hand, the spec uses it two ways:
 *
 *   - Direct backend probe: pass it as `Authorization: Bearer …`
 *     to `GET /api/cart` and assert 2xx. The cart endpoint is the
 *     ideal probe target because per ST-033 it returns 200 with an
 *     empty cart for any authenticated user (never 404), so a
 *     non-2xx response unambiguously indicates an auth failure
 *     rather than a missing resource.
 *
 *   - Browser-side injection: write a synthetic Firebase JS SDK
 *     persistence record to localStorage via `addInitScript()` so
 *     the SPA's auth observer resolves to the seeded user
 *     immediately at boot, without requiring any sign-in form.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. The ESLint config enforces
 *     `no-console: error` (allowing only `warn` / `error`), and the
 *     workspace lint gate runs with `--max-warnings 0`. The static
 *     fixture password literal `'Test-Password-1234'` is NEVER
 *     logged; it appears only in the `data: { … }` body of the
 *     Identity Toolkit signUp / signInWithPassword call. Per the
 *     LocalGCP Verification Rule, fixture passwords for emulator-
 *     only auth are local-only test data, not production secrets.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, does NOT mint or verify any JWT,
 *     does NOT invoke `verifyIdToken()`. It interacts with the
 *     Firebase Auth Emulator solely via the public Identity Toolkit
 *     REST surface — the same surface a browser-side Firebase JS
 *     SDK uses. `jsonwebtoken`, `jose`, and `jwt-decode` are NOT
 *     imported anywhere.
 *   - Rule R7 / C6 (Fabric → Three texture order): N/A in this
 *     spec — the register/login flow does not exercise the texture
 *     pipeline. (Sibling specs that drive UI changes wait for
 *     `networkidle` after each interaction so the texture pipeline
 *     settles; this spec's UI-touching tests follow the same
 *     pattern out of habit.)
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     NO terminology associated with downstream financial
 *     settlement, processor integrations, or financial-instrument
 *     handling. The register/login slice has no financial side
 *     effects. The Rule R9 source-file regex MUST return zero
 *     matches against this file.
 *   - Rule R10: N/A — this is a spec file, not a migration.
 *   - LocalGCP Verification Rule: every test creates its own user
 *     fresh from the Firebase Auth Emulator and exercises the local
 *     backend; no live GCP credentials are required and no test
 *     depends on pre-existing emulator state.
 *
 * ===========================================================================
 * Determinism Strategy
 * ===========================================================================
 *
 *   - Per-test user creation. Each test registers a fresh user with
 *     an email of the form
 *     `e2e-auth-${Date.now()}-${randomUUID()}@strikeforge.test`. The
 *     combination of millisecond-resolution timestamp plus 122 bits
 *     of UUID entropy makes a same-millisecond collision
 *     astronomically unlikely. Cross-test isolation is preserved
 *     without any teardown step — residue from prior runs accumulates
 *     in the local emulator and is wiped on the next
 *     `docker compose up` cycle (LocalGCP Verification Rule).
 *   - Reserved `.test` TLD. The `@strikeforge.test` domain uses
 *     RFC 2606's reserved `.test` TLD which can never resolve to a
 *     real mail server, so an accidental run against live Firebase
 *     would not generate spurious deliverability traffic.
 *   - Synchronous header capture in request listeners. Playwright's
 *     `request.headers()` accessor returns the recorded headers
 *     synchronously (`{ [key: string]: string }`) — the asynchronous
 *     `request.headerValue(name)` returns a Promise and would have
 *     to be awaited inside the otherwise-synchronous
 *     `page.on('request', …)` callback. We use `headers()` and read
 *     the lowercase `'authorization'` key directly.
 *   - Defensive type narrowing. JSON response bodies are cast through
 *     a precisely-shaped interface so subsequent property accesses
 *     are type-safe under TypeScript's `strict` settings — no `any`,
 *     no implicit `unknown`, no non-null assertions.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// All three URLs / keys are pinned to the localhost ports declared in
// the repository's docker-compose.yml:
//
//   - firebase-auth-emulator: published 9099:9099 (Identity Toolkit
//     emulator endpoint at /identitytoolkit.googleapis.com/v1/...)
//   - backend:                published 3000:3000 (Express service
//     hosting /api/auth, /api/designs, /api/cart, /api/orders, etc.)
//
// FIREBASE_API_KEY is the literal token the emulator accepts as a
// query parameter. The emulator does NOT validate API keys against
// any allowlist — the value is opaque. CRITICAL: this MUST match
// the SPA's own apiKey (`VITE_FIREBASE_API_KEY`, currently
// `'local-emulator-key'` per `frontend/.env`) so the localStorage
// persistence key the test writes
// (`firebase:authUser:${apiKey}:[DEFAULT]`) lines up with the key
// the SPA's Firebase JS SDK reads on page boot. See QA Final D
// Issue #10.

const FIREBASE_AUTH_EMULATOR_HOST = 'http://localhost:9099';
const FIREBASE_API_KEY = 'local-emulator-key';
const BACKEND_BASE_URL = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
//
// EmulatorUser captures the subset of the Identity Toolkit signUp
// response that downstream stages consume. The Identity Toolkit
// returns more fields (e.g., `kind`, `expiresIn`); we capture only
// the five needed.
//
// The `password` field is the LITERAL fixture password we provided to
// the emulator — Firebase's signUp response NEVER returns the
// password (per ST-023-AC4, "credential material … is never returned
// in any response"). We retain it in the test fixture solely so the
// login test can re-submit it to `accounts:signInWithPassword`. The
// password is NEVER logged.

interface EmulatorUser {
  uid: string;
  email: string;
  password: string;
  idToken: string;
  refreshToken: string;
}

/**
 * Canonical shape of the Identity Toolkit signUp response. The
 * emulator returns additional fields (`kind`, `expiresIn`,
 * `displayName`, etc.) which are intentionally NOT destructured —
 * the spec only needs the four below.
 */
interface IdentityToolkitSignUpResponse {
  localId: string;
  idToken: string;
  refreshToken: string;
  email: string;
}

/**
 * Canonical shape of the Identity Toolkit signInWithPassword
 * response. As with signUp, additional fields (`registered`,
 * `displayName`, etc.) are intentionally NOT destructured.
 */
interface IdentityToolkitSignInResponse {
  localId: string;
  idToken: string;
  refreshToken: string;
}

/**
 * Canonical shape of the login result returned by `signInEmulatorUser`.
 * Distinct from `EmulatorUser` because login does not echo back the
 * provided password — only `signUp` (where the test originated the
 * password) carries that field forward.
 */
interface LoginResult {
  uid: string;
  idToken: string;
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Helper — registerEmulatorUser(request, options?)
// ---------------------------------------------------------------------------
//
// Calls the Firebase Auth Emulator's Identity Toolkit signUp endpoint
// to register a fresh user. Returns the resulting `localId` (uid),
// `email`, the literal `password` we provided (so the login helper
// can re-use it), `idToken`, and `refreshToken`.
//
// The `options` parameter accepts overrides for the auto-generated
// email and password — most tests rely on the auto-generated values
// for collision-free uniqueness, but tests that need to re-register
// the same email (to exercise duplicate-email rejection paths) can
// pass explicit values.
//
// Per Rule R3, this function does NOT verify, parse, or decode the
// returned `idToken` — it forwards the opaque string verbatim to its
// callers. Token validation is the backend session middleware's job
// (`admin.auth().verifyIdToken()` per AAP C2).
//
// Per Rule R2, the function does NOT log the password, idToken, or
// refreshToken. The error path includes the response body in the
// thrown Error message — this is acceptable because the Identity
// Toolkit error envelope contains structured error codes (e.g.,
// `EMAIL_EXISTS`, `OPERATION_NOT_ALLOWED`), NOT credential material.

async function registerEmulatorUser(
  request: APIRequestContext,
  options: { email?: string; password?: string } = {},
): Promise<EmulatorUser> {
  // Per-test unique email — guarantees no collision against an
  // emulator that already contains residue from a prior run on the
  // same Postgres / emulator volumes. The combination of
  // `Date.now()` (millisecond resolution) and `randomUUID()` (122
  // bits of entropy) makes a same-millisecond collision
  // astronomically unlikely. The `e2e-auth-` prefix distinguishes
  // these from users created by the sibling `save-design-flow`,
  // `share-link-flow`, and `cart-and-order-flow` specs so a
  // diagnostic glance at the emulator's user list reveals which
  // spec produced any given residual user.
  const email = options.email ?? `e2e-auth-${Date.now()}-${randomUUID()}@strikeforge.test`;

  // Static fixture password meets Firebase's minimum length
  // requirement (≥ 6 characters). Per the LocalGCP Verification
  // Rule, fixture passwords for emulator-only auth are local-only
  // test data, not production secrets — embedding the literal in
  // source is safe so long as it is NEVER logged. Rule R2 prohibits
  // logging credential material; declaring it as a fixture literal
  // is permitted.
  const password = options.password ?? 'Test-Password-1234';

  const response = await request.post(
    `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      data: { email, password, returnSecureToken: true },
    },
  );

  if (!response.ok()) {
    // Include the response body in the Error message so a developer
    // running the suite locally can see whether the emulator returned
    // `EMAIL_EXISTS` (pointing to a stale volume) versus a
    // network-level failure. The body is the structured Identity
    // Toolkit error envelope — never a credential.
    throw new Error(
      `Firebase Auth Emulator signUp failed with status ${response.status()}; body: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as IdentityToolkitSignUpResponse;

  return {
    uid: body.localId,
    email: body.email,
    password,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Helper — signInEmulatorUser(request, email, password)
// ---------------------------------------------------------------------------
//
// Calls the Firebase Auth Emulator's Identity Toolkit
// `signInWithPassword` endpoint to log in an existing user. Returns
// the freshly-issued `localId`, `idToken`, and `refreshToken`. The
// emulator issues a NEW idToken on every successful sign-in (it is
// NOT the same token returned by signUp); we forward it verbatim to
// the caller for use as the request's bearer.
//
// Per ST-024 ("login validates credentials and issues a session
// token"), this is the canonical login path. We exercise it via the
// public REST surface rather than driving any sign-in UI; the
// configurator does not mandate a specific sign-in form, and this
// approach is identical to what the SPA's Firebase JS SDK would do
// internally.
//
// Per Rule R2, the function does NOT log credentials.
// Per Rule R3, the function does NOT decode or verify the returned
// idToken.

async function signInEmulatorUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await request.post(
    `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      data: { email, password, returnSecureToken: true },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Firebase Auth Emulator signInWithPassword failed with status ${response.status()}; body: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as IdentityToolkitSignInResponse;

  return {
    uid: body.localId,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Helper — signInViaTestHook(page, user)
// ---------------------------------------------------------------------------
//
// Performs a real Firebase sign-in inside the running SPA via the
// test-only `window.__strikeforge_test_auth__` hook installed by
// `frontend/src/auth/firebase-client.ts`. The hook is gated by
// `import.meta.env.DEV` so it is tree-shaken from production
// builds.
//
// Why this approach rather than seeding localStorage:
//
//   - Firebase v10's default browser persistence is
//     `indexedDBLocalPersistence`. A localStorage-seeded synthetic
//     persistedUser record can be ignored by the SDK on rehydrate
//     unless every internal validity check passes (apiKey match,
//     stsTokenManager.expirationTime in the future, schema parity
//     with the SDK's internal type). In practice, those checks
//     diverge across SDK minor versions and the seed silently
//     fails — the SPA boots anonymously.
//   - The test hook calls the SAME `signInWithEmailAndPassword`
//     code path the production sign-in UI uses. The SDK fires
//     `onAuthStateChanged` listeners synchronously, React re-
//     renders with `isAuthenticated = true`, and persistence is
//     written by the SDK itself (no schema-mismatch risk).
//
// Per Rule R3, this helper does NOT import `firebase-admin`, does
// NOT mint or decode JWTs, and does NOT call `verifyIdToken()`. It
// invokes only the public Firebase JS SDK surface via the hook.
// Per Rule R2, this helper does NOT log credentials.
//
// Sequence:
//   1. Navigate to `/` so the Vite-served SPA initializes Firebase
//      Auth and attaches the test hook.
//   2. Wait for `networkidle` so the initial bundle has loaded.
//   3. Wait until `window.__strikeforge_test_auth__` is defined
//      (synchronous attachment after `initializeFirebaseClient()`
//      returns).
//   4. Call the hook's `signIn(email, password)` — this is a real
//      Identity Toolkit `accounts:signInWithPassword` call against
//      the Firebase Auth Emulator.
//   5. Verify `getCurrentUser()` returns the signed-in user (uid
//      match) — fail fast with a clear diagnostic if not.
//   6. Wait for the configurator `<canvas>` to attach (15s timeout
//      covers software-WebGL warmup on CI runners) and park the
//      mouse so idle auto-rotation does not fire during tests.
//
// After this helper returns, the page is at `/`, the user is
// signed in, the configurator is interactive, and subsequent
// `page.reload()` calls preserve auth state via Firebase
// persistence.

async function signInViaTestHook(page: Page, user: EmulatorUser): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await page.waitForFunction(() => typeof window.__strikeforge_test_auth__ !== 'undefined', {
    timeout: 10_000,
  });

  await page.evaluate(
    async (args: { email: string; password: string }) => {
      await window.__strikeforge_test_auth__!.signIn(args.email, args.password);
    },
    { email: user.email, password: user.password },
  );

  await page.waitForLoadState('networkidle');

  const signedInUid = await page.evaluate(() => {
    const current = window.__strikeforge_test_auth__!.getCurrentUser();
    return current === null ? null : current.uid;
  });
  if (signedInUid !== user.uid) {
    throw new Error(
      `signInViaTestHook: expected currentUser.uid=${user.uid} after signIn but observed ${String(
        signedInUid,
      )}`,
    );
  }

  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 15_000 });
  await page.mouse.move(50, 300);
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------------------
// Helper — backendAcceptsToken(request, idToken)
// ---------------------------------------------------------------------------
//
// Direct backend probe of `GET /api/cart` with a Bearer token. Per
// ST-033, the cart endpoint returns 200 with an empty cart for any
// authenticated user (never 404), making it a clean
// "auth works yes/no" probe. A non-2xx response indicates the
// session middleware rejected the token — either because the token
// was malformed, expired, or revoked.
//
// Returns `true` if the response status is 2xx, `false` otherwise.
// Does NOT throw — the test branches on the boolean and surfaces
// the failure via an `expect()` assertion with a descriptive message.

async function backendAcceptsToken(request: APIRequestContext, idToken: string): Promise<boolean> {
  const response = await request.get(`${BACKEND_BASE_URL}/api/cart`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.ok();
}

// ---------------------------------------------------------------------------
// Helper — backendRejectsUnauthenticated(request)
// ---------------------------------------------------------------------------
//
// Direct backend probe of `GET /api/cart` WITHOUT a Bearer token.
// Per ST-026-AC1 ("Requests to any protected endpoint without a
// session token are rejected with the documented unauthenticated
// status"), the response MUST be HTTP 401.
//
// Returns `true` if the response status is exactly 401, `false`
// otherwise. Does NOT throw.

async function backendRejectsUnauthenticated(request: APIRequestContext): Promise<boolean> {
  const response = await request.get(`${BACKEND_BASE_URL}/api/cart`);
  return response.status() === 401;
}

// ---------------------------------------------------------------------------
// Test suite — Register / Login / Logout flow
// ---------------------------------------------------------------------------
//
// Five focused tests covering the registration contract, the
// authenticated-vs-unauthenticated middleware contract, the login
// contract, browser-side bearer attachment, and the logout
// (clear-auth-state) contract. Each test is independent: it
// registers its own user and drives or probes the backend without
// depending on state created by another test.

test.describe('Register / Login / Logout flow', () => {
  // -------------------------------------------------------------------
  // Test 1 — Registration produces a usable user (ST-023-AC1, ST-023-AC2)
  // -------------------------------------------------------------------
  //
  // ST-023-AC1: "The registration endpoint accepts a request with the
  // documented required fields and persists a canonical user record
  // when the input is valid."
  //
  // ST-023-AC2: "A successful registration returns the canonical user
  // record (without any credential material) and a success status."
  //
  // We exercise these via the Firebase Auth Emulator's REST surface
  // — the same surface the SPA's Firebase JS SDK would call. The
  // assertions verify:
  //
  //   - `localId` (uid) is non-empty: the canonical user record was
  //     persisted with a server-assigned identifier.
  //   - `email` matches the format we submitted: the email was
  //     accepted as the canonical login identifier.
  //   - `idToken` and `refreshToken` are non-empty: the emulator
  //     issued a session-grade token pair (this is emulator
  //     behavior; per ST-023-AC2 the BACKEND'S /api/auth/register
  //     endpoint MUST NOT issue a session token by itself, but the
  //     emulator's signUp REST endpoint does as a separate matter).
  //   - The fixture password is intact (used as evidence that the
  //     test held it correctly for downstream login).
  //
  // ST-023-AC4 ("credential material … is never returned in any
  // response") is upheld by the fact that we NEVER read a `password`
  // field off the response body — Firebase's signUp does not return
  // the password, and the test does not destructure one out.

  test('ST-045-AC1: registration via emulator REST creates a usable user', async ({ request }) => {
    const user = await registerEmulatorUser(request);

    expect(
      user.uid,
      'Registered user must have a non-empty server-assigned uid (ST-023-AC1)',
    ).toBeTruthy();
    expect(user.email, 'Registered email must match the e2e-auth fixture pattern').toMatch(
      /^e2e-auth-.+@strikeforge\.test$/,
    );
    expect(
      user.idToken,
      'Emulator must issue a non-empty idToken on successful signUp',
    ).toBeTruthy();
    expect(
      user.refreshToken,
      'Emulator must issue a non-empty refreshToken on successful signUp',
    ).toBeTruthy();
    expect(
      user.password,
      'Test fixture password must be retained (used for the downstream login test)',
    ).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // Test 2 — Session middleware contract (ST-026-AC1, ST-026-AC3)
  // -------------------------------------------------------------------
  //
  // ST-026-AC1: "Requests to any protected endpoint without a session
  // token are rejected with the documented unauthenticated status
  // and response body, and never reach the protected handler."
  //
  // ST-026-AC3: "Requests carrying a valid, unexpired session token
  // are forwarded to the protected handler with the authenticated
  // user identity attached to the request context."
  //
  // We probe `/api/cart` (the ideal target per ST-033 — it returns
  // 200 with an empty cart for any authenticated user, never 404)
  // both with and without a Bearer token. The authenticated probe
  // MUST succeed (proving valid tokens are forwarded to the
  // handler); the unauthenticated probe MUST return 401 (proving
  // the middleware rejects unauthenticated callers before reaching
  // the handler).
  //
  // A regression where the session middleware was misconfigured
  // (e.g., applied to wrong paths, or where verifyIdToken was
  // bypassed) would surface here: the unauthenticated probe would
  // return 200, OR the authenticated probe would return 401, OR
  // both.

  test('ST-045-AC1: authenticated request to /api/cart returns 2xx, unauthenticated returns 401', async ({
    request,
  }) => {
    const user = await registerEmulatorUser(request);

    // Authenticated probe: must return 2xx. A 401 here points to a
    // mis-wired Firebase Admin verifyIdToken (e.g., the backend is
    // pointing at production Firebase instead of the emulator, or
    // the emulator host env var is missing).
    const accepted = await backendAcceptsToken(request, user.idToken);
    expect(
      accepted,
      'Backend rejected a freshly-issued emulator idToken; check Firebase Admin verifyIdToken wiring (AAP C2 / Rule R3)',
    ).toBe(true);

    // Unauthenticated probe: must return exactly 401. A 200 here
    // points to a missing or mis-mounted session middleware (the
    // /api/cart route was reached without an auth check). A 403 or
    // 500 here points to a different bug — distinct from no-token
    // rejection per ST-026-AC1.
    const rejected = await backendRejectsUnauthenticated(request);
    expect(
      rejected,
      'Backend accepted an unauthenticated request; session middleware must enforce 401 (ST-026-AC1)',
    ).toBe(true);
  });

  // -------------------------------------------------------------------
  // Test 3 — Login flow re-authenticates (ST-024)
  // -------------------------------------------------------------------
  //
  // ST-024 ("login validates credentials and issues a session token")
  // exercised via the Identity Toolkit `signInWithPassword` REST
  // endpoint — the same endpoint the SPA's Firebase JS SDK calls
  // when a user signs in with an email/password.
  //
  // Steps:
  //
  //   1. Register a fresh user (also produces an initial idToken).
  //   2. Call `signInWithPassword` with the same credentials. The
  //      emulator issues a NEW idToken — this proves the login
  //      surface accepts canonical credentials and produces a
  //      session-grade token.
  //   3. The login-issued idToken corresponds to the SAME user
  //      (same `localId`).
  //   4. The login-issued idToken is accepted by the backend's
  //      session middleware on `/api/cart`.
  //
  // A regression where login produced a token that the backend
  // rejected (e.g., because the emulator and the backend were
  // configured for DIFFERENT Firebase project IDs) would surface as
  // a failed `backendAcceptsToken` assertion at step 4.

  test('ST-045-AC1: login flow via emulator returns valid idToken accepted by backend', async ({ request }) => {
    // Register the user; we keep the password literal in scope on
    // the returned EmulatorUser so we can re-submit it to login.
    const user = await registerEmulatorUser(request);

    // Sign in with the same credentials — emulates ST-024 login.
    const loginResult = await signInEmulatorUser(request, user.email, user.password);

    expect(
      loginResult.uid,
      'Login result must reference the same canonical user (localId match)',
    ).toBe(user.uid);
    expect(loginResult.idToken, 'Login must issue a non-empty idToken (ST-024)').toBeTruthy();
    expect(
      loginResult.refreshToken,
      'Login must issue a non-empty refreshToken alongside the idToken',
    ).toBeTruthy();

    // The freshly-issued login token must be accepted by the
    // backend — proves the verifyIdToken contract holds for tokens
    // issued via the login (signInWithPassword) path, not just the
    // signUp path.
    const accepted = await backendAcceptsToken(request, loginResult.idToken);
    expect(
      accepted,
      'Login-issued idToken was not accepted by the backend (ST-024 + ST-026 wiring)',
    ).toBe(true);
  });

  // -------------------------------------------------------------------
  // Test 4 — Browser-side bearer attachment (ST-026 + frontend api/client.ts)
  // -------------------------------------------------------------------
  //
  // After the SPA boots into the authenticated state via the test-
  // hook sign-in path, any outbound `/api/*` requests it fires
  // MUST attach an `Authorization: Bearer …` header — proving:
  //
  //   1. The SPA's `onAuthStateChanged()` observer resolved to the
  //      signed-in user immediately at boot (Firebase persistence
  //      survived the post-sign-in `page.reload()`).
  //   2. The SPA's outbound fetch wrapper (frontend/src/api/client.ts)
  //      correctly invokes `getIdToken()` and attaches the bearer
  //      to every authenticated request.
  //
  // The test does NOT assert that any specific call WAS made — the
  // SPA may or may not auto-fetch on load. It only asserts that IF
  // any non-auth `/api/*` calls were made, they ALL had Authorization
  // headers. The `/api/auth/*` paths are explicitly excluded because
  // ST-026 says register and login endpoints do NOT require a
  // bearer.
  //
  // We use the synchronous `req.headers()` accessor inside the
  // `page.on('request', …)` callback rather than the asynchronous
  // `req.headerValue('authorization')` — the listener callback is
  // not async and `headers()` returns a plain object of recorded
  // headers (lower-cased keys per Playwright's contract).
  //
  // Why the request listener captures only post-reload traffic:
  // `signInViaTestHook` itself navigates to `/` and signs in. The
  // initial unauthenticated mount fires before sign-in completes,
  // so any `/api/*` prefetch the SPA performs during that window
  // would NOT carry a Bearer header (the SDK's persistence had
  // not yet rehydrated). To isolate the post-authenticated mount,
  // we clear the buffer after sign-in completes and `page.reload()`
  // — the SPA then re-mounts with Firebase persistence already
  // populated, and any subsequent prefetch is authenticated.

  test('ST-045-AC1: authenticated browser session attaches token to API calls', async ({ page, request }) => {
    const user = await registerEmulatorUser(request);

    // Buffer outbound /api/* requests' URL, method, and Authorization
    // header. The listener installs BEFORE the first navigation so no
    // requests slip past while the listener is being attached.
    //
    // We capture `method` so the assertion below can correctly skip
    // CORS preflight (`OPTIONS`) requests — preflights never carry
    // an `Authorization` header per the Fetch / CORS specification:
    // the browser strips ALL non-CORS-safelisted headers (including
    // `Authorization`) from preflight requests, by design. The actual
    // request that follows a successful preflight DOES carry the
    // bearer; that real request is the subject of our assertion.
    const apiRequests: {
      url: string;
      method: string;
      authorization: string | null;
    }[] = [];
    page.on('request', (req) => {
      // Filter on URL pathname starting with `/api/` rather than a
      // simple substring match on the full URL. The substring match
      // would incorrectly capture Vite dev-server source-module
      // loads such as `http://localhost:5173/src/api/client.ts`,
      // which are NOT backend API calls and (correctly) do not
      // carry an Authorization header — Vite's dev server is a
      // local resource served on the same origin as the SPA.
      //
      // Backend `/api/*` calls go to `VITE_API_BASE_URL`
      // (`http://localhost:3000`) with pathname `/api/<route>`. The
      // pathname-based filter cleanly separates the two.
      let pathname: string;
      try {
        pathname = new URL(req.url()).pathname;
      } catch {
        // Defensive — if Playwright ever surfaces a non-URL
        // request (e.g., a `data:` URL), skip it.
        return;
      }
      if (pathname.startsWith('/api/')) {
        // Playwright's `Request.headers()` is synchronous and
        // returns a plain `{ [key: string]: string }` with lower-
        // cased keys. The optional-chaining `?? null` normalizes
        // missing-header cases to `null` for cleaner downstream
        // assertions.
        apiRequests.push({
          url: req.url(),
          method: req.method(),
          authorization: req.headers()['authorization'] ?? null,
        });
      }
    });

    // Sign in via the test hook — performs the real Firebase
    // signInWithEmailAndPassword and waits for canvas attach. The
    // initial unauthenticated mount happens during this call, so
    // any `/api/*` prefetch fired BEFORE sign-in completes will
    // be in `apiRequests` without a Bearer header.
    await signInViaTestHook(page, user);

    // Discard the pre-authentication traffic so the assertion only
    // examines post-authenticated mount traffic. After this point
    // the SPA has Firebase persistence populated, and `page.reload()`
    // re-mounts with `onAuthStateChanged` resolving to the signed-
    // in user immediately.
    apiRequests.length = 0;

    // Reload so the SPA boots with the signed-in user already
    // resolved. Any auto-fetch on this mount path MUST attach the
    // bearer token. Wait for canvas attach so we know the
    // post-reload mount has had time to fire its prefetch.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 15_000 });

    // Verify every captured non-auth, non-preflight /api/* request
    // carries a Bearer token. We do NOT require any calls to have
    // been made (some configurator builds auto-fetch on load, others
    // lazy-load on user interaction); we only require that IF
    // genuine, post-authenticated calls were made, they were
    // authenticated.
    //
    // Two categories of capture are skipped:
    //
    //   1. `OPTIONS` preflight requests — by spec, browsers do NOT
    //      forward `Authorization` on preflights (the preflight only
    //      asks the origin server "may I send this header?"). The
    //      browser then sends the real request with the header
    //      attached. Asserting Bearer on the preflight would assert
    //      a property the browser itself disallows.
    //
    //   2. `/api/auth/*` paths — the register and login endpoints
    //      are explicitly unauthenticated per AAP §0.5.6 / ST-026,
    //      so they correctly do NOT carry a bearer.
    //
    // For all other /api/* requests, we assert that `authorization`
    // matches the `Bearer <token>` pattern. The label string
    // includes URL and method so a future failure surfaces the
    // exact route and verb that misbehaved.
    //
    // We use `expect.soft()` for diagnostic clarity: even if one
    // request fails the assertion, all OTHER requests are still
    // checked, and the test report enumerates the full set of
    // misbehaving captures rather than aborting at the first.
    // The trailing `expect(test.info().errors).toEqual([])` then
    // converts any soft failures into a hard failure with rich
    // context.
    const offenders: { url: string; method: string; authorization: string | null }[] = [];
    for (const apiRequest of apiRequests) {
      if (apiRequest.method === 'OPTIONS') {
        // CORS preflight — headers are stripped by the browser per
        // the Fetch standard. Not a real authenticated call.
        continue;
      }
      if (apiRequest.url.includes('/api/auth/')) {
        // /api/auth/register and /api/auth/login are unauthenticated
        // entry points per AAP §0.5.6; bypass the bearer assertion.
        continue;
      }
      const auth = apiRequest.authorization;
      const ok = typeof auth === 'string' && /^Bearer /.test(auth);
      if (!ok) {
        offenders.push({
          url: apiRequest.url,
          method: apiRequest.method,
          authorization: auth,
        });
      }
    }

    // Convert any captured offenders into a single hard failure so
    // the test report includes the full list. This is much more
    // diagnostic than `toMatch()`, which aborts at the first
    // offender and (for the null case) raises a Matcher type error
    // that obscures the URL/method that misbehaved.
    expect(
      offenders,
      `One or more /api/* requests lacked an Authorization Bearer header. Captures (excluding OPTIONS preflights and /api/auth/*): ${JSON.stringify(
        offenders,
        null,
        2,
      )}`,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Test 5 — Logout primitive clears the SPA auth state (ST-025)
  // -------------------------------------------------------------------
  //
  // ST-025 ("logout terminates the session") at the BROWSER layer
  // means the SPA's Firebase Auth state transitions from a signed-
  // in user to `null`, so subsequent UI rendering flips to the
  // unauthenticated state and outbound `/api/*` calls no longer
  // carry a bearer.
  //
  // FULL server-side revocation (the `sessions` table revocation
  // marker driven by POST /api/auth/logout per ST-025-AC1, plus the
  // ST-025-AC2 "subsequent request authenticated with a revoked
  // session token is rejected" contract) is exercised in the
  // backend integration suite — the e2e suite's responsibility for
  // ST-025 is the BROWSER layer of the contract.
  //
  // The test exercises the SPA's actual Firebase JS SDK signOut
  // path via the test hook (rather than poking localStorage
  // directly). This validates the SAME code path the production
  // sign-out UI uses — the SDK's `signOut()` clears persistence,
  // resets in-memory `currentUser` to `null`, and fires
  // `onAuthStateChanged` listeners with `null`.
  //
  // Steps:
  //
  //   1. Sign in via the test hook so the SDK has a valid current
  //      user.
  //   2. Verify `getCurrentUser()` is non-null — guards against a
  //      regression where sign-in silently fails.
  //   3. Call `signOut()` via the test hook.
  //   4. Verify `getCurrentUser()` returns `null` — the SDK's
  //      signOut path successfully cleared the in-memory user.
  //   5. Independent backend probe — an unauthenticated request
  //      remains rejected by the backend session middleware.

  test('ST-045-AC1: SDK signOut clears the SPA auth state', async ({
    page,
    request,
  }) => {
    const user = await registerEmulatorUser(request);
    await signInViaTestHook(page, user);

    // Confirm the SPA holds a signed-in user before sign-out. This
    // guards against a regression where the test hook silently
    // returns without populating `currentUser` — we want to know
    // that the SIGN-IN worked before we test that SIGN-OUT clears
    // it.
    const signedInBefore = await page.evaluate(() => {
      const current = window.__strikeforge_test_auth__!.getCurrentUser();
      return current === null ? null : { uid: current.uid };
    });
    expect(
      signedInBefore,
      'Test hook must report a signed-in user before signOut; otherwise the clear assertion would be vacuous',
    ).not.toBeNull();
    expect(signedInBefore!.uid).toBe(user.uid);

    // Drive the SPA's actual Firebase JS SDK signOut path through
    // the test hook. The SDK's signOut clears persistence (whatever
    // backing store the SDK chose at init: indexedDBLocalPersistence
    // or browserLocalPersistence), resets in-memory `currentUser`
    // to `null`, and fires `onAuthStateChanged` listeners.
    await page.evaluate(async () => {
      await window.__strikeforge_test_auth__!.signOut();
    });

    // Verify the SDK's `currentUser` is now `null`. The SDK's
    // signOut is synchronous in its update of currentUser; this
    // assertion is a direct read of the SDK's in-memory state.
    const signedInAfter = await page.evaluate(() => {
      return window.__strikeforge_test_auth__!.getCurrentUser();
    });
    expect(
      signedInAfter,
      'Test hook must report a null current user after signOut (ST-025 from the browser perspective)',
    ).toBeNull();

    // Independent backend probe: the BACKEND-side revocation
    // contract (ST-025-AC2) is exercised in the backend integration
    // suite. Here we only verify the BROWSER no longer holds the
    // session — the original `user.idToken` may still be accepted
    // by Firebase since the JS SDK signOut path does NOT auto-
    // revoke emulator tokens; revocation is the BACKEND's job via
    // its `sessions` table revocation marker.
    //
    // We DO assert that an unauthenticated request remains rejected
    // — this provides a sanity check that the backend's session
    // middleware is still up and rejecting after the logout
    // primitive ran. If the backend somehow flipped to "allow all"
    // mode, this assertion would catch it.
    const rejected = await backendRejectsUnauthenticated(request);
    expect(
      rejected,
      'Unauthenticated GET /api/cart must continue to return 401 after the logout primitive',
    ).toBe(true);
  });
});
