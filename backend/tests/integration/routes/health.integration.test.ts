/**
 * `health.integration.test.ts` — Integration test for the liveness
 * (`GET /healthz`) and readiness (`GET /readyz`) probes per Story ST-048
 * and AAP §0.6.5.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations)
 * ============================================================================
 *   - Story ST-048 (`tickets/stories/ST-048-metrics-endpoint-health-readiness-probes.md`):
 *       AC3 — "Each service exposes a liveness probe endpoint that returns a
 *             success status whenever the service process is running and able
 *             to serve traffic, and a failure status only when the process is
 *             in an unrecoverable state. The liveness probe MUST NOT depend
 *             on external dependencies — a database outage alone does not
 *             fail liveness."
 *       AC4 — "Each service exposes a readiness probe endpoint that returns
 *             a success status only when the service has fully initialized,
 *             its required dependencies are reachable, and it is ready to
 *             accept incoming traffic; otherwise the probe returns a failure
 *             status. The readiness probe MUST exercise the database
 *             connection and report failure when the database is unreachable."
 *       AC5 — "Both probe endpoints can be reached and interpreted in the
 *             local development environment without any cloud access" — this
 *             integration test IS that local exercise driven from
 *             `npm run test:integration`.
 *
 *   - AAP §0.6.5 Track 1 / Gate T1-D verification (VERBATIM):
 *       "`docker compose stop postgres && sleep 3; curl -s -o /dev/null -w
 *         "%{http_code}" http://localhost:3000/readyz`"
 *       (expected: `503`). Replicated in this file by the
 *       `GET /readyz` describe block's "returns 503 when DB query rejects"
 *       test, which uses `jest.spyOn(pool, 'query').mockRejectedValueOnce(...)`
 *       to simulate the same DB-unreachable condition without physically
 *       stopping the postgres container — the route's `Promise.race` against
 *       `pool.query('SELECT 1')` resolves the same way regardless of whether
 *       the rejection comes from a stopped container or a spy.
 *
 *   - AAP §0.5.6 Middleware Order (NON-NEGOTIABLE):
 *       "`express.json` → `correlationMiddleware` → `pino-http` →
 *        `metricsMiddleware` → routes → error handler"
 *       Reproduced verbatim in `createIntegrationApp()` below.
 *
 *   - AAP §0.3.3 New Files to Create — Backend:
 *       "`backend/src/routes/health.ts` — `/healthz` (liveness) and `/readyz`
 *        (readiness; 503 when DB unreachable) (ST-048)".
 *
 *   - `docs/observability/README.md` (Probe contract):
 *       "Liveness probe returns success when the process is running, failure
 *        only when the process has reached an unrecoverable state. A database
 *        outage alone MUST NOT fail liveness. Readiness probe returns success
 *        only when the service is fully initialized and its required
 *        dependencies are reachable. Both probes are unauthenticated."
 *
 *   - Constraint C5 (AAP §0.2.2 — VERBATIM):
 *       "A middleware at the request boundary MUST generate a UUID v4 as the
 *        correlation ID when the inbound `x-correlation-id` header is absent,
 *        and preserve it verbatim when present." — Verified by the
 *        `x-correlation-id` response-header tests in BOTH describe blocks
 *        (round-trip preservation, UUID-shape generation, presence on 503).
 *
 *   - Rule R2 (AAP §0.8.1 — VERBATIM):
 *       "Log records MUST NOT contain passwords, bearer tokens, session
 *        tokens, or API keys. MUST enforce via pino serializer allow-list,
 *        not per-call discipline."
 *       Extended by analogy to PROBE RESPONSE BODIES: the 503 failure body
 *       MUST NOT leak DB connection details (host, port, credential
 *       fragments, error stack traces). Verified by the "does NOT leak DB
 *       connection details" test in the `GET /readyz` describe.
 *
 *   - Story ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC1 — triggered on every PR open and push.
 *       AC2 — deterministic fixtures; emits an integration report artifact.
 *       AC3 — distinguishes assertion failures from environment / fixture-
 *             setup failures (per-suite.ts `afterEach` rejection guard tags
 *             environmental failures distinctly).
 *       AC4 — runs against locally-started dependencies (PostgreSQL via
 *             docker-compose); this file's happy paths exercise the REAL
 *             pool against the real container.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks)
 * ============================================================================
 *   - `backend/src/routes/health.ts`:
 *       * `createHealthRoutes`        — factory returning a Router that
 *                                       mounts `GET /healthz` (liveness) and
 *                                       `GET /readyz` (readiness). The
 *                                       readiness handler races
 *                                       `pool.query('SELECT 1')` against a
 *                                       3-second timeout via `Promise.race`
 *                                       and emits exactly
 *                                       `{ status: 'ready' }` (200) or
 *                                       `{ status: 'not_ready' }` (503).
 *   - `backend/src/db/pool.ts`:
 *       * `initializePool`            — singleton `pg.Pool` factory used by
 *                                       `createIntegrationApp()` to satisfy
 *                                       `createHealthRoutes`'s `{ pool }`
 *                                       dependency. The REAL pool is used
 *                                       for happy-path readiness assertions
 *                                       so the test exercises the same
 *                                       SELECT-1 round-trip as production.
 *       * `getPool`                   — used at test scope to obtain the
 *                                       same singleton reference for
 *                                       `jest.spyOn(pool, 'query')`
 *                                       instrumentation that simulates DB
 *                                       failure / timeout / leak conditions
 *                                       without disturbing the underlying
 *                                       connection.
 *   - `backend/src/middleware/correlation.ts`:
 *       * `correlationMiddleware`     — production C5 middleware. Mounted in
 *                                       the EXACT order AAP §0.5.6 mandates
 *                                       so the `x-correlation-id` response-
 *                                       header tests assert against the real
 *                                       chain (NOT a mocked surface).
 *   - `backend/src/logging/pino.ts`:
 *       * `logger`                    — production pino logger with the
 *                                       Rule R2 redaction allow-list. Wired
 *                                       into `pinoHttp({ logger, ... })` so
 *                                       any log records emitted during probe
 *                                       handling apply the same allow-list
 *                                       serialization as production —
 *                                       supporting the Rule R2 leak-
 *                                       prevention test which relies on the
 *                                       end-to-end logging substrate.
 *   - `backend/src/routes/metrics.ts`:
 *       * `metricsMiddleware`         — production metrics-recording
 *                                       middleware. Mounted purely for
 *                                       chain-fidelity per AAP §0.5.6 —
 *                                       this file does NOT assert on metric
 *                                       values directly (those assertions
 *                                       live in `metrics.integration.test.ts`),
 *                                       but its presence in the chain is
 *                                       mandatory so the probe responses
 *                                       traverse the same composed surface
 *                                       as production.
 *
 * ============================================================================
 * Why a Focused Test App
 * ============================================================================
 *   The schema's Phase 1 (and the canonical pattern in
 *   `metrics.integration.test.ts`) mandate a focused Express app rather than
 *   `backend/src/index.ts`. Importing the production composition root would
 *   also boot session middleware, the auth/design/share/order routes, the
 *   Firebase Admin SDK, and bind a TCP socket — none of which are needed to
 *   exercise the `/healthz` and `/readyz` contract, all of which add startup
 *   latency, and most of which already have dedicated tests. The focused app
 *   reproduces the EXACT middleware chain ordering mandated by AAP §0.5.6
 *   (`express.json` → `correlationMiddleware` → `pino-http` →
 *   `metricsMiddleware` → routes → error handler) and mounts only the routes
 *   the SUT exposes (`/healthz` and `/readyz`).
 *
 * ============================================================================
 * Why `jest.spyOn(pool, 'query')` Rather than Stopping postgres
 * ============================================================================
 *   The Gate T1-D User Example uses `docker compose stop postgres` to drive
 *   the readiness probe to 503. That approach has two problems for an
 *   integration test:
 *     1. It STOPS the container that subsequent tests in the same worker
 *        rely on, breaking the deterministic-fixture contract (ST-044-AC2).
 *     2. It relies on a Docker daemon being reachable from the test process,
 *        which is true in CI / dev but increases the surface for environment-
 *        induced flakiness (ST-044-AC3 — distinguish assertion failures from
 *        environment failures).
 *   Spying on the singleton's `query` method to reject (or hang) is a
 *   semantically-equivalent simulation: the route's
 *   `Promise.race([pool.query('SELECT 1'), timeout])` resolves to false the
 *   same way regardless of whether the rejection comes from a stopped
 *   container or a `mockRejectedValueOnce`. The test asserts the same 503 +
 *   `{ status: 'not_ready' }` body shape that the User Example would observe
 *   against the live container. `mockRejectedValueOnce` (rather than
 *   `mockRejectedValue`) reverts to the real implementation after one call
 *   so subsequent tests are not affected even if `afterEach` cleanup fails.
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance
 * ============================================================================
 *   - Rule R1 (story ACs authoritative): every `it()` cites the ST-048 AC
 *     or AAP § / Constraint it verifies.
 *   - Rule R2 (no credentials in logs / response bodies): the
 *     "does NOT leak DB connection details" test sweeps the 503 response
 *     body AND headers for forbidden patterns (`ECONNREFUSED`, `127.0.0.1`,
 *     `5432`). The 503 contract verified by the route is exactly
 *     `{ status: 'not_ready' }` — no `error.message`, no stack trace, no
 *     `errorMessage` property.
 *   - Rule R3 (Firebase Admin only): no JWT-library imports; the test does
 *     not exercise authenticated flows because `/healthz` and `/readyz` are
 *     unauthenticated per AAP §0.6.5 endpoint authentication map.
 *   - Rule R4 (no env defaults): this file performs zero `process.env`
 *     reads. Required env vars are validated by `env-fail-fast.integration
 *     .test.ts` (and by `jest.config.integration.ts` at config load).
 *   - Rule R6 / C4 (OTel registration order): registration is owned by
 *     `register-tracing.ts` via Jest's `setupFiles`; this file does not
 *     re-import the SDK module. By the time this file's modules are
 *     required, OTel auto-instrumentation has already monkey-patched
 *     `pg`, `http`, and `express`.
 *   - Rule R8 (gates fail closed): every assertion uses `expect`; no
 *     try/catch swallows test failures; the integration app is wired
 *     against the REAL `pg.Pool` so misconfiguration produces an
 *     observable failure rather than a silent skip. The `afterEach` spy
 *     restoration is guaranteed to run regardless of test outcome,
 *     preventing spy leakage between tests.
 *   - Rule R9 (no payment): N/A — no payment terms in this file.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   npx eslint backend/tests/integration/routes/health.integration.test.ts
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/health.integration.test.ts \
 *      --forceExit
 */

