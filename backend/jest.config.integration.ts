/**
 * Jest Integration Test Configuration — `backend/jest.config.integration.ts`
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - AAP §0.3.3 / §0.6.8 Track 3 / §0.6.10 MG1-E / §0.6.12 MG2-H
 *   - Story ST-039: Enforce Integration Test Gate After Unit Test Pass
 *       AC1: Gate triggers AFTER unit gate passes for the same `COMMIT_SHA`.
 *       AC2: Emits integration report artifact at documented path.
 *       AC3: Failing gate blocks merge; passing publishes the report.
 *       AC4: Dependencies declared in versioned source; reproducible.
 *   - Story ST-044: Define and Maintain Integration Test Suite
 *       AC1: Triggered on every PR open and every push to an open PR.
 *       AC2: Deterministic fixtures; emits integration report artifact.
 *       AC3: Distinguishes assertion failures from environment/fixture-setup
 *            failures in the report.
 *       AC4: Runs against locally-started dependencies; no network access
 *            to remote environments.
 *   - Rule R4 (AAP §0.8.1): All six required env vars MUST throw at startup
 *                           when unset; no fallback values in source code.
 *   - Rule R6 / C4 (AAP §0.8.1 / §0.2.2): OpenTelemetry auto-instrumentations
 *                                          MUST be registered before any
 *                                          application import. The
 *                                          `setupFiles` entry below loads
 *                                          `register-tracing.ts`, which is
 *                                          the integration-suite analogue of
 *                                          the first-line `import './tracing'`
 *                                          in `backend/src/index.ts`.
 *   - Rule R8 (AAP §0.8.1): Gates fail closed — any infrastructure or tooling
 *                           error MUST produce a failed verdict.
 *   - LocalGCP Verification Rule (AAP §0.8.2): Integration tests MUST create
 *                                              their own resources at setup
 *                                              and clean up at teardown — no
 *                                              dependence on pre-existing
 *                                              emulator state.
 *
 * ============================================================================
 * Purpose
 * ============================================================================
 *   This is the Jest configuration for the INTEGRATION test suite of the
 *   backend workspace. Integration tests:
 *     - Live in `backend/tests/integration/**\/*.test.ts` (per AAP §0.6.7
 *       and the existing `tests/integration/observability/*.integration.test.ts`
 *       files which match the `**\/*.test.ts` glob).
 *     - Exercise service-to-service interactions against dockerized
 *       dependencies declared in `docker-compose.yml`:
 *         * PostgreSQL via `127.0.0.1:5432` (DATABASE_URL TCP form).
 *         * Firebase Auth Emulator via `localhost:9099`.
 *         * fake-gcs-server via `GCS_EMULATOR_HOST` (typically
 *           `http://localhost:4443`).
 *     - Use HTTP (supertest) against the Express app to verify routes
 *       end-to-end at the service boundary.
 *     - Create and clean up their own resources at setup/teardown — no
 *       dependence on pre-existing emulator state (LocalGCP Rule).
 *
 * ============================================================================
 * MG1-E Verification Command (verbatim from AAP §0.6.10)
 * ============================================================================
 *   ```bash
 *   cd backend && npx jest --config jest.config.integration.ts --forceExit
 *   echo "integration: $?"
 *   # expected exit: 0
 *   ```
 *
 * ============================================================================
 * Cloud Build Coordination (AAP §0.6.12)
 * ============================================================================
 *   The integration step in `cloudbuild.yaml` sets all six required env vars
 *   and runs:
 *     ```
 *     cd backend && npx jest --config jest.config.integration.ts --forceExit \
 *       --ci --json --outputFile=/workspace/reports/jest-integration-results.json
 *     ```
 *   The `reports/integration-junit.xml` artifact (jest-junit reporter) plus the
 *   `--outputFile` JSON artifact are uploaded by the pipeline's artifact
 *   block to `gs://${_ARTIFACTS_BUCKET}/${BUILD_ID}/reports/`.
 *
 * ============================================================================
 * Failure Categorization (ST-044-AC3)
 * ============================================================================
 *   The JUnit XML output structurally distinguishes the two failure classes:
 *     - Setup hook failures (from `globalSetup`, `beforeAll`, `beforeEach`)
 *       appear as `<error>` elements at the suite level → environment /
 *       fixture-setup failures.
 *     - Test-assertion failures appear as `<failure>` elements at the
 *       testcase level → assertion failures.
 *   Cloud Build's artifact aggregator parses these element names natively.
 *   Operators triaging a failed run can grep the report for `<error` to find
 *   environment failures and `<failure` to find genuine assertion regressions.
 *
 * ============================================================================
 * Why `tsconfig.spec.json` Instead of `tsconfig.json` for ts-jest
 * ============================================================================
 *   The backend's primary `tsconfig.json` excludes `tests/integration/**\/*.ts`
 *   and enforces `noUnusedLocals: true` / `noUnusedParameters: true`. The
 *   sibling `tsconfig.spec.json` extends `tsconfig.json` but:
 *     - Includes `tests/**\/*.ts` and the two jest config files explicitly.
 *     - Sets `noUnusedLocals: false` and `noUnusedParameters: false` so test
 *       files that destructure response payloads without consuming every
 *       field compile cleanly.
 *     - Sets `noEmit: true` because tests are never built into the production
 *       bundle.
 *   The same `tsconfig.spec.json` is referenced by `backend/.eslintrc.json`
 *   (`parserOptions.project`) so ESLint and ts-jest see the same compiler
 *   context — a single source of truth for "how integration test TypeScript
 *   is compiled". This eliminates the failure mode where `tsc --noEmit`
 *   passes (using `tsconfig.spec.json`) but `jest --config jest.config.integration.ts`
 *   fails on the same files (because it would see different compiler options
 *   under `tsconfig.json`).
 *
 * ============================================================================
 * Why `maxWorkers: 1`
 * ============================================================================
 *   Integration tests share the single PostgreSQL database, the single
 *   fake-gcs-server bucket, and the single Firebase Auth emulator project.
 *   Parallel execution would race on:
 *     - Migrations (only one connection should run them at a time).
 *     - Test rows (parallel writes to the same table corrupt fixtures).
 *     - GCS object names (parallel uploads to the same key collide).
 *     - Firebase user records (parallel creates with the same email collide).
 *   Serial execution (`maxWorkers: 1`) is the pragmatic guarantee of
 *   determinism (ST-044-AC2). The throughput cost is acceptable because the
 *   suite runs ONLY in CI gate position MG1-E, never in inner-loop
 *   developer iterations.
 *
 * ============================================================================
 * Why `detectOpenHandles: true` and `forceExit: false`
 * ============================================================================
 *   `detectOpenHandles: true` instructs Jest to surface any open handles
 *   (sockets, timers, DB connections) at the end of the run with a stack
 *   trace pointing at the leaking source — invaluable when a test forgets
 *   to close a `pg.Client`. The cost is a brief delay during teardown to
 *   inspect the handle queue; this is acceptable in a serialized integration
 *   run.
 *
 *   `forceExit: false` defers the "kill the process even if handles are
 *   open" behavior to the CLI flag (`--forceExit`) used in the AAP
 *   verification command. This separation lets local debugging see the
 *   open-handle diagnostic (no `--forceExit` → process hangs visibly) while
 *   CI invocations still terminate promptly (`--forceExit` is passed by
 *   `cloudbuild.yaml`).
 *
 * ============================================================================
 * Why `collectCoverage: false`
 * ============================================================================
 *   Coverage is a unit-test concern (ST-038/ST-043). The integration suite
 *   exercises real network paths and ORM code paths that would inflate
 *   coverage numbers without proving the unit-level invariants the gate
 *   actually wants to enforce. Keeping coverage off here keeps the gate
 *   metric meaningful and shaves substantial run time off the suite.
 *
 * ============================================================================
 * Forbidden Patterns (Documented for Reviewers)
 * ============================================================================
 *   - DO NOT add fallback values for the six required env vars. Rule R4
 *     mandates a fail-fast throw within 2 seconds of process start.
 *   - DO NOT set `maxWorkers > 1` without first introducing per-worker
 *     database isolation (separate schemas, transaction wrappers per test).
 *   - DO NOT set `bail: true`. The MG1-E pipeline step needs the full set
 *     of failures recorded in the JUnit artifact for triage.
 *   - DO NOT enable `collectCoverage: true` here. Use the unit suite for
 *     coverage; integration coverage conflates metric with setup-heavy
 *     paths.
 *   - DO NOT change `setupFiles: ['register-tracing.ts']` to
 *     `setupFilesAfterEnv`. By the latter phase, Jest's framework has
 *     already required some of the OTel instrumentation targets
 *     (e.g., `http`), and instrumentation would be partial. Rule R6 / C4.
 *   - DO NOT include `<rootDir>/src` in `roots` or `testMatch`. Co-located
 *     unit tests under `src/` are owned by `jest.config.unit.ts`.
 */

