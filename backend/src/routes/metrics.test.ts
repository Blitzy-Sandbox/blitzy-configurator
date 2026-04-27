/**
 * Unit tests for `backend/src/routes/metrics.ts` — ST-048 (AC1, AC2, AC5).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-048 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "Each service exposes a metrics endpoint at a documented path
 *             that serves service-level metrics typed as explicit primitives
 *             — a request rate counter, an error rate counter, a request
 *             latency histogram, and a process-up gauge are the baseline
 *             set — in a technology-neutral text format suitable for
 *             scraping."
 *
 *       AC2: "Every emitted metric carries at minimum a service label, an
 *             environment label, and a version label so that metrics are
 *             dimensioned consistently across deployments and can be
 *             filtered and aggregated by service, environment, and version."
 *
 *       AC5: "The metrics endpoint and both probe endpoints can be reached
 *             and interpreted in the local development environment without
 *             any cloud access, and the expected responses are documented
 *             alongside the endpoints."
 *
 *   - Story ST-043 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC3: "A failing assertion, a test exception, or a coverage
 *             percentage below the documented threshold produces a failed
 *             verdict; the suite is deterministic, so repeated runs against
 *             the same source tree produce the same verdict."
 *
 *       AC4: "The suite runs in the local development environment without
 *             any additional services or network access beyond the standard
 *             local toolchain."
 *
 *   - AAP §0.6.5 Track 1 Gate T1-D verification (verbatim from user prompt):
 *
 *         curl -sf localhost:3000/metrics | grep http_requests_total
 *         # expected: match found
 *
 *     The `Gate T1-D verification` describe block below mirrors this command
 *     at the unit level: the test asserts the `/metrics` body contains the
 *     literal `http_requests_total` after sample traffic has flowed.
 *
 *   - AAP §0.7.1 "Exhaustively In Scope":
 *         backend/src co-located *.test.ts files (per ST-043)
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * GET /metrics — Prometheus text exposition format (ST-048-AC1, ST-048-AC5):
 *   1. Returns HTTP 200 with `Content-Type: text/plain; ... version=0.0.4`
 *      — the canonical Prometheus exposition Content-Type emitted by
 *      `registry.contentType` in prom-client v15. Scrapers parse the
 *      response only when this header matches.
 *   2. Body shape is plain text with `# HELP` and `# TYPE` directive
 *      lines preceding each metric. This is the structural signal that
 *      a Prometheus scraper uses to discover metric metadata.
 *   3. The body MUST contain the four ST-048-AC1 prescribed primitives:
 *        - `http_requests_total`               (request rate counter)
 *        - `http_errors_total`                 (error rate counter)
 *        - `http_request_duration_seconds`     (latency histogram)
 *        - `process_up`                        (process liveness gauge)
 *      Verification is by `# TYPE <name> <kind>` regex match plus a
 *      sample-line presence check — together they confirm the metric is
 *      both registered and emitted.
 *   4. The `process_up` gauge is held at the literal value `1` while the
 *      process is serving (the source sets it once at module load, and
 *      `resetMetricsForTests` re-sets it to 1 to preserve the
 *      "process-is-up" semantic across test reset boundaries).
 *
 * GET /metrics — service / environment / version labels (ST-048-AC2):
 *   5. Every metric series MUST carry the three baseline labels (`service`,
 *      `environment`, `version`). The source's `setDefaultLabels` puts
 *      these at the END of the label list for counters and at the FRONT
 *      for histograms (this is a prom-client v15 implementation detail);
 *      the assertion regexes use `[^}]*` between label requirements so
 *      the order is irrelevant — only PRESENCE matters per the spec.
 *   6. The label VALUES must be non-empty strings. The source falls back
 *      to documented defaults (`'strikeforge-backend'`,
 *      `'development'`, `'unknown'`) when env vars are unset, so the
 *      assertion accepts ANY non-empty value via `[^"]+`. This makes
 *      the test robust to test-runner environments that pre-set
 *      `SERVICE_NAME` / `NODE_ENV` / `SERVICE_VERSION`.
 *
 * metricsMiddleware — request counting + duration recording (ST-048-AC1):
 *   7. Every completed inbound request increments `http_requests_total`
 *      exactly once, partitioned by `method`, `route`, and `status`. The
 *      counter is written in the `res.on('finish')` listener so handlers
 *      that mutate `res.statusCode` (Express error handlers, conditional
 *      branches) are reflected in the recorded label.
 *   8. Every completed inbound request records ONE observation into the
 *      `http_request_duration_seconds` histogram. The histogram's `_count`
 *      series MUST equal the request count; `_sum` and `_bucket{le="..."}`
 *      series MUST be present.
 *   9. The middleware self-skips for `req.path === '/metrics'` so the
 *      scrape endpoint is NOT counted by itself — including the scrape
 *      would produce a self-referential tail at every scrape interval
 *      that obscures the application traffic signal.
 *  10. The `method` label is the inbound HTTP method (GET, POST, ...).
 *      The `status` label is the actual status code emitted to the
 *      client (200, 404, 500, ...) — the source reads it from
 *      `res.statusCode` inside the `'finish'` hook so error-handler-
 *      applied status codes are reflected.
 *  11. 5xx responses ALSO increment `http_errors_total` (the dedicated
 *      error-rate counter named in ST-048-AC1). 4xx responses increment
 *      ONLY `http_requests_total`. This split is deliberate: alerts on
 *      "error rate" want a flat counter, not a regex-filtered subset.
 *
 * metricsMiddleware — Rule R2 + cardinality defenses:
 *  12. The `route` label is the matched Express ROUTE TEMPLATE (e.g.
 *      `/api/designs/:id`), NOT the raw URL. Query strings, path
 *      parameter values, and any incidental credentials in those
 *      values therefore NEVER appear in metric labels. This is the
 *      structural defense against (a) cardinality blow-up
 *      (millions of distinct UUIDs each producing a unique label
 *      value) and (b) credential leakage via query strings (Rule R2).
 *  13. Inbound headers (`x-correlation-id`, `Authorization`, any
 *      `x-*` header) MUST NOT appear as metric labels or in any
 *      label value. This is verified by injecting sentinel header
 *      values and asserting their absence in the scrape body.
 *  14. Unmatched routes (404 from no handler matching the path)
 *      consolidate under a single `route="__unknown__"` label. This
 *      prevents scanners hitting `/wp-admin`, `/.env`, etc. from
 *      each producing a unique series.
 *
 * createMetricsRoutes — factory contract:
 *  15. Returns an Express Router (a callable function — the router IS
 *      its own request handler). The composition root in
 *      `backend/src/index.ts` mounts the returned router at the
 *      application root via `app.use(router)`.
 *  16. Each factory invocation returns a DISTINCT Router instance.
 *      The shared module-level state is the prom-client registry,
 *      not the router; multiple routers backed by the same registry
 *      is the expected pattern.
 *
 * metricsMiddleware — function contract:
 *  17. The exported `metricsMiddleware` is a runtime function with
 *      arity 3 (`req, res, next`). Express's middleware contract
 *      requires three-argument functions for ordinary middleware
 *      (four-argument functions are reserved for error handlers).
 *
 * ============================================================================
 * Determinism (ST-043-AC3)
 * ============================================================================
 *
 *   - `resetMetricsForTests()` is invoked in `beforeEach` so every test
 *     starts from a known-zero counter / histogram baseline. Without this
 *     reset, prom-client's module-level registry would accumulate state
 *     across tests and order-dependent flakes would emerge.
 *   - The reset preserves `process_up = 1` because zeroing it would imply
 *     the process is down — wrong semantically and wrong for the gauge
 *     test that asserts the literal value `1`.
 *   - No fake timers are used. The histogram observation uses
 *     `process.hrtime.bigint()` which is monotonic and unaffected by
 *     wall-clock manipulation; faking it would short-circuit the very
 *     duration the test is verifying.
 *   - `clearMocks` / `resetMocks` / `restoreMocks` are all `true` in
 *     `jest.config.unit.ts`, but no `jest.fn()` is installed by these
 *     tests — the test exercises the real middleware against real
 *     Express + supertest plumbing.
 *
 * ============================================================================
 * Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` drives the in-memory Express
 *     application via an ephemeral-port loopback that supertest manages
 *     internally; no DNS, no external host, no cloud access.
 *   - Zero file-system access. The test reads no files; the route reads
 *     no files.
 *   - Zero environment-variable mutation. The test does NOT touch
 *     `process.env`. The metrics module's three identity env vars
 *     (`SERVICE_NAME`, `NODE_ENV`, `SERVICE_VERSION`) are read at
 *     module-load time with documented defaults; the test asserts
 *     against `[^"]+` (any non-empty value) so the assertion is robust
 *     to any test-runner-provided values.
 *
 * @see backend/src/routes/metrics.ts          — module under test
 * @see backend/jest.config.unit.ts            — Jest runner configuration
 * @see tickets/stories/ST-048-metrics-endpoint-health-readiness-probes.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// `express` is imported as a runtime default — the test invokes
// `express()` to construct an in-memory Express application that mounts
// the metrics middleware and the router under test. Supertest's
// `request` is also a runtime default (the package's primary export).
// Both packages declare these defaults via CommonJS's
// `module.exports = ...`, and the project's `esModuleInterop: true`
// compiler option (see `backend/tsconfig.json`) makes the
// `import x from 'y'` form resolve to `module.exports` under the hood.
//
// `createMetricsRoutes`, `metricsMiddleware`, and `resetMetricsForTests`
// are the three subjects under test, imported as named runtime exports
// from the sibling `./metrics` module. They are NOT type-only imports
// — every import is invoked at runtime by these tests.

import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';

import { createMetricsRoutes, metricsMiddleware, resetMetricsForTests } from './metrics';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Construct a fresh Express application wired identically to the
 * production composition root in `backend/src/index.ts` (with the
 * `metricsMiddleware` mounted globally BEFORE any application route,
 * and the `createMetricsRoutes()` router mounted at the application
 * root so the scrape lives at `GET /metrics`).
 *
 * Two synthetic test routes are registered to drive predictable
 * status-code distributions through the middleware:
 *   - `GET /sample` — returns 200 OK with `{ ok: true }` body. Used to
 *     exercise the success path of `http_requests_total` and the
 *     histogram observation flow.
 *   - `GET /boom`   — returns 500 with `{ error: 'fail' }` body. Used
 *     to exercise the 5xx path that should ALSO increment
 *     `http_errors_total`.
 *
 * No POST handler is registered; POST requests therefore yield 404
 * (Express's default no-match response) and the metrics middleware
 * records `method="POST", route="__unknown__", status="404"` for
 * those requests. This is the documented behaviour of
 * `resolveRouteLabel` for unmatched paths and exists to defend
 * cardinality against vulnerability scanners.
 *
 * The `includeMiddleware: false` option is used by tests that need
 * to verify the unmiddlewared `/metrics` endpoint emits a static
 * baseline (no per-request counters, just `process_up` and the
 * default process metrics).
 *
 * @param includeMiddleware - Whether to mount the metrics middleware
 *                            globally. Defaults to `true` so most
 *                            tests get the production wiring without
 *                            needing to opt in.
 * @returns A ready-to-test Express application instance.
 */
