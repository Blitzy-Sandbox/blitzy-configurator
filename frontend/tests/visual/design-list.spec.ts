/**
 * Design list visual regression — Playwright spec for ST-046-AC1
 * coverage of the "design list" surface.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 ("New Files to Create — Frontend"):
 *       "frontend/tests/visual/*.spec.ts | toHaveScreenshot() visual
 *        regression (ST-046)".
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "toHaveScreenshot() baselines for configurator, DESIGN LIST,
 *        cart, and order confirmation at fixed viewport (ST-046);
 *        ≥4 surfaces."
 *   - ST-046-AC1 (the AC source of truth per Rule R1):
 *       "The visual regression suite … captures screenshots of at
 *        least the configurator, DESIGN LIST, cart, and order
 *        confirmation surfaces."
 *   - ST-046-AC2: each captured screenshot is compared against a
 *     versioned baseline at a fixed viewport size, and any delta
 *     exceeding the documented pixel-difference threshold produces a
 *     failed verdict.
 *   - ST-046-AC4: baseline updates require an explicit commit to the
 *     versioned baseline artifacts; no run silently overwrites a
 *     baseline.
 *   - ST-019 (Load Design List): the signed-in user sees a list of
 *     their saved designs with metadata (title, last-modified
 *     timestamp); selecting an entry loads it into the configurator;
 *     fetch failure leaves the previously rendered UI intact.
 *   - ST-018 (Save Design CTA): drives the saved-designs collection
 *     that ST-019 surfaces; the populated-state fixture below is what
 *     a user with three previously saved designs would see.
 *   - ST-022 (Design Summary Sidebar — AC5): the design summary
 *     sidebar hosts the Save Design and Add to Cart CTAs; when the
 *     design list view opens as a drawer / dialog the summary
 *     sidebar may remain partially visible behind it — that backdrop
 *     content is captured as part of the visual baseline.
 *   - ST-028 (Retrieve Designs By User Endpoint): GET /api/designs
 *     returns a paginated list `{ items: Design[], nextCursor: string
 *     | null }` of designs owned by the authenticated user — the
 *     contract that the frontend's `getDesigns()` consumes and that
 *     this spec mocks deterministically.
 *
 * ===========================================================================
 * Coverage Surface
 * ===========================================================================
 *
 *   This spec captures TWO baseline screenshots of the design list
 *   surface — both contributing to the ST-046-AC1 four-surfaces
 *   coverage requirement (configurator, design list, cart, order
 *   confirmation):
 *
 *     1) `design-list-empty.png`     — empty state: signed-in user
 *        with no saved designs. Validates that the empty-state copy
 *        / CTA renders correctly when `items: []` is returned.
 *     2) `design-list-populated.png` — populated state: signed-in
 *        user with three saved designs at fixed timestamps.
 *        Validates the design card layout, metadata display, and
 *        ordering.
 *
 *   Both are taken at the fixed 1280×720 viewport configured in
 *   `playwright.config.ts`. Both `chromium` and `webkit` projects run
 *   this spec, so per-project baselines are stored under
 *     frontend/visual-baselines/design-list.spec.ts/<project>/<name>.png
 *   automatically by Playwright — no per-project filename munging is
 *   required in this file.
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
 *   - Rule R7 / C6 (Fabric → Three texture order): this file does
 *     NOT touch the texture pipeline; the only canvas it inspects
 *     is the R3F `<canvas>` element, which is masked out of every
 *     snapshot.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no terminology associated with downstream financial
 *     settlement, processor integrations, or financial-instrument
 *     handling. The design list surface displays user-owned design
 *     metadata only — no settlement or financial-instrument
 *     elements appear in either the empty or populated baseline.
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
 *     LoadDesignList trigger, the Save Design CTA, etc.) become
 *     enabled. This replaces the prior `setAuthenticatedState`
 *     localStorage-seeding helper, which silently failed under
 *     Firebase v10's `browserLocalPersistence` rehydrate validation.
 *   - All `/api/designs**` and `/api/cart` calls are mocked through
 *     a single dispatching `page.route('**\/api/**')` handler.
 *     Pattern matching is performed inside the handler against
 *     `request.url()` and `request.method()` — most-specific
 *     patterns are checked first. The single-handler design avoids
 *     any reverse-registration-order ambiguity that overlapping
 *     `page.route()` glob registrations could otherwise produce, and
 *     mirrors the proven pattern from
 *     `frontend/tests/visual/cart.spec.ts` and
 *     `frontend/tests/visual/order-confirmation.spec.ts`.
 *   - Firebase Auth REST URLs (`identitytoolkit.googleapis.com` and
 *     `securetoken.googleapis.com`) are NOT mocked — the new auth
 *     bootstrap depends on the live Firebase Auth Emulator. Mocking
 *     these endpoints would break the real `signIn()` flow and the
 *     SDK would never settle to an authenticated principal.
 *   - Design titles and timestamps are FIXED via module-scope
 *     constants so the rendered design list is byte-deterministic
 *     across runs.
 *   - Even with fixed timestamps in the fixture, some implementations
 *     may render relative time strings ("2 days ago", "Just now")
 *     that drift with the test execution date. `<time>` semantic
 *     locators and any `[data-testid="design-card-timestamp"]`
 *     elements are masked at snapshot time as defense-in-depth.
 *   - The 3D canvas is masked at snapshot time because R3F's WebGL
 *     output varies with the rasteriser (SwiftShader vs. real GPU)
 *     and is not part of the design list surface under test.
 *   - Per the Playwright config the viewport is fixed at 1280×720,
 *     `animations: 'disabled'`, `maxDiffPixelRatio: 0.01`, and
 *     `threshold: 0.2` for `expect(page).toHaveScreenshot()`.
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
// See cart.spec.ts for the full rationale. Briefly: the prior
// localStorage-seeding helper (`setAuthenticatedState`) silently
// failed under Firebase v10's `browserLocalPersistence` rehydrate
// validation, leaving the Load Design List trigger button disabled
// because the SPA booted anonymous. The current approach uses the
// production E2E `signInViaTestHook` pattern, which talks to the live
// Firebase Auth Emulator at localhost:9099 to create a real
// authenticated SDK state.

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
  const email = `visual-design-list-${Date.now()}-${randomUUID()}@strikeforge.test`;
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
// These mirror the typed shapes that `frontend/src/api/designs.ts` and
// `frontend/src/api/orders.ts` (created at MG1-F) will expose. Keeping
// them here as local aliases means the spec is self-contained — it
// does NOT import from `frontend/src/api/*`, so the spec can be
// authored before that source code is final and so the spec keeps
// compiling even if those modules later refactor their internal
// types.

/**
 * Minimal design-summary shape returned by GET /api/designs per
 * ST-028. Each entry is one row in the LoadDesignList view and
 * carries enough metadata for ST-019-AC1 ("title and last-modified
 * time") to identify it.
 */
