/**
 * Order confirmation visual regression — Playwright spec for ST-046-AC1
 * coverage of the "order confirmation" surface.
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
 *        cart, and ORDER CONFIRMATION at fixed viewport (ST-046);
 *        ≥4 surfaces."
 *   - ST-046-AC1 (the AC source of truth per Rule R1):
 *       "The visual regression suite … captures screenshots of at least
 *        the configurator, design list, cart, and ORDER CONFIRMATION
 *        surfaces."
 *   - ST-046-AC2: comparison against versioned baseline at fixed
 *     viewport with a documented pixel-difference threshold producing
 *     a failed verdict on delta.
 *   - ST-046-AC4: baseline updates require an explicit commit to the
 *     versioned baseline artifacts; no run silently overwrites a
 *     baseline.
 *   - ST-032 (Create Order Endpoint): POST /api/orders writes a new
 *     order in a documented non-terminal state with a server-assigned
 *     identifier, line items derived from the cart, and a calculated
 *     subtotal — explicitly EXCLUDES financial settlement.
 *   - ST-034 (Finalize Order Post-Processing):
 *     POST /api/orders/:id/finalize transitions to a finalized state
 *     and runs the documented post-processing workflow (inventory
 *     reservation, order confirmation notification, bookkeeping) —
 *     SCOPE EXPLICITLY EXCLUDES downstream financial settlement.
 *   - ST-033 (Retrieve Cart Endpoint): GET /api/cart returns the
 *     authenticated user's cart contents (line items + subtotal),
 *     used here to drive the cart → order flow before finalization.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls; the constants `FAKE_ID_TOKEN` and
 *     `'fake-refresh-token-for-tests'` are placeholder strings only
 *     and are never logged. The frontend ESLint config enforces
 *     `no-console: error` (allowing only `warn` and `error`), and the
 *     workspace lint gate runs with `--max-warnings 0`.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file
 *     does NOT import `firebase-admin`, never parses or verifies a
 *     JWT manually, and never invokes `verifyIdToken()`. It only
 *     seeds Firebase JS SDK persistence state via localStorage.
 *   - Rule R7 / C6 (Fabric → Three texture order): this file does NOT
 *     touch the texture pipeline; the only canvas it inspects is the
 *     R3F `<canvas>` element, which is masked out of every snapshot.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no terminology associated with downstream financial
 *     settlement, processor integrations, or financial-instrument
 *     handling. Order finalization in StrikeForge transitions order
 *     state and runs documented post-processing (inventory,
 *     notification, bookkeeping) — settlement is explicitly out of
 *     scope per the EP-008 scope-exclusion section.
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
 *     and the order endpoints, which require a valid session, see a
 *     non-anonymous principal. This avoids hitting any real or
 *     emulated Firebase Auth REST endpoint.
 *   - All `/api/cart`, `/api/designs**`, `/api/orders`, `/api/orders/:id`,
 *     and `/api/orders/:id/finalize` calls are mocked through a single
 *     dispatching `page.route('**\/api/**')` handler. Pattern matching
 *     is performed inside the handler against `request.url()` and
 *     `request.method()` — most-specific patterns are checked first.
 *     The single-handler design avoids any reverse-registration-order
 *     ambiguity that overlapping `page.route()` glob registrations
 *     could otherwise produce.
 *   - Firebase Auth REST URLs (`identitytoolkit.googleapis.com` and
 *     `securetoken.googleapis.com`) are intercepted with empty 200
 *     fixtures so any background SDK refresh attempt does not produce
 *     a network error and therefore does not surface in the
 *     screenshot.
 *   - Order ID, line items, subtotal, currency, and timestamps are
 *     FIXED via module-scope constants so the rendered confirmation
 *     surface is byte-deterministic across runs.
 *   - The 3D canvas, any rendered order ID display, any rendered
 *     timestamp, and any rendered confirmation reference number are
 *     masked at snapshot time to remove the only remaining sources
 *     of cross-environment visual variance (font rendering of
 *     auto-generated identifiers + clock-derived strings).
 *   - Per the Playwright config the viewport is fixed at 1280×720,
 *     `animations: 'disabled'`, `maxDiffPixelRatio: 0.01`, and
 *     `threshold: 0.2` for `expect(page).toHaveScreenshot()`.
 *
 * ===========================================================================
 * Coverage Surface
 * ===========================================================================
 *
 *   The single screenshot captured by this file is `order-confirmation.png`
 *   per AAP §0.6.12 ("≥4 surfaces" — configurator, design list, cart,
 *   ORDER CONFIRMATION). The snapshot is taken AFTER the full
 *   create-order + finalize-order chain has resolved.
 *
 *   The flow is implementation-aware:
 *     - One-step flow: a single CTA in the cart panel triggers
 *       POST /api/orders followed by POST /api/orders/:id/finalize
 *       atomically (no separate finalize affordance).
 *     - Two-step flow: the cart CTA triggers POST /api/orders, then
 *       a separate "Finalize" button on the resulting confirmation
 *       surface triggers POST /api/orders/:id/finalize.
 *   The spec handles both branches via the optional finalize-button-
 *   with-timeout pattern (3-second visibility window; if the button
 *   never appears, the auto-finalize path is in effect and the spec
 *   proceeds straight to the confirmation container locator).
 */

