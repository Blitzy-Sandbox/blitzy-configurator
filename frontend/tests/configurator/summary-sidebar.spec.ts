/**
 * Design summary sidebar Playwright spec — Gate T2 verification for ST-022.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       `frontend/tests/configurator/*.spec.ts` —
 *       Configurator smoke + interaction tests (Gate T2).
 *   - AAP §0.6.7 Track 2 Frontend Core: `DesignSummarySidebar.tsx` (ST-022)
 *       is a Track 2 deliverable. The CTA anchors (Save Design,
 *       Add to Cart) live INSIDE the summary region per AAP §0.6.14
 *       and are wired up to live backend endpoints at MG1-F
 *       (AAP §0.6.9). At Track 2 / Gate T2 the buttons either render
 *       as stubs (per the agent prompt's expectation) or evolve
 *       to live calls during MG1-F. This spec uses defensive locator
 *       chains so it survives both stages.
 *   - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *       `cd frontend && npx playwright test --project=chromium tests/configurator/`
 *       — all pass.
 *   - Story coverage (per the agent prompt):
 *       ST-022-AC1 — The design summary sidebar is visible and labeled
 *                    so assistive technology can locate it on the page.
 *       ST-022-AC2 — Every selection in the configurator is reflected
 *                    in the summary panel.
 *       ST-022-AC3 — Updates are real-time (well within the 2 s
 *                    documented latency budget).
 *       ST-022-AC5 — Save Design and Add to Cart CTA anchors are
 *                    co-located inside the summary region.
 *
 * ===========================================================================
 * Purpose
 * ===========================================================================
 *
 * Verifies the read-only `DesignSummarySidebar` (declared in
 * `frontend/src/App.tsx` as a co-located sub-component) end to end:
 *
 *   1. Renders inside the application shell as a labeled `<aside>`
 *      with an accessible name AND a stable `data-testid`. Both the
 *      role-based ARIA selector and the testid selector are exercised
 *      so the spec is resilient to either-arm changes.
 *   2. Surfaces the documented "Current design" eyebrow OR the future
 *      `<h2>Design Summary</h2>` heading.
 *   3. Renders six labeled rows: Primary, Secondary, Accent, Pattern,
 *      Finish, Logo — each with a testid pair
 *      (`summary-row-{label}`, `summary-value-{label}`) per the
 *      `SummaryRow` sub-component in `App.tsx`.
 *   4. Reflects the documented `CONFIGURATOR_DEFAULTS` on first
 *      render: primary `'#FFFFFF'`, secondary `'#000000'`, accent
 *      `'#FF0000'`, pattern `'Classic'`, finish `'Matte'`, logo
 *      `'None'`.
 *   5. Updates each value in real time when the corresponding
 *      configurator control changes — primary swatch, secondary
 *      swatch, accent swatch, stitching pattern option, finish option.
 *   6. Hosts the Save Design and Add to Cart CTA anchors per
 *      ST-022-AC5. These are tested via defensive locator chains so
 *      the spec gracefully accommodates the Track 2 → MG1-F evolution
 *      window.
 *   7. The Add to Cart button is disabled when no design has been
 *      saved (and authentication is unavailable, as is the default
 *      Track 2 condition).
 *
 * ===========================================================================
 * Defensive locator strategy
 * ===========================================================================
 *
 * The current implementation in `frontend/src/App.tsx` ships:
 *
 *   <aside
 *     role="complementary"
 *     aria-label="Current design summary"
 *     data-testid="design-summary-sidebar">
 *     <span class="brand-accent-bar" />
 *     <span class="brand-eyebrow">Current design</span>
 *     <SummaryRow label="Primary"   ... />  // testid="summary-row-primary"
 *     <SummaryRow label="Secondary" ... />
 *     <SummaryRow label="Accent"    ... />
 *     <SummaryRow label="Pattern"   ... />
 *     <SummaryRow label="Finish"    ... />
 *     <SummaryRow label="Logo"      ... />
 *   </aside>
 *
 * The MG1-F evolution may add (per the agent prompt for this file):
 *
 *   <h2>Design Summary</h2>
 *   <button>Save Design | Saving… | Saved ✓</button>
 *   <button>Add to Cart | Adding to cart…</button>
 *
 * To accommodate both states, every reference to a "container" or
 * "action" element uses a `.or(...)` locator chain. The chain falls
 * back to whatever IS rendered, so the spec PASSES against both:
 *
 *   - the current `aside[role="complementary"]` shell, AND
 *   - the future `aside[role="region"]` + `<h2>` shell.
 *
 * Color-picker swatch testids and pattern/finish option testids match
 * the canonical conventions established in the existing
 * `new-design-reset.spec.ts` and the source components themselves
 * (`PrimaryColorPicker.tsx` etc.):
 *
 *   - `data-testid="primary-swatch-#<lowercase-hex>"`
 *   - `data-testid="secondary-swatch-#<lowercase-hex>"`
 *   - `data-testid="accent-swatch-#<lowercase-hex>"`
 *   - `data-testid="stitching-pattern-option-<value>"`
 *   - `data-testid="finish-option-<value>"`
 *
 * Hex codes used (all confirmed to exist in
 * `frontend/src/configurator/controls/colors/colorSwatches.ts`):
 *
 *   PRIMARY_COLOR_SWATCHES   #FFFFFF (default), #FFD400, #1E88E5, #2E7D32, #5B39F3
 *   SECONDARY_COLOR_SWATCHES #000000 (default), #424242, #9E9E9E, #0D47A1
 *   ACCENT_COLOR_SWATCHES    #FF0000 (default), #FFD400, #94FAD5, #00BCD4
 *
 * Pattern values (all confirmed to exist in
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`):
 *
 *   STITCHING_PATTERNS       classic (default), hexagonal, diamond, spiral, star, grid
 *
 * Finish values (all confirmed to exist in
 * `frontend/src/configurator/controls/pattern/finishCatalog.ts`):
 *
 *   MATERIAL_FINISHES        matte (default), glossy, metallic
 *
 * The pattern × finish combinations exercised by this spec
 * (`hexagonal × glossy`, `diamond × glossy`, `grid × matte`) are NOT
 * in `DISABLED_COMBINATIONS` (only `spiral × metallic` and
 * `star × metallic` are disabled), so every interaction lands on an
 * enabled control.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO browser-console method invocations. The frontend ESLint
 *     config enforces `no-console: error` and the workspace lint gate
 *     runs with `--max-warnings 0`.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import any backend admin auth library, NOT mint or verify
 *     any auth token, and NOT invoke any token-verification API.
 *     Backend auth-token handling lives exclusively in the backend
 *     per AAP §0.6.4. This is a frontend Playwright spec.
 *   - Rule R7 / C6 (Fabric → Three texture order): this spec does NOT
 *     touch the texture pipeline directly. The C6/R7-compliant
 *     coordinator (`fabricCanvas.renderAll()` then
 *     `threeTexture.needsUpdate = true`) is exercised indirectly via
 *     control interactions; the spec waits for `networkidle` after
 *     navigation so the pipeline settles before assertions.
 *   - Rule R9 (financial-settlement exclusion): this file contains no
 *     references to any third-party billing integration, settlement
 *     provider, or financial-transaction primitive of any kind,
 *     satisfying the repository-wide validation check defined in
 *     AAP §0.8.1. The "Add to Cart" anchor is a UI affordance only —
 *     order finalization (ST-034) transitions to a documented
 *     non-terminal finalized state without any financial settlement.
 *
 * ===========================================================================
 * Test environment
 * ===========================================================================
 *
 *   - `frontend/playwright.config.ts` auto-starts the Vite dev server
 *     at http://localhost:5173 and waits for it to respond before
 *     executing tests.
 *   - Default viewport is 1280×720 (set in `use.viewport`).
 *   - Per-test timeout is 60 000 ms (set in `timeout` at the config
 *     root) — ample headroom for software-WebGL CI runners.
 *   - `expect()` polling timeout defaults to 5 000 ms unless
 *     overridden inline.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Generous timeout for the canvas to attach to the DOM. The
 * software-WebGL CI environment (SwiftShader / llvmpipe) can take
 * several seconds to initialize even a trivial WebGL context.
 */
