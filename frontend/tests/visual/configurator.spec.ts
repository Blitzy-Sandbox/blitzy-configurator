/**
 * Configurator visual regression — Playwright spec for ST-046-AC1 coverage of
 * the "configurator" surface.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       "frontend/tests/visual/*.spec.ts | toHaveScreenshot() visual
 *        regression (ST-046)".
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "toHaveScreenshot() baselines for CONFIGURATOR, design list,
 *        cart, and order confirmation at fixed viewport (ST-046);
 *        ≥ 4 surfaces."
 *   - ST-046-AC1 (the AC source of truth per Rule R1):
 *       "The visual regression suite … captures screenshots of at least
 *        the CONFIGURATOR, design list, cart, and order confirmation
 *        surfaces."
 *   - ST-046-AC2: each captured screenshot is compared against a
 *     versioned baseline at a fixed viewport size; any delta exceeding
 *     the documented pixel-difference threshold produces a failed
 *     verdict.
 *   - ST-046-AC4: baseline updates require an explicit commit to the
 *     versioned baseline artifacts; no run can silently overwrite a
 *     baseline.
 *   - ST-046-AC5: the suite runs in the local development environment
 *     against locally-started services so developers can capture,
 *     refresh, and compare baselines without remote access.
 *   - ST-001 (Render Initial Sphere Preview on Configurator Load): the
 *     configurator renders a 3D ball preview centered in the viewport;
 *     the preview re-centers and re-fits on viewport resize; no
 *     console-level error output during initial render.
 *   - ST-006 (Select Primary Panel Color from Swatch Palette): the
 *     primary-color palette is visible in the control sidebar; clicking
 *     a swatch updates the preview's primary panel color within the
 *     latency budget; the primary-color picker is reachable and
 *     operable using only keyboard input.
 *   - ST-010 (Select Stitching Pattern): exactly six stitching pattern
 *     options (classic, hexagonal, diamond, spiral, star, grid).
 *   - ST-011 (Material Finish Selector): three finishes (matte, glossy,
 *     metallic).
 *
 * ===========================================================================
 * Purpose
 * ===========================================================================
 *
 * Captures TWO baseline snapshots of the configurator surface:
 *
 *   1) `configurator-default.png`   — page-load default state with the
 *      documented store defaults applied (primary `#FFFFFF`, secondary
 *      `#000000`, accent `#FF0000`, pattern `classic`, finish `matte`,
 *      no logo).
 *   2) `configurator-customized.png` — after the user changes the
 *      primary color, stitching pattern, and material finish via the
 *      controls sidebar. This second baseline validates that the UI
 *      updates correctly in response to control interactions and that
 *      the selected-state visual treatment renders consistently.
 *
 * Both snapshots are taken at the fixed 1280×720 viewport configured
 * in `frontend/playwright.config.ts`, on BOTH the `chromium` and
 * `webkit` projects defined there. Playwright auto-suffixes baseline
 * filenames with `-chromium-linux.png` / `-webkit-linux.png` so
 * per-browser baselines are independent — no manual filename munging
 * is required in this file.
 *
 * Per Playwright's snapshot-path convention, the resulting baselines
 * are stored under `frontend/visual-baselines/` (the
 * `snapshotDir` configured in `playwright.config.ts`):
 *
 *   frontend/visual-baselines/
 *     visual/
 *       configurator.spec.ts/
 *         configurator-default-chromium-linux.png
 *         configurator-default-webkit-linux.png
 *         configurator-customized-chromium-linux.png
 *         configurator-customized-webkit-linux.png
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. The frontend ESLint config enforces
 *     `no-console: error` (only `warn` and `error` are allowed) and
 *     the workspace lint gate runs with `--max-warnings 0`. No bearer
 *     tokens, passwords, or `Authorization` header values are
 *     constructed, formatted, or logged anywhere.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, NOT mint or verify any JWT, and
 *     NOT invoke `verifyIdToken()`. Backend auth-token handling lives
 *     exclusively in the backend per AAP §0.6.4.
 *   - Rule R7 / C6 (Fabric → Three texture order): this spec does
 *     NOT touch the texture pipeline directly. The C6/R7-compliant
 *     texture coordinator (`fabricCanvas.renderAll()` then
 *     `threeTexture.needsUpdate = true`) is exercised indirectly via
 *     the control interactions in the customized state test; we wait
 *     for `networkidle` after each interaction so the pipeline
 *     settles before snapshot capture.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no terminology associated with downstream financial settlement,
 *     processor integrations, or financial-instrument handling. The
 *     configurator surface is purely a design-customization tool; it
 *     never models a settlement flow.
 *
 * ===========================================================================
 * Determinism Strategy
 * ===========================================================================
 *
 *   - WebGL canvas masking: the 3D `<canvas>` element rendered by
 *     `@react-three/fiber` produces output that varies by GPU driver,
 *     OS antialiasing, and rasterizer (Chromium's SwiftShader vs.
 *     WebKit's pipeline). Therefore the canvas MUST be MASKED in
 *     every screenshot via `mask: [page.locator('canvas')]`. Without
 *     masking, baselines become flaky and unreliable — the magenta
 *     box that Playwright overlays in both baseline and current
 *     captures hides the non-deterministic pixels from the diff.
 *   - Backend mocking: every `/api/**` request is intercepted by a
 *     single dispatching `page.route()` handler so the configurator
 *     surface renders consistently regardless of backend availability.
 *     ST-046-AC5 says the suite runs against locally-started
 *     services, but for VISUAL determinism the mocks override even
 *     when the backend is reachable — we never want a transient
 *     network condition to invalidate a baseline.
 *   - Firebase Auth REST blocking: the SPA may initialize the
 *     Firebase JS SDK at boot even though the configurator surface
 *     does not require auth. We block `identitytoolkit.googleapis.com`
 *     and `securetoken.googleapis.com` with empty 200 fixtures so
 *     any background SDK probe resolves synthetically rather than
 *     producing a network error that could flicker error UI into
 *     the snapshot.
 *   - Idle auto-rotate suppression: per ST-003 the preview begins
 *     auto-rotating after an idle interval. We park the mouse over
 *     the controls sidebar (`page.mouse.move(50, 300)`) so the page
 *     stays in the "interacting" state and the rotation timer never
 *     fires. The canvas is masked anyway, but this also stabilizes
 *     any visible "auto-rotate active" UI indicator outside the
 *     canvas.
 *   - Animation freezing: the playwright config sets
 *     `expect.toHaveScreenshot.animations: 'disabled'` so CSS
 *     animations are paused during snapshot capture. This setting
 *     does NOT affect the R3F render loop — the canvas mask handles
 *     that separately.
 *   - Fixed viewport: `viewport: { width: 1280, height: 720 }` is
 *     defined in playwright.config.ts and applies to every project.
 *     Both baselines capture exactly 1280×720 pixels (`fullPage:
 *     false`) — never the scrolled page height, which would vary
 *     with DOM content.
 *
 * ===========================================================================
 * Locator Strategy
 * ===========================================================================
 *
 * The configurator's controls sidebar exposes both ARIA semantics
 * (preferred per ST-006/ST-008/ST-010 accessibility requirements) and
 * `data-testid` fallbacks. This spec uses `.or()`-chained locators so
 * either implementation path resolves cleanly:
 *
 *   page.getByRole('group', { name: /primary color/i })
 *     .or(page.getByTestId('primary-color-picker'))
 *
 * If a control is implemented but neither its accessible name nor its
 * testid matches, the click step fails with a clear error pointing the
 * implementer to add the missing accessor — this protects the test's
 * descriptive failure mode.
 *
 * The current `frontend/src/configurator/controls/colors/PrimaryColorPicker.tsx`
 * implementation provides:
 *
 *   <section aria-label="Primary panel color" data-testid="primary-color-picker">
 *     <ul role="radiogroup" aria-label="Primary panel color swatches">
 *       <li><button role="radio" data-testid="primary-swatch-..." /></li>
 *       …
 *     </ul>
 *   </section>
 *
 * `getByRole('group')` matches neither the `role="region"` outer
 * section nor the `role="radiogroup"` inner ul — but `getByTestId`
 * matches the section. So the `.or()` falls through correctly to the
 * testid path. The pattern selector and finish selector follow the
 * same shape with their respective testids.
 *
 * Within each picker container, swatch buttons are selected by
 * positional index (`.nth(N)`) against the `'[role="radio"], button'`
 * locator. The swatch arrays in
 * `frontend/src/configurator/controls/colors/colorSwatches.ts`,
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`, and
 * `frontend/src/configurator/controls/pattern/finishCatalog.ts` are
 * `Object.freeze()`d in declaration order, so the indices are stable:
 *
 *   - Primary swatches[2] = #FFD400 "Bright yellow" (non-default)
 *   - Pattern[3]          = "spiral"               (non-default)
 *   - Finish[1]           = "glossy"               (non-default)
 *
 * Note: `spiral × glossy` is NOT in DISABLED_COMBINATIONS (only
 * `spiral × metallic` and `star × metallic` are disabled), so the
 * customized-state test's selections are all valid and clickable.
 */

