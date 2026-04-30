/**
 * Material finish selector + disabled-combination matrix Playwright spec —
 * Gate T2 verification for ST-011 and ST-013.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       `frontend/tests/configurator/*.spec.ts` —
 *       Configurator smoke + interaction tests (Gate T2).
 *   - AAP §0.6.7 Track 2 Frontend Core: `FinishSelector.tsx` (ST-011) and
 *       `DisabledCombinationTooltip.tsx` (ST-013) are Track 2 deliverables.
 *   - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *       `cd frontend && npx playwright test --project=chromium tests/configurator/`
 *       — all pass.
 *   - Story coverage (per the source story files):
 *       ST-011-AC1 — Three finish options named Matte, Glossy, Metallic
 *                    are visible in the control sidebar.
 *       ST-011-AC2 — Selecting a finish applies it and marks the option
 *                    as the active selection within the latency budget.
 *       ST-011-AC3 — The currently selected finish remains visually
 *                    marked as active after selection.
 *       ST-013-AC1 — An unsupported pattern × finish combination renders
 *                    the conflicting option in a disabled visual state.
 *       ST-013-AC2 — Hovering or focusing a disabled option reveals a
 *                    tooltip explaining why the combination is unavailable.
 *       ST-013-AC3 — Clicking a disabled option produces no change to
 *                    the preview and does not register as a selection.
 *       ST-013-AC4 — Changing the other variable so the combination
 *                    becomes supported re-enables the disabled option.
 *
 * ===========================================================================
 * Implementation alignment notes
 * ===========================================================================
 *
 * The agent prompt for this file used a `material-finish-*` test-id prefix
 * convention. The actual frontend source code (see
 * `frontend/src/configurator/controls/pattern/FinishSelector.tsx` and
 * `frontend/src/configurator/controls/pattern/DisabledCombinationTooltip.tsx`)
 * ships with the shorter `finish-*` prefix, which is also the prefix the
 * existing `configurator-load.spec.ts`, `summary-sidebar.spec.ts`, and
 * `new-design-reset.spec.ts` already exercise. This spec adopts the
 * shipped convention so the tests run against the real DOM contract:
 *
 *   - `data-testid="finish-selector"`        (the `<section>`)
 *   - `data-testid="finish-option-<value>"`  (`role="radio"` button)
 *   - `data-testid="finish-tooltip-<value>"` (tooltip element, only
 *                                              rendered when disabled)
 *   - `data-testid="stitching-pattern-selector"`
 *   - `data-testid="stitching-pattern-option-<value>"`
 *
 * Disabled-state direction: the implementation enforces ST-013's
 * "conflicting option" requirement on the FINISH side only. When the
 * active stitching pattern is `spiral` or `star`, the metallic finish
 * is rendered with `aria-disabled="true"`, an `aria-describedby`
 * pointer to the tooltip, and a `<DisabledCombinationTooltip
 * role="tooltip">` element that is hidden by default and revealed on
 * hover or focus. The pattern selector itself does NOT add
 * `aria-disabled` to any pattern button — the `StitchingPatternSelector`
 * intentionally does not call `isCombinationDisabled`. This is a
 * deliberate UX choice: the user is always free to switch patterns,
 * and only the conflicting finish is held back, with the explanatory
 * tooltip pointing to the resolution path. The tests below verify
 * this behavior as the contract; if the matrix is ever extended to
 * disable on both sides, the corresponding tests in this spec will
 * surface the change so the owner knows to update the assertions.
 *
 * Disabled pairs (per `frontend/src/configurator/controls/pattern/
 * patternCatalog.ts` `DISABLED_COMBINATIONS`):
 *
 *     pattern="spiral" → finish="metallic" disabled
 *     pattern="star"   → finish="metallic" disabled
 *     all other 16 pattern × finish combinations are ENABLED.
 *
 * ===========================================================================
 * Force-click on a disabled radio
 * ===========================================================================
 *
 * Playwright's default `click()` performs an actionability check that
 * fails (and times out) if the target has `aria-disabled="true"`. To
 * exercise the application's defensive guard inside `onClick` (early
 * return when `disabled` is true) we deliberately bypass the
 * actionability check with `{ force: true }`. The defensive guard is
 * the production code path that prevents a stray pointer event (from
 * touch, custom inputs, or assistive technology that ignores
 * `aria-disabled`) from changing state. See
 * `FinishSelector.tsx` `onClick` for the guard:
 *
 *     onClick={() => {
 *       if (disabled) {
 *         setRevealedFinish(entry.value);
 *         return;
 *       }
 *       setMaterialFinish(entry.value);
 *     }}
 *
 * ===========================================================================
 * Cross-cutting rules enforced
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): zero direct `console.*`
 *     calls in this file. The mock fulfills auth endpoints with empty
 *     bodies so no credential payloads pass through.
 *   - Rule R3 (Firebase Admin SDK only on backend): no JWT or
 *     `firebase-admin` imports — this is a frontend Playwright spec.
 *   - Rule R7 / C6 (Fabric → Three texture update order): untouched by
 *     this spec; the texture coordinator owns that contract.
 *   - Rule R9 (no payment processing): no payment-related strings.
 *
 * ===========================================================================
 * Type augmentation
 * ===========================================================================
 *
 * No `Window` augmentation is required — this spec only interacts with
 * the DOM via Playwright locators. The shared bridge types in
 * `frontend/tests/types/bridge.d.ts` are already auto-included by the
 * frontend `tsconfig.json` `include` array; this file does not depend
 * on them.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants — selectors, labels, defaults
// ---------------------------------------------------------------------------

/**
 * The `<section>` rendered by `FinishSelector.tsx`. The section is the
 * stable mount point for the entire finish picker. Its inner `<ul>` is
 * the actual `role="radiogroup"`, while the section itself carries
 * `aria-label="Material finish"` (without a role).
 */
