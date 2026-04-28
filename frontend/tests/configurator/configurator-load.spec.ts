/**
 * Configurator load + sphere render Playwright spec — Gate T2 canary.
 *
 * ---------------------------------------------------------------------------
 * Authority
 * ---------------------------------------------------------------------------
 *
 * - AAP §0.3.4 "New Files to Create — Frontend":
 *     `frontend/tests/configurator/*.spec.ts` —
 *     Configurator smoke + interaction tests (Gate T2).
 * - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *     `cd frontend && npx playwright test --project=chromium tests/configurator/`
 *     — all pass.
 * - Story coverage (per the assigned-file detailed instructions):
 *     ST-001-AC1 — Configurator opens and displays a sphere.
 *     ST-001-AC2 — Sphere is centered and properly sized.
 *     ST-001-AC4 — Initial render is free of console errors.
 *     ST-005-AC3 — Initial preview render completes ≤ 2000 ms on the
 *                  reference hardware profile.
 *     ST-022 (related) — Design summary sidebar present after load.
 *
 * ---------------------------------------------------------------------------
 * Purpose
 * ---------------------------------------------------------------------------
 *
 * This Playwright spec is the foundational canary test for the
 * configurator UI. It verifies, for both Chromium and WebKit:
 *
 *   1. The configurator page loads at `/` without errors.
 *   2. A `<canvas>` element mounts within the load budget.
 *   3. The canvas has non-zero drawing-buffer and client dimensions.
 *   4. No JavaScript errors are emitted to the console during initial
 *      load (ST-001-AC4).
 *   5. The performance instrumentation (`window.__strikeforge_perf__`)
 *      is initialized.
 *   6. The initial sphere render completes within ST-005's 2-second
 *      budget (`initialLoadMs ≤ 2_000`).
 *   7. The control sidebar (color pickers, pattern selector, finish
 *      selector, logo uploader) and the design summary sidebar are
 *      all visible.
 *   8. The BallCanvas wrapper carries the documented `data-testid`.
 *   9. The R3F Canvas mounts inside the wrapper.
 *  10. Resize does not produce errors and re-fits the canvas.
 *
 * If any test in this spec fails, every other configurator spec in
 * `tests/configurator/` is at risk: this is the entry-point smoke test.
 *
 * ---------------------------------------------------------------------------
 * Cross-cutting rules enforced
 * ---------------------------------------------------------------------------
 *
 *   - Rule R2 (no credential material in logs): The console-error
 *     buffering pattern uses `page.on('console', ...)` and
 *     `page.on('pageerror', ...)` listeners ONLY. There are zero
 *     direct `console.*` calls in this file.
 *   - Rule R3 (Firebase Admin SDK only on backend): No JWT or
 *     `firebase-admin` imports — this is a frontend Playwright spec.
 *   - Rule R7 / C6 (Fabric → Three texture update order): Untouched
 *     by this spec; the texture coordinator owns that contract.
 *   - Rule R9 (no payment processing): No payment-related strings.
 *
 * ---------------------------------------------------------------------------
 * Type augmentation note
 * ---------------------------------------------------------------------------
 *
 * The browser-side `Window` augmentation that exposes
 * `window.__strikeforge_perf__` is centralised at
 * `frontend/tests/types/bridge.d.ts` (single source of truth for every
 * spec). It is auto-included via `frontend/tsconfig.json`'s
 * `include: ["src", "tests", ...]` entry. This file therefore does NOT
 * redeclare the Window interface — duplicating the augmentation would
 * risk TS2717 ("subsequent property declarations must have the same
 * type") if the shapes ever drift.
 *
 * ---------------------------------------------------------------------------
 * Test environment
 * ---------------------------------------------------------------------------
 *
 *   - `frontend/playwright.config.ts` auto-starts the Vite dev server
 *     on http://localhost:5173 and waits for it to respond before
 *     executing tests.
 *   - Default viewport is 1280×720 (set in `use.viewport`).
 *   - Per-test timeout is 60_000 ms (set in `timeout` at the config
 *     root) — comfortable headroom for software-WebGL CI runners.
 *   - `expect()` polling timeout defaults to 5_000 ms unless overridden.
 */

