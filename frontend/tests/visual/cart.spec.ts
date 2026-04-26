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
 *     ZERO `console.*` calls; the constant `FAKE_ID_TOKEN` and the
 *     placeholder string `'fake-refresh-token-for-tests'` are static
 *     strings only and are never logged. The frontend ESLint config
 *     enforces `no-console: error` (allowing only `warn` and `error`),
 *     and the workspace lint gate runs with `--max-warnings 0`.
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

import { test, expect, type Page, type Route, type Request } from '@playwright/test';

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

/**
 * Placeholder ID-token string used to simulate an authenticated
 * session. This is NOT a real JWT — it is an opaque string that the
 * spec never logs. Per Rule R2, no `console.*` call ever references
 * this constant.
 */
const FAKE_ID_TOKEN = 'fake-id-token-for-tests';

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
// Helper — setAuthenticatedState(page, options?)
// ---------------------------------------------------------------------------
//
// Seeds the Firebase JS SDK's persisted localStorage key BEFORE any
// page script runs, so the SPA's onAuthStateChanged() observer
// resolves to the seeded user immediately on boot — no network round
// trip to identitytoolkit.googleapis.com, no signInWithEmailAndPassword
// dialog, no flicker from anonymous → authenticated.
//
// The shape written to localStorage matches the v10 Firebase JS SDK's
// authUser persistence schema — every required field is present so
// that Firebase's persistence-rehydrate path accepts the entry. The
// `apiKey` is `'fake-api-key'` here; if the real SPA constructs
// firebase config from `import.meta.env.VITE_FIREBASE_API_KEY` and
// that env var is absent at test time, the SDK falls back to its own
// initialized apiKey value — but the persistence key uses whatever
// apiKey the SDK was initialized with, NOT the one we wrote here.
// Because we additionally mock all `identitytoolkit.googleapis.com/**`
// and `securetoken.googleapis.com/**` calls with empty 200 fixtures,
// any divergence between the seeded apiKey and the SDK's runtime
// apiKey degrades gracefully — the SDK simply does not find a
// persisted user and proceeds anonymously, but the cart fixture still
// responds deterministically because the mock does not inspect the
// bearer token.
//
// `addInitScript` ensures the localStorage write happens before any
// SPA script — Firebase JS SDK reads persistence synchronously
// during its initialization, so the seed must be present at module
// evaluation time.
//
// Per Rule R3, this function does NOT import `firebase-admin`, does
// NOT mint a real JWT, and does NOT verify any token. It writes a
// synthetic persistence record only.
async function setAuthenticatedState(
  page: Page,
  options: { uid?: string; email?: string; idToken?: string } = {},
): Promise<void> {
  const uid = options.uid ?? 'test-user-uid-cart';
  const email = options.email ?? 'cart-test@example.test';
  const idToken = options.idToken ?? FAKE_ID_TOKEN;

  await page.addInitScript(
    (args: { uid: string; email: string; idToken: string }) => {
      const apiKey = 'fake-api-key';
      const persistKey = `firebase:authUser:${apiKey}:[DEFAULT]`;
      const now = Date.now();
      const persistedUser = {
        uid: args.uid,
        email: args.email,
        emailVerified: true,
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
          refreshToken: 'fake-refresh-token-for-tests',
          accessToken: args.idToken,
          expirationTime: now + 60 * 60 * 1000,
        },
        createdAt: String(now),
        lastLoginAt: String(now),
        apiKey,
        appName: '[DEFAULT]',
      };
      window.localStorage.setItem(persistKey, JSON.stringify(persistedUser));
    },
    { uid, email, idToken },
  );
}

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
  // Firebase Auth REST endpoints — block both Identity Toolkit and the
  // Secure Token Service so any background SDK refresh attempt resolves
  // synthetically rather than producing a real network failure. These
  // domains do NOT overlap with `**/api/**`, so registration order is
  // irrelevant for them.
  // ---------------------------------------------------------------------
  await page.route('**/identitytoolkit.googleapis.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/securetoken.googleapis.com/**', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        refresh_token: 'fake-refresh-token-for-tests',
        expires_in: '3600',
      }),
    }),
  );

  // ---------------------------------------------------------------------
  // Single dispatching handler for every `/api/**` request. Branches
  // are ordered most-specific first.
  // ---------------------------------------------------------------------
  await page.route('**/api/**', async (route: Route, request: Request) => {
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
  });
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
  test('cart with items', async ({ page }) => {
    // -----------------------------------------------------------------
    // 1) Seed authenticated session BEFORE navigation.
    // -----------------------------------------------------------------
    //
    // `addInitScript` runs in every new document, so localStorage is
    // populated before any SPA script reads `firebase.auth()`. ST-033
    // requires the cart endpoint to be guarded by a valid session;
    // without this seed the SPA would treat the user as anonymous
    // and the cart panel might not render at all.
    await setAuthenticatedState(page);

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
    // 4) Load the SPA and wait for the canvas to attach.
    // -----------------------------------------------------------------
    //
    // We wait for `networkidle` so any first-load fetches (designs
    // list, cart, etc.) resolve through the mock before we start
    // interacting. We then wait for the R3F canvas element to attach
    // because its presence is the SPA-ready signal — every other
    // surface (including the cart panel) mounts after the
    // configurator shell.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

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