const FINISH_SELECTOR_TESTID = 'finish-selector';

/**
 * The accessible label applied to the `<section>` rendered by
 * `FinishSelector.tsx`. Per ST-011-AC1 the picker is identified to
 * assistive technology via this string.
 */
const FINISH_SECTION_ARIA_LABEL = 'Material finish';

/**
 * The accessible name applied to the inner `<ul role="radiogroup">`
 * rendered by `FinishSelector.tsx`. Used to address the radiogroup
 * unambiguously even though the page contains other radiogroups
 * (color pickers, pattern selector, accent picker).
 */
const FINISH_RADIOGROUP_NAME = 'Material finish options';

/**
 * The `<section>` rendered by `StitchingPatternSelector.tsx`. We
 * interact with the inner option buttons via
 * `stitching-pattern-option-<value>`; the section testid is asserted
 * to confirm the picker is visible before exercising disabled
 * combinations.
 */
const STITCHING_PATTERN_SELECTOR_TESTID = 'stitching-pattern-selector';

/**
 * The default `materialFinish` slice value declared by
 * `frontend/src/state/configuratorStore.ts` `CONFIGURATOR_DEFAULTS`
 * (DEFAULT_FINISH === 'matte'). The default finish on first render
 * MUST be matte per ST-011 alignment with the documented store
 * defaults.
 */
const DEFAULT_FINISH = 'matte' as const;

/**
 * The default `stitchingPattern` slice value. Documented in
 * `frontend/src/state/configuratorStore.ts` as 'classic' so the
 * configurator opens with no disabled finishes.
 */
const DEFAULT_PATTERN = 'classic' as const;

/**
 * The complete material-finish catalog, mirroring
 * `frontend/src/configurator/controls/pattern/finishCatalog.ts`. The
 * order matches the array declared in that catalog so both
 * presentation order and keyboard tab order are deterministic.
 */
const FINISHES: ReadonlyArray<{
  readonly value: 'matte' | 'glossy' | 'metallic';
  readonly label: string;
}> = [
  { value: 'matte', label: 'Matte' },
  { value: 'glossy', label: 'Glossy' },
  { value: 'metallic', label: 'Metallic' },
];

/**
 * The complete stitching-pattern catalog, mirroring
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`.
 * Order matches the array declared in that catalog.
 */
const PATTERNS: ReadonlyArray<{
  readonly value: 'classic' | 'hexagonal' | 'diamond' | 'spiral' | 'star' | 'grid';
  readonly label: string;
}> = [
  { value: 'classic', label: 'Classic' },
  { value: 'hexagonal', label: 'Hexagonal' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'spiral', label: 'Spiral' },
  { value: 'star', label: 'Star' },
  { value: 'grid', label: 'Grid' },
];

