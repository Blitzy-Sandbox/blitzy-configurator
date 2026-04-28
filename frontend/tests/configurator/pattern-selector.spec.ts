/**
 * Stitching pattern selector Playwright spec — Gate T2 verification for
 * ST-010 with cross-cutting checks for ST-013 (disabled-combination
 * isolation) and ST-022 (summary sidebar reflection).
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       `frontend/tests/configurator/*.spec.ts` —
 *       Configurator smoke + interaction tests (Gate T2).
 *   - AAP §0.6.7 Track 2 Frontend Core: `StitchingPatternSelector.tsx`
 *       (ST-010) is a Track 2 deliverable rendering six pattern radio
 *       options. The default finish (matte) leaves all six patterns
 *       enabled; the disabled-combination matrix is exercised in
 *       `finish-selector.spec.ts`.
 *   - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *       `cd frontend && npx playwright test --project=chromium tests/configurator/`
 *       — all pass.
 *   - Story coverage (per the source story files):
 *       ST-010-AC1 — Six stitching pattern options named Classic,
 *                    Hexagonal, Diamond, Spiral, Star, and Grid are
 *                    visible in the control sidebar.
 *       ST-010-AC2 — Selecting a pattern applies it within the
 *                    documented latency budget; the selection is
 *                    visibly marked active.
 *       ST-010-AC3 — The currently selected pattern remains visually
 *                    marked as active in the sidebar after selection.
 *       ST-022 (related) — Pattern selection is reflected in the live
 *                          design summary sidebar.
 *       ST-009 (cross-cutting) — Pattern changes do NOT reset color
 *                                 picker selections, finish selection,
 *                                 or other slices.
 *
 * ===========================================================================
 * Implementation alignment notes
 * ===========================================================================
 *
 * The agent prompt for this file outlined a `radiogroup` role + an
 * `aria-label="Stitching pattern"` on the testid-bearing element, plus
 * `primary-color-swatch-{hex}` and `material-finish-option-{value}`
 * testid prefixes for cross-control isolation tests. The actual frontend
 * source code (`frontend/src/configurator/controls/pattern/
 * StitchingPatternSelector.tsx`,
 * `frontend/src/configurator/controls/pattern/FinishSelector.tsx`,
 * `frontend/src/configurator/controls/colors/PrimaryColorPicker.tsx`)
 * ships with a slightly different, but more accessibility-correct,
 * DOM contract:
 *
 *   - The `data-testid="stitching-pattern-selector"` lives on the outer
 *     `<section>` which carries `aria-label="Stitching pattern"` but no
 *     role. The inner `<ul>` carries `role="radiogroup"` and
 *     `aria-label="Stitching pattern options"` so assistive technology
 *     can address the radiogroup unambiguously even though the page
 *     contains other radiogroups (color pickers, finish selector). This
 *     mirrors the convention used by the sibling
 *     `finish-selector.spec.ts`.
 *   - Color swatches use `data-testid="primary-swatch-#<lowercase-hex>"`
 *     (the `#` is part of the testid, the hex is lower-cased) per
 *     `PrimaryColorPicker.tsx` line 94.
 *   - Finish options use `data-testid="finish-option-<value>"` per
 *     `FinishSelector.tsx` line 140.
 *   - The summary sidebar is an `<aside>` with `role="complementary"`
 *     and `aria-label="Current design summary"` per `App.tsx` line 142.
 *     We address it through a defensive locator chain identical to
 *     `summary-sidebar.spec.ts` so the spec is resilient to the future
 *     `role="region"` promotion.
 *
 * This spec adopts the shipped DOM contract verbatim so the tests run
 * against the real component output. None of the substitutions weaken
 * the AC coverage — every ST-010 acceptance criterion is still checked.
 *
 * ===========================================================================
 * Why this spec does NOT exercise disabled combinations
 * ===========================================================================
 *
 * The default `materialFinish` slice value declared by
 * `frontend/src/state/configuratorStore.ts` `CONFIGURATOR_DEFAULTS`
 * (DEFAULT_FINISH === 'matte') leaves ALL six patterns enabled because
 * the `DISABLED_COMBINATIONS` map only conflicts metallic with
 * spiral/star. The pattern selector ALSO does not call
 * `isCombinationDisabled` (see the architectural note in
 * `StitchingPatternSelector.tsx` and the alignment block in
 * `finish-selector.spec.ts`), so pattern buttons are always enabled
 * regardless of finish.
 *
 * This means: in this spec, every click on a pattern option succeeds
 * and the disabled-state matrix never appears. That isolation is
 * intentional — disabled-combination behavior is the responsibility of
 * `finish-selector.spec.ts`, which exercises every (pattern × finish)
 * conflict pair. Splitting the concerns keeps each spec focused on a
 * single user journey.
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
 * The `<section>` rendered by `StitchingPatternSelector.tsx`. The
 * section is the stable mount point for the entire pattern picker
 * surface. Its inner `<ul>` is the actual `role="radiogroup"`, while
 * the section itself carries `aria-label="Stitching pattern"` (without
 * a role).
 */
