# frontend/visual-baselines/

This folder stores the **versioned baseline PNG snapshots** consumed by the
Playwright visual regression test suite under `frontend/tests/visual/*.spec.ts`.
Baselines are committed to git so that every PR's visual regression run
compares against an explicit, reviewable baseline rather than auto-capturing
fresh screenshots at run time. The folder is the canonical `snapshotDir` value
configured in `frontend/playwright.config.ts`; Playwright reads from and writes
to this path whenever `expect(page).toHaveScreenshot()` is exercised.

## Authoritative Story (ST-046)

The binding ticket for everything in this folder is
**ST-046 — Define and Maintain Visual Regression Test Suite with Baselines**
(epic EP-010), which lives at
`tickets/stories/ST-046-visual-regression-test-suite.md` and supplies the
acceptance criteria that govern this folder's contents and workflow.

The five acceptance criteria, restated in plain operational language:

- **AC1 — Coverage:** The configurator, design list, cart, and order
  confirmation surfaces all have committed baselines, and the suite is
  triggered on every pull request open and on every subsequent push to an
  open pull request against the default branch.
- **AC2 — Comparison:** Each capture is compared at a fixed viewport size
  (1280x720) against its committed baseline; deltas exceeding the documented
  pixel-difference threshold produce a failed verdict.
- **AC3 — Reporting:** Failed runs surface side-by-side baseline and current
  screenshots in the Playwright HTML report at a documented path; merge is
  blocked until the difference is acknowledged.
- **AC4 — Explicit commits:** Baseline updates require an explicit
  `git add` + `git commit` by a developer or QA engineer running
  `--update-snapshots` locally. CI never auto-updates baselines, and no run
  can silently overwrite a committed baseline with a new capture.
- **AC5 — Local runnability:** The suite runs in the local development
  environment against locally-started services using
  `cd frontend && npx playwright test tests/visual/`.

## Contents

This folder is initially empty (with a `.gitkeep` placeholder and this README)
until the first run of `--update-snapshots`. Once populated by Playwright, the
folder mirrors the relative path from `testDir` (`./tests`) to each spec file
and adds a per-spec `-snapshots` subdirectory holding the PNG captures, with
per-project (chromium, webkit) and per-platform (linux, darwin, win32)
suffixes appended automatically by Playwright at snapshot capture time.

For each call site of the form
`await expect(page).toHaveScreenshot('<name>.png')` inside a test under
`frontend/tests/visual/`, Playwright writes a baseline at:

```text
frontend/visual-baselines/visual/<spec-file-name>-snapshots/<name>-<project>-<platform>.png
```

Expected layout AFTER the visual suite has been fully populated on Linux CI
under both `chromium` and `webkit` projects:

```text
frontend/visual-baselines/
  .gitkeep
  README.md
  visual/
    configurator.spec.ts-snapshots/
      configurator-default-chromium-linux.png
      configurator-default-webkit-linux.png
      configurator-customized-chromium-linux.png
      configurator-customized-webkit-linux.png
    design-list.spec.ts-snapshots/
      design-list-empty-chromium-linux.png
      design-list-empty-webkit-linux.png
      design-list-populated-chromium-linux.png
      design-list-populated-webkit-linux.png
    cart.spec.ts-snapshots/
      cart-with-items-chromium-linux.png
      cart-with-items-webkit-linux.png
    order-confirmation.spec.ts-snapshots/
      order-confirmation-chromium-linux.png
      order-confirmation-webkit-linux.png
```

The `visual/` parent (mirroring `tests/visual/`), the `-snapshots`
subdirectory suffix on each spec name, and the `-{project}-{platform}.png`
filename suffix are all added automatically by Playwright; you do NOT
manually create these subdirectories or filenames. The leading
`<name>` portion of each PNG is taken from the string argument passed to
`toHaveScreenshot()` in the spec file. If a spec calls
`toHaveScreenshot()` without an explicit name, Playwright synthesizes one
from the test title and an auto-incrementing index — which is harder to
review, so the visual specs always pass an explicit name argument.

Playwright derives the platform segment from `process.platform`, so:

- **CI runs on Linux**, so committed baselines are typically `*-linux.png`.
- Developers regenerating locally on macOS produce `*-darwin.png` files;
  Windows produces `*-win32.png`. CI runners on Linux ignore non-Linux
  baselines unless a Linux variant is also present in the same folder.
- The recommended local workflow when contributing new baselines is to
  regenerate inside a Linux Docker container that matches the CI runner so
  the committed PNG suffix matches what CI will compare against.

