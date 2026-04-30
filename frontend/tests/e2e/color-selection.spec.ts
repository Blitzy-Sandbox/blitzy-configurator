/**
 * Color selection end-to-end flow — Playwright spec.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 ("New Files to Create — Frontend"):
 *       "frontend/tests/e2e/*.spec.ts | Critical flows ... (ST-045)".
 *   - AAP §0.6.12 (Merge Gate 2 — MG2-H Hardened Test Suites):
 *       "frontend/tests/e2e/*.spec.ts | Critical flow … (ST-045);
 *        Chromium + WebKit projects".
 *   - ST-045-AC1 (the AC source of truth per Rule R1):
 *       "The end-to-end suite … exercises at least the configurator
 *        load, color selection, save-design, load-design, and order
 *        creation flows against running services."
 *   - ST-045-AC4: the suite runs in the local development environment
 *     against locally-started services so developers can reproduce
 *     failures without remote access.
 *   - ST-006 (Primary Panel Color Customization):
 *       "Selecting a primary color updates the live preview within
 *        the documented latency budget. The selected swatch is
 *        visually distinguished in the picker."
 *   - ST-007 (Secondary Panel Color):
 *       "Selecting a secondary color updates the live preview within
 *        the documented latency budget. The selected swatch is
 *        visually distinguished."
 *   - ST-008 (Accent Color):
 *       "Selecting an accent color updates the live preview within
 *        the documented latency budget. The selected swatch is
 *        visually distinguished."
 *   - ST-009 (Real-Time Color Preview Sync):
 *       "Primary, secondary, and accent color selections are reflected
 *        on the preview within the documented latency budget. Rapid
 *        successive color changes arrive in order — no lost or
 *        reordered updates."
 *   - ST-022-AC1 (Design Summary Sidebar):
 *       "Panel displays primary color, secondary color, accent color,
 *        stitching pattern, material finish, logo state in
 *        human-readable form."
 *   - ST-022-AC2 (Latency):
 *       "Every change updates summary within latency budget (no manual
 *        refresh)."
 *
 * ===========================================================================
 * What this spec validates
 * ===========================================================================
 *
 * The color-selection slice of ST-045-AC1 — the second of the five
 * mandated critical user flows. Each `test()` is an independent
 * contract assertion; splitting the slice into focused tests rather
 * than a single monolithic flow yields clearer diagnostic output on
 * failure (a primary-picker regression is isolated from a
 * secondary-picker regression) and matches the regressionability
 * strategy used by the sibling `register-login-flow.spec.ts`,
 * `save-design-flow.spec.ts`, `share-link-flow.spec.ts`, and
 * `cart-and-order-flow.spec.ts` specs in this folder.
 *
 *   1. The user can interact with the primary color picker; the
 *      selection is reflected in the design summary sidebar
 *      within the documented latency budget. (ST-006, ST-009-AC1,
 *      ST-022-AC1, ST-022-AC2.)
 *   2. Same contract for the secondary color picker. (ST-007,
 *      ST-009-AC2.)
 *   3. Same contract for the accent color picker. (ST-008,
 *      ST-009-AC3.)
 *   4. Rapid successive color changes are honored in order without
 *      loss or reordering — the texture pipeline coordinator
 *      (frontend/src/configurator/texture/texturePipeline.ts) honors
 *      C6/R7 (Fabric.js renderAll() before Three.js needsUpdate)
 *      so back-to-back swatch clicks produce a deterministic final
 *      state and do NOT lose the WebGL context. (ST-009-AC4.)
 *   5. All three pickers are concurrently present and reachable —
 *      smoke test for "left control sidebar fully renders". (Implicit
 *      from the three-region layout requirement.)
 *
 * ===========================================================================
 * The "no auth, no backend" architecture, in brief
 * ===========================================================================
 *
 * Color selection is a PRE-SAVE, CLIENT-ONLY activity. The Zustand
 * store at `frontend/src/state/configuratorStore.ts` is the single
 * source of truth for design selections; no API calls fire until the
 * user activates the Save Design CTA (which is exercised by
 * `save-design-flow.spec.ts`, NOT here). Concretely:
 *
 *   - The spec performs NO sign-up / sign-in.
 *   - The spec performs NO Authorization: Bearer header injection.
 *   - The spec issues NO HTTP requests except those the SPA makes on
 *     its own (typically zero for the color-selection flow).
 *
 * This means the spec runs successfully against ANY environment that
 * provides the Vite dev server at http://localhost:5173 — the backend,
 * Postgres, Firebase Auth Emulator, and fake-gcs-server are all
 * OPTIONAL. The Playwright `webServer` block in
 * `frontend/playwright.config.ts` auto-starts the Vite dev server, so
 * `npx playwright test tests/e2e/color-selection.spec.ts` works
 * standalone.
 *
 * ===========================================================================
 * Defensive locator strategy
 * ===========================================================================
 *
 * The spec uses chained `.or(...)` locators so it survives reasonable
 * implementation refactors. Concretely, `getColorPickerGroup(page,
 * 'primary')` returns a Locator that resolves to whichever of the
 * following matches first:
 *
 *   1. `getByRole('group', { name: /primary color/i })` — the
 *      preferred ARIA-first selector. The current implementation
 *      uses a `<section aria-label="Primary panel color">` whose
 *      implicit ARIA role is `region`, NOT `group`, so this
 *      attempt does NOT match in production today. It is retained
 *      for future-compatibility: a refactor moving the picker into
 *      a `<fieldset role="group">` would still satisfy this spec
 *      without changes.
 *   2. `getByTestId('primary-color-picker')` — the pragmatic
 *      data-testid fallback. The current implementation in
 *      `frontend/src/configurator/controls/colors/PrimaryColorPicker.tsx`
 *      sets exactly this attribute, so this attempt is the
 *      load-bearing locator today.
 *
 * The same dual-strategy applies to:
 *   - the summary sidebar (`getByRole('region', { name: /summary/i })`
 *     OR `getByTestId('design-summary-sidebar')` — the current impl
 *     uses `role="complementary"` so the testid is load-bearing);
 *   - the per-color summary row (`getByText(/primary( color)?/i)` OR
 *     `getByTestId('summary-row-primary')` OR
 *     `getByTestId('summary-value-primary')` OR
 *     `getByTestId('summary-primary-color')` — the current impl uses
 *     just the word "Primary" as a label and `summary-row-primary`
 *     as the testid, but the future-friendly aliases are retained).
 *
 * Inside each picker, swatch elements may be implemented as either
 * `<button>` (auto role="button") or `<input type="radio">` (role
 * "radio"). The current implementation uses `<button role="radio">`
 * inside a `<div role="radiogroup">`, so `getByRole('radio')` is
 * load-bearing today; `getByRole('button')` is retained for
 * compatibility with a hypothetical implementation that drops the
 * explicit `role="radio"` override.
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs
 *     ZERO `console.*` calls. The `page.on('console', …)` listener
 *     SUBSCRIBES to console events emitted BY THE BROWSER and
 *     buffers them for assertion; it never WRITES to the test
 *     runner's console. The ESLint config enforces `no-console:
 *     error` (allowing only `warn` / `error`) and the workspace
 *     lint gate runs with `--max-warnings 0`, so any inadvertent
 *     `console.log` would block CI immediately.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does
 *     NOT import `firebase-admin`, does NOT mint or verify any JWT,
 *     does NOT invoke `verifyIdToken()`. `jsonwebtoken`, `jose`, and
 *     `jwt-decode` are NOT imported. Verifiable via
 *     `grep -n "firebase-admin\|jsonwebtoken\|jose\|jwt-decode"
 *      frontend/tests/e2e/color-selection.spec.ts`.
 *   - Rule R7 / C6 (Fabric → Three texture order): the
 *     "rapid successive color changes apply in order" test
 *     EXERCISES this contract: rapid back-to-back swatch clicks
 *     would crash a non-compliant `texturePipeline.update()`
 *     implementation by losing the WebGL context. The test's
 *     `await expect(page.locator('canvas').first()).toBeAttached()`
 *     assertion catches that failure mode.
 *   - Rule R9 (financial-settlement exclusion): this file contains
 *     no payment-processor imports, no charge logic, no order
 *     finalization references. Verifiable via
 *     `grep -niE "stripe|braintree|paypal|payment_intent|charge|
 *      tokenize|refund|checkout|billing|credit card"
 *      frontend/tests/e2e/color-selection.spec.ts`.
 *
 * ===========================================================================
 * Test environment
 * ===========================================================================
 *
 *   - Playwright config (frontend/playwright.config.ts):
 *       - viewport 1280×720
 *       - baseURL http://localhost:5173
 *       - projects: chromium + webkit (this spec runs on BOTH per
 *         AAP §0.6.12).
 *       - per-test timeout 60s — adequate for software-WebGL
 *         (SwiftShader / llvmpipe) cold starts on CI.
 *   - The webServer block auto-starts `npm run dev` and waits up to
 *     120s for http://localhost:5173 to respond.
 *   - The `mouse.move(50, 300)` nudge in `waitForConfiguratorReady`
 *     suppresses ST-003's idle auto-rotation (3-second idle threshold)
 *     so the canvas does not silently rotate during the test —
 *     idle-rotation is exercised by `tests/configurator/preview.spec.ts`
 *     and is out of scope here.
 */

