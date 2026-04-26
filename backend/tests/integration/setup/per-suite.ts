/**
 * `per-suite.ts` — Jest `setupFilesAfterEnv` hook for the backend integration
 * test suite.
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - AAP §0.6.4 / §0.6.10 / §0.6.12 (Track 1 Backend, MG1-E, MG2-H)
 *   - Story ST-044: Define and Maintain Integration Test Suite for Service
 *                   Interactions (per-AC3 — distinguish assertion failures
 *                   from environment / fixture-setup failures).
 *   - Story ST-039: Enforce Integration Test Gate After Unit Test Pass
 *                   (gate must fail closed on any failure — Rule R8).
 *   - Story ST-047: Emit Structured Logs with Correlation ID Across Service
 *                   Boundaries (correlation IDs are UUID v4).
 *   - Story ST-049: Propagate Distributed Traces and Publish Dashboard
 *                   Template Stub (W3C trace IDs are 32-hex; span IDs are
 *                   16-hex).
 *   - Story ST-026: Enforce Session Validation Contract on Protected
 *                   Endpoints (integration tests verify the contract; the
 *                   custom matchers here support those assertions).
 *   - Rule R6 / C4 (AAP §0.8.1 / §0.2.2) — OpenTelemetry auto-instrumentations
 *                                          MUST be registered before any
 *                                          application import. This file is
 *                                          loaded AFTER `register-tracing.ts`
 *                                          (the `setupFiles` shim) so OTel
 *                                          is already initialized when this
 *                                          file runs — no OTel imports here.
 *   - Rule R8 (AAP §0.8.1) — Gates fail closed; any infrastructure or tooling
 *                            error MUST produce a failed verdict. The
 *                            `afterEach` unhandled-rejection guard below is
 *                            the per-test enforcement of this rule.
 *
 * ============================================================================
 * Hook Type and Runtime Ordering
 * ============================================================================
 *   This file is registered as `setupFilesAfterEnv` in
 *   `backend/jest.config.integration.ts`. The full ordering Jest performs
 *   for the integration suite is:
 *
 *     1. `setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts']`
 *        — runs BEFORE the Jest framework loads. Imports
 *        `backend/src/tracing.ts` to bootstrap OpenTelemetry
 *        auto-instrumentation (Rule R6 / C4).
 *     2. `globalSetup: '<rootDir>/tests/integration/setup/global-setup.ts'`
 *        — runs ONCE before any test file. Applies migrations, creates the
 *        test GCS bucket, validates env vars (Rule R4).
 *     3. `setupFilesAfterEnv: ['<rootDir>/tests/integration/setup/per-suite.ts']`
 *        — THIS FILE. Runs ONCE per test file, AFTER Jest's framework
 *        (`expect`, `jest`, lifecycle hooks) is available.
 *     4. `globalTeardown: '<rootDir>/tests/integration/setup/global-teardown.ts'`
 *        — runs ONCE after ALL test files. Cleans up emulator state.
 *
 *   The `setupFilesAfterEnv` phase is the only one where:
 *     - `jest.setTimeout()` works.
 *     - `expect.extend()` works (Jest's `expect` exists at this stage).
 *     - `beforeAll`, `beforeEach`, `afterEach`, `afterAll` are globally
 *       available.
 *     - Module imports of `backend/src/**` are SAFE (the OTel SDK has
 *       already been initialized in the prior `setupFiles` phase, BEFORE
 *       any test module's `require()` chain begins).
 *
 * ============================================================================
 * Responsibilities of This File
 * ============================================================================
 *   - Set the per-test timeout (defensive; matches `testTimeout: 30000`).
 *   - Register custom matchers used by integration tests:
 *       * `toBeUuid()` / `toMatchCorrelationId()` — ST-047 correlation IDs.
 *       * `toMatchTraceId()` — ST-049 W3C trace IDs (32-hex).
 *       * `toMatchSpanId()` — ST-049 W3C span IDs (16-hex).
 *   - Surface unhandled promise rejections per test (Rule R8 fail-closed).
 *
 * ============================================================================
 * What This File Deliberately Does NOT Do
 * ============================================================================
 *   - It does NOT open database connections. Repository tests open their
 *     own pools and tear them down.
 *   - It does NOT create Express app instances. Each route test mounts
 *     its own minimal app via supertest as needed (see
 *     `tests/integration/fixtures/app.ts`).
 *   - It does NOT run database migrations. That happens in
 *     `global-setup.ts` ONCE for the entire run.
 *   - It does NOT call OpenTelemetry init. That happens in
 *     `register-tracing.ts` BEFORE any test module loads (Rule R6 / C4).
 *   - It does NOT export anything other than the `{}` module sentinel.
 *     Tests should NOT import from this file directly. The file's purpose
 *     is side effects (matcher registration, hook installation) only.
 *
 * ============================================================================
 * Failure Categorization (ST-044-AC3)
 * ============================================================================
 *   ST-044-AC3 requires that the integration suite distinguish assertion
 *   failures from environment / fixture-setup failures in the report.
 *   This file contributes to that distinction as follows:
 *
 *     - Custom matchers (`toBeUuid`, `toMatchTraceId`, `toMatchSpanId`,
 *       `toMatchCorrelationId`) produce ASSERTION-style failures with a
 *       clear matcher name. JUnit reports render these as `<failure>`
 *       elements distinct from environment errors.
 *     - The `afterEach` unhandled-rejection guard throws an error tagged
 *       "Unhandled promise rejection(s) during test" — a clearly
 *       identifiable category that operators can grep for in CI logs to
 *       triage environmental defects from genuine assertion failures.
 *
 *   Combined with `global-setup.ts`'s top-level throw behaviour (which
 *   produces a JUnit `<error>` element at the suite level), the three
 *   failure categories are unambiguously distinguishable in the report.
 */