import { test, expect, type Page, type Route, type Request } from '@playwright/test';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------
//
// These mirror the typed shapes used by `frontend/src/api/orders.ts`
// (created at MG1-F) and `frontend/src/api/designs.ts`. Keeping them
// here as local aliases means the spec is self-contained — it does
// NOT import from `frontend/src/api/*`, so the spec can be authored
// before that source code is final and so the spec keeps compiling
// even if those modules later refactor their internal types.

/**
 * Order lifecycle states per ST-032 / ST-034.
 *
 *   - 'created'   — POST /api/orders has succeeded; the order is
 *                   persisted in a non-terminal state. The flow has
 *                   NOT yet been finalized. (ST-032-AC4)
 *   - 'finalized' — POST /api/orders/:id/finalize has succeeded; the
 *                   order has progressed through the documented
 *                   post-processing workflow (inventory reservation,
 *                   notification, bookkeeping). Per Rule R9, NO
 *                   downstream financial settlement is performed.
 *                   (ST-034-AC1, ST-034-AC2, ST-034-AC4)
 *
 * No other states are valid in this scope. The `enum`-equivalent
 * union is the safest typed representation since we never write
 * arbitrary strings into the mock fixtures.
 */
type OrderState = 'created' | 'finalized';

/**
 * One line item belonging to a persisted order. The shape mirrors the
 * `order_items` table introduced by migration ST-035: a foreign key
 * to a design, a quantity, optional per-item metadata. The optional
 * `designTitle` is a denormalized convenience the API may include so
 * the confirmation surface does not need to refetch each design.
 */