/**
 * The disabled pairs declared by
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`
 * `DISABLED_COMBINATIONS`. The implementation reads this map and
 * disables the FINISH side when any of these patterns is active.
 *
 *   spiral + metallic = DISABLED
 *   star   + metallic = DISABLED
 *
 * All 16 other pattern × finish pairs are ENABLED.
 */
const DISABLED_PAIRS: ReadonlyArray<{
  readonly pattern: 'spiral' | 'star';
  readonly finish: 'metallic';
}> = [
  { pattern: 'spiral', finish: 'metallic' },
  { pattern: 'star', finish: 'metallic' },
];

// ---------------------------------------------------------------------------
// Helpers — selector composition
// ---------------------------------------------------------------------------

/**
 * Build the `data-testid` for a finish option. Mirrors the
 * `data-testid={`finish-option-${entry.value}`}` template from
 * `FinishSelector.tsx`.
 */
function finishOptionTestId(finish: string): string {
  return `finish-option-${finish}`;
}

/**
 * Build the `data-testid` for a finish-disabled tooltip element.
 * Mirrors the `data-testid={`finish-tooltip-${entry.value}`}` template
 * from `FinishSelector.tsx`. The tooltip element is only rendered in
 * the DOM when the corresponding finish is disabled — when enabled,
 * the conditional render returns `null` so this locator resolves to
 * zero elements.
 */
function finishTooltipTestId(finish: string): string {
  return `finish-tooltip-${finish}`;
}

/**
 * Build the `data-testid` for a pattern option. Mirrors the
 * `data-testid={`stitching-pattern-option-${entry.value}`}` template
 * from `StitchingPatternSelector.tsx`.
 */
function patternOptionTestId(pattern: string): string {
  return `stitching-pattern-option-${pattern}`;
}

// ---------------------------------------------------------------------------
// Helpers — fixtures
// ---------------------------------------------------------------------------

/**
 * Mock backend / Firebase / GCS calls so the configurator can render a
 * default-state sphere without any live network dependency.
 *
 * Track 2 (per AAP §0.6.7) renders the configurator with a stub API
 * layer; this mock function ensures Playwright tests behave the same
 * way regardless of whether the Track 1 backend is up. Specifically:
 *
 *   - `identitytoolkit.googleapis.com/**` — Firebase Auth REST.
 *   - `securetoken.googleapis.com/**`     — Firebase Auth token refresh.
 *   - `**\/api/designs` (GET)             — Empty design list payload.
 *   - `**\/api/cart` (GET)                — Empty cart payload.
 *   - `**\/api/**` (any other path)       — Empty `{}` payload.
 *
 * Routes are installed via `page.route(...)`, which intercepts requests
 * inside the page's network layer. They have no effect on tests that
 * never trigger the corresponding URL.
 */
async function mockBackendApi(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  // The glob '**/api/**' matches BOTH real backend `/api/*` calls AND
  // the Vite-served frontend source files at `/src/api/*.ts` (because
  // the path segment "api" appears in both). Letting the catch-all
  // fulfill the source-file requests with a `{}` JSON body breaks the
  // browser's strict-MIME-type enforcement for ES modules and prevents
  // the React tree from mounting (no canvas, no controls, no anything).
  // Fix: filter at routing time using a function predicate that checks
  // the URL pathname starts with `/api/` (no `/src/` prefix), so Vite
  // can serve frontend source files normally.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route, request) => {
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
    },
  );
}

/**
 * Navigate to the configurator and wait for it to be ready for
 * interaction. Specifically:
 *
 *   1. Navigate to the Vite dev server root (`/`).
 *   2. Wait for `networkidle` so any in-flight Firebase initialization
 *      and asset preloads have settled.
 *   3. Wait for an R3F `<canvas>` to attach to the DOM — the
 *      configurator render pipeline requires the canvas before the
 *      controls are interactive.
 *   4. Move the mouse to a neutral position so no element is
 *      accidentally hovered (which could pre-reveal a disabled-state
 *      tooltip in the finish selector and confuse the assertions
 *      below).
 *   5. Wait one more `networkidle` cycle for any post-canvas-mount
 *      effects (state hydration, store subscriptions firing) to settle.
 *
 * Identical helper to the one used by the sibling specs
 * (`configurator-load.spec.ts`, `summary-sidebar.spec.ts`,
 * `logo-upload.spec.ts`) so behavior is consistent across the suite.
 */