import type { Config } from 'jest';

// ===========================================================================
// Section 1 — Required Env Var Validation (Rule R4 — fail-fast, no defaults)
// ===========================================================================
//
// Why this block runs at module-evaluation time:
//   When Jest loads this config (whether via `jest --config jest.config.integration.ts`
//   or programmatically through ts-jest), it imports this module BEFORE
//   forking any worker or running any test. A `throw` here surfaces the
//   misconfiguration immediately — within Rule R4's 2-second budget for
//   "exits non-zero with a descriptive error" — and prevents the much more
//   confusing failure mode where individual tests fail with "DATABASE_URL is
//   undefined" deep inside `pg`'s connection logic.
//
// Why the list is duplicated here rather than imported from
// `backend/src/config/env.ts`:
//   The integration suite's `globalSetup` (which we register below) ALSO
//   duplicates this list verbatim — see the file header in
//   `backend/tests/integration/setup/global-setup.ts` for the rationale.
//   At the Jest config-load phase the module-resolution context for
//   `backend/src/**` is not guaranteed to match the test workers' context
//   (different ts-jest cache, different transformer state). Inline
//   validation is robust against those harness-level variations and keeps
//   the config file self-contained — it cannot fail to load due to a
//   missing or broken `src/config/env.ts`. The two lists MUST be kept in
//   sync; a change to `REQUIRED_ENV_VARS` in the canonical source MUST
//   land in the same commit that updates this file.
//
// Why empty strings are treated as unset:
//   A `.env` line of the form `DATABASE_URL=` (no value after the equals
//   sign) is indistinguishable from "forgot to set it" and MUST fail. This
//   matches the canonical `requireEnv` semantics in
//   `backend/src/config/env.ts`.
//
// Why we name the variable but never log its value:
//   Rule R2 (no credential material in logs) — the message names the
//   offending VARIABLE NAME but never the VALUE. A message like
//   `Error: DATABASE_URL is not set` is correct; a message like
//   `Error: DATABASE_URL=postgres://user:pwd@host` would leak credentials
//   (DATABASE_URL contains the database password in production).

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'GCS_BUCKET_NAME',
  'GCS_EMULATOR_HOST',
  'COVERAGE_THRESHOLD',
  'GCP_REGION',
] as const;