import { test, expect, type Page, type Route, type Request } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper — mockBackendApi(page)
// ---------------------------------------------------------------------------
//
// Single dispatching route handler for `**\/api/**`. Branches are
// ordered MOST-SPECIFIC FIRST so /api/cart and /api/designs are
// matched before the generic fallback. The single-handler design
// avoids the reverse-registration-order ambiguity that overlapping
// `page.route()` glob registrations would otherwise produce
// (Playwright matches routes in REVERSE registration order, so
// splitting these into separate `page.route()` calls would make the
// last-registered glob intercept everything and short-circuit the
// more specific patterns).
//
// The handler always responds with `route.fulfill(...)` — never
// `route.continue()` — because we want the spec to be fully isolated
// from any real backend availability. ST-046-AC5 says tests run
// against locally-started services, but for VISUAL determinism we
// override even reachable backends so a transient slow response
// never invalidates a baseline.
//
// Per Rule R2, the handler does NOT log any request body or header
// content. The `request` parameter is consumed only via its `url()`
// and `method()` accessors. The Authorization header (if any) is
// never inspected, never logged, and never propagated.
//
// Per Rule R3, the handler does NOT validate any bearer token — that
// is firebase-admin's job on the backend. We accept any request
// (authorized or anonymous) and respond with the same deterministic
// fixture so the configurator surface renders identically in either
// case.
async function mockBackendApi(page: Page): Promise<void> {
  // -------------------------------------------------------------------
  // Firebase Auth REST endpoints — block both Identity Toolkit and
  // the Secure Token Service so any background SDK refresh attempt
  // resolves synthetically rather than producing a real network
  // failure. These domains do NOT overlap with `**/api/**`, so
  // registration order is irrelevant for them.
  // -------------------------------------------------------------------
  await page.route('**/identitytoolkit.googleapis.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/securetoken.googleapis.com/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  // -------------------------------------------------------------------
  // Single dispatching handler for every /api/** request. Branches
  // are ordered most-specific first.
  // -------------------------------------------------------------------
  await page.route('**/api/**', async (route: Route, request: Request) => {
    const url = request.url();
    const method = request.method();

    // GET /api/designs (and any ?cursor=… variant) — return an empty
    // saved-design list per ST-028 so the LoadDesignList component
    // (when mounted in the configurator surface) renders a stable
    // empty state instead of a loading spinner or an error.
    if (url.includes('/api/designs') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextCursor: null }),
      });
      return;
    }

    // GET /api/cart — return an empty cart per ST-033-AC3 (an empty
    // cart still returns 200 with an empty representation, never
    // 404). This prevents any startup cart-trigger badge from
    // showing a loading state in the snapshot.
    if (url.includes('/api/cart') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], subtotal: 0, currency: 'USD' }),
      });
      return;
    }

    // Fallback — every other /api/** request resolves to an empty
    // 200 so the SPA does not surface a network error in the
    // snapshot. This intentionally covers any future endpoints not
    // yet characterised; the empty body is conservative.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite — Configurator visual regression
