/**
 * Cart visual regression — Playwright spec for ST-046-AC1 coverage of the
 * "cart" surface.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 ("New Files to Create — Frontend"):
 *       "frontend/tests/visual/*.spec.ts | toHaveScreenshot() visual
 *        regression (ST-046)".
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "toHaveScreenshot() baselines for configurator, design list,
 *        CART, and order confirmation at fixed viewport (ST-046);
 *        ≥4 surfaces."
 *   - ST-046-AC1 (the AC source of truth per Rule R1):
 *       "The visual regression suite … captures screenshots of at least
 *        the configurator, design list, CART, and order confirmation
 *        surfaces."
 *   - ST-046-AC2: each captured screenshot is compared against a
 *     versioned baseline at a fixed viewport size with a documented
 *     pixel-difference threshold producing a failed verdict on delta.
 *   - ST-046-AC4: baseline updates require an explicit commit to the
 *     versioned baseline artifacts; no run silently overwrites a
 *     baseline.
 *   - ST-033 (Retrieve Cart Endpoint): GET /api/cart returns the
 *     authenticated user's cart contents — line items with quantity,
 *     referenced design id, optional per-item metadata, and a
 *     calculated subtotal. An empty cart returns 200 (NOT 404). The
 *     endpoint is side-effect-free.
 *   - ST-022 (Design Summary Sidebar — AC5): the design summary
 *     sidebar hosts the Save Design and Add to Cart call-to-action
 *     anchors; the cart trigger affordance therefore lives in the
 *     summary sidebar and / or top nav.
 *   - ST-018 (Save Design CTA): drives the "saved designs" list that
 *     is referenced by the cart's line items via designId; the
 *     designs fixture ensures the cart's line items have stable
 *     references when rendered.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. The Firebase Auth Emulator-issued
 *     `idToken` and `refreshToken` are stored only on the
 *     `EmulatorUser` object and used solely as opaque strings by the
 *     SDK's signIn flow — they are never logged. The frontend ESLint
 *     config enforces `no-console: error` (allowing only `warn` and
 *     `error`), and the workspace lint gate runs with
 *     `--max-warnings 0`.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, never parses or verifies a JWT
 *     manually, and never invokes `verifyIdToken()`. It only seeds
 *     Firebase JS SDK persistence state via localStorage so the SPA's
 *     auth observer resolves to a non-anonymous principal at boot.
 *   - Rule R7 / C6 (Fabric → Three texture order): this file does NOT
 *     touch the texture pipeline; the only canvas it inspects is the
 *     R3F `<canvas>` element, which is masked out of the snapshot.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no terminology associated with downstream financial settlement,
 *     processor integrations, or financial-instrument handling. The
 *     cart shows line items and a subtotal — it never models a
 *     settlement flow, never displays a financial-instrument
 *     selector, and never names any third-party settlement service.
 *     Order creation and finalization are exercised in
 *     `order-confirmation.spec.ts`, which itself is also free of
 *     financial-settlement terminology per Rule R9 and per the
 *     EP-008 scope-exclusion section.
 *
 * ===========================================================================
 * Determinism Strategy
 * ===========================================================================
 *
 *   - Authentication is simulated via `page.addInitScript()` writing
 *     the Firebase JS SDK's persisted localStorage key
 *     `firebase:authUser:<apiKey>:[DEFAULT]`. With a persisted
 *     authenticated user already in localStorage when the SPA boots,
 *     the auth state observer resolves immediately to the seeded user
 *     and the cart endpoint, which requires a valid session per
 *     ST-033-AC1, sees a non-anonymous principal. This avoids hitting
 *     any real or emulated Firebase Auth REST endpoint.
 *   - All `/api/cart` and `/api/designs**` calls are mocked through a
 *     single dispatching `page.route('**\/api/**')` handler. Pattern
 *     matching is performed inside the handler against
 *     `request.url()` and `request.method()` — most-specific patterns
 *     are checked first. The single-handler design avoids any
 *     reverse-registration-order ambiguity that overlapping
 *     `page.route()` glob registrations could otherwise produce, and
 *     mirrors the proven pattern from
 *     `frontend/tests/visual/order-confirmation.spec.ts`.
 *   - Firebase Auth REST URLs (`identitytoolkit.googleapis.com` and
 *     `securetoken.googleapis.com`) are intercepted with empty 200
 *     fixtures so any background SDK refresh attempt does not produce
 *     a network error and therefore does not surface in the snapshot.
 *   - Line item titles, quantities, currency, subtotal, and
 *     timestamps are FIXED via module-scope constants and the cart
 *     fixture so the rendered cart surface is byte-deterministic
 *     across runs.
 *   - The 3D canvas, any rendered timestamps, and any auto-generated
 *     cart line item identifiers are masked at snapshot time to
 *     remove any remaining sources of cross-environment visual
 *     variance (e.g., software-WebGL rasteriser differences,
 *     clock-derived strings, server-assigned identifier rendering).
 *   - Per the Playwright config the viewport is fixed at 1280×720,
 *     `animations: 'disabled'`, `maxDiffPixelRatio: 0.01`, and
 *     `threshold: 0.2` for `expect(page).toHaveScreenshot()`.
 *
 * ===========================================================================
 * Coverage Surface
 * ===========================================================================
 *
 *   The single screenshot captured by this file is `cart-with-items.png`
 *   per AAP §0.6.12 ("≥4 surfaces" — configurator, design list, CART,
 *   order confirmation). The snapshot is taken AFTER the SPA has
 *   loaded, the user has opened the cart panel, and the seeded line
 *   items have rendered.
 *
 *   The fixture seeds two line items at fixed quantities (1 and 2)
 *   with a fixed subtotal (14997 minor units) in USD. The exact values
 *   are arbitrary but deterministic — the baseline captures whatever
 *   visual representation the cart UI renders for those values.
 *
 *   Both `chromium` and `webkit` projects (per playwright.config.ts)
 *   run this spec, so the baseline is captured per-project. Playwright
 *   stores per-project baselines under
 *   `frontend/visual-baselines/cart.spec.ts/<project>/cart-with-items.png`
 *   automatically — no per-project filename munging is required here.
 */