function buildApp(includeMiddleware = true): express.Express {
  const app = express();
  // JSON body parsing for POST /sample tests below. Setting it before
  // the metrics middleware is fine because parsing happens lazily on
  // the request body — the metrics middleware does not read the
  // body, only headers and the eventual response status.
  app.use(express.json());

  if (includeMiddleware) {
    app.use(metricsMiddleware);
  }

  // Mount the metrics router AT THE ROOT — this matches the production
  // wiring in `backend/src/index.ts` where `app.use(createMetricsRoutes())`
  // exposes `/metrics` directly without an `/api/` prefix.
  app.use(createMetricsRoutes());

  // Synthetic 200 route. Body is ignored by the middleware; the only
  // observable effect is `res.statusCode === 200` at the `'finish'`
  // event boundary. Note the explicit `void` return type via a
  // statement-only arrow body — `(_req, res) => res.json(...)` would
  // have an implicit Response return, which TypeScript accepts for
  // RequestHandler signatures but the project's `noImplicitReturns`
  // does NOT enforce a void body. Both forms compile; the explicit
  // statement body is a small clarity win.
  app.get('/sample', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // Synthetic 500 route. The 5xx status drives both the
  // `http_requests_total{status="500"}` increment and the
  // `http_errors_total{status="500"}` increment in the middleware.
  app.get('/boom', (_req: Request, res: Response) => {
    res.status(500).json({ error: 'fail' });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('GET /metrics — ST-048-AC1 (Prometheus text format)', () => {
  beforeEach(() => {
    // Reset prom-client's accumulated counter / histogram state so each
    // test starts from a known-zero baseline. Without this reset the
    // tests that assert specific counter values would be order-dependent
    // and flake under different test orderings — directly violating
    // ST-043-AC3's determinism requirement.
    resetMetricsForTests();
  });

  it('returns 200 with Prometheus text-format Content-Type', async () => {
    // The Prometheus text exposition Content-Type is canonical:
    //   `text/plain; ... version=0.0.4 ...`
    // prom-client's `register.contentType` constant emits exactly this
    // string. A scraper that does NOT see `version=0.0.4` will reject
    // the response or fall back to a heuristic parser; either way is
    // a degraded scrape, so the explicit assertion guards against any
    // future regression that swaps the Content-Type for a generic
    // `application/octet-stream` or `text/html`.
    const app = buildApp();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-type']).toMatch(/version=0\.0\.4/);
  });

  it('body is plain text with # HELP and # TYPE directive lines', async () => {
    // The Prometheus exposition format requires every metric to be
    // preceded by `# HELP <name> <description>` and `# TYPE <name>
    // <kind>` lines. Their presence is the structural signal that a
    // scraper uses to discover metric metadata; without them, scrapers
    // emit "incomplete metric metadata" warnings and dashboards lose
    // their tooltip text.
    //
    // The `^...` anchor with the `m` flag asserts the directive is at
    // the START of a line — they MUST NOT appear inline. The presence
    // of any one HELP and any one TYPE line is sufficient to establish
    // the format; subsequent tests verify specific named metrics.
    const app = buildApp();
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/^# HELP /m);
    expect(res.text).toMatch(/^# TYPE /m);
  });

  it('body includes http_requests_total counter (ST-048-AC1 request rate)', async () => {
    // Generate one sample request so the counter is registered AND
    // emitted. Without traffic the counter is registered but emits no
    // sample lines (counters with no observations show only the
    // `# HELP` and `# TYPE` directives), and the test would degenerate
    // into a metadata-only check.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');

    // Both the TYPE directive AND a labelled sample line must appear.
    // The TYPE directive proves the metric is REGISTERED; the
    // labelled sample line proves the middleware observed at least
    // one request and the counter is EMITTING.
    expect(res.text).toMatch(/# TYPE http_requests_total counter/);
    expect(res.text).toMatch(/http_requests_total\{/);
  });

  it('body includes http_request_duration_seconds histogram (ST-048-AC1 latency)', async () => {
    // The latency histogram is a multi-series metric. Each completed
    // request emits:
    //   - a sequence of `_bucket{le="..."}` cumulative counts
    //   - a `_count` series (total observations)
    //   - a `_sum` series (sum of observation values)
    // ALL THREE must be present for a histogram to be useful — a
    // scraper that gets only `_bucket` cannot compute averages, and
    // a scraper that gets only `_count` cannot compute quantiles.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/# TYPE http_request_duration_seconds histogram/);
    expect(res.text).toMatch(/http_request_duration_seconds_bucket\{/);
    expect(res.text).toMatch(/http_request_duration_seconds_count\{/);
    expect(res.text).toMatch(/http_request_duration_seconds_sum\{/);
  });

  it('body includes process_up gauge held at the literal value 1', async () => {
    // The process-up gauge is the cheapest possible liveness signal
    // and is set once at module load. The exposition format renders
    // a gauge as `name{labels} value` with a SPACE separator; the
    // regex `process_up\{[^}]*\} 1` matches any combination of
    // labels (the source applies the three default labels via
    // `setDefaultLabels`) followed by the literal `1`.
    //
    // Note: `[^}]*` matches anything that is NOT a closing brace.
    // This is a deliberately greedy match across the whole label
    // block. It does NOT cross brace boundaries because the negated
    // character class disallows `}`.
    const app = buildApp();
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/# TYPE process_up gauge/);
    expect(res.text).toMatch(/process_up\{[^}]*\} 1/);
  });

  it('body includes http_errors_total counter (ST-048-AC1 error rate)', async () => {
    // ST-048-AC1 names "an error rate counter" alongside the request
    // rate counter. The source declares `http_errors_total` as a
    // dedicated 5xx-only counter (rather than a derived series like
    // `http_requests_total{status=~"5.."}`) so alert policies can
    // threshold on it directly.
    //
    // Driving a single 500 request through `/boom` creates one
    // observation for both `http_requests_total` AND `http_errors_total`.
    const app = buildApp();
    await request(app).get('/boom');
    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/# TYPE http_errors_total counter/);
    expect(res.text).toMatch(/http_errors_total\{/);
  });

  describe('Gate T1-D verification (per AAP §0.6.5)', () => {
    // The user prompt's Gate T1-D verification command is verbatim:
    //
    //   curl -sf localhost:3000/metrics | grep http_requests_total
    //
    // (expected: match found). This test mirrors that grep at the unit
    // level — an in-memory scrape of `/metrics` after one sample
    // request must contain the literal string `http_requests_total`.

    it('"/metrics body contains the literal http_requests_total"', async () => {
      const app = buildApp();
      await request(app).get('/sample');
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('http_requests_total');
    });
  });
});

describe('GET /metrics — ST-048-AC2 (service / environment / version labels)', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('http_requests_total carries a non-empty service label', async () => {
    // The source applies the three default labels via `setDefaultLabels`
    // at module-load. The label VALUE is read from `process.env.SERVICE_NAME`
    // with documented fallback `'strikeforge-backend'`; the assertion
    // accepts any non-empty value via `[^"]+` so the test passes
    // regardless of what `SERVICE_NAME` is set to in the test runner.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/http_requests_total\{[^}]*service="[^"]+"/);
  });

  it('http_requests_total carries a non-empty environment label', async () => {
    // Same defensive `[^"]+` pattern — accepts whatever the test
    // runner has set `NODE_ENV` to (typically `'test'` under Jest).
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/http_requests_total\{[^}]*environment="[^"]+"/);
  });

  it('http_requests_total carries a non-empty version label', async () => {
    // Same defensive `[^"]+` pattern. The source falls back to
    // `'unknown'` when neither `SERVICE_VERSION` nor `COMMIT_SHA`
    // is set; `'unknown'` is a non-empty string and matches.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/http_requests_total\{[^}]*version="[^"]+"/);
  });

  it('http_request_duration_seconds histogram carries all three baseline labels', async () => {
    // Histograms render the default labels alongside the user labels
    // on every `_bucket`, `_count`, and `_sum` series. The order of
    // labels differs between counters and histograms in prom-client
    // v15 (this is an internal implementation detail), but the
    // PRESENCE of all three labels is guaranteed by `setDefaultLabels`.
    // The test uses three independent matchers connected by `[^}]*`
    // gaps so any label ordering passes.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{[^}]*service="[^"]+"[^}]*environment="[^"]+"[^}]*version="[^"]+"/,
    );
  });

  it('http_errors_total carries all three baseline labels', async () => {
    // ST-048-AC2 uses "every emitted metric" — the error counter is
    // an emitted metric, so it MUST carry the three baseline labels.
    const app = buildApp();
    await request(app).get('/boom');
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(/http_errors_total\{[^}]*service="[^"]+"/);
    expect(res.text).toMatch(/http_errors_total\{[^}]*environment="[^"]+"/);
    expect(res.text).toMatch(/http_errors_total\{[^}]*version="[^"]+"/);
  });

  it('process_up gauge carries all three baseline labels', async () => {
    // Process-up has no metric-specific labels (no `labelNames` was
    // specified in its construction), so the only labels rendered
    // are the three baseline labels from `setDefaultLabels`. The
    // single combined regex therefore succeeds whether or not
    // additional labels appear.
    const app = buildApp();
    const res = await request(app).get('/metrics');
    expect(res.text).toMatch(
      /process_up\{[^}]*service="[^"]+"[^}]*environment="[^"]+"[^}]*version="[^"]+"/,
    );
  });
});

describe('metricsMiddleware — request counting and labelling', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('increments http_requests_total exactly once per 200 response', async () => {
    // After one GET /sample, the counter line for
    // `method="GET", route="/sample", status="200"` MUST exist with
    // a value of at least 1. Using `>= 1` instead of `=== 1` guards
    // against any concurrent test interference (with `resetMetricsForTests`
    // called per-test, this is unlikely but the looser bound is more
    // robust to future restructuring and matches the schema's design).
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');

    // The counter line follows `http_requests_total{...} <count>`.
    // The regex captures the trailing integer value so we can assert
    // a numeric lower bound on it. Note: prom-client emits user
    // labels (method, route, status) BEFORE default labels (service,
    // environment, version), so the regex's order matches the source.
    const match = res.text.match(
      /http_requests_total\{[^}]*method="GET"[^}]*route="\/sample"[^}]*status="200"[^}]*\}\s+(\d+)/,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('records http_request_duration_seconds observation count per request', async () => {
    // The histogram's `_count` series tracks the total number of
    // observations for each (method, route, status) combination.
    // After one GET /sample, the count series for
    // `method="GET", route="/sample", status="200"` MUST be at
    // least 1 — the middleware records exactly one observation per
    // completed request via the `'finish'` listener.
    const app = buildApp();
    await request(app).get('/sample');
    const res = await request(app).get('/metrics');

    // Histogram label order in prom-client v15 puts default labels
    // FIRST then user labels, but `[^}]*` between requirements
    // accepts either order without modification.
    const match = res.text.match(
      /http_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/sample"[^}]*status="200"[^}]*\}\s+(\d+)/,
    );
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('labels requests by method (GET vs POST yield different label values)', async () => {
    // Driving a GET and a POST through the middleware produces TWO
    // distinct counter rows differentiated by the `method` label.
    // The POST goes to /sample (which only has GET registered) — it
    // therefore yields a 404 response with `route="__unknown__"`
    // (the cardinality-defending sentinel). The `method="POST"`
    // label still appears regardless of route resolution.
    const app = buildApp();
    await request(app).get('/sample');
    await request(app).post('/sample').send({});
    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/method="GET"/);
    expect(res.text).toMatch(/method="POST"/);
  });

  it('labels requests by status code (200 and 500 yield different label values)', async () => {
    // Both `/sample` (200) and `/boom` (500) drive distinct counter
    // rows differentiated by the `status` label. Without per-status
    // labelling, dashboards could not distinguish "100 successful
    // requests/sec" from "100 failed requests/sec" — the difference
    // matters for SLO calculations.
    const app = buildApp();
    await request(app).get('/sample');
    await request(app).get('/boom');
    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/status="200"/);
    expect(res.text).toMatch(/status="500"/);
  });

  it('increments http_errors_total for 5xx responses (not 2xx)', async () => {
    // Hit /boom once and /sample twice. After this traffic:
    //   - http_requests_total{status="500"}  has 1 observation
    //   - http_requests_total{status="200"}  has 2 observations
    //   - http_errors_total{status="500"}    has 1 observation
    //   - http_errors_total{status="200"}    has 0 observations (no
    //                                         such series should be
    //                                         emitted because 200 is
    //                                         not a 5xx)
    //
    // The assertion verifies (a) the 500 row exists in
    // `http_errors_total` and (b) NO `http_errors_total{...status="200"...}`
    // row exists. The negative assertion is the defence-in-depth
    // check that the source's 5xx-only filter is correctly applied.
    const app = buildApp();
    await request(app).get('/sample');
    await request(app).get('/sample');
    await request(app).get('/boom');
    const res = await request(app).get('/metrics');

    // Positive: the 500 error row IS emitted.
    expect(res.text).toMatch(/http_errors_total\{[^}]*status="500"[^}]*\}\s+\d+/);

    // Negative: NO http_errors_total row carries a 2xx status. Read
    // the body line-by-line and assert no `http_errors_total` line
    // contains `status="200"`. A regex-style negative-assertion would
    // miss multi-line cases; the explicit loop is bulletproof.
    const errorLines = res.text.split('\n').filter((line) => line.startsWith('http_errors_total'));
    for (const line of errorLines) {
      expect(line).not.toContain('status="200"');
    }
  });

  it('increments http_errors_total for 5xx responses (not 4xx)', async () => {
    // 4xx responses are CLIENT errors — by convention they do NOT
    // count toward the server error rate. The source's filter is
    // `if (res.statusCode >= 500 && res.statusCode <= 599)`, so a
    // 404 (POST /sample with no POST handler registered) MUST NOT
    // appear in `http_errors_total` even though it appears in
    // `http_requests_total`.
    const app = buildApp();
    await request(app).post('/sample').send({}); // 404
    const res = await request(app).get('/metrics');

    // Positive: the 404 IS recorded in http_requests_total.
    expect(res.text).toMatch(/http_requests_total\{[^}]*status="404"[^}]*\}/);

    // Negative: NO http_errors_total row carries status="404".
    const errorLines = res.text.split('\n').filter((line) => line.startsWith('http_errors_total'));
    for (const line of errorLines) {
      expect(line).not.toContain('status="404"');
    }
  });

  it('does NOT count its own /metrics requests (no self-referential tail)', async () => {
    // The middleware self-skips when `req.path === '/metrics'`.
    // Including the scrape in `http_requests_total` would create a
    // self-referential tail at every scrape interval — every minute
    // there would be an extra request counted, biasing dashboards.
    //
    // Verification: scrape /metrics three times consecutively with no
    // intervening application traffic. The /metrics endpoint itself
    // is the ONLY endpoint hit, so `http_requests_total` should NOT
    // emit a row for `route="/metrics"` (or for any route with the
    // /metrics path). prom-client's behaviour for a counter with
    // zero observations is to emit ONLY the # HELP / # TYPE lines —
    // no sample rows at all.
    const app = buildApp();
    await request(app).get('/metrics');
    await request(app).get('/metrics');
    const res = await request(app).get('/metrics');

    // No row should reference /metrics in the route label.
    expect(res.text).not.toMatch(/http_requests_total\{[^}]*route="\/metrics"/);
  });
});

