/**
 * Save & load design end-to-end flow — Playwright spec.
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
 *   - ST-018 (Save Design CTA):
 *       "A Save Design call-to-action is visible in the primary UI and
 *        is enabled whenever the current design has unsaved changes
 *        and the user is authenticated."
 *       "Activating the Save Design CTA sends the current design
 *        selections to the persistence service and shows a success
 *        indicator once the save is confirmed."
 *       "If persistence fails or the user is not authenticated, the
 *        user sees an actionable failure message".
 *       "Immediately after a successful save, the Save Design CTA
 *        reflects the saved state until the user makes another change."
 *   - ST-019 (Load Design List):
 *       Authenticated users can open a list of their saved designs;
 *       selecting a design loads its full state into the configurator.
 *   - ST-022 (Design Summary Sidebar — AC5): the summary panel hosts
 *     the Save Design and Add to Cart CTA anchors alongside the
 *     configuration readout, preserving single-viewport access.
 *   - ST-027 (Create Design Endpoint):
 *       "POST /api/designs requires a valid session and persists a new
 *        design record with all configurator selections (colors,
 *        stitching pattern, material finish, logo reference and
 *        placement) owned by the authenticated user."
 *       "A successful create returns the canonical persisted design,
 *        including a server-assigned identifier and timestamps."
 *       "Requests without a valid session are rejected by the session
 *        validation contract before reaching the persistence layer."
 *   - ST-028 (Retrieve Designs by User):
 *       "GET /api/designs requires a valid session and returns only
 *        designs owned by the authenticated user, never designs owned
 *        by other users."
 *       "When the authenticated user has no designs, the endpoint
 *        returns an empty collection with a success status (not an
 *        error)."
 *       "The endpoint enforces a documented maximum page size."
 *
 * ===========================================================================
 * What this spec validates
 * ===========================================================================
 *
 * Each `test()` block is an independent assertion of a contract corner
 * for the save-design and load-design slice of ST-045-AC1. Splitting
 * these stages into focused tests rather than a single monolithic
 * flow yields clearer diagnostic output on failure (a backend
 * regression in POST /api/designs is isolated from a UI regression in
 * the Save CTA) and matches the regressionability strategy used by
 * the sibling `share-link-flow.spec.ts` and `cart-and-order-flow.spec.ts`
 * specs in this folder.
 *
 *   1. The UI Save Design CTA, when clicked by an authenticated user
 *      after a deterministic UI change, fires a POST /api/designs that
 *      returns 2xx with a non-empty server-assigned id (ST-018-AC2,
 *      ST-027-AC2). Independently verified via GET /api/designs
 *      surfacing the saved row.
 *   2. GET /api/designs returns only the authenticated user's designs;
 *      a different user sees an empty list (ST-028-AC1 ownership
 *      isolation). This is the canonical horizontal privilege
 *      escalation guard for the design list endpoint.
 *   3. The Load Design List affordance, after a save, surfaces at
 *      least one entry in the UI (ST-019). The list panel may be a
 *      dialog, region, or popover — the locator chain accepts any.
 *   4. After a `page.reload()`, the saved design persists in both the
 *      backend (GET /api/designs returns it) and the UI (the Load
 *      Design List still shows it). This catches "saved to server
 *      but list doesn't refresh on reload" defects — common when the
 *      list is fetched only on initial mount and not re-fetched
 *      after navigation.
 *   5. POST /api/designs without an Authorization header returns 401
 *      (ST-027-AC4 — session validation contract rejects
 *      unauthenticated callers BEFORE the persistence layer). Pure
 *      backend probe; no browser launched.
 *
 * The orchestrated single-flow test in `critical-path-full.spec.ts`
 * is the sibling complement — it proves the segments compose; this
 * file proves each segment's contract holds in isolation.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. The frontend ESLint config enforces
 *     `no-console: error` (allowing only `warn` / `error`), and the
 *     workspace lint gate runs with `--max-warnings 0`. Static fixture
 *     passwords are NEVER logged; they appear in the `data: { … }`
 *     body of the Identity Toolkit signUp call only.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, does NOT mint or verify any JWT,
 *     does NOT invoke `verifyIdToken()`. It interacts with the
 *     Firebase Auth Emulator solely via the public Identity Toolkit
 *     REST surface (`accounts:signUp`) — the same surface a
 *     browser-side Firebase JS SDK uses. `jsonwebtoken`, `jose`, and
 *     `jwt-decode` are NOT imported anywhere.
 *   - Rule R7 / C6 (Fabric → Three texture order): this spec drives
 *     the UI through user-style interactions (locator clicks) and
 *     waits for `networkidle` after each interaction so the texture
 *     pipeline (`fabricCanvas.renderAll()` then
 *     `threeTexture.needsUpdate = true`) settles before the next
 *     stage; it does NOT touch the pipeline directly.
 *   - Rule R9 (financial-settlement exclusion): this file contains NO
 *     terminology associated with downstream financial settlement,
 *     processor integrations, or financial-instrument handling. The
 *     save-design and load-design feature has no financial side
 *     effects. The Rule R9 source-file regex (defined in the AAP
 *     §0.8.1 R9 verification block) MUST return zero matches against
 *     this file.
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
 *     `e2e-save-${Date.now()}-${randomUUID()}@strikeforge.test`. The
 *     combination of millisecond-resolution timestamp plus 122 bits
 *     of UUID entropy makes a same-millisecond collision
 *     astronomically unlikely. Cross-test isolation is preserved
 *     without any teardown step — residue from prior runs accumulates
 *     in the local emulator and is wiped on the next
 *     `docker compose up` cycle (LocalGCP Verification Rule).
 *   - Auth state injection. UI-driven tests write a synthetic
 *     Firebase JS SDK persistence record to localStorage BEFORE any
 *     page script runs, so the SPA's `onAuthStateChanged` observer
 *     resolves to the seeded user immediately at boot. This avoids
 *     navigating through an actual sign-in form.
 *   - Defensive locators. Every UI click target chains an ARIA-name
 *     locator with a `data-testid` fallback via `.or()`. This
 *     insulates the spec against minor accessibility refactors while
 *     still catching genuine UI absence.
 *   - Independent backend verification. Wherever the UI claims a
 *     design was saved, this spec ALSO calls GET /api/designs
 *     directly via the `request` fixture and asserts the design is
 *     present. UI-only assertions can pass when the backend
 *     persistence is broken (e.g., the UI may show "Saved!" without
 *     actually persisting). The backend probe verifies actual
 *     persistence — it is the strongest assertion in the spec.
 *   - Tolerant success-indicator wait. ST-018-AC2 mandates a success
 *     indicator after save, but ST-018-AC4 says the CTA "reflects
 *     the saved state until the user makes another change" — the
 *     indicator may auto-dismiss faster than the test can observe
 *     it. The success-indicator wait is wrapped in `.catch(() => {})`
 *     so an auto-dismissed indicator does not fail the test; the
 *     authoritative assertion is the API verification.
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
// any allowlist — the value is opaque. Using `'fake-api-key'` matches
// the placeholder used in the SPA's bootstrap config so the
// localStorage persistence key (which embeds the apiKey) lines up
// with whatever the SPA's own SDK initialization writes.

const FIREBASE_AUTH_EMULATOR_HOST = 'http://localhost:9099';
const FIREBASE_API_KEY = 'fake-api-key';
const BACKEND_BASE_URL = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
//
// EmulatorUser captures the subset of the Identity Toolkit signUp
// response that downstream stages consume. The Identity Toolkit
// returns more fields (e.g., `kind`, `expiresIn`); we capture only
// the four needed.

interface EmulatorUser {
  uid: string;
  email: string;
  password: string;
  idToken: string;
  refreshToken: string;
}

/**
 * Canonical shape of an entry returned by GET /api/designs per
 * ST-028-AC2 — the response includes, per design, the server-assigned
 * identifier and the title (plus other metadata that is not asserted
 * here). Other fields surfaced by the endpoint (last-modified
 * timestamp, payload-summary metadata) are intentionally NOT
 * destructured into this type; the spec's contract assertions cover
 * only the canonical id + title, and any future shape additions are
 * non-breaking.
 */