import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
  type Request,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// QA Final D — Visual auth bootstrap
// ---------------------------------------------------------------------------
//
// Visual specs that exercise authenticated surfaces (cart, design list,
// order confirmation) MUST authenticate the SPA before navigation so
// the gated affordances (Cart trigger, Load Design List, etc.) become
// enabled and the visual snapshot is meaningful.
//
// PRIOR APPROACH (broken): localStorage seeding. The spec wrote a
// synthetic `firebase:authUser:${apiKey}:[DEFAULT]` localStorage record
// before navigation, hoping Firebase v10's persistence rehydrate path
// would adopt the seeded user. After the SPA was refactored to use
// `initializeAuth({ persistence: browserLocalPersistence })`, the
// rehydrate path validates the persisted record's full schema; any
// subtle drift between the synthetic record and Firebase's internal
// representation causes the SDK to silently boot anonymous, and the
// gated UI affordances stay disabled.
//
// CURRENT APPROACH (working): use the same `signInViaTestHook` pattern
// the production E2E suite uses. The test hook
// (`window.__strikeforge_test_auth__`) is installed by
// `frontend/src/auth/firebase-client.ts` in DEV builds only; it
// exposes `signIn(email, password)` which calls the SAME
// `signInWithEmailAndPassword` code path the production sign-in UI
// would. Combined with a fresh emulator-registered user via the
// Identity Toolkit REST API (`signUp` endpoint), this produces a real
// authenticated SDK state — `onAuthStateChanged` fires with the
// signed-in user, React re-renders with `isAuthenticated=true`, the
// Cart and Load Design buttons become enabled, and the snapshot
// captures the authenticated UI state.
//
// All `/api/**` calls remain mocked via `mockBackendApi(page, ...)` so
// the rendered surface (cart contents, design list, order details) is
// driven by the spec's fixtures rather than backend state — the
// emulator is exercised ONLY for the sign-in handshake.
//
// Per Rule R3, this code does NOT import `firebase-admin`, never
// parses or verifies a JWT, and never calls `verifyIdToken()`. The
// emulator-issued `idToken` is forwarded opaquely.
// Per Rule R2, this code never logs the password, idToken, or
// refreshToken. The error path includes the structured Identity
// Toolkit error envelope (e.g., `EMAIL_EXISTS`) which is never a
// credential.

const FIREBASE_AUTH_EMULATOR_HOST = 'http://localhost:9099';
const FIREBASE_API_KEY = 'local-emulator-key';

interface EmulatorUser {
  uid: string;
  email: string;
  password: string;
  idToken: string;
  refreshToken: string;
}