const PATTERN_SELECTOR_TESTID = 'stitching-pattern-selector';

/**
 * The accessible label applied to the `<section>` rendered by
 * `StitchingPatternSelector.tsx`. Per ST-010-AC1 the picker is
 * identified to assistive technology via this string.
 */
const PATTERN_SECTION_ARIA_LABEL = 'Stitching pattern';

/**
 * The accessible name applied to the inner `<ul role="radiogroup">`
 * rendered by `StitchingPatternSelector.tsx`. Used to address the
 * radiogroup unambiguously even though the page contains other
 * radiogroups (color pickers, finish selector).
 */
const PATTERN_RADIOGROUP_NAME = 'Stitching pattern options';

/**
 * The default `stitchingPattern` slice value declared by
 * `frontend/src/state/configuratorStore.ts` `CONFIGURATOR_DEFAULTS`
 * (DEFAULT_PATTERN === 'classic'). The default pattern on first
 * render MUST be classic per ST-010 alignment with the documented
 * store defaults.
 */
const DEFAULT_PATTERN = 'classic' as const;

/**
 * The complete stitching-pattern catalog, mirroring
 * `frontend/src/configurator/controls/pattern/patternCatalog.ts`.
 * The order matches the array declared in that catalog so both
 * presentation order and keyboard tab order are deterministic.
 *
 * Per ST-010-AC1 the six options are named exactly:
 *   Classic, Hexagonal, Diamond, Spiral, Star, Grid.
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
 * A non-default primary color swatch from the curated palette declared
 * in `frontend/src/configurator/controls/colors/colorSwatches.ts`. The
 * Royal Blue swatch is one of the eight primary swatches and is NOT
 * the documented store default (`#FFFFFF` White); we use it to verify
 * cross-control isolation between pattern selection and primary color
 * selection. The testid format is `primary-swatch-#<lowercase-hex>`
 * per `PrimaryColorPicker.tsx`.
 */
const NON_DEFAULT_PRIMARY_HEX = '#1e88e5'; // Royal blue
const DEFAULT_PRIMARY_HEX = '#ffffff'; // White (the documented default)

/**
 * Pattern-change settle time. ST-010-AC2 requires the selection
 * effect within a documented latency budget; the existing
 * configurator latency budget per ST-009 is well under one second.
 * 750 ms is comfortable headroom for a software-WebGL CI runner and
 * avoids racing the texture pipeline's rAF settlement, while keeping
 * each test fast.
 */
const PATTERN_PERSISTENCE_WAIT_MS = 750;

/**
 * Default Vite `<canvas>` attach timeout. Aligned with the sibling
 * specs (`configurator-load.spec.ts`, `summary-sidebar.spec.ts`,
 * `finish-selector.spec.ts`) so behavior is uniform across the suite.
 */
const CANVAS_ATTACH_TIMEOUT_MS = 15_000;

/**
 * Defensive accessible-name regex for the design summary sidebar. The
 * current implementation uses `aria-label="Current design summary"`;
 * the sibling `summary-sidebar.spec.ts` documents that this regex
 * matches both the current wording and a future "Design summary"
 * promotion. We mirror that convention here so renaming the sidebar
 * does not break this spec.
 */
const SUMMARY_ARIA_LABEL_REGEX = /design summary|current design summary/i;

/**
 * Canonical `data-testid` for the summary sidebar. Per
 * `App.tsx` `DesignSummarySidebar`, this is the most stable
 * identifier and is the primary arm of the defensive locator chain.
 */
const SUMMARY_TESTID = 'design-summary-sidebar';

// ---------------------------------------------------------------------------
// Helpers — selector composition
// ---------------------------------------------------------------------------

