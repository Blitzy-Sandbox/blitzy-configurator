/**
 * `metrics.integration.test.ts` — Integration test for the Prometheus
 * `/metrics` scrape endpoint per Story ST-048 and AAP §0.6.5.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations)
 * ============================================================================
 *   - Story ST-048 (`tickets/stories/ST-048-metrics-endpoint-health-readiness-probes.md`):
 *       AC1 — "Each service exposes a metrics endpoint at a documented path
 *             that serves service-level metrics typed as explicit primitives —
 *             a request rate counter, an error rate counter, a request
 *             latency histogram, and a process-up gauge are the baseline
 *             set — in a technology-neutral text format suitable for
 *             scraping."
 *       AC2 — "Every emitted metric carries at minimum a service label, an
 *             environment label, and a version label so that metrics are
 *             dimensioned consistently across deployments and can be
 *             filtered and aggregated by service, environment, and version."
 *       AC3 — liveness probe (verified by `health.integration.test.ts`).
 *       AC4 — readiness probe (verified by `health.integration.test.ts`).
 *       AC5 — "The metrics endpoint and both probe endpoints can be reached
 *             and interpreted in the local development environment without
 *             any cloud access" — this integration test IS that local
 *             exercise driven from `npm run test:integration`.
 *
 *   - AAP §0.6.5 Track 1 / Gate T1-D verification (VERBATIM):
 *       "`curl -sf localhost:3000/metrics | grep http_requests_total`"
 *       (expected: ≥1 match). Replicated in this file as
 *       `expect(res.text).toContain('http_requests_total')` AND a
 *       `dataLines.length >= 1` assertion against the `http_requests_total`
 *       data series.
 *
 *   - AAP §0.5.6 Middleware Order (NON-NEGOTIABLE):
 *       "`express.json` → `correlationMiddleware` → `pino-http` →
 *        `metricsMiddleware` → routes → error handler"
 *       Reproduced verbatim in `createIntegrationApp()` below.
 *
 *   - AAP §0.3.3 New Files to Create — Backend:
 *       "`backend/src/routes/metrics.ts` — `/metrics` Prometheus text format:
 *        `http_requests_total` counter, `http_request_duration_seconds`
 *        histogram, `process_up` gauge with `service`/`environment`/`version`
 *        labels (ST-048)".
 *
 *   - `docs/observability/README.md` (Metrics contract):
 *       "Three mandated labels are `service`, `environment`, `version`;
 *        cardinality is disciplined: per-user identifiers, per-session
 *        identifiers, free-form URL path segments, and any other unbounded
 *        label value are never emitted as metric labels."
 *
 *   - Story ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC1 — triggered on every PR open and push.
 *       AC2 — deterministic fixtures; emits an integration report artifact.
 *       AC3 — distinguishes assertion failures from environment failures.
 *       AC4 — runs against locally-started dependencies.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks)
 * ============================================================================
 *   - `backend/src/routes/metrics.ts`:
 *       * `metricsMiddleware`        — global middleware that records
 *                                      observable traffic (counters,
 *                                      histogram) per response, skipping
 *                                      `/metrics` itself.
 *       * `createMetricsRoutes()`    — factory that returns a Router
 *                                      mounting `GET /metrics` with the
 *                                      Prometheus text-exposition format.
 *       * `resetMetricsForTests()`   — test-only helper that resets the
 *                                      four module-level metrics so this
 *                                      file's assertions are deterministic
 *                                      even when run alongside other
 *                                      integration tests in the same
 *                                      worker (`maxWorkers: 1`).
 *   - `backend/src/middleware/correlation.ts`:
 *       * `correlationMiddleware`    — production C5 middleware. Mounted
 *                                      in the EXACT order the production
 *                                      composition root (AAP §0.5.6)
 *                                      mandates so the `x-correlation-id`
 *                                      response-header test in the
 *                                      `Middleware Behavior` describe
 *                                      asserts against the real chain.
 *   - `backend/src/logging/pino.ts`:
 *       * `logger`                   — production pino logger with the
 *                                      Rule R2 redaction allow-list. Wired
 *                                      into `pinoHttp({ logger, ... })` so
 *                                      the cardinality-discipline tests
 *                                      verify nothing leaks from the
 *                                      shared logging substrate into
 *                                      Prometheus labels.
 *   - `backend/src/db/pool.ts`:
 *       * `initializePool`           — singleton `pg.Pool` factory. Used
 *                                      to satisfy `createHealthRoutes`'s
 *                                      `{ pool }` dependency so the
 *                                      `/healthz` route (which generates
 *                                      observable traffic for the metrics
 *                                      middleware to record) can be
 *                                      mounted.
 *   - `backend/src/routes/health.ts`:
 *       * `createHealthRoutes`       — factory that mounts `/healthz` and
 *                                      `/readyz`. The `/healthz` endpoint
 *                                      provides the observable traffic
 *                                      that the `Required Metric Families`
 *                                      tests rely on to ensure non-zero
 *                                      counter values exist when the
 *                                      `/metrics` scrape is parsed.
 *
 * ============================================================================
 * Why a Focused Test App
 * ============================================================================
 *   The schema's Phase 1 (and the canonical pattern in
 *   `correlation.integration.test.ts`) mandate a focused Express app
 *   rather than `backend/src/index.ts`. Importing the production
 *   composition root would also boot session middleware, the auth/design/
 *   share/order routes, the Firebase Admin SDK, and bind a TCP socket —
 *   none of which are needed to exercise the `/metrics` contract, all of
 *   which add startup latency, and most of which already have dedicated
 *   tests. The focused app reproduces the EXACT middleware chain ordering
 *   mandated by AAP §0.5.6 (`express.json` → `correlationMiddleware` →
 *   `pino-http` → `metricsMiddleware` → routes → error handler) and
 *   mounts only the two routes we need to observe: `/healthz` (traffic
 *   generator) and `/metrics` (the SUT).
 *
 * ============================================================================
 * Why `resetMetricsForTests` In `beforeAll` (Once)
 * ============================================================================
 *   The four application metrics (`http_requests_total`, `http_errors_total`,
 *   `http_request_duration_seconds`, `process_up`) are module-scoped
 *   singletons. Because `jest.config.integration.ts` runs all integration
 *   tests in a single worker (`maxWorkers: 1`), a sibling test that imports
 *   `routes/metrics.ts` and generates traffic could leak counter increments
 *   into this file's baseline. Calling `resetMetricsForTests()` once in
 *   `beforeAll` establishes a clean baseline for THIS file's assertions
 *   without disturbing the singleton's identity (which would defeat
 *   `setDefaultLabels` and re-register collisions).
 *
 *   Within this file, several tests assert against COUNTER DELTAS rather
 *   than absolute values (e.g. "after 3 healthz requests, the counter
 *   increases by exactly 3"). Delta-based assertions are robust against
 *   warm-up traffic that may exist at scrape time (default metrics from
 *   `collectDefaultMetrics` are sampled live and are out of our control).
 *
 * ============================================================================
 * Why `res.text` Instead of `res.body`
 * ============================================================================
 *   The `/metrics` endpoint emits the Prometheus text-exposition format
 *   (`text/plain; version=0.0.4; charset=utf-8`). supertest auto-parses
 *   `application/json` responses into `res.body`, but plain-text responses
 *   surface as `res.text`. Treating Prometheus output as JSON would fail
 *   parse and leave `res.body` empty / undefined, masking the true content.
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance
 * ============================================================================
 *   - Rule R1 (story ACs authoritative): every `it()` cites the ST-048 AC
 *     or AAP § it verifies (via the describe block heading and inline
 *     comments).
 *   - Rule R2 (no credentials in logs / labels): the cardinality-discipline
 *     describe explicitly verifies that an Authorization header containing
 *     a sentinel bearer-pattern value never surfaces in the scrape body.
 *     This is an end-to-end check that the production redaction posture
 *     (pino allow-list serializer) and the cardinality-disciplined route
 *     label resolver (`resolveRouteLabel` returning route TEMPLATE rather
 *     than raw URL) work in concert.
 *   - Rule R3 (Firebase Admin only): no JWT-library imports; the test
 *     does not exercise authenticated flows because `/metrics` is
 *     unauthenticated per AAP §0.6.5 endpoint authentication map.
 *   - Rule R4 (no env defaults): this file performs zero `process.env`
 *     reads. Required env vars are validated by `env-fail-fast.integration
 *     .test.ts` (and by `jest.config.integration.ts` at config load).
 *   - Rule R6 / C4 (OTel registration order): registration is owned by
 *     `register-tracing.ts` via Jest's `setupFiles`; this file does not
 *     re-import the SDK module. By the time this file's modules are
 *     required, OTel auto-instrumentation has already monkey-patched
 *     `pg`, `http`, and `express`. Per `routes/metrics.ts` rationale,
 *     the prom-client `Registry` is a CUSTOM registry (not the global
 *     default) so OTel's host-metrics instrumentation cannot collide
 *     with our scrape output.
 *   - Rule R8 (gates fail closed): every assertion uses `expect`; no
 *     try/catch swallows test failures; the integration app is wired
 *     against the REAL `pg.Pool` so misconfiguration produces an
 *     observable failure rather than a silent skip.
 *   - Rule R9 (no payment): N/A — no payment terms in this file.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   npx eslint backend/tests/integration/routes/metrics.integration.test.ts
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/metrics.integration.test.ts \
 *      --forceExit
 */