// ---------------------------------------------------------------------------
//
// Two tests, two screenshot baselines. Both share the same beforeEach
// setup (mock install + navigation + canvas-attach wait + idle-rotate
// suppression) and differ only in whether they exercise the controls
// before capturing.

test.describe('Configurator visual regression', () => {
  test.beforeEach(async ({ page }) => {
    // Install the dispatching backend mock BEFORE navigation so the
    // very first /api/** request (likely a startup designs/cart
    // prefetch) is intercepted from frame zero.
    await mockBackendApi(page);

    // Load the SPA — `baseURL` is configured to `http://localhost:5173`
    // in playwright.config.ts (the Vite dev server is auto-started
    // via the `webServer` block in that config).
    await page.goto('/');

    // Wait for the initial load to settle — every first-load fetch
    // (designs list, cart, etc.) resolves through the mock before we
    // start interacting.
    await page.waitForLoadState('networkidle');

    // Wait for the R3F <canvas> to be attached — this is the
    // configurator-mount signal. Every other surface (controls
    // sidebar, design summary sidebar) mounts after the canvas
    // shell. 15 seconds of headroom covers software-WebGL warmup on
    // CI runners (SwiftShader / llvmpipe) where R3F initial mount is
    // ~5× slower than on real GPU hardware.
    await page.waitForSelector('canvas', { state: 'attached', timeout: 15_000 });

    // Park the mouse off the canvas, over the controls sidebar
    // region (x=50, y=300 — well within the left third of the
    // 1280×720 viewport). This keeps the configurator in the
    // "interacting" state so the idle auto-rotation timer never
    // fires during snapshot capture (ST-003). The canvas is masked
    // anyway, but this also stabilizes any "auto-rotate active" UI
    // indicator that lives outside the canvas.
    await page.mouse.move(50, 300);

    // Final settle pass — give any post-mount fetch / hydration
    // work a chance to resolve through the mock before screenshotting.
    await page.waitForLoadState('networkidle');
  });

  test('default state', async ({ page }) => {
    // Capture the configurator surface immediately after mount with
    // the documented store defaults applied. The `mask` array hides
    // every `<canvas>` element from the diff:
    //   - The R3F WebGL canvas (the 3D ball preview).
    //   - Any offscreen Fabric.js canvas that the texture pipeline
    //     may have created (the texture pipeline coordinator in
    //     frontend/src/configurator/texture/texturePipeline.ts may
    //     mount an offscreen canvas — masking is defense-in-depth).
    //
    // `fullPage: false` constrains the capture to the 1280×720
    // viewport defined in playwright.config.ts — never the scrolled
    // page height, which would vary with DOM content.
    await expect(page).toHaveScreenshot('configurator-default.png', {
      mask: [page.locator('canvas')],
      fullPage: false,
    });
  });

  test('customized state', async ({ page }) => {
    // -----------------------------------------------------------------
    // 1) Select a non-default primary color.
    // -----------------------------------------------------------------
    //
    // PRIMARY_COLOR_SWATCHES[2] = #FFD400 "Bright yellow"
    // (PRIMARY_COLOR_SWATCHES[0] is the default #FFFFFF "White").
    //
    // The picker is a <section data-testid="primary-color-picker">
    // containing a <ul role="radiogroup"> of <button role="radio">
    // swatch buttons. The combined selector
    // `[role="radio"], button` matches every swatch button (the
    // section contains no other buttons), and `.nth(2)` selects
    // the third one, indexed from zero.
    const primaryColorPicker = page
      .getByRole('group', { name: /primary color/i })
      .or(page.getByTestId('primary-color-picker'));
    const primarySwatch = primaryColorPicker.first().locator('[role="radio"], button').nth(2);
    await primarySwatch.click();

    // -----------------------------------------------------------------
    // 2) Select a non-default stitching pattern.
    // -----------------------------------------------------------------
    //
    // STITCHING_PATTERNS[3] = "spiral"
    // (STITCHING_PATTERNS[0] is the default "classic").
    //
    // `spiral × glossy` is NOT in DISABLED_COMBINATIONS (only
    // `spiral × metallic` and `star × metallic` are disabled), so
    // the spiral button is enabled and clickable in this sequence.
    const patternSelector = page
      .getByRole('group', { name: /stitching pattern/i })
      .or(page.getByTestId('stitching-pattern-selector'));
    const patternOption = patternSelector.first().locator('[role="radio"], button').nth(3);
    await patternOption.click();

    // -----------------------------------------------------------------
    // 3) Select a non-default material finish.
    // -----------------------------------------------------------------
    //
    // MATERIAL_FINISHES[1] = "glossy"
    // (MATERIAL_FINISHES[0] is the default "matte").
    //
    // After selecting `spiral` above, the `glossy` finish remains
    // enabled because `spiral × glossy` is not disabled. Selecting
    // `metallic` here would land on a disabled combination and the
    // button would be inert; we deliberately stay on `glossy` to
    // exercise an active selection.
    const finishSelector = page
      .getByRole('group', { name: /finish/i })
      .or(page.getByTestId('finish-selector'));
    const finishOption = finishSelector.first().locator('[role="radio"], button').nth(1);
    await finishOption.click();

    // -----------------------------------------------------------------
    // 4) Allow the texture pipeline to settle.
    // -----------------------------------------------------------------
    //
    // The C6/R7-compliant texture coordinator
    // (frontend/src/configurator/texture/texturePipeline.ts) calls
    // `fabricCanvas.renderAll()` first and only then sets
    // `threeTexture.needsUpdate = true`. The pipeline runs
    // asynchronously after each control change. Waiting for
    // `networkidle` is the simplest way to confirm there are no
    // in-flight fetches that could mutate the DOM mid-snapshot;
    // animations are already disabled by playwright.config.ts.
    await page.waitForLoadState('networkidle');

    // -----------------------------------------------------------------
    // 5) Capture the customized-state baseline.
    // -----------------------------------------------------------------
    //
    // Same masking strategy as the default-state capture: every
    // `<canvas>` is masked because WebGL output varies across
    // rasterizers. The DOM around the canvas (controls sidebar with
    // updated selected-state markers, summary sidebar with updated
    // values) is what this baseline meaningfully captures.
    await expect(page).toHaveScreenshot('configurator-customized.png', {
      mask: [page.locator('canvas')],
      fullPage: false,
    });
  });
});