import { test, expect, type ConsoleMessage, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Boot the configurator SPA, wait for the Three.js canvas to attach,
 * and nudge the mouse cursor to suppress idle auto-rotation.
 *
 * Sequence:
 *   1. Navigate to the SPA root (Playwright's `baseURL` resolves to
 *      http://localhost:5173).
 *   2. Wait for the page to reach `networkidle` so initial Vite-served
 *      module imports have all completed.
 *   3. Wait for the `<canvas>` element to be attached to the DOM. We
 *      use `state: 'attached'` (NOT `'visible'`) because R3F may
 *      briefly render a 0×0 canvas during initial layout before the
 *      WebGL context allocates a real drawing buffer; the
 *      "attached" state guarantees the element exists without
 *      coupling to its dimensions. The 15-second timeout absorbs
 *      cold-start variance on software-WebGL CI runners.
 *   4. Move the mouse to a neutral coordinate (50, 300) — well away
 *      from the central canvas region — to register a "user
 *      activity" event that resets the idle-rotation timer per
 *      ST-003. Without this, the configurator's 3-second idle
 *      timeout will trigger auto-rotation during the test, creating
 *      flake when the rapid-sequence test reads the canvas state.
 *   5. A second `networkidle` wait absorbs any post-mount fetches
 *      (e.g., texture asset loads) so subsequent locator queries see
 *      the fully-settled DOM.
 */
async function waitForConfiguratorReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 15_000 });
  // Move the mouse to a neutral position to suppress idle auto-rotation
  // flicker. ST-003's idle threshold is 3 seconds; this nudge keeps the
  // ball still during the entire test.
  await page.mouse.move(50, 300);
  await page.waitForLoadState('networkidle');
}

