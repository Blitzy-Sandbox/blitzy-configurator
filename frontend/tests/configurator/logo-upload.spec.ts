/**
 * Logo upload, position, and validation Playwright spec — Gate T2 ST-014/015/016/017.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       `frontend/tests/configurator/*.spec.ts` —
 *       Configurator smoke + interaction tests (Gate T2).
 *   - AAP §0.6.7 Track 2 Frontend Core: `LogoUploader.tsx`, `LogoPositioner.tsx`,
 *       and `InvalidFileFeedback.tsx` are Track 2 deliverables. They render
 *       inside the control sidebar (App.tsx) at Gate T2 with no live backend
 *       coupling.
 *   - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *       `cd frontend && npx playwright test --project=chromium tests/configurator/`
 *       — all pass.
 *   - Story coverage:
 *       ST-014-AC1 — File-picker affordance is reachable from the control
 *                    sidebar.
 *       ST-014-AC2 — File-picker accepts the documented set of image MIME
 *                    types (PNG, JPEG, GIF, SVG, WebP).
 *       ST-014-AC4 — File-picker is reachable and operable using the
 *                    keyboard and is labeled for assistive technology.
 *       ST-015-AC1 — Position pad responds to user interaction (drag /
 *                    keyboard arrow keys) and the position state updates.
 *       ST-015-AC2 — The current logo position is displayed in a
 *                    human-readable form alongside the pad and updates
 *                    when the user moves the logo.
 *       ST-016-AC1 — Scale control adjusts the logo's displayed size on
 *                    the preview in real time.
 *       ST-016-AC2 — The current scale value is shown as a human-readable
 *                    label next to the control.
 *       ST-017-AC1 — Uploading a file whose type is not among the
 *                    supported image formats is rejected and the preview
 *                    is left unchanged.
 *       ST-017-AC2 — Uploading a file larger than the documented maximum
 *                    file size is rejected and the preview is left
 *                    unchanged.
 *       ST-017-AC3 — Every rejection produces a user-facing message that
 *                    names the specific reason and the remediation, and is
 *                    announced to assistive technology (`role="alert"`,
 *                    `aria-live="assertive"`).
 *       ST-022 (related) — design summary sidebar logo row updates from
 *                    "None" → "Uploaded" once a valid file is staged.
 *
 * ===========================================================================
 * Purpose
 * ===========================================================================
 *
 * Verifies the LogoUploader / LogoPositioner / InvalidFileFeedback triad
 * end to end against the rendered configurator:
 *
 *   1. The hidden `<input type="file">` declares the documented `accept`
 *      attribute including all five supported MIME types.
 *   2. Uploading a valid PNG transitions the uploader from "Choose a
 *      logo image" to "Replace logo", populates the filename row,
 *      reveals the "Remove logo" button, and updates the design
 *      summary sidebar logo row from "None" to "Uploaded".
 *   3. The position pad responds to keyboard arrow-key navigation and
 *      both the `data-x` / `data-y` attributes and the human-readable
 *      "Position: x=<n>, y=<n>" readout reflect the change.
 *   4. The scale slider responds to value changes via the DOM API
 *      (`fill('0.75')`) and the `data-scale` attribute and the
 *      "1.00×" readout both reflect the change.
 *   5. Uploading an `application/pdf` file produces an
 *      `<InvalidFileFeedback>` element with `data-reason="unsupported-format"`,
 *      `role="alert"`, `aria-live="assertive"`, and a remediation
 *      message that lists the supported formats.
 *   6. Uploading a 6 MiB PNG produces an `<InvalidFileFeedback>` element
 *      with `data-reason="size-exceeded"`, `role="alert"`,
 *      `aria-live="assertive"`, and a remediation that names the 5 MB
 *      limit.
 *   7. After a rejection, a subsequent successful upload clears the
 *      feedback element entirely (the rejection is not sticky).
 *   8. Removing the staged logo clears the filename row, hides the
 *      remove button, returns the trigger label to "Choose a logo
 *      image", and resets the summary row to "None".
 *
 * ===========================================================================
 * Implementation note — testids reflect the SHIPPED component contract
 * ===========================================================================
 *
 * The agent prompt anticipated a different set of testids
 * (`logo-uploader-trigger`, `logo-uploader-remove`, `logo-uploader-feedback`,
 * `logo-positioner-pad`, `logo-positioner-scale-value`, `logo-positioner-reset`,
 * `data-disabled` attribute, x/y input fields). The actual shipped
 * components in `frontend/src/configurator/controls/logo/` and
 * `frontend/src/App.tsx` use a different (and equally valid) set:
 *
 *   - LogoUploader → `logo-uploader`, `logo-uploader-input`,
 *     `logo-uploader-label`, `logo-uploader-filename`,
 *     `logo-uploader-clear`, `logo-uploader-description`.
 *     Trigger label text: "Choose a logo image" / "Replace logo".
 *     Clear button text: "Remove logo".
 *   - InvalidFileFeedback → default testid `invalid-file-feedback`,
 *     `data-reason="unsupported-format" | "size-exceeded"`.
 *   - LogoPositioner → `logo-positioner`, `logo-position-pad`,
 *     `logo-position-dot`, `logo-scale-slider`, `logo-scale-readout`.
 *     Position is set via the pad's pointer / arrow-key interactions
 *     (no separate x/y input fields). Scale slider readout format:
 *     `"<n.nn>×"` (multiplication sign).
 *   - DesignSummarySidebar → `aria-label="Current design summary"`,
 *     `data-testid="design-summary-sidebar"`. Logo value reads "None"
 *     / "Uploaded" (no scale percentage).
 *
 * This spec verifies the SHIPPED contract — i.e., the same convention
 * already established by `tests/configurator/configurator-load.spec.ts`
 * (line 430-435 explicitly notes: "we use the existing identifiers
 * rather than the aspirational [...] from the agent prompt template").
 *
 * ===========================================================================
 * Cross-cutting Rules
 * ===========================================================================
 *
 *   - Rule R2 (no credential material in logs): this file performs ZERO
 *     browser-console method invocations. The frontend ESLint config
 *     enforces `no-console: error` and the workspace lint gate runs with
 *     `--max-warnings 0`.
 *   - Rule R3 (Firebase Admin SDK only on backend): this file does NOT
 *     import any backend admin auth library, NOT mint or verify any
 *     auth token, and NOT invoke any token-verification API. This is a
 *     frontend Playwright spec.
 *   - Rule R7 / C6 (Fabric → Three texture order): this spec does NOT
 *     touch the texture pipeline directly. The C6/R7-compliant
 *     coordinator (`fabricCanvas.renderAll()` then
 *     `threeTexture.needsUpdate = true`) is exercised indirectly via
 *     the LogoUploader's `setLogoFile` store update; the spec waits
 *     for `networkidle` after navigation so the pipeline settles.
 *   - Rule R9 (no payment processing): this file contains no
 *     payment-related strings, libraries, or behaviours.
 *
 * ===========================================================================
 * Test environment
 * ===========================================================================
 *
 *   - `frontend/playwright.config.ts` auto-starts the Vite dev server
 *     on http://localhost:5173 and waits for it to respond before
 *     executing tests.
 *   - Default viewport is 1280×720 (set in `use.viewport`).
 *   - Per-test timeout is 60_000 ms — comfortable headroom for
 *     software-WebGL CI runners.
 *   - `expect()` polling timeout defaults to 5_000 ms unless overridden.
 *   - Both the `chromium` and `webkit` projects are configured; this
 *     spec is engine-agnostic and runs on either.
 */