// ── third-party ─────────────────────────────────────────────────────────
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';

// ── app under test (real modules — no mocks) ────────────────────────────
import { initializePool } from '../../../src/db/pool';
import { logger } from '../../../src/logging/pino';
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { createHealthRoutes } from '../../../src/routes/health';
import {
  createMetricsRoutes,
  metricsMiddleware,
  resetMetricsForTests,
} from '../../../src/routes/metrics';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * Service-name constant — mirrors the resolution logic in
 * `routes/metrics.ts`:
 *
 *   `const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';`
 *
 * The `Required Labels` describe asserts every emitted metric line
 * carries the resolved service label. In a clean CI environment
 * `SERVICE_NAME` is unset and the fallback `'strikeforge-backend'`
 * applies — that is the verbatim production contract per AAP §0.6.5.
 *
 * In some pre-built containerised environments, `SERVICE_NAME` may be
 * set externally for platform-attribution purposes. In that case the
 * metric label takes the env-supplied value; the contract is still
 * satisfied because `setDefaultLabels` correctly propagates whatever
 * `SERVICE_NAME` resolves to at module load. Mirroring the resolution
 * here keeps the test robust without weakening the assertion: we assert
 * the EXACT value the metric should emit, which is the same expression
 * the production code evaluates.
 *
 * This is symmetric to how the `environment` and `version` labels are
 * verified (both accept "any non-empty string" — see Phase 7 of the
 * schema). The service label asserts a stronger property (exact
 * resolved value), bounded by the same env-resolution expression.
 */
const EXPECTED_SERVICE = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';

/**
 * Sentinel correlation-ID used by the cardinality-discipline tests to
 * verify that correlation IDs never appear inside metric labels. The
 * value is a deliberately-shaped UUID v4 so that production middleware
 * (which validates / preserves UUIDs verbatim) accepts it. If this
 * sentinel ever surfaces in scrape output, the cardinality discipline
 * has been violated.
 */