// ── third-party ─────────────────────────────────────────────────────────
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';

// ── app under test (real modules — no mocks) ────────────────────────────
import { getPool, initializePool } from '../../../src/db/pool';
import { logger } from '../../../src/logging/pino';
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { createHealthRoutes } from '../../../src/routes/health';
import { metricsMiddleware } from '../../../src/routes/metrics';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * Strict UUID v4 regex per RFC 4122 §4.4.
 *
 * Used as a stricter alternative to the suite-wide `toBeUuid()` matcher
 * (which accepts any UUID v1–5 shape). The C5 contract specifies UUID v4
 * specifically (`backend/src/middleware/correlation.ts` uses `crypto.randomUUID()`
 * which returns v4), so a v4-only regex catches a regression that switched
 * to a different UUID version.
 *
 * Both this regex and the suite-wide `toMatchCorrelationId()` matcher are
 * applied at different points in this file:
 *   - `toMatchCorrelationId()` — the loose, conventional shape check used
 *      where preserving compatibility with the broader suite is preferred.
 *   - This regex — used as a defensive secondary check to prove UUID v4
 *      generation specifically (per Constraint C5 verbatim).
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Canonical inbound UUID v4 used by the round-trip test in the
 * `GET /healthz` describe.
 *
 * The value is a deliberately-shaped, stable UUID v4 so that production
 * middleware (which preserves UUIDs verbatim per Constraint C5) accepts
 * it and emits it on the response header unchanged. If the response
 * header value differs from this constant, the C5 "preserve verbatim"
 * semantics have been violated.
 */