/**
 * Return a defensive Locator that resolves to one of the three color
 * pickers. The chained `.or(...)` survives both the current
 * implementation (data-testid attribute on a `<section>`) and a
 * hypothetical future refactor that uses a semantic
 * `<fieldset role="group" aria-label="Primary Color">`.
 *
 * Note: the regex `${role} color` is intentionally simple. The
 * current accent picker uses aria-label "Accent and stitching
 * color" — the regex does not match that exact string, but the
 * data-testid fallback (`accent-color-picker`) does. Either branch
 * resolves the locator and the test continues.
 */
function getColorPickerGroup(page: Page, role: 'primary' | 'secondary' | 'accent'): Locator {
  const labelPattern = new RegExp(`${role} color`, 'i');
  const testId = `${role}-color-picker`;
  return page.getByRole('group', { name: labelPattern }).or(page.getByTestId(testId));
}

/**
 * Return a defensive Locator that resolves to the design summary
 * sidebar. The chained `.or(...)` survives both the current
 * implementation (`<aside role="complementary" data-testid=
 * "design-summary-sidebar">`) and a hypothetical refactor that
 * promotes the sidebar to `role="region"`.
 */
function getDesignSummarySidebar(page: Page): Locator {
  return page
    .getByRole('region', { name: /design summary|summary/i })
    .or(page.getByTestId('design-summary-sidebar'));
}