type DesignSummary = {
  id: string;
  title: string;
  createdAt: string;
  lastModifiedAt: string;
};

/**
 * Minimal cart-payload shape returned by GET /api/cart per ST-033.
 * The design list view does not display the cart, but the SPA may
 * prefetch the cart on initial mount (e.g., to render an
 * always-visible cart badge in the top nav). Mocking it ensures any
 * such prefetch resolves with deterministic data and does NOT
 * surface a network error in the design list snapshot.
 */
type CartPayload = {
  items: Array<{ designId: string; quantity: number; designTitle?: string }>;
  subtotal: number;
  currency: string;
};

// ---------------------------------------------------------------------------
// Constants — fixed test fixtures
// ---------------------------------------------------------------------------
//
// Every value here must remain CONSTANT across runs to satisfy
// ST-046-AC2 (deterministic visual baselines). Changing any of these
// constants requires an explicit baseline refresh via
//   `npx playwright test tests/visual/design-list.spec.ts --update-snapshots`
// followed by a deliberate commit (per ST-046-AC4).

// QA Final D — `FAKE_ID_TOKEN` constant removed. Auth is now driven
// by a real Firebase Auth Emulator user via `registerEmulatorUser` +
// `signInViaTestHook` (see "Visual auth bootstrap" section near the
// top of the file). The SDK manages its own idToken / refreshToken
// internally; the spec never references either directly.