const INBOUND_FIXED_UUID = '11111111-2222-4333-8444-555555555555';

/**
 * The route's verified DB-query timeout (per `backend/src/routes/health.ts`
 * `READYZ_DB_TIMEOUT_MS = 3_000`).
 *
 * Used by the timeout-behavior test in the `GET /readyz` describe to
 * bracket the elapsed time of a hung query: the test asserts that the
 * response arrives within ~3 seconds (lower bound `READYZ_TIMEOUT_LOWER_MS`
 * proves the route waited for the timeout rather than failing immediately;
 * upper bound `READYZ_TIMEOUT_UPPER_MS` proves the timeout actually fired
 * rather than letting the test hang up to Jest's overall timeout).
 */
const READYZ_TIMEOUT_LOWER_MS = 2_500;
const READYZ_TIMEOUT_UPPER_MS = 5_000;

/**
 * Per-test Jest timeout for the timeout-behavior test in the `GET /readyz`
 * describe. The route's 3-second internal timeout plus async overhead can
 * push the test toward the suite-wide 30-second cap (`per-suite.ts`
 * `jest.setTimeout(30_000)`), but giving this specific test a tighter
 * 10-second budget means a regression that prevented the timeout from
 * firing would surface as a failed test (timeout) rather than a 30-second
 * hang.
 */
const READYZ_TIMEOUT_TEST_BUDGET_MS = 10_000;