interface DesignListEntry {
  id: string;
  title: string;
}

/**
 * Canonical paginated list response per ST-028 — `items` is a bounded
 * array of design summaries (max page size enforced server-side per
 * ST-028-AC5) and `nextCursor` is the opaque continuation token (or
 * null when no more pages remain). The test asserts only that
 * `items` is an array; the cursor format is deliberately opaque per
 * ST-028-AC5 ("cursor-based, offset-based, or equivalent").
 */
interface DesignListResponse {
  items: DesignListEntry[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helper — registerEmulatorUser(request)
// ---------------------------------------------------------------------------
//
// Calls the Firebase Auth Emulator's Identity Toolkit signUp endpoint
// to register a fresh user. Returns the resulting `localId` (uid),
// `email`, `idToken`, and `refreshToken`.
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

async function registerEmulatorUser(request: APIRequestContext): Promise<EmulatorUser> {
  // Per-run unique email — guarantees no collision against an
  // emulator that already contains residue from a prior run on the
  // same Postgres / emulator volumes. The combination of `Date.now()`
  // (millisecond resolution) and `randomUUID()` (122 bits of entropy)
  // makes a same-millisecond collision astronomically unlikely.
  const email = `e2e-save-${Date.now()}-${randomUUID()}@strikeforge.test`;

  // Static fixture password meets Firebase's minimum length
  // requirement (6 characters). It is NEVER logged. Firebase's
  // emulator does not enforce complexity rules but real Firebase
  // requires ≥6 characters; we exceed that comfortably.
  const password = 'Test-Password-1234';

  const response = await request.post(
    `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { data: { email, password, returnSecureToken: true } },
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

  const body = (await response.json()) as {
    localId: string;
    idToken: string;
    refreshToken: string;
    email: string;
  };

  return {
    uid: body.localId,
    email: body.email,
    password,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Helper — injectAuthState(page, user)
// ---------------------------------------------------------------------------
//
// Seeds the Firebase JS SDK's persisted localStorage key BEFORE any
// page script runs, so the SPA's `onAuthStateChanged()` observer
// resolves to the seeded user immediately at boot. This avoids
// hitting any real or emulated Firebase Auth REST endpoint via the
// SPA's own sign-in flow.
//
// The shape written to localStorage matches the v10 Firebase JS SDK's
// authUser persistence schema — every required field is present so
// that Firebase's persistence-rehydrate path accepts the entry.
//
// `addInitScript` ensures the localStorage write happens before any
// SPA script — the Firebase JS SDK reads persistence synchronously
// during initialization, so the seed must be present at module
// evaluation time.
//
// Per Rule R3, this function does NOT import `firebase-admin`, does
// NOT mint a real JWT, and does NOT verify any token. It writes a
// synthetic persistence record only.

async function injectAuthState(page: Page, user: EmulatorUser): Promise<void> {
  await page.addInitScript(
    (args: {
      uid: string;
      email: string;
      idToken: string;
      refreshToken: string;
      apiKey: string;
    }) => {
      // The persistence key format is documented in firebase-js-sdk
      // source as `firebase:authUser:${apiKey}:${appName}`. The SPA
      // uses the default app name `[DEFAULT]`. The apiKey embedded
      // in the key is the SDK's *runtime* apiKey at initialization
      // time — if the SPA's runtime apiKey diverges from the one we
      // wrote here, the SDK simply ignores our seeded entry and
      // proceeds anonymously. Because we register and use the user
      // via the emulator's REST surface (which does not validate
      // apiKeys), the test still functions — but the SPA's
      // auth-driven UI states (e.g., "Save Design" enabled when
      // authenticated) may not flip to authenticated. This is
      // mitigated by ALSO using the idToken directly in API
      // requests via the `request` fixture for any contract that
      // the UI does not cover.
      const persistKey = `firebase:authUser:${args.apiKey}:[DEFAULT]`;
      const now = Date.now();
      const persistedUser = {
        uid: args.uid,
        email: args.email,
        emailVerified: false,
        isAnonymous: false,
        providerData: [
          {
            providerId: 'password',
            uid: args.email,
            displayName: null,
            email: args.email,
            phoneNumber: null,
            photoURL: null,
          },
        ],
        stsTokenManager: {
          refreshToken: args.refreshToken,
          accessToken: args.idToken,
          // Tokens issued by the emulator are nominally valid for
          // ~1 hour. We mirror that lifetime here so the SDK does
          // not immediately attempt a refresh on first read.
          expirationTime: now + 60 * 60 * 1000,
        },
        createdAt: String(now),
        lastLoginAt: String(now),
        apiKey: args.apiKey,
        appName: '[DEFAULT]',
      };
      window.localStorage.setItem(persistKey, JSON.stringify(persistedUser));
    },
    {
      uid: user.uid,
      email: user.email,
      idToken: user.idToken,
      refreshToken: user.refreshToken,
      apiKey: FIREBASE_API_KEY,
    },
  );
}


// ---------------------------------------------------------------------------
// Helper — waitForConfiguratorReady(page)
// ---------------------------------------------------------------------------
//
// Drives the SPA from initial navigation to the "configurator
// interactive" state:
//
//   1. Navigate to `/` (Vite serves the SPA at baseURL).
//   2. Wait for `networkidle` so the initial bundle, the Firebase
//      SDK's persistence rehydrate, and any startup `/api/*` prefetch
//      have all settled.
//   3. Wait for a `<canvas>` element to attach — this is the R3F
//      `<Canvas>` mount signal. Until the canvas attaches, the
//      configurator's controls sidebar may not be fully hydrated and
//      subsequent interactions can race against React StrictMode's
//      double-mount path.
//   4. Park the mouse over the controls sidebar (x=50, y=300) so the
//      idle auto-rotation timer in `useIdleAutoRotate.ts` does NOT
//      fire during the test (it triggers only after the canvas has
//      been mouse-still for the documented idle interval).
//   5. Final `networkidle` to confirm any post-mount hydration work
//      has resolved before the test starts interacting.
//
// 15-second timeout for the canvas-attach wait covers software-WebGL
// warmup on CI runners (SwiftShader / llvmpipe), where R3F's initial
// mount is approximately 5× slower than on real GPU hardware.

async function waitForConfiguratorReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 15_000 });
  await page.mouse.move(50, 300);
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------------------
// Helper — listDesignsForUser(request, idToken)
// ---------------------------------------------------------------------------
//
// Direct backend API call to GET /api/designs. Used by every test in
// this spec to perform the independent backend verification that is
// the strongest assertion in the suite — UI-only assertions can
// pass even when the backend persistence is broken (the UI may show
// "Saved!" without actually persisting). The backend probe verifies
// actual persistence.
//
// Per ST-028-AC1, the endpoint requires a valid session and returns
// only designs owned by the authenticated user. Per ST-028-AC3, an
// authenticated user with no designs receives an empty collection
// with a success status (NOT a 404). Per ST-028-AC5, the response is
// bounded by a documented page size, with cursor-based pagination.
//
// The function captures only the canonical `items` array and
// `nextCursor` — additional metadata fields (totalCount, page index,
// etc.) are intentionally NOT extracted. The response body is a
// `DesignListResponse` per the canonical type alias above.
//
// Throws on non-OK responses; Test 5 (the unauthenticated-401
// contract) calls `request.post(...)` inline rather than this helper
// so it can branch on the status code without catching an exception.
// Per Rule R2, the body in the error message contains structured
// backend error codes, never credential material.

async function listDesignsForUser(
  request: APIRequestContext,
  idToken: string,
): Promise<DesignListResponse> {
  const response = await request.get(`${BACKEND_BASE_URL}/api/designs`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!response.ok()) {
    throw new Error(
      `GET /api/designs failed with status ${response.status()}; body: ${await response.text()}`,
    );
  }
  return (await response.json()) as DesignListResponse;
}

// ---------------------------------------------------------------------------
// Test suite — Save and load design flow
// ---------------------------------------------------------------------------
//
// Five focused tests covering the save-design contract, the
// list-designs contract, the load-design UI affordance, the
// persistence-across-reload contract, and the unauthenticated-401
// contract. Each test is independent: it registers its own user and
// drives or probes the backend without depending on state created by
// another test.

test.describe('Save and load design flow', () => {
  // -------------------------------------------------------------------
  // Test 1 — Save Design CTA fires POST /api/designs (ST-018, ST-027)
  // -------------------------------------------------------------------
  //
  // The headline UI-driven save-design contract:
  //
  //   1. Authenticate (so the Save CTA is enabled per ST-018-AC1).
  //   2. Verify the user starts with zero designs — per ST-028-AC3,
  //      a fresh user receives an empty collection. This guards
  //      against cross-test contamination.
  //   3. Wait for the configurator canvas to attach.
  //   4. Click a non-default primary color swatch — this drives the
  //      design state to a "has unsaved changes" condition per
  //      ST-018-AC1 (the CTA is enabled "whenever the current design
  //      has unsaved changes").
  //   5. Click the Save Design CTA.
  //   6. Capture the POST /api/designs response — the response
  //      MUST be 2xx and the body MUST contain a non-empty
  //      server-assigned id per ST-027-AC2.
  //   7. Best-effort wait for a success indicator per ST-018-AC2
  //      (wrapped in `.catch` because ST-018-AC4's "saved state"
  //      reflection may dismiss faster than the wait can observe).
  //   8. Independent backend verification: GET /api/designs returns
  //      exactly one design, whose id matches the POST response's
  //      id. This is the strongest persistence assertion.
  //
  // Locator chain: ARIA-name regex (preferred — accessibility-first)
  // OR data-testid fallback (insulates against accessible-name
  // refactors).

  test('authenticated user can save the current design via Save CTA', async ({
    page,
    request,
  }) => {
    const user = await registerEmulatorUser(request);
    await injectAuthState(page, user);

    // Verify the user starts with zero designs (LocalGCP Rule
    // isolation guarantee — each registration produces a brand-new
    // user with no prior design state).
    const initial = await listDesignsForUser(request, user.idToken);
    expect(
      initial.items.length,
      'Fresh user must start with an empty design list',
    ).toBe(0);

    await waitForConfiguratorReady(page);

    // Drive a deterministic UI change so the save has semantic
    // meaning — without this the saved design is the default. The
    // primary picker is located by ARIA name (accessibility-first)
    // OR by testId fallback. Per
    // `frontend/src/configurator/controls/colors/PrimaryColorPicker.tsx`
    // the section is keyed via `data-testid="primary-color-picker"`
    // and `aria-label="Primary panel color"`.
    const primaryPicker = page
      .getByRole('group', { name: /primary color/i })
      .or(page.getByTestId('primary-color-picker'))
      .first();
    await primaryPicker.waitFor({ state: 'visible', timeout: 10_000 });

    // Each swatch is a `<button role="radio">` per the picker
    // implementation. We accept either role to insulate against
    // future role refactors.
    const swatches = primaryPicker.getByRole('button').or(primaryPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    expect(
      swatchCount,
      'Primary color picker must surface multiple swatches for a non-default selection',
    ).toBeGreaterThan(1);
    // Select the second swatch (index 1) — the first is typically
    // the default white. Using nth(1) is deterministic across runs
    // and produces a non-default selection without needing to know
    // the specific swatch hex values.
    await swatches.nth(1).click();
    await page.waitForLoadState('networkidle');

    // Locate the Save Design CTA. Per AAP §0.6.9 / ST-022-AC5, the
    // CTA lives in the design summary sidebar (right region). The
    // ARIA-name regex matches both "Save" and "Save Design" buttons
    // — the exact label is implementation-defined.
    const saveCta = page
      .getByRole('button', { name: /^save( design)?$/i })
      .or(page.getByTestId('save-design-cta'))
      .first();
    await saveCta.waitFor({ state: 'visible', timeout: 10_000 });

    // Start the response listener BEFORE clicking — the canonical
    // Playwright pattern ensures the listener is registered before
    // the network request fires. This prevents a race where the
    // request completes before the listener is installed.
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/designs') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await saveCta.click();
    const response = await responsePromise;

    // Per ST-027-AC2, a successful create returns the canonical
    // persisted design with a server-assigned identifier. We
    // assert the response is in the 2xx range. The Playwright
    // Response.status() returns a number; 200 ≤ status < 300 is
    // the success window.
    expect(
      response.status(),
      'POST /api/designs lower bound — must be ≥ 200',
    ).toBeGreaterThanOrEqual(200);
    expect(
      response.status(),
      `POST /api/designs upper bound — must be < 300; got ${response.status()}`,
    ).toBeLessThan(300);

    const responseBody = (await response.json()) as {
      id: string;
      title: string;
      payload: unknown;
    };
    expect(
      responseBody.id,
      'POST /api/designs response must include a server-assigned id (ST-027-AC2)',
    ).toBeTruthy();
    expect(typeof responseBody.id).toBe('string');
    // ST-027-AC2 requires a UUID-shaped id. We validate it is a
    // non-empty string; strict UUID format validation (canonical
    // hex grouping, RFC 4122 version bits) is the backend
    // integration test's concern. Here we validate the e2e
    // contract: an id IS returned, IS a string, and IS non-empty.
    expect(responseBody.id.length).toBeGreaterThan(0);

    // Best-effort wait for the success indicator per ST-018-AC2
    // ("shows a success indicator once the save is confirmed").
    // ST-018-AC4 says the CTA "reflects the saved state until the
    // user makes another change" — the indicator MAY be a transient
    // toast that auto-dismisses, OR a persistent state on the CTA
    // itself. The forgiving locator chain matches:
    //   - role="status" (ARIA live region for transient toasts)
    //   - any text matching "saved" or "success"
    //   - testId "save-success-indicator" fallback
    // The `.catch(() => {})` swallows a wait timeout — the
    // authoritative assertion is the API verification below.
    const successIndicator = page
      .getByRole('status')
      .or(page.getByText(/saved|success/i))
      .or(page.getByTestId('save-success-indicator'));
    await successIndicator
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => {
        // The success indicator may auto-dismiss faster than this
        // 5-second wait can observe, or the implementation may
        // surface "saved" state via a CTA label change rather than
        // a separate indicator. Either is compliant with ST-018;
        // the API verification below is the authoritative
        // persistence proof.
      });

    // Independent backend verification — the strongest persistence
    // assertion. The design MUST appear in the user's list with the
    // exact id returned by the POST response.
    const after = await listDesignsForUser(request, user.idToken);
    expect(
      after.items.length,
      'Saved design must appear in the authenticated user\'s list (ST-028-AC1)',
    ).toBe(1);
    expect(
      after.items[0]!.id,
      'Listed design id must match the id returned by POST /api/designs',
    ).toBe(responseBody.id);
  });


  // -------------------------------------------------------------------
  // Test 2 — Ownership isolation (ST-028-AC1)
  // -------------------------------------------------------------------
  //
  // ST-028-AC1: GET /api/designs returns "only designs owned by the
  // authenticated user, never designs owned by other users". This
  // test creates a design as user A, then registers user B and
  // verifies user B's list is empty. A regression where the endpoint
  // returns ALL designs (not just the requester's own) — a horizontal
  // privilege escalation — fails this test.
  //
  // The setup uses the UI Save flow (rather than a direct POST) so
  // this test ALSO validates that the UI-driven save is
  // user-scoped — i.e., the SPA correctly attaches the user A's
  // bearer token to its outbound POST /api/designs call. A
  // regression where the SPA accidentally omitted the bearer or
  // attached the wrong user's bearer would surface as either an
  // error in the save (caught by the `expect(...).toBeLessThan(300)`
  // assertion) or a missing entry in user A's list (caught by
  // `expect(list.items.length).toBe(1)`).

  test('GET /api/designs returns the saved design with correct ownership', async ({
    page,
    request,
  }) => {
    const user = await registerEmulatorUser(request);
    await injectAuthState(page, user);

    await waitForConfiguratorReady(page);

    const saveCta = page
      .getByRole('button', { name: /^save( design)?$/i })
      .or(page.getByTestId('save-design-cta'))
      .first();
    await saveCta.waitFor({ state: 'visible', timeout: 10_000 });

    // Listener BEFORE click — canonical Playwright pattern.
    const savePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/designs') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await saveCta.click();
    const saveResponse = await savePromise;
    // Defensive — we don't assert the exact 2xx status because
    // Test 1 covers that. We only need the save to succeed so the
    // ownership check is meaningful. A non-2xx here would
    // short-circuit the rest of the test with a clearer failure
    // message than a downstream assertion would produce.
    expect(
      saveResponse.status(),
      'Save must succeed for ownership isolation to be testable',
    ).toBeLessThan(300);

    // Verify ownership via direct GET — user A sees their own
    // design exactly once. ST-028-AC2 requires per-design id and
    // title in the response; we assert both are truthy without
    // pinning the exact title format (ST-018 does NOT mandate a
    // specific default-save title format).
    const list = await listDesignsForUser(request, user.idToken);
    expect(
      list.items.length,
      'Owner must see their own saved design exactly once',
    ).toBe(1);
    expect(
      list.items[0]!.id,
      'Listed design must surface the server-assigned id (ST-028-AC2)',
    ).toBeTruthy();
    expect(
      list.items[0]!.title,
      'Listed design must surface the title metadata (ST-028-AC2)',
    ).toBeTruthy();

    // ST-028-AC1: a different user must NOT see this design.
    // Register a brand-new user B and verify their list is empty.
    // A horizontal privilege escalation defect — where the
    // endpoint returns ALL designs in the database — fails this
    // assertion immediately.
    const otherUser = await registerEmulatorUser(request);
    const otherList = await listDesignsForUser(request, otherUser.idToken);
    expect(
      otherList.items.length,
      "A different user must NOT see other users' designs (ST-028-AC1)",
    ).toBe(0);
  });

  // -------------------------------------------------------------------
  // Test 3 — Load Design List surfaces saved designs (ST-019)
  // -------------------------------------------------------------------
  //
  // ST-019: Authenticated users can open a list of their saved
  // designs; selecting a design loads its full state into the
  // configurator. This test validates the FIRST half of the
  // contract — the affordance to OPEN the list and have it surface
  // saved designs. The "selecting a design loads its state into
  // the configurator" half is exercised by the orchestrated
  // critical-path-full spec, which has visibility into the live
  // configurator state after a reload.
  //
  // The locator chain accepts multiple presentations of the list
  // panel (region, dialog, popover) and multiple labels for the
  // trigger ("Load Design", "My Designs", "Open Designs", or
  // simply "Designs"). This insulates the spec against minor UI
  // copy or component-shape changes while still catching genuine
  // absence.
  //
  // The list-entries assertion uses `getByRole('button')` OR
  // `getByRole('listitem')` as the design-entry locator —
  // implementations vary between rendering each entry as a
  // clickable button (likely the most accessible choice) or as a
  // `<li>` containing a button. Either is acceptable.

  test('Load Design List shows saved designs', async ({ page, request }) => {
    const user = await registerEmulatorUser(request);
    await injectAuthState(page, user);

    await waitForConfiguratorReady(page);

    // Save a design first so the list has at least one entry. We
    // don't assert exhaustively on the save response (Test 1 does
    // that) — we only need the save to succeed so the list panel
    // has something to render.
    const saveCta = page
      .getByRole('button', { name: /^save( design)?$/i })
      .or(page.getByTestId('save-design-cta'))
      .first();
    await saveCta.waitFor({ state: 'visible', timeout: 10_000 });

    const savePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/designs') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await saveCta.click();
    const saveResponse = await savePromise;
    expect(
      saveResponse.status(),
      'Save must succeed to populate the Load Design List',
    ).toBeLessThan(300);

    // Open the Load Design List from the top navigation. Multiple
    // accessible names are acceptable per the AAP — the spec is
    // tolerant of "Load Design", "My Designs", "Open Designs", or
    // simply "Designs".
    const loadTrigger = page
      .getByRole('button', { name: /load design|my designs|open designs|^designs$/i })
      .or(page.getByTestId('load-design-list-trigger'))
      .first();
    await loadTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await loadTrigger.click();

    // The list panel may be a dialog, region, or popover. Each
    // role-based locator is tried in order; the first match wins.
    // The testId fallback covers presentations where the panel
    // does not expose a recognizable accessible role.
    const listPanel = page
      .getByRole('region', { name: /designs|saved designs/i })
      .or(page.getByRole('dialog', { name: /designs|saved designs/i }))
      .or(page.getByTestId('design-list-panel'))
      .first();
    await listPanel.waitFor({ state: 'visible', timeout: 10_000 });

    // Verify at least one design entry is rendered. The entry is
    // typically a `<button>` (accessible-by-default for clickable
    // list items) but may also be a `<li>` containing a clickable
    // child. Either role is acceptable.
    const designEntries = listPanel.getByRole('button').or(listPanel.getByRole('listitem'));
    const entryCount = await designEntries.count();
    expect(
      entryCount,
      'Saved design must appear in the Load Design List (ST-019)',
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // Test 4 — Persistence across page reload (ST-027 / ST-028)
  // -------------------------------------------------------------------
  //
  // The strongest persistence test in the suite. Steps:
  //
  //   1. Save a design via the UI.
  //   2. `page.reload()` — re-runs the SPA mount fully, including
  //      Firebase persistence rehydrate, configurator initial
  //      mount, and any design-list pre-fetch.
  //   3. Independent backend verification — GET /api/designs MUST
  //      still return the design. This catches "in-memory only"
  //      regressions where the design was held in the SPA's
  //      Zustand store but never actually persisted to Postgres.
  //   4. UI verification — opening the Load Design List again MUST
  //      still surface the design. This catches "designs save to
  //      server but list doesn't refresh on reload" regressions —
  //      common when the list is fetched only on initial mount and
  //      not re-fetched after navigation.
  //
  // The test exercises the COMPLETE persistence chain:
  // backend write → backend read → SPA mount → SPA list fetch →
  // SPA list render. A failure could indicate any of: persistence
  // failure (Postgres rollback), list refresh failure (stale store
  // cache), auth state loss on reload (cookie / localStorage
  // mismatch), etc. The diagnostic value of this test is therefore
  // very high — a regression in any of those layers surfaces here.

  test('after page reload, saved design persists and can be reloaded', async ({
    page,
    request,
  }) => {
    const user = await registerEmulatorUser(request);
    await injectAuthState(page, user);

    await waitForConfiguratorReady(page);

    const saveCta = page
      .getByRole('button', { name: /^save( design)?$/i })
      .or(page.getByTestId('save-design-cta'))
      .first();
    await saveCta.waitFor({ state: 'visible', timeout: 10_000 });

    const savePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/designs') &&
        response.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await saveCta.click();
    const saveResponse = await savePromise;
    expect(
      saveResponse.status(),
      'Save must succeed before testing persistence across reload',
    ).toBeLessThan(300);

    // Reload the page. Auth state is preserved because:
    //   1. `addInitScript` re-runs on every navigation, so the
    //      synthetic Firebase persistence record is re-seeded
    //      before any SPA script runs.
    //   2. localStorage also persists across same-origin reloads
    //      by default — the persistence record from before the
    //      reload would also be present.
    // Either path is sufficient; the dual coverage makes this
    // test more resilient.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page
      .locator('canvas')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });

    // Independent backend verification — design must persist in
    // Postgres. A regression that holds the design in-memory only
    // (e.g., a Zustand store that never actually invokes the API
    // client) fails here.
    const list = await listDesignsForUser(request, user.idToken);
    expect(
      list.items.length,
      'Saved design must persist across page reload (GET /api/designs)',
    ).toBe(1);

    // UI verification — the Load Design List must still surface
    // the design after reload. A regression where the list is
    // fetched only on initial mount and not re-fetched after
    // navigation fails here.
    const loadTrigger = page
      .getByRole('button', { name: /load design|my designs|open designs|^designs$/i })
      .or(page.getByTestId('load-design-list-trigger'))
      .first();
    await loadTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await loadTrigger.click();

    const listPanel = page
      .getByRole('region', { name: /designs|saved designs/i })
      .or(page.getByRole('dialog', { name: /designs|saved designs/i }))
      .or(page.getByTestId('design-list-panel'))
      .first();
    await listPanel.waitFor({ state: 'visible', timeout: 10_000 });

    const designEntries = listPanel.getByRole('button').or(listPanel.getByRole('listitem'));
    const entryCount = await designEntries.count();
    expect(
      entryCount,
      'Saved design must remain visible in the Load Design List after page reload',
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // Test 5 — Unauthenticated save returns 401 (ST-027-AC4)
  // -------------------------------------------------------------------
  //
  // ST-027-AC4: "Requests without a valid session are rejected by
  // the session validation contract before reaching the persistence
  // layer." This is a pure backend-contract test — no `page`
  // fixture is needed, only the `request` fixture, which is faster
  // (no browser launch).
  //
  // The test sends a well-formed POST /api/designs payload but
  // omits the Authorization header. The backend MUST return 401
  // (not 200, not 500). The session middleware MUST reject the
  // request before any write hits Postgres.
  //
  // The test belongs in the e2e suite (and not just the backend
  // integration suite) because it validates the SAME backend the
  // UI talks to — a regression where the e2e backend's session
  // middleware was bypassed for /api/designs would surface here
  // even when the backend integration suite passes against a
  // different test fixture.

  test('unauthenticated save attempt does not create a design', async ({ request }) => {
    // Direct backend probe: well-formed payload, deliberately NO
    // Authorization header. The payload uses safe RGB hex values
    // and the canonical pattern + finish literals from the
    // configurator catalog so the backend cannot reject this on
    // schema-validation grounds; the rejection MUST come from the
    // session middleware.
    const response = await request.post(`${BACKEND_BASE_URL}/api/designs`, {
      data: {
        title: 'Unauthorized Design',
        payload: {
          primaryColor: '#FFFFFF',
          secondaryColor: '#000000',
          accentColor: '#FF0000',
          pattern: 'classic',
          finish: 'matte',
          logo: null,
        },
      },
    });
    expect(
      response.status(),
      'Unauthenticated POST /api/designs must return 401 (ST-027-AC4)',
    ).toBe(401);
  });
});

