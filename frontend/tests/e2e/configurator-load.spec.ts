/**
 * Configurator load end-to-end flow — Playwright spec.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 ("New Files to Create — Frontend"):
 *       "frontend/tests/e2e/*.spec.ts | Critical flows ... (ST-045)".
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "frontend/tests/e2e/*.spec.ts | Critical flow ... (ST-045);
 *        Chromium + WebKit projects".
 *   - ST-045-AC1 (the AC source of truth per Rule R1):
 *       "The end-to-end suite ... exercises at least the configurator
 *        load, color selection, save-design, load-design, and order
 *        creation flows against running services."
 *   - ST-045-AC4: the suite runs in the local development environment
 *     against locally-started services so developers can reproduce
 *     failures without remote access.
 *   - ST-001 (Render Initial Sphere Preview on Configurator Load):
 *       AC1 — Opening the configurator displays a three-dimensional
 *             spherical ball centered in the preview area within the
 *             documented initial-load budget.
 *       AC2 — The ball renders with the documented default visual
 *             state (default panel colors, default stitching pattern,
 *             default finish) before any user selection is made.
 *       AC3 — Resizing the browser window re-centers the ball and
 *             keeps it fully visible without distortion or clipping.
 *       AC4 — The initial render cycle completes without producing
 *             visible artifacts or console-level error output.
 *   - ST-005 (Performance Budget): initial sphere render ≤2000 ms;
 *     sustained ≥30 FPS during drag rotation. (Strict performance
 *     assertions live in `frontend/tests/performance/`; this spec
 *     uses a generous CI-friendly bound to catch catastrophic
 *     regressions only.)
 *   - ST-022-AC1 (Design Summary Sidebar): the summary panel displays
 *     primary color, secondary color, accent color, stitching pattern,
 *     material finish, and logo state in human-readable form.
 *
 * ===========================================================================
 * What this spec validates
 * ===========================================================================
 *
 * The configurator-load slice of ST-045-AC1 — the FIRST of the five
 * mandated critical user flows. The spec is deliberately the simplest
 * end-to-end test in the suite:
 *
 *   1. The page loads at the root URL `/` without throwing.
 *   2. The 3D `<canvas>` element attaches within a generous CI-safe
 *      budget (15 s) — this catches catastrophic regressions while
 *      leaving strict ≤2000 ms enforcement to `tests/performance/`.
 *   3. The configurator UI renders the three documented regions:
 *      top region (header / future navigation), left control sidebar
 *      (proxy: primary color picker visible), and right summary
 *      sidebar.
 *   4. The default design selections are reflected in the summary
 *      sidebar — labeled rows for primary color, stitching pattern,
 *      and material finish exist (default values per ST-001-AC2).
 *   5. NO console errors are emitted during initial render
 *      (ST-001-AC4 — the explicit acceptance criterion).
 *   6. After a viewport resize, the canvas remains attached
 *      (ST-001-AC3 — re-centering is verified by the visual
 *      regression suite; here we only assert no detach-on-resize
 *      regression).
 *
 * No authentication. No backend API calls. No UI mutations beyond
 * navigation and a viewport resize. The spec is therefore the cleanest
 * smoke check for "does the configurator render at all".
 *
 * ===========================================================================
 * The "no auth, no backend" architecture, in brief
 * ===========================================================================
 *
 * Per ST-001, the configurator renders defaults BEFORE any user
 * selection — i.e., the page is reachable anonymously. Concretely:
 *
 *   - The spec performs NO sign-up / sign-in.
 *   - The spec performs NO Authorization: Bearer header injection.
 *   - The spec issues NO HTTP requests except those the SPA itself
 *     fires on its own.
 *
 * This means the spec runs successfully against ANY environment that
 * provides the Vite dev server at http://localhost:5173. The backend,
 * Postgres, Firebase Auth Emulator, and fake-gcs-server are all
 * OPTIONAL. The Playwright `webServer` block in
 * `frontend/playwright.config.ts` auto-starts the Vite dev server, so
 * `npx playwright test tests/e2e/configurator-load.spec.ts` works
 * standalone without any external dependencies.
 *
 * ===========================================================================
 * Defensive locator strategy
 * ===========================================================================
 *
 * The spec uses chained `.or(...)` locators so it survives reasonable
 * implementation refactors. This matches the approach used in the
 * sibling `color-selection.spec.ts` and `critical-path-full.spec.ts`
 * specs.
 *
 * Top region — three-arm chain:
 *   1. `getByRole('navigation')`  — preferred semantic anchor for a
 *       future top-of-page navigation bar (e.g., once the
 *       NewDesignDialog / LoadDesignList / ShareDesignAction CTAs
 *       per AAP §0.6.7 + §0.6.9 are surfaced).
 *   2. `getByTestId('top-navigation')` — pragmatic fallback that
 *       matches a likely future testid convention.
 *   3. `getByRole('banner')` — matches the CURRENT implementation's
 *       `<header role="banner">` shell in `frontend/src/App.tsx`. This
 *       arm is load-bearing today; the first two arms are forward
 *       compatibility.
 *
 * Primary color picker (proxy for "control sidebar rendered") —
 *   1. `getByRole('group', { name: /primary color/i })` — the
 *       preferred ARIA-first selector. The current implementation
 *       uses `<section aria-label="Primary panel color">` whose
 *       implicit ARIA role is `region`, NOT `group`, so this
 *       attempt does NOT match in production today. It is retained
 *       for future-compatibility: a refactor moving the picker into
 *       a `<fieldset role="group">` would still satisfy this spec.
 *   2. `getByTestId('primary-color-picker')` — the load-bearing
 *       data-testid fallback. The current implementation in
 *       `frontend/src/configurator/controls/colors/PrimaryColorPicker.tsx`
 *       sets exactly this attribute.
 *
 * Summary sidebar —
 *   1. `getByRole('region', { name: /design summary|summary/i })` —
 *       preferred. The current `<aside role="complementary"
 *       aria-label="Current design summary">` does NOT match
 *       (`complementary` ≠ `region`); retained for future
 *       compatibility.
 *   2. `getByTestId('design-summary-sidebar')` — the load-bearing
 *       fallback. The current `<aside data-testid=
 *       "design-summary-sidebar">` matches directly.
 *
 * Per-field labels inside the summary sidebar use a four-arm chain:
 *   1. visible text matching the broadened regex (e.g.
 *      `/primary( color)?/i` matches both "Primary" — the current
 *      label — and "Primary color" — a possible future label).
 *   2. `data-testid="summary-row-<field>"` — the current row testid
 *      attached in `App.tsx`'s SummaryRow component.
 *   3. `data-testid="summary-value-<field>"` — the current value
 *      cell testid.
 *   4. `data-testid="summary-<field>-color"` / `summary-<field>` — a
 *      hypothetical future testid naming convention named in the
 *      original AAP agent prompt.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO browser-developer-tools logger invocations from the test
 *     process side. The `page.on('console', ...)` listener SUBSCRIBES
 *     to events emitted BY THE BROWSER and buffers them for assertion;
 *     the test process itself never WRITES to the runner's stdout.
 *     The error array is read once in the final `expect(...)
 *     .toHaveLength(0)` assertion — Playwright's reporter renders the
 *     assertion failure message; nothing in this file calls any
 *     stdout-writing method. The ESLint config enforces
 *     `no-console: error` and the workspace lint gate runs with
 *     `--max-warnings 0`, so any inadvertent stdout call would block
 *     CI immediately.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import any backend-only auth library, does NOT mint or
 *     verify any JWT, does NOT invoke any token-verification helper.
 *     The disallowed identifiers (firebase admin SDK package, the
 *     three named JWT libraries from the AAP §0.4.1 forbidden list)
 *     are NOT imported anywhere in this file. Verifiable by inspecting
 *     the import block at the top of this module — `@playwright/test`
 *     is the SOLE import.
 *   - Rule R7 / C6 (Fabric → Three texture order): not directly
 *     exercised by this spec (no swatch clicks). The collected error
 *     buffers catch any texture-pipeline crash that emits an error
 *     during initial mount.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no payment-processor imports, no settlement logic, no order
 *     finalization references. Verifiable by inspecting the imports
 *     and string literals — nothing in this spec interacts with any
 *     payment SDK, gateway, or money-handling routine.
 *
 * ===========================================================================
 * Test environment
 * ===========================================================================
 *
 *   - Playwright config (frontend/playwright.config.ts):
 *       - viewport 1280×720
 *       - baseURL http://localhost:5173
 *       - projects: chromium + webkit (this spec runs on BOTH per
 *         AAP §0.6.12 — no `test.skip(({ browserName }) => ...)`).
 *       - per-test timeout 60s — adequate for software-WebGL
 *         (SwiftShader / llvmpipe) cold starts on CI.
 *   - The webServer block auto-starts `npm run dev` and waits up to
 *     120s for http://localhost:5173 to respond.
 */