type OrderItem = {
  designId: string;
  quantity: number;
  designTitle?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Canonical persisted-order shape returned by POST /api/orders and
 * POST /api/orders/:id/finalize per ST-032-AC2 and ST-034-AC2. The
 * fields are deliberately conservative — server-assigned `id`, the
 * lifecycle `state`, the line items, the calculated `subtotal`, and
 * the timestamps. Currency is optional because the contract is
 * single-currency by default but exposes the field for future use.
 */
type Order = {
  id: string;
  state: OrderState;
  items: OrderItem[];
  subtotal: number;
  currency?: string;
  createdAt: string;
  lastModifiedAt: string;
};

/**
 * One line item in the active cart per ST-033. The cart precedes the
 * order — the user assembles their selections in the cart and then
 * creates an order from the cart contents at the end of the flow.
 */
type CartItem = {
  designId: string;
  quantity: number;
  designTitle?: string;
};

/**
 * The cart payload returned by GET /api/cart per ST-033-AC2.
 * `subtotal` is the calculated subtotal of the line items at the
 * server's current pricing (the frontend never recomputes pricing
 * locally — the server is the single source of truth). Per Rule R9,
 * the subtotal is a numeric display value only; this spec contains
 * NO payment-processing logic of any kind.
 */
type CartPayload = {
  items: CartItem[];
  subtotal: number;
  currency: string;
};

/**
 * Minimal design-summary shape required to render the design list
 * sidebar / dropdown. Mirrors the shape returned by GET /api/designs
 * (ST-028) — the spec includes this so the design list panel renders
 * in a stable state during the order flow.
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
// `npx playwright test tests/visual/order-confirmation.spec.ts --update-snapshots`
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
 * `lastModifiedAt` field in the design / cart / order fixtures. The
 * confirmation surface may render this timestamp inline (e.g.
 * "Order placed at 12:00:00 UTC on 2024-06-15"); since clock-derived
 * strings would otherwise drift between runs, the rendered
 * timestamp element is also masked at snapshot time as
 * defense-in-depth.
 */
const FIXED_TIMESTAMP = '2024-06-15T12:00:00.000Z';

/**
 * Fixed order identifier. The server assigns this in the real API
 * (ST-032-AC2: "server-assigned order identifier"); the spec mocks
 * the response with this fixed value so the rendered ID is
 * deterministic. Even so, the rendered ID display element is masked
 * because UI layers may apply formatting (uppercase, hyphenation,
 * truncation) that varies across breakpoints.
 */
const FIXED_ORDER_ID = 'order-fixture-deterministic-001';

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
// persisted user and proceeds anonymously, but the order-flow
// fixtures still respond deterministically because they do not
// inspect the bearer token.
//
// `addInitScript` ensures the localStorage write happens before any
// SPA script — Firebase JS SDK reads persistence synchronously
// during its initialization, so the seed must be present at module
// evaluation time.
async function setAuthenticatedState(
  page: Page,
  options: { uid?: string; email?: string; idToken?: string } = {},
): Promise<void> {
  const uid = options.uid ?? 'test-user-uid-order';
  const email = options.email ?? 'order-test@example.test';
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
// are ordered MOST-SPECIFIC FIRST so that, e.g., `/api/orders/:id/finalize`
// is matched before `/api/orders/:id`, which is matched before
// `/api/orders`. This avoids the registration-order ambiguity that
// multiple overlapping `page.route()` calls otherwise produce.
//
// The handler always responds with `route.fulfill(...)` — never
// `route.continue()` — because we want the spec to be fully isolated
// from any real backend availability. If a request arrives that the
// handler does not explicitly recognize, it falls through to a
// generic empty 200 response so the SPA does not surface a network
// error in the snapshot.
//
// Per Rule R2, the handler does not log any request body or header
// content. The `request` parameter is consumed only via its `url()`
// and `method()` accessors.
async function mockBackendApi(
  page: Page,
  options: {
    designs?: DesignSummary[];
    cart?: CartPayload;
    order?: Order;
  } = {},
): Promise<void> {
  // ---------------------------------------------------------------------
  // Firebase Auth REST endpoints — block both Identity Toolkit and the
  // Secure Token Service so any background SDK refresh attempt resolves
  // synthetically rather than producing a real network failure.
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
  // Base order shape used as a template for every order response. The
  // dispatch branches override `state` to either 'created' or
  // 'finalized' as appropriate per ST-032 / ST-034.
  // ---------------------------------------------------------------------
  const baseOrder: Order = options.order ?? {
    id: FIXED_ORDER_ID,
    state: 'finalized',
    items: [],
    subtotal: 0,
    currency: 'USD',
    createdAt: FIXED_TIMESTAMP,
    lastModifiedAt: FIXED_TIMESTAMP,
  };

  // ---------------------------------------------------------------------
  // Single dispatching handler for every `/api/**` request. Branches
  // are ordered most-specific first.
  // ---------------------------------------------------------------------
  await page.route('**/api/**', async (route: Route, request: Request) => {
    const url = request.url();
    const method = request.method();

    // POST /api/orders/:id/finalize — finalize the order.
    // Per ST-034-AC1 / ST-034-AC2: the order transitions to a
    // finalized state and runs the documented post-processing.
    // Per Rule R9: no payment processing happens here — the response
    // contains state, items, subtotal display data, and timestamps
    // ONLY.
    if (/\/api\/orders\/[^/]+\/finalize$/.test(url) && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...baseOrder, state: 'finalized' as OrderState }),
      });
      return;
    }

    // GET /api/orders/:id — refetch the (now finalized) order. Some
    // implementations refetch the order on the confirmation surface
    // to display the canonical post-finalize representation; this
    // branch services that lookup with the same finalized fixture.
    if (/\/api\/orders\/[^/]+$/.test(url) && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...baseOrder, state: 'finalized' as OrderState }),
      });
      return;
    }

    // POST /api/orders — create the order from cart contents per
    // ST-032. Returns the canonical persisted order with HTTP 201
    // and state 'created'.
    if (/\/api\/orders$/.test(url) && method === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...baseOrder, state: 'created' as OrderState }),
      });
      return;
    }

    // GET /api/cart — return the seeded cart fixture per ST-033.
    if (url.includes('/api/cart') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(options.cart ?? { items: [], subtotal: 0, currency: 'USD' }),
      });
      return;
    }

    // GET /api/designs (and any `?cursor=...` variant) — return the
    // seeded design list per ST-028. The cart panel may render the
    // design list as a backdrop or context sidebar.
    if (url.includes('/api/designs') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: options.designs ?? [], nextCursor: null }),
      });
      return;
    }

    // Fallback — every other `/api/**` request resolves to an empty
    // 200 so the SPA does not surface a network error in the
    // snapshot. This includes future endpoints we have not yet
    // characterised; the empty body is conservative.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite — Order confirmation visual regression