## Generating Baselines (First Run or Refresh)

Use these steps when capturing initial baselines or refreshing existing
baselines after an intentional UI change. **Every step that ends with a
commit is required by ST-046-AC4** — the explicit commit is what prevents
silent overwrites.

1. Ensure local services are up:

```bash
docker compose up -d
```

This starts `backend`, `postgres`, `firebase-auth-emulator`, and
`gcs-emulator` per the local-development infrastructure plan.

2. Apply database migrations so the backend has the schema the visual
   surfaces depend on (designs, cart, orders):

```bash
docker compose exec backend npx node-pg-migrate up
```

3. From the `frontend/` workspace, run the visual suite with
   `--update-snapshots`. Use the npm script:

```bash
cd frontend
npm run test:visual:update
```

or invoke Playwright directly:

```bash
cd frontend
npx playwright test tests/visual/ --update-snapshots
```

This runs the four visual spec files (`configurator.spec.ts`,
`design-list.spec.ts`, `cart.spec.ts`, `order-confirmation.spec.ts`) under
both `chromium` and `webkit` projects defined in
`frontend/playwright.config.ts`, capturing fresh PNGs in
`frontend/visual-baselines/`.

4. Review the diff in your working tree before staging anything:

```bash
git status frontend/visual-baselines/
git diff --stat frontend/visual-baselines/
```

You should see only the PNG files you intended to refresh. If unexpected
files appear (e.g., baselines for a surface you did not touch), investigate
before committing — an unintended baseline change is usually a regression
masquerading as an "update".

5. Commit the baselines explicitly. **This is the ST-046-AC4 step:**

```bash
git add frontend/visual-baselines/
git commit -m "test(visual): refresh visual regression baselines for <surface(s)>"
```

The PR description must explain WHY the baseline changed; reviewers reject
PRs that update baselines without a stated cause.

## Verifying Against Baselines (CI and Local)

To run the visual suite in verification mode against the committed
baselines (the mode CI uses on every PR), invoke either:

```bash
cd frontend
npm run test:visual
```

or:

```bash
cd frontend
npx playwright test tests/visual/
```

When verification fails:

- Playwright writes the actual screenshot, the original baseline, and a
  pixel-diff PNG into `frontend/test-results/<test-name>/`.
- The HTML report at `frontend/playwright-report/index.html` shows
  side-by-side `expected`, `actual`, and `diff` columns for each failing
  comparison, satisfying ST-046-AC3.
- The Playwright process exits with a non-zero status code.
- In CI (Cloud Build via `cloudbuild.yaml`), this exit code blocks the
  build per Rule R8 ("gates fail closed") — the failed verdict is never
  silently downgraded.

## Reviewer Checklist

Use this checklist when a pull request modifies any file in
`frontend/visual-baselines/`:

- Confirm the PR description explains WHY the visual baseline changed
  (e.g., "intentional color tweak in `PrimaryColorPicker`", "viewport
  size adjustment for ST-022 sidebar", "new design surface added").
- Confirm only the expected baselines were updated. A change to one
  component should not produce diffs in unrelated baselines; cross-surface
  diffs usually indicate an accidental global style change.
- Open each changed PNG and visually inspect it. Reject if the change
  introduces unintended layout shifts, color regressions, missing focus
  rings, or accessibility regressions (loss of contrast, missing labels).
- Confirm the developer ran `--update-snapshots` on a platform whose
  suffix matches the committed file (typically `*-linux.png` for CI
  parity, captured via Docker if the developer is on macOS or Windows).
- Confirm any deleted baselines correspond to legitimately removed UI
  surfaces (e.g., a retired modal), not accidentally deleted ones.
- Confirm both `chromium` and `webkit` baselines are present for any
  refreshed surface — committing only one project leaves the other
  unprotected.

## Pixel Difference Threshold

The per-screenshot pixel-difference threshold is configured in
`frontend/playwright.config.ts` via the `expect.toHaveScreenshot`
configuration block. The configured values are:

- `maxDiffPixelRatio: 0.01` — at most 1% of the captured pixels may
  differ between the actual screenshot and the committed baseline before
  the comparison fails.
- `threshold: 0.2` — the perceptual color-distance threshold (in YIQ
  color space, Playwright's pixelmatch default) for a single pixel to be
  considered "different" from its baseline counterpart.
- `animations: 'disabled'` — disables CSS animations during capture so
  that comparisons are deterministic across runs and platforms.

Any change to these thresholds is itself a non-trivial implementation
decision per the user-provided Explainability Rule and **must** be
recorded as a new row in `docs/decisions/README.md` before the change is
committed. Do not loosen the thresholds to make a flaky baseline pass —
fix the underlying determinism problem (e.g., disable an animation, mock
a clock, freeze a random seed) instead.

## Per-Browser Coverage

The visual suite runs under both `chromium` and `webkit` Playwright
projects, configured as separate entries in the `projects` array of
`frontend/playwright.config.ts`. Each baseline is captured separately
for each project, so each visual spec produces 2 baselines per platform
per surface (one for Chromium / Blink, one for WebKit).

This dual-browser coverage exists because:

- Chromium and WebKit have independent text rasterization, font fallback
  selection, and CSS rendering implementations. A change that looks fine
  on Chromium can regress on WebKit and vice versa.
- Real users open the configurator across both engine families
  (Chrome / Edge use Blink; Safari uses WebKit).

When refreshing baselines for a UI change, ensure both project variants
are regenerated. Committing a baseline ONLY for chromium leaves webkit
unprotected and lets a real WebKit-specific regression slip through; the
reviewer checklist above explicitly verifies both are present.

## Binary Asset Notes

PNG baselines are binary assets, not source code. They are intentionally:

- **Committed to git** — by design, per ST-046-AC4. The repository's
  root `.gitignore` does NOT contain `*.png` or
  `frontend/visual-baselines/` patterns. The baseline folder is the
  one Playwright artifact directory that is version-controlled.
- **Excluded from TypeScript compilation** — `frontend/visual-baselines`
  appears in the root `tsconfig.json` `exclude` list, and
  `frontend/tsconfig.json` also excludes the folder. PNG files are not
  TypeScript sources and never participate in `tsc --noEmit`.
- **Excluded from ESLint** — `frontend/visual-baselines/` is in the root
  `.eslintrc.json` `ignorePatterns` array. ESLint never traverses this
  folder.
- **Excluded from the Vite build** — Vite's `frontend/vite.config.ts`
  bundles only `frontend/src/` and `frontend/index.html`; the
  visual-baselines folder is outside Vite's scope and is never copied
  into `frontend/dist/`.
- **Excluded from Prettier** — `frontend/visual-baselines/` is listed in
  `.prettierignore`, and Prettier ignores binary files automatically in
  any case.

Together, these exclusions keep the baseline folder isolated from every
quality gate that operates on source code, while still leaving it
version-controlled so that changes to the rendered UI are reviewable as
diffs in pull requests.

## Diff Artifacts (not committed)

When a comparison fails during a verification run (i.e., when the suite
is invoked WITHOUT `--update-snapshots`), Playwright writes diagnostic
images alongside the actual screenshot and the baseline:

- `*-actual.png` — the screenshot Playwright captured this run.
- `*-diff.png` — a pixel-diff overlay highlighting the regions that
  differ from the baseline.
- The original `*.png` baseline is also copied into the failure folder
  so all three can be opened side-by-side from the HTML report.

These diagnostic images live under `frontend/test-results/` and are
**not** committed. The repository's `.gitignore` includes:

- `**/test-results/`
- `**/test-results/**/*-diff.png`
- `**/test-results/**/*-actual.png`

Only the COMMITTED `*.png` files in `frontend/visual-baselines/` are
baseline references; everything in `frontend/test-results/` is
ephemeral CI / local-run output that is recreated on every test run.

## Cross-References

Important paths the reader may want to navigate to from here:

- `frontend/playwright.config.ts` — Configures
  `snapshotDir: './visual-baselines'`, the `chromium` and `webkit`
  projects, the fixed `1280x720` viewport, and the `toHaveScreenshot`
  thresholds described above.
- `frontend/tests/visual/configurator.spec.ts` — Visual tests for the
  configurator surface (default and customized states).
- `frontend/tests/visual/design-list.spec.ts` — Visual tests for the
  saved-designs list (empty and populated states).
- `frontend/tests/visual/cart.spec.ts` — Visual tests for the cart
  surface.
- `frontend/tests/visual/order-confirmation.spec.ts` — Visual tests for
  the order confirmation surface.
- `tickets/stories/ST-046-visual-regression-test-suite.md` — Source of
  truth for AC1 through AC5; this README is a faithful operational
  paraphrase of that story.
- `docs/decisions/README.md` — Per the Explainability Rule, any
  threshold or coverage-scope changes must be documented here as a new
  decision-log row before the change ships.
- `cloudbuild.yaml` — CI pipeline that runs the test suites; the visual
  suite participates via the integration test step and inherits Rule R8
  fail-closed semantics.