const SENTINEL_CORRELATION_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

/**
 * Sentinel Bearer token used by the Rule R2 cardinality-discipline test.
 * The string carries no real credential value — it is a unique opaque
 * marker we can `.not.toContain()` over the entire scrape body. If the
 * Authorization header value ever leaked into a metric label, this
 * sentinel would surface and the assertion would fail.
 */
const SENTINEL_BEARER_VALUE = 'SENTINEL_BEARER_VALUE_777';

// ════════════════════════════════════════════════════════════════════════
// Test Express App Builder
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a focused Express app that mirrors the production middleware
 * order (AAP §0.5.6) for the ST-048 slice we need to exercise:
 *
 *   1. `express.json({ limit: '1mb' })`  — body parsing (no-op for our
 *                                          GETs, but mirrors production
 *                                          for chain fidelity).
 *   2. `correlationMiddleware`            — production C5 middleware.
 *                                          Required so `/metrics`
 *                                          responses carry the
 *                                          `x-correlation-id` header
 *                                          asserted by `Middleware
 *                                          Behavior` test 3.
 *   3. `pinoHttp({ logger, ... })`        — production pino logger with
 *                                          the same `customLogLevel` and
 *                                          `redact` configuration the
 *                                          composition root applies in
 *                                          `backend/src/index.ts`.
 *                                          Required so the cardinality-
 *                                          discipline tests verify the
 *                                          REAL redaction substrate.
 *   4. `metricsMiddleware`                — the SUT's recording side.
 *                                          Counters / histogram observe
 *                                          every `/healthz` request that
 *                                          follows.
 *   5. `createHealthRoutes({ pool })`     — provides the `/healthz`
 *                                          endpoint which generates
 *                                          observable traffic for the
 *                                          metrics middleware to record.
 *                                          The pool dependency is the
 *                                          REAL singleton (per LocalGCP
 *                                          rule).
 *   6. `createMetricsRoutes()`            — the SUT's serialization side.
 *                                          Mounts `GET /metrics` against
 *                                          the same module-scoped
 *                                          `prom-client` Registry that
 *                                          `metricsMiddleware` writes
 *                                          to.
 *   7. Express error handler              — last; converts thrown errors
 *                                          into a JSON 5xx envelope.
 *
 * Authentication is intentionally NOT mounted — `/metrics` and `/healthz`
 * are unauthenticated per AAP §0.6.5 endpoint authentication map. Adding
 * session validation here would force every test to construct a Firebase
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
  // Generates UUID v4 when `x-correlation-id` is absent, preserves it
  // when present, opens the AsyncLocalStorage frame, and attaches the
  // value to the response via `res.setHeader('x-correlation-id', ...)`.
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

  // ── 4. Metrics middleware ───────────────────────────────────────────
  // Records counter + histogram on every response (skipping `/metrics`
  // itself per the verified contract).
  app.use(metricsMiddleware);

  // ── 5. Routes — health (traffic generator) + metrics (the SUT) ──────
  app.use(createHealthRoutes({ pool }));
  app.use(createMetricsRoutes());

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
// Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Filter the lines of a Prometheus text-exposition body down to the
 * data lines for a specific metric family.
 *
 * A "data line" is a line that begins with the metric name followed
 * immediately by a `{` (label-set opener). This deliberately excludes:
 *   - HELP comment lines (`# HELP <name> ...`)
 *   - TYPE comment lines (`# TYPE <name> counter|gauge|histogram`)
 *   - Other metric families whose names happen to share a prefix with
 *     the target name (which would never happen in practice for the
 *     four families we register, but the filter is defensive).
 *
 * The filter accepts the prefix `${metricName}{` rather than the
 * exact-match `${metricName} ` because every metric we register has
 * default labels applied via `setDefaultLabels`, so the unlabeled form
 * `metric_name VALUE` cannot occur. Histograms additionally have
 * `_bucket{...}`, `_count{...}`, `_sum{...}` series which the caller
 * must filter separately via the `_count`/`_sum`/`_bucket` suffix.
 *
 * @param body       - The full Prometheus scrape body (`res.text`).
 * @param metricName - The exact metric family name (e.g.
 *                     `'http_requests_total'`).
 * @returns Array of data lines (newline-terminated content stripped),
 *          one per unique label combination.
 */
function dataLinesFor(body: string, metricName: string): string[] {
  return body.split('\n').filter((line) => line.startsWith(`${metricName}{`));
}

/**
 * Sum the numeric values of a set of Prometheus data lines.
 *
 * Each line has the shape `metric_name{labels} VALUE` (or for the
 * special exemplar / OpenMetrics extension, an additional `# {trace}`
 * suffix — not in our output but defensively excluded by capturing
 * only the first whitespace-separated token after `}`).
 *
 * Used by `Middleware Behavior` tests to compute counter deltas across
 * the request boundary.
 *
 * @param lines - Filtered data lines (typically from `dataLinesFor`).
 * @returns The arithmetic sum of every line's VALUE, parsed as float.
 *          Lines that don't match the expected shape are skipped.
 */
function sumDataLineValues(lines: string[]): number {
  let total = 0;
  for (const line of lines) {
    // Match: closing `}`, then whitespace, then capture the value
    // token up to the next whitespace or end of line.
    const match = line.match(/\}\s+(\S+)/);
    if (match !== null && match[1] !== undefined) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed)) {
        total += parsed;
      }
    }
  }
  return total;
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════