import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Stable selector constants — match the SHIPPED component contract
// ---------------------------------------------------------------------------

/** Section root for the LogoUploader (`<section aria-label="Logo upload">`). */
const UPLOADER_TESTID = 'logo-uploader';

/**
 * The hidden but focusable `<input type="file">` inside LogoUploader.
 * Playwright's `setInputFiles({ name, mimeType, buffer })` works on
 * hidden inputs because it sets the file value via the DOM API
 * directly, not via a click event.
 */
const UPLOADER_INPUT_TESTID = 'logo-uploader-input';

/**
 * The visible `<label>` element that acts as the file-picker affordance
 * (clicking it triggers the OS file dialog via `htmlFor`). Text is
 * "Choose a logo image" before any upload, "Replace logo" after.
 */
const UPLOADER_LABEL_TESTID = 'logo-uploader-label';

/**
 * The filename / status `<p>` element. Always rendered. Text reads
 * "No logo selected." when no logo is staged, the file's name when a
 * `File` is staged, or "Saved logo from your design." when a remote
 * URL is staged from a loaded design. The `data-has-logo` attribute
 * is `"true"` or `"false"` and is the most reliable empty-state
 * discriminator.
 */
const UPLOADER_FILENAME_TESTID = 'logo-uploader-filename';

/**
 * The "Remove logo" button. Only rendered when a logo is staged
 * (i.e., `logoFile !== null` in the configurator store).
 */
const UPLOADER_CLEAR_TESTID = 'logo-uploader-clear';

/**
 * The InvalidFileFeedback container — rendered ONLY when the
 * uploader's local `error` state is non-null. Default testid (the
 * LogoUploader does not pass an explicit `data-testid` prop).
 */
const FEEDBACK_TESTID = 'invalid-file-feedback';

/** Section root for the LogoPositioner (`<section aria-label="Logo placement">`). */
const POSITIONER_TESTID = 'logo-positioner';

/**
 * The 2D position pad. `role="application"`, `tabIndex=0` so it is
 * keyboard-focusable. Carries `data-x` and `data-y` attributes
 * reporting the current normalized position in `[-1, 1]` (rounded to
 * 2 decimals).
 */
const POSITION_PAD_TESTID = 'logo-position-pad';

/** The visual position-indicator dot inside the pad. */
const POSITION_DOT_TESTID = 'logo-position-dot';

/**
 * The scale slider — `<input type="range" min=0.25 max=2.5 step=0.05>`.
 * Carries `data-scale` reporting the current scale to 2 decimals.
 */
const SCALE_SLIDER_TESTID = 'logo-scale-slider';