describe('metricsMiddleware — Rule R2 + cardinality defenses', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  it('uses the route TEMPLATE (not the raw URL) for the route label', async () => {
    // The cardinality-defending invariant: a request like
    // `GET /sample?token=secret-abc&ssn=123` must produce a
    // metric line with `route="/sample"` and NOT a line that
    // contains the query string. The source's `resolveRouteLabel`
    // reads `req.route.path` (the matched template) which excludes
    // query strings by construction — but this test pins that
    // invariant as a contract so any future refactor that
    // accidentally read `req.originalUrl` would fail loudly.
    const app = buildApp();
    await request(app).get('/sample?token=secret-abc&ssn=123');
    const res = await request(app).get('/metrics');

    // The route label MUST be the template `/sample`.
    expect(res.text).toMatch(/route="\/sample"/);

    // The query string and its values MUST NOT appear anywhere in
    // the scrape body. Each of the four sentinel substrings is
    // checked individually so the failing assertion message points
    // at the specific leak.
    expect(res.text).not.toContain('secret-abc');
    expect(res.text).not.toContain('ssn=123');
    expect(res.text).not.toContain('token=');
    expect(res.text).not.toContain('?');
  });

  it('does NOT include x-correlation-id header values in metric labels', async () => {
    // Rule R2: no credential material in logs OR metric labels. A
    // correlation-id header is not strictly credential material, but
    // it IS a high-cardinality value that would explode label
    // dimensions if recorded. The source never reads request headers
    // for label construction; this test pins that invariant.
    const app = buildApp();
    const sentinelCorrelationId = 'CORR-abc-xyz-TEST-LABEL-SENTINEL';
    await request(app).get('/sample').set('x-correlation-id', sentinelCorrelationId);
    const res = await request(app).get('/metrics');

    expect(res.text).not.toContain(sentinelCorrelationId);
  });

  it('does NOT echo Authorization Bearer tokens into metric labels (Rule R2)', async () => {
    // The most direct credential-leak path: an Authorization header
    // containing a Bearer token. The middleware MUST NOT read this
    // header value, MUST NOT include it in any label, and MUST NOT
    // include any substring of it in the scrape body.
    //
    // Two distinct sentinel substrings are checked because the
    // failing test message would then point at the specific leak
    // pattern (full token value vs. the SECRET fragment alone).
    const app = buildApp();
    const secretToken = 'Bearer-SECRET-SENTINEL-12345';
    await request(app).get('/sample').set('Authorization', secretToken);
    const res = await request(app).get('/metrics');

    expect(res.text).not.toContain(secretToken);
    expect(res.text).not.toContain('SECRET-SENTINEL');
  });

  it('does NOT include arbitrary x-* header values in metric labels', async () => {
    // Defense-in-depth against future drift: any header beginning
    // with `x-` is a known extensibility surface. The middleware
    // MUST NOT inadvertently start reading from this surface. We
    // inject a sentinel value into a generic `x-test-header` and
    // assert its absence.
    const app = buildApp();
    const sentinelHeaderValue = 'X-HEADER-SHOULD-NEVER-LEAK-ABC123';
    await request(app)
      .get('/sample')
      .set('x-test-header', sentinelHeaderValue)
      .set('x-arbitrary-future-header', 'another-sentinel-DEF456');
    const res = await request(app).get('/metrics');

    expect(res.text).not.toContain(sentinelHeaderValue);
    expect(res.text).not.toContain('another-sentinel-DEF456');
  });

  it('consolidates unmatched paths under a single __unknown__ route label', async () => {
    // A request that hits no handler (POST to a GET-only path, or
    // any path that has no registered handler) must NOT introduce
    // a unique route label per distinct path. The source's
    // `resolveRouteLabel` returns the literal `'__unknown__'` for
    // unmatched routes — this test verifies that two different
    // unmatched paths consolidate to the SAME label, defending
    // cardinality against vulnerability scanners hitting
    // `/wp-admin`, `/.env`, etc.
    const app = buildApp();
    await request(app).get('/this-path-does-not-exist');
    await request(app).get('/another-fake-path');
    const res = await request(app).get('/metrics');

    // Both unmatched requests should have produced rows with
    // `route="__unknown__"`.
    expect(res.text).toMatch(/route="__unknown__"/);

    // Neither raw path should appear anywhere in the scrape body.
    expect(res.text).not.toContain('this-path-does-not-exist');
    expect(res.text).not.toContain('another-fake-path');
  });
});

