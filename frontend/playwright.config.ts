import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the StrikeForge 3D sports ball configurator
 * frontend (React 18 + Vite + R3F + Fabric.js).
 *
 * ---------------------------------------------------------------------------
 * Authority
 * ---------------------------------------------------------------------------
 *
 * - AAP §0.3.4 "New Files to Create — Frontend":
 *   "frontend/playwright.config.ts | Playwright projects chromium + webkit,
 *    visual-snapshots mode"
 * - AAP §0.6.7 Track 2: initial chromium project for Gate T2.
 * - AAP §0.6.12 MG2-H: add webkit project and tests/e2e/, tests/visual/
 *   directories. Because this is a greenfield implementation, the file is
 *   authored once with both projects from the start — there is no value in
 *   producing two temporal versions during initial scaffolding.
 * - AAP §0.4.2: @playwright/test ^1.48.x — "E2E + visual regression runner".
 * - ST-045-AC3: end-to-end suite exercises configurator load, color
 *   selection, save-design, load-design, and order creation flows against
 *   running services.
 * - ST-046-AC2: each captured screenshot is compared against a versioned
 *   baseline at a fixed viewport size, and any delta exceeding the
 *   documented pixel-difference threshold produces a failed verdict.
 * - ST-046-AC4: baselines are committed to the repository — they live under
 *   ./visual-baselines/ which is intentionally excluded from .gitignore.
 *
 * ---------------------------------------------------------------------------
 * Test directory layout
 * ---------------------------------------------------------------------------
 *
 *   tests/configurator/   Gate T2 — basic configurator smoke + interaction
 *                         tests (color swatches, pattern selector, logo
 *                         upload). All run on chromium only via:
 *                         `npx playwright test --project=chromium tests/configurator/`
 *
 *   tests/performance/    Gate T2 — FPS ≥ 30 sustained during drag-rotate
 *                         and ≤ 2000 ms initial sphere render budget per
 *                         ST-005. Chromium-only:
 *                         `npx playwright test --project=chromium tests/performance/`
 *
 *   tests/e2e/            ST-045 — critical user flow (register → login →
 *                         create design → save → share → add to cart →
 *                         create order). Runs on both chromium and webkit
 *                         per AAP §0.6.12 (the two major engine families):
 *                         `npx playwright test tests/e2e/`
 *
 *   tests/visual/         ST-046 — visual regression of configurator,
 *                         design list, cart, and order confirmation
 *                         surfaces. Compares against committed PNG
 *                         baselines under ./visual-baselines/:
 *                         `npx playwright test tests/visual/`
 *
 * ---------------------------------------------------------------------------
 * Visual regression baseline storage
 * ---------------------------------------------------------------------------
 *
 * `snapshotDir: './visual-baselines'` directs `expect(page).toHaveScreenshot()`
 * to read and write PNGs under frontend/visual-baselines/, which is
 * NOT in .gitignore so baselines are versioned alongside source per
 * ST-046-AC4. Baseline updates require an explicit commit; no run can
 * silently overwrite a baseline.
 *
 * ---------------------------------------------------------------------------
 * Web server auto-startup
 * ---------------------------------------------------------------------------
 *
 * The `webServer` block tells Playwright to run `npm run dev` (which the
 * frontend package.json maps to `vite`) and wait for the dev server to
 * respond at http://localhost:5173 before launching tests. The Vite dev
 * server is pinned to port 5173 with `strictPort: true` in vite.config.ts,
 * so this URL never silently shifts to 5174 on a port collision.
 *
 *   - reuseExistingServer: !process.env.CI
 *     Locally, Playwright reuses an already-running Vite instance so
 *     developers can edit the SPA, hot-reload via Vite, and re-run
 *     `npx playwright test` repeatedly without restarting the server.
 *     In CI, the server is always started fresh from a known state.
 *
 *   - timeout: 120_000
 *     Allows for cold-boot scenarios where node_modules is freshly
 *     populated and Vite must perform initial dependency pre-bundling
 *     of three.js, @react-three/fiber, fabric, firebase, etc.
 *
 * The Playwright tests rely on Vite serving the SPA, and the SPA itself
 * communicates with the local backend over http://localhost:3000 (started
 * via `docker compose up -d` for Track 2 stub or via the live integration
 * in MG1-F). Per the LocalGCP Verification Rule, integration tests create
 * their own resources during setup — globalSetup/globalTeardown are NOT
 * defined here.
 *
 * ---------------------------------------------------------------------------
 * Browser projects
 * ---------------------------------------------------------------------------
 *
 * Two projects per AAP §0.6.12 ("the two major engine families" per
 * ST-045-AC3):
 *
 *   - chromium  — devices['Desktop Chrome'] — Blink engine
 *   - webkit    — devices['Desktop Safari']  — WebKit engine
 *
 * No firefox project; the AAP scope is firmly two browsers. Spreading
 * the named device descriptors (rather than overriding `browserName`
 * directly) gives correct user-agent strings, default viewport, and
 * default emulation settings for each engine.
 *
 * ---------------------------------------------------------------------------
 * Reporter strategy
 * ---------------------------------------------------------------------------
 *
 *   - 'html' → playwright-report/  (browseable; .gitignored)
 *   - 'json' → test-results/results.json
 *     (this exact path is consumed by Cloud Build to upload test results
 *      to gs://${_ARTIFACTS_BUCKET}/${BUILD_ID}/reports/ per AAP §0.6.11)
 *   - 'list' → terminal output for local developer feedback
 *
 * ---------------------------------------------------------------------------
 * Determinism
 * ---------------------------------------------------------------------------
 *
 *   - viewport: 1280×720 fixed for every test → ST-046-AC2 deterministic
 *     visual baselines across CI environments.
 *   - toHaveScreenshot.maxDiffPixelRatio: 0.01 (1% tolerance) accounts
 *     for OS-level font rendering variance without masking real visual
 *     regressions.
 *   - toHaveScreenshot.threshold: 0.2 (default pixelmatch threshold)
 *     in YIQ color space.
 *   - toHaveScreenshot.animations: 'disabled' freezes CSS animations
 *     during snapshot capture.
 *
 * ---------------------------------------------------------------------------
 * CI hardening (Rule R8 — gates fail closed)
 * ---------------------------------------------------------------------------
 *
 *   - forbidOnly: !!process.env.CI — `test.only` in committed code fails
 *     CI immediately rather than silently running a single test.
 *   - retries: 2 in CI / 0 locally — CI tolerates flakes up to 2 retries
 *     for environment hiccups; local runs do not retry, surfacing
 *     deterministic failures fast.
 *   - workers: 4 in both CI and locally — bounded parallelism for
 *     reproducible durations and to avoid overloading the single
 *     shared Vite dev server. Playwright's default of `undefined`
 *     resolves to `Math.floor(os.cpus().length / 2)`, which on a
 *     64+ core build host saturates the Vite dev server with
 *     dozens of concurrent module-graph requests, causing R3F /
 *     fabric / firebase chunks to load slower than the per-test
 *     action timeouts and producing flaky "click timed out" or
 *     "test hook never installed" failures. A fixed worker count
 *     of 4 keeps Vite responsive while preserving meaningful
 *     parallelism on developer machines and CI runners alike.
 */
export default defineConfig({
  // -----------------------------------------------------------------------
  // Test discovery
  // -----------------------------------------------------------------------
  testDir: './tests',
  outputDir: './test-results',
  snapshotDir: './visual-baselines',

  // -----------------------------------------------------------------------
  // Execution model
  // -----------------------------------------------------------------------
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Cap at 4 workers in BOTH CI and local environments. The shared
  // Vite dev server cannot keep up with the module-graph requests
  // generated by 32+ concurrent browser contexts on high-core build
  // hosts, which surfaces as click timeouts and missing test hooks
  // even though each test is correct in isolation. 4 workers is the
  // documented stable upper bound across our testbed matrix.
  workers: 4,

  // -----------------------------------------------------------------------
  // Per-test timeout — 60s
  // -----------------------------------------------------------------------
  //
  // Playwright's default per-test timeout is 30 seconds. That's adequate
  // for ordinary DOM-heavy tests on a GPU-accelerated environment, but
  // the StrikeForge configurator suite runs against software WebGL
  // (SwiftShader / llvmpipe) on sandboxed CI runners with no GPU
  // available. Software WebGL is CPU-bound, so:
  //
  //   - R3F initial mount is ~5× slower than on real GPU hardware.
  //   - Canvas visibility / actionability checks are ~3-5× slower.
  //   - Combined-suite parallel runs add inter-worker CPU contention,
  //     pushing per-test wall time toward 30-45s for tests that would
  //     ordinarily complete in 5-10s on hardware.
  //
  // Empirically observed wall times in a 17-test combined run on a
  // 128-core / SwiftShader sandbox:
  //   - simple navigation + canvas-visibility assertions: ~25-35s
  //   - drag interaction + frame settle:                  ~40-50s
  //   - resize across 3 breakpoints with R3F re-fit:      ~45s
  //
  // 60s gives comfortable headroom across every observed case while
  // still surfacing genuine hangs (an infinite loop or a deadlocked
  // animation frame would produce a timeout in any reasonable budget).
  //
  // Tests that need *more* than 60s (e.g. multi-step performance
  // budget tests that include their own settle windows) call
  // `test.setTimeout(60_000)` or higher explicitly.
  //
  // The hardware production budget (`MIN_FPS_BUDGET_HARDWARE = 30` in
  // tests/performance/budget.spec.ts) and the initial-load budget
  // (`INITIAL_LOAD_BUDGET_MS = 2000` per ST-005-AC3) remain in the
  // assertion code, so this timeout change has no effect on what is
  // actually measured.
  timeout: 60_000,

  // -----------------------------------------------------------------------
  // Reporters (HTML + JSON + list)
  // -----------------------------------------------------------------------
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list'],
  ],

  // -----------------------------------------------------------------------
  // Assertion defaults
  // -----------------------------------------------------------------------
  expect: {
    // Default expect() polling timeout (5 seconds).
    timeout: 5_000,
    // Visual regression thresholds for `expect(page).toHaveScreenshot()`.
    // Per ST-046-AC2: deltas exceeding the documented threshold produce
    // a failed verdict. The `maxDiffPixelRatio` value (1%) is intentionally
    // strict but accommodates OS-level font rendering variance across CI
    // environments. The `threshold` (0.2) is Playwright's pixelmatch
    // default in YIQ color space. `animations: 'disabled'` freezes CSS
    // animations to ensure deterministic visual baselines.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
    },
  },

  // -----------------------------------------------------------------------
  // Shared `use` defaults applied to every project
  // -----------------------------------------------------------------------
  use: {
    // Vite dev server URL — pinned to 5173 with `strictPort: true` in
    // vite.config.ts so this assumption never silently shifts.
    baseURL: 'http://localhost:5173',

    // Diagnostic artifacts — captured only on failure so successful
    // runs produce the smallest possible output footprint.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Fixed viewport — required by ST-046-AC2 for deterministic visual
    // baselines. 1280×720 matches the default for `Desktop Chrome` and
    // is wide enough to display the configurator's three-region layout
    // (controls + preview + summary sidebar) per ST-022.
    viewport: { width: 1280, height: 720 },

    // Per-action timeouts — generous enough to cover slow R3F frame
    // processing during initial mount but tight enough to surface real
    // hangs.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,

    // Tolerate self-signed certs if the local stack ever surfaces HTTPS
    // (the Firebase emulator and fake-gcs-server are both HTTP today).
    ignoreHTTPSErrors: true,
  },

  // -----------------------------------------------------------------------
  // Browser projects — Chromium (Blink) + WebKit per ST-045-AC3
  // -----------------------------------------------------------------------
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  // -----------------------------------------------------------------------
  // Vite dev server auto-startup — Playwright launches `npm run dev`
  // and waits for http://localhost:5173 to respond before running tests
  // -----------------------------------------------------------------------
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
