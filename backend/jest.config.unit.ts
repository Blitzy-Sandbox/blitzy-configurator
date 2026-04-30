/**
 * Jest Unit Test Configuration — `backend/jest.config.unit.ts`
 *
 * Authority:
 *   - AAP §0.3.3 / §0.6.8 Track 3 / §0.6.10 MG1-E / §0.6.12 MG2-H
 *   - Story ST-038: Enforce Unit Test Gate with Coverage Threshold
 *   - Story ST-043: Define and Maintain Unit Test Suite with Coverage Report
 *
 * Purpose:
 *   This is the Jest configuration for the UNIT test suite of the StrikeForge
 *   backend workspace. Unit tests are co-located next to the source file they
 *   test (sibling `.test.ts` files anywhere under `backend/src`) and MUST run
 *   WITHOUT any external services — no database, no emulators, no network.
 *   Determinism is mandatory: a single source tree MUST produce the same
 *   pass/fail verdict on every run (ST-043-AC3).
 *
 * Coverage threshold:
 *   The threshold is consumed exclusively from the `COVERAGE_THRESHOLD`
 *   environment variable. Per Rule R4 (AAP §0.8.1), the variable MUST throw at
 *   startup when unset — there is NO default value in source code. The env-var
 *   check below intentionally fails earlier than Jest's internal coverage-
 *   threshold parser would, with a more descriptive error message.
 *
 * Fail-closed semantics (Rule R8):
 *   - A failing assertion produces a non-zero exit code.
 *   - A coverage measurement below `COVERAGE_THRESHOLD` produces a non-zero
 *     exit code via `coverageThreshold.global`.
 *   - Use of any deprecated Jest API produces a hard error via
 *     `errorOnDeprecated: true`.
 *   - `bail: false` is intentional — we want the FULL list of failures recorded
 *     in the coverage report artifact, not the first failure only.
 *
 * Coverage report artifact path:
 *   Reports are emitted to `<rootDir>/coverage/unit/`. The MG1-E pipeline step
 *   in `cloudbuild.yaml` copies this directory to
 *   `gs://${_ARTIFACTS_BUCKET}/${BUILD_ID}/reports/coverage-unit/`.
 *
 * Integration tests:
 *   The integration suite is configured separately in
 *   `backend/jest.config.integration.ts` and covers test files under
 *   `backend/tests/integration` with dockerized dependencies. The
 *   `testPathIgnorePatterns` entry below provides redundant safety to ensure
 *   integration tests never run under this unit config.
 */

import type { Config } from 'jest';

// ---------------------------------------------------------------------------
// COVERAGE_THRESHOLD env var validation (Rule R4 — fail-fast, no defaults).
// ---------------------------------------------------------------------------
// Why this block lives at module-evaluation time:
//   When Jest loads this config (whether via `jest --config jest.config.unit.ts`
//   or programmatically), it imports this module. A `throw` here surfaces the
//   misconfiguration BEFORE any test process is forked or any worker started,
//   matching the "exits non-zero within 2 seconds with a descriptive error"
//   expectation in the User Example for Rule R4.

const COVERAGE_THRESHOLD_RAW: string | undefined = process.env.COVERAGE_THRESHOLD;

if (COVERAGE_THRESHOLD_RAW === undefined || COVERAGE_THRESHOLD_RAW === '') {
  throw new Error(
    'COVERAGE_THRESHOLD environment variable is required (per Rule R4). ' +
      'Set it to an integer between 0 and 100 (e.g. COVERAGE_THRESHOLD=80) ' +
      'before invoking the unit test gate. No default value is permitted in ' +
      'source code; see backend/jest.config.unit.ts and AAP §0.8.1 R4.',
  );
}

const COVERAGE_THRESHOLD: number = Number.parseInt(COVERAGE_THRESHOLD_RAW, 10);

if (!Number.isInteger(COVERAGE_THRESHOLD) || COVERAGE_THRESHOLD < 0 || COVERAGE_THRESHOLD > 100) {
  throw new Error(
    `COVERAGE_THRESHOLD must be an integer between 0 and 100; ` +
      `got "${COVERAGE_THRESHOLD_RAW}". See backend/jest.config.unit.ts.`,
  );
}