async function registerEmulatorUser(request: APIRequestContext): Promise<EmulatorUser> {
  const email = `visual-cart-${Date.now()}-${randomUUID()}@strikeforge.test`;
  const password = 'Test-Password-1234';

  const response = await request.post(
    `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { data: { email, password, returnSecureToken: true } },
  );

  if (!response.ok()) {
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

async function signInViaTestHook(page: Page, user: EmulatorUser): Promise<void> {
  await page.waitForFunction(
    () => typeof window.__strikeforge_test_auth__ !== 'undefined',
    { timeout: 10_000 },
  );

  await page.evaluate(
    async (args: { email: string; password: string }) => {
      await window.__strikeforge_test_auth__!.signIn(args.email, args.password);
    },
    { email: user.email, password: user.password },
  );

  const signedInUid = await page.evaluate(() => {
    const current = window.__strikeforge_test_auth__!.getCurrentUser();
    return current === null ? null : current.uid;
  });
  if (signedInUid !== user.uid) {
    throw new Error(
      `signInViaTestHook: expected currentUser.uid=${user.uid} after signIn but observed ${String(signedInUid)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
//
// These mirror the typed shapes that `frontend/src/api/orders.ts` and
// `frontend/src/api/designs.ts` (created at MG1-F) will expose. Keeping
// them here as local aliases means the spec is self-contained — it does
// NOT import from `frontend/src/api/*`, so the spec can be authored
// before that source code is final and so the spec keeps compiling
// even if those modules later refactor their internal types.

/**
 * One line item in the active cart per ST-033-AC2.
 *
 *   - `designId` — foreign key to the `designs` table (ST-030); the
 *     cart references designs the user has previously saved (ST-018).
 *   - `quantity` — integer count of the design ordered.
 *   - `designTitle` — optional denormalised convenience field; the API
 *     may include it so the cart UI does not need to refetch every
 *     design just to render its title.
 *   - `metadata` — optional per-item metadata bag per ST-033-AC2
 *     ("any per-item metadata required to render the cart").
 */
type CartItem = {
  designId: string;
  quantity: number;
  designTitle?: string;
  metadata?: Record<string, unknown>;
};

/**
 * The cart payload returned by GET /api/cart per ST-033-AC2 / ST-033-AC3.
 * `subtotal` is the calculated subtotal of the line items at the
 * server's current pricing; the frontend never recomputes pricing
 * locally — the server is the single source of truth.
 *
 * Per Rule R9, the subtotal is a numeric display value only. This spec
 * contains no downstream-financial-settlement logic of any kind: no
 * authorization-of-funds flow, no instrument tokenisation, no
 * settlement-instrument selection, no reversal handling. The cart
 * simply exposes "what the user has assembled" and "what it would
 * cost in aggregate".
 */
type CartPayload = {
  items: CartItem[];
  subtotal: number;
  currency: string;
};

/**
 * Minimal design-summary shape required to keep the design summary
 * sidebar (ST-022) and / or design list (ST-019) in a stable state
 * while the cart panel is open. Mirrors the shape returned by GET
 * /api/designs (ST-028).
 */
type DesignSummary = {
  id: string;
  title: string;
  createdAt: string;
  lastModifiedAt: string;
};

// ---------------------------------------------------------------------------
// Constants — fixed test fixtures
// ---------------------------------------------------------------------------
//
// Every value here must remain CONSTANT across runs to satisfy
// ST-046-AC2 (deterministic visual baselines). Changing any of these
// constants requires an explicit baseline refresh via
// `npx playwright test tests/visual/cart.spec.ts --update-snapshots`
// followed by a deliberate commit (per ST-046-AC4).

// QA Final D — `FAKE_ID_TOKEN` constant removed. Auth is now driven
// by a real Firebase Auth Emulator user via `registerEmulatorUser` +
// `signInViaTestHook` (see "Visual auth bootstrap" section near the
// top of the file). The SDK manages its own idToken / refreshToken
// internally; the spec never references either directly.

/**
 * Fixed ISO-8601 timestamp used for every `createdAt` and
 * `lastModifiedAt` field in the design / cart fixtures. The cart UI
 * may render line item timestamps inline (e.g., "Added 2024-06-15");
 * since clock-derived strings would otherwise drift between runs, the
 * rendered timestamp elements are also masked at snapshot time as
 * defense-in-depth.
 */
const FIXED_TIMESTAMP = '2024-06-15T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Helper — (REMOVED) setAuthenticatedState(page, options?)
// ---------------------------------------------------------------------------
//
// QA Final D — the previous localStorage-seeding helper has been
// removed. See the "Visual auth bootstrap" section above for the
// replacement: `registerEmulatorUser(request)` +
// `signInViaTestHook(page, user)`.

// ---------------------------------------------------------------------------
// Helper — mockBackendApi(page, options?)
// ---------------------------------------------------------------------------
//
// Single dispatching route handler. Matches `**\/api/**` and decides
// the response based on the URL path + HTTP method. The `if` branches
// are ordered MOST-SPECIFIC FIRST so that, e.g., `/api/cart` is
// matched before the generic fallback. This avoids the
// reverse-registration-order ambiguity that multiple overlapping
// `page.route()` calls otherwise produce.
//
// Playwright matches routes in the OPPOSITE order to their
// registration. Splitting `/api/cart` and `/api/designs` and
// `/api/**` across three separate `page.route()` calls would mean the
// most-recently-registered glob wins; if the broadest pattern is
// registered last, it intercepts every `/api/cart` and
// `/api/designs` request before the more specific handlers can
// dispatch. The single-handler approach used here removes that
// ambiguity entirely.
//
// The handler always responds with `route.fulfill(...)` — never
// `route.continue()` — because we want the spec to be fully isolated
// from any real backend availability. If a request arrives that the
// handler does not explicitly recognize, it falls through to a generic
// empty 200 response so the SPA does not surface a network error in
// the snapshot.
//
// Per Rule R2, the handler does not log any request body or header
// content. The `request` parameter is consumed only via its `url()`
// and `method()` accessors.
//
// Per Rule R9, the cart fixture contains line items + subtotal +
// currency ONLY. There are no settlement-instrument, billing-address,
// fund-authorization-form, or processor-credential fields in any of
// the mocked responses.
async function mockBackendApi(
  page: Page,
  options: { designs?: DesignSummary[]; cart?: CartPayload } = {},
): Promise<void> {
  // ---------------------------------------------------------------------
  // QA Final D — Firebase Auth REST endpoints are NOT mocked.
  // ---------------------------------------------------------------------
  //
  // The new auth bootstrap (signInViaTestHook + registerEmulatorUser)
  // talks to the live Firebase Auth Emulator at localhost:9099. We do
  // NOT intercept identitytoolkit.googleapis.com / securetoken.
  // googleapis.com — those calls go through to the emulator running in
  // docker-compose. Mocking them would break the real sign-in flow.
  //
  // ---------------------------------------------------------------------
  // Single dispatching handler for every `/api/**` request. Branches
  // are ordered most-specific first.
  //
  // The glob '**/api/**' matches BOTH real backend `/api/*` calls AND
  // the Vite-served frontend source files at `/src/api/*.ts` (because
  // the path segment "api" appears in both). Letting the catch-all
  // fulfill the source-file requests with a `{}` JSON body breaks the
  // browser's strict-MIME-type enforcement for ES modules and prevents
  // the React tree from mounting. Fix: filter at routing time using a
  // function predicate that requires the URL pathname to start with
  // `/api/` (no `/src/` prefix), so Vite serves frontend source files
  // normally.
  // ---------------------------------------------------------------------
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route, request: Request) => {
      const url = request.url();
      const method = request.method();

      // GET /api/cart — return the seeded cart fixture per ST-033.
      // Per ST-033-AC3, an empty cart still returns 200 with an empty
      // representation (never 404). Per ST-033-AC4 the endpoint is
      // side-effect-free, so any non-GET method is benign — we still
      // respond 200 with a generic body so the SPA does not surface a
      // network error during navigation.
      if (url.includes('/api/cart') && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            options.cart ?? { items: [], subtotal: 0, currency: 'USD' },
          ),
        });
        return;
      }

      // GET /api/designs (and any `?cursor=...` variant) — return the
      // seeded design list per ST-028. Some cart implementations refetch
      // the saved designs list to render the cart's line item titles
      // when the line item itself does not include a denormalised
      // `designTitle`. The fixture ensures both code paths render
      // deterministically.
      if (url.includes('/api/designs') && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: options.designs ?? [], nextCursor: null }),
        });
        return;
      }

      // Fallback — every other `/api/**` request (including any non-GET
      // hit on `/api/cart` or `/api/designs`, which the cart panel
      // should never trigger but a stray handler might) resolves to an
      // empty 200 so the SPA does not surface a network error in the
      // snapshot. This intentionally covers future endpoints we have
      // not yet characterised; the empty body is conservative.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Test suite — Cart visual regression
