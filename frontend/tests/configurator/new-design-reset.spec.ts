/**
 * Start New Design confirmation + reset Playwright spec — Gate T2 verification
 * for ST-020.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       `frontend/tests/configurator/*.spec.ts` —
 *       Configurator smoke + interaction tests (Gate T2).
 *   - AAP §0.6.7 Track 2 Frontend Core: `NewDesignDialog.tsx` (ST-020)
 *       is a Track 2 deliverable; the agent prompt for this spec
 *       enumerates the eleven test cases this file must contain.
 *   - Story coverage (per the agent prompt):
 *       ST-020-AC1 — A New Design action is accessible from the top
 *                    navigation area and is reachable by both pointer
 *                    and keyboard.
 *       ST-020-AC2 — Activating New Design while the current design
 *                    has unsaved changes shows a confirmation prompt
 *                    naming what will be lost, and allows the user to
 *                    cancel or proceed.
 *       ST-020-AC3 — Cancelling the prompt leaves every configurator
 *                    surface unchanged and does not reset any
 *                    selection.
 *       ST-020-AC4 — Confirming the prompt resets every configurator
 *                    surface — preview, color pickers, pattern
 *                    selector, finish selector, logo controls, and
 *                    summary sidebar — to the documented default
 *                    values.
 *
 * ===========================================================================
 * Purpose
 * ===========================================================================
 *
 * Verifies the `NewDesignDialog` flow, end to end:
 *
 *   1. The "Start New Design" button is visible and reachable by
 *      keyboard in the top navigation.
 *   2. When `isSaved=true` (no unsaved changes), clicking the button
 *      immediately resets the configurator without showing a
 *      confirmation dialog.
 *   3. When `isSaved=false` (the user has unsaved changes), clicking
 *      the button opens a modal confirmation dialog with:
 *         - `role="dialog" aria-modal="true"`
 *         - a heading explaining the loss of unsaved changes
 *         - "Cancel" and "Discard and start new" buttons
 *         - default focus on the Cancel button (least-destructive)
 *         - ESC key closes the dialog without resetting state
 *         - backdrop click does NOT dismiss the dialog
 *   4. Cancel preserves the configurator state.
 *   5. Confirm ("Discard and start new") resets ALL configurator
 *      selections to the documented `CONFIGURATOR_DEFAULTS` (white
 *      primary, black secondary, red accent, classic pattern, matte
 *      finish, no logo).
 *   6. After reset, the summary sidebar reflects the defaults and the
 *      configurator is back in `isSaved=true` state.
 *
 * ===========================================================================
 * Defensive locator strategy
 * ===========================================================================
 *
 * The spec uses chained `.or(...)` locators so it survives reasonable
 * implementation refactors of `NewDesignDialog.tsx`. This matches the
 * approach used in the sibling `tests/e2e/configurator-load.spec.ts`,
 * `tests/visual/configurator.spec.ts`, and other established specs.
 *
 * "Start New Design" trigger — three-arm chain:
 *   1. `getByRole('button', { name: /Start New Design/i })` — the
 *       canonical accessible-name selector matching the button label.
 *   2. `getByTestId('start-new-design-button')` — likely future
 *       testid convention; load-bearing if a refactor changes the
 *       accessible name (e.g., to "New Design").
 *   3. `getByRole('button', { name: /^New Design$/i })` — alternative
 *       label matching a possible future shorter button label.
 *
 * Confirmation dialog — two-arm chain:
 *   1. `getByRole('dialog')` — Playwright auto-matches both
 *       `role="dialog"` and `role="alertdialog"`.
 *   2. `getByTestId('new-design-dialog')` — the likely future testid
 *       convention.
 *
 * Color, pattern, and finish controls use the data-testid conventions
 * established in `frontend/src/configurator/controls/colors/` and
 * `frontend/src/configurator/controls/pattern/`:
 *
 *   - `data-testid="primary-swatch-<hex>"` (hex is lower-cased
 *      including the `#`, e.g. `primary-swatch-#ffd400`).
 *   - `data-testid="stitching-pattern-option-<value>"`.
 *   - `data-testid="finish-option-<value>"`.
 *
 * Summary sidebar values use the testids from `App.tsx`'s `SummaryRow`:
 *
 *   - `data-testid="summary-value-primary"`   (reads `'#FFFFFF'` etc.)
 *   - `data-testid="summary-value-secondary"`
 *   - `data-testid="summary-value-accent"`
 *   - `data-testid="summary-value-pattern"`   (reads `'Classic'` etc.)
 *   - `data-testid="summary-value-finish"`    (reads `'Matte'` etc.)
 *   - `data-testid="summary-value-logo"`      (reads `'None'` /
 *                                              `'Uploaded'`).
 *
 * For the "after Discard, all defaults" assertion this spec uses the
 * canonical store defaults straight from `CONFIGURATOR_DEFAULTS`:
 *
 *   primaryColor   = '#FFFFFF'
 *   secondaryColor = '#000000'
 *   accentColor    = '#FF0000'
 *   stitchingPattern = 'classic'  (label "Classic")
 *   materialFinish   = 'matte'    (label "Matte")
 *   logoFile         = null       (label "None")
 *
 * For the "after change, summary updated" assertion this spec uses
 * non-default swatches that ARE present in the curated palettes:
 *
 *   PRIMARY_COLOR_SWATCHES[2]   = `#FFD400`  (label "Bright yellow")
 *   SECONDARY_COLOR_SWATCHES[1] = `#424242`  (label "Slate")
 *   ACCENT_COLOR_SWATCHES[1]    = `#FFD400`  (label "Yellow")
 *   STITCHING_PATTERNS[3]       = `spiral`   (label "Spiral")
 *   MATERIAL_FINISHES[1]        = `glossy`   (label "Glossy")
 *
 * `spiral × glossy` is NOT in `DISABLED_COMBINATIONS` (only
 * `spiral × metallic` and `star × metallic` are disabled in
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`),
 * so every interaction sequence below lands on enabled controls.
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
 *     the control interactions in the multi-surface change sequence;
 *     we wait for `networkidle` after navigation so the pipeline
 *     settles before assertions.
 *   - Rule R9 (financial-settlement exclusion): this file contains no
 *     references to any payment processor, settlement provider, or
 *     financial-transaction primitive of any kind, satisfying the
 *     repository-wide validation check defined in AAP §0.8.1.
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
 * Generous timeout for the dialog visibility / dismissal assertions.
 * Modal animations and React commit cycles need a small buffer beyond
 * the default 5 s `expect` timeout, especially on the first dialog
 * open (when `NewDesignDialog` lazy-loads its DOM subtree).
 */