// ---------------------------------------------------------------------------
//
// One test, one screenshot baseline. The test drives the full flow
// (open cart → create order → finalize) and asserts against the
// `order-confirmation.png` baseline at the fixed viewport, masking
// the dynamic regions described above.
//
// Both `chromium` and `webkit` projects (per playwright.config.ts)
// run this spec, so the baseline is captured per-project. Playwright
// stores per-project baselines under
// `frontend/visual-baselines/order-confirmation.spec.ts/<project>/order-confirmation.png`
// automatically — no per-project filename munging is required in this
// file.

test.describe('Order confirmation visual regression', () => {
  test('finalized order confirmation', async ({ page }) => {
    // -----------------------------------------------------------------
    // 1) Seed authenticated session BEFORE navigation.
    // -----------------------------------------------------------------
    //
    // `addInitScript` runs in every new document, so localStorage is
    // populated before any SPA script reads `firebase.auth()`.
    await setAuthenticatedState(page);

    // -----------------------------------------------------------------
    // 2) Build the deterministic fixtures.
    // -----------------------------------------------------------------
    //
    // The order's `items` mirror the cart's `items` so the
    // confirmation surface, which typically displays the line items
    // that were ordered, has the same items as the cart. The
    // subtotal of `14997` represents whatever currency unit the
    // server uses (e.g. cents / minor units); the spec does not
    // interpret this value — it just renders deterministically.
    const designs: DesignSummary[] = [
      {
        id: 'design-order-001',
        title: 'Tournament Red',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
      {
        id: 'design-order-002',
        title: 'Practice Blue',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
    ];
    const cart: CartPayload = {
      items: [
        { designId: 'design-order-001', quantity: 1, designTitle: 'Tournament Red' },
        { designId: 'design-order-002', quantity: 2, designTitle: 'Practice Blue' },
      ],
      subtotal: 14997,
      currency: 'USD',
    };
    const order: Order = {
      id: FIXED_ORDER_ID,
      state: 'finalized',
      items: [
        { designId: 'design-order-001', quantity: 1, designTitle: 'Tournament Red' },
        { designId: 'design-order-002', quantity: 2, designTitle: 'Practice Blue' },
      ],
      subtotal: 14997,
      currency: 'USD',
      createdAt: FIXED_TIMESTAMP,
      lastModifiedAt: FIXED_TIMESTAMP,
    };

    // -----------------------------------------------------------------
    // 3) Install the dispatching backend mock BEFORE navigation.
    // -----------------------------------------------------------------
    //
    // Every `/api/**` request — including any prefetch on initial
    // load — is intercepted from the first navigation onward.
    await mockBackendApi(page, { designs, cart, order });

    // -----------------------------------------------------------------
    // 4) Load the SPA and wait for the canvas to attach.
    // -----------------------------------------------------------------
    //
    // We wait for `networkidle` so any first-load fetches (designs
    // list, cart, etc.) resolve through the mock before we start
    // interacting. We then wait for the R3F canvas element to attach
    // because its presence is the SPA-ready signal — every other
    // surface mounts after the configurator shell.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

    // -----------------------------------------------------------------
    // 5) Open the cart view (Step 1 of the flow).
    // -----------------------------------------------------------------
    //
    // The cart trigger may be:
    //   - A button labelled "Cart" / "View Cart" / "Open Cart" / "My Cart".
    //   - A button with `data-testid="cart-trigger"`.
    //
    // We use a defensive `.or()` chain that matches any of these and
    // click the first match. The `.first()` qualifier handles the
    // edge case where the SPA renders multiple matching candidates
    // (e.g. mobile + desktop variants both in the DOM).
    const cartTrigger = page
      .getByRole('button', { name: /^cart$|view cart|open cart|my cart/i })
      .or(page.getByTestId('cart-trigger'));
    await cartTrigger.first().click();

    // The cart container itself may be a `<section role="region">`,
    // a `<dialog role="dialog">`, or a generic `<div>` with
    // `data-testid="cart-panel"`. We wait for whichever is visible.
    const cartContainer = page
      .getByRole('region', { name: /^cart$|shopping cart/i })
      .or(page.getByRole('dialog', { name: /^cart$|shopping cart/i }))
      .or(page.getByTestId('cart-panel'));
    await cartContainer.first().waitFor({ state: 'visible', timeout: 5_000 });

    // -----------------------------------------------------------------
    // 6) Trigger order creation (Step 2 of the flow).
    // -----------------------------------------------------------------
    //
    // Per Rule R9, the CTA must use ORDER terminology — "Create
    // Order", "Place Order", "Submit Order" — never the
    // payment-processing terminology that other commerce platforms
    // sometimes use. We scope the locator to `cartContainer.first()`
    // so we click the cart's CTA and not some unrelated button
    // elsewhere on the page.
    const createOrderBtn = cartContainer
      .first()
      .getByRole('button', { name: /create order|place order|submit order/i })
      .or(cartContainer.first().getByTestId('create-order-button'));
    await createOrderBtn.first().click();

    // -----------------------------------------------------------------
    // 7) Trigger finalization if the implementation requires a
    // separate "Finalize" button (Step 3 of the flow).
    // -----------------------------------------------------------------
    //
    // The flow may be:
    //   - One-step: "Place Order" automatically chains POST
    //     /api/orders + POST /api/orders/:id/finalize. No separate
    //     finalize affordance is shown.
    //   - Two-step: "Create Order" creates the order; a separate
    //     "Finalize" button completes the post-processing.
    //
    // We try the finalize button with a SHORT timeout (3 seconds).
    // If the button is visible within that window, we click it. If
    // the locator times out we fall through silently — the
    // auto-finalize path is in effect and the confirmation surface
    // will appear without any further interaction.
    //
    // The `try/catch` is the cleanest expression of "click if
    // visible, otherwise do nothing"; we catch the timeout error
    // explicitly without rethrowing because the absence of the
    // button is a valid implementation choice, not a test failure.
    const finalizeBtn = page
      .getByRole('button', { name: /finalize|confirm order/i })
      .or(page.getByTestId('finalize-order-button'));
    try {
      await finalizeBtn.first().waitFor({ state: 'visible', timeout: 3_000 });
      await finalizeBtn.first().click();
    } catch {
      // Auto-finalize path — no explicit finalize button in this
      // implementation. Proceed to the confirmation surface.
    }

    // -----------------------------------------------------------------
    // 8) Wait for the order confirmation surface to render.
    // -----------------------------------------------------------------
    //
    // The confirmation container could be:
    //   - A `<section role="region" aria-label="Order Confirmation">`.
    //   - A `<dialog role="dialog" aria-label="Order Complete">`.
    //   - A `<div data-testid="order-confirmation-panel">` that
    //     replaces the cart panel content.
    //
    // The accessible-name regex tolerates "Order Confirmation",
    // "Order Complete", "Order Received", "Order Finalized".
    const confirmationContainer = page
      .getByRole('region', { name: /order (confirmation|complete|received|finalized)/i })
      .or(page.getByRole('dialog', { name: /order (confirmation|complete|received|finalized)/i }))
      .or(page.getByTestId('order-confirmation-panel'));
    await confirmationContainer.first().waitFor({ state: 'visible', timeout: 10_000 });

    // Allow any post-finalize fetch (e.g. refetching the order via
    // GET /api/orders/:id) and any CSS animations to settle. The
    // playwright config sets `animations: 'disabled'` for screenshot
    // capture, but waiting for `networkidle` is the simplest way to
    // confirm there are no in-flight fetches that could mutate the
    // surface mid-snapshot.
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------
    // 9) Capture the visual baseline.
    // -----------------------------------------------------------------
    //
    // The masked regions cover every potential source of dynamic
    // content:
    //   - `canvas`            — the R3F WebGL canvas; its pixel
    //                           output varies with rasteriser
    //                           (SwiftShader vs. real GPU) and
    //                           must be excluded from the
    //                           comparison.
    //   - `[data-testid="order-id"]`           — the rendered order ID.
    //   - `[data-testid="order-timestamp"]`    — any timestamp
    //                                            display element.
    //   - `[data-testid="order-confirmation-id"]` — alternate ID
    //                                            display selector.
    //   - `time`              — semantic `<time>` elements that
    //                           render relative dates ("a moment
    //                           ago", "X minutes ago"); masking is
    //                           defense-in-depth in case the UI
    //                           formats the timestamp as a relative
    //                           string.
    //
    // `fullPage: false` — capture only the viewport so the snapshot
    // is exactly 1280×720 (the playwright config viewport) and not
    // the whole scrolled page. This keeps the baseline file size
    // bounded and ensures the comparison region is the visible
    // confirmation surface, not arbitrary off-screen content.
    await expect(page).toHaveScreenshot('order-confirmation.png', {
      mask: [
        page.locator('canvas'),
        page.locator('[data-testid="order-id"]'),
        page.locator('[data-testid="order-timestamp"]'),
        page.locator('[data-testid="order-confirmation-id"]'),
        page.locator('time'),
      ],
      fullPage: false,
    });
  });
});
