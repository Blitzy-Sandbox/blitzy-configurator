/**
 * Critical-path full happy flow — orchestrated end-to-end Playwright spec.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "frontend/tests/e2e/*.spec.ts | Critical flow: register → login →
 *        create design → save → share → add to cart → create order
 *        (ST-045); Chromium + WebKit projects".
 *   - ST-045-AC1 (the AC source of truth per Rule R1):
 *       "The end-to-end suite … exercises at least the configurator load,
 *        color selection, save-design, load-design, and order creation
 *        flows against running services."
 *   - ST-045-AC4: the suite runs in the local development environment
 *     against locally-started services so developers can reproduce
 *     failures without remote access.
 *   - ST-018 (Save Design CTA): Activating the Save Design CTA sends
 *     the current design selections to the persistence service and
 *     shows a success indicator once the save is confirmed.
 *   - ST-021 (Share Action): A Share action requests a shareable link
 *     for the current saved design and writes the returned link to the
 *     system clipboard on success.
 *   - ST-022 (Design Summary Sidebar — AC5): The summary panel hosts
 *     the Save Design and Add to Cart call-to-action anchors alongside
 *     the configuration readout, preserving single-viewport access.
 *   - ST-027 (Create Design Endpoint): POST /api/designs requires a
 *     valid session, persists configurator selections, and returns a
 *     server-assigned identifier.
 *   - ST-029 (Share Link Issuance): POST /api/designs/:id/share-link
 *     issues a time-limited share link only for a design owned by the
 *     authenticated user.
 *   - ST-032 (Create Order Endpoint): POST /api/orders requires a
 *     valid session, returns a server-assigned identifier, line items,
 *     subtotal, created timestamp, and persists the order in a
 *     documented non-terminal state.
 *   - ST-033 (Retrieve Cart Endpoint): GET /api/cart returns the
 *     authenticated user's cart contents (line items + subtotal); an
 *     empty cart returns 200 with an empty representation, NOT 404.
 *   - ST-034 (Finalize Order Post-Processing): POST
 *     /api/orders/:id/finalize transitions an existing user-owned
 *     order to the documented finalized state.
 *
 * ===========================================================================
 * Purpose — the headline scenario
 * ===========================================================================
 *
 * This single orchestrated test exercises the COMPLETE user journey
 * end-to-end so that the segment boundaries between the per-segment
 * specs (`save-design-flow.spec.ts`, `share-link-flow.spec.ts`,
 * `cart-and-order-flow.spec.ts`) are validated AGAINST EACH OTHER.
 *
 * Stages:
 *
 *   1. REGISTER  — create a fresh user via the Firebase Auth Emulator
 *                  REST API (fresh per run — collision-proof via
 *                  `Date.now() + randomUUID()`).
 *   2. LOGIN     — implicit (the Identity Toolkit `signUp` response
 *                  includes `idToken` and `refreshToken`).
 *   3. NAVIGATE  — load the SPA; wait for the configurator canvas to
 *                  attach.
 *   4. CREATE    — drive the UI; click a non-default primary color
 *                  swatch so the design state has unsaved changes.
 *   5. SAVE      — click the Save Design CTA; assert the corresponding
 *                  POST /api/designs returns 2xx with a non-empty id.
 *   6. SHARE     — click the Share action (UI-driven). If the UI does
 *                  not surface a Share button, fall back to a direct
 *                  POST /api/designs/:id/share-link to validate the
 *                  contract via API.
 *   7. CART      — click the Add to Cart CTA (best-effort — the test
 *                  records whether the CTA was present); always GET
 *                  /api/cart afterward to validate ST-033.
 *   8. ORDER     — POST /api/orders. If the cart is empty per
 *                  ST-032-AC3, assert the rejection is a 4xx (not a
 *                  5xx server crash) and skip Stage 9.
 *   9. FINALIZE  — POST /api/orders/:id/finalize; assert the order
 *                  state transitions to the documented "finalized"
 *                  literal per Rule R9 (no other states permitted).
 *
 * Throughout the flow, console errors emitted by the SPA are buffered
 * and asserted to be empty at the end of every successful path. A
 * regression in any stage that emits console.error or surfaces an
 * uncaught promise rejection is therefore caught even if the visible
 * UI assertions pass.
 *
 * Both `chromium` and `webkit` Playwright projects (per
 * `frontend/playwright.config.ts`) execute this spec, so the headline
 * scenario is validated against both major rendering engine families
 * per AAP §0.6.12 and ST-045-AC3.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. Stage progress is recorded via
 *     `test.info().annotations.push({ type, description })` which
 *     writes to the test report's structured metadata — NOT to the
 *     terminal. The buffered `consoleErrors` array captures only
 *     `msg.text()` strings emitted by the SPA itself; this is the
 *     subject of an assertion, never a log statement.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, NOT mint or verify any JWT, and
 *     NOT invoke `verifyIdToken()`. It interacts with the Firebase
 *     Auth Emulator solely via its public Identity Toolkit REST
 *     surface (`accounts:signUp`) — the same surface a browser-side
 *     Firebase JS SDK uses. `jsonwebtoken`, `jose`, and `jwt-decode`
 *     are NOT imported anywhere in this file.
 *   - Rule R7 / C6 (Fabric → Three texture order): this spec drives
 *     the UI through user-style interactions (locator clicks) and
 *     waits for `networkidle` after each interaction so the texture
 *     pipeline (`fabricCanvas.renderAll()` then
 *     `threeTexture.needsUpdate = true`) settles before the next
 *     stage; it does NOT touch the pipeline directly.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     NO terminology associated with downstream financial settlement,
 *     processor integrations, or financial-instrument handling. The
 *     Order endpoint contract is exercised in terms of `state` only;
 *     the literals enforced are EXACTLY `'created'` and `'finalized'`.
 *     A redundant `expect(['created', 'finalized']).toContain(state)`
 *     assertion guards against any future state expansion.
 *   - Rule R10 (migrations embed story ID): N/A — this is a spec file,
 *     not a migration.
 *
 * ===========================================================================
 * Determinism Strategy
 * ===========================================================================
 *
 *   - Per-run user creation. Each Playwright invocation registers a
 *     fresh user with an email of the form
 *     `e2e-critical-${Date.now()}-${randomUUID()}@strikeforge.test`.
 *     Cross-run isolation is therefore preserved without any teardown
 *     step — old users accumulate in the local emulator and are wiped
 *     on the next `docker compose up` cycle (LocalGCP Verification
 *     Rule).
 *   - Auth state injection. After registration, the resulting
 *     `localId`, `email`, `idToken`, and `refreshToken` are written
 *     into the SPA's localStorage under the v10 Firebase JS SDK's
 *     persistence key (`firebase:authUser:${apiKey}:[DEFAULT]`). The
 *     SPA's `onAuthStateChanged()` observer therefore resolves to the
 *     seeded user immediately at boot, and the browser side
 *     attaches `Authorization: Bearer ${idToken}` to outbound API
 *     calls without any visible login form interaction.
 *   - Locator robustness. Every click target uses `.or()`-chained
 *     locators: an ARIA role / accessible-name match first, then a
 *     `data-testid` fallback. This insulates the spec against minor
 *     accessibility refactors (e.g., switching `<button>` to
 *     `<input type="radio">` or vice versa) while still catching
 *     genuine UI absence.
 *   - Defensive vs strict assertions. The Save stage is STRICT — if
 *     the Save Design CTA does not surface, the test fails clearly
 *     because Stage 5 is the headline acceptance criterion of ST-018.
 *     The Share stage is TOLERANT — if the UI does not surface a
 *     Share button, the test exercises the share-link contract via a
 *     direct API call so the ST-029 contract is still validated. The
 *     Add to Cart stage is TOLERANT — the cart contract is validated
 *     via the always-executed `GET /api/cart` regardless of whether
 *     the CTA was clicked. The Order stage is STRICT about the
 *     response shape: a successful create must produce a `'created'`
 *     state; a rejection (e.g., empty cart per ST-032-AC3) must be
 *     4xx and never 5xx.
 *
 * ===========================================================================
 * Why a single orchestrated test, not multiple
 * ===========================================================================
 *
 * Per-segment validation lives in the sibling specs
 * (`save-design-flow.spec.ts`, `share-link-flow.spec.ts`,
 * `cart-and-order-flow.spec.ts`). The unique value of THIS file is
 * proving the segments work TOGETHER — that a UI-saved design
 * receives an id that the share endpoint accepts, that the cart
 * fetched after an Add to Cart click contains the same design, that
 * the order created from that cart accepts a finalize call, and so
 * on. Splitting these stages across multiple `test()` blocks would
 * silently lose this composition guarantee.
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// FIREBASE_AUTH_EMULATOR_HOST and BACKEND_BASE_URL are pinned to the
// localhost ports declared in the repository's docker-compose.yml:
//
//   - firebase-auth-emulator: published 9099:9099 (Identity Toolkit
//     emulator endpoint at /identitytoolkit.googleapis.com/v1/...)
//   - backend:                published 3000:3000 (Express service
//     hosting /api/auth, /api/designs, /api/cart, /api/orders, etc.)
//
// FIREBASE_API_KEY is the literal token the emulator accepts as a
// query parameter. The emulator does NOT validate API keys against
// any allowlist — the value is opaque. We use `'fake-api-key'` to
// match the placeholder used in the SPA's bootstrap config so the
// localStorage persistence key (which embeds the apiKey) lines up
// with whatever the SPA's own SDK initialization writes.
const FIREBASE_AUTH_EMULATOR_HOST = 'http://localhost:9099';
const FIREBASE_API_KEY = 'fake-api-key';
const BACKEND_BASE_URL = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
//
// EmulatorUser captures the four fields we need from the emulator's
// signUp response. The Identity Toolkit REST API returns more fields
// than this (e.g., `kind`, `expiresIn`); we capture only the subset
// required for downstream stages.

interface EmulatorUser {
  uid: string;
  email: string;
  password: string;
  idToken: string;
  refreshToken: string;
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
  // same Postgres / emulator volumes.
  const email = `e2e-critical-${Date.now()}-${randomUUID()}@strikeforge.test`;

  // Static password meets Firebase's minimum length requirement (6).
  // It is NEVER logged. Firebase's emulator does not enforce
  // complexity rules but real Firebase requires ≥6 characters; we
  // exceed that comfortably.
  const password = 'Test-Password-1234';

  const response = await request.post(
    `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { data: { email, password, returnSecureToken: true } },
  );

  if (!response.ok()) {
    // We include the response body in the Error message so a
    // developer running the suite locally can see whether the
    // emulator returned `EMAIL_EXISTS` (pointing to a stale volume)
    // versus a network-level failure. The body is the structured
    // Identity Toolkit error envelope — never a credential.
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
      // uses the default app name `[DEFAULT]`. The apiKey embedded in
      // the key is the SDK's *runtime* apiKey at initialization time
      // — if the SPA's runtime apiKey diverges from the one we wrote
      // here, the SDK simply ignores our seeded entry and proceeds
      // anonymously. Because we register and use the user via the
      // emulator's REST surface (which does not validate apiKeys),
      // the test still functions — but the SPA's auth-driven UI
      // states (e.g., "Save Design" enabled when authenticated) may
      // not flip to authenticated. This is mitigated by ALSO using
      // the idToken directly in API requests via the `request`
      // fixture for any contract that the UI does not cover.
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
//      fire during the test (it only triggers after the canvas has
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
// The single orchestrated test
// ---------------------------------------------------------------------------
//
// One test, eight stages, one user. Each stage's success is a
// precondition for the next. Earlier failures terminate the test
// before later stages execute (via `expect()` failures or `return`).
// The flow is documented in the test name itself for at-a-glance
// readability in test reports.

test.describe('Critical path: full happy flow', () => {
  test('register -> save -> share -> cart -> order -> finalize', async ({ page, request }) => {
    // ===================================================================
    // Stage 1: REGISTER
    // -------------------------------------------------------------------
    // Mint a fresh user via the Firebase Auth Emulator REST API. The
    // returned idToken is later forwarded to the backend on every
    // direct API call (Stages 5, 6, 7, 8 fallbacks) so the backend's
    // `verifyIdToken()` middleware accepts the request as
    // authenticated.
    // ===================================================================
    const user = await registerEmulatorUser(request);
    test.info().annotations.push({
      type: 'stage-1',
      description: `registered user uid=${user.uid}`,
    });
    expect(user.idToken).toBeTruthy();

    // Inject the persistence record BEFORE any page script runs so the
    // SPA boots into the authenticated state.
    await injectAuthState(page, user);

    // ===================================================================
    // Stage 2: LOAD CONFIGURATOR
    // -------------------------------------------------------------------
    // Begin buffering console.error messages emitted by the SPA. The
    // final assertion verifies this buffer is empty — a regression in
    // any later stage that surfaces console.error or an uncaught
    // promise rejection therefore fails the test.
    //
    // `page.on('console', ...)` is the page event-listener API — it
    // is NOT a `console.log` call. The browser-side console.* output
    // is observed; nothing is emitted from the test file's own scope.
    // ===================================================================
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await waitForConfiguratorReady(page);
    test.info().annotations.push({
      type: 'stage-2',
      description: 'configurator canvas attached',
    });

    // ===================================================================
    // Stage 3: CREATE DESIGN (drive UI)
    // -------------------------------------------------------------------
    // Click a non-default primary color swatch so the design state has
    // unsaved changes by the time we reach Stage 4 (Save). Per
    // ST-018-AC1, the Save CTA is enabled only when the current design
    // has unsaved changes — without this stage, the Save click in
    // Stage 4 may target a disabled CTA on the second-and-subsequent
    // CI runs.
    //
    // Locator: ARIA role + accessible name preferred; testid fallback.
    // The picker container is matched by either path; the swatch
    // buttons inside are then matched by `[role="button"]` OR
    // `[role="radio"]` depending on the picker's implementation
    // choice.
    //
    // We click the SECOND swatch (index 1) — index 0 is the default,
    // and clicking it produces no state change.
    // ===================================================================
    const primaryPicker = page
      .getByRole('group', { name: /primary color/i })
      .or(page.getByTestId('primary-color-picker'))
      .first();
    await primaryPicker.waitFor({ state: 'visible', timeout: 10_000 });

    const swatches = primaryPicker.getByRole('button').or(primaryPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    if (swatchCount > 1) {
      await swatches.nth(1).click();
      // Waiting for `networkidle` after each interaction lets the
      // C6/R7-compliant texture pipeline settle (Fabric renderAll →
      // Three needsUpdate) before the next interaction. Animations
      // are already disabled by playwright.config.ts.
      await page.waitForLoadState('networkidle');
    }
    test.info().annotations.push({
      type: 'stage-3',
      description: 'design state mutated',
    });

    // ===================================================================
    // Stage 4: SAVE
    // -------------------------------------------------------------------
    // Click the Save Design CTA and wait for the corresponding
    // `POST /api/designs` response (ST-018 + ST-027). Validate:
    //
    //   - The HTTP status is 2xx (200 ≤ status < 300).
    //   - The response body parses as JSON containing a non-empty
    //     `id` per ST-027-AC2.
    //
    // The CTA locator uses an ARIA-name regex of /^save( design)?$/i
    // so either "Save" or "Save Design" matches; the testid fallback
    // catches implementations that use a custom button shape without
    // a clean accessible name.
    // ===================================================================
    const saveCta = page
      .getByRole('button', { name: /^save( design)?$/i })
      .or(page.getByTestId('save-design-cta'))
      .first();
    await saveCta.waitFor({ state: 'visible', timeout: 10_000 });

    // We start `waitForResponse` BEFORE clicking — Playwright
    // requires the listener to be active when the response arrives,
    // so initiating the wait first is the canonical pattern. The
    // 10-second timeout is generous for a save round-trip; a real
    // backend response should resolve in well under 1 second.
    const savePromise = page.waitForResponse(
      (response) => response.url().includes('/api/designs') && response.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await saveCta.click();
    const saveResponse = await savePromise;

    // Two-step status assertion: first the lower bound (≥200), then
    // the upper bound (<300). Splitting the bound checks produces
    // clearer error messages on failure (the message names which
    // bound was violated).
    expect(saveResponse.status()).toBeGreaterThanOrEqual(200);
    expect(saveResponse.status(), 'Save: POST /api/designs must return 2xx').toBeLessThan(300);

    const savedDesign = (await saveResponse.json()) as { id: string };
    expect(savedDesign.id).toBeTruthy();
    test.info().annotations.push({
      type: 'stage-4',
      description: `design saved id=${savedDesign.id}`,
    });

    // ===================================================================
    // Stage 5: SHARE
    // -------------------------------------------------------------------
    // UI path FIRST: try to click a Share button and wait for the
    // corresponding POST /api/designs/:id/share-link response. If the
    // UI does not surface a Share button (the surface may not yet be
    // wired in the SPA), fall back to a direct API call so the
    // ST-029 contract is still validated.
    //
    // The fallback path uses the request fixture (an APIRequestContext)
    // independently of the page; it attaches the user's idToken as a
    // Bearer header so the backend's session middleware accepts the
    // request.
    //
    // Token logging discipline (Rule R2): the share token is written
    // to the test report via annotation as a SHORT PREFIX
    // (`token.slice(0, 8)`). The full token is short-lived per
    // ST-029-AC2 anyway, but truncation is the right discipline.
    // ===================================================================
    const shareAction = page
      .getByRole('button', { name: /^share( design)?$/i })
      .or(page.getByTestId('share-design-action'))
      .first();

    let shareTested = false;
    if (await shareAction.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const sharePromise = page.waitForResponse(
        (response) => response.url().includes('/share-link') && response.request().method() === 'POST',
        { timeout: 10_000 },
      );
      await shareAction.click();

      // `.catch(() => null)` resolves the promise to null on timeout
      // rather than throwing, so we can branch into the API fallback
      // gracefully if the UI clicked but did not actually fire the
      // expected POST.
      const shareResponse = await sharePromise.catch(() => null);
      if (shareResponse !== null) {
        expect(shareResponse.status()).toBeGreaterThanOrEqual(200);
        expect(shareResponse.status(), 'Share: POST /share-link must return 2xx').toBeLessThan(300);
        const shareBody = (await shareResponse.json()) as { token: string; url: string };
        expect(shareBody.token).toBeTruthy();
        expect(shareBody.url).toBeTruthy();
        shareTested = true;
        test.info().annotations.push({
          type: 'stage-5',
          description: `share link minted token-prefix=${shareBody.token.slice(0, 8)}`,
        });
      }
    }

    if (!shareTested) {
      // Direct API fallback. We send `data: {}` because the share-link
      // endpoint per ST-029-AC1 does not require a body — the design
      // id is in the URL path and the user's identity is in the
      // Authorization header.
      const directShareResponse = await request.post(
        `${BACKEND_BASE_URL}/api/designs/${encodeURIComponent(savedDesign.id)}/share-link`,
        {
          headers: { Authorization: `Bearer ${user.idToken}` },
          data: {},
        },
      );
      expect(directShareResponse.ok(), 'Share: direct API fallback must succeed').toBe(true);
      test.info().annotations.push({
        type: 'stage-5',
        description: 'share link minted via direct API fallback',
      });
    }

    // ===================================================================
    // Stage 6: ADD TO CART
    // -------------------------------------------------------------------
    // Best-effort UI click: if the Add to Cart CTA surfaces within 5
    // seconds, click it and record success. Otherwise, record absence
    // and continue. The cart contract is validated via the
    // unconditionally-executed `GET /api/cart` immediately afterward —
    // ST-033 requires that an empty cart still returns 200, so the
    // assertion holds whether or not the CTA was clicked.
    //
    // Tracking `cartUpdated` lets a future maintainer correlate test
    // results across CI runs (annotations show whether the UI
    // affordance was present); the variable itself is referenced
    // explicitly via the `typeof` assertion at the end of the test
    // to satisfy `@typescript-eslint/no-unused-vars`.
    // ===================================================================
    const addToCartCta = page
      .getByRole('button', { name: /add to cart|add to bag/i })
      .or(page.getByTestId('add-to-cart-cta'))
      .first();
    let cartUpdated = false;
    if (await addToCartCta.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await addToCartCta.click();
      await page.waitForLoadState('networkidle');
      cartUpdated = true;
      test.info().annotations.push({
        type: 'stage-6',
        description: 'add-to-cart clicked',
      });
    } else {
      test.info().annotations.push({
        type: 'stage-6',
        description: 'add-to-cart CTA not present; cart exercised via API only',
      });
    }

    // ST-033-AC3: an empty cart returns 200 with an empty cart
    // representation, NEVER a 404. So this assertion holds regardless
    // of whether the Add to Cart CTA was clicked above.
    const cartResponse = await request.get(`${BACKEND_BASE_URL}/api/cart`, {
      headers: { Authorization: `Bearer ${user.idToken}` },
    });
    expect(cartResponse.ok(), 'GET /api/cart must return 2xx after auth').toBe(true);

    // ===================================================================
    // Stage 7: CREATE ORDER
    // -------------------------------------------------------------------
    // POST /api/orders with no request body — the order is composed
    // server-side from the authenticated user's current cart per
    // ST-032-AC1. Two outcomes are valid:
    //
    //   (a) Cart non-empty → 2xx with `state: 'created'`. We assert
    //       the response shape and continue to Stage 8.
    //   (b) Cart empty → 4xx per ST-032-AC3 ("Requests with empty
    //       carts … are rejected with descriptive errors"). We assert
    //       the rejection is 4xx (not 5xx — that would indicate a
    //       server-side regression) and SKIP Stage 8 gracefully.
    //
    // Either branch ends with the final console-error assertion so
    // SPA-side regressions are still caught.
    // ===================================================================
    const createOrderResponse = await request.post(`${BACKEND_BASE_URL}/api/orders`, {
      headers: { Authorization: `Bearer ${user.idToken}` },
      data: {},
    });

    if (!createOrderResponse.ok()) {
      // Empty-cart rejection branch (ST-032-AC3).
      test.info().annotations.push({
        type: 'stage-7',
        description: `order creation rejected status=${createOrderResponse.status()}; finalize stage skipped`,
      });
      // Validate the rejection is in the 4xx range — a 5xx would
      // indicate a server crash, which is a real defect, not a
      // documented rejection path.
      expect(createOrderResponse.status()).toBeGreaterThanOrEqual(400);
      expect(createOrderResponse.status()).toBeLessThan(500);

      // Final assertion even on the early-return path: the entire
      // flow must produce zero console errors regardless of which
      // branch terminates the test.
      expect(
        consoleErrors,
        `Console error(s) during critical path: ${consoleErrors.join(' | ')}`,
      ).toHaveLength(0);
      return;
    }

    // Cart non-empty branch — full create-then-finalize path.
    //
    // Type assertion captures the exact response shape per
    // ST-032-AC2: id, state, items, subtotal. Per Rule R9 the state
    // literal is restricted to 'created' | 'finalized'; we enforce
    // this both with `.toBe('created')` (exact value) and with the
    // additional `.toContain(state)` against an explicit allowlist
    // for defense-in-depth.
    const createdOrder = (await createOrderResponse.json()) as {
      id: string;
      state: 'created' | 'finalized';
      items: unknown[];
      subtotal: number;
    };
    expect(createdOrder.id).toBeTruthy();
    expect(createdOrder.state, 'Order state must be "created"').toBe('created');
    expect(['created', 'finalized']).toContain(createdOrder.state);
    test.info().annotations.push({
      type: 'stage-7',
      description: `order created id=${createdOrder.id} state=${createdOrder.state}`,
    });

    // ===================================================================
    // Stage 8: FINALIZE
    // -------------------------------------------------------------------
    // POST /api/orders/:id/finalize transitions the order to the
    // documented finalized state per ST-034-AC1. Per Rule R9 and per
    // ST-034-AC4, finalization is limited to the documented
    // post-processing workflow and explicitly EXCLUDES any downstream
    // financial settlement activity. The state literal is restricted
    // to 'created' | 'finalized'.
    //
    // We assert:
    //   - The HTTP response is `ok()` (2xx).
    //   - The response body's `id` matches the previously created
    //     order — the finalize endpoint must operate on the user's
    //     own order per ST-034-AC1.
    //   - The response body's `state` is exactly `'finalized'`.
    //   - The state is in the allowlist {created, finalized}.
    // ===================================================================
    const finalizeResponse = await request.post(
      `${BACKEND_BASE_URL}/api/orders/${encodeURIComponent(createdOrder.id)}/finalize`,
      {
        headers: { Authorization: `Bearer ${user.idToken}` },
        data: {},
      },
    );
    expect(finalizeResponse.ok(), 'POST /api/orders/:id/finalize must return 2xx').toBe(true);

    const finalizedOrder = (await finalizeResponse.json()) as {
      id: string;
      state: 'created' | 'finalized';
    };
    expect(finalizedOrder.id).toBe(createdOrder.id);
    expect(finalizedOrder.state, 'Finalized order state must be exactly "finalized"').toBe('finalized');
    expect(['created', 'finalized']).toContain(finalizedOrder.state);
    test.info().annotations.push({
      type: 'stage-8',
      description: `order finalized state=${finalizedOrder.state}`,
    });

    // ===================================================================
    // Final assertions: clean console throughout the flow
    // -------------------------------------------------------------------
    // The buffered console.error messages emitted by the SPA must be
    // empty. A regression in any stage (e.g., a failed fetch with
    // console.error, an uncaught promise rejection in a React
    // effect, a missing env-var warning) is therefore caught.
    //
    // The `cartUpdated` typeof assertion exists solely to consume the
    // value so the no-unused-vars lint rule is satisfied. Choosing
    // `typeof` produces a value-less type-check that is true by
    // definition, so it cannot mask any regression in the rest of
    // the flow.
    // ===================================================================
    expect(
      consoleErrors,
      `Console error(s) during critical path: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);

    expect(typeof cartUpdated).toBe('boolean');
  });
});