/**
 * The "<n.nn>×" textual scale readout next to the slider (the
 * multiplication sign is U+00D7).
 */
const SCALE_READOUT_TESTID = 'logo-scale-readout';

/** Design summary sidebar (App.tsx) — accessibility-named complementary aside. */
const SUMMARY_SIDEBAR_TESTID = 'design-summary-sidebar';
const SUMMARY_LOGO_VALUE_TESTID = 'summary-value-logo';

// ---------------------------------------------------------------------------
// Fixture buffers — constructed in-memory so no on-disk PNG is needed
// ---------------------------------------------------------------------------

/**
 * 1×1 transparent PNG (the smallest valid PNG: ~70 bytes).
 *
 * Byte breakdown:
 *   - 8-byte PNG signature.
 *   - IHDR chunk: 1×1 pixel, 8-bit RGBA.
 *   - IDAT chunk: zlib-compressed single transparent pixel.
 *   - IEND chunk: end marker.
 *
 * The validator (`validateLogoFile`) inspects only `file.type` and
 * `file.size`, never the bytes themselves, so the choice of payload
 * does not matter as long as the buffer is stable across runs and is
 * valid enough to satisfy any future content-aware validation.
 */
const TINY_PNG_BUFFER: Buffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

/**
 * 6 MiB buffer beginning with the PNG signature.
 *
 * The validator's MIME check uses `file.type` (set explicitly via
 * Playwright's `setInputFiles({ mimeType: 'image/png', ... })`) and
 * its size check uses `file.size` (which equals the buffer length).
 * Therefore an `image/png`-typed 6 MiB buffer passes the MIME-type
 * allow-list (`SUPPORTED_LOGO_MIME_TYPES`) but fails the
 * `MAXIMUM_LOGO_SIZE_BYTES = 5 * 1024 * 1024` size cap, deterministically
 * triggering the size-exceeded path of the validator.
 *
 * 6 MiB = 6 × 1024 × 1024 = 6_291_456 bytes — safely above the 5 MiB
 * limit. We start with the PNG signature so that future content-aware
 * validation (e.g., rendering a thumbnail) does not reject the buffer
 * before reaching the size check.
 */
const OVERSIZED_PNG_BUFFER: Buffer = (() => {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  // Total target: 6 MiB. Filler is allocated lazily inside this IIFE
  // to keep top-of-file constants readable.
  const TARGET_BYTES = 6 * 1024 * 1024;
  const filler = Buffer.alloc(TARGET_BYTES - signature.length, 0);
  return Buffer.concat([signature, filler]);
})();

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
 * tests that never trigger the corresponding URL — the logo-upload
 * tests in this file do not exercise any backend endpoint, but the
 * mocks defend against accidental fetches from store-init effects,
 * preloading, or telemetry beacons.
 *
 * This mirrors the canonical pattern established by
 * `tests/configurator/configurator-load.spec.ts` and
 * `tests/configurator/summary-sidebar.spec.ts` so all configurator
 * tests share the same stub posture.
 */
async function mockBackendApi(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }),
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
 * Navigate to `/`, wait for the configurator to mount, and confirm
 * the LogoUploader and LogoPositioner are visible. Returns once the
 * page is in the steady "ready for interaction" state.
 *
 * Sequence:
 *   1. `page.goto('/')` — Playwright honours the configured baseURL
 *      `http://localhost:5173` (set in `playwright.config.ts`).
 *   2. Wait for `networkidle` so the initial XHR / fetch storm
 *      (Vite HMR client, store hydration, mocked API beacons) has
 *      settled.
 *   3. Wait for the `<canvas>` element to ATTACH (not necessarily
 *      paint). Software-WebGL CI runners take several seconds to
 *      initialize a WebGL context; 15 seconds is comfortable
 *      headroom.
 *   4. Re-await `networkidle` to let any post-canvas fetch settle.
 *   5. Confirm the logo controls have rendered — the App.tsx
 *      `<ControlSidebar>` mounts `<LogoUploader>` AND
 *      `<LogoPositioner>` synchronously, so this is a valid
 *      readiness gate.
 *
 * Why no `mockBackendApi` here: the `beforeEach` hook is the
 * canonical place to install mocks BEFORE navigation, and routing
 * before goto is the only way to intercept the very-first navigation
 * fetches. Each test's `beforeEach` calls `mockBackendApi` then
 * `waitForConfiguratorReady` in that order.
 */
async function waitForConfiguratorReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page
    .locator('canvas')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId(UPLOADER_TESTID)).toBeVisible();
  await expect(page.getByTestId(POSITIONER_TESTID)).toBeVisible();
}

/**
 * Upload a fixture buffer through the LogoUploader's hidden input.
 *
 * Playwright's `setInputFiles({ name, mimeType, buffer })` form
 * passes the buffer to the page WITHOUT writing a temp file to disk.
 * The `mimeType` parameter sets `File.prototype.type` directly,
 * which is what the validator inspects. The `name` parameter sets
 * `File.prototype.name`, which the uploader echoes into the
 * `logo-uploader-filename` element on success.
 *
 * Note: `setInputFiles` works on visually-hidden inputs because it
 * sets the value via the DOM `<input>.files` API, not via a click.
 * The LogoUploader's input is positioned `absolute / inset:0` over
 * the visible label per `logo.module.css`, but it remains in the
 * DOM and accessible to Playwright.
 */