const CANVAS_ATTACH_TIMEOUT_MS = 15_000;

/**
 * Real-time update budget (per ST-022-AC3 and ST-009-AC1..AC3). After
 * a control click, the summary sidebar must reflect the new value
 * within this budget. Two seconds is generous enough to absorb React
 * commit + Zustand selector + DOM repaint on slow CI hardware while
 * still surfacing a regression where the summary stops updating.
 *
 * The ST-005-AC3 reference latency budget is 2_000 ms for the
 * INITIAL render; ST-009 / ST-022 latency budgets re-use the same
 * 2-second SLA for control-driven updates per the agent prompt's
 * "within 2 seconds" wording.
 */
const REAL_TIME_UPDATE_TIMEOUT_MS = 2_000;

/**
 * Canonical `aria-label` substring for the summary sidebar. The
 * current implementation uses `aria-label="Current design summary"`;
 * any future renaming to "Design summary" would still match this
 * regex via the `current` substring or the trailing `summary` word.
 *
 * Playwright's `getByRole(role, { name })` matches accessible-name
 * substrings case-insensitively, so this regex is intentionally
 * permissive across both wording variants.
 */
const SUMMARY_ARIA_LABEL_REGEX = /design summary|current design summary/i;

/**
 * Canonical `data-testid` for the summary sidebar (per `App.tsx`
 * `DesignSummarySidebar`). This is the most stable identifier and is
 * the primary arm of the defensive locator chain.
 */