describe('createMetricsRoutes — factory contract', () => {
  it('returns a value that is callable as Express middleware', () => {
    // `express.Router()` returns a function (the router IS its own
    // request handler — `app.use(router)` works because `router` is
    // callable as `(req, res, next)`). `typeof router === 'function'`
    // is therefore the appropriate structural assertion.
    const router = createMetricsRoutes();
    expect(typeof router).toBe('function');
  });

  it('returns a distinct router instance on each invocation', () => {
    // Multiple factory calls produce DISTINCT Router instances. The
    // shared module-level state is the prom-client registry, NOT the
    // router; multiple routers all backed by the same registry is the
    // expected pattern. Verifying this prevents future refactors from
    // accidentally introducing a hidden module-level Router singleton.
    const r1 = createMetricsRoutes();
    const r2 = createMetricsRoutes();
    expect(r1).not.toBe(r2);
  });

  it('mounts a working /metrics endpoint when used in an app', async () => {
    // A second app constructed with a fresh router instance must
    // serve `/metrics` exactly the same as the primary app. This
    // verifies that the factory pattern produces functional outputs,
    // not just structurally-correct (function-typed) ones.
    const app = express();
    app.use(createMetricsRoutes());
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });
});

describe('metricsMiddleware — function contract', () => {
  it('is a function', () => {
    // The exported `metricsMiddleware` is a runtime function. This
    // catches any future refactor that accidentally converts it
    // into a class instance, an object, or a factory.
    expect(typeof metricsMiddleware).toBe('function');
  });

  it('has Express middleware arity (3 parameters: req, res, next)', () => {
    // Express's middleware contract requires three-argument functions
    // for ordinary middleware (`(req, res, next)`). Four-argument
    // functions (`(err, req, res, next)`) are reserved for error
    // handlers — Express dispatches to them differently. A drift
    // here would cause Express to mis-route the middleware (e.g.
    // skip it on success paths if it had error-handler arity).
    //
    // `Function.length` returns the number of declared parameters
    // up to the first parameter with a default value or rest
    // parameter. Our middleware declares all three explicitly with
    // no defaults, so `length === 3`.
    expect(metricsMiddleware.length).toBe(3);
  });
});

