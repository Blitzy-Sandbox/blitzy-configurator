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
 *     ZERO `console.*` calls. The Firebase Auth Emulator-issued
 *     `idToken` and `refreshToken` are stored only on the
 *     EmulatorUser object and used solely as opaque strings by the
 *     SDK's signIn flow — they are never logged. The Emulator user
 *     password (`'Test-Password-1234'`) is a shared throwaway used
 *     only against the local emulator and is never logged. The
 *     frontend ESLint config enforces `no-console: error` (allowing
 *     only `warn` and `error`), and the workspace lint gate runs
 *     with `--max-warnings 0`.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, never parses or verifies a JWT
 *     manually, and never invokes `verifyIdToken()`. The Emulator-
 *     issued idToken is treated opaquely; the SPA's Firebase JS SDK
 *     manages it internally after `signIn()` resolves. Token
 *     verification still occurs server-side via the live backend
 *     authentication middleware (which is not exercised here because
 *     all `/api/**` calls are mocked at the page boundary).
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
 *   - Authentication is established via the production E2E pattern:
 *     each test calls `registerEmulatorUser(request)` (which talks
 *     to the live Firebase Auth Emulator at `localhost:9099` to
 *     create a fresh user via the Identity Toolkit signUp REST
 *     endpoint) and then `signInViaTestHook(page, user)` (which
 *     drives the SPA's Firebase JS SDK through the
 *     `window.__strikeforge_test_auth__` test-only hook to invoke
 *     `signInWithEmailAndPassword()`). After `signIn()` resolves the
 *     SDK's `onAuthStateChanged` observer fires, React re-renders
 *     with `isAuthenticated = true`, and the gated UI elements (the
 *     cart trigger, the order-creation CTA, etc.) become enabled.
 *     This replaces the prior `setAuthenticatedState` localStorage-
 *     seeding helper, which silently failed under Firebase v10's
 *     `browserLocalPersistence` rehydrate validation.
 *   - All `/api/cart`, `/api/designs**`, `/api/orders`, `/api/orders/:id`,
 *     and `/api/orders/:id/finalize` calls are mocked through a single
 *     dispatching `page.route('**\/api/**')` handler. Pattern matching
 *     is performed inside the handler against `request.url()` and
 *     `request.method()` — most-specific patterns are checked first.
 *     The single-handler design avoids any reverse-registration-order
 *     ambiguity that overlapping `page.route()` glob registrations
 *     could otherwise produce.
 *   - Firebase Auth REST URLs (`identitytoolkit.googleapis.com` and
 *     `securetoken.googleapis.com`) are NOT mocked — the new auth
 *     bootstrap depends on the live Firebase Auth Emulator. Mocking
 *     these endpoints would break the real `signIn()` flow and the
 *     SDK would never settle to an authenticated principal.
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
// See `tests/visual/cart.spec.ts` for the full rationale. Briefly:
// the prior localStorage-seeding helper (`setAuthenticatedState`)
// silently failed under Firebase v10's `browserLocalPersistence`
// rehydrate validation, leaving the Cart trigger button disabled
// because the SPA booted anonymous. The current approach uses the
// production E2E `signInViaTestHook` pattern, which talks to the live
// Firebase Auth Emulator at localhost:9099 to create a real
// authenticated SDK state.
//
// Per Rule R3 the spec does NOT import `firebase-admin`, never
// parses or verifies a JWT manually, and never invokes
// `verifyIdToken()`. The Emulator-issued idToken is treated opaquely;
// the SPA's Firebase JS SDK manages it internally after `signIn()`
// resolves. Server-side token verification still occurs in the live
// backend authentication middleware, which is not exercised here
// because all `/api/**` calls are mocked at the page boundary.
//
// Per Rule R2 the spec performs ZERO `console.*` calls. The
// Emulator-issued idToken / refreshToken are stored only on the
// EmulatorUser object and used solely as opaque strings by the SDK's
// signIn flow — they are never logged. The Emulator user password
// (`'Test-Password-1234'`) is a shared throwaway used only against
// the local emulator and is never logged.

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
  const email = `visual-order-confirmation-${Date.now()}-${randomUUID()}@strikeforge.test`;
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

// QA Final D — `FAKE_ID_TOKEN` constant removed. Auth is now driven
// by a real Firebase Auth Emulator user via `registerEmulatorUser` +
// `signInViaTestHook` (see "Visual auth bootstrap" section near the
// top of the file). The SDK manages its own idToken / refreshToken
// internally; the spec never references either directly.

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
// Helper — (REMOVED) setAuthenticatedState(page, options?)
// ---------------------------------------------------------------------------
//
// QA Final D — the previous localStorage-seeding helper has been
// removed. See the "Visual auth bootstrap" section near the top of
// the file for the replacement: `registerEmulatorUser(request)` +
// `signInViaTestHook(page, user)`.

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
  // QA Final D — Firebase Auth REST endpoints are NOT mocked. The new
  // auth bootstrap (signInViaTestHook + registerEmulatorUser) talks to
  // the live Firebase Auth Emulator at localhost:9099. Mocking the
  // identitytoolkit.googleapis.com / securetoken.googleapis.com
  // endpoints would break the real sign-in flow.
  // ---------------------------------------------------------------------

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
    },
  );
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
  test('ST-046-AC1: finalized order confirmation', async ({ page, request }) => {
    // -----------------------------------------------------------------
    // 1) Auth bootstrap — register a fresh Emulator user.
    // -----------------------------------------------------------------
    //
    // QA Final D — Issue #5 (ORDER-CONFIRMATION-VISUAL-AUTH).
    // The cart trigger and order-creation flow render `[disabled]`
    // for anonymous principals; we register a Firebase Auth Emulator
    // user here and sign in via the SPA's test-only hook AFTER the
    // canvas mounts (see step 5 below). Each test creates its OWN
    // fresh user so the test is fully isolated.
    const user = await registerEmulatorUser(request);

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
    // 5) Drive the SPA through Firebase JS SDK signIn via the
    //    test-only `window.__strikeforge_test_auth__` hook.
    // -----------------------------------------------------------------
    //
    // After `signIn()` resolves the SDK's `onAuthStateChanged`
    // observer fires, React re-renders with `isAuthenticated=true`,
    // and the cart trigger (rendered `[disabled]` for anonymous
    // principals via `title="Sign in to view your cart."`) becomes
    // enabled.
    await signInViaTestHook(page, user);
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------
    // 6) Open the cart view (Step 1 of the flow).
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

    // QA Final D — Wait for the cart contents to fully render before
    // attempting to click the create-order button. The CartPanel
    // mounts in `actionState='loading'` (rendering "Loading cart…"
    // via `data-testid="cart-loading"`) while it fetches GET
    // /api/cart, then transitions to `actionState='loaded'` which
    // is when the items list and `data-testid="create-order-button"`
    // mount. Without this wait, Playwright's locator may resolve to
    // a transient button instance that gets detached from the DOM
    // when React commits the loaded subtree, producing a
    // "element was detached from the DOM, retrying" failure.
    //
    // We positively assert the loaded state by waiting for the first
    // `cart-line-item` to be visible — this guarantees both that
    // `actionState === 'loaded'` AND that items are rendered, so the
    // create-order-button is stably mounted and ready for click.
    await cartContainer
      .first()
      .getByTestId('cart-line-item')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });

    // -----------------------------------------------------------------
    // 7) Trigger order creation (Step 2 of the flow).
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
    // 8) Trigger finalization if the implementation requires a
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
    // 9) Wait for the order confirmation surface to render.
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
    // 10) Capture the visual baseline.
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