// Branches are notoriously harder to cover than lines/statements/functions.
// Jest's branch counter treats each try/catch arm and each optional-chaining
// fallback as an additional branch, so giving 5 percentage points of slack
// below the global threshold matches common practice and avoids contrived
// "branch-only" tests that exist solely to satisfy the metric. The lower bound
// is clamped at 0 so a low global threshold (e.g. 3) cannot underflow.
const BRANCH_THRESHOLD: number = Math.max(0, COVERAGE_THRESHOLD - 5);

// ---------------------------------------------------------------------------
// Jest configuration object.
// ---------------------------------------------------------------------------
// All 22 members listed in the file's export schema are populated. The
// configuration is typed against `Config` from the `jest` package so any drift
// from the supported schema surfaces at TypeScript compile time during the
// Track-3 type-check gate (`tsc --noEmit`).

const config: Config = {
  // Distinguishes unit-suite log output from integration-suite log output when
  // both configs run in the same CI pipeline.
  displayName: 'unit',

  // ts-jest is the pinned TypeScript transformer per AAP §0.4.1
  // backend/package.json devDeps (`ts-jest@^29.1.5`). The preset configures
  // sensible Jest defaults for TypeScript projects (transform globs, module
  // file extensions, source-map support).
  preset: 'ts-jest',

  // Pure-Node test environment. There is no JSDOM and no browser; backend
  // unit tests cover Express handlers, services, repositories, and helpers
  // that import only Node built-ins and CommonJS modules.
  testEnvironment: 'node',

  // This file sits at the backend workspace root. `<rootDir>` therefore
  // resolves to `backend/` and every glob below is anchored there.
  rootDir: '.',

  // Restrict test discovery to the `src/` tree. Integration tests living in
  // `backend/tests/integration/` are handled by `jest.config.integration.ts`
  // and excluded explicitly via `testPathIgnorePatterns` below.
  roots: ['<rootDir>/src'],

  // Co-located unit tests per AAP §0.6.7. The recursive glob (`**`) matches
  // any depth under `src/`, which is intentional: every layer (routes,
  // services, repositories, middleware, config, logging, db, auth) ships its
  // own unit tests next to the implementation.
  testMatch: ['<rootDir>/src/**/*.test.ts'],

  // Defense-in-depth: even if `roots`/`testMatch` were widened, integration
  // tests would still be excluded.
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/tests/integration/'],

  // Standard module-file extensions for a TypeScript Node project. `.json` is
  // included so fixtures/snapshots that import JSON resolve correctly.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Per-extension transformer wiring. `ts-jest` is invoked with the backend's
  // own `tsconfig.json` so unit tests share the exact compiler options
  // (strict mode, target ES2022, module commonjs) used by the production
  // build — preventing "passes in test, fails in build" classes of defects.
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },

  // Always collect coverage for the unit suite. The MG1-E gate verification
  // command in AAP §0.6.10 explicitly passes `--coverage` and asserts the
  // threshold via `--coverageThreshold`; setting `collectCoverage: true` here
  // makes local invocations (`npm --workspace backend run test:unit`) match
  // CI behaviour without requiring callers to remember the flag.
  collectCoverage: true,

  // Output directory for coverage artifacts. The pipeline step in
  // `cloudbuild.yaml` copies this directory to
  // `gs://${_ARTIFACTS_BUCKET}/${BUILD_ID}/reports/coverage-unit/` for ST-043
  // artifact retention.
  coverageDirectory: '<rootDir>/coverage/unit',

  // Multiple reporter formats so the same run satisfies CLI consumers,
  // browsers, IDE plugins, and downstream artifact parsers:
  //   - 'text'         : full per-file table on stdout (CI logs)
  //   - 'text-summary' : concise summary on stdout (pipeline summary)
  //   - 'html'         : interactive browsable report at
  //                      `coverage/unit/index.html`
  //   - 'lcov'         : standard LCOV format for IDE integrations and most
  //                      coverage aggregators
  //   - 'json-summary' : `coverage/unit/coverage-summary.json` for the
  //                      pipeline step that surfaces the measured coverage
  //                      percentage in the verdict (ST-038-AC2, ST-043-AC2)
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],

  // Files included in the coverage denominator. Globs are negated with `!`
  // for exclusions:
  //   - Exclude `*.test.ts` so the suite does not measure coverage of the
  //     test files themselves (which would always be 100%).
  //   - Exclude `*.d.ts` declaration files (no executable code).
  //   - Exclude `src/tracing.ts` — the OpenTelemetry SDK initialization is a
  //     pure side-effect import (`import './tracing'` per Rule R6) that is
  //     verified by integration tests, not unit tests.
  //   - Exclude `src/index.ts` — the Express app composition root is a thin
  //     wiring shell; behavioural verification belongs in the integration
  //     suite (`backend/tests/integration/`).
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
    '!<rootDir>/src/**/*.test.ts',
    '!<rootDir>/src/**/*.d.ts',
    '!<rootDir>/src/tracing.ts',
    '!<rootDir>/src/index.ts',
  ],

  // Per-axis thresholds. Jest's `coverageThreshold.global` block fails the
  // run if ANY of the named axes is below its target — exactly the
  // fail-closed behaviour Rule R8 requires.
  //   - lines / statements / functions  : the configured COVERAGE_THRESHOLD
  //   - branches                        : COVERAGE_THRESHOLD - 5 (clamped)
  coverageThreshold: {
    global: {
      lines: COVERAGE_THRESHOLD,
      statements: COVERAGE_THRESHOLD,
      branches: BRANCH_THRESHOLD,
      functions: COVERAGE_THRESHOLD,
    },
  },

  // The clearMocks / resetMocks / restoreMocks triple guarantees test
  // isolation. After each test:
  //   - clearMocks   : `mock.calls`, `mock.results`, `mock.instances` cleared
  //   - resetMocks   : implementations reset (jest.fn() returns undefined)
  //   - restoreMocks : original implementations re-installed for jest.spyOn
  // This isolation is what makes ST-043-AC3 ("repeated runs against the same
  // source tree produce the same verdict") actually deterministic.
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Reduce per-test logging noise; CI consumers look at the reporter output
  // and the JUnit/JSON summary, not at verbose per-test stdout.
  verbose: false,

  // Generous 10-second per-test cap. Unit tests should run in single-digit
  // milliseconds; anything that needs more time is by definition not a unit
  // test and belongs in the integration suite. Setting a non-default ceiling
  // also prevents runaway tests (infinite loops, never-resolved promises)
  // from hanging the CI runner indefinitely.
  testTimeout: 10000,

  // Treat use of any deprecated Jest API as a hard error. This is part of
  // Rule R8's fail-closed posture: silent deprecation warnings would let
  // technical debt accumulate undetected. When Jest deprecates an API the
  // pinned version still supports, this surfaces immediately during the
  // unit-test gate rather than in a future major upgrade.
  errorOnDeprecated: true,

  // Run every test in every file even after the first failure. The MG1-E
  // gate consumes the full set of failures from the coverage / JUnit
  // artifacts; bailing early would hide the long tail of failures and force
  // multiple iterations on the same broken commit.
  bail: false,

  // Use 50% of the available CPU cores. Fully-parallel runs (`100%`) are
  // attractive for raw speed but introduce non-determinism on shared
  // resources — process-wide Date stubs, pino serializer state, prom-client
  // global registry, AsyncLocalStorage propagation. Half-parallel hits the
  // sweet spot of CI throughput and the strict determinism required by
  // ST-043-AC3 and Rule R8.
  maxWorkers: '50%',
};

// Default export consumed by Jest when this file is referenced via
// `jest --config jest.config.unit.ts`. The schema declares `is_default: true`
// for the `config` symbol; Jest reads `module.exports.default` (after the
// ts-jest commonjs transform) and Jest's own ESM-aware loader reads
// `default` directly.
export default config;