/**
 * Fixed ISO-8601 timestamp used for every `createdAt` and
 * `lastModifiedAt` field in the design fixtures. The design list
 * UI may render these as absolute dates ("Jun 15, 2024") or as
 * relative strings ("3 months ago"); the absolute form is stable,
 * but the relative form drifts with the test execution date — so
 * any rendered timestamp element is also masked at snapshot time as
 * defense-in-depth.
 */
const FIXED_TIMESTAMP = '2024-06-15T12:00:00.000Z';

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
// are ordered MOST-SPECIFIC FIRST so that, e.g., `/api/designs`
// is matched before the generic fallback. This avoids the
// reverse-registration-order ambiguity that multiple overlapping
// `page.route()` calls otherwise produce.
//
// Playwright matches routes in the OPPOSITE order to their
// registration. Splitting `/api/designs` and `/api/cart` and
// `/api/**` across three separate `page.route()` calls would mean
// the most-recently-registered glob wins; if the broadest pattern is
// registered last, it intercepts every `/api/designs` and
// `/api/cart` request before the more specific handlers can
// dispatch. The single-handler approach used here removes that
// ambiguity entirely and mirrors the canonical pattern established
// by `tests/visual/cart.spec.ts` and
// `tests/visual/order-confirmation.spec.ts`.
//
// The handler always responds with `route.fulfill(...)` — never
// `route.continue()` — because we want the spec to be fully
// isolated from any real backend availability. If a request arrives
// that the handler does not explicitly recognize, it falls through
// to a generic empty 200 response so the SPA does not surface a
// network error in the snapshot.
//
// Per Rule R2, the handler does not log any request body or header
// content. The `request` parameter is consumed only via its `url()`
// and `method()` accessors.
//
// Per Rule R9, neither the design list response nor the cart
// response contains settlement-instrument, billing-address,
// fund-authorization-form, or processor-credential fields. The
// design list returns design metadata only (id, title, timestamps);
// the cart returns line items + subtotal + currency only.
async function mockBackendApi(
  page: Page,
  options: { designs?: DesignSummary[]; cart?: CartPayload } = {},
): Promise<void> {
  // ---------------------------------------------------------------------
  // QA Final D — Firebase Auth REST endpoints are NOT mocked. The new
  // auth bootstrap (signInViaTestHook + registerEmulatorUser) talks to
  // the live Firebase Auth Emulator at localhost:9099. Mocking the
  // identitytoolkit.googleapis.com / securetoken.googleapis.com
  // endpoints would break the real sign-in flow.
  // ---------------------------------------------------------------------

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

      // GET /api/designs (and any `?cursor=...&limit=...` variant) —
      // return the seeded design list per ST-028. The list is
      // wrapped in `{ items, nextCursor }` per the documented
      // pagination contract; `nextCursor: null` indicates this is
      // the final (and only) page.
      if (url.includes('/api/designs') && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: options.designs ?? [], nextCursor: null }),
        });
        return;
      }

      // GET /api/cart — return the seeded cart fixture per ST-033.
      // The design list surface does not display the cart, but the
      // SPA may prefetch the cart on initial mount (e.g., to render
      // an always-visible cart badge in the top nav). Per
      // ST-033-AC3, an empty cart still returns 200 with an empty
      // representation (never 404).
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

      // Fallback — every other `/api/**` request (including any
      // non-GET hit on `/api/designs` or `/api/cart`, which the
      // design list view should never trigger but a stray handler
      // might) resolves to an empty 200 so the SPA does not surface
      // a network error in the snapshot. This intentionally covers
      // future endpoints we have not yet characterised; the empty
      // body is conservative.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Test suite — Design list visual regression