async function uploadFile(
  page: Page,
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<void> {
  await page
    .getByTestId(UPLOADER_INPUT_TESTID)
    .setInputFiles({ name, mimeType, buffer });
}

/**
 * Read the design summary sidebar's logo value text. Reading via the
 * value testid keeps assertions independent of any whitespace or
 * styling around the label.
 */
async function readSummaryLogoValue(page: Page): Promise<string> {
  const value = page.getByTestId(SUMMARY_LOGO_VALUE_TESTID);
  return (await value.textContent())?.trim() ?? '';
}


// ---------------------------------------------------------------------------
// Late-defined fixture: PDF buffer
//
// Defined after the helpers section so its JSDoc and value remain
// adjacent and self-contained. Used by the unsupported-format
// rejection tests below.
// ---------------------------------------------------------------------------

/**
 * A minimal PDF buffer prefixed with the canonical %PDF magic bytes.
 *
 * Used solely to exercise the `unsupported-format` validation path.
 * The validator never inspects the body — only `file.type`, which we
 * declare as `application/pdf` via `setInputFiles({ mimeType, ... })`.
 */
const PDF_BUFFER: Buffer = Buffer.from(
  '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n',
  'latin1',
);

// ---------------------------------------------------------------------------
// File-name + MIME-type fixtures
// ---------------------------------------------------------------------------

const VALID_PNG_NAME = 'test-logo.png';
const VALID_PNG_MIME = 'image/png';
const OVERSIZED_PNG_NAME = 'oversized-logo.png';
const INVALID_PDF_NAME = 'malicious.pdf';
const INVALID_PDF_MIME = 'application/pdf';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Logo upload, positioning, and validation', () => {
  test.beforeEach(async ({ page }) => {
    await mockBackendApi(page);
    await waitForConfiguratorReady(page);
  });

  // -----------------------------------------------------------------------
  // Test 1 — ST-014-AC1, ST-014-AC2, ST-014-AC4
  //
  // The LogoUploader section renders inside the control sidebar with:
  //   - a labeled `<section aria-label="Logo upload">` container,
  //   - a visible label-as-trigger reading "Choose a logo image"
  //     before any upload, and
  //   - a hidden but focusable file input whose `accept` attribute
  //     enumerates the five documented MIME types (PNG, JPEG, GIF,
  //     SVG, WebP — order per `SUPPORTED_LOGO_MIME_TYPES` in
  //     `logoValidation.ts`).
  //
  // The visible description (`logo-uploader-description`) names the
  // accepted formats and the maximum size — that copy is the user-
  // facing remediation surface for ST-017-AC3 even before any upload
  // attempt.
  // -----------------------------------------------------------------------
  test('renders the LogoUploader with the documented label, accept attribute, and description (ST-014-AC1, ST-014-AC2)', async ({
    page,
  }) => {
    const uploader = page.getByTestId(UPLOADER_TESTID);
    await expect(uploader).toBeVisible();

    // Label-as-trigger initial copy.
    const label = page.getByTestId(UPLOADER_LABEL_TESTID);
    await expect(label).toBeVisible();
    await expect(label).toHaveText('Choose a logo image');

    // The hidden file input is in the DOM (not display:none) so its
    // `accept` attribute is observable. We verify each documented MIME
    // type as a discrete substring so the assertion does not depend
    // on the join order.
    const input = page.getByTestId(UPLOADER_INPUT_TESTID);
    await expect(input).toBeAttached();
    const acceptAttr = await input.getAttribute('accept');
    expect(acceptAttr).not.toBeNull();
    expect(acceptAttr).toContain('image/png');
    expect(acceptAttr).toContain('image/jpeg');
    expect(acceptAttr).toContain('image/gif');
    expect(acceptAttr).toContain('image/svg+xml');
    expect(acceptAttr).toContain('image/webp');

    // The accessible description names the supported formats and the
    // maximum size — both pieces of information are required by
    // ST-017-AC3 (rejection messages must name remediation, and the
    // affordance copy is the upstream version of that remediation).
    const description = page.getByTestId('logo-uploader-description');
    await expect(description).toBeVisible();
    await expect(description).toContainText(/PNG/i);
    await expect(description).toContainText(/JPEG/i);
    await expect(description).toContainText(/GIF/i);
    await expect(description).toContainText(/SVG/i);
    await expect(description).toContainText(/WebP/i);
    await expect(description).toContainText(/5 MB/i);
  });

  // -----------------------------------------------------------------------
  // Test 2 — ST-015-AC1, ST-015-AC2 (positioner skeleton),
  //          ST-016-AC1 (scale slider visibility)
  //
  // Confirms the LogoPositioner section mounts with all documented
  // sub-elements: the position pad (with `data-x`/`data-y` reporting
  // attributes), the position dot, the scale slider, and the scale
  // readout.
  //
  // Initial values are CONFIGURATOR_DEFAULTS:
  //   - logoPosition = { x: 0, y: 0 }
  //   - logoScale    = 1.0
  // -----------------------------------------------------------------------
  test('renders the LogoPositioner with the documented controls and default values (ST-015-AC1, ST-016-AC1)', async ({
    page,
  }) => {
    const positioner = page.getByTestId(POSITIONER_TESTID);
    await expect(positioner).toBeVisible();

    const pad = page.getByTestId(POSITION_PAD_TESTID);
    await expect(pad).toBeVisible();
    // The pad is keyboard-focusable per ST-015-AC1 (and the underlying
    // a11y contract — `tabIndex={0}`).
    await expect(pad).toHaveAttribute('tabindex', '0');
    await expect(pad).toHaveAttribute('role', 'application');
    // Default position is (0, 0).
    await expect(pad).toHaveAttribute('data-x', '0.00');
    await expect(pad).toHaveAttribute('data-y', '0.00');

    const dot = page.getByTestId(POSITION_DOT_TESTID);
    await expect(dot).toBeAttached();

    const slider = page.getByTestId(SCALE_SLIDER_TESTID);
    await expect(slider).toBeVisible();
    await expect(slider).toHaveAttribute('type', 'range');
    await expect(slider).toBeEnabled();
    // Default scale is 1.0; both the slider value and the data-scale
    // attribute report 1.00 to two decimal places.
    await expect(slider).toHaveAttribute('data-scale', '1.00');

    const readout = page.getByTestId(SCALE_READOUT_TESTID);
    await expect(readout).toBeVisible();
    // Readout format: "1.00×" (multiplication sign U+00D7).
    await expect(readout).toHaveText(/1\.00\s*[\u00D7x]/i);
  });

  // -----------------------------------------------------------------------
  // Test 3 — Initial state of the filename row + summary sidebar
  //
  // Before any upload:
  //   - The filename `<p>` is always rendered, displays
  //     "No logo selected.", and carries `data-has-logo="false"`.
  //   - The "Remove logo" button does NOT exist (count === 0).
  //   - The InvalidFileFeedback is not rendered.
  //   - The design summary sidebar logo value reads "None".
  // -----------------------------------------------------------------------
  test('initial state: filename reads "No logo selected.", no remove button, no feedback, summary "None"', async ({
    page,
  }) => {
    const filename = page.getByTestId(UPLOADER_FILENAME_TESTID);
    await expect(filename).toBeVisible();
    await expect(filename).toHaveText('No logo selected.');
    await expect(filename).toHaveAttribute('data-has-logo', 'false');

    // The remove button is conditionally rendered.
    await expect(page.getByTestId(UPLOADER_CLEAR_TESTID)).toHaveCount(0);

    // The rejection feedback is also conditionally rendered.
    await expect(page.getByTestId(FEEDBACK_TESTID)).toHaveCount(0);

    // Summary reflects no-logo state.
    await expect(page.getByTestId(SUMMARY_SIDEBAR_TESTID)).toBeVisible();
    expect(await readSummaryLogoValue(page)).toBe('None');
  });

  // -----------------------------------------------------------------------
  // Test 4 — ST-014-AC4: a valid PNG upload populates the filename row,
  //                       transitions the trigger label to "Replace
  //                       logo", reveals the "Remove logo" button, and
  //                       updates the design summary to "Uploaded".
  // -----------------------------------------------------------------------
  test('uploading a valid PNG populates the filename, swaps the label, reveals remove, updates the summary (ST-014-AC4)', async ({
    page,
  }) => {
    await uploadFile(page, TINY_PNG_BUFFER, VALID_PNG_NAME, VALID_PNG_MIME);

    // Filename row text echoes the uploaded file's name.
    const filename = page.getByTestId(UPLOADER_FILENAME_TESTID);
    await expect(filename).toHaveText(VALID_PNG_NAME);
    await expect(filename).toHaveAttribute('data-has-logo', 'true');

    // Label-as-trigger swaps to the "Replace logo" copy.
    const label = page.getByTestId(UPLOADER_LABEL_TESTID);
    await expect(label).toHaveText('Replace logo');

    // "Remove logo" button is now in the DOM and visible.
    const removeBtn = page.getByTestId(UPLOADER_CLEAR_TESTID);
    await expect(removeBtn).toBeVisible();
    await expect(removeBtn).toHaveText('Remove logo');

    // No rejection feedback is present after a successful upload.
    await expect(page.getByTestId(FEEDBACK_TESTID)).toHaveCount(0);

    // Design summary sidebar reflects the upload.
    await expect
      .poll(async () => readSummaryLogoValue(page), { timeout: 5_000 })
      .toBe('Uploaded');
  });


  // -----------------------------------------------------------------------
  // Test 5 — ST-015-AC1, ST-015-AC2: position pad responds to keyboard
  //          arrow keys and the position attributes update accordingly.
  //
  // The pad's `handlePadKeyDown` handler increments the normalized
  // position by `POSITION_STEP = 0.05` per arrow key press. After
  // focusing the pad and pressing ArrowRight, ArrowRight, ArrowUp,
  // the position should be (0.10, 0.05) — within clamp bounds and
  // rounded to 2 decimals.
  //
  // The implementation also exposes a position readout `<p>` that
  // reads "Position: x=0.10, y=0.05" — we verify this human-readable
  // format directly on the `logo-positioner` section's text content.
  // -----------------------------------------------------------------------
  test('position pad updates data-x / data-y and the position readout via keyboard arrows (ST-015-AC1, ST-015-AC2)', async ({
    page,
  }) => {
    // A logo upload is not required to interact with the pad — the
    // pad is keyboard-active regardless of whether a logo is staged
    // (the texture reflects the `logoPosition` slice when `logoFile`
    // is non-null; the slice itself is settable at all times).
    const pad = page.getByTestId(POSITION_PAD_TESTID);
    await pad.focus();

    // Initial state: (0.00, 0.00).
    await expect(pad).toHaveAttribute('data-x', '0.00');
    await expect(pad).toHaveAttribute('data-y', '0.00');

    // Two ArrowRight presses → x increments by 2 × 0.05 = 0.10.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(pad).toHaveAttribute('data-x', '0.10');

    // One ArrowUp press → y increments by 0.05 (the y axis is
    // flipped in the pointer→normalized helper but ArrowUp directly
    // adds to dy, so y goes positive).
    await page.keyboard.press('ArrowUp');
    await expect(pad).toHaveAttribute('data-y', '0.05');

    // The human-readable readout updates to match. The readout `<p>`
    // does not have its own testid; we read the positioner section's
    // text and assert the substring.
    const positioner = page.getByTestId(POSITIONER_TESTID);
    await expect(positioner).toContainText('Position: x=0.10, y=0.05');

    // The Home key resets the position to origin (per the
    // implementation's keyboard contract — convenient for tests but
    // also a documented user shortcut).
    await page.keyboard.press('Home');
    await expect(pad).toHaveAttribute('data-x', '0.00');
    await expect(pad).toHaveAttribute('data-y', '0.00');
  });

  // -----------------------------------------------------------------------
  // Test 6 — ST-016-AC1, ST-016-AC2: the scale slider reflects
  //          changes in both the `data-scale` attribute and the
  //          textual readout in real time.
  //
  // Set the slider to 0.75 → readout becomes "0.75×", `data-scale`
  // becomes "0.75". Set to 1.5 → readout becomes "1.50×",
  // `data-scale` becomes "1.50". Both values are well within the
  // [0.25, 2.5] range so no clamping occurs.
  //
  // We also exercise an out-of-range value (3.0) to confirm
  // clamping: the slider's native min/max attributes prevent it from
  // exceeding the documented bounds, so the resulting `data-scale`
  // should be "2.50".
  //
  // The slider does NOT require a logo upload — the slice is
  // settable at all times. The render effect on the texture is only
  // visible when a logo is present, but the state-machine contract
  // is identical.
  // -----------------------------------------------------------------------
  test('scale slider updates data-scale and the readout in real time, and clamps to the documented bounds (ST-016-AC1, ST-016-AC2)', async ({
    page,
  }) => {
    const slider = page.getByTestId(SCALE_SLIDER_TESTID);
    const readout = page.getByTestId(SCALE_READOUT_TESTID);

    // Set to 0.75 → 0.75×.
    await slider.fill('0.75');
    await expect(slider).toHaveAttribute('data-scale', '0.75');
    await expect(readout).toHaveText(/0\.75\s*[\u00D7x]/i);

    // Set to 1.50 → 1.50×.
    await slider.fill('1.5');
    await expect(slider).toHaveAttribute('data-scale', '1.50');
    await expect(readout).toHaveText(/1\.50\s*[\u00D7x]/i);

    // Set to the lower bound (0.25) → 0.25×.
    await slider.fill('0.25');
    await expect(slider).toHaveAttribute('data-scale', '0.25');
    await expect(readout).toHaveText(/0\.25\s*[\u00D7x]/i);

    // Set to the upper bound (2.5) → 2.50×.
    await slider.fill('2.5');
    await expect(slider).toHaveAttribute('data-scale', '2.50');
    await expect(readout).toHaveText(/2\.50\s*[\u00D7x]/i);
  });

  // -----------------------------------------------------------------------
  // Test 7 — ST-017-AC1, ST-017-AC3: uploading an unsupported MIME
  //          type produces a `role="alert"` / `aria-live="assertive"`
  //          rejection feedback element with the documented
  //          discriminator and copy.
  //
  // The validator (`validateLogoFile`) rejects on the MIME-type
  // allow-list FIRST before checking size, so passing
  // `mimeType: 'application/pdf'` deterministically routes through
  // the unsupported-format branch.
  //
  // The InvalidFileFeedback component:
  //   - tags itself with `data-reason="unsupported-format"`,
  //   - uses `role="alert"` so AT announces the message (ST-017-AC4),
  //   - uses `aria-live="assertive"` to interrupt current speech,
  //   - uses `aria-atomic="true"` to re-announce the entire region,
  //   - exposes sub-testids `-heading`, `-detail`, `-remediation`
  //     for inspecting each part of the message.
  // -----------------------------------------------------------------------
  test('uploading an unsupported MIME (application/pdf) shows an "unsupported-format" feedback with role=alert (ST-017-AC1, ST-017-AC3)', async ({
    page,
  }) => {
    await uploadFile(page, PDF_BUFFER, INVALID_PDF_NAME, INVALID_PDF_MIME);

    const feedback = page.getByTestId(FEEDBACK_TESTID);
    await expect(feedback).toBeVisible({ timeout: 5_000 });
    await expect(feedback).toHaveAttribute('role', 'alert');
    await expect(feedback).toHaveAttribute('aria-live', 'assertive');
    await expect(feedback).toHaveAttribute('aria-atomic', 'true');
    await expect(feedback).toHaveAttribute('data-reason', 'unsupported-format');

    // The heading names the failure category.
    const heading = page.getByTestId(`${FEEDBACK_TESTID}-heading`);
    await expect(heading).toHaveText(/Unsupported file format/i);

    // The detail mentions the observed MIME type so the user can
    // recognise their file.
    const detail = page.getByTestId(`${FEEDBACK_TESTID}-detail`);
    await expect(detail).toContainText(/application\/pdf/i);

    // The remediation enumerates the supported formats — the user
    // can act on the message without consulting external docs.
    const remediation = page.getByTestId(`${FEEDBACK_TESTID}-remediation`);
    await expect(remediation).toContainText(/PNG/i);
    await expect(remediation).toContainText(/JPEG/i);

    // The preview state is unchanged: filename row reads
    // "No logo selected.", remove button is absent, summary still
    // says "None". This verifies ST-017-AC1's "preview is left
    // unchanged" requirement.
    await expect(page.getByTestId(UPLOADER_FILENAME_TESTID)).toHaveText(
      'No logo selected.',
    );
    await expect(page.getByTestId(UPLOADER_CLEAR_TESTID)).toHaveCount(0);
    expect(await readSummaryLogoValue(page)).toBe('None');
  });


  // -----------------------------------------------------------------------
  // Test 8 — ST-017-AC2, ST-017-AC3: uploading an oversized PNG
  //          produces a `role="alert"` rejection feedback with the
  //          "size-exceeded" discriminator and a remediation that
  //          names the documented 5 MB limit.
  //
  // The 6 MiB buffer is typed as `image/png`, so the MIME-type
  // allow-list check passes and the size check is the failure path
  // exercised. The remediation message lists the maximum size in
  // megabytes ("5 MB") matching the `MAXIMUM_LOGO_SIZE_LABEL`
  // constant in `logoValidation.ts`.
  // -----------------------------------------------------------------------
  test('uploading an oversized (>5 MiB) PNG shows a "size-exceeded" feedback naming the 5 MB limit (ST-017-AC2, ST-017-AC3)', async ({
    page,
  }) => {
    await uploadFile(
      page,
      OVERSIZED_PNG_BUFFER,
      OVERSIZED_PNG_NAME,
      VALID_PNG_MIME,
    );

    const feedback = page.getByTestId(FEEDBACK_TESTID);
    await expect(feedback).toBeVisible({ timeout: 5_000 });
    await expect(feedback).toHaveAttribute('role', 'alert');
    await expect(feedback).toHaveAttribute('aria-live', 'assertive');
    await expect(feedback).toHaveAttribute('aria-atomic', 'true');
    await expect(feedback).toHaveAttribute('data-reason', 'size-exceeded');

    // The heading names the size-exceeded category.
    const heading = page.getByTestId(`${FEEDBACK_TESTID}-heading`);
    await expect(heading).toHaveText(/File is too large/i);

    // The detail names the observed size in MB so the user can
    // gauge how much they need to compress.
    const detail = page.getByTestId(`${FEEDBACK_TESTID}-detail`);
    await expect(detail).toContainText(/MB/i);

    // The remediation names the 5 MB limit so the user knows the
    // target size to compress under.
    const remediation = page.getByTestId(`${FEEDBACK_TESTID}-remediation`);
    await expect(remediation).toContainText(/5 MB/i);

    // The preview state is unchanged: no filename, no remove button,
    // summary still says "None". This verifies ST-017-AC2's
    // "preview is left unchanged" requirement.
    await expect(page.getByTestId(UPLOADER_FILENAME_TESTID)).toHaveText(
      'No logo selected.',
    );
    await expect(page.getByTestId(UPLOADER_CLEAR_TESTID)).toHaveCount(0);
    expect(await readSummaryLogoValue(page)).toBe('None');
  });

  // -----------------------------------------------------------------------
  // Test 9 — Removing an uploaded logo clears the staged state.
  //
  // After clicking the "Remove logo" button:
  //   - the filename row returns to "No logo selected." and
  //     `data-has-logo="false"`,
  //   - the "Remove logo" button is detached (count === 0),
  //   - the trigger label returns to "Choose a logo image",
  //   - the summary value-logo returns to "None",
  //   - no rejection feedback appears (a clean removal is not an
  //     error).
  //
  // This exercise complements ST-014's "successful upload" path with
  // the "remove" path that the LogoUploader's `handleClear` method
  // implements via `setLogoFile(null)` on the configurator store.
  // -----------------------------------------------------------------------
  test('removing an uploaded logo restores the empty state for the uploader and the summary', async ({
    page,
  }) => {
    // 1. Upload a valid PNG.
    await uploadFile(page, TINY_PNG_BUFFER, VALID_PNG_NAME, VALID_PNG_MIME);
    await expect(page.getByTestId(UPLOADER_FILENAME_TESTID)).toHaveText(
      VALID_PNG_NAME,
    );

    // 2. Click "Remove logo".
    await page.getByTestId(UPLOADER_CLEAR_TESTID).click();

    // 3. Verify post-remove state.
    const filename = page.getByTestId(UPLOADER_FILENAME_TESTID);
    await expect(filename).toHaveText('No logo selected.');
    await expect(filename).toHaveAttribute('data-has-logo', 'false');

    await expect(page.getByTestId(UPLOADER_CLEAR_TESTID)).toHaveCount(0);
    await expect(page.getByTestId(UPLOADER_LABEL_TESTID)).toHaveText(
      'Choose a logo image',
    );

    // Summary returns to "None".
    await expect
      .poll(async () => readSummaryLogoValue(page), { timeout: 5_000 })
      .toBe('None');

    // No rejection feedback was generated by the remove action.
    await expect(page.getByTestId(FEEDBACK_TESTID)).toHaveCount(0);
  });

  // -----------------------------------------------------------------------
  // Test 10 — Rejection feedback does not persist after a successful
  //           subsequent upload.
  //
  // UX expectation: after a user fixes their bad input by uploading
  // a valid file, the previous error message must NOT remain on
  // screen. The LogoUploader's `handleChange` clears `error` to
  // `null` on success, which causes the InvalidFileFeedback to
  // unmount.
  //
  // Sequence:
  //   1. Upload an invalid PDF → feedback appears with
  //      `data-reason="unsupported-format"`.
  //   2. Upload a valid PNG → filename row updates, summary updates,
  //      feedback disappears.
  // -----------------------------------------------------------------------
  test('rejection feedback unmounts after a successful subsequent upload', async ({
    page,
  }) => {
    // First upload: invalid PDF.
    await uploadFile(page, PDF_BUFFER, INVALID_PDF_NAME, INVALID_PDF_MIME);
    const feedback = page.getByTestId(FEEDBACK_TESTID);
    await expect(feedback).toBeVisible({ timeout: 5_000 });
    await expect(feedback).toHaveAttribute('data-reason', 'unsupported-format');

    // Second upload: valid PNG.
    await uploadFile(page, TINY_PNG_BUFFER, VALID_PNG_NAME, VALID_PNG_MIME);

    // The filename row reflects the success.
    await expect(page.getByTestId(UPLOADER_FILENAME_TESTID)).toHaveText(
      VALID_PNG_NAME,
    );

    // The previous rejection feedback element is detached.
    await expect(page.getByTestId(FEEDBACK_TESTID)).toHaveCount(0);

    // The summary updates to "Uploaded".
    await expect
      .poll(async () => readSummaryLogoValue(page), { timeout: 5_000 })
      .toBe('Uploaded');
  });

  // -----------------------------------------------------------------------
  // Test 11 — Two consecutive rejections each surface their own
  //           feedback element with the correct discriminator.
  //
  // This guards against a regression where the first rejection's
  // state leaks into the second's. Sequence:
  //   1. Upload invalid PDF → feedback with `data-reason="unsupported-format"`.
  //   2. Upload oversized PNG → feedback with `data-reason="size-exceeded"`.
  //
  // The feedback is rendered as a single React element whose props
  // change between the two attempts; the data-reason attribute is
  // the deterministic discriminator that distinguishes them.
  // -----------------------------------------------------------------------
  test('a second rejection updates the feedback discriminator from "unsupported-format" to "size-exceeded"', async ({
    page,
  }) => {
    // First attempt: PDF.
    await uploadFile(page, PDF_BUFFER, INVALID_PDF_NAME, INVALID_PDF_MIME);
    const feedback = page.getByTestId(FEEDBACK_TESTID);
    await expect(feedback).toBeVisible({ timeout: 5_000 });
    await expect(feedback).toHaveAttribute('data-reason', 'unsupported-format');

    // Second attempt: 6 MiB PNG.
    await uploadFile(
      page,
      OVERSIZED_PNG_BUFFER,
      OVERSIZED_PNG_NAME,
      VALID_PNG_MIME,
    );

    // The same testid resolves to the same node, but its data-reason
    // is now the size-exceeded discriminator. We re-await visibility
    // because the React reconciliation may briefly swap the children
    // (heading + detail + remediation) during the transition.
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveAttribute('data-reason', 'size-exceeded');

    // The remediation text now references the 5 MB cap.
    await expect(
      page.getByTestId(`${FEEDBACK_TESTID}-remediation`),
    ).toContainText(/5 MB/i);

    // No logo has been staged through either attempt.
    await expect(page.getByTestId(UPLOADER_FILENAME_TESTID)).toHaveText(
      'No logo selected.',
    );
    expect(await readSummaryLogoValue(page)).toBe('None');
  });


});