async function waitForConfiguratorReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page
    .locator('canvas')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 });
  await page.mouse.move(50, 300);
  await page.waitForLoadState('networkidle');
}

/**
 * Assert that the given locator's `aria-disabled` attribute is in an
 * "enabled" state — i.e., either absent (`null`) or explicitly
 * `'false'`. React serializes `aria-disabled={false}` as the literal
 * string `"false"` in the DOM, while React serializes
 * `aria-disabled={undefined}` as no attribute at all. Both signals
 * mean "enabled"; neither means "disabled". This helper accepts either
 * representation so the spec is resilient to the exact React render
 * choice.
 */
async function expectAriaDisabledFalsy(locator: Locator): Promise<void> {
  const ariaDisabled = await locator.getAttribute('aria-disabled');
  expect(
    ariaDisabled === null || ariaDisabled === 'false',
    `expected aria-disabled to be absent or "false", got "${ariaDisabled}"`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Material finish selector (ST-011) and disabled-combination matrix (ST-013)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackendApi(page);
    await waitForConfiguratorReady(page);
  });

  // -------------------------------------------------------------------------
  // Section A — Rendering and structure (ST-011-AC1)
  // -------------------------------------------------------------------------

  test('renders the finish selector section with the documented aria-label', async ({
    page,
  }) => {
    const selector = page.getByTestId(FINISH_SELECTOR_TESTID);
    await expect(selector).toBeVisible();
    await expect(selector).toHaveAttribute('aria-label', FINISH_SECTION_ARIA_LABEL);
  });

  test('exposes the inner radiogroup by role and accessible name', async ({ page }) => {
    // The radiogroup role lives on the inner <ul>, NOT on the section.
    // We address it by accessible name to disambiguate from the other
    // radiogroups on the page (color pickers, pattern selector).
    const radiogroup = page.getByRole('radiogroup', { name: FINISH_RADIOGROUP_NAME });
    await expect(radiogroup).toBeVisible();
  });

  test('renders exactly three finish options (Matte, Glossy, Metallic)', async ({ page }) => {
    for (const finish of FINISHES) {
      const option = page.getByTestId(finishOptionTestId(finish.value));
      await expect(option).toBeVisible();
    }

    const allOptions = page.locator('[data-testid^="finish-option-"]');
    await expect(allOptions).toHaveCount(3);
  });

  test('renders finish options in the documented DOM order (matte, glossy, metallic)', async ({
    page,
  }) => {
    const allOptions = page.locator('[data-testid^="finish-option-"]');
    const renderedTestIds = await allOptions.evaluateAll((els: Element[]) =>
      els.map((el) => el.getAttribute('data-testid')),
    );

    expect(renderedTestIds).toEqual([
      finishOptionTestId('matte'),
      finishOptionTestId('glossy'),
      finishOptionTestId('metallic'),
    ]);
  });

  test('each finish option exposes role="radio" and an accessible label naming the finish', async ({
    page,
  }) => {
    for (const finish of FINISHES) {
      const option = page.getByTestId(finishOptionTestId(finish.value));
      await expect(option).toHaveAttribute('role', 'radio');

      const ariaLabel = await option.getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      // The finish name (case-insensitive) MUST appear in the label
      // so screen readers announce which finish is which.
      expect(ariaLabel!.toLowerCase()).toContain(finish.label.toLowerCase());
    }
  });

  // -------------------------------------------------------------------------
  // Section B — Default state
  // -------------------------------------------------------------------------

  test('default finish is "matte" with aria-checked="true" on first render', async ({
    page,
  }) => {
    const matteOption = page.getByTestId(finishOptionTestId(DEFAULT_FINISH));
    await expect(matteOption).toHaveAttribute('aria-checked', 'true');

    for (const finish of FINISHES) {
      if (finish.value === DEFAULT_FINISH) continue;
      const option = page.getByTestId(finishOptionTestId(finish.value));
      await expect(option).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('default state has no disabled finishes and no tooltips in the DOM', async ({
    page,
  }) => {
    // Default pattern is 'classic', which has no disabled finishes,
    // so every finish option is enabled and no tooltip element is
    // rendered (the conditional render returns null when enabled).
    for (const finish of FINISHES) {
      const option = page.getByTestId(finishOptionTestId(finish.value));
      await expectAriaDisabledFalsy(option);
      await expect(option).toBeEnabled();

      const tooltip = page.getByTestId(finishTooltipTestId(finish.value));
      await expect(tooltip).toHaveCount(0);
    }
  });

  // -------------------------------------------------------------------------
  // Section C — Selection behavior (ST-011-AC2 / ST-011-AC3)
  // -------------------------------------------------------------------------

  test('clicking glossy selects it and deselects matte (ST-011-AC2)', async ({ page }) => {
    const matte = page.getByTestId(finishOptionTestId('matte'));
    const glossy = page.getByTestId(finishOptionTestId('glossy'));

    await expect(matte).toHaveAttribute('aria-checked', 'true');

    await glossy.click();

    await expect(glossy).toHaveAttribute('aria-checked', 'true');
    await expect(matte).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking metallic selects it and deselects matte (ST-011-AC2)', async ({
    page,
  }) => {
    const matte = page.getByTestId(finishOptionTestId('matte'));
    const metallic = page.getByTestId(finishOptionTestId('metallic'));

    await expect(matte).toHaveAttribute('aria-checked', 'true');

    await metallic.click();

    await expect(metallic).toHaveAttribute('aria-checked', 'true');
    await expect(matte).toHaveAttribute('aria-checked', 'false');
  });

  test('switching among all three finishes leaves only one option active (ST-011-AC2)', async ({
    page,
  }) => {
    // Walk through the finishes in order: matte (default) → glossy →
    // metallic → matte. After each click, exactly one option is
    // aria-checked="true" and the other two are "false".
    const sequence: ReadonlyArray<typeof FINISHES[number]['value']> = [
      'glossy',
      'metallic',
      'matte',
    ];

    for (const target of sequence) {
      await page.getByTestId(finishOptionTestId(target)).click();
      for (const finish of FINISHES) {
        const option = page.getByTestId(finishOptionTestId(finish.value));
        await expect(option).toHaveAttribute(
          'aria-checked',
          finish.value === target ? 'true' : 'false',
        );
      }
    }
  });

  test('finish selection persists across a non-trivial wait (ST-011-AC3)', async ({
    page,
  }) => {
    const glossy = page.getByTestId(finishOptionTestId('glossy'));
    await glossy.click();
    await expect(glossy).toHaveAttribute('aria-checked', 'true');

    // Wait long enough to confirm the selection is persistent and not
    // a transient visual state. 750 ms is well beyond the documented
    // ST-009 (real-time color sync) latency budget and the
    // ST-005-AC3 (initial sphere render) budget combined.
    await page.waitForTimeout(750);

    await expect(glossy).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId(finishOptionTestId('matte'))).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('finish selection is independent of stitching pattern selection', async ({
    page,
  }) => {
    // Pick a non-default pattern (hexagonal — known to be enabled
    // for every finish per the disabled-combinations map).
    await page.getByTestId(patternOptionTestId('hexagonal')).click();
    await expect(page.getByTestId(patternOptionTestId('hexagonal'))).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Change finish to glossy.
    await page.getByTestId(finishOptionTestId('glossy')).click();
    await expect(page.getByTestId(finishOptionTestId('glossy'))).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Pattern selection preserved — finish change MUST NOT clobber
    // the pattern slice.
    await expect(page.getByTestId(patternOptionTestId('hexagonal'))).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('finish selection is independent of primary color picker selection', async ({
    page,
  }) => {
    // Use a known-existing primary swatch from the documented palette
    // (`frontend/src/configurator/controls/colors/colorSwatches.ts`).
    // The format is `primary-swatch-#<lowercase-hex>` per the source
    // component's `data-testid` template.
    const royalBlueSwatch = page.getByTestId('primary-swatch-#1e88e5');
    await royalBlueSwatch.click();
    await expect(royalBlueSwatch).toHaveAttribute('aria-checked', 'true');

    // Change finish.
    await page.getByTestId(finishOptionTestId('glossy')).click();
    await expect(page.getByTestId(finishOptionTestId('glossy'))).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Primary color selection preserved.
    await expect(royalBlueSwatch).toHaveAttribute('aria-checked', 'true');
  });

  // -------------------------------------------------------------------------
  // Section D — Disabled-combination matrix (ST-013)
  // -------------------------------------------------------------------------

  test.describe('disabled-combination matrix (ST-013)', () => {
    test('selecting spiral pattern disables the metallic finish (ST-013-AC1)', async ({
      page,
    }) => {
      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));

      // Pre-condition: with the default 'classic' pattern, every
      // finish is enabled.
      await expect(metallicOption).toBeEnabled();
      await expectAriaDisabledFalsy(metallicOption);

      // Select spiral pattern (one of the two patterns disabled
      // against metallic per `DISABLED_COMBINATIONS`).
      await page.getByTestId(patternOptionTestId('spiral')).click();
      await expect(page.getByTestId(patternOptionTestId('spiral'))).toHaveAttribute(
        'aria-checked',
        'true',
      );

      // Metallic finish becomes disabled.
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      // Matte and glossy remain enabled.
      await expectAriaDisabledFalsy(page.getByTestId(finishOptionTestId('matte')));
      await expectAriaDisabledFalsy(page.getByTestId(finishOptionTestId('glossy')));
    });

    test('selecting star pattern disables the metallic finish (ST-013-AC1)', async ({
      page,
    }) => {
      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await expect(metallicOption).toBeEnabled();

      await page.getByTestId(patternOptionTestId('star')).click();
      await expect(page.getByTestId(patternOptionTestId('star'))).toHaveAttribute(
        'aria-checked',
        'true',
      );

      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      // Matte and glossy remain enabled.
      await expectAriaDisabledFalsy(page.getByTestId(finishOptionTestId('matte')));
      await expectAriaDisabledFalsy(page.getByTestId(finishOptionTestId('glossy')));
    });

    test('selecting non-conflicting patterns leaves all three finishes enabled', async ({
      page,
    }) => {
      // Patterns NOT in DISABLED_COMBINATIONS' value lists for any
      // finish — the four "always-enabled" patterns.
      const enabledPatterns: ReadonlyArray<typeof PATTERNS[number]['value']> = [
        'classic',
        'hexagonal',
        'diamond',
        'grid',
      ];

      for (const pattern of enabledPatterns) {
        await page.getByTestId(patternOptionTestId(pattern)).click();
        await expect(page.getByTestId(patternOptionTestId(pattern))).toHaveAttribute(
          'aria-checked',
          'true',
        );

        for (const finish of FINISHES) {
          const option = page.getByTestId(finishOptionTestId(finish.value));
          await expectAriaDisabledFalsy(option);
          await expect(option).toBeEnabled();
        }
      }
    });

    test('disabled metallic finish exposes aria-describedby pointing to a tooltip element (ST-013-AC2)', async ({
      page,
    }) => {
      // Setup: pick spiral pattern → metallic disabled.
      await page.getByTestId(patternOptionTestId('spiral')).click();

      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      // The disabled option exposes a tooltip via aria-describedby.
      const ariaDescribedBy = await metallicOption.getAttribute('aria-describedby');
      expect(ariaDescribedBy).not.toBeNull();
      expect(ariaDescribedBy!.length).toBeGreaterThan(0);

      // The id referenced by aria-describedby is present on the
      // tooltip element. We use an attribute selector (`[id="…"]`)
      // rather than an `#id` selector with `CSS.escape(...)` because
      // `CSS` is a browser DOM API and is not defined in Node.js
      // (the Playwright test context). The attribute selector is
      // safe for any id value and Playwright resolves it identically.
      const tooltipById = page.locator(`[id="${ariaDescribedBy!}"]`);
      await expect(tooltipById).toHaveCount(1);
      await expect(tooltipById).toHaveAttribute('role', 'tooltip');
    });

    test('disabled metallic tooltip has role="tooltip" and explanatory text (ST-013-AC2)', async ({
      page,
    }) => {
      // Setup: pick spiral pattern.
      await page.getByTestId(patternOptionTestId('spiral')).click();

      const tooltip = page.getByTestId(finishTooltipTestId('metallic'));
      // The tooltip element exists in the DOM (the conditional render
      // returns the component when disabled is true).
      await expect(tooltip).toHaveCount(1);
      await expect(tooltip).toHaveAttribute('role', 'tooltip');

      // The text contains both context items (the finish and the
      // pattern) so a screen reader can construct a complete
      // explanation.
      await expect(tooltip).toContainText(/metallic/i);
      await expect(tooltip).toContainText(/spiral/i);
    });

    test('hovering a disabled metallic option reveals the tooltip (ST-013-AC2)', async ({
      page,
    }) => {
      // Setup: pick spiral pattern.
      await page.getByTestId(patternOptionTestId('spiral')).click();

      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      const tooltip = page.getByTestId(finishTooltipTestId('metallic'));
      // Initially hidden (no hover, no focus).
      await expect(tooltip).toHaveAttribute('data-visible', 'false');

      // Hover the disabled option. `force: true` is necessary because
      // Playwright's hover() actionability check refuses to interact
      // with an `aria-disabled="true"` element by default.
      await metallicOption.hover({ force: true });

      // Tooltip becomes visible.
      await expect(tooltip).toHaveAttribute('data-visible', 'true');

      // Move the mouse to a neutral location so the hover is
      // released — the tooltip then hides again.
      await page.mouse.move(0, 0);
      await expect(tooltip).toHaveAttribute('data-visible', 'false');
    });

    test('focusing a disabled metallic option reveals the tooltip (ST-013-AC2)', async ({
      page,
    }) => {
      // Setup: pick spiral pattern.
      await page.getByTestId(patternOptionTestId('spiral')).click();

      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      const tooltip = page.getByTestId(finishTooltipTestId('metallic'));
      await expect(tooltip).toHaveAttribute('data-visible', 'false');

      // Focus the disabled option directly via DOM focus(). Disabled
      // options use `aria-disabled` (not the HTML `disabled`
      // attribute) precisely so they remain keyboard-focusable per
      // ST-013-AC2.
      await metallicOption.focus();

      await expect(tooltip).toHaveAttribute('data-visible', 'true');

      // Blur to hide the tooltip again.
      await metallicOption.blur();
      await expect(tooltip).toHaveAttribute('data-visible', 'false');
    });

    test('clicking a disabled metallic finish does NOT change the selection (ST-013-AC3)', async ({
      page,
    }) => {
      // Setup: pick spiral pattern → metallic disabled.
      await page.getByTestId(patternOptionTestId('spiral')).click();
      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      // Pre-state: matte is the active finish (default carries over
      // because the pattern change does not implicitly change the
      // finish).
      const matteOption = page.getByTestId(finishOptionTestId('matte'));
      await expect(matteOption).toHaveAttribute('aria-checked', 'true');
      await expect(metallicOption).toHaveAttribute('aria-checked', 'false');

      // Force-click the disabled metallic option. Playwright's
      // default `click()` would refuse the action because the element
      // has `aria-disabled="true"`. The force option bypasses the
      // actionability check and verifies the application's defensive
      // guard inside `onClick` (early return when `disabled` is true).
      await metallicOption.click({ force: true });

      // Selection unchanged.
      await expect(matteOption).toHaveAttribute('aria-checked', 'true');
      await expect(metallicOption).toHaveAttribute('aria-checked', 'false');

      // Spiral pattern still active (the click should not have
      // bubbled to any other state slice).
      await expect(page.getByTestId(patternOptionTestId('spiral'))).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    test('restoring a compatible pattern re-enables the previously disabled finish (ST-013-AC4)', async ({
      page,
    }) => {
      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));

      // Disable metallic by selecting spiral.
      await page.getByTestId(patternOptionTestId('spiral')).click();
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId(finishTooltipTestId('metallic'))).toHaveCount(1);

      // Restore the documented default pattern (classic), which has
      // no disabled finishes.
      await page.getByTestId(patternOptionTestId(DEFAULT_PATTERN)).click();
      await expect(page.getByTestId(patternOptionTestId(DEFAULT_PATTERN))).toHaveAttribute(
        'aria-checked',
        'true',
      );

      // Metallic is re-enabled.
      await expectAriaDisabledFalsy(metallicOption);
      await expect(metallicOption).toBeEnabled();

      // Tooltip element no longer rendered (the conditional render
      // returns null when the option is enabled).
      await expect(page.getByTestId(finishTooltipTestId('metallic'))).toHaveCount(0);

      // The aria-describedby attribute is removed from the now-
      // enabled metallic option.
      const ariaDescribedBy = await metallicOption.getAttribute('aria-describedby');
      expect(ariaDescribedBy).toBeNull();
    });

    test('all six patterns remain selectable regardless of finish (implementation chose finish-side enforcement)', async ({
      page,
    }) => {
      // Verify ST-013's "conflicting option" requirement is enforced
      // on the FINISH side only — the pattern selector does NOT
      // disable spiral or star when metallic is the active finish.
      // This is the documented architectural choice in
      // `StitchingPatternSelector.tsx`, which intentionally does not
      // consult `isCombinationDisabled`.
      await page.getByTestId(finishOptionTestId('metallic')).click();
      await expect(page.getByTestId(finishOptionTestId('metallic'))).toHaveAttribute(
        'aria-checked',
        'true',
      );

      for (const pattern of PATTERNS) {
        const option = page.getByTestId(patternOptionTestId(pattern.value));
        // Pattern options are always enabled; aria-disabled is never
        // set on a pattern button.
        await expect(option).toBeEnabled();
        const ariaDisabled = await option.getAttribute('aria-disabled');
        expect(ariaDisabled).toBeNull();
      }
    });

    test('every documented disabled pair (spiral+metallic, star+metallic) is enforced', async ({
      page,
    }) => {
      // Iterate the disabled-combinations matrix declared by the
      // source `patternCatalog.ts` and exercise each one. Selecting
      // the conflict pattern MUST disable the conflict finish; the
      // tooltip MUST be present. This catches future regressions if
      // the matrix is changed.
      for (const pair of DISABLED_PAIRS) {
        // Reset to a known compatible state between iterations.
        await page.getByTestId(patternOptionTestId(DEFAULT_PATTERN)).click();
        await expect(page.getByTestId(patternOptionTestId(DEFAULT_PATTERN))).toHaveAttribute(
          'aria-checked',
          'true',
        );
        await expectAriaDisabledFalsy(page.getByTestId(finishOptionTestId(pair.finish)));

        // Now select the conflicting pattern.
        await page.getByTestId(patternOptionTestId(pair.pattern)).click();
        await expect(page.getByTestId(patternOptionTestId(pair.pattern))).toHaveAttribute(
          'aria-checked',
          'true',
        );

        // Conflicting finish becomes disabled.
        const conflictingFinish = page.getByTestId(finishOptionTestId(pair.finish));
        await expect(conflictingFinish).toHaveAttribute('aria-disabled', 'true');
        await expect(conflictingFinish).toHaveAttribute('aria-describedby', /\S/);

        // Tooltip element present with role="tooltip".
        const tooltip = page.getByTestId(finishTooltipTestId(pair.finish));
        await expect(tooltip).toHaveCount(1);
        await expect(tooltip).toHaveAttribute('role', 'tooltip');
      }
    });

    test('previously selected finish keeps aria-checked while becoming disabled', async ({
      page,
    }) => {
      // Pick metallic with a compatible pattern (classic).
      const metallicOption = page.getByTestId(finishOptionTestId('metallic'));
      await metallicOption.click();
      await expect(metallicOption).toHaveAttribute('aria-checked', 'true');
      await expectAriaDisabledFalsy(metallicOption);

      // Switch to a conflicting pattern (spiral).
      await page.getByTestId(patternOptionTestId('spiral')).click();
      await expect(page.getByTestId(patternOptionTestId('spiral'))).toHaveAttribute(
        'aria-checked',
        'true',
      );

      // Metallic remains aria-checked="true" (the slice did not
      // change) but is now also aria-disabled="true". This is the
      // documented "selected but disabled" UX — the user sees a clear
      // indication that the chosen finish is incompatible with the
      // chosen pattern, and the tooltip explains the resolution path.
      await expect(metallicOption).toHaveAttribute('aria-checked', 'true');
      await expect(metallicOption).toHaveAttribute('aria-disabled', 'true');

      // Tooltip is in the DOM with role="tooltip".
      await expect(page.getByTestId(finishTooltipTestId('metallic'))).toHaveCount(1);
      await expect(page.getByTestId(finishTooltipTestId('metallic'))).toHaveAttribute(
        'role',
        'tooltip',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Section E — Sibling controls coexist
  // -------------------------------------------------------------------------

  test('finish selector coexists with the stitching-pattern selector and color pickers', async ({
    page,
  }) => {
    // Sanity check: the finish picker, pattern picker, and primary
    // color picker are all present. Disabled-combination logic relies
    // on this co-presence — a regression that hides the pattern
    // selector would break the matrix.
    await expect(page.getByTestId(FINISH_SELECTOR_TESTID)).toBeVisible();
    await expect(page.getByTestId(STITCHING_PATTERN_SELECTOR_TESTID)).toBeVisible();
    await expect(page.getByTestId('primary-color-picker')).toBeVisible();
  });
});