// ---------------------------------------------------------------------------
//
// Two tests, two screenshot baselines (one for the empty state and
// one for the populated state). Each test:
//   1. Registers a fresh Firebase Auth Emulator user via
//      `registerEmulatorUser(request)` — see "Visual auth bootstrap"
//      near the top of the file.
//   2. Installs the design-and-cart mock with the appropriate
//      designs fixture.
//   3. Navigates to the SPA, waits for the canvas to attach.
//   4. Drives the SPA through `signInViaTestHook(page, user)` so
//      Firebase's `onAuthStateChanged` observer resolves to the
//      seeded user and gated UI surfaces (LoadDesignList trigger)
//      become enabled.
//   5. Opens the design list view, waits for the surface to render,
//      and asserts against its baseline at the fixed viewport,
//      masking the dynamic regions described above.
//
// QA Final D: the previous `test.beforeEach` block seeded auth via
// `setAuthenticatedState(page)` (a localStorage-write helper). Under
// Firebase v10's `browserLocalPersistence` rehydrate validation that
// helper silently failed and the SPA booted anonymous. The new
// pattern requires both the `page` and the `request` Playwright
// fixtures, so auth setup is inlined in each test rather than in a
// shared `beforeEach`.
//
// Both `chromium` and `webkit` projects (per playwright.config.ts)
// run this spec, so the baselines are captured per-project.
// Playwright stores per-project baselines under
//   frontend/visual-baselines/design-list.spec.ts/<project>/<name>.png
// automatically — no per-project filename munging is required in
// this file.