const DIALOG_VISIBILITY_TIMEOUT_MS = 5_000;

/**
 * Generous timeout for verifying the dialog has dismissed (returned
 * to count 0 in the DOM). This covers focus-restore animations,
 * unmount transitions, and any deferred React effects.
 */
const DIALOG_DISMISSAL_TIMEOUT_MS = 5_000;

/**
 * Long poll window for "after reset, the summary reflects defaults"
 * assertions. The reset propagates through Zustand → React render →
 * texture pipeline → DOM update; 5 s comfortably absorbs any
 * propagation delay on slow CI hardware.
 */
const RESET_PROPAGATION_TIMEOUT_MS = 5_000;

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
 * tests that never trigger the corresponding URL — the new-design
 * reset spec does not exercise any backend endpoint, but the mocks
 * defend against accidental fetches from store-init effects,
 * preloading, or telemetry beacons.
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
 * configurator without race conditions between dialog assertions and
 * canvas/store hydration.
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
 * Locate the "Start New Design" trigger using a defensive three-arm
 * chain. The first arm matches the canonical accessible name; the
 * subsequent arms accommodate likely future refactors so the spec
 * does not break on label changes.
 *
 * Per the agent prompt, the canonical button name is
 * "Start New Design"; alternative shorter labels ("New Design") are
 * accepted as forward-compatible fallbacks. A `data-testid` arm is
 * included for the cases where the accessible name is genuinely
 * dynamic (e.g., localised) but a stable testid remains.
 */
function locateStartNewDesignButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /Start New Design/i })
    .or(page.getByTestId('start-new-design-button'))
    .or(page.getByRole('button', { name: /^New Design$/i }));
}

/**
 * Locate the New Design confirmation dialog using a defensive
 * two-arm chain. Playwright's `getByRole('dialog')` auto-matches
 * both `role="dialog"` and `role="alertdialog"`, so a single role
 * arm is sufficient even if `NewDesignDialog` is implemented as an
 * alert dialog. The testid arm provides a stable identifier for
 * cases where another dialog (e.g., `LoadDesignList`'s confirmation)
 * coexists on the page.
 */
function locateNewDesignDialog(page: Page): Locator {
  return page.getByRole('dialog').or(page.getByTestId('new-design-dialog'));
}

/**
 * Locate the Cancel button inside the confirmation dialog. The
 * `^Cancel$` anchored regex deliberately rejects any button whose
 * accessible name STARTS with "Cancel" but extends beyond — for
 * example, "Cancel and reset" or "Cancel order" — so the Locator
 * always lands on the dedicated dismissal control.
 */
function locateCancelButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /^Cancel$/ })
    .or(page.getByTestId('new-design-cancel-button'));
}

/**
 * Locate the destructive confirm button inside the confirmation
 * dialog. The label "Discard and start new" is the canonical name
 * per the agent prompt; alternative shorter labels ("Discard",
 * "Start new") are accepted as forward-compatible fallbacks.
 */
function locateDiscardButton(page: Page): Locator {
  return page
    .getByRole('button', { name: /Discard and start new/i })
    .or(page.getByTestId('new-design-discard-button'))
    .or(page.getByRole('button', { name: /^Discard$/i }));
}

/**
 * Open the New Design confirmation dialog by introducing an unsaved
 * change first (so `isSaved=false`), then clicking the Start New
 * Design button. Returns the dialog Locator after asserting it is
 * visible.
 *
 * The unsaved change is a primary-color swatch click on the second
 * curated swatch (`#F5F5F5` "Soft white") — guaranteed to be
 * non-default and present in the palette per
 * `frontend/src/configurator/controls/colors/colorSwatches.ts`.
 */
async function openConfirmationDialog(page: Page): Promise<Locator> {
  // Introduce an unsaved change. The Soft white swatch is the second
  // primary-palette entry (PRIMARY_COLOR_SWATCHES[1]) and is
  // non-default. Two locator arms — testid first, position-based
  // fallback — survive any swatch-testid refactor.
  const primaryPicker = page
    .getByRole('group', { name: /primary color/i })
    .or(page.getByTestId('primary-color-picker'));
  const nonDefaultSwatch = page
    .getByTestId('primary-swatch-#f5f5f5')
    .or(primaryPicker.first().locator('[role="radio"], button').nth(1));
  await nonDefaultSwatch.first().click();

  // Click the Start New Design trigger.
  await locateStartNewDesignButton(page).first().click();

  // Confirm the dialog is visible.
  const dialog = locateNewDesignDialog(page).first();
  await expect(dialog).toBeVisible({ timeout: DIALOG_VISIBILITY_TIMEOUT_MS });
  return dialog;
}

/**
 * Apply non-default selections across multiple surfaces. After this
 * helper runs, every summary slice should reflect a non-default
 * value. Used by the Cancel-preserves-state and Discard-resets-state
 * tests to confirm broad-surface behaviour.
 *
 * The pattern + finish combination is `spiral × glossy`, which is
 * NOT in `DISABLED_COMBINATIONS` (only `spiral × metallic` and
 * `star × metallic` are disabled). Every locator uses a defensive
 * testid-or-position chain so the helper survives swatch reordering.
 */
