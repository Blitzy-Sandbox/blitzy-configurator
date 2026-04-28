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

import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';

// Imported lazily inside the suite-teardown `afterAll` to keep per-suite.ts
// itself decoupled from application-module startup work. The dynamic
// require keeps test-bootstrap and src boundaries clean: per-suite.ts
// touches `src/db/pool` only at teardown to dispose any lazily-initialised
// pg pool that lingered after the suite's last test.
//
// QA Issue #2 (MAJOR) — TCPWRAP open handle: `pg.Pool` opens a TCP socket
// to PostgreSQL on first query (`pool.connect()` is invoked lazily). That
// socket is a `TCPWRAP` from `async_hooks`'s perspective. With Jest's
// `--detectOpenHandles` enabled (per `jest.config.integration.ts`
// detectOpenHandles: true), and because the pool is a process-singleton
// that no test file explicitly disposes, the pg socket remains alive when
// Jest takes its post-suite snapshot. Jest's stack-trace heuristic then
// reports the supertest invocation site (e.g.,
// `health.integration.test.ts:657`) as the responsible code path, because
// that line is where the request that triggered the lazy pool
// initialisation entered the user-test layer — even though the actual
// open handle is the pg client socket inside the pool, not the
// supertest-managed listening server. The fix is to close the pool at
// suite teardown so the pg socket(s) are torn down before the open-handle
// snapshot fires.

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

// ---------------------------------------------------------------------------
// Suite teardown — TCPWRAP open-handle prevention (pg pool + http agents)
// ---------------------------------------------------------------------------
//
// QA Issue #2 (MAJOR): integration runs end with Jest's open-handle detector
// reporting a TCPWRAP at supertest's `Test.serverAddress` call site
// (specifically `tests/integration/routes/health.integration.test.ts:657`,
// which is the `await request(app).get('/readyz')` line in the readiness
// happy-path test).
//
// Diagnostic empirical finding (verified by isolating /healthz and /readyz
// test groups via `-t` filter):
//   - Running ONLY `/healthz` tests (which never call `pool.query`): NO
//     TCPWRAP open-handle warning.
//   - Running ONLY `/readyz` tests (which call `pool.query('SELECT 1')` to
//     verify DB reachability): TCPWRAP open-handle warning appears.
//
// This isolates the leaking handle to the **pg client socket**, NOT the
// supertest-managed ephemeral HTTP listening server. supertest closes the
// listening server inside its `Test.end()` callback via
// `server.close(localAssert)` and `await request(app).get(...)` resolves
// only after `localAssert` fires (which fires only on the server's
// `'close'` event). The listening TCPWRAP is therefore disposed before
// the test's `await` resolves, so it cannot be the leaking handle.
//
// The pg pool is a module-scoped process singleton (see
// `backend/src/db/pool.ts`): on the first `pool.query(...)` invocation,
// `pg` opens a TCP socket to PostgreSQL and holds it in the pool's
// idle-client list. Subsequent queries reuse that socket. The pool's
// underlying TCP socket is a `TCPWRAP` from `async_hooks`'s perspective.
// With Jest's `--detectOpenHandles` enabled (per
// `jest.config.integration.ts` `detectOpenHandles: true`) — which is
// intentional for ST-044-AC2 deterministic-fixture verification — and
// because no test file explicitly disposes the pool, the pg socket
// remains alive when Jest takes its post-suite snapshot at the end of
// each test file. Jest's stack-trace heuristic then reports the FIRST
// supertest call that transitively caused the TCPWRAP creation
// (`request(app).get('/readyz')` on `health.integration.test.ts:657`)
// as the responsible code path — the trace is misleading: the actual
// open handle is the pg client socket inside the pool, but the test
// function on the call stack at TCPWRAP creation time happens to be
// the supertest invocation that triggered the route which queried pg.
//
// Fix: dispose the pg pool at suite teardown. `closePool()` clears the
// module-scoped `pool` reference FIRST, then awaits `pool.end()` which
// drains active queries and closes every underlying socket before
// resolving. Subsequent test files in the same Jest worker re-load
// `src/db/pool` in their own VM context (Jest's module isolation
// guarantees one fresh module graph per test file), so closing the
// pool here does not affect later suites.
//
// We additionally drain the http/https global agents to defend against
// any incidental keep-alive client sockets created by code paths we
// haven't audited (e.g., outbound HTTP calls from middleware to the
// Firebase emulator that bypass supertest's request lifecycle). These
// destroy() calls are no-ops when no sockets are pooled, so they are
// always safe.
//
// `await new Promise(resolve => setImmediate(resolve))` yields one
// event-loop tick so the destroyed sockets' `'close'` events flush
// cleanly before Jest's `afterAll` returns. Without this, Jest's
// open-handle detector may still observe FIN-ACK packets in flight
// when it takes its post-suite snapshot.
//
// This `afterAll` runs in EVERY integration suite (because `per-suite.ts`
// is the global `setupFilesAfterEnv`), so the cleanup is applied
// uniformly without each individual suite needing to remember it. The
// hook ordering (Jest documented LIFO afterAll execution) means
// per-suite.ts's afterAll runs AFTER any test-file-local afterAll, so
// suite-specific cleanup completes before pool disposal.
//
// Story coverage / decision-log entry:
//   - QA Issue #2 (MAJOR): TCPWRAP open handle from pg pool's lazy
//     socket — resolved by closing the pool at suite teardown.
//   - QA Issue #3 (MINOR): Indirect contribution — fewer alive handles
//     after suite reduces the surface for OTel exporter timer callbacks
//     to fire after Jest VM teardown.
//   - ST-044-AC2 (deterministic fixtures): no socket state can bleed
//     across suite boundaries when each suite closes its own pool.

afterAll(async () => {
  // Dispose the pg pool's TCP socket(s) BEFORE Jest's open-handle
  // snapshot fires. Lazy-require avoids forcing pool import on test
  // files that never use the database (e.g., pure logging unit tests
  // that import per-suite.ts via setupFilesAfterEnv).
  //
  // `closePool()` is safe to call when no pool exists — it returns
  // immediately if the module-scoped `pool` reference is null, which
  // is the case for any test file that did not invoke `getPool()` or
  // `pool.query()` directly or transitively.
  try {
    const poolModule = (await import('../../../src/db/pool')) as {
      closePool: () => Promise<void>;
    };
    await poolModule.closePool();
  } catch {
    // Best-effort cleanup: a load failure here would be unusual (the
    // module is part of the same compilation unit as the test code)
    // and should NOT mask test results. The TCPWRAP warning would
    // re-appear in the next CI run, surfacing the regression at that
    // point. We intentionally swallow because cleanup errors must not
    // convert a passing test run into a failing one (matching the
    // policy already documented in `global-teardown.ts`).
  }

  // Synchronously dispose every pooled keep-alive socket on the
  // default global HTTP agents. Both calls are no-ops when no
  // sockets are pooled, so they are safe to invoke even in suites
  // that never made an outbound HTTP request.
  nodeHttp.globalAgent.destroy();
  nodeHttps.globalAgent.destroy();

  // Yield one event-loop tick so the destroyed sockets' close events
  // flush before Jest's afterAll returns. Without this, Jest's open-
  // handle detector may still observe the FIN-ACK in flight when it
  // takes its post-suite snapshot.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