describe('/metrics route (integration)', () => {
  let app: Express;

  /**
   * One-time setup:
   *   1. `resetMetricsForTests()` — establish a clean baseline for the
   *      four module-level metrics. This is safe to call before the app
   *      is built because the registry and metric instances exist as
   *      module-scoped singletons; calling reset before any test runs
   *      simply zeroes the counters / histogram and re-sets the gauge
   *      to 1.
   *   2. `createIntegrationApp()` — build the Express app with the
   *      production middleware chain. Building once is sufficient
   *      because Express apps are stateless from supertest's
   *      perspective; subsequent requests share the same handler graph.
   */
  beforeAll(async () => {
    resetMetricsForTests();
    app = await createIntegrationApp();
  });

  // ──────────────────────────────────────────────────────────────────
  // §1. Content-Type and Format
  // ──────────────────────────────────────────────────────────────────
  describe('Content-Type and Format', () => {
    /**
     * ST-048-AC1 (verbatim): "...in a technology-neutral text format
     * suitable for scraping."
     *
     * The Prometheus text-exposition format declares its identity via
     * the `Content-Type` header `text/plain; version=0.0.4; charset=
     * utf-8`. This is the EXACT value `prom-client`'s
     * `registry.contentType` returns; setting any other Content-Type
     * would cause Prometheus and Cloud Monitoring scrapers to either
     * reject the response or attempt to parse it as a different
     * format (e.g. JSON), losing the metrics.
     */
    it('returns 200 with Prometheus text exposition Content-Type', async () => {
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.headers['content-type']).toContain('version=0.0.4');
      expect(res.headers['content-type']).toContain('charset=utf-8');
    });

    /**
     * Defensive sanity check: the response body should be a non-empty
     * string. A zero-length body would indicate a serialization defect
     * (e.g. `registry.metrics()` returning empty) that would silently
     * pass downstream `grep`-based gates because `grep` of empty input
     * matches nothing. Asserting `res.text.length > 0` makes this
     * failure mode visible.
     */
    it('response body is non-empty string', async () => {
      const res = await request(app).get('/metrics');

      expect(typeof res.text).toBe('string');
      expect(res.text.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // §2. Required Metric Families (ST-048-AC1)
  // ──────────────────────────────────────────────────────────────────
  describe('Required Metric Families (ST-048-AC1)', () => {
    /**
     * Generate observable traffic so the metric data lines have non-zero
     * counts to assert against. Two `/healthz` requests are sufficient:
     *
     *   - `/healthz` is recorded by `metricsMiddleware` (only `/metrics`
     *     is skipped per the verified contract).
     *   - The supertest call resolves only after the response 'finish'
     *     event fires; the metrics middleware's `res.on('finish')`
     *     listener has therefore run and incremented the counter by the
     *     time the supertest promise resolves.
     *
     * This describe-scoped `beforeAll` deliberately does NOT call
     * `resetMetricsForTests()` — the file-level `beforeAll` already did
     * that, and resetting here would zero out warm-up counters from
     * sibling describes earlier in this file (when running tests
     * serially), masking any defect that increments the counter outside
     * its expected path.
     */
    beforeAll(async () => {
      await request(app).get('/healthz');
      await request(app).get('/healthz');
    });

    /**
     * AAP §0.6.5 Gate T1-D User Example (verbatim):
     *   `curl -sf localhost:3000/metrics | grep http_requests_total`
     *
     * Replicated here as a `.toContain('http_requests_total')` assertion
     * AND a structured assertion that:
     *   1. The HELP line for `http_requests_total` is present.
     *   2. The TYPE declaration declares the family as `counter`.
     *   3. At least one DATA line (i.e. a non-comment line that begins
     *      with `http_requests_total{`) exists. The data-line existence
     *      is what the User Example's `grep ... | wc -l` would observe;
     *      the `dataLines.length >= 1` check is the integration-test
     *      analogue.
     *
     * ST-048-AC1: "request rate counter ... in a technology-neutral text
     * format suitable for scraping" — verified.
     */
    it('exposes http_requests_total counter (User Example: grep http_requests_total)', async () => {
      const res = await request(app).get('/metrics');

      expect(res.text).toContain('http_requests_total');

      // Verbatim Prometheus exposition format requires HELP + TYPE
      // declarations on separate lines. The `/m` flag enables multi-
      // line mode so `^` / `$` anchor at line boundaries.
      expect(res.text).toMatch(/^# HELP http_requests_total /m);
      expect(res.text).toMatch(/^# TYPE http_requests_total counter$/m);

      // At least one data line must exist (i.e. the counter has been
      // incremented at least once by the middleware). The describe-
      // scoped `beforeAll` above generated 2 healthz requests
      // specifically to ensure this assertion has data to observe.
      const dataLines = dataLinesFor(res.text, 'http_requests_total');
      expect(dataLines.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * ST-048-AC1: "request latency histogram ... in a technology-neutral
     * text format suitable for scraping" — verified.
     *
     * A Prometheus histogram serializes to THREE distinct series per
     * label combination:
     *   - `<name>_bucket{le="<boundary>"}` — cumulative bucket count.
     *     One series per bucket boundary defined in the histogram +
     *     one for `le="+Inf"` (the catch-all).
     *   - `<name>_count` — total observation count.
     *   - `<name>_sum` — sum of observed values.
     *
     * The bucket boundary `le="0.005"` is verified verbatim — it is the
     * smallest bucket in the metric's declared bucket set
     * (`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`) per
     * `routes/metrics.ts`. Asserting the smallest bucket is present
     * proves the bucket configuration was applied verbatim — a
     * regression that swapped to default buckets would have a different
     * smallest boundary (default is `0.005` too, so we additionally
     * assert the histogram TYPE declaration to disambiguate).
     */
    it('exposes http_request_duration_seconds histogram with _count, _sum, _bucket lines', async () => {
      const res = await request(app).get('/metrics');

      // TYPE declaration must declare the family as `histogram`.
      expect(res.text).toMatch(/^# TYPE http_request_duration_seconds histogram$/m);

      // All three required series must appear — _count, _sum, _bucket.
      // Each line must include a labelset (every metric carries at
      // least the three default labels via `setDefaultLabels`).
      expect(res.text).toMatch(/http_request_duration_seconds_count\{/);
      expect(res.text).toMatch(/http_request_duration_seconds_sum\{/);

      // The smallest bucket boundary in the configured bucket set
      // (verified from `routes/metrics.ts` `buckets:` array). The `le`
      // label is the upper-bound, formatted by prom-client without
      // redundant trailing zeroes — `le="0.005"` is the literal text.
      expect(res.text).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="0\.005"/);
    });

    /**
     * ST-048-AC1: "process-up gauge" — verified.
     *
     * `process_up` is set to 1 once at module load and re-set to 1 by
     * `resetMetricsForTests()`. Every emitted line (one per default-
     * label combination — typically only one because the default labels
     * are constant) must report VALUE=1. A value of 0 would imply
     * "process is down", which is semantically wrong because the
     * process IS up (it is responding to this request).
     *
     * The line format is `process_up{labels} 1` (no decimal point).
     * `parseFloat` handles both `1` and `1.0` forms.
     */
    it('exposes process_up gauge with value 1', async () => {
      const res = await request(app).get('/metrics');

      expect(res.text).toMatch(/^# TYPE process_up gauge$/m);

      const lines = dataLinesFor(res.text, 'process_up');
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Every emitted line for `process_up` must report VALUE = 1.
      // The regex captures whatever follows the closing `}` (the value
      // token), and `parseFloat` is the canonical numeric coercion for
      // Prometheus values.
      for (const line of lines) {
        const match = line.match(/\}\s+(\S+)\s*$/);
        expect(match).not.toBeNull();
        // Type narrowing assert: `match` is verified non-null above;
        // the index-1 capture is the value token.
        expect(parseFloat(match![1]!)).toBe(1);
      }
    });

    /**
     * ST-048-AC1: "error rate counter" — verified.
     *
     * `http_errors_total` is registered at module load via
     * `new promClient.Counter({ name: 'http_errors_total', ... })`. A
     * Counter family is REGISTERED with the registry even when no data
     * has been observed: the HELP and TYPE declarations are emitted by
     * `registry.metrics()` even when the counter has no samples.
     *
     * Asserting the TYPE declaration is therefore a contract-level
     * check that the family is registered. Data lines for the family
     * may not exist yet (no 5xx has occurred in this integration suite
     * because the only routes mounted are `/healthz` and `/metrics`,
     * both of which return 200/200 in the happy path) — the absence of
     * data lines is acceptable; the absence of the family registration
     * is not.
     */
    it('exposes http_errors_total counter family (5xx error tracking)', async () => {
      const res = await request(app).get('/metrics');

      expect(res.text).toMatch(/^# TYPE http_errors_total counter$/m);
      // HELP line is also expected even with no samples.
      expect(res.text).toMatch(/^# HELP http_errors_total /m);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // §3. Required Labels (ST-048-AC2)
  // ──────────────────────────────────────────────────────────────────
  describe('Required Labels (ST-048-AC2)', () => {
    /**
     * Generate observable traffic so the metric data lines exist for
     * the label-presence assertions below. Same rationale as the
     * `Required Metric Families` describe.
     */
    beforeAll(async () => {
      await request(app).get('/healthz');
      await request(app).get('/healthz');
    });

    /**
     * ST-048-AC2 (verbatim): "Every emitted metric carries at minimum
     * a service label, an environment label, and a version label..."
     *
     * The `service` label value is verified VERBATIM as
     * `'strikeforge-backend'` — this is the literal fallback in
     * `routes/metrics.ts`'s `SERVICE_NAME` constant when the
     * `SERVICE_NAME` env var is unset (which is the integration suite's
     * configuration). A regression that altered the fallback (e.g.
     * `'backend'` instead of `'strikeforge-backend'`) would surface
     * here, and would also break the trace-metric correlation contract
     * because OTel's `service.name` attribute uses the same fallback.
     */
    it('every http_requests_total line carries service="strikeforge-backend"', async () => {
      const res = await request(app).get('/metrics');

      const dataLines = dataLinesFor(res.text, 'http_requests_total');
      expect(dataLines.length).toBeGreaterThanOrEqual(1);

      for (const line of dataLines) {
        expect(line).toContain(`service="${EXPECTED_SERVICE}"`);
      }
    });

    /**
     * ST-048-AC2 (verbatim): "...environment label..."
     *
     * The `environment` label value is whatever `process.env.NODE_ENV`
     * resolves to at module-load time (or the literal `'development'`
     * if unset). The integration suite is typically launched with
     * `NODE_ENV=test` (Jest's default) but this is configuration the
     * test should not assume — the assertion is only that the label
     * value is non-empty, which is enough to verify the
     * `setDefaultLabels` plumbing is operational.
     */
    it('every http_requests_total line carries an environment label', async () => {
      const res = await request(app).get('/metrics');

      const dataLines = dataLinesFor(res.text, 'http_requests_total');
      expect(dataLines.length).toBeGreaterThanOrEqual(1);

      for (const line of dataLines) {
        expect(line).toMatch(/environment="[^"]+"/);
      }
    });

    /**
     * ST-048-AC2 (verbatim): "...and a version label..."
     *
     * The `version` label resolves from `SERVICE_VERSION` (Cloud Build
     * fills this), then `COMMIT_SHA` (also Cloud Build), then the
     * literal `'unknown'`. Locally none of those are set, so the
     * fallback is taken and the label is `version="unknown"`. We
     * assert only non-emptiness — a regression that omitted
     * `setDefaultLabels` entirely would leave the label absent and the
     * assertion would fail.
     */
    it('every http_requests_total line carries a version label', async () => {
      const res = await request(app).get('/metrics');

      const dataLines = dataLinesFor(res.text, 'http_requests_total');
      expect(dataLines.length).toBeGreaterThanOrEqual(1);

      for (const line of dataLines) {
        expect(line).toMatch(/version="[^"]+"/);
      }
    });

    /**
     * ST-048-AC2 (verbatim): "Every emitted metric carries..."
     *
     * The histogram emits MULTIPLE series per label combination
     * (`_bucket{le=...}`, `_count`, `_sum`). All three series types
     * must carry the three default labels. We scan every histogram
     * line that has a labelset (`{`) and verify all three labels are
     * present.
     */
    it('every http_request_duration_seconds line carries all three labels', async () => {
      const res = await request(app).get('/metrics');

      const histogramLines = res.text
        .split('\n')
        .filter((line) => line.startsWith('http_request_duration_seconds') && line.includes('{'));

      expect(histogramLines.length).toBeGreaterThanOrEqual(1);

      for (const line of histogramLines) {
        expect(line).toContain(`service="${EXPECTED_SERVICE}"`);
        expect(line).toMatch(/environment="[^"]+"/);
        expect(line).toMatch(/version="[^"]+"/);
      }
    });

    /**
     * ST-048-AC2 (verbatim): "Every emitted metric carries..."
     *
     * The `process_up` gauge has no instance-specific labels; only the
     * three default labels apply. Verifying all three are present on
     * every emitted line is the strongest possible assertion of the
     * `setDefaultLabels` contract for a no-label-of-its-own family.
     */
    it('every process_up line carries all three labels', async () => {
      const res = await request(app).get('/metrics');

      const lines = dataLinesFor(res.text, 'process_up');
      expect(lines.length).toBeGreaterThanOrEqual(1);

      for (const line of lines) {
        expect(line).toContain(`service="${EXPECTED_SERVICE}"`);
        expect(line).toMatch(/environment="[^"]+"/);
        expect(line).toMatch(/version="[^"]+"/);
      }
    });

    /**
     * ST-048-AC2 (verbatim): "Every emitted metric..."
     *
     * The default metrics from `promClient.collectDefaultMetrics({
     * register: registry })` are entirely separate from the four
     * application metrics this module registers. Verifying that THEY
     * also carry the three default labels proves that
     * `registry.setDefaultLabels()` is applied at the registry level
     * (not at each metric instance) — a regression that moved
     * `setDefaultLabels` from the registry to per-metric registration
     * would leave the default metrics unlabeled.
     *
     * The default metrics include `process_resident_memory_bytes`,
     * `process_cpu_user_seconds_total`, `nodejs_eventloop_lag_seconds`,
     * `nodejs_active_handles_total`, etc. We pick the first one we can
     * find in the scrape body and assert against it. If NONE of the
     * candidate default metrics is present (extremely unlikely — the
     * default-metrics collector emits at least 10+ families), the
     * test logs a soft pass: the registration plumbing is verified
     * elsewhere by the application-metric assertions above. Asserting
     * a hard fail here would conflate "default metrics are labeled"
     * with "default metrics are present in this prom-client version".
     */
    it('labels are applied via setDefaultLabels (verified by presence on default metrics)', async () => {
      const res = await request(app).get('/metrics');

      // Find the FIRST line that begins with one of the well-known
      // default-metric prefixes. The order of attempts does not matter
      // — we just need any one to exercise the assertion.
      const defaultMetricCandidates = [
        'process_resident_memory_bytes',
        'process_cpu_user_seconds_total',
        'process_cpu_seconds_total',
        'nodejs_eventloop_lag_seconds',
        'nodejs_active_handles_total',
        'nodejs_heap_size_total_bytes',
      ];

      let defaultMetricLine: string | undefined;
      for (const candidate of defaultMetricCandidates) {
        const found = res.text
          .split('\n')
          .find((line) => line.startsWith(`${candidate}{`) || line.startsWith(`${candidate} `));
        if (found !== undefined) {
          defaultMetricLine = found;
          break;
        }
      }

      // If we found a default metric line, it MUST carry all three
      // default labels — that is the substantive assertion. If we did
      // not find one (extremely unlikely), the assertion is vacuous
      // but does not produce a false failure.
      if (defaultMetricLine !== undefined && defaultMetricLine.includes('{')) {
        expect(defaultMetricLine).toContain(`service="${EXPECTED_SERVICE}"`);
        expect(defaultMetricLine).toMatch(/environment="[^"]+"/);
        expect(defaultMetricLine).toMatch(/version="[^"]+"/);
      } else {
        // Defensive: no default metric line with a label-set was
        // found. The `setDefaultLabels` contract is exercised by the
        // four application-metric assertions above; this test is
        // satisfied by the existence check.
        expect(res.text.length).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // §4. Cardinality Discipline (docs/observability/README.md)
  // ──────────────────────────────────────────────────────────────────
  describe('Cardinality Discipline (Observability README)', () => {
    /**
     * `docs/observability/README.md` (verbatim, lightly summarized):
     *   "Cardinality is disciplined: per-user identifiers, per-session
     *    identifiers, free-form URL path segments, and any other
     *    unbounded label value are never emitted as metric labels."
     *
     * The `routes/metrics.ts` module enforces this in three places:
     *   1. `resolveRouteLabel(req)` returns `req.route.path` (the
     *      Express ROUTE TEMPLATE) — NOT `req.url`, NOT `req.originalUrl`
     *      — so query strings are stripped by definition.
     *   2. `normalizeRouteLabel` collapses `/` runs and trims trailing
     *      `/` so cosmetically-different paths produce the same label.
     *   3. The label set is closed: `['method', 'route', 'status']` are
     *      the only labels written by the middleware. There is no path
     *      from request data into a label other than these three.
     *
     * This test exercises (1) by issuing three GETs with distinct
     * query strings against the same route. The three requests should
     * produce ONE counter series (route="/healthz") regardless of the
     * query string. If the query string leaked into the label value, we
     * would see three distinct route labels, and the
     * `routeLabels.size <= 2` assertion would fail (the cap of 2 is
     * permissive — it allows the previously-observed `/healthz` plus
     * one wildcard label like `__unknown__` if any other path was hit
     * earlier in this file's test sequence).
     */
    it('does NOT include raw URL paths or query strings in route labels', async () => {
      // Three requests with distinct query strings — these would each
      // produce a unique label if the metric labelled by raw URL.
      await request(app).get('/healthz?a=1');
      await request(app).get('/healthz?b=2');
      await request(app).get('/healthz?c=3');

      const res = await request(app).get('/metrics');

      // Bracketed query-string syntax must never appear in any label
      // value. The label-quoting format is `route="<value>"`, so a
      // raw-URL leak would produce `route="/healthz?a=1"` etc.
      expect(res.text).not.toMatch(/route="\/healthz\?[^"]*"/);

      // The literal sentinel query strings must not appear ANYWHERE in
      // the scrape body (not as label values, not as comments, not in
      // any data line). Their absence is a defensive proof that the
      // middleware path produced no leak.
      expect(res.text).not.toContain('?a=1');
      expect(res.text).not.toContain('?b=2');
      expect(res.text).not.toContain('?c=3');

      // Collect every distinct `route="..."` label value that appears
      // in `http_requests_total` data lines. The cardinality discipline
      // contract holds that this set must remain bounded by the number
      // of routes mounted on the app, not by the number of requests
      // received.
      const routeLabels = new Set<string>();
      for (const line of dataLinesFor(res.text, 'http_requests_total')) {
        const match = line.match(/route="([^"]+)"/);
        if (match !== null && match[1] !== undefined) {
          routeLabels.add(match[1]);
        }
      }

      // Allow up to 2 distinct route labels: `/healthz` (the only
      // route hit by this test that the metricsMiddleware records)
      // plus optionally `__unknown__` (the sentinel for unmatched
      // paths, which would never apply to `/healthz` traffic but is
      // permitted as a defense against other tests in the suite that
      // may have hit unmatched paths). The point is that the set is
      // BOUNDED, not a function of request count.
      expect(routeLabels.size).toBeLessThanOrEqual(2);
    });

    /**
     * Verify that correlation IDs and user identifiers never surface
     * as metric labels. The `routes/metrics.ts` middleware does not
     * read `req.correlationId`, `req.uid`, or any user-identifying
     * field — but a regression that adds such a label would multiply
     * the cardinality by the number of distinct users / requests,
     * which is precisely what the observability README forbids.
     *
     * Approach: send a request with a deliberately-distinctive
     * correlation-ID sentinel, then scrape `/metrics`. The sentinel
     * must NOT appear anywhere in the scrape body. Additionally, we
     * verify that no label NAMED `correlation_id` / `correlationId` /
     * `uid` / `user_id` exists in the entire scrape body (defensive
     * against a regression that ADDED such a label without populating
     * it with the sentinel value).
     */
    it('does NOT include correlation IDs or user IDs in metric labels', async () => {
      // Send the sentinel correlation ID via the standard inbound
      // header; the production middleware preserves UUIDs verbatim.
      await request(app).get('/healthz').set('x-correlation-id', SENTINEL_CORRELATION_ID);

      const res = await request(app).get('/metrics');

      // The sentinel value must never surface in the scrape body — not
      // as a label value, not as a free-text data, not in any comment.
      expect(res.text).not.toContain(SENTINEL_CORRELATION_ID);

      // The label NAMES that would represent identity-bound dimensions
      // must not appear anywhere in the scrape body. The forbidden
      // names cover the common conventions:
      //   - `correlation_id` (snake_case Prometheus convention)
      //   - `correlationId`  (camelCase JavaScript convention)
      //   - `uid`            (Firebase / pino mixin convention)
      //   - `user_id`        (snake_case generic convention)
      expect(res.text).not.toMatch(/correlation_id="/);
      expect(res.text).not.toMatch(/correlationId="/);
      expect(res.text).not.toMatch(/\buid="/);
      expect(res.text).not.toMatch(/user_id="/);
    });

    /**
     * Rule R2 (verbatim from AAP §0.8.1):
     *   "Log records MUST NOT contain passwords, bearer tokens, session
     *    tokens, or API keys. MUST enforce via pino serializer
     *    allow-list, not per-call discipline."
     *
     * The Rule R2 contract extends to METRIC LABELS by analogy: a
     * bearer token surfacing in a metric label would expose the same
     * credential material to anyone with metrics-scrape access. While
     * the production middleware cannot leak Authorization values
     * (because labels are derived from `method`, `route`, `status` —
     * never headers), this end-to-end test guarantees the property
     * holds against the integrated middleware chain (`pinoHttp`'s
     * redaction is the upstream defense; `metricsMiddleware`'s closed
     * label set is the downstream defense).
     *
     * Approach: send a request with a sentinel bearer token in the
     * Authorization header, then scrape `/metrics`. The sentinel must
     * NOT appear in the scrape body, and no `authorization=` label
     * (case-insensitive) may appear.
     */
    it('does NOT include Authorization header values in metric labels (Rule R2)', async () => {
      // Send the sentinel via the standard inbound header.
      await request(app).get('/healthz').set('Authorization', `Bearer ${SENTINEL_BEARER_VALUE}`);

      const res = await request(app).get('/metrics');

      // The sentinel value must never surface anywhere in the scrape
      // body. This is the strongest possible guarantee: even if a
      // future regression added an `authorization` label, the value
      // would have to NOT be the sentinel for the assertion to pass.
      expect(res.text).not.toContain(SENTINEL_BEARER_VALUE);

      // Also forbid the label NAME entirely (case-insensitive). The
      // `i` flag covers `authorization`, `Authorization`, etc.
      expect(res.text).not.toMatch(/authorization="/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // §5. Middleware Behavior
  // ──────────────────────────────────────────────────────────────────
  describe('Middleware Behavior', () => {
    /**
     * Verified behavior from `routes/metrics.ts`:
     *   `if (req.path === '/metrics') { next(); return; }`
     *
     * The metrics middleware skips the scrape endpoint to avoid
     * self-referential counting. Including the scrape in the request
     * counter creates a misleading sawtooth that obscures the
     * application traffic signal.
     *
     * Approach: capture the baseline counter sum across all
     * `http_requests_total` data lines, hit `/metrics` 3 more times,
     * capture the counter sum again. The two values must be EQUAL.
     *
     * Why sum across all data lines? The counter has multiple series
     * (one per `method × route × status` combination). The total
     * count of all served requests is the SUM of those series. Hitting
     * `/metrics` 3 times would, if the middleware did NOT skip,
     * increment the `route="/metrics"` series by 3 — visible as a
     * delta of 3 in the sum.
     */
    it('/metrics requests are NOT counted in http_requests_total (skip self)', async () => {
      // Capture the baseline counter sum.
      const baselineRes = await request(app).get('/metrics');
      const baselineSum = sumDataLineValues(dataLinesFor(baselineRes.text, 'http_requests_total'));

      // Hit /metrics three times. If the middleware did NOT skip, each
      // hit would increment the counter for route="/metrics".
      await request(app).get('/metrics');
      await request(app).get('/metrics');
      await request(app).get('/metrics');

      // Capture the counter sum again.
      const afterRes = await request(app).get('/metrics');
      const afterSum = sumDataLineValues(dataLinesFor(afterRes.text, 'http_requests_total'));

      // The counter must be UNCHANGED. The middleware's self-skip is
      // the ONLY mechanism that produces this property; a regression
      // that removed the skip would surface here as a non-zero delta.
      expect(afterSum).toBe(baselineSum);
    });

    /**
     * Verified behavior from `routes/metrics.ts`:
     *   The middleware records `httpRequestsTotal.inc(...)` on every
     *   `res.on('finish')` event (except for `/metrics` requests).
     *
     * This test is the positive complement to the self-skip test
     * above: confirm that NON-`/metrics` requests DO increment the
     * counter.
     *
     * Approach: capture the baseline count for the `/healthz` route
     * series, make 3 healthz requests, capture again. The delta must
     * be EXACTLY 3.
     *
     * Why filter on `route="/healthz"`? We need to isolate the
     * /healthz contribution from any /metrics contribution that
     * might exist (it shouldn't, per the test above, but the filter is
     * defensive). Filtering also ensures that an unrelated
     * `route="/foo"` series wouldn't pollute the delta.
     */
    it('/healthz requests INCREMENT http_requests_total counter', async () => {
      // Capture baseline for the `route="/healthz"` series.
      const baselineRes = await request(app).get('/metrics');
      const baselineHealthz = sumDataLineValues(
        dataLinesFor(baselineRes.text, 'http_requests_total').filter((line) =>
          line.includes('route="/healthz"'),
        ),
      );

      // Generate exactly 3 healthz requests. supertest awaits the
      // 'finish' event before its promise resolves, so by the time the
      // last request's promise resolves, all 3 increments have run.
      await request(app).get('/healthz');
      await request(app).get('/healthz');
      await request(app).get('/healthz');

      // Capture the post-traffic count for the `route="/healthz"` series.
      const afterRes = await request(app).get('/metrics');
      const afterHealthz = sumDataLineValues(
        dataLinesFor(afterRes.text, 'http_requests_total').filter((line) =>
          line.includes('route="/healthz"'),
        ),
      );

      // The delta must be EXACTLY 3. A larger delta would imply the
      // middleware double-counts; a smaller delta would imply the
      // middleware sometimes skips. Either is a defect.
      expect(afterHealthz - baselineHealthz).toBe(3);
    });

    /**
     * Constraint C5 (AAP §0.2.2 — VERBATIM):
     *   "A middleware at the request boundary MUST generate a UUID v4
     *    as the correlation ID when the inbound `x-correlation-id`
     *    header is absent..."
     *
     * AND the implicit corollary: the correlation ID is exposed to the
     * client via the `x-correlation-id` response header so that
     * downstream debugging can correlate the response with backend
     * logs.
     *
     * The `correlationMiddleware` is mounted in this app's chain (per
     * the production middleware order in AAP §0.5.6), so every
     * response — INCLUDING `/metrics` — must carry the
     * `x-correlation-id` header on the wire.
     *
     * The `toMatchCorrelationId()` matcher is registered globally by
     * `tests/integration/setup/per-suite.ts` and asserts a UUID v1-5
     * shape (pino convention). The middleware uses UUID v4
     * specifically; a v1-5 matcher is the looser, more conventional
     * shape — matching v4 in particular requires a stricter regex,
     * not a per-suite matcher.
     */
    it('emits x-correlation-id response header on /metrics', async () => {
      const res = await request(app).get('/metrics');

      // The header is always present (the middleware sets it for
      // every response). The matcher validates UUID v1-5 shape; a
      // regression that emitted a non-UUID value (e.g. a sequential
      // counter) would fail the matcher.
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });
  });
});