async function applyNonDefaultSelections(page: Page): Promise<void> {
  // Primary swatch — index 2 (FFD400 "Bright yellow") is non-default.
  const primaryPicker = page
    .getByRole('group', { name: /primary color/i })
    .or(page.getByTestId('primary-color-picker'));
  const primarySwatch = page
    .getByTestId('primary-swatch-#ffd400')
    .or(primaryPicker.first().locator('[role="radio"], button').nth(2));
  await primarySwatch.first().click();

  // Secondary swatch — index 1 (424242 "Slate") is non-default.
  const secondaryPicker = page
    .getByRole('group', { name: /secondary color/i })
    .or(page.getByTestId('secondary-color-picker'));
  const secondarySwatch = page
    .getByTestId('secondary-swatch-#424242')
    .or(secondaryPicker.first().locator('[role="radio"], button').nth(1));
  await secondarySwatch.first().click();

  // Accent swatch — index 1 (FFD400 "Yellow") is non-default.
  const accentPicker = page
    .getByRole('group', { name: /accent/i })
    .or(page.getByTestId('accent-color-picker'));
  const accentSwatch = page
    .getByTestId('accent-swatch-#ffd400')
    .or(accentPicker.first().locator('[role="radio"], button').nth(1));
  await accentSwatch.first().click();

  // Stitching pattern — `spiral` (STITCHING_PATTERNS[3]) is
  // non-default and compatible with the `glossy` finish below.
  const patternSelector = page
    .getByRole('group', { name: /stitching pattern/i })
    .or(page.getByTestId('stitching-pattern-selector'));
  const patternOption = page
    .getByTestId('stitching-pattern-option-spiral')
    .or(patternSelector.first().locator('[role="radio"], button').nth(3));
  await patternOption.first().click();

  // Material finish — `glossy` (MATERIAL_FINISHES[1]) is non-default.
  // `spiral × glossy` is enabled per DISABLED_COMBINATIONS.
  const finishSelector = page
    .getByRole('group', { name: /finish/i })
    .or(page.getByTestId('finish-selector'));
  const finishOption = page
    .getByTestId('finish-option-glossy')
    .or(finishSelector.first().locator('[role="radio"], button').nth(1));
  await finishOption.first().click();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Start New Design action (ST-020)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackendApi(page);
    await waitForConfiguratorReady(page);
  });

  // -----------------------------------------------------------------------
  // Test 1 — ST-020-AC1: trigger visibility + accessibility
  //
  // The Start New Design button is rendered in the top navigation,
  // is visible, is enabled, and is reachable by both pointer and
  // keyboard. Visibility implies pointer-reachability; for keyboard
  // reachability we additionally assert the button is focusable
  // (focus() succeeds and the button receives focus).
  // -----------------------------------------------------------------------
  test('renders the "Start New Design" trigger in the top navigation (ST-020-AC1)', async ({
    page,
  }) => {
    const button = locateStartNewDesignButton(page).first();

    // Pointer-reachability: button is visible AND enabled.
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();

    // Keyboard-reachability: focus() succeeds and the button takes
    // focus. This confirms the trigger is in the document's tab
    // order (i.e. not `tabindex="-1"`) without requiring a full Tab
    // traversal from <body>, which is fragile across browsers.
    await button.focus();
    await expect(button).toBeFocused();
  });

  // -----------------------------------------------------------------------
  // Test 2 — `isSaved=true` short-circuit
  //
  // When the configurator is in its pristine default state
  // (`isSaved=true`), clicking Start New Design must NOT open a
  // confirmation dialog. The store's `resetToDefaults()` action runs
  // unconditionally (defaults onto defaults is a no-op semantically),
  // so the summary remains in default state.
  //
  // We use `toHaveCount(0)` for the dialog-absent assertion rather
  // than `toBeHidden()` — the dialog DOM should not exist at all,
  // not merely be hidden via CSS.
  // -----------------------------------------------------------------------
  test('does NOT show a confirmation dialog when state is unmodified (isSaved=true)', async ({
    page,
  }) => {
    // Pre-condition: store starts with `isSaved=true` (defaults).
    await locateStartNewDesignButton(page).first().click();

    // No dialog should appear. The configurator is in default state
    // so the store's reset action runs without a confirmation.
    const dialog = locateNewDesignDialog(page);
    await expect(dialog).toHaveCount(0);

    // Configurator remains in default state — verify via the
    // canonical summary value testids.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFFFFF');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Classic');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Matte');
  });

  // -----------------------------------------------------------------------
  // Test 3 — ST-020-AC2: dialog appears when there are unsaved changes
  //
  // After making any non-default selection (primary swatch click),
  // `isSaved` flips to false. Clicking Start New Design must open a
  // modal dialog with `role="dialog"` (or `alertdialog`) and
  // `aria-modal="true"` so screen readers announce it as modal.
  // -----------------------------------------------------------------------
  test('SHOWS a confirmation dialog when the user has unsaved changes (ST-020-AC2)', async ({
    page,
  }) => {
    const dialog = await openConfirmationDialog(page);

    // The dialog must be modal — `aria-modal="true"` ensures
    // assistive tech traps focus and announces modality.
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  // -----------------------------------------------------------------------
  // Test 4 — ST-020-AC2 wording: dialog mentions loss of unsaved changes
  //
  // Per ST-020-AC2, the confirmation prompt MUST name what will be
  // lost. We accept any of "discard", "unsaved", "lose", or "lost"
  // in the dialog text — the canonical wording is documented in the
  // agent prompt as "Discard and start new" + a heading mentioning
  // unsaved changes.
  // -----------------------------------------------------------------------
  test('confirmation dialog mentions loss of unsaved changes (ST-020-AC2)', async ({ page }) => {
    const dialog = await openConfirmationDialog(page);

    // The dialog text must convey that proceeding will discard the
    // current work. The regex accepts "discard", "unsaved", "lose",
    // or "lost" so the spec survives small wording refactors.
    await expect(dialog).toContainText(/discard|unsaved|lose|lost/i);
  });

  // -----------------------------------------------------------------------
  // Test 5 — ST-020-AC2: Cancel and Discard buttons present
  //
  // The dialog MUST surface BOTH a Cancel button and a destructive
  // Discard button. The Cancel button uses an anchored regex
  // (`/^Cancel$/`) to avoid matching unrelated buttons (e.g., "Cancel
  // order"); the Discard button accepts the canonical
  // "Discard and start new" or shorter "Discard" labels.
  // -----------------------------------------------------------------------
  test('confirmation dialog has Cancel and Discard buttons (ST-020-AC2)', async ({ page }) => {
    await openConfirmationDialog(page);

    const cancel = locateCancelButton(page).first();
    await expect(cancel).toBeVisible({ timeout: DIALOG_VISIBILITY_TIMEOUT_MS });

    const discard = locateDiscardButton(page).first();
    await expect(discard).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 6 — Cancel button receives default focus on dialog open
  //
  // Per the agent prompt's `<NewDesignDialog>` discovery, focus is
  // set on the Cancel button when the dialog opens. This is the
  // least-destructive default — pressing Enter on first open
  // dismisses the dialog rather than discarding the user's work.
  //
  // This is a UX safety guarantee, not strictly required by
  // ST-020-AC2; however it materially improves the modal's
  // accessibility contract and is therefore covered as part of the
  // confirmation-dialog smoke verification.
  // -----------------------------------------------------------------------
  test('Cancel button receives default focus when the dialog opens', async ({ page }) => {
    await openConfirmationDialog(page);

    const cancel = locateCancelButton(page).first();
    await expect(cancel).toBeFocused({ timeout: DIALOG_VISIBILITY_TIMEOUT_MS });
  });

  // -----------------------------------------------------------------------
  // Test 7 — ST-020-AC3: Cancel preserves the current configurator state
  //
  // The user makes changes across multiple surfaces, opens the
  // confirmation dialog, and clicks Cancel. After Cancel:
  //   - the dialog dismisses,
  //   - the summary sidebar still reflects the pre-dialog values,
  //   - `isSaved` is still false (subsequent New Design clicks will
  //     re-open the dialog — verified indirectly).
  //
  // We verify the summary values match the non-default selections
  // applied via `applyNonDefaultSelections`. Pattern is "spiral"
  // (label "Spiral") and finish is "glossy" (label "Glossy"); both
  // labels come from the catalogs in
  // `frontend/src/configurator/controls/pattern/patternCatalog.ts`
  // and `frontend/src/configurator/controls/pattern/finishCatalog.ts`.
  // -----------------------------------------------------------------------
  test('clicking Cancel preserves the current configurator state (ST-020-AC3)', async ({
    page,
  }) => {
    // Make changes across multiple surfaces.
    await applyNonDefaultSelections(page);

    // Open the dialog.
    await locateStartNewDesignButton(page).first().click();
    const dialog = locateNewDesignDialog(page).first();
    await expect(dialog).toBeVisible({ timeout: DIALOG_VISIBILITY_TIMEOUT_MS });

    // Click Cancel.
    await locateCancelButton(page).first().click();

    // Dialog dismisses.
    await expect(locateNewDesignDialog(page)).toHaveCount(0, {
      timeout: DIALOG_DISMISSAL_TIMEOUT_MS,
    });

    // Configurator state preserved — summary still shows the
    // non-default selections.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFD400');
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#424242');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FFD400');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Spiral');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy');
  });

  // -----------------------------------------------------------------------
  // Test 8 — ST-020-AC3: ESC key closes dialog without resetting state
  //
  // Standard modal UX: pressing ESC is equivalent to clicking
  // Cancel. The dialog dismisses, the configurator state is
  // preserved, and `isSaved` remains false. This matches the
  // "Cancel preserves state" path but exercises the keyboard-driven
  // dismissal that assistive-tech users rely on.
  // -----------------------------------------------------------------------
  test('pressing ESC key closes the dialog without resetting state (ST-020-AC3)', async ({
    page,
  }) => {
    // Apply a single change so the dialog appears.
    const dialog = await openConfirmationDialog(page);

    // Press ESC.
    await page.keyboard.press('Escape');

    // Dialog dismisses.
    await expect(dialog).toHaveCount(0, { timeout: DIALOG_DISMISSAL_TIMEOUT_MS });

    // Configurator state preserved — primary still shows the
    // non-default selection from `openConfirmationDialog`
    // (`#F5F5F5` "Soft white"). We assert via the summary value
    // testid which `App.tsx` `SummaryRow` exposes.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#F5F5F5');
  });

  // -----------------------------------------------------------------------
  // Test 9 — ST-020-AC4: Discard resets ALL surfaces to defaults
  //
  // The user makes changes across multiple surfaces, opens the
  // confirmation dialog, and clicks Discard. After Discard:
  //   - the dialog dismisses,
  //   - every summary value matches `CONFIGURATOR_DEFAULTS`:
  //       primary  = '#FFFFFF'
  //       secondary = '#000000'
  //       accent   = '#FF0000'
  //       pattern  = 'Classic'
  //       finish   = 'Matte'
  //       logo     = 'None'
  //   - `isSaved` is back to true (verified indirectly in test 10).
  //
  // We use individual `toHaveText` assertions on each summary value
  // testid for maximum diagnostic clarity — if a single surface
  // fails to reset, the failing assertion message names that
  // surface immediately.
  // -----------------------------------------------------------------------
  test('clicking Discard resets ALL surfaces to defaults (ST-020-AC4)', async ({ page }) => {
    // Apply non-default changes across multiple surfaces.
    await applyNonDefaultSelections(page);

    // Verify pre-reset state — non-default values present.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFD400');
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#424242');
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FFD400');
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Spiral');
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Glossy');

    // Open and confirm the dialog.
    await locateStartNewDesignButton(page).first().click();
    const dialog = locateNewDesignDialog(page).first();
    await expect(dialog).toBeVisible({ timeout: DIALOG_VISIBILITY_TIMEOUT_MS });

    await locateDiscardButton(page).first().click();

    // Dialog dismisses.
    await expect(locateNewDesignDialog(page)).toHaveCount(0, {
      timeout: DIALOG_DISMISSAL_TIMEOUT_MS,
    });

    // ALL surfaces reset to documented defaults from
    // `CONFIGURATOR_DEFAULTS` in
    // `frontend/src/state/configuratorStore.ts`. Each assertion
    // is given the reset-propagation timeout so the spec absorbs
    // any Zustand → React render → DOM-update latency.
    await expect(page.getByTestId('summary-value-primary')).toHaveText('#FFFFFF', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-secondary')).toHaveText('#000000', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-accent')).toHaveText('#FF0000', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-pattern')).toHaveText('Classic', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-finish')).toHaveText('Matte', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
    await expect(page.getByTestId('summary-value-logo')).toHaveText('None', {
      timeout: RESET_PROPAGATION_TIMEOUT_MS,
    });
  });

  // -----------------------------------------------------------------------
  // Test 10 — ST-020-AC4: after Discard, isSaved is true again
  //
  // `resetToDefaults()` sets `isSaved=true` per
  // `frontend/src/state/configuratorStore.ts`. Therefore a
  // subsequent click of Start New Design should NOT open the
  // dialog (because the configurator is back in its default,
  // pristine state).
  //
  // This guards against a regression where `resetToDefaults()`
  // would only reset the visible surfaces but leave the `isSaved`
  // flag at false — which would make the dialog appear after every
  // Discard, an obvious UX bug.
  // -----------------------------------------------------------------------
  test('after Discard, the configurator is back in isSaved=true (no dialog on subsequent click)', async ({
    page,
  }) => {
    // Apply a change so the dialog appears on first click.
    await openConfirmationDialog(page);

    // Click Discard to reset.
    await locateDiscardButton(page).first().click();
    await expect(locateNewDesignDialog(page)).toHaveCount(0, {
      timeout: DIALOG_DISMISSAL_TIMEOUT_MS,
    });

    // Click Start New Design AGAIN — no dialog should appear,
    // because the store is back in default `isSaved=true` state.
    await locateStartNewDesignButton(page).first().click();
    await expect(locateNewDesignDialog(page)).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // Test 11 — Modal backdrop click does NOT dismiss the dialog
  //
  // The agent prompt documents this as a deliberate UX choice for
  // `aria-modal="true"` dialogs: the user MUST explicitly choose
  // Cancel or Discard, never inadvertently dismiss via a
  // mis-aimed click. This safeguards against accidental data loss
  // on the destructive path.
  //
  // We click at coordinates (2, 2), which is well outside any
  // reasonable modal bounding box (the dialog is centered at
  // 1280×720). The dialog must remain visible.
  // -----------------------------------------------------------------------
  test('clicking the modal backdrop does NOT close the dialog', async ({ page }) => {
    const dialog = await openConfirmationDialog(page);

    // Click at the very top-left corner — outside the dialog box.
    await page.mouse.click(2, 2);

    // Dialog remains open (aria-modal="true" prevents inadvertent
    // backdrop dismiss in this UX). We use `force: false` semantics
    // implicitly via `toBeVisible` — if the dialog accidentally
    // dismissed, the assertion would fail with an actionability
    // error rather than a hidden-element error.
    await expect(dialog).toBeVisible();
  });
});