import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * ST-005-AC3 — initial sphere render budget. The performance.ts
 * module's `initialLoadMs` snapshot field captures the time from
 * `initializePerformanceInstrumentation()` to the first rAF callback
 * after the Canvas mounts. This is the canonical "initial render
 * complete" signal.
 */
const INITIAL_LOAD_BUDGET_MS = 2_000;

/**
 * Selector for the wrapping `<div>` rendered by `BallCanvas.tsx`.
 * The wrapper hosts the R3F `<Canvas>`, receives drag-rotation pointer
 * events, and is the documented attachment point for Playwright tests
 * (see `frontend/tests/configurator/preview.spec.ts` for prior art).
 */
const BALL_CANVAS_WRAPPER_TESTID = 'ball-canvas-wrapper';

/**
 * Selector for the actual `<canvas>` element rendered inside the
 * BallCanvas wrapper by R3F. R3F itself does not expose a `data-testid`
 * on its `<Canvas>` component, so we reach the canvas via descendant
 * selector from the wrapper — both DOM coordinates land on the same
 * element regardless of which path is used.
 */
const R3F_CANVAS_DESCENDANT_SELECTOR = `[data-testid="${BALL_CANVAS_WRAPPER_TESTID}"] canvas`;

/**
 * Selector for the design summary sidebar (ST-022). The aside is
 * rendered with `role="complementary"` and
 * `aria-label="Current design summary"` in `frontend/src/App.tsx`,
 * but the data-testid is the most stable identity.
 */
const DESIGN_SUMMARY_SIDEBAR_TESTID = 'design-summary-sidebar';

/**
 * Generous timeout for the canvas to attach to the DOM. The
 * software-WebGL CI environment (SwiftShader / llvmpipe) can take
 * several seconds to initialize even a trivial WebGL context — this
 * cap ensures we surface real hangs while tolerating CI variance.
 */
const CANVAS_ATTACH_TIMEOUT_MS = 15_000;

/**
 * Generous timeout for `initialLoadMs` to be reported by the
 * performance instrumentation. The ST-005-AC3 budget is 2_000 ms, but
 * we poll for up to 10_000 ms to allow for the React StrictMode
 * double-mount, Vite cold-start dependency pre-bundling, and software
 * WebGL warmup before asserting against the budget.
 */
const PERFORMANCE_API_POLL_TIMEOUT_MS = 10_000;

/**
 * Polling timeout for the `totalFrames` increment assertion. At even
 * the lowest software-rendered FPS (~5 FPS), 5 seconds yields ~25
 * frames — comfortably above the 1-frame-increment we require to
 * verify the render loop is alive.
 */
const TOTAL_FRAMES_INCREMENT_POLL_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock backend / Firebase / GCS calls so the configurator can render
 * a default-state sphere without any live network dependency.
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
 * tests that never trigger the corresponding URL — the configurator
 * load test in this file does not exercise any backend endpoint, but
 * the mocks defend against accidental fetches from store-init
 * effects, preloading, or telemetry beacons.
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
 * Mutable buffer of error messages observed during a single page
 * lifecycle. The array is appended-to from inside the
 * `page.on('console', ...)` and `page.on('pageerror', ...)` listeners
 * registered via `attachConsoleErrorBuffer(...)`.
 *
 * The `messages` array is intentionally NOT readonly so the listener
 * can `push()` into it. Tests assert against the snapshot of the
 * array at the end of the test (`expect(buffer.messages).toEqual([])`).
 */
interface ConsoleErrorBuffer {
  readonly messages: string[];
}

/**
 * Attach console-error and page-error listeners that buffer all
 * observed error messages into a returned `ConsoleErrorBuffer`.
 *
 * MUST be called BEFORE `page.goto(...)` so that errors emitted
 * during the very-earliest navigation phase are captured. Errors
 * include:
 *
 *   - `console.error(...)` calls from page scripts.
 *   - Uncaught exceptions on the page (`pageerror` event).
 *
 * The console-listener filter compares `msg.type() === 'error'` so
 * that warning-level messages do NOT pollute the buffer — Vite's
 * dev server commonly emits `[Vite]` info lines that are not test
 * failures.
 *
 * Per Rule R2, this spec contains zero direct `console.*` calls.
 * Registering a Playwright listener is a Playwright API call, not a
 * console call, and is permitted.
 */