// ---------------------------------------------------------------------------
//
// One test, one screenshot baseline. The test seeds an authenticated
// session, installs the cart-and-designs mock, navigates to the SPA,
// opens the cart panel, waits for the line items to render, and
// asserts against the `cart-with-items.png` baseline at the fixed
// viewport, masking the dynamic regions described above.
//
// Both `chromium` and `webkit` projects (per playwright.config.ts)
// run this spec, so the baseline is captured per-project. Playwright
// stores per-project baselines under
// `frontend/visual-baselines/cart.spec.ts/<project>/cart-with-items.png`
// automatically — no per-project filename munging is required in this
// file.

test.describe('Cart visual regression', () => {
  test('ST-046-AC1: cart with items', async ({ page, request }) => {
    // -----------------------------------------------------------------
    // 1) Register a real user via Firebase Auth Emulator, then sign in
    //    via the test-only window hook so the SPA boots authenticated.
    // -----------------------------------------------------------------
    //
    // QA Final D — Issue #4 (CART-VISUAL-AUTH): the cart trigger button
    // is `[disabled]` when the SPA has no authenticated user, so the
    // visual snapshot of the cart panel was previously unreachable.
    // The new auth bootstrap (registerEmulatorUser + signInViaTestHook)
    // produces a real authenticated SDK state, the cart trigger
    // becomes enabled, and the snapshot can be captured.
    const user = await registerEmulatorUser(request);

    // -----------------------------------------------------------------
    // 2) Build the deterministic fixtures.
    // -----------------------------------------------------------------
    //
    // The designs fixture provides two saved designs that the cart's
    // line items reference by id. Even though the cart line items
    // include the `designTitle` denormalised field, the designs
    // fixture is included so any cart UI implementation that
    // additionally renders the saved designs list (e.g. ST-019
    // LoadDesignList in a sidebar) has stable data to display.
    const designs: DesignSummary[] = [
      {
        id: 'design-cart-001',
        title: 'Tournament Red',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
      {
        id: 'design-cart-002',
        title: 'Practice Blue',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
    ];

    // The cart fixture: two line items at FIXED quantities (1 and 2)
    // with a FIXED subtotal (14997) in USD. The exact values are
    // arbitrary but deterministic — the rendered baseline captures
    // whatever visual representation the cart UI produces for those
    // values, and only intentional UI changes will require a
    // baseline refresh.
    //
    // Per Rule R9, this fixture contains ONLY line items + subtotal +
    // currency. It does NOT contain any settlement-instrument,
    // billing-address, fund-authorization-form, or processor-
    // credential fields, and the spec never asserts the presence of
    // any such field.
    const cart: CartPayload = {
      items: [
        {
          designId: 'design-cart-001',
          quantity: 1,
          designTitle: 'Tournament Red',
        },
        {
          designId: 'design-cart-002',
          quantity: 2,
          designTitle: 'Practice Blue',
        },
      ],
      // `subtotal` is an integer in minor units (e.g., cents); display
      // formatting (e.g. "$149.97") is the cart UI's responsibility.
      // The spec provides the raw integer here and lets the UI render
      // whatever localized representation it produces.
      subtotal: 14997,
      currency: 'USD',
    };

    // -----------------------------------------------------------------
    // 3) Install the dispatching backend mock BEFORE navigation.
    // -----------------------------------------------------------------
    //
    // Every `/api/**` request — including any prefetch on initial
    // load — is intercepted from the first navigation onward.
    await mockBackendApi(page, { designs, cart });

    // -----------------------------------------------------------------
    // 4) Load the SPA, sign in via test hook, wait for canvas attach.
    // -----------------------------------------------------------------
    //
    // We wait for `networkidle` so any first-load fetches (designs
    // list, cart, etc.) resolve through the mock before we start
    // interacting. After the SPA boots, the test-only auth hook
    // attaches itself to `window.__strikeforge_test_auth__`; we then
    // call `signInViaTestHook` to produce an authenticated SDK state
    // (which propagates to React via `onAuthStateChanged`). After
    // sign-in, the gated affordances (cart trigger) become enabled
    // and the visual snapshot is meaningful.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

    await signInViaTestHook(page, user);

    // After sign-in, give the SPA a moment for React to re-render and
    // for any post-auth fetches (which the mock will intercept) to
    // settle before we start clicking cart-related UI.
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------
    // 5) Open the cart view.
    // -----------------------------------------------------------------
    //
    // Per ST-022-AC5 the design summary sidebar (right panel) hosts
    // the Save Design and Add to Cart CTAs alongside the configuration
    // readout. The cart-VIEW trigger affordance is implementation-
    // dependent: it may be a dedicated button in the top nav, a "View
    // Cart" affordance in the summary sidebar, or an icon-with-badge
    // button in a corner of the layout.
    //
    // We use a defensive `.or()` chain that matches any of these and
    // click the first match. The `.first()` qualifier handles the
    // edge case where the SPA renders multiple matching candidates
    // (e.g. mobile + desktop variants both in the DOM).
    const cartTrigger = page
      .getByRole('button', { name: /^cart$|view cart|open cart|my cart/i })
      .or(page.getByTestId('cart-trigger'));
    await cartTrigger.first().click();

    // -----------------------------------------------------------------
    // 6) Wait for the cart container to be visible.
    // -----------------------------------------------------------------
    //
    // The cart container itself may be a `<section role="region">`,
    // a `<dialog role="dialog">`, or a generic `<div>` with
    // `data-testid="cart-panel"`. We wait for whichever is visible.
    const cartContainer = page
      .getByRole('region', { name: /^cart$|shopping cart/i })
      .or(page.getByRole('dialog', { name: /^cart$|shopping cart/i }))
      .or(page.getByTestId('cart-panel'));
    await cartContainer.first().waitFor({ state: 'visible', timeout: 5_000 });

    // -----------------------------------------------------------------
    // 7) Wait for at least one line item to render.
    // -----------------------------------------------------------------
    //
    // Each line item could be a `<li role="listitem">` (the natural
    // semantic for an itemised cart) or a generic `<div>` with
    // `data-testid="cart-line-item"`. We scope the locator to
    // `cartContainer.first()` so we do not match unrelated list items
    // elsewhere on the page.
    const firstLineItem = cartContainer
      .first()
      .getByRole('listitem')
      .or(cartContainer.first().getByTestId('cart-line-item'))
      .first();
    await firstLineItem.waitFor({ state: 'visible', timeout: 5_000 });

    // Allow any subtotal-calculation animation, line-item-rendering
    // transitions, and any deferred fetches to settle before the
    // snapshot. The playwright config sets `animations: 'disabled'`
    // for screenshot capture, but waiting for `networkidle` is the
    // simplest way to confirm there are no in-flight fetches that
    // could mutate the surface mid-snapshot.
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------
    // 8) Capture the visual baseline.
    // -----------------------------------------------------------------
    //
    // The masked regions cover every potential source of dynamic
    // content:
    //   - `canvas`               — the R3F WebGL canvas; its pixel
    //                              output varies with rasteriser
    //                              (SwiftShader vs. real GPU) and
    //                              must be excluded from the
    //                              comparison.
    //   - `[data-testid="cart-line-item-timestamp"]`
    //                            — any per-line-item timestamp
    //                              display element (e.g., "Added X
    //                              minutes ago").
    //   - `[data-testid="cart-id"]`
    //                            — a server-assigned cart identifier
    //                              if the UI surfaces one (some cart
    //                              UIs render an opaque cart ref so
    //                              the user can quote it to support).
    //   - `time`                 — semantic `<time>` elements that
    //                              may render relative dates;
    //                              masking is defense-in-depth in
    //                              case the UI formats a timestamp
    //                              as a relative string.
    //
    // `fullPage: false` — capture only the viewport so the snapshot
    // is exactly 1280×720 (the playwright config viewport) and not
    // the whole scrolled page. This keeps the baseline file size
    // bounded and ensures the comparison region is the visible cart
    // surface, not arbitrary off-screen content.
    await expect(page).toHaveScreenshot('cart-with-items.png', {
      mask: [
        page.locator('canvas'),
        page.locator('[data-testid="cart-line-item-timestamp"]'),
        page.locator('[data-testid="cart-id"]'),
        page.locator('time'),
      ],
      fullPage: false,
    });
  });
});