import { test, expect, type ConsoleMessage } from '@playwright/test';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Configurator load flow', () => {
  // -------------------------------------------------------------------------
  // Test 1: full load surface — canvas, controls, summary, no console error
  // -------------------------------------------------------------------------
  //
  // This is the headline test for ST-001 + ST-045-AC1's first mandated
  // flow. It validates the entire load surface in one sweep:
  //
  //   1. Subscribe to `console` and `pageerror` events BEFORE navigating
  //      so we capture every error emitted from the very first byte of
  //      script execution onward (ST-001-AC4's "initial render cycle"
  //      includes script bootstrap, not just visible mount).
  //   2. Navigate, wait for networkidle, assert the canvas attaches.
  //   3. Walk the three regions (top, control, summary) using defensive
  //      `.or()`-chained locators with three- or four-arm fallbacks.
  //   4. Walk the three summary fields (color label, pattern label,
  //      finish label) — assert each is reachable inside the summary
  //      sidebar via either visible text OR one of multiple testid
  //      fallbacks.
  //   5. Resize to a smaller viewport, assert the canvas remains
  //      attached, then restore the configured default.
  //   6. Assert NO console errors and NO page errors were observed
  //      during the entire flow.
  //
  // The error-collection arrays are deliberately kept inside the
  // `test()` closure (NOT module-scope) so each test run starts with
  // a fresh empty buffer.
  test('configurator loads with canvas, controls, and default summary', async ({ page }) => {
    // ----- Console error detection -----
    // Buffer console errors observed during page lifecycle. Per
    // ST-001-AC4, the initial render must NOT emit console-level error
    // output. We collect errors WITHOUT re-emitting them (Rule R2 —
    // the test runner process never writes to its own stdout). The
    // buffered strings appear in the assertion's failure message via
    // `consoleErrors.join(' | ')` so the developer sees what fired
    // without us invoking any stdout-writing helper from this file.
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Buffer page errors (uncaught exceptions and unhandled promise
    // rejections that bubble to the browser's "page error" surface).
    // Some errors don't reach the developer-tools error stream because
    // they're thrown synchronously during render or rejected from a
    // top-level `useEffect` — the `pageerror` listener catches these.
    const pageErrors: Error[] = [];
    page.on('pageerror', (error: Error) => {
      pageErrors.push(error);
    });

    // ----- Navigate to the configurator root -----
    // Playwright resolves '/' against `baseURL: 'http://localhost:5173'`
    // configured in `frontend/playwright.config.ts`. The Vite dev
    // server is auto-started by the `webServer` block in that config;
    // this spec does NOT depend on the backend, Postgres, or any
    // emulator being up.
    await page.goto('/');
    // `networkidle` ensures all initial Vite-served module imports
    // (React, R3F, Three, Fabric, Zustand, etc.) have completed their
    // network round-trips before we start asserting on the DOM.
    await page.waitForLoadState('networkidle');

    // ----- Verify canvas attaches (ST-001-AC1, ST-005 budget) -----
    // We use `state: 'attached'` (NOT `'visible'`) because R3F may
    // briefly render a 0×0 canvas during initial layout before the
    // WebGL context allocates a real drawing buffer; the "attached"
    // state guarantees the element exists without coupling to its
    // dimensions.
    //
    // The 15-second timeout is generous on purpose — the production
    // budget per ST-005 is ≤2000 ms but software-rendered WebGL
    // (SwiftShader / llvmpipe) on sandboxed CI runners can take
    // 5×–10× longer than real GPU hardware. Strict ≤2000 ms
    // enforcement lives in `frontend/tests/performance/`.
    //
    // `canvas.first()` defends against environments where Fabric.js
    // creates an offscreen canvas in addition to R3F's primary canvas;
    // we only need to verify ANY canvas is attached.
    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 15_000 });
    await expect(canvas).toBeAttached();

    // ----- Verify the three-region layout exists (ST-001-AC1) -----
    //
    // Top region. Three-arm chain accommodates:
    //   - `<nav role="navigation">` (a hypothetical future top nav bar
    //     when LoadDesignList / ShareDesignAction etc. are surfaced),
    //   - `data-testid="top-navigation"` (a reasonable future testid),
    //   - `<header role="banner">` (the CURRENT App.tsx shell).
    const topNav = page
      .getByRole('navigation')
      .or(page.getByTestId('top-navigation'))
      .or(page.getByRole('banner'));
    await topNav.first().waitFor({ state: 'visible', timeout: 5_000 });

    // Left control sidebar (proxied by primary color picker visible).
    // The current implementation uses `<section aria-label="Primary
    // panel color" data-testid="primary-color-picker">` whose
    // implicit ARIA role is `region`, NOT `group`, so the role-based
    // arm does not match today; the testid arm is load-bearing.
    const primaryColorPicker = page
      .getByRole('group', { name: /primary color/i })
      .or(page.getByTestId('primary-color-picker'));
    await primaryColorPicker.first().waitFor({ state: 'visible', timeout: 10_000 });

    // Right summary sidebar (ST-022). Same dual-strategy: the current
    // `<aside role="complementary" data-testid="design-summary-sidebar">`
    // is matched by the testid arm; the role arm is forward
    // compatibility.
    const summarySidebar = page
      .getByRole('region', { name: /design summary|summary/i })
      .or(page.getByTestId('design-summary-sidebar'));
    await summarySidebar.first().waitFor({ state: 'visible', timeout: 5_000 });
    await expect(summarySidebar.first()).toBeVisible();

    // ----- Verify default design selections are reflected -----
    // (ST-001-AC2 + ST-022-AC1 — labels exist in the summary sidebar.)
    //
    // Per `frontend/src/state/configuratorStore.ts` defaults and the
    // SummaryRow component in `frontend/src/App.tsx`, the summary
    // sidebar renders six rows labeled "Primary", "Secondary",
    // "Accent", "Pattern", "Finish", "Logo". The default rendering
    // uses these short labels with CSS-driven visual uppercasing —
    // the underlying text is mixed-case.
    //
    // Rather than asserting specific values (which would couple the
    // test to a particular hex/text representation), we assert the
    // labeled ROWS exist. Detailed field-level semantic checks belong
    // to ST-022-specific unit/integration tests, not the e2e suite.
    //
    // Each row locator uses a four-arm chain:
    //   - visible text matching the field label (broadened to match
    //     both the current short label "Primary" and a hypothetical
    //     future longer label "Primary color"),
    //   - `data-testid="summary-row-<field>"` (current row testid),
    //   - `data-testid="summary-value-<field>"` (current value-cell
    //     testid), and
    //   - `data-testid="summary-<field>-color"` or
    //     `data-testid="summary-<field>"` (a future-friendly alias
    //     named in the original AAP agent prompt).
    const summaryItems = summarySidebar.first();

    // Color label — verifies the primary color row is reachable.
    // /primary( color)?/i matches the current "Primary" label as
    // well as a future "Primary color" label.
    const colorLabel = summaryItems
      .getByText(/primary( color)?/i)
      .or(summaryItems.getByTestId('summary-row-primary'))
      .or(summaryItems.getByTestId('summary-value-primary'))
      .or(summaryItems.getByTestId('summary-primary-color'));
    await expect(colorLabel.first()).toBeVisible({ timeout: 5_000 });

    // Pattern label — /stitching pattern|pattern/i matches both the
    // current "Pattern" label and a future "Stitching pattern" label.
    const patternLabel = summaryItems
      .getByText(/stitching pattern|pattern/i)
      .or(summaryItems.getByTestId('summary-row-pattern'))
      .or(summaryItems.getByTestId('summary-value-pattern'))
      .or(summaryItems.getByTestId('summary-pattern'));
    await expect(patternLabel.first()).toBeVisible({ timeout: 5_000 });

    // Finish label — /finish/i matches the current "Finish" label
    // and any reasonable variant.
    const finishLabel = summaryItems
      .getByText(/finish/i)
      .or(summaryItems.getByTestId('summary-row-finish'))
      .or(summaryItems.getByTestId('summary-value-finish'))
      .or(summaryItems.getByTestId('summary-finish'));
    await expect(finishLabel.first()).toBeVisible({ timeout: 5_000 });

    // ----- Verify viewport resize does not detach canvas -----
    // (ST-001-AC3 — partial validation. Full re-centering correctness
    // is enforced by the visual regression suite under
    // `frontend/tests/visual/`. Here we assert only that the canvas
    // does NOT detach as a side effect of the resize, which catches
    // a regression where a faulty React effect cleanup unmounts the
    // canvas on viewport change.)
    //
    // Resize to 1024×768 (a common laptop breakpoint), wait for
    // networkidle (lets R3F's resize observer + frame loop settle),
    // and re-assert the canvas remains attached.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForLoadState('networkidle');
    await expect(canvas).toBeAttached();

    // Restore the configured default viewport (1280×720 per
    // playwright.config.ts) so any subsequent test (or visual
    // regression run sharing this page lifecycle) sees the
    // documented baseline size.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForLoadState('networkidle');
    await expect(canvas).toBeAttached();

    // ----- Final assertion: ST-001-AC4 no console error output -----
    // The initial render cycle MUST complete without console errors.
    // We assert AFTER all UI checks so any post-mount errors triggered
    // by the resize cycle are also captured.
    //
    // The custom assertion message includes the buffered errors so
    // that the developer can immediately see WHAT fired without
    // having to re-run the test with verbose Playwright output.
    expect(
      consoleErrors,
      `Configurator emitted console error(s) during initial render: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);

    expect(
      pageErrors,
      `Configurator emitted page error(s) during initial render: ${pageErrors
        .map((e) => e.message)
        .join(' | ')}`,
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: load completes within reasonable bound (timing sanity check)
  // -------------------------------------------------------------------------
  //
  // A simpler timing-oriented sanity check separate from the dedicated
  // `frontend/tests/performance/` suite (which enforces ST-005's
  // strict ≤2000 ms initial-load budget on hardware-accelerated
  // GPU runs). This e2e bound is intentionally loose enough to survive
  // software-WebGL cold starts on CI under heavy parallel load but
  // tight enough to catch a runaway hang or infinite loop during
  // initial mount.
  //
  // Splitting this from Test 1 makes the test report more precise
  // on failure: if Test 1 fails on a console-error assertion but
  // Test 2 passes, the developer immediately knows the load completed
  // successfully but emitted a stray error log.
  //
  // Choice of 30_000 ms bound:
  //   - The canvas `waitFor` timeout is 15_000 ms. Setting the
  //     assertion bound EQUAL to the waitFor timeout creates a race:
  //     if waitFor takes the full 15 s, the surrounding `goto` and
  //     `networkidle` overhead pushes elapsedMs over 15_000 by a few
  //     hundred milliseconds, producing a spurious failure.
  //   - 30_000 ms gives a comfortable margin above the 15 s waitFor
  //     timeout while still being 15× the strict ST-005 production
  //     budget — a regression that pushes load above 30 s is
  //     definitionally catastrophic (15× over budget) and the
  //     dedicated performance suite catches anything less.
  //   - Playwright's per-test timeout (60_000 ms in the playwright
  //     config) sits comfortably above this bound, so a hung test
  //     fails on the per-test timeout, not the assertion — the
  //     assertion only fails on actual measurable slowness.
  test('configurator load completes within reasonable bound', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'attached', timeout: 15_000 });

    const elapsedMs = Date.now() - startTime;

    // ST-005 documented production budget is ≤2000 ms initial sphere
    // render. CI cold-start overhead and software-WebGL contention
    // can dominate that budget by an order of magnitude; we use a
    // generous 30_000 ms as the E2E sanity bound — well above the
    // 15_000 ms canvas waitFor timeout to leave headroom for
    // `goto` + `networkidle` overhead, and 15× over the production
    // budget so a true catastrophic regression is still caught. The
    // strict ≤2000 ms budget enforcement lives in
    // frontend/tests/performance/budget.spec.ts.
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