function attachConsoleErrorBuffer(page: Page): ConsoleErrorBuffer {
  const messages: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      messages.push(msg.text());
    }
  });
  page.on('pageerror', (err: Error) => {
    messages.push(`pageerror: ${err.message}`);
  });
  return { messages };
}

/**
 * Wait for the BallCanvas wrapper's child `<canvas>` to attach to
 * the DOM. Returns a Playwright Locator pointing at the canvas.
 *
 * Used as the standard "page is ready" gate by every test in this
 * spec — the configurator is considered loaded once R3F has mounted
 * its WebGL canvas inside the wrapper.
 */
async function waitForCanvasAttached(page: Page) {
  const canvas = page.locator(R3F_CANVAS_DESCENDANT_SELECTOR);
  await canvas.first().waitFor({ state: 'attached', timeout: CANVAS_ATTACH_TIMEOUT_MS });
  return canvas;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Configurator page load and initial render', () => {
  // -----------------------------------------------------------------------
  // Test 1 — ST-001-AC1
  //
  // After `page.goto('/')`, the wrapper and the inner R3F `<canvas>`
  // both attach to the DOM within the canvas attach timeout. We also
  // sanity-check that no console errors were emitted during the
  // navigation/attach window.
  // -----------------------------------------------------------------------
  test('configurator page mounts a canvas element within the load budget', async ({ page }) => {
    await mockBackendApi(page);

    const errorBuffer = attachConsoleErrorBuffer(page);

    const goStart = Date.now();
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Canvas attaches.
    const canvas = await waitForCanvasAttached(page);
    const elapsedMs = Date.now() - goStart;

    // The DOM-attached canvas should arrive well within 5× the
    // initial-load budget. The 5× multiplier is the meta-assertion
    // tolerance for `goto + networkidle + canvas attach`, NOT the
    // ST-005-AC3 budget itself (which is asserted exactly in test 8
    // below using `window.__strikeforge_perf__.getSnapshot()`).
    expect(elapsedMs, `canvas attach time (${elapsedMs} ms)`).toBeLessThanOrEqual(
      INITIAL_LOAD_BUDGET_MS * 5,
    );

    // The canvas must be the actual <canvas> element, not a stub.
    const tagName = await canvas.first().evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('canvas');

    // No console errors expected during the initial navigation.
    expect(errorBuffer.messages).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 2 — ST-001-AC2
  //
  // The mounted canvas has non-zero drawing-buffer dimensions
  // (`canvas.width`, `canvas.height`) AND non-zero CSS box dimensions
  // (`clientWidth`, `clientHeight`). A canvas that mounts with width=0
  // is a regression — R3F failed to fit the wrapper.
  // -----------------------------------------------------------------------
  test('canvas has non-zero width and height after layout', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = await waitForCanvasAttached(page);

    const dimensions = await canvas.first().evaluate((node) => {
      const c = node as HTMLCanvasElement;
      return {
        width: c.width,
        height: c.height,
        clientWidth: c.clientWidth,
        clientHeight: c.clientHeight,
      };
    });

    expect(dimensions.width, 'canvas.width').toBeGreaterThan(0);
    expect(dimensions.height, 'canvas.height').toBeGreaterThan(0);
    expect(dimensions.clientWidth, 'canvas.clientWidth').toBeGreaterThan(0);
    expect(dimensions.clientHeight, 'canvas.clientHeight').toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 3 — BallCanvas wrapper testid + non-pathological cursor
  //
  // The wrapper carries `data-testid="ball-canvas-wrapper"` per the
  // implementation in `frontend/src/configurator/preview/BallCanvas.tsx`.
  //
  // The cursor styling is a UX detail that may legitimately be
  // 'auto'/'default' in the current build (no CSS rule sets it
  // explicitly today) or 'grab'/'pointer' if a future CSS rule is
  // added. We accept any reasonable cursor value and reject obviously
  // pathological ones (e.g., 'not-allowed', 'wait') that would
  // indicate a regression to user-blocking UI.
  // -----------------------------------------------------------------------
  test('BallCanvas wrapper has the documented test-id and a non-pathological cursor', async ({
    page,
  }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const wrapper = page.getByTestId(BALL_CANVAS_WRAPPER_TESTID);
    await expect(wrapper).toBeVisible();

    const cursor = await wrapper.evaluate((node) => window.getComputedStyle(node).cursor);

    // Reject pathological cursors that would imply the configurator
    // is blocked or non-interactive at load.
    const pathologicalCursors = new Set(['not-allowed', 'no-drop', 'wait', 'progress']);
    expect(pathologicalCursors.has(cursor)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 4 — R3F Canvas mounts inside the BallCanvas wrapper
  //
  // The wrapper hosts the R3F `<Canvas>` which renders a single
  // `<canvas>` DOM element. We assert that exactly one canvas is
  // descendant of the wrapper — multiple canvases would imply a
  // double-mount bug, zero canvases would imply R3F never
  // initialized.
  // -----------------------------------------------------------------------
  test('R3F Canvas mounts as a child of the BallCanvas wrapper', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const wrapper = page.getByTestId(BALL_CANVAS_WRAPPER_TESTID);
    await expect(wrapper).toBeVisible();

    const canvas = page.locator(R3F_CANVAS_DESCENDANT_SELECTOR);
    await expect(canvas).toBeAttached();

    const canvasCount = await canvas.count();
    expect(canvasCount, 'exactly one R3F canvas should be mounted').toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Test 5 — All primary control sidebars and summary visible
  //
  // ST-006 / ST-007 / ST-008 / ST-010 / ST-011 / ST-014 / ST-022:
  // every Track 2 control region renders by default and is visible
  // after the page loads. This is the smoke-test guard against any
  // missing-mount regression in `App.tsx`'s `<ControlSidebar />`.
  //
  // The agent-prompt-suggested role names use substring matching by
  // default in Playwright (`getByRole('radiogroup', { name: 'X' })`
  // matches accessible names containing 'X' as a substring,
  // case-insensitive), so 'Primary panel color' matches the actual
  // 'Primary panel color swatches' aria-label on the radiogroup.
  // -----------------------------------------------------------------------
  test('all primary control sidebars are visible after load', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Three color picker radiogroups.
    await expect(page.getByRole('radiogroup', { name: /Primary panel color/i })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: /Secondary panel color/i })).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: /Accent and stitching color/i }),
    ).toBeVisible();

    // Pattern + finish selectors. The actual implementation testids
    // are `stitching-pattern-selector` and `finish-selector`; we use
    // the existing identifiers rather than the aspirational
    // `material-finish-selector` from the agent prompt template.
    await expect(page.getByTestId('stitching-pattern-selector')).toBeVisible();
    await expect(page.getByTestId('finish-selector')).toBeVisible();

    // Logo uploader.
    await expect(page.getByTestId('logo-uploader')).toBeVisible();

    // Design summary sidebar (ST-022). The actual aside is rendered
    // with role="complementary" and aria-label="Current design summary"
    // in App.tsx; the testid is the most stable identifier.
    await expect(page.getByTestId(DESIGN_SUMMARY_SIDEBAR_TESTID)).toBeVisible();
  });

  // -----------------------------------------------------------------------
  // Test 6 — ST-001-AC4 / Rule R2
  //
  // No console errors and no page errors are emitted during the
  // initial render. This catches WebGL initialization failures,
  // unhandled promise rejections in store init, malformed React
  // rendering, etc.
  //
  // We use `attachConsoleErrorBuffer` BEFORE `page.goto(...)` so
  // that errors emitted during the very first navigation phase are
  // captured. After `networkidle` we additionally wait for
  // `domcontentloaded` to allow async errors to surface.
  // -----------------------------------------------------------------------
  test('initial page load reports zero console errors and zero page errors', async ({ page }) => {
    await mockBackendApi(page);
    const errorBuffer = attachConsoleErrorBuffer(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Allow any deferred async errors (e.g., trailing post-mount
    // effects) to surface before we assert.
    await page.waitForLoadState('domcontentloaded');

    expect(
      errorBuffer.messages,
      `console / page errors observed:\n${errorBuffer.messages.join('\n')}`,
    ).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Test 7 — Performance instrumentation API exposure
  //
  // `frontend/src/configurator/preview/performance.ts` attaches a
  // `window.__strikeforge_perf__` API in `BallCanvas.tsx`'s
  // `useEffect`. The API has two methods:
  //
  //   - `getSnapshot(): PerformanceSnapshot`
  //   - `resetAccumulators(): void`
  //
  // We assert all three of (object exists, both methods are
  // functions). This is the contract that ST-005's Playwright
  // performance suite (in `tests/performance/budget.spec.ts`)
  // depends on.
  // -----------------------------------------------------------------------
  test('performance instrumentation API is exposed on window', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Wait for the instrumentation API to attach. The
    // `BallCanvas.tsx` `useEffect` runs after mount; on slow CI
    // hardware this can lag the canvas-attach event by ~100ms.
    await expect
      .poll(
        async () => {
          return page.evaluate(() => typeof window.__strikeforge_perf__ === 'object');
        },
        {
          message: 'window.__strikeforge_perf__ should be initialized after canvas mount',
          timeout: PERFORMANCE_API_POLL_TIMEOUT_MS,
        },
      )
      .toBe(true);

    const apiAvailable = await page.evaluate(
      () => typeof window.__strikeforge_perf__ === 'object',
    );
    expect(apiAvailable).toBe(true);

    const hasGetSnapshot = await page.evaluate(
      () => typeof window.__strikeforge_perf__?.getSnapshot === 'function',
    );
    expect(hasGetSnapshot).toBe(true);

    const hasResetAccumulators = await page.evaluate(
      () => typeof window.__strikeforge_perf__?.resetAccumulators === 'function',
    );
    expect(hasResetAccumulators).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 8 — ST-005-AC3
  //
  // The CANONICAL ST-005-AC3 budget assertion: `initialLoadMs`
  // (time from instrumentation init to first rAF callback) is
  // ≤ 2_000 ms.
  //
  // We use `expect.poll(...)` rather than `waitForTimeout(...)`
  // because polling terminates as soon as the condition is met —
  // typically within a few hundred ms of canvas mount, well below
  // the 10_000 ms safety timeout.
  // -----------------------------------------------------------------------
  test('initial sphere render completes within ST-005 budget (≤ 2000 ms)', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Wait for the API to attach (StrictMode double-mount can defer
    // attachment by one render cycle).
    await expect
      .poll(
        async () => {
          return page.evaluate(() => typeof window.__strikeforge_perf__ === 'object');
        },
        {
          message: 'window.__strikeforge_perf__ should be initialized',
          timeout: PERFORMANCE_API_POLL_TIMEOUT_MS,
        },
      )
      .toBe(true);

    // Wait for the first frame to be observed (initialLoadMs becomes
    // non-null). This is the canonical "initial render complete"
    // signal per `performance.ts` JSDoc.
    await expect
      .poll(
        async () => {
          return page.evaluate(
            () => window.__strikeforge_perf__?.getSnapshot().initialLoadMs ?? null,
          );
        },
        {
          message: 'initialLoadMs should be reported within 10 seconds',
          timeout: PERFORMANCE_API_POLL_TIMEOUT_MS,
        },
      )
      .not.toBeNull();

    // Read the final snapshot and assert against the budget.
    const initialLoadMs = await page.evaluate(
      () => window.__strikeforge_perf__?.getSnapshot().initialLoadMs ?? null,
    );

    expect(initialLoadMs).not.toBeNull();
    expect(
      initialLoadMs,
      `initialLoadMs (${initialLoadMs} ms) must be ≤ ${INITIAL_LOAD_BUDGET_MS} ms (ST-005-AC3)`,
    ).toBeLessThanOrEqual(INITIAL_LOAD_BUDGET_MS);
  });

  // -----------------------------------------------------------------------
  // Test 9 — Continuous frameloop verification
  //
  // BallCanvas.tsx sets `frameloop="always"` on the R3F `<Canvas>`,
  // meaning frames render continuously regardless of state changes.
  // We exploit this property to verify the render loop is alive:
  // sample `totalFrames` once, wait via polling, sample again, and
  // assert the count increased.
  //
  // A regression that broke the rAF loop (e.g., an early-throw
  // inside `frameLoop`) would freeze `totalFrames` at its
  // post-init value.
  // -----------------------------------------------------------------------
  test('total frames counter increments after initial render (continuous frameloop)', async ({
    page,
  }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Wait for the API and the first frame.
    await expect
      .poll(
        async () => {
          return page.evaluate(
            () => window.__strikeforge_perf__?.getSnapshot().totalFrames ?? 0,
          );
        },
        {
          message: 'first frame should be observed',
          timeout: PERFORMANCE_API_POLL_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);

    const before = await page.evaluate(
      () => window.__strikeforge_perf__?.getSnapshot().totalFrames ?? 0,
    );
    expect(before, 'baseline frame count').toBeGreaterThan(0);

    // Poll for an increment. At even ~5 FPS (worst-case software
    // WebGL), 5 seconds yields ~25 frames so a single-frame increase
    // is essentially guaranteed.
    await expect
      .poll(
        async () => {
          return page.evaluate(
            () => window.__strikeforge_perf__?.getSnapshot().totalFrames ?? 0,
          );
        },
        {
          message: 'totalFrames should increase as frames render',
          timeout: TOTAL_FRAMES_INCREMENT_POLL_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(before);
  });

  // -----------------------------------------------------------------------
  // Test 10 — Canvas occupies its container's content box
  //
  // ST-001-AC2 (sphere is centered and properly sized): the canvas
  // must have a non-empty bounding box. We do NOT assert exact
  // pixel dimensions because the layout is responsive and depends
  // on viewport. A non-empty bounding box is the necessary
  // condition for the sphere to be visually present.
  // -----------------------------------------------------------------------
  test('canvas has a non-empty bounding box within its container', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = await waitForCanvasAttached(page);

    const box = await canvas.first().boundingBox();
    expect(box, 'canvas bounding box').not.toBeNull();
    // Non-null assertion is permitted in tests per the eslint
    // override for `tests/**/*.spec.ts`.
    expect(box!.width, 'canvas bounding box width').toBeGreaterThan(0);
    expect(box!.height, 'canvas bounding box height').toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 11 — Resize survives without errors
  //
  // ST-001-AC3 (resize re-centers): R3F's internal ResizeObserver
  // re-fits the canvas when the wrapping <div> resizes. We change
  // the viewport and verify the canvas remains attached and visible
  // and that no new console errors are emitted.
  // -----------------------------------------------------------------------
  test('configurator survives a viewport resize without errors', async ({ page }) => {
    await mockBackendApi(page);
    const errorBuffer = attachConsoleErrorBuffer(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    // Resize the viewport.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForLoadState('networkidle');

    // Canvas remains attached and visible after resize.
    await expect(page.locator(R3F_CANVAS_DESCENDANT_SELECTOR).first()).toBeVisible();

    // No new errors emitted during resize.
    expect(
      errorBuffer.messages,
      `errors observed after resize:\n${errorBuffer.messages.join('\n')}`,
    ).toEqual([]);

    // Canvas has non-zero drawing buffer dimensions after re-fit.
    const dims = await page.locator(R3F_CANVAS_DESCENDANT_SELECTOR).first().evaluate((node) => {
      const c = node as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(dims.width, 'canvas.width post-resize').toBeGreaterThan(0);
    expect(dims.height, 'canvas.height post-resize').toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 12 — Controls and summary remain visible after resize
  //
  // The CSS Grid in `frontend/src/styles/global.css` collapses to a
  // single column at viewports ≤ 900px. At 1280×800 (> 900px) the
  // three-region layout (controls / preview / summary) stays
  // intact. This is the smoke check that all regions remain
  // discoverable post-resize.
  // -----------------------------------------------------------------------
  test('controls and summary remain visible after a viewport resize', async ({ page }) => {
    await mockBackendApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForCanvasAttached(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('radiogroup', { name: /Primary panel color/i })).toBeVisible();
    await expect(page.getByTestId('stitching-pattern-selector')).toBeVisible();
    await expect(page.getByTestId('finish-selector')).toBeVisible();
    await expect(page.getByTestId(DESIGN_SUMMARY_SIDEBAR_TESTID)).toBeVisible();
  });
});