for (const name of REQUIRED_ENV_VARS) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `[jest.config.integration] Required environment variable "${name}" is not set ` +
        '(per Rule R4). Integration tests require all six env vars to be populated: ' +
        `${REQUIRED_ENV_VARS.join(', ')}. ` +
        'See backend/.env.example for documentation, copy it to backend/.env, fill in ' +
        'values, and re-run. Cloud Build sets these via _SUBSTITUTIONS in cloudbuild.yaml.',
    );
  }
}

// ===========================================================================
// Section 2 — Jest Configuration Object
// ===========================================================================
//
// Every member is documented inline. The configuration is typed against
// `Config` from the `jest` package so any drift from the supported schema
// surfaces at TypeScript compile time during the Track-3 type-check gate
// (`tsc --noEmit`).

const config: Config = {
  // -------------------------------------------------------------------------
  // Suite identity
  // -------------------------------------------------------------------------
  // Distinguishes integration-suite output from unit-suite output when both
  // configs run in the same CI pipeline (MG1-E runs unit then integration in
  // sequence). The string appears as a label in `--verbose` output and in
  // any reporter that surfaces the project name.
  displayName: 'integration',

  // -------------------------------------------------------------------------
  // TypeScript transformer
  // -------------------------------------------------------------------------
  // ts-jest is the pinned TypeScript transformer per AAP §0.4.1
  // (`backend/package.json` devDependencies — `ts-jest@^29.1.5`). The preset
  // configures sensible Jest defaults for TypeScript projects: transform
  // globs, module file extensions, source-map support, and ESM/CJS
  // interop. We override the preset selectively below where needed.
  preset: 'ts-jest',

  // -------------------------------------------------------------------------
  // Runtime environment
  // -------------------------------------------------------------------------
  // Pure-Node test environment. There is no JSDOM and no browser; backend
  // integration tests cover Express routes, services, repositories, and
  // middleware that import only Node built-ins, CommonJS modules, and the
  // dockerized dependencies (PostgreSQL, fake-gcs-server, Firebase Auth
  // emulator). A JSDOM environment would bring in `window`/`document`
  // globals, slow startup, and add no value here.
  testEnvironment: 'node',

  // -------------------------------------------------------------------------
  // Path anchoring
  // -------------------------------------------------------------------------
  // This file sits at the backend workspace root. `<rootDir>` resolves to
  // `backend/` and every glob below is anchored there. Using `'.'` (rather
  // than an absolute path) keeps the config portable between developer
  // workstations, Cloud Build, and the docker-compose `backend` service —
  // all of which mount the source tree at different absolute paths.
  rootDir: '.',

  // -------------------------------------------------------------------------
  // Test discovery
  // -------------------------------------------------------------------------
  // Restrict test discovery to the integration test tree. This matches the
  // AAP §0.6.7 layout (`backend/tests/integration/**/*.test.ts`).
  // Co-located unit tests under `backend/src/**/*.test.ts` are handled by
  // `jest.config.unit.ts` and explicitly excluded below via
  // `testPathIgnorePatterns`.
  roots: ['<rootDir>/tests/integration'],

  // The recursive `**` glob matches any depth under `tests/integration`,
  // which captures both the existing flat layout (e.g.
  // `tests/integration/observability/foo.integration.test.ts`) and the
  // future grouped layout (e.g. `tests/integration/routes/auth/login.test.ts`)
  // without requiring a config update. The trailing `*.test.ts` matches the
  // canonical Jest test-file extension; `*.integration.test.ts` files (such
  // as the existing observability tests) match this glob because they end
  // in `.test.ts`.
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],

  // Defense-in-depth path exclusions:
  //   - `/node_modules/` : never run vendored test files.
  //   - `/dist/`         : never run compiled artifacts (would duplicate
  //                        execution of TS-source tests).
  //   - `/src/`          : co-located unit tests under `backend/src/` are
  //                        OWNED by `jest.config.unit.ts`. Including this
  //                        path here is critical — without it, a future
  //                        widening of `roots` or `testMatch` would silently
  //                        run unit tests under integration mode (against
  //                        live emulators), producing flaky verdicts.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/'],

  // -------------------------------------------------------------------------
  // Module resolution
  // -------------------------------------------------------------------------
  // Standard module-file extensions for a TypeScript Node project. `.json`
  // is included so fixtures that import JSON resolve correctly (e.g.
  // golden-payload fixtures stored as `*.fixture.json`). The order matches
  // ts-jest's preset default and is intentionally preserved.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // -------------------------------------------------------------------------
  // Per-extension transformer wiring
  // -------------------------------------------------------------------------
  // ts-jest transforms `.ts`/`.tsx` files using the compiler options from
  // `tsconfig.spec.json`. See the file header section "Why `tsconfig.spec.json`
  // Instead of `tsconfig.json`" for the full rationale. In short:
  //   - `tsconfig.spec.json` extends `tsconfig.json` and includes
  //     `tests/**/*.ts` plus the two jest config files.
  //   - It sets `noUnusedLocals: false` and `noUnusedParameters: false`
  //     so test files compile cleanly when destructuring without consuming
  //     every field.
  //   - It is also the project file used by `.eslintrc.json` for parsing
  //     test files, ensuring ESLint and ts-jest agree on compiler context.
  // The `^.+\.(ts|tsx)$` regex matches any `.ts` or `.tsx` file under the
  // test tree.
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Lifecycle hooks (the four files in depends_on_files)
  // -------------------------------------------------------------------------
  // `setupFiles` runs BEFORE the Jest framework is loaded — and BEFORE any
  // test module's `require()` chain begins. This is the ONLY phase in the
  // Jest lifecycle that runs before `pg`, `http`, or `express` could be
  // loaded by test code. The shim at `register-tracing.ts` imports
  // `backend/src/tracing.ts` which synchronously calls `sdk.start()` and
  // registers `@opentelemetry/auto-instrumentations-node`, satisfying
  // Rule R6 / C4 (auto-instrumentation MUST be registered before any
  // application import). Moving this to `setupFilesAfterEnv` would silently
  // break Rule R6 — by that phase, Jest's framework has already loaded some
  // of the instrumentation targets and instrumentation would be partial.
  setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts'],

  // `globalSetup` runs ONCE per integration test run, in a SEPARATE Node
  // process from the test workers, BEFORE any test file is loaded. The
  // default-exported async function in `global-setup.ts` is responsible
  // for: validating the six required env vars, waiting for PostgreSQL to
  // be reachable, applying all migrations forward (ST-030/ST-031/ST-035),
  // creating the unique-per-run test GCS bucket (LocalGCP Verification
  // Rule), verifying Firebase Auth emulator reachability, and initializing
  // the test-user tracking file used by per-suite firebase-user fixtures.
  // Failures from this hook propagate uncaught to Jest, which renders them
  // as JUnit `<error>` elements at the suite level — distinct from the
  // `<failure>` elements produced by per-test assertion failures
  // (ST-044-AC3 categorization).
  globalSetup: '<rootDir>/tests/integration/setup/global-setup.ts',

  // `globalTeardown` runs ONCE per integration test run, in a SEPARATE
  // Node process from the test workers, AFTER all test files complete.
  // The default-exported async function in `global-teardown.ts` is
  // responsible for: deleting test users from the Firebase Auth emulator
  // via the Identity Toolkit admin REST endpoint, deleting the test GCS
  // bucket from fake-gcs-server, reversing all migrations (validating
  // ST-030-AC3/ST-031-AC3/ST-035-AC4 down-migration idempotency at every
  // CI run), and cleaning up the `/tmp/strikeforge-*.json` cross-process
  // tracking files. Best-effort by design: cleanup errors are logged but
  // do NOT mark the run failed (the verdict has already been determined
  // by this point).
  globalTeardown: '<rootDir>/tests/integration/setup/global-teardown.ts',

  // `setupFilesAfterEnv` runs ONCE per test FILE after Jest's framework
  // is initialized (`expect`, `jest`, `beforeAll`, `beforeEach`,
  // `afterEach`, `afterAll`, `jest.setTimeout()`, `expect.extend()`).
  // The side-effect module at `per-suite.ts` registers custom matchers
  // (`toBeUuid`, `toMatchTraceId`, `toMatchSpanId`, `toMatchCorrelationId`),
  // installs the unhandled-rejection guard that surfaces missed `await`s
  // as fail-closed assertion errors (Rule R8), and sets the per-test
  // timeout. Tests should NOT import this file directly — the file's
  // purpose is side effects only.
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup/per-suite.ts'],

  // -------------------------------------------------------------------------
  // Coverage (intentionally OFF for integration)
  // -------------------------------------------------------------------------
  // Coverage is a unit-test concern (ST-038/ST-043). Integration coverage
  // conflates the metric with setup-heavy, network-bound paths and would
  // make the threshold artificially easier to satisfy without proving the
  // invariants the gate actually wants to enforce. Keeping coverage off
  // here also shaves substantial wall-clock time off the suite (instrument
  // injection per file is non-trivial under ts-jest).
  collectCoverage: false,

  // -------------------------------------------------------------------------
  // Mock isolation between tests
  // -------------------------------------------------------------------------
  // The clearMocks / resetMocks / restoreMocks triple guarantees test
  // isolation. After each test:
  //   - clearMocks   : `mock.calls`, `mock.results`, `mock.instances` cleared
  //   - resetMocks   : implementations reset (jest.fn() returns undefined)
  //   - restoreMocks : original implementations re-installed for jest.spyOn
  // This isolation is the prerequisite for ST-044-AC2 ("repeated runs ...
  // produce the same verdict") — without it, mock state from a prior test
  // could change the behavior of a later test's HTTP call.
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // -------------------------------------------------------------------------
  // Reporting verbosity
  // -------------------------------------------------------------------------
  // `verbose: true` prints each test name as it runs. Integration tests are
  // slow relative to unit tests (full HTTP + DB round-trip per case), so
  // having a live progress indicator helps developers (and CI log readers)
  // confirm the suite is making progress rather than hung. The cost is a
  // few extra log lines per run, which the JUnit / JSON artifact consumers
  // ignore.
  verbose: true,

  // -------------------------------------------------------------------------
  // Per-test timeout
  // -------------------------------------------------------------------------
  // 30 seconds per test. Generous because each test makes one or more
  // HTTP round-trips through the Express app, hits PostgreSQL via `pg`,
  // and may touch the GCS or Firebase emulators. The 30-second cap also
  // prevents a hung emulator (e.g. fake-gcs-server lockup) from hanging
  // the CI runner indefinitely — Rule R8 fail-closed posture. Mirrored
  // explicitly in `per-suite.ts` via `jest.setTimeout(30_000)` as a
  // defensive measure against config drift.
  testTimeout: 30000,

  // -------------------------------------------------------------------------
  // Deprecation handling
  // -------------------------------------------------------------------------
  // Treat use of any deprecated Jest API as a hard error. This is part of
  // Rule R8's fail-closed posture: silent deprecation warnings would let
  // technical debt accumulate undetected. When Jest deprecates an API the
  // pinned version still supports, this surfaces immediately during the
  // integration-test gate rather than in a future major upgrade.
  errorOnDeprecated: true,

  // -------------------------------------------------------------------------
  // Failure aggregation
  // -------------------------------------------------------------------------
  // Run every test in every file even after the first failure. The MG1-E
  // gate consumes the full set of failures from the JUnit artifact;
  // bailing early would hide the long tail of failures and force multiple
  // iterations on the same broken commit. This explicitly contradicts
  // common "fail-fast" advice for inner-loop development and is correct
  // for CI: developer iteration speed is preserved by running the unit
  // suite first (which DOES run with bail-equivalent semantics via its
  // coverage gate).
  bail: false,

  // -------------------------------------------------------------------------
  // Worker concurrency (CRITICAL: serial)
  // -------------------------------------------------------------------------
  // `maxWorkers: 1` serializes integration tests. They share the single
  // PostgreSQL database, the single fake-gcs-server bucket, and the single
  // Firebase Auth emulator. Parallel execution would corrupt fixtures and
  // produce non-deterministic verdicts. See the file header section "Why
  // `maxWorkers: 1`" for the full rationale. Do NOT raise this without
  // first introducing per-worker database isolation.
  maxWorkers: 1,

  // -------------------------------------------------------------------------
  // Process exit semantics
  // -------------------------------------------------------------------------
  // `forceExit: false` defers the "kill the process even if handles are
  // open" decision to the CLI flag. The User Example command in AAP
  // §0.6.10 passes `--forceExit` at the CLI; setting it to `true` here
  // would mask developer-time leaks (a test that forgets to close a
  // `pg.Client` would silently exit cleanly under config-driven forceExit
  // but reveal the leak when developers run without the CLI flag). Pairing
  // `forceExit: false` with `detectOpenHandles: true` (below) gives the
  // best of both worlds: developers see leaks; CI terminates promptly via
  // `--forceExit`.
  forceExit: false,

  // `detectOpenHandles: true` instructs Jest to print a stack trace for
  // each open handle (socket, timer, DB connection) at the end of the
  // run. Invaluable when a test forgets to close a `pg.Client` or stops
  // listening to a server. The cost is a brief teardown delay; this is
  // acceptable in a serialized integration run that takes minutes to
  // complete.
  detectOpenHandles: true,

  // -------------------------------------------------------------------------
  // Reporters — JUnit XML output for ST-039-AC2 / ST-044-AC3
  // -------------------------------------------------------------------------
  // The `default` reporter prints the standard CLI output. The `jest-junit`
  // reporter emits a JUnit XML file at `<rootDir>/reports/integration-junit.xml`
  // — the documented integration report artifact path. The XML structurally
  // distinguishes the two failure classes (ST-044-AC3):
  //   - `<failure>` elements at the testcase level → assertion failures.
  //   - `<error>` elements at the suite level → environment / fixture-setup
  //     failures (from globalSetup, beforeAll, beforeEach throws).
  // Cloud Build's artifact aggregator parses these element names natively,
  // so a CI dashboard panel can break the failure count down by category
  // without any custom parsing logic.
  //
  // Reporter options:
  //   - outputDirectory     : `<rootDir>/reports` — uploaded by the
  //                           pipeline's artifact block to
  //                           gs://${_ARTIFACTS_BUCKET}/${BUILD_ID}/reports/.
  //   - outputName          : `integration-junit.xml` — the documented path
  //                           per ST-039-AC2 and ST-044-AC2.
  //   - classNameTemplate   : `{classname}` — uses the describe-block name
  //                           as the JUnit class, which most aggregators
  //                           render as a hierarchical group.
  //   - titleTemplate       : `{title}` — uses the it/test name as the
  //                           testcase title.
  //   - ancestorSeparator   : ' › ' — Unicode breadcrumb separator between
  //                           nested describe blocks. Renders as
  //                           "Auth › Login › invalid token" rather than
  //                           "Auth Login invalid token", which is more
  //                           readable in failure summaries.
  //   - usePathForSuiteName : 'true' — suite names include the file path,
  //                           letting CI dashboards group failures by file.
  //                           Note the string value: jest-junit reads
  //                           options as strings, not booleans, per its
  //                           README.
  //   - addFileAttribute    : 'true' — adds `file="path/to/test.ts"` to
  //                           each `<testcase>` element. Surrounding tools
  //                           (e.g., GitHub Actions' annotation step) read
  //                           this attribute to deep-link from a failed
  //                           testcase to its source file.
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: '<rootDir>/reports',
        outputName: 'integration-junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
        ancestorSeparator: ' › ',
        usePathForSuiteName: 'true',
        addFileAttribute: 'true',
      },
    ],
  ],
};

// ===========================================================================
// Section 3 — Default Export
// ===========================================================================
//
// Default export consumed by Jest when this file is referenced via
// `jest --config jest.config.integration.ts`. The schema declares
// `is_default: true` for the `config` symbol; Jest reads `module.exports.default`
// (after the ts-jest commonjs transform) and Jest's own ESM-aware loader reads
// `default` directly. The `Config` type annotation on the constant above
// guarantees compile-time conformance with Jest's expected configuration shape.

export default config;