test.describe('Design list visual regression', () => {

  // -----------------------------------------------------------------
  // Test 1 — Empty state
  // -----------------------------------------------------------------
  //
  // The signed-in user has zero saved designs. The design list view
  // should render its empty-state copy / CTA (e.g., "You haven't
  // saved any designs yet — create your first design to see it
  // here"). The exact wording is the implementation's choice; the
  // baseline captures whatever the UI renders.
  test('ST-046-AC1: design list empty state', async ({ page, request }) => {
    // -------------------------------------------------------------
    // Auth bootstrap — register a fresh Emulator user.
    // -------------------------------------------------------------
    //
    // QA Final D — Issue #3 (DESIGN-LIST-VISUAL-AUTH).
    // ST-019 (Load Design List) requires the design-list endpoint
    // to be guarded by a valid session; the LoadDesignList trigger
    // button renders `[disabled]` until `isAuthenticated === true`.
    // The user is registered before any page navigation so its
    // credentials are available for `signInViaTestHook` later.
    const user = await registerEmulatorUser(request);

    // Install the dispatching backend mock with an empty designs
    // array BEFORE navigation. Every `/api/**` request — including
    // any prefetch on initial load — is intercepted from the first
    // navigation onward.
    await mockBackendApi(page, { designs: [] });

    // Load the SPA and wait for the canvas to attach. The R3F
    // canvas presence is the SPA-ready signal — every other surface
    // (including any design list panel/drawer/modal) mounts after
    // the configurator shell.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

    // -------------------------------------------------------------
    // Drive the SPA through Firebase JS SDK signIn via the
    // test-only `window.__strikeforge_test_auth__` hook.
    // -------------------------------------------------------------
    //
    // After `signIn()` resolves the SDK's `onAuthStateChanged`
    // observer fires, React re-renders with `isAuthenticated=true`,
    // and the LoadDesignList trigger (rendered `[disabled]` for
    // anonymous principals) becomes enabled.
    await signInViaTestHook(page, user);
    await page.waitForLoadState('networkidle');

    // -------------------------------------------------------------
    // Open the design list view.
    // -------------------------------------------------------------
    //
    // Per AAP §0.6.7 and §0.6.9 (MG1-F) the LoadDesignList
    // component is mounted in the top navigation. The trigger
    // affordance is implementation-dependent: it may be a button
    // labeled "Load saved design", "Load Design", "My Designs",
    // "Open Designs", or "Designs", or a button with
    // `data-testid="load-design-trigger"` or
    // `data-testid="load-design-list-trigger"`. We use a defensive
    // `.or()` chain that matches any of these and click the first
    // match. The `.first()` qualifier handles the edge case where
    // the SPA renders multiple matching candidates (e.g., mobile +
    // desktop variants both in the DOM). The accepted name pattern
    // mirrors the production E2E spec (`tests/e2e/save-design-flow.spec.ts`).
    const loadButton = page
      .getByRole('button', {
        name: /load saved design|load design|my designs|open designs|^designs$/i,
      })
      .or(page.getByTestId('load-design-trigger'))
      .or(page.getByTestId('load-design-list-trigger'));
    await loadButton.first().click();

    // -------------------------------------------------------------
    // Wait for the design list container to be visible.
    // -------------------------------------------------------------
    //
    // The container itself may be a `<dialog role="dialog">`, a
    // `<section role="region">` with an aria-label, or a generic
    // `<div>` with `data-testid="design-list-panel"`. We wait for
    // whichever is visible.
    const listContainer = page
      .getByRole('region', { name: /designs|saved designs/i })
      .or(page.getByRole('dialog', { name: /designs|saved designs/i }))
      .or(page.getByTestId('design-list-panel'));
    await listContainer.first().waitFor({ state: 'visible', timeout: 5_000 });

    // Allow any open / fade-in transitions and any deferred fetches
    // to settle before the snapshot. The Playwright config sets
    // `animations: 'disabled'` for screenshot capture, but waiting
    // for `networkidle` is the simplest way to confirm there are
    // no in-flight fetches that could mutate the surface
    // mid-snapshot.
    await page.waitForLoadState('networkidle');

    // -------------------------------------------------------------
    // Capture the visual baseline.
    // -------------------------------------------------------------
    //
    // Mask the R3F WebGL canvas (visible behind any drawer / modal
    // because the Three.js context continues rendering). The empty
    // state surface contains no timestamp or relative-time
    // elements (there are no design cards), so masking those is
    // not required for this baseline — but `<time>` is masked as
    // defense-in-depth in case the empty-state copy includes a
    // "last visited" or "last updated" hint that surfaces a
    // server-derived timestamp.
    //
    // `fullPage: false` — capture only the viewport so the
    // snapshot is exactly 1280×720 (the playwright config
    // viewport) and not the whole scrolled page.
    await expect(page).toHaveScreenshot('design-list-empty.png', {
      mask: [page.locator('canvas'), page.locator('time')],
      fullPage: false,
    });
  });

  // -----------------------------------------------------------------
  // Test 2 — Populated state
  // -----------------------------------------------------------------
  //
  // The signed-in user has three saved designs at fixed
  // timestamps. The design list view should render three list
  // items / cards with each design's title and last-modified
  // metadata. Per ST-019-AC1, the metadata displayed must be
  // sufficient to identify each design ("title and last-modified
  // time") — but the EXACT formatting (absolute date, relative
  // string, layout) is the implementation's choice. The baseline
  // captures whatever the UI produces.
  test('ST-046-AC1: design list populated state', async ({ page, request }) => {
    // -------------------------------------------------------------
    // Auth bootstrap — register a fresh Emulator user.
    // -------------------------------------------------------------
    //
    // QA Final D — Issue #3 (DESIGN-LIST-VISUAL-AUTH).
    // Same pattern as the empty-state test: register the user
    // first, then sign in via the test-only hook after the SPA's
    // canvas mounts. Each test creates its OWN fresh user so the
    // two tests do not share authentication state across worker
    // contexts.
    const user = await registerEmulatorUser(request);

    // Build the deterministic designs fixture. Three entries are
    // sufficient to validate list layout (single vs. multi-item
    // visual differences); the exact titles are arbitrary but
    // chosen to be visually distinct strings of varying length
    // ("Tournament Red" / "Practice Blue" / "Charity Match
    // Yellow") so any per-card truncation behaviour is exercised
    // by the baseline.
    //
    // Per Rule R9, this fixture contains design metadata only.
    // There are no settlement-instrument, billing-address,
    // fund-authorization-form, or processor-credential fields.
    const designs: DesignSummary[] = [
      {
        id: 'design-fixture-001',
        title: 'Tournament Red',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
      {
        id: 'design-fixture-002',
        title: 'Practice Blue',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
      {
        id: 'design-fixture-003',
        title: 'Charity Match Yellow',
        createdAt: FIXED_TIMESTAMP,
        lastModifiedAt: FIXED_TIMESTAMP,
      },
    ];

    // Install the dispatching backend mock with the populated
    // designs fixture BEFORE navigation. Every `/api/**` request —
    // including any prefetch on initial load — is intercepted from
    // the first navigation onward.
    await mockBackendApi(page, { designs });

    // Load the SPA and wait for the canvas to attach.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

    // Drive the SPA through Firebase JS SDK signIn via the
    // test-only `window.__strikeforge_test_auth__` hook so the
    // LoadDesignList trigger becomes enabled.
    await signInViaTestHook(page, user);
    await page.waitForLoadState('networkidle');

    // Open the design list view via the same defensive locator
    // chain used in the empty-state test.
    const loadButton = page
      .getByRole('button', {
        name: /load saved design|load design|my designs|open designs|^designs$/i,
      })
      .or(page.getByTestId('load-design-trigger'))
      .or(page.getByTestId('load-design-list-trigger'));
    await loadButton.first().click();

    // Wait for the design list container to be visible.
    const listContainer = page
      .getByRole('region', { name: /designs|saved designs/i })
      .or(page.getByRole('dialog', { name: /designs|saved designs/i }))
      .or(page.getByTestId('design-list-panel'));
    await listContainer.first().waitFor({ state: 'visible', timeout: 5_000 });

    // -------------------------------------------------------------
    // Wait for at least one design card to render.
    // -------------------------------------------------------------
    //
    // Each design entry could be an `<li role="listitem">` (the
    // natural semantic for an itemised list) or a card with
    // `data-testid="design-list-item"`. We scope the locator to
    // `listContainer.first()` so we do not match unrelated list
    // items elsewhere on the page.
    const firstCard = listContainer
      .first()
      .getByRole('listitem')
      .or(listContainer.first().getByTestId('design-list-item'))
      .first();
    await firstCard.waitFor({ state: 'visible', timeout: 5_000 });

    // Allow any list-rendering transitions and any deferred fetches
    // to settle before the snapshot.
    await page.waitForLoadState('networkidle');

    // -------------------------------------------------------------
    // Capture the visual baseline.
    // -------------------------------------------------------------
    //
    // The masked regions cover every potential source of dynamic
    // content:
    //   - `canvas`
    //       The R3F WebGL canvas; its pixel output varies with
    //       rasteriser (SwiftShader vs. real GPU) and must be
    //       excluded from the comparison.
    //   - `[data-testid="design-card-timestamp"]`
    //       Any per-card timestamp display element (e.g., "Last
    //       modified 3 months ago"). Even with FIXED_TIMESTAMP
    //       values in the fixture, relative-time formatters will
    //       drift with the test execution date.
    //   - `time`
    //       Semantic `<time>` elements that may render relative
    //       dates; masking is defense-in-depth in case the UI
    //       formats a timestamp as a relative string without using
    //       the `data-testid` attribute.
    //
    // `fullPage: false` — capture only the viewport so the
    // snapshot is exactly 1280×720 (the playwright config
    // viewport) and not the whole scrolled page.
    await expect(page).toHaveScreenshot('design-list-populated.png', {
      mask: [
        page.locator('canvas'),
        page.locator('[data-testid="design-card-timestamp"]'),
        page.locator('time'),
      ],
      fullPage: false,
    });
  });
});