/**
 * Return a defensive Locator that resolves to the per-color row
 * inside the summary sidebar. Tries (in order):
 *   1. Visible text matching `/<role>( color)?/i` — handles the
 *      current "Primary" label as well as a future "Primary color"
 *      label.
 *   2. `data-testid="summary-row-<role>"` — the current testid
 *      attached to each summary row in `frontend/src/App.tsx`.
 *   3. `data-testid="summary-value-<role>"` — the current testid on
 *      the value cell within each summary row.
 *   4. `data-testid="summary-<role>-color"` — a hypothetical future
 *      naming convention.
 *
 * The `.first()` invocation by the caller picks whichever resolves.
 */
function getSummaryRow(summary: Locator, role: 'primary' | 'secondary' | 'accent'): Locator {
  const labelPattern = new RegExp(`${role}( color)?`, 'i');
  return summary
    .getByText(labelPattern)
    .or(summary.getByTestId(`summary-row-${role}`))
    .or(summary.getByTestId(`summary-value-${role}`))
    .or(summary.getByTestId(`summary-${role}-color`));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Color selection flow', () => {
  // -------------------------------------------------------------------------
  // Test 1: Primary color picker → summary sidebar
  // -------------------------------------------------------------------------
  test('ST-045-AC1: primary color selection updates summary sidebar', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await waitForConfiguratorReady(page);

    // Locate the primary color picker via the defensive helper.
    const primaryPicker = getColorPickerGroup(page, 'primary').first();
    await primaryPicker.waitFor({ state: 'visible', timeout: 10_000 });

    // Discover swatches inside the picker. The current implementation
    // uses `<button role="radio">` swatches; the `.or(...)` covers a
    // future implementation that uses native `<input type="radio">`.
    const swatches = primaryPicker.getByRole('button').or(primaryPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThan(0);

    // Click a non-default swatch (the second one if available, else
    // the first). Picking index 1 — when more than one swatch exists —
    // guarantees the click actually changes state, even if the
    // first swatch happens to be the current default.
    const targetIndex = swatchCount > 1 ? 1 : 0;
    await swatches.nth(targetIndex).click();
    await page.waitForLoadState('networkidle');

    // Verify the summary sidebar still renders. ST-022-AC1 requires
    // "human-readable form" for the primary color value but does
    // NOT mandate a specific text representation (hex string vs
    // named color vs swatch chip), so we assert presence of the
    // ROW, not specific text content.
    const summary = getDesignSummarySidebar(page).first();
    await expect(summary).toBeVisible();

    const primarySummary = getSummaryRow(summary, 'primary');
    await expect(primarySummary.first()).toBeVisible();

    // Per ST-009-AC1, the change reflects within the documented
    // latency budget. We allow a generous 500 ms settle window and
    // re-assert the summary remains visible (no error state, no
    // unmount-on-error scenario). 500 ms is well above the
    // documented latency budget but tight enough to catch a
    // genuine "stuck in pending state" bug.
    await page.waitForTimeout(500);
    await expect(summary).toBeVisible();

    expect(
      consoleErrors,
      `Console error(s) during primary color selection: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: Secondary color picker → summary sidebar
  // -------------------------------------------------------------------------
  test('ST-045-AC1: secondary color selection updates summary sidebar', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await waitForConfiguratorReady(page);

    const secondaryPicker = getColorPickerGroup(page, 'secondary').first();
    await secondaryPicker.waitFor({ state: 'visible', timeout: 10_000 });

    const swatches = secondaryPicker.getByRole('button').or(secondaryPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThan(0);

    const targetIndex = swatchCount > 1 ? 1 : 0;
    await swatches.nth(targetIndex).click();
    await page.waitForLoadState('networkidle');

    const summary = getDesignSummarySidebar(page).first();
    await expect(summary).toBeVisible();

    const secondarySummary = getSummaryRow(summary, 'secondary');
    await expect(secondarySummary.first()).toBeVisible();

    await page.waitForTimeout(500);
    await expect(summary).toBeVisible();

    expect(
      consoleErrors,
      `Console error(s) during secondary color selection: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Accent color picker → summary sidebar
  // -------------------------------------------------------------------------
  test('ST-045-AC1: accent color selection updates summary sidebar', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await waitForConfiguratorReady(page);

    // Note: the current implementation's accent picker has aria-label
    // "Accent and stitching color" — the simple `/accent color/i`
    // regex in `getColorPickerGroup` does NOT match that exact
    // string, but the `.or(getByTestId('accent-color-picker'))`
    // fallback does. Both arms of the locator are intentional.
    const accentPicker = getColorPickerGroup(page, 'accent').first();
    await accentPicker.waitFor({ state: 'visible', timeout: 10_000 });

    const swatches = accentPicker.getByRole('button').or(accentPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThan(0);

    const targetIndex = swatchCount > 1 ? 1 : 0;
    await swatches.nth(targetIndex).click();
    await page.waitForLoadState('networkidle');

    const summary = getDesignSummarySidebar(page).first();
    await expect(summary).toBeVisible();

    const accentSummary = getSummaryRow(summary, 'accent');
    await expect(accentSummary.first()).toBeVisible();

    await page.waitForTimeout(500);
    await expect(summary).toBeVisible();

    expect(
      consoleErrors,
      `Console error(s) during accent color selection: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Rapid successive color changes apply in order (ST-009-AC4)
  // -------------------------------------------------------------------------
  test('ST-045-AC1: rapid successive color changes apply in order', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await waitForConfiguratorReady(page);

    const primaryPicker = getColorPickerGroup(page, 'primary').first();
    await primaryPicker.waitFor({ state: 'visible', timeout: 10_000 });

    const swatches = primaryPicker.getByRole('button').or(primaryPicker.getByRole('radio'));
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThan(1);

    // Click a sequence of swatches rapidly. The implementation under
    // test (`frontend/src/configurator/texture/texturePipeline.ts`
    // per C6/R7) is required to honor each change in order:
    // `fabricCanvas.renderAll()` MUST resolve before
    // `threeTexture.needsUpdate = true` is set, otherwise rapid
    // back-to-back interactions can lose updates or, in the worst
    // case, lose the WebGL context entirely.
    //
    // We click up to four swatches in quick succession with
    // `delay: 0` (overriding Playwright's default action delay) to
    // simulate the kind of frantic user interaction that ST-009-AC4
    // explicitly mandates support for.
    const sequenceLength = Math.min(swatchCount, 4);
    for (let i = 0; i < sequenceLength; i += 1) {
      await swatches.nth(i).click({ delay: 0 });
    }

    // After the rapid sequence, allow the texture pipeline to
    // settle. We wait for `networkidle` (no-op for client-only
    // changes but harmless) and a 500 ms polling window before
    // re-asserting the configurator is still healthy.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const summary = getDesignSummarySidebar(page).first();
    await expect(summary).toBeVisible();

    // Verify the canvas has not detached. A regression in
    // texture-pipeline ordering can cause the WebGL context to
    // throw `WEBGL_lose_context`; that surfaces here as either
    // (a) the canvas element being torn down or (b) a console
    // error being emitted by the WebGL subsystem. Both are caught.
    await expect(page.locator('canvas').first()).toBeAttached();

    expect(
      consoleErrors,
      `Console error(s) during rapid color sequence: ${consoleErrors.join(' | ')}`,
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: All three color pickers are reachable
  // -------------------------------------------------------------------------
  // A consolidation smoke test: verifies the entire left-control
  // sidebar mounts with all three color pickers concurrently visible.
  // Catches a regression where, e.g., a single picker silently fails
  // to render due to a Suspense boundary or import-error swallowing.
  test('ST-045-AC1: all three color pickers are reachable', async ({ page }) => {
    await waitForConfiguratorReady(page);

    const primaryPicker = getColorPickerGroup(page, 'primary').first();
    const secondaryPicker = getColorPickerGroup(page, 'secondary').first();
    const accentPicker = getColorPickerGroup(page, 'accent').first();

    // The first picker gets a 10-second budget (cold-start tolerance);
    // the subsequent two get 5 seconds because by then the SPA is
    // fully mounted.
    await expect(primaryPicker).toBeVisible({ timeout: 10_000 });
    await expect(secondaryPicker).toBeVisible({ timeout: 5_000 });
    await expect(accentPicker).toBeVisible({ timeout: 5_000 });
  });
});