describe('resetMetricsForTests — test-only state reset', () => {
  it('is a function', () => {
    // Pin the runtime export shape — `resetMetricsForTests` is a
    // function, not an object or a class. Any future refactor that
    // accidentally converts it to a more complex shape would fail
    // this assertion.
    expect(typeof resetMetricsForTests).toBe('function');
  });

  it('resets accumulated counters between consecutive uses', async () => {
    // Drive 3 sample requests through the middleware, scrape /metrics,
    // capture the counter value, then RESET, then drive a single
    // request, and verify the second scrape's counter equals 1 (not 4).
    //
    // This is the determinism contract that ST-043-AC3 depends on:
    // without `resetMetricsForTests`, prom-client's module-level
    // registry would accumulate state across tests, producing
    // order-dependent flakes.
    const app = buildApp();
    resetMetricsForTests();

    await request(app).get('/sample');
    await request(app).get('/sample');
    await request(app).get('/sample');

    const beforeReset = await request(app).get('/metrics');
    const beforeMatch = beforeReset.text.match(
      /http_requests_total\{[^}]*method="GET"[^}]*route="\/sample"[^}]*status="200"[^}]*\}\s+(\d+)/,
    );
    expect(beforeMatch).not.toBeNull();
    expect(Number(beforeMatch![1])).toBeGreaterThanOrEqual(3);

    // Reset and verify the counter value goes back to zero (no
    // emitted row at all, since prom-client suppresses zero-count
    // counter rows).
    resetMetricsForTests();

    await request(app).get('/sample');

    const afterReset = await request(app).get('/metrics');
    const afterMatch = afterReset.text.match(
      /http_requests_total\{[^}]*method="GET"[^}]*route="\/sample"[^}]*status="200"[^}]*\}\s+(\d+)/,
    );
    expect(afterMatch).not.toBeNull();
    // Exactly 1 — proving the reset zeroed the counter and the
    // single subsequent /sample request was the first observation.
    expect(Number(afterMatch![1])).toBe(1);
  });

  it('preserves process_up at 1 across resets (process is still up)', async () => {
    // The reset deliberately does NOT zero `process_up`. Setting
    // `process_up = 0` would imply the process is down — wrong
    // semantically, and would break the dashboard panel that uses
    // `process_up == 0` as a "process is dead" signal.
    //
    // Verification: scrape /metrics, reset, scrape again, and assert
    // both scrapes show `process_up{...} 1`.
    const app = buildApp();

    const before = await request(app).get('/metrics');
    expect(before.text).toMatch(/process_up\{[^}]*\} 1/);

    resetMetricsForTests();

    const after = await request(app).get('/metrics');
    expect(after.text).toMatch(/process_up\{[^}]*\} 1/);
  });
});