// Set the per-test timeout. Matches `testTimeout: 30000` in
// `backend/jest.config.integration.ts`. Setting it explicitly here is
// defensive — if a future engineer changes the config, this file's value
// remains as documented intent and prevents per-test timeouts from
// silently dropping back to Jest's 5-second default.
jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Custom Matchers
// ---------------------------------------------------------------------------

/**
 * Validates UUID format (8-4-4-4-12 hex with a recognised version + variant).
 *
 * Used to assert ST-047 correlation IDs and database row UUIDs (e.g. the
 * server-assigned design `id` returned by the create-design endpoint).
 *
 * Regex breakdown:
 *   ^[0-9a-f]{8}-           -> 8 hex digits and a hyphen (time-low)
 *   [0-9a-f]{4}-            -> 4 hex digits (time-mid)
 *   [1-5][0-9a-f]{3}-       -> version nibble [1-5] + 3 hex (we accept any
 *                              UUID version, not just v4, because Postgres
 *                              `gen_random_uuid()` produces v4 specifically
 *                              but other generators (e.g. v7 from external
 *                              libraries) might also appear in fixtures)
 *   [89ab][0-9a-f]{3}-      -> variant nibble [89ab] + 3 hex
 *   [0-9a-f]{12}$           -> 12 hex digits (node)
 *
 * Returns the standard `{ pass, message }` shape Jest expects from custom
 * matchers (per `@types/jest` `CustomMatcherResult`).
 */
function toBeUuid(received: unknown): jest.CustomMatcherResult {
  const pass =
    typeof received === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(received);
  return {
    pass,
    message: (): string => `expected ${JSON.stringify(received)} ${pass ? 'not ' : ''}to be a UUID`,
  };
}

/**
 * Validates a W3C trace ID — 32 hex characters, not all zeros.
 *
 * Per the W3C trace-context specification an all-zeros trace ID is
 * invalid. This matcher rejects it explicitly, catching the common bug
 * where a missing or malformed `traceparent` header is silently substituted
 * with all-zero IDs (which would otherwise pass a naive `^[0-9a-f]{32}$`
 * check and mask broken trace propagation).
 *
 * Used to assert ST-049 distributed-tracing correctness — specifically
 * the trace identifier carried in OpenTelemetry spans and structured log
 * records.
 */
function toMatchTraceId(received: unknown): jest.CustomMatcherResult {
  const pass =
    typeof received === 'string' && /^[0-9a-f]{32}$/i.test(received) && !/^0+$/.test(received);
  return {
    pass,
    message: (): string =>
      `expected ${JSON.stringify(received)} ${pass ? 'not ' : ''}to match a 32-hex non-zero trace identifier`,
  };
}

/**
 * Validates a W3C span ID — 16 hex characters, not all zeros.
 *
 * Per the W3C trace-context specification an all-zeros span ID is invalid.
 * Same rationale as `toMatchTraceId`: the all-zeros check catches the
 * silent-substitution bug where a missing parent span ID is replaced with
 * zeros.
 *
 * Used to assert ST-049 distributed-tracing correctness.
 */
function toMatchSpanId(received: unknown): jest.CustomMatcherResult {
  const pass =
    typeof received === 'string' && /^[0-9a-f]{16}$/i.test(received) && !/^0+$/.test(received);
  return {
    pass,
    message: (): string =>
      `expected ${JSON.stringify(received)} ${pass ? 'not ' : ''}to match a 16-hex non-zero span identifier`,
  };
}

/**
 * Domain-specific alias for `toBeUuid` — reads better at the call site:
 *
 *   `expect(headers['x-correlation-id']).toMatchCorrelationId()`
 *
 * vs. the equivalent but less readable:
 *
 *   `expect(headers['x-correlation-id']).toBeUuid()`
 *
 * Tests assert correlation IDs frequently (every authenticated request,
 * every cross-service call), so the matcher's domain-specific name aids
 * readability and lets failure messages self-document what the assertion
 * was checking.
 */
function toMatchCorrelationId(received: unknown): jest.CustomMatcherResult {
  return toBeUuid(received);
}

expect.extend({
  toBeUuid,
  toMatchTraceId,
  toMatchSpanId,
  toMatchCorrelationId,
});