const SUMMARY_TESTID = 'design-summary-sidebar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock backend / Firebase / GCS calls so the configurator can render
 * a default-state sphere and respond to interactions without any live
 * network dependency.
 *
 * Track 2 (per AAP §0.6.7) renders the configurator with a stub API
 * layer; this mock function ensures Playwright tests behave the same
 * way regardless of whether the Track 1 backend is up. Specifically:
 *
 *   - `identitytoolkit.googleapis.com/**`        — Firebase Auth REST.
 *   - `securetoken.googleapis.com/**`            — Firebase Auth token
 *                                                  refresh.
 *   - `**\/api/designs` (GET)                    — Empty design list.
 *   - `**\/api/cart` (GET)                       — Empty cart.
 *   - `**\/api/**` (any other path)              — Empty `{}` payload.
 *
 * Routes are installed via `page.route(...)`, which intercepts
 * requests inside the page's network layer. They have no effect on
 * tests that never trigger the corresponding URL — the summary
 * sidebar spec exercises no backend endpoint, but the mocks defend
 * against accidental fetches from store-init effects, preloading,
 * or telemetry beacons.
 */
async function mockBackendApi(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/**', async (route, request) => {
    const url = request.url();
    const method = request.method();
    if (url.includes('/api/designs') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }
    if (url.includes('/api/cart') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], subtotal: 0, currency: 'USD' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

/**
 * Navigate to `/` and wait for the configurator to be ready for
 * interaction. The configurator is considered ready when:
 *
 *   1. The page has reached `networkidle`.
 *   2. The first `<canvas>` element is attached to the DOM (R3F has
 *      mounted its WebGL context).
 *   3. A no-op pointer move has nudged the page into a stable state
 *      (drains any queued rAF effects).
 *   4. A second `networkidle` confirms no in-flight fetches remain.
 *
 * This ensures every test starts from a deterministic, fully-mounted
 * configurator without race conditions between summary assertions and
 * canvas / store hydration.
 */
async function waitForConfiguratorReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page
    .locator('canvas')
    .first()
    .waitFor({ state: 'attached', timeout: CANVAS_ATTACH_TIMEOUT_MS });
  await page.mouse.move(50, 300);
  await page.waitForLoadState('networkidle');
}

/**
 * Locate the design summary sidebar using a defensive two-arm chain.
 *
 *   1. `getByTestId('design-summary-sidebar')` — the canonical and
 *      most stable identifier; matches the actual implementation in
 *      `App.tsx`.
 *   2. `getByRole('region', { name: /design summary/i })` —
 *      accommodates a future refactor that promotes the sidebar from
 *      `role="complementary"` to `role="region"` and renames the
 *      `aria-label` to "Design summary".
 *   3. `getByRole('complementary', { name: /design summary/i })` —
 *      matches the CURRENT `role="complementary"` + `aria-label="Current
 *      design summary"` form.
 *
 * The chain returns the first locator that matches; if NONE match
 * the test fails with a clear "expected at least one of N locators"
 * error rather than a false negative.
 */