// ════════════════════════════════════════════════════════════════════════
// Test Express App Builder
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a focused Express app that mirrors the production middleware order
 * (AAP §0.5.6) for the ST-048-AC3 / AC4 slice this file exercises:
 *
 *   1. `express.json({ limit: '1mb' })`  — body parsing (no-op for our
 *                                          GETs, but mirrors production
 *                                          for chain fidelity).
 *   2. `correlationMiddleware`            — production C5 middleware.
 *                                          Required so probe responses
 *                                          carry the `x-correlation-id`
 *                                          header asserted by the
 *                                          C5 propagation tests in BOTH
 *                                          describe blocks.
 *   3. `pinoHttp({ logger, ... })`        — production pino logger with
 *                                          the same `customLogLevel` and
 *                                          `redact` configuration the
 *                                          composition root applies in
 *                                          `backend/src/index.ts`.
 *                                          Required so the Rule R2 leak-
 *                                          prevention test verifies the
 *                                          REAL redaction substrate (and
 *                                          so `req.log` is populated when
 *                                          the readiness handler emits a
 *                                          structured-warning record on
 *                                          DB failure).
 *   4. `metricsMiddleware`                — chain-fidelity per AAP §0.5.6.
 *                                          This file does NOT assert on
 *                                          metric values; the metrics
 *                                          assertions are owned by
 *                                          `metrics.integration.test.ts`.
 *                                          Mounting the middleware here
 *                                          is purely so the probe traffic
 *                                          traverses the same composed
 *                                          surface as production.
 *   5. `createHealthRoutes({ pool })`     — the SUT. Mounted at app ROOT
 *                                          (NOT `/api`) because the
 *                                          factory's internal paths are
 *                                          `/healthz` and `/readyz` per
 *                                          the verified contract. The
 *                                          pool dependency is the REAL
 *                                          singleton (per the LocalGCP
 *                                          rule).
 *   6. Express error handler              — last; converts thrown errors
 *                                          into a JSON 5xx envelope. The
 *                                          readiness handler delegates to
 *                                          `handleReadinessProbe(...).catch(next)`
 *                                          so an unexpected throw bubbles
 *                                          to this handler rather than
 *                                          surfacing as an unhandled
 *                                          rejection (which the per-suite
 *                                          guard would tag as an
 *                                          environmental failure).
 *
 * Authentication is intentionally NOT mounted — `/healthz` and `/readyz`
 * are unauthenticated per AAP §0.6.5 endpoint authentication map. Adding
 * session validation here would force the test to construct a Firebase
 * ID token, defeating the LocalGCP rule and adding flakiness.
 *
 * @returns A fully-wired Express app suitable for supertest invocation.
 */
async function createIntegrationApp(): Promise<Express> {
  // The pool is a module-level singleton; calling `initializePool()`
  // either returns the existing pool or creates one from `DATABASE_URL`.
  // It satisfies `createHealthRoutes`'s `{ pool }` dependency without
  // requiring this test to know the DB connection details.
  const pool = initializePool();

  const app = express();

  // ── 1. Body parsing ─────────────────────────────────────────────────
  // Mirror production: 1 MB JSON limit (per AAP §0.6.4 design endpoints
  // and the standard composition-root limit).
  app.use(express.json({ limit: '1mb' }));

  // ── 2. Correlation middleware (C5) ──────────────────────────────────
  // DIRECT middleware (NOT a factory). Generates UUID v4 when
  // `x-correlation-id` is absent, preserves it verbatim when present,
  // opens the AsyncLocalStorage frame, and attaches the value to the
  // response via `res.setHeader('x-correlation-id', ...)`.
  app.use(correlationMiddleware);

  // ── 3. Pino HTTP middleware ─────────────────────────────────────────
  // The `customLogLevel` and `redact` options are the same configuration
  // applied in `backend/src/index.ts`. We pass them inline rather than
  // re-exporting them from `logging/pino.ts` because the production
  // composition root configures pino-http separately from the logger
  // itself; mirroring that arrangement keeps this integration app
  // byte-faithful to the deployed shape.
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
    }),
  );

  // ── 4. Metrics middleware (chain fidelity only) ─────────────────────
  // Records counter + histogram on every response (skipping `/metrics`
  // itself per the verified contract). Present here purely so this app
  // mirrors the production chain ordering exactly; assertions on the
  // recorded values are owned by `metrics.integration.test.ts`.
  app.use(metricsMiddleware);

  // ── 5. Routes — health (the SUT) ────────────────────────────────────
  // `createHealthRoutes` mounts `/healthz` and `/readyz` at the ROUTER
  // root. The factory is invoked here at app ROOT (NOT under `/api`)
  // matching the production composition in `backend/src/index.ts`.
  app.use(createHealthRoutes({ pool }));

  // ── 6. Error handler ────────────────────────────────────────────────
  // Last in the chain. Converts thrown errors into a JSON 5xx envelope.
  // The 4-arg signature is required for Express to recognise the handler
  // as an error handler (the framework dispatches by arity).
  app.use(
    (
      err: Error & { status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ): void => {
      const status = err.status ?? err.statusCode ?? 500;
      res.status(status).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: status >= 500 ? 'Internal server error' : err.message,
        },
      });
    },
  );

  return app;
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════