// ---------------------------------------------------------------------------
// Module Augmentation — TypeScript Declaration Merging
// ---------------------------------------------------------------------------

declare global {
  // The `jest` namespace is the canonical merge target for custom matcher
  // declarations under `@types/jest`. ESLint's no-namespace rule normally
  // forbids `namespace` declarations, but TypeScript's declaration-merging
  // mechanism for `interface Matchers<R>` REQUIRES this namespace form —
  // there is no module-style alternative for ambient declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      /**
       * Asserts the value is a UUID (any version 1-5).
       *
       * @returns The assertion chain (Jest convention).
       *
       * @example
       *   expect(designRow.id).toBeUuid();
       *
       * Implementation: `toBeUuid` in
       * `backend/tests/integration/setup/per-suite.ts`.
       */
      toBeUuid(): R;

      /**
       * Asserts the value is a 32-hex non-zero W3C trace identifier.
       *
       * Rejects the all-zeros trace ID per the W3C trace-context spec.
       *
       * @returns The assertion chain (Jest convention).
       *
       * @example
       *   expect(spanContext.traceId).toMatchTraceId();
       *
       * Implementation: `toMatchTraceId` in
       * `backend/tests/integration/setup/per-suite.ts`.
       */
      toMatchTraceId(): R;

      /**
       * Asserts the value is a 16-hex non-zero W3C span identifier.
       *
       * Rejects the all-zeros span ID per the W3C trace-context spec.
       *
       * @returns The assertion chain (Jest convention).
       *
       * @example
       *   expect(spanContext.spanId).toMatchSpanId();
       *
       * Implementation: `toMatchSpanId` in
       * `backend/tests/integration/setup/per-suite.ts`.
       */
      toMatchSpanId(): R;

      /**
       * Asserts the value is a UUID — domain-specific alias for `toBeUuid`
       * that reads better when asserting `x-correlation-id` headers and
       * structured-log `correlationId` fields.
       *
       * @returns The assertion chain (Jest convention).
       *
       * @example
       *   expect(response.headers['x-correlation-id']).toMatchCorrelationId();
       *
       * Implementation: `toMatchCorrelationId` in
       * `backend/tests/integration/setup/per-suite.ts`.
       */
      toMatchCorrelationId(): R;
    }
  }
}

// ---------------------------------------------------------------------------
// Unhandled Promise Rejection Surfacing (Rule R8 fail-closed)
// ---------------------------------------------------------------------------
//
// Without this guard, a missed `await` in test A could surface as an
// unhandled rejection during test B's run — producing a confusing "the
// wrong test failed" report. Under `maxWorkers: 1` (the default for the
// integration suite, where parallel DB writes would corrupt fixtures), a
// rejection from one test even attributes to a NEXT test run by the same
// worker, masking the real source of the defect.
//
// The pattern below:
//   - `beforeAll`: registers a process-level listener that captures every
//     unhandled rejection during the suite's lifetime.
//   - `afterEach`: drains the captured-rejection queue and throws if any
//     are present, failing the test that produced them with a clear
//     error message.
//   - `afterAll`: removes the listener so Jest can shut the worker down
//     cleanly without dangling listeners (which would otherwise leak
//     between worker reuse cycles when Jest pools workers).
//
// The thrown error is tagged "Unhandled promise rejection(s) during test"
// — operators can grep CI logs for that exact string to triage
// environment-class failures from genuine assertion failures
// (ST-044-AC3 categorization requirement).

const unhandledRejections: unknown[] = [];

const captureRejection = (reason: unknown): void => {
  unhandledRejections.push(reason);
};

beforeAll(() => {
  process.on('unhandledRejection', captureRejection);
});

afterAll(() => {
  process.off('unhandledRejection', captureRejection);
});

afterEach(() => {
  if (unhandledRejections.length > 0) {
    // `splice` empties the array atomically so subsequent `afterEach`
    // invocations do not re-throw the same rejections.
    const collected = unhandledRejections.splice(0, unhandledRejections.length);
    // Throwing in `afterEach` fails the test that just ran (or, if no
    // test ran in this `afterEach` window, the suite). This is exactly
    // the Rule R8 fail-closed posture: silent rejections cannot mask
    // defects.
    throw new Error(
      `Unhandled promise rejection(s) during test (${collected.length}): ${collected
        .map((reason) =>
          reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
        )
        .join('; ')}`,
    );
  }
});

// Mark this file as a module so `declare global` works as expected.
// Without this, TypeScript treats the file as a script (no top-level
// imports/exports) and ambient `declare global` declarations behave
// differently — the `jest.Matchers` augmentation would silently fail to
// merge with `@types/jest`'s declarations and `expect(x).toBeUuid()` would
// produce a TypeScript "Property 'toBeUuid' does not exist" error at
// every call site. The `export {}` line is a sentinel that costs nothing
// at runtime (it compiles to an empty `module.exports` assignment under
// CommonJS) and is the canonical TypeScript pattern for declaring "this
// file is a module without exposing any public API".
export {};