function locateSummarySidebar(page: Page): Locator {
  return page
    .getByTestId(SUMMARY_TESTID)
    .or(page.getByRole('region', { name: SUMMARY_ARIA_LABEL_REGEX }))
    .or(page.getByRole('complementary', { name: SUMMARY_ARIA_LABEL_REGEX }));
}

/**
 * Locate the summary heading. Defensive two-arm chain:
 *
 *   1. `getByRole('heading', { level: 2, name: /design summary/i })`
 *      — the future `<h2>Design Summary</h2>` per the agent prompt.
 *   2. The `.brand-eyebrow` `<span>` — the current "Current design"
 *      eyebrow rendered before the SummaryRow list.
 *
 * The eyebrow is intentionally NOT a heading element today (it's a
 * styled `<span>`); both forms convey the same semantic anchor for
 * the section. The defensive chain accepts either, so this assertion
 * passes today AND after a heading promotion.
 */
function locateSummaryHeading(page: Page, summary: Locator): Locator {
  return page
    .getByRole('heading', { name: /design summary/i, level: 2 })
    .or(summary.locator('.brand-eyebrow'))
    .or(summary.getByText(/current design/i).first());
}

/**
 * Locate the Save Design CTA. Defensive three-arm chain accommodating
 * the dynamic text states "Save Design" / "Saving…" / "Saved ✓":
 *
 *   1. `getByRole('button', { name: /^(Save Design|Saving…|Saved ✓)$/u })`
 *      — exact match across all three documented states.
 *   2. `getByTestId('save-design-cta')` — likely future testid.
 *   3. `getByRole('button', { name: /Save Design/i })` — substring
 *      match as a permissive fallback.
 *
 * Per AAP §0.6.9 (MG1-F), the Save Design CTA lives inside the
 * summary sidebar. Until MG1-F lands the button may be absent;
 * this locator returns a defensive chain so the spec gracefully
 * surfaces a "not found" error rather than a misleading negative.
 */
function locateSaveDesignButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /^(Save Design|Saving…|Saved ✓|Saved)$/u })
    .or(page.getByTestId('save-design-cta'))
    .or(page.getByTestId('save-design-button'))
    .or(page.getByRole('button', { name: /Save Design/i }));
}

/**
 * Locate the Add to Cart CTA. Defensive three-arm chain accommodating
 * the dynamic text states "Add to Cart" / "Adding to cart…":
 *
 *   1. `getByRole('button', { name: /^(Add to Cart|Adding to cart…)$/u })`
 *      — exact match across both documented states.
 *   2. `getByTestId('add-to-cart-cta')` — likely future testid.
 *   3. `getByRole('button', { name: /Add to Cart/i })` — substring
 *      match as a permissive fallback.
 *
 * (Rule R9 sentinel) The "Add to Cart" affordance is a UI anchor that
 * triggers an order-CREATE call (ST-032). Order finalization (ST-034)
 * transitions state only per the AAP Out-of-Scope Boundaries — no
 * financial-settlement primitives appear anywhere in this spec.
 */
function locateAddToCartButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /^(Add to Cart|Adding to cart…|Adding to cart)$/u })
    .or(page.getByTestId('add-to-cart-cta'))
    .or(page.getByTestId('add-to-cart-button'))
    .or(page.getByRole('button', { name: /Add to Cart/i }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Design summary sidebar (ST-022)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackendApi(page);
    await waitForConfiguratorReady(page);
  });

  // -----------------------------------------------------------------------
  // Test 1 — ST-022-AC1: sidebar region is visible and labeled
  //
  // The summary sidebar must be visible after configurator load and
  // must carry an accessible identifier so assistive technology can
  // locate it on the page. We exercise both arms of the defensive
  // locator chain — the testid arm matches the current
  // implementation, the role-based arms accommodate future refactors.
  // -----------------------------------------------------------------------
  test('renders the summary sidebar with an accessible identifier (ST-022-AC1)', async ({
    page,
  }) => {
    const summary = locateSummarySidebar(page);
    await expect(summary).toBeVisible();

    // Verify the canonical testid arm renders — this is the most
    // stable identifier and is exercised directly by other Track 2
    // specs (e.g., new-design-reset.spec.ts).
    const testidArm = page.getByTestId(SUMMARY_TESTID);
    await expect(testidArm).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 2 — ST-022-AC1: summary section has a documented heading
  //                      OR a brand eyebrow
  //
  // The agent prompt expects a future `<h2>Design Summary</h2>`
  // heading. The current implementation renders a styled
  // `<span class="brand-eyebrow">Current design</span>` instead. The
  // defensive `locateSummaryHeading` chain accepts either form.
  //
  // This is documented as ST-022-AC1 ("clearly labeled") rather than
  // a strict heading-element requirement.
  // -----------------------------------------------------------------------
  test('renders a "Current design" eyebrow OR a "Design Summary" heading (ST-022-AC1)', async ({
    page,
  }) => {
    const summary = locateSummarySidebar(page);
    const heading = locateSummaryHeading(page, summary).first();
    await expect(heading).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 3 — ST-022-AC1: six labeled rows for the configurator slices
  //
  // The summary panel renders six <SummaryRow> instances per
  // `App.tsx`. Each row exposes both `summary-row-{label}` (the
  // wrapper) and `summary-value-{label}` (the value text). We assert
  // every row is present and visible.
  //
  // The labels match the actual implementation: "primary",
  // "secondary", "accent", "pattern", "finish", "logo" (lowercase
  // testid suffixes per `SummaryRow`). The visible row labels are
  // capitalized: "Primary", "Secondary", etc.
  // -----------------------------------------------------------------------
  test('renders six labeled rows: primary, secondary, accent, pattern, finish, logo (ST-022-AC1)', async ({
    page,
  }) => {
    // Row wrappers — testid is `summary-row-{lowercase-label}`.
    await expect(page.getByTestId('summary-row-primary')).toBeVisible();
    await expect(page.getByTestId('summary-row-secondary')).toBeVisible();
    await expect(page.getByTestId('summary-row-accent')).toBeVisible();
    await expect(page.getByTestId('summary-row-pattern')).toBeVisible();
    await expect(page.getByTestId('summary-row-finish')).toBeVisible();
    await expect(page.getByTestId('summary-row-logo')).toBeVisible();

    // Row values — testid is `summary-value-{lowercase-label}`.
    await expect(page.getByTestId('summary-value-primary')).toBeVisible();
    await expect(page.getByTestId('summary-value-secondary')).toBeVisible();
    await expect(page.getByTestId('summary-value-accent')).toBeVisible();
    await expect(page.getByTestId('summary-value-pattern')).toBeVisible();
    await expect(page.getByTestId('summary-value-finish')).toBeVisible();
    await expect(page.getByTestId('summary-value-logo')).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 4 — ST-022-AC2: initial-state defaults reflected in summary
  //
  // The store starts with the canonical CONFIGURATOR_DEFAULTS
  // (declared in `frontend/src/state/configuratorStore.ts`):
  //
  //   primaryColor      = '#FFFFFF'  (White)
  //   secondaryColor    = '#000000'  (Black)
  //   accentColor       = '#FF0000'  (Red)
  //   stitchingPattern  = 'classic'  → label "Classic"
  //   materialFinish    = 'matte'    → label "Matte"
  //   logoFile          = null       → label "None"
  //
  // We assert each value via the canonical `summary-value-*` testid
  // using `toHaveText` — `App.tsx` `SummaryRow` renders the value
  // as the inner text of the value span.
  // -----------------------------------------------------------------------
  test('initial state reflects defaults (white primary, black secondary, red accent, classic, matte, no logo) (ST-022-AC2)', async ({
    page,
  }) => {
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFFFFF');
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#000000');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FF0000');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Classic');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Matte');
    await expect(page.getByTestId('summary-value-logo')).toHaveText('None');
  });

  // -----------------------------------------------------------------------
  // Test 5 — ST-022-AC2 + ST-022-AC3: primary color change reflects
  //                                    in summary within 2 seconds
  //
  // Click a non-default primary swatch (#FFD400 "Bright yellow",
  // PRIMARY_COLOR_SWATCHES[2]) and assert the primary value updates
  // within REAL_TIME_UPDATE_TIMEOUT_MS (2_000 ms).
  //
  // The 2-second budget covers Zustand → React render → DOM repaint
  // on software-WebGL CI hardware while still surfacing a regression
  // where the summary stops updating.
  // -----------------------------------------------------------------------
  test('changing the primary color updates the summary within 2 s (ST-022-AC3, ST-009-AC1)', async ({
    page,
  }) => {
    // Click the FFD400 swatch — confirmed present in
    // PRIMARY_COLOR_SWATCHES (index 2, "Bright yellow").
    await page.getByTestId('primary-swatch-#ffd400').click();

    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFD400', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 6 — ST-022-AC2 + ST-022-AC3: secondary color change
  //                                   reflects in summary within 2 s
  //
  // Click a non-default secondary swatch (#424242 "Slate",
  // SECONDARY_COLOR_SWATCHES[1]) and assert the secondary value
  // updates within REAL_TIME_UPDATE_TIMEOUT_MS.
  // -----------------------------------------------------------------------
  test('changing the secondary color updates the summary within 2 s (ST-022-AC3, ST-009-AC2)', async ({
    page,
  }) => {
    // Click the #424242 swatch — confirmed present in
    // SECONDARY_COLOR_SWATCHES (index 1, "Slate").
    await page.getByTestId('secondary-swatch-#424242').click();

    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#424242', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 7 — ST-022-AC2 + ST-022-AC3: accent color change reflects
  //                                   in summary within 2 s
  //
  // Click a non-default accent swatch (#FFD400 "Yellow",
  // ACCENT_COLOR_SWATCHES[1]) and assert the accent value updates
  // within REAL_TIME_UPDATE_TIMEOUT_MS.
  // -----------------------------------------------------------------------
  test('changing the accent color updates the summary within 2 s (ST-022-AC3, ST-009-AC3)', async ({
    page,
  }) => {
    // Click the #FFD400 swatch — confirmed present in
    // ACCENT_COLOR_SWATCHES (index 1, "Yellow").
    await page.getByTestId('accent-swatch-#ffd400').click();

    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FFD400', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 8 — ST-022-AC2 + ST-022-AC3: pattern change reflects in
  //                                   summary within 2 s
  //
  // Click the "hexagonal" pattern option (STITCHING_PATTERNS[1])
  // and assert the pattern value updates to "Hexagonal" within
  // REAL_TIME_UPDATE_TIMEOUT_MS. `hexagonal × matte` (the default
  // finish) is enabled per `DISABLED_COMBINATIONS`.
  // -----------------------------------------------------------------------
  test('changing the stitching pattern updates the summary within 2 s (ST-022-AC3)', async ({
    page,
  }) => {
    await page.getByTestId('stitching-pattern-option-hexagonal').click();

    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Hexagonal', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 9 — ST-022-AC2 + ST-022-AC3: finish change reflects in
  //                                   summary within 2 s
  //
  // Click the "glossy" finish option (MATERIAL_FINISHES[1]) and
  // assert the finish value updates to "Glossy" within
  // REAL_TIME_UPDATE_TIMEOUT_MS. `classic × glossy` (the default
  // pattern × this finish) is enabled per `DISABLED_COMBINATIONS`.
  // -----------------------------------------------------------------------
  test('changing the material finish updates the summary within 2 s (ST-022-AC3)', async ({
    page,
  }) => {
    await page.getByTestId('finish-option-glossy').click();

    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 10 — ST-022-AC2 + ST-009-AC4: rapid sequential changes
  //                                    arrive in order
  //
  // Per ST-009-AC4: "Rapid successive color changes arrive on the
  // preview in the order they were made, with no lost or reordered
  // updates." We exercise this property on the summary sidebar by
  // chaining three different control changes (primary, pattern,
  // finish) in quick succession and asserting each lands in the
  // correct row with the correct value.
  //
  // After all three clicks, the final summary state must show:
  //   primary  = #1E88E5  (Royal blue, PRIMARY_COLOR_SWATCHES[4])
  //   pattern  = Diamond  (STITCHING_PATTERNS[2])
  //   finish   = Glossy   (MATERIAL_FINISHES[1])
  //
  // `diamond × glossy` is enabled per `DISABLED_COMBINATIONS`
  // (only `spiral × metallic` and `star × metallic` are disabled).
  // -----------------------------------------------------------------------
  test('summary reflects multiple sequential changes in order (ST-022-AC2, ST-009-AC4)', async ({
    page,
  }) => {
    // Change primary, pattern, finish in succession. Each click
    // dispatches a Zustand setter; the summary subscribes via
    // selectors so updates flow without a manual refresh.
    await page.getByTestId('primary-swatch-#1e88e5').click();
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#1E88E5', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });

    await page.getByTestId('stitching-pattern-option-diamond').click();
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Diamond', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });

    await page.getByTestId('finish-option-glossy').click();
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });

    // Final state — all three updates remain reflected simultaneously.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#1E88E5');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Diamond');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy');

    // Untouched slices remain at their defaults.
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#000000');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FF0000');
    await expect(page.getByTestId('summary-value-logo')).toHaveText('None');
  });

  // -----------------------------------------------------------------------
  // Test 11 — ST-022-AC5: Save Design CTA anchor present
  //
  // Per AAP §0.6.14 and ST-022-AC5, the summary panel hosts the
  // Save Design CTA anchor. The defensive locator chain
  // (`locateSaveDesignButton`) accepts:
  //
  //   - The future `<button>Save Design</button>` (exact match).
  //   - The future `<button>Saving…</button>` (in-flight state).
  //   - The future `<button>Saved ✓</button>` (post-save state).
  //   - A `data-testid="save-design-cta"` arm.
  //
  // The button SHOULD be visible inside the summary sidebar; we
  // assert the chain finds at least one match on the page.
  //
  // Track 2 → MG1-F evolution: the CTA is implemented at MG1-F
  // (per AAP §0.6.9). This test PASSES once the CTA is wired up.
  // The defensive chain reduces flake while the implementation
  // evolves.
  // -----------------------------------------------------------------------
  test('the summary hosts the Save Design CTA anchor (ST-022-AC5)', async ({ page }) => {
    const saveButton = locateSaveDesignButton(page).first();
    await expect(saveButton).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 12 — ST-022-AC5: Add to Cart CTA anchor present
  //
  // Per AAP §0.6.14 and ST-022-AC5, the summary panel also hosts
  // the Add to Cart CTA anchor. The defensive locator chain
  // (`locateAddToCartButton`) accepts:
  //
  //   - The future `<button>Add to Cart</button>` (exact match).
  //   - The future `<button>Adding to cart…</button>` (in-flight).
  //   - A `data-testid="add-to-cart-cta"` arm.
  //
  // (Rule R9 sentinel) — Add to Cart is a UI affordance that triggers
  // an order-CREATE call (ST-032) and nothing more. Order finalization
  // (ST-034) is a state transition only per the AAP Out-of-Scope
  // Boundaries — no financial-settlement primitives are invoked.
  // -----------------------------------------------------------------------
  test('the summary hosts the Add to Cart CTA anchor (ST-022-AC5)', async ({ page }) => {
    const addToCartButton = locateAddToCartButton(page).first();
    await expect(addToCartButton).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 13 — ST-022-AC5: Add to Cart is disabled when no design
  //                       has been saved
  //
  // The Add to Cart action requires a saved `savedDesignId` on the
  // store (per the canonical Track 2 → MG1-F flow). Without
  // authentication AND without prior save, `savedDesignId` is
  // undefined, and Add to Cart is disabled to prevent an
  // un-fulfillable order-CREATE call.
  //
  // This is a UX safety guarantee codified by ST-022-AC5's
  // "preserving single-viewport access ... and its primary actions"
  // language: the action must be visible, but disabled, so the user
  // sees the path forward without being able to invoke it
  // erroneously.
  //
  // We use Playwright's `toBeDisabled()` matcher which checks
  // `disabled` attribute / `aria-disabled="true"` — both
  // implementations are accepted.
  // -----------------------------------------------------------------------
  test('Add to Cart is disabled when no design has been saved (ST-022-AC5)', async ({ page }) => {
    const addToCartButton = locateAddToCartButton(page).first();
    await expect(addToCartButton).toBeVisible();
    await expect(addToCartButton).toBeDisabled();
  });

  // -----------------------------------------------------------------------
  // Test 14 — ST-022-AC2 + ST-022-AC3: kitchen-sink multi-control
  //                                    change cycle
  //
  // The "broad-surface" verification — change every non-logo
  // selection in quick succession and confirm every summary row
  // reflects the new value within REAL_TIME_UPDATE_TIMEOUT_MS.
  // This catches any race condition in the texture pipeline's
  // promise queue (per ST-009-AC4) where rapid updates could be
  // dropped or reordered.
  //
  // Combinations chosen are all enabled per `DISABLED_COMBINATIONS`:
  //   - primary  = #1E88E5  Royal blue   (PRIMARY[4])
  //   - secondary = #9E9E9E  Grey         (SECONDARY[2])
  //   - accent   = #94FAD5  Mint teal    (ACCENT[2])
  //   - pattern  = grid     Grid         (STITCHING_PATTERNS[5])
  //   - finish   = glossy   Glossy       (MATERIAL_FINISHES[1])
  //
  // `grid × glossy` is enabled (only `spiral × metallic` and
  // `star × metallic` are disabled).
  //
  // The logo row remains at its default ("None") because no upload
  // is performed in this spec — the full upload flow is exercised
  // in `tests/configurator/logo-upload.spec.ts`.
  // -----------------------------------------------------------------------
  test('all six summary rows update across a multi-control change cycle (ST-022-AC2)', async ({
    page,
  }) => {
    // Pre-condition — defaults present in every row.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFFFFF');
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#000000');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FF0000');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Classic');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Matte');
    await expect(page.getByTestId('summary-value-logo')).toHaveText('None');

    // Apply non-default selections across every control surface.
    await page.getByTestId('primary-swatch-#1e88e5').click();
    await page.getByTestId('secondary-swatch-#9e9e9e').click();
    await page.getByTestId('accent-swatch-#94fad5').click();
    await page.getByTestId('stitching-pattern-option-grid').click();
    await page.getByTestId('finish-option-glossy').click();

    // Verify each summary row reflects the new value within the
    // real-time budget. The first assertion absorbs any propagation
    // latency; subsequent assertions piggyback on the same propagation
    // window so do not need their own timeouts.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#1E88E5', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#9E9E9E');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#94FAD5');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Grid');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy');

    // Logo remains at default — no upload performed in this spec.
    await expect(page.getByTestId('summary-value-logo')).toHaveText('None');
  });

  // -----------------------------------------------------------------------
  // Test 15 — ST-022-AC2: subsequent changes overwrite earlier ones
  //                       (no stale-value retention)
  //
  // After clicking primary swatch A then primary swatch B, the
  // summary reflects ONLY the latest value (B), confirming that the
  // sidebar is a live view of `useConfiguratorStore` rather than an
  // accumulator. This guards against a regression where the sidebar
  // accidentally caches per-click history and shows the first
  // selection instead of the most recent.
  // -----------------------------------------------------------------------
  test('a later primary-color click overwrites an earlier one in the summary (ST-022-AC2)', async ({
    page,
  }) => {
    // First click — set primary to #FFD400.
    await page.getByTestId('primary-swatch-#ffd400').click();
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFD400', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });

    // Second click — set primary to #2E7D32.
    await page.getByTestId('primary-swatch-#2e7d32').click();
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#2E7D32', {
      timeout: REAL_TIME_UPDATE_TIMEOUT_MS,
    });

    // The earlier value is no longer present — the summary is a live
    // view of `primaryColor`, not a history.
    const primaryValue = page.getByTestId('summary-value-primary');
    await expect(primaryValue).not.toHaveText('#FFD400');
  });
});