/**
 * Build the `data-testid` for a pattern option. Mirrors the
 * `data-testid={`stitching-pattern-option-${entry.value}`}` template
 * from `StitchingPatternSelector.tsx`.
 */
function patternOptionTestId(pattern: string): string {
  return `stitching-pattern-option-${pattern}`;
}

/**
 * Build the `data-testid` for a finish option. Mirrors the
 * `data-testid={`finish-option-${entry.value}`}` template from
 * `FinishSelector.tsx`. Used by the cross-control isolation tests
 * that verify pattern changes do not clobber the finish slice.
 */
function finishOptionTestId(finish: string): string {
  return `finish-option-${finish}`;
}

/**
 * Build the `data-testid` for a primary color swatch. Mirrors the
 * `data-testid={`primary-swatch-${swatch.value.toLowerCase()}`}`
 * template from `PrimaryColorPicker.tsx`. Note that the `#` is
 * present in `swatch.value` and remains in the testid; the hex is
 * lower-cased.
 */
function primarySwatchTestId(hex: string): string {
  return `primary-swatch-${hex.toLowerCase()}`;
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
  // the React tree from mounting. Fix: filter at routing time using a
  // function predicate that requires the URL pathname to start with
  // `/api/` (no `/src/` prefix), so Vite serves frontend source files
  // normally.
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
 *      accidentally hovered (which could pre-reveal an unrelated
 *      tooltip and confuse assertions in this spec or sibling specs
 *      sharing the test runner).
 *   5. Wait one more `networkidle` cycle for any post-canvas-mount
 *      effects (state hydration, store subscriptions firing) to
 *      settle.
 *
 * Identical helper to the one used by the sibling specs
 * (`configurator-load.spec.ts`, `summary-sidebar.spec.ts`,
 * `finish-selector.spec.ts`, `logo-upload.spec.ts`) so behavior is
 * consistent across the suite.
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
 * Locate the design summary sidebar using a defensive locator chain.
 * Mirrors the convention from `summary-sidebar.spec.ts`:
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
 * The `Locator.or()` chain returns the first locator that matches; if
 * NONE match the test fails with a clear error rather than a false
 * negative.
 */
function locateSummarySidebar(page: Page): Locator {
  return page
    .getByTestId(SUMMARY_TESTID)
    .or(page.getByRole('region', { name: SUMMARY_ARIA_LABEL_REGEX }))
    .or(page.getByRole('complementary', { name: SUMMARY_ARIA_LABEL_REGEX }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Stitching pattern selector (ST-010)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackendApi(page);
    await waitForConfiguratorReady(page);
  });

  // -------------------------------------------------------------------------
  // Section A — Rendering and structure (ST-010-AC1)
  // -------------------------------------------------------------------------

  test('renders the stitching-pattern selector section with the documented aria-label', async ({
    page,
  }) => {
    const selector = page.getByTestId(PATTERN_SELECTOR_TESTID);
    await expect(selector).toBeVisible();
    await expect(selector).toHaveAttribute('aria-label', PATTERN_SECTION_ARIA_LABEL);
  });

  test('exposes the inner radiogroup by role and accessible name', async ({ page }) => {
    // The radiogroup role lives on the inner <ul>, NOT on the section.
    // We address it by accessible name to disambiguate from the other
    // radiogroups on the page (color pickers, finish selector).
    const radiogroup = page.getByRole('radiogroup', { name: PATTERN_RADIOGROUP_NAME });
    await expect(radiogroup).toBeVisible();
  });

  test('renders exactly six pattern options (Classic, Hexagonal, Diamond, Spiral, Star, Grid)', async ({
    page,
  }) => {
    for (const pattern of PATTERNS) {
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      await expect(option).toBeVisible();
      await expect(option).toHaveAttribute('role', 'radio');
    }

    // Confirm there are no extra options beyond the six documented
    // ones — guards against accidental palette expansion that would
    // violate ST-010-AC1's "exactly six options" requirement.
    const allOptions = page.locator('[data-testid^="stitching-pattern-option-"]');
    await expect(allOptions).toHaveCount(6);
  });

  test('renders pattern options in the documented DOM order', async ({ page }) => {
    // ST-010-AC1 names the patterns in the order: Classic, Hexagonal,
    // Diamond, Spiral, Star, Grid. This order matters for keyboard
    // navigation (Tab / ArrowKeys cycle through the radiogroup in DOM
    // order) and for visual regression baselines.
    const allOptions = page.locator('[data-testid^="stitching-pattern-option-"]');
    const renderedTestIds = await allOptions.evaluateAll((els: Element[]) =>
      els.map((el) => el.getAttribute('data-testid')),
    );

    expect(renderedTestIds).toEqual(PATTERNS.map((p) => patternOptionTestId(p.value)));
  });

  test('each pattern option has the correct accessible label', async ({ page }) => {
    for (const pattern of PATTERNS) {
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      // The accessible name MUST include the human-readable pattern
      // label (case-insensitive) so screen readers announce which
      // pattern is which. The component composes the label as
      // `Stitching pattern <Label> [(selected)]. <Description>` —
      // we assert only the substring containment of the label here
      // to remain decoupled from the description copy.
      const ariaLabel = await option.getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel!.toLowerCase()).toContain(pattern.label.toLowerCase());
    }
  });

  // -------------------------------------------------------------------------
  // Section B — Default state
  // -------------------------------------------------------------------------

  test('default pattern is "classic" with aria-checked="true" on first render', async ({
    page,
  }) => {
    const classicOption = page.getByTestId(patternOptionTestId(DEFAULT_PATTERN));
    await expect(classicOption).toHaveAttribute('aria-checked', 'true');

    // All other options MUST be aria-checked="false". React renders
    // the boolean `aria-checked={false}` as the literal string
    // `"false"` — the radiogroup contract requires every non-selected
    // option to expose this state to assistive technology.
    for (const pattern of PATTERNS) {
      if (pattern.value === DEFAULT_PATTERN) continue;
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      await expect(option).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('every pattern option is enabled with the default finish (matte)', async ({
    page,
  }) => {
    // The default finish is matte, which leaves all six patterns
    // enabled per the DISABLED_COMBINATIONS map. Even so the pattern
    // selector itself never sets aria-disabled — it is always
    // free-clickable. This test guards against a future regression
    // that would inadvertently disable pattern options.
    for (const pattern of PATTERNS) {
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      await expect(option).toBeEnabled();
      // aria-disabled is intentionally never set on a pattern button.
      const ariaDisabled = await option.getAttribute('aria-disabled');
      expect(ariaDisabled).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // Section C — Selection behavior (ST-010-AC2 / ST-010-AC3)
  // -------------------------------------------------------------------------

  test('clicking hexagonal selects it and deselects classic (ST-010-AC2)', async ({
    page,
  }) => {
    const classic = page.getByTestId(patternOptionTestId('classic'));
    const hexagonal = page.getByTestId(patternOptionTestId('hexagonal'));

    await expect(classic).toHaveAttribute('aria-checked', 'true');

    await hexagonal.click();

    await expect(hexagonal).toHaveAttribute('aria-checked', 'true');
    await expect(classic).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking each non-default pattern marks it active and deselects the previous (ST-010-AC2)', async ({
    page,
  }) => {
    // Walk through every non-default pattern in order. After each
    // click, exactly one option is aria-checked="true" and the other
    // five are "false". This exercises ST-010-AC1 (every pattern is
    // selectable) and ST-010-AC2 (radiogroup contract: only one
    // active at a time) in a single sequence.
    let previousValue: string = DEFAULT_PATTERN;

    for (const pattern of PATTERNS) {
      if (pattern.value === DEFAULT_PATTERN) continue;

      const option = page.getByTestId(patternOptionTestId(pattern.value));
      // Every pattern is enabled with the default finish (matte).
      // Asserting before each click catches regressions early.
      await expect(option).toBeEnabled();

      await option.click();

      // Newly clicked option becomes active.
      await expect(option).toHaveAttribute('aria-checked', 'true');

      // Previously selected option deactivates.
      const previousOption = page.getByTestId(patternOptionTestId(previousValue));
      await expect(previousOption).toHaveAttribute('aria-checked', 'false');

      previousValue = pattern.value;
    }
  });

  test('exactly one pattern is aria-checked="true" after each click (ST-010-AC2)', async ({
    page,
  }) => {
    // Iterate every pattern, click it, then verify the radiogroup
    // contract: precisely ONE option carries aria-checked="true".
    // Mirrors `finish-selector.spec.ts` "switching among all three"
    // pattern but for the six-option pattern selector.
    for (const target of PATTERNS) {
      await page.getByTestId(patternOptionTestId(target.value)).click();
      for (const pattern of PATTERNS) {
        const option = page.getByTestId(patternOptionTestId(pattern.value));
        await expect(option).toHaveAttribute(
          'aria-checked',
          pattern.value === target.value ? 'true' : 'false',
        );
      }
    }
  });

  test('pattern selection persists across a non-trivial wait (ST-010-AC3)', async ({
    page,
  }) => {
    const spiralOption = page.getByTestId(patternOptionTestId('spiral'));
    await spiralOption.click();
    await expect(spiralOption).toHaveAttribute('aria-checked', 'true');

    // Wait long enough to confirm the selection is persistent and
    // not a transient visual state. PATTERN_PERSISTENCE_WAIT_MS is
    // well beyond the documented latency budget.
    await page.waitForTimeout(PATTERN_PERSISTENCE_WAIT_MS);

    await expect(spiralOption).toHaveAttribute('aria-checked', 'true');
    // The default 'classic' is no longer selected.
    await expect(page.getByTestId(patternOptionTestId(DEFAULT_PATTERN))).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('rapid sequential pattern changes resolve to the last selection (ST-010-AC2)', async ({
    page,
  }) => {
    // Click four patterns in quick succession with no awaits between
    // them (Playwright still serializes the actions internally). The
    // final selection MUST be the last one clicked — proves the
    // store update is monotonic and that no race in the texture
    // pipeline reverts the slice.
    await page.getByTestId(patternOptionTestId('hexagonal')).click();
    await page.getByTestId(patternOptionTestId('diamond')).click();
    await page.getByTestId(patternOptionTestId('star')).click();
    await page.getByTestId(patternOptionTestId('grid')).click();

    const gridOption = page.getByTestId(patternOptionTestId('grid'));
    await expect(gridOption).toHaveAttribute('aria-checked', 'true');

    // Every other option, including the original default (classic),
    // is no longer active.
    for (const pattern of PATTERNS) {
      if (pattern.value === 'grid') continue;
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      await expect(option).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('clicking the already-selected pattern does not toggle it off (radiogroup contract)', async ({
    page,
  }) => {
    // Switch to diamond.
    const diamondOption = page.getByTestId(patternOptionTestId('diamond'));
    await diamondOption.click();
    await expect(diamondOption).toHaveAttribute('aria-checked', 'true');

    // Re-click the SAME option. ARIA radiogroup semantics mandate
    // that clicking an already-checked radio is a no-op (the user
    // must select a different option to deselect the current one).
    await diamondOption.click();
    await expect(diamondOption).toHaveAttribute('aria-checked', 'true');

    // Default classic is still not selected.
    await expect(page.getByTestId(patternOptionTestId(DEFAULT_PATTERN))).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('data-selected attribute mirrors aria-checked on the selected option', async ({
    page,
  }) => {
    // The component sets `data-selected="true"|"false"` alongside
    // `aria-checked` to give Playwright/Jest a stable selector
    // independent of ARIA state. Verifying both mirror each other
    // protects against accidentally diverging the two signals.
    await page.getByTestId(patternOptionTestId('star')).click();

    const starOption = page.getByTestId(patternOptionTestId('star'));
    await expect(starOption).toHaveAttribute('aria-checked', 'true');
    await expect(starOption).toHaveAttribute('data-selected', 'true');

    // Other options have data-selected="false".
    for (const pattern of PATTERNS) {
      if (pattern.value === 'star') continue;
      const option = page.getByTestId(patternOptionTestId(pattern.value));
      await expect(option).toHaveAttribute('data-selected', 'false');
    }
  });

  // -------------------------------------------------------------------------
  // Section D — Summary sidebar reflection (ST-022 cross-cutting)
  // -------------------------------------------------------------------------

  test('selecting a pattern updates the design summary sidebar value', async ({ page }) => {
    const summary = locateSummarySidebar(page);
    await expect(summary).toBeVisible();

    // Default summary mentions "Classic" (the human-readable label
    // for the default 'classic' pattern, per
    // `STITCHING_PATTERN_LABELS` in `App.tsx`). The summary row uses
    // the testid `summary-value-pattern`; addressing the row text
    // via `toContainText` is the most resilient assertion.
    await expect(summary).toContainText(/Classic/i);

    // Click Hexagonal.
    await page.getByTestId(patternOptionTestId('hexagonal')).click();

    // Summary now reflects Hexagonal. The 2_000 ms timeout matches
    // the AAP §0.6.7 documented update budget for control-driven
    // summary updates.
    await expect(summary).toContainText(/Hexagonal/i, { timeout: 2_000 });
  });

  test('summary sidebar value testid for pattern updates after selection', async ({
    page,
  }) => {
    // Direct assertion on the canonical summary-value-pattern testid
    // (per `App.tsx` `SummaryRow`'s data-testid template). This
    // complements the broader `toContainText` assertion above with a
    // more precise locator that catches future regressions where the
    // value text reflows into a different row.
    const patternValue = page.getByTestId('summary-value-pattern');
    await expect(patternValue).toBeVisible();
    await expect(patternValue).toHaveText(/Classic/i);

    await page.getByTestId(patternOptionTestId('grid')).click();
    await expect(patternValue).toHaveText(/Grid/i, { timeout: 2_000 });
  });

  // -------------------------------------------------------------------------
  // Section E — Cross-control isolation (ST-009 cross-cutting)
  // -------------------------------------------------------------------------

  test('pattern selection is independent of finish selection', async ({ page }) => {
    // Default finish is matte; verify it.
    const matteOption = page.getByTestId(finishOptionTestId('matte'));
    await expect(matteOption).toHaveAttribute('aria-checked', 'true');

    // Change pattern from classic to grid.
    await page.getByTestId(patternOptionTestId('grid')).click();
    await expect(page.getByTestId(patternOptionTestId('grid'))).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Finish selection is preserved — pattern change MUST NOT
    // clobber the materialFinish slice.
    await expect(matteOption).toHaveAttribute('aria-checked', 'true');
  });

  test('pattern selection is independent of primary color selection', async ({ page }) => {
    // Pre-condition: change a primary color to a non-default swatch.
    // We use Royal Blue (`#1E88E5`) — the testid is
    // `primary-swatch-#1e88e5` per the lower-cased `data-testid`
    // template in `PrimaryColorPicker.tsx`.
    const royalBlueSwatch = page.getByTestId(primarySwatchTestId(NON_DEFAULT_PRIMARY_HEX));
    await royalBlueSwatch.click();
    await expect(royalBlueSwatch).toHaveAttribute('aria-checked', 'true');

    // Change pattern from classic to diamond.
    const diamondOption = page.getByTestId(patternOptionTestId('diamond'));
    await diamondOption.click();
    await expect(diamondOption).toHaveAttribute('aria-checked', 'true');

    // Primary color selection is preserved — pattern change MUST NOT
    // clobber the primaryColor slice.
    await expect(royalBlueSwatch).toHaveAttribute('aria-checked', 'true');

    // The default White swatch is still not selected.
    const whiteSwatch = page.getByTestId(primarySwatchTestId(DEFAULT_PRIMARY_HEX));
    await expect(whiteSwatch).toHaveAttribute('aria-checked', 'false');
  });

  // -------------------------------------------------------------------------
  // Section F — Layout resilience
  // -------------------------------------------------------------------------

  test('pattern selection persists across viewport resize', async ({ page }) => {
    // Pick a non-default pattern.
    const spiralOption = page.getByTestId(patternOptionTestId('spiral'));
    await spiralOption.click();
    await expect(spiralOption).toHaveAttribute('aria-checked', 'true');

    // Resize the viewport to a smaller laptop size. R3F's <Canvas>
    // reacts to a `ResizeObserver`; this test guards against a
    // regression where re-mounting the canvas would reset the
    // pattern selector's component state.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForLoadState('networkidle');

    // Selection persists across the resize.
    await expect(spiralOption).toHaveAttribute('aria-checked', 'true');
  });

  // -------------------------------------------------------------------------
  // Section G — Co-presence with sibling controls
  // -------------------------------------------------------------------------

  test('stitching-pattern selector coexists with the finish selector and color pickers', async ({
    page,
  }) => {
    // Sanity check: the pattern picker, finish picker, and primary
    // color picker are all present in the control sidebar. This
    // co-presence is required for the cross-control isolation tests
    // above and for the disabled-combination matrix in the sibling
    // `finish-selector.spec.ts`.
    await expect(page.getByTestId(PATTERN_SELECTOR_TESTID)).toBeVisible();
    await expect(page.getByTestId('finish-selector')).toBeVisible();
    await expect(page.getByTestId('primary-color-picker')).toBeVisible();
  });
});