describe('Health and Readiness routes (integration)', () => {
  /**
   * The Express app instance shared across all tests. Built once in
   * `beforeAll` because Express apps are stateless from supertest's
   * perspective; subsequent requests share the same handler graph.
   */
  let app: Express;

  /**
   * Per-test handle to a `jest.spyOn(pool, 'query')` instance. Tests that
   * need to drive the readiness probe to a failure path assign this
   * handle in their setup; the suite-wide `afterEach` restores it to the
   * real implementation regardless of test outcome.
   *
   * The `let querySpy` pattern (rather than per-test `const`) makes the
   * teardown guarantee uniform: even if a test throws unexpectedly
   * BEFORE its inline cleanup runs, the `afterEach` still finds the spy
   * via the module-scoped binding and restores it. Without this pattern,
   * a thrown assertion in a test that did not call `mockRestore` would
   * leak the spy into the next test, producing cascading failures that
   * mask the original defect (a Rule R8 fail-closed concern).
   *
   * The variable is `null` between tests so the `afterEach` skip-when-
   * absent branch is taken when a test did not install a spy.
   */
  let querySpy: jest.SpyInstance | null = null;

  /**
   * One-time setup: build the integration app. The pool is initialized
   * inside `createIntegrationApp()` via `initializePool()`. The pool is
   * a module-scoped singleton, so subsequent calls to `getPool()` from
   * test bodies return the same reference — which is what makes
   * `jest.spyOn(getPool(), 'query')` work as a consistent stub.
   */
  beforeAll(async () => {
    app = await createIntegrationApp();
  });

  /**
   * Per-test teardown: always restore the pool spy if one was installed.
   *
   * `jest.config.integration.ts` enables `restoreMocks: true` which
   * automatically restores all mocks created via `jest.spyOn` after each
   * test. We additionally null out the module-scoped `querySpy` handle
   * so a stale reference cannot be reused after restoration. The
   * defense-in-depth pattern (explicit restore + `restoreMocks`)
   * tolerates either layer being misconfigured without leaking a spy.
   */
  afterEach(() => {
    if (querySpy !== null) {
      querySpy.mockRestore();
      querySpy = null;
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // §1. GET /healthz (ST-048-AC3)
  // ──────────────────────────────────────────────────────────────────
  describe('GET /healthz (ST-048-AC3)', () => {
    /**
     * ST-048-AC3 (verbatim): "Each service exposes a liveness probe
     * endpoint that returns a success status whenever the service
     * process is running and able to serve traffic..."
     *
     * `routes/health.ts` returns `res.status(200).json({ status: 'ok' })`
     * unconditionally — the handler does NOT touch the pool at all,
     * which is the AC3 contract. The body shape is verified verbatim
     * (`{ status: 'ok' }`) so a regression that added an `error` field,
     * a `details` object, or any other structure would surface here.
     */
    it('returns 200 with { status: "ok" } when the process is running', async () => {
      const res = await request(app).get('/healthz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    /**
     * ST-048-AC3 (verbatim): "...The liveness probe MUST NOT depend on
     * external dependencies — a database outage alone does not fail
     * liveness."
     *
     * This is the negative complement of the previous test: even when
     * the database is COMPLETELY unreachable (every `pool.query` call
     * rejects), the liveness probe still returns 200. The route's
     * verified contract is that the `/healthz` handler does NOT call
     * `pool.query` at all — but installing a `mockRejectedValue` here
     * gives the strongest possible guarantee: the test would FAIL if
     * `/healthz` ever started touching the pool, even transitively.
     *
     * The spy uses `mockRejectedValue` (not `mockRejectedValueOnce`)
     * so EVERY `pool.query` call during this test rejects — including
     * any that might be added in a future regression. The cleanup is
     * handled by the suite-wide `afterEach`.
     */
    it('is independent of database state — succeeds even when pool.query rejects', async () => {
      const pool = getPool();
      // `pool.query` has 7 overloads, the first of which is
      // `query<T extends Submittable>(queryStream: T): T`. Jest's
      // `spyOn` resolves to that overload, which causes
      // `mockRejectedValue<T>` to require `RejectedValue<T> = never`
      // (because `T` does not extend `PromiseLike`). The widening cast
      // to `jest.SpyInstance` (default `<any, any, any>`) makes
      // `mockRejectedValue` accept `Error`. Test-file ESLint exempts
      // `@typescript-eslint/no-explicit-any`, so this is permitted.
      querySpy = (jest.spyOn(pool, 'query') as unknown as jest.SpyInstance).mockRejectedValue(
        new Error('DB unreachable (simulated for AC3 negation)'),
      );

      const res = await request(app).get('/healthz');

      // 200 OK + canonical body shape — UNCHANGED by DB outage.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });

      // Defensive: the spy must NOT have been called by `/healthz`. If
      // it was, AC3's "MUST NOT depend on external dependencies" was
      // violated — the response body might still be 200 by coincidence,
      // but the contract is broken.
      expect(querySpy).not.toHaveBeenCalled();
    });

    /**
     * Constraint C5 (AAP §0.2.2 — VERBATIM):
     *   "A middleware at the request boundary MUST generate a UUID v4 as
     *    the correlation ID when the inbound `x-correlation-id` header
     *    is absent, and preserve it verbatim when present."
     *
     * AND the implicit corollary: the correlation ID is exposed to the
     * client via the `x-correlation-id` response header so that
     * downstream debugging can correlate the response with backend logs.
     *
     * The `correlationMiddleware` is mounted in this app's chain (per
     * the production middleware order in AAP §0.5.6), so every
     * response — including `/healthz` — must carry the
     * `x-correlation-id` header on the wire.
     *
     * The `toMatchCorrelationId()` matcher is registered globally by
     * `tests/integration/setup/per-suite.ts` and asserts a UUID v1-5
     * shape. The middleware uses UUID v4 specifically; matching v4 is
     * verified by the next test's `UUID_V4_REGEX` assertion, which is
     * the stricter regex.
     */
    it('emits x-correlation-id response header (C5 propagation)', async () => {
      const res = await request(app).get('/healthz');

      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    /**
     * Constraint C5 (AAP §0.2.2 — VERBATIM):
     *   "...preserve it verbatim when present."
     *
     * "Verbatim" means the response header value MUST be byte-identical
     * to the inbound header value — no re-canonicalization, no version
     * swap, no formatting change. Real-world systems (Heroku Router,
     * AWS ALB) commonly mint request IDs in non-UUID forms and rely on
     * verbatim preservation across hops.
     *
     * The chosen `INBOUND_FIXED_UUID` is a deliberately-shaped UUID v4
     * so that even a hypothetical "validate inbound, regenerate if
     * malformed" regression would still preserve this value. The check
     * is `expect(...).toBe(INBOUND_FIXED_UUID)` (strict equality) — any
     * deviation fails the test.
     */
    it('preserves inbound x-correlation-id header (C5 round-trip)', async () => {
      const res = await request(app).get('/healthz').set('x-correlation-id', INBOUND_FIXED_UUID);

      expect(res.headers['x-correlation-id']).toBe(INBOUND_FIXED_UUID);
    });

    /**
     * Constraint C5 (AAP §0.2.2 — VERBATIM):
     *   "...MUST generate a UUID v4 as the correlation ID when the
     *    inbound `x-correlation-id` header is absent..."
     *
     * The strict UUID v4 form (literal `4` in the version nibble,
     * `[89ab]` in the variant nibble) is asserted via the local
     * `UUID_V4_REGEX` constant — a stricter check than the suite-wide
     * `toBeUuid()` matcher (which accepts v1–5). A regression that
     * switched the generator to a non-v4 UUID library would surface
     * here even though the suite-wide matcher would still pass.
     *
     * The suite-wide `toBeUuid()` is asserted as well so this test
     * doubles as a regression check for the matcher's registration —
     * if `per-suite.ts` ever stopped registering `toBeUuid`, this test
     * would fail with a "matcher not found" error rather than a misleading
     * assertion failure.
     */
    it('generates a fresh UUID v4 when x-correlation-id is absent', async () => {
      const res = await request(app).get('/healthz');

      const correlationId = res.headers['x-correlation-id'];
      // The suite-wide v1-5 matcher (auto-registered by per-suite.ts).
      expect(correlationId).toBeUuid();
      // The strict v4 regex (locally defined in this file).
      expect(correlationId).toMatch(UUID_V4_REGEX);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // §2. GET /readyz (ST-048-AC4)
  // ──────────────────────────────────────────────────────────────────
  describe('GET /readyz (ST-048-AC4)', () => {
    /**
     * ST-048-AC4 (verbatim): "Each service exposes a readiness probe
     * endpoint that returns a success status only when the service has
     * fully initialized, its required dependencies are reachable, and
     * it is ready to accept incoming traffic..."
     *
     * Happy path: the postgres container is up (per the integration-
     * test global setup), so `pool.query('SELECT 1')` resolves and the
     * route returns 200 with `{ status: 'ready' }`.
     *
     * The body shape is verified verbatim — `{ status: 'ready' }`. A
     * regression that added an `error` field, a `version` object, or
     * any other structure would fail the strict `toEqual`. We also
     * check `res.body.status` separately so a partial regression that
     * preserved the status but added extra keys would still fail (the
     * `toEqual` is strict equality of the entire object — both checks
     * are belt-and-suspenders).
     */
    it('returns 200 with { status: "ready" } when DB is reachable', async () => {
      const res = await request(app).get('/readyz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ready' });
      expect(res.body.status).toBe('ready');
    });

    /**
     * AAP §0.6.5 Track 1 / Gate T1-D verification (VERBATIM):
     *   `docker compose stop postgres && sleep 3; curl -s -o /dev/null
     *    -w "%{http_code}" http://localhost:3000/readyz`
     *   (expected: `503`)
     *
     * Replicated here via `jest.spyOn(pool, 'query').mockRejectedValueOnce(...)`.
     * The route's `Promise.race([pool.query('SELECT 1'), timeout])` resolves
     * to false the same way regardless of whether the rejection comes from
     * a stopped container or a spy — so the 503 + `{ status: 'not_ready' }`
     * outcome is byte-identical to the live-container User Example.
     *
     * `mockRejectedValueOnce` (rather than `mockRejectedValue`) reverts to
     * the real implementation after one call, so subsequent tests in this
     * describe are insulated even if `afterEach` cleanup is somehow
     * bypassed (defense-in-depth per the schema's spy-management note).
     *
     * The 503 body is verified verbatim as `{ status: 'not_ready' }` — no
     * `error.message`, no `errorMessage`, no `details`, no stack trace.
     * That contract is enforced by the route per Rule R2 and is verified
     * in stronger detail by the leak-prevention test below; here we just
     * check the canonical happy/sad output shape.
     */
    it('returns 503 with { status: "not_ready" } when DB query rejects (Gate T1-D User Example)', async () => {
      const pool = getPool();
      // See the AC3 negation test for the rationale behind this
      // `as unknown as jest.SpyInstance` cast: `pool.query`'s first
      // overload returns `T extends Submittable`, not a `PromiseLike`,
      // so `mockRejectedValueOnce` typing requires the widening cast.
      querySpy = (jest.spyOn(pool, 'query') as unknown as jest.SpyInstance).mockRejectedValueOnce(
        new Error('DB unavailable (simulated for Gate T1-D)'),
      );

      const res = await request(app).get('/readyz');

      // 503 — the User Example expected exit code.
      expect(res.status).toBe(503);
      // Canonical not_ready body (per the verified contract).
      expect(res.body).toEqual({ status: 'not_ready' });
      // Belt-and-suspenders: the `status` key value separately.
      expect(res.body.status).toBe('not_ready');
    });

    /**
     * Verified behavior from `routes/health.ts`:
     *   `const READYZ_DB_TIMEOUT_MS = 3_000;`
     *   The handler uses `Promise.race([readinessCheck, timeout])` where
     *   `timeout` is a `setTimeout(() => resolve(false), READYZ_DB_TIMEOUT_MS)`.
     *
     * If `pool.query('SELECT 1')` HANGS (never resolves, never rejects),
     * the timeout MUST fire after ~3 seconds and the route MUST return
     * 503. Without the timeout the readiness probe would hang
     * indefinitely, causing Cloud Run / Kubernetes to either:
     *   - Treat the probe as healthy (because no failure signal arrived
     *     within the platform's own probe-timeout) — silently masking
     *     the real outage.
     *   - Trip the platform's probe-timeout (typically 1-10 seconds),
     *     producing inconsistent behavior across environments.
     * Both outcomes violate the AAP §0.6.5 Gate T1-D contract.
     *
     * Approach: install a spy that returns a never-resolving promise,
     * then time the request from start to response. The elapsed time
     * must be:
     *   - LESS THAN `READYZ_TIMEOUT_UPPER_MS` (5000ms) — proves the
     *     timeout actually fired rather than letting the test approach
     *     the per-test budget (`READYZ_TIMEOUT_TEST_BUDGET_MS`, 10s).
     *   - GREATER THAN OR EQUAL TO `READYZ_TIMEOUT_LOWER_MS` (2500ms)
     *     — proves the route waited for the timeout rather than bailing
     *     out immediately. A regression that resolved the race to false
     *     synchronously (e.g. an off-by-one boolean flip) would surface
     *     as an elapsed time below this lower bound.
     *
     * The per-test Jest timeout is set to `READYZ_TIMEOUT_TEST_BUDGET_MS`
     * (10s) so even a regression that prevented the timeout from firing
     * surfaces as a Jest-level test timeout (10s) rather than a 30-second
     * suite-wide hang.
     */
    it(
      'returns 503 within ~3 seconds when DB query hangs (route 3s timeout)',
      async () => {
        const pool = getPool();
        // A promise that never resolves AND never rejects. The route's
        // `Promise.race` against the 3s timeout is the ONLY way the
        // request can complete; if the route's timeout was removed,
        // this test would hang for `READYZ_TIMEOUT_TEST_BUDGET_MS` and
        // fail via Jest's per-test timeout.
        //
        // The `as unknown as jest.SpyInstance` cast is the same widening
        // used by the rejection tests above — `pool.query`'s first
        // overload returns a non-PromiseLike `T extends Submittable`,
        // and Jest's spyOn picks that overload, so we widen to the
        // default `SpyInstance<any, any, any>` to accept arbitrary
        // mock return values.
        querySpy = (jest.spyOn(pool, 'query') as unknown as jest.SpyInstance).mockReturnValueOnce(
          // The never-resolving promise. Cast to `unknown` first to
          // detach from `Promise<never>` typing, then to the concrete
          // mock return shape.
          new Promise<never>(() => {
            /* never resolves — exercises the route's 3s timeout */
          }),
        );

        const start = Date.now();
        const res = await request(app).get('/readyz');
        const elapsed = Date.now() - start;

        // Status code MUST be 503 — the timeout resolved the race to
        // `false`, which the route maps to 503 + `{ status: 'not_ready' }`.
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'not_ready' });

        // Lower bound: the response did NOT arrive synchronously.
        // 2500ms is below the 3000ms route timeout to allow for clock
        // skew / scheduler jitter (the actual timeout fires close to
        // but not exactly at 3000ms in practice).
        expect(elapsed).toBeGreaterThanOrEqual(READYZ_TIMEOUT_LOWER_MS);

        // Upper bound: the response arrived BEFORE Jest's per-test
        // timeout. 5000ms gives the timeout 2 seconds of slack beyond
        // the 3000ms route timeout for async overhead (event loop
        // scheduling, supertest's response parsing). A larger elapsed
        // would imply the timeout did not fire.
        expect(elapsed).toBeLessThan(READYZ_TIMEOUT_UPPER_MS);
      },
      READYZ_TIMEOUT_TEST_BUDGET_MS,
    );

    /**
     * Rule R2 (AAP §0.8.1 — VERBATIM):
     *   "Log records MUST NOT contain passwords, bearer tokens, session
     *    tokens, or API keys. MUST enforce via pino serializer
     *    allow-list, not per-call discipline."
     *
     * Extended by analogy to PROBE RESPONSE BODIES: the 503 failure body
     * MUST NOT leak DB connection details (host, port, error stack
     * traces, credential fragments). A regression that included
     * `error.message` or a stack trace in the response body would
     * expose internal infrastructure details to anyone with network
     * access to the readiness probe — a violation of the Rule R2 spirit
     * even though the rule's letter speaks to log records.
     *
     * The route's verified contract emits exactly `{ status: 'not_ready' }`
     * for failures — no error metadata at all. This test's strongest
     * formulation injects an error message containing the canonical
     * DB-connection-details substring (`'connect ECONNREFUSED 127.0.0.1:5432'`)
     * and verifies that NONE of the substrings appear in the response
     * body OR headers.
     *
     * The header sweep is included because a future regression that
     * tried to "helpfully" surface the failure reason via a custom
     * `X-Failure-Reason` response header would bypass the body check.
     * Sweeping headers as well is defense-in-depth.
     *
     * The forbidden patterns are:
     *   - `ECONNREFUSED` — Node.js's canonical TCP connection-refused
     *     error code; would only appear if the route surfaced the raw
     *     error.
     *   - `127.0.0.1` — the local-loopback IP, which is the DB host in
     *     local / CI environments. Appearing in the response would imply
     *     a host-leak.
     *   - `5432` — PostgreSQL's default port; appearing in the response
     *     would imply a port-leak.
     */
    it('does NOT leak DB connection details in 503 response body (Rule R2)', async () => {
      const pool = getPool();
      // The `as unknown as jest.SpyInstance` cast widens the spy's
      // inferred return type so `mockRejectedValueOnce` accepts an
      // `Error` argument — see the AC3 negation test for the full
      // rationale on why `pool.query`'s overload set forces this cast.
      querySpy = (jest.spyOn(pool, 'query') as unknown as jest.SpyInstance).mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      );

      const res = await request(app).get('/readyz');

      // Status MUST be 503 — the rejection resolves the race to false.
      expect(res.status).toBe(503);

      // Combine body + headers into a single string for substring
      // sweeping. JSON.stringify on `res.headers` serialises the entire
      // header map (keys + values), so any leak via a custom header is
      // caught here too.
      const fullResponse = JSON.stringify(res.body) + JSON.stringify(res.headers);

      // The canonical DB-error substring MUST NOT appear anywhere in
      // the response surface. Each forbidden token is checked
      // independently so the failure message identifies WHICH token
      // leaked (rather than collapsing into a single regex that says
      // "something leaked").
      expect(fullResponse).not.toContain('ECONNREFUSED');
      expect(fullResponse).not.toContain('127.0.0.1');
      expect(fullResponse).not.toContain('5432');

      // The body MUST NOT contain error-shaped properties. The
      // verified route contract is `{ status: 'not_ready' }` only —
      // any of these properties existing implies a regression that
      // started leaking error metadata.
      expect(res.body).not.toHaveProperty('error');
      expect(res.body).not.toHaveProperty('errorMessage');
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body).not.toHaveProperty('details');
      expect(res.body).not.toHaveProperty('reason');

      // Strongest body assertion: the body is EXACTLY the canonical
      // not_ready shape. Any extra key (even one with a benign value)
      // would fail this strict-equality check.
      expect(res.body).toEqual({ status: 'not_ready' });
    });

    /**
     * Constraint C5 (AAP §0.2.2 — VERBATIM):
     *   "A middleware at the request boundary MUST generate a UUID v4
     *    as the correlation ID..."
     *
     * The C5 contract applies to ALL responses, including failure
     * responses. A 503 readiness response that LACKED the
     * `x-correlation-id` header would break operational debugging:
     * operators correlating a 503 incident with backend logs would
     * have no shared identifier to pivot on.
     *
     * The `correlationMiddleware` runs BEFORE the readiness handler in
     * the chain (per AAP §0.5.6), so the response header is set BEFORE
     * the handler can possibly fail. Verifying the header on a 503
     * response proves the middleware ordering is correct — a
     * regression that placed the route before the correlation
     * middleware would emit 503s without the header.
     */
    it('emits x-correlation-id even on 503 response', async () => {
      const pool = getPool();
      // The `as unknown as jest.SpyInstance` cast widens the spy's
      // inferred return type so `mockRejectedValueOnce` accepts an
      // `Error` argument — see the AC3 negation test for the rationale.
      querySpy = (jest.spyOn(pool, 'query') as unknown as jest.SpyInstance).mockRejectedValueOnce(
        new Error('DB unavailable for header-on-503 test'),
      );

      const res = await request(app).get('/readyz');

      // Confirm we exercised the failure path (not just the happy path).
      expect(res.status).toBe(503);
      // The correlation header MUST be present even on failure
      // responses (a UUID v1-5 shape per the suite-wide matcher).
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });
  });
});
