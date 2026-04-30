/**
 * Prometheus metrics endpoint and request-recording middleware — ST-048.
 *
 * This module is the single backend touch-point for application-level
 * Prometheus metrics. It exports three symbols:
 *
 *   - `metricsMiddleware`        — Express middleware. Attached at the
 *                                  COMPOSITION ROOT (before any routes)
 *                                  so every inbound request increments
 *                                  the request counter and records its
 *                                  duration into the histogram. Request
 *                                  paths to `/metrics` itself are skipped
 *                                  to avoid self-referential counting.
 *   - `createMetricsRoutes()`    — Factory returning an `express.Router`
 *                                  with `GET /metrics` mounted at root.
 *                                  The handler serializes the module-
 *                                  scoped registry into the standard
 *                                  Prometheus text-exposition format
 *                                  (`text/plain; version=0.0.4; charset=
 *                                  utf-8`) and 200-responds with the
 *                                  body. On serialization error the
 *                                  handler delegates to `next(err)` per
 *                                  Rule R8 (fail-closed; never silent).
 *   - `resetMetricsForTests()`   — Test-only helper that resets the
 *                                  values of the four application
 *                                  metrics defined here. Production
 *                                  callers MUST NOT use it; the export
 *                                  exists solely so unit tests can run
 *                                  in a deterministic order without one
 *                                  test's emissions leaking into the
 *                                  next test's assertions.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - AAP §0.3.3 New Files to Create — Backend:
 *       "`backend/src/routes/metrics.ts` — `/metrics` Prometheus text
 *        format: `http_requests_total` counter,
 *        `http_request_duration_seconds` histogram, `process_up` gauge
 *        with `service`/`environment`/`version` labels (ST-048)".
 *   - AAP §0.6.5 Track 1 / Gate T1-D verification:
 *       `curl -sf localhost:3000/metrics | grep http_requests_total`
 *       (expected: match found).
 *   - AAP §0.6.5 ST-048-AC1 (verbatim): "Metrics endpoint emits
 *     prescribed set (request counts, error counts, latency histogram,
 *     process liveness) in Prometheus text format".
 *   - AAP §0.6.5 ST-048-AC2 (verbatim): "Every metric carries service,
 *     environment, version labels".
 *   - Story ST-048-AC1 (verbatim): "Each service exposes a metrics
 *     endpoint at a documented path that serves service-level metrics
 *     typed as explicit primitives — a request rate counter, an error
 *     rate counter, a request latency histogram, and a process-up gauge
 *     are the baseline set — in a technology-neutral text format
 *     suitable for scraping."
 *   - Story ST-048-AC2 (verbatim): "Every emitted metric carries at
 *     minimum a service label, an environment label, and a version
 *     label so that metrics are dimensioned consistently across
 *     deployments and can be filtered and aggregated by service,
 *     environment, and version."
 *
 * Cross-cutting rule compliance:
 *
 *   - Rule R1 — story acceptance criteria authoritative: emits exactly
 *     the four metric primitives ST-048-AC1 names (`http_requests_total`,
 *     `http_errors_total`, `http_request_duration_seconds`,
 *     `process_up`). Every emitted metric carries the three baseline
 *     labels ST-048-AC2 names via `setDefaultLabels` on the registry.
 *
 *   - Rule R2 — no credentials in logs/labels: the route label resolver
 *     extracts the matched Express ROUTE TEMPLATE (e.g.
 *     `/api/designs/:id`) from `req.route.path` rather than the raw URL
 *     `req.originalUrl` or `req.url`. Query strings, path parameter
 *     values, and any incidental credentials in those values therefore
 *     NEVER appear in metric labels — the templating is structural and
 *     defends against accidental credential leaks via cardinality.
 *
 *   - Rule R3, R4, R5, R9 — N/A. This module is cross-cutting
 *     observability infrastructure; it does not call Firebase Admin,
 *     does not read the six required env vars, does not call GCS, and
 *     does not handle payments. The module-level constants below
 *     (SERVICE_NAME, ENVIRONMENT, VERSION) read NON-required metadata
 *     env vars with documented operational defaults — these are NOT
 *     part of Rule R4's six (DATABASE_URL, FIREBASE_PROJECT_ID,
 *     GCS_BUCKET_NAME, GCS_EMULATOR_HOST, COVERAGE_THRESHOLD,
 *     GCP_REGION). See `backend/src/config/env.ts` for the canonical
 *     Rule R4 list.
 *
 *   - Rule R6 — OTel registration order: this module is loaded AFTER
 *     `import './tracing'` in `backend/src/index.ts`, so the prom-
 *     client `Registry` and the OTel auto-instrumentations co-exist
 *     without overlap. We use a CUSTOM `Registry` (not prom-client's
 *     global default) so the OTel host-metrics instrumentation cannot
 *     accidentally double-register entries onto our scrape endpoint.
 *
 *   - Rule R8 — gates fail closed: if `registry.metrics()` throws
 *     (extremely rare; practically only happens if a metric label
 *     mapping is corrupted) the route handler forwards the error to
 *     Express's central error handler via `next(err)` rather than
 *     swallowing it. The error handler then responds with 500. A
 *     silent success on a metrics serialization failure is impossible.
 *
 * Architectural rationale:
 *
 *   The module-scoped singleton pattern is the IDIOMATIC prom-client
 *   shape: one `Registry`, four metric instances, registered once at
 *   module load. The two exported entry points (`metricsMiddleware`
 *   and `createMetricsRoutes`) close over the same registry — this is
 *   what guarantees that a request counted by the middleware is
 *   serialized by the next `/metrics` scrape.
 *
 *   We use our OWN registry (`new Registry()`) instead of prom-client's
 *   global default so that:
 *     1. The OTel auto-instrumentation (which may register its own
 *        host metrics into the global default registry) does not
 *        pollute our scrape output with metrics we did not explicitly
 *        opt into.
 *     2. Tests can assert against a known-good metric set without
 *        worrying about whatever any other test or import side-effect
 *        might have appended to a process-wide singleton.
 *     3. The exposition output is reproducible and small, making
 *        `grep`-based gate verification (Gate T1-D) trivial.
 *
 *   The explicit `httpErrorsTotal` 5xx-only counter, instead of a
 *   derived series like `http_requests_total{status=~"5.."}`, is a
 *   concession to alerting simplicity: many alerting systems can
 *   threshold on a flat counter rate but not on a regex-filtered
 *   subset, and the user-provided Observability Rule names "error
 *   rate" as a first-class panel for the dashboard template.
 *
 *   The histogram bucket set [5ms, 10ms, 25ms, 50ms, 100ms, 250ms,
 *   500ms, 1s, 2.5s, 5s, 10s] follows standard SRE practice: dense at
 *   the sub-perceptible end (≤100ms) where most successful API calls
 *   land, sparser at the long tail where timeout territory begins.
 *   These buckets give P50, P95, and P99 estimates accurate to within
 *   one bucket boundary across the full request-duration range
 *   relevant to a configurator API.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import * as promClient from 'prom-client';

// ---------------------------------------------------------------------------
// Module-scoped identity constants — applied as DEFAULT LABELS on every
// metric registered with the local registry below.
// ---------------------------------------------------------------------------
//
// These three values are read once at module-load time from non-required
// metadata env vars. They are NOT part of Rule R4's six required vars (those
// throw when unset; see `backend/src/config/env.ts`); they are observational
// metadata where a documented default is strictly more useful than a fatal
// startup error.
//
// The fallback values are chosen to MIRROR EXACTLY the same fallbacks in
// `backend/src/tracing.ts` — the OTel `Resource` attached to spans uses
// identical `service.name` / `service.version` / `deployment.environment`
// values. This dimensional alignment is the cardinal property that makes
// trace-metric correlation work in dashboards: a `service` label on a
// metric can be joined against a `service.name` attribute on a span without
// any value translation.
//
// ENVIRONMENT defaults to `'development'` to match the broadly-followed
// convention that a process started without `NODE_ENV` is assumed to be in
// a dev / debug posture; production deploys explicitly set NODE_ENV.
//
// VERSION reads `SERVICE_VERSION` first (set by Cloud Build during the
// MG2-G build step from the package.json `version` field) and falls back
// to `COMMIT_SHA` (set by Cloud Build from the build's source revision).
// If neither is set — typically only in a from-source local invocation —
// we use the literal `'unknown'`. A metric tagged `version=unknown` is
// strictly more useful than a process that refuses to emit any metrics.

const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';
const ENVIRONMENT = process.env['NODE_ENV'] ?? 'development';
const VERSION = process.env['SERVICE_VERSION'] ?? process.env['COMMIT_SHA'] ?? 'unknown';

/**
 * Default labels applied by `registry.setDefaultLabels` to EVERY metric
 * sample emitted from this module. These are the three labels mandated by
 * ST-048-AC2 ("Every metric carries service, environment, version labels").
 *
 * Defining them as a typed `const` (rather than passing the inline object
 * to `setDefaultLabels`) allows tests to assert the exact label set
 * without re-deriving it.
 */
const DEFAULT_LABELS: Readonly<Record<'service' | 'environment' | 'version', string>> = {
  service: SERVICE_NAME,
  environment: ENVIRONMENT,
  version: VERSION,
};

// ---------------------------------------------------------------------------
// Singleton registry + metric instances.
// ---------------------------------------------------------------------------
//
// `new promClient.Registry()` creates a fresh, isolated registry. We do NOT
// use prom-client's global default registry (`promClient.register`) because
// shared global state across imports is an anti-pattern in this codebase:
//   - tests cannot reliably reset state without affecting unrelated modules
//   - the OTel auto-instrumentation may register host metrics into the
//     global default at startup, polluting the application scrape output
//   - the global registry is a hidden coupling — explicit constructor
//     wiring makes the metric set an obvious feature of this module
//
// The registry is captured in the module closure so both the middleware
// and the route handler reference the SAME instance. Counter increments
// from the middleware are observable via the route handler's serialization
// in the next scrape.

const registry = new promClient.Registry();
registry.setDefaultLabels(DEFAULT_LABELS);

// Default process-level metrics: event-loop lag, GC pause time, RSS, heap
// usage, file descriptor count, CPU usage. prom-client v15 exposes these
// as a bundle through `collectDefaultMetrics`. They are a well-understood
// set of SRE-relevant signals and including them in our scrape output is
// the standard expectation for any Node service.
//
// The `register: registry` argument routes the default metrics into OUR
// custom registry (not the global default). This is critical: without it
// the default metrics would be emitted by `promClient.register.metrics()`
// (the global default) but NOT by `registry.metrics()` (our custom one).

promClient.collectDefaultMetrics({ register: registry });

/**
 * Counter — `http_requests_total`.
 *
 * Incremented by `metricsMiddleware` exactly once per response,
 * partitioned by `method`, `route` (template), and `status` (the actual
 * status code emitted by Express, captured via the `res.on('finish')`
 * hook so error-handler-applied status codes are reflected).
 *
 * The label cardinality is bounded by:
 *   - `method`  : a closed set of HTTP verbs (GET / POST / PUT / DELETE /
 *                 PATCH / HEAD / OPTIONS) — 7 values max
 *   - `route`   : the matched Express route template, NOT the raw URL.
 *                 See `resolveRouteLabel` below for the cardinality
 *                 defense rationale.
 *   - `status`  : a closed set of HTTP status codes — 60-ish values in
 *                 practice
 *
 * Combined with the three default labels (service / environment /
 * version), the upper bound on series count for this counter is
 * approximately:
 *   1 service * 3 environments * unbounded versions *
 *   7 methods * routes * 60 statuses
 *
 * In a typical deployment this is on the order of a few thousand series,
 * which is well within Prometheus's healthy operating range.
 */
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled by the backend, partitioned by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/**
 * Counter — `http_errors_total`.
 *
 * Incremented by `metricsMiddleware` for every 5xx response. Per
 * standard monitoring convention only server-side errors are counted as
 * "errors"; 4xx responses are client-side and can be reconstructed by
 * filtering `http_requests_total` on `status=~"4.."` if needed.
 *
 * This counter exists as a first-class series (rather than a derived
 * one) because:
 *   1. ST-048-AC1 explicitly names "error rate counter" alongside the
 *      request rate counter — implementation parity with the spec.
 *   2. Many alerting systems (Cloud Monitoring, Prometheus alertmanager)
 *      can express thresholds on a flat counter rate but cannot express
 *      a regex-filtered subset of another counter. Exposing the 5xx
 *      counter directly simplifies the alert policy definitions in
 *      `docs/observability/dashboard-template.md`.
 *   3. The user-provided Observability Rule names "error rate" as a
 *      first-class panel; the dashboard template aligns with this name.
 */
const httpErrorsTotal = new promClient.Counter({
  name: 'http_errors_total',
  help: 'Total HTTP responses with a 5xx status code, partitioned by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

/**
 * Histogram — `http_request_duration_seconds`.
 *
 * Observed by `metricsMiddleware` once per response, with the duration
 * measured from the moment the middleware ran (i.e. before any
 * downstream handler executed) to the moment Express emitted the
 * response's `'finish'` event. Buckets are explicit (no auto-bucketing)
 * to ensure dashboards can compute consistent quantile estimates across
 * deployments and over time.
 *
 * Bucket boundary rationale:
 *   - 5ms / 10ms / 25ms : sub-perceptible. Healthy in-memory or warm
 *                         cache responses. P50 of GET /healthz lives
 *                         here.
 *   - 50ms / 100ms      : single-roundtrip database queries. P50 of
 *                         GET /api/designs/:id lives here.
 *   - 250ms / 500ms     : multi-roundtrip or composite operations.
 *                         P95 of POST /api/designs lives around here.
 *   - 1s                : the user-perceptible threshold for "feeling
 *                         slow". P99 of healthy backends should NOT
 *                         exceed this regularly.
 *   - 2.5s / 5s         : long-tail territory. Most well-tuned APIs
 *                         have <0.1% of traffic in these buckets.
 *   - 10s               : timeout territory. Anything in this bucket
 *                         is likely to be a stuck request that should
 *                         have been killed by a timeout middleware.
 *
 * The `+Inf` bucket is added automatically by prom-client and accounts
 * for any duration exceeding 10s — these are visible as
 * `http_request_duration_seconds_bucket{le="+Inf"}` in the scrape
 * output.
 */
const httpRequestDurationSeconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, partitioned by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Gauge — `process_up`.
 *
 * Constant `1` while the process is alive and serving. Set once at
 * module load (below) and reset to `1` by `resetMetricsForTests` so
 * test isolation is preserved.
 *
 * The gauge's purpose is "instance up?" alerting: a Prometheus
 * `absent()` or `up{job="strikeforge-backend"} == 0` alert fires when
 * scrapes fail because the process is no longer responding. This gives
 * an immediate, dimensionless signal of liveness alongside the more
 * detailed health probes in `routes/health.ts`.
 *
 * Setting it to `1` once at module load is deliberately the only
 * mutation in production code: there is no path that sets it to `0`,
 * because the process being dead is precisely the condition under
 * which the metric becomes unobservable (the scrape fails). The
 * dashboard panel built from this metric checks `absent_over_time` or
 * `up == 0`, not `process_up == 0`.
 */
const processUp = new promClient.Gauge({
  name: 'process_up',
  help: 'Process liveness gauge; held at 1 while the process is serving.',
  registers: [registry],
});

processUp.set(1);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Express ROUTE TEMPLATE for use as a metric label.
 *
 * Why template, not raw URL?
 *   - Raw URLs (`req.originalUrl`, `req.url`) embed user-controlled path
 *     parameters and query strings. For a route like
 *     `GET /api/designs/:id`, every unique `:id` value (typically a
 *     UUID) would create a brand new metric series. A million distinct
 *     designs implies a million distinct series — Prometheus's series
 *     cardinality budget would be exhausted within a single dashboard
 *     refresh.
 *   - Query strings can contain credentials, search terms, and PII.
 *     The TEMPLATE strips all of these by definition: the `:id` segment
 *     is the same string regardless of which design the user is
 *     accessing, and query strings are absent from `req.route.path`.
 *
 * When does Express populate `req.route`?
 *   - AFTER routing has matched a handler. Our middleware is registered
 *     globally (before routes), but the timer in `metricsMiddleware`
 *     fires on the response's `'finish'` event — by which time the
 *     handler that produced the response has already been matched (or
 *     not), so `req.route` reflects the match outcome.
 *   - For 404 / 405 / unmatched paths, Express never sets `req.route`,
 *     so we return the sentinel `'__unknown__'` to consolidate every
 *     unmatched path under a single label value. This is the second
 *     line of cardinality defense: scanners hitting `/wp-admin`,
 *     `/.env`, `/admin.php`, etc. would otherwise each be unique
 *     labels.
 *
 * Why concatenate `req.baseUrl` with `req.route.path`?
 *   - Routers mounted under a path prefix (e.g. `app.use('/api',
 *     designsRouter)`) populate `req.route.path` with only the
 *     SUB-route (`/:id`), not the full path. Prepending `req.baseUrl`
 *     restores the full template (`/api/:id`). This is critical for
 *     readability of the metric labels and for a dashboard panel that
 *     filters on `route="/api/..."`.
 *
 * @param req - The Express request, after routing has run.
 * @returns The matched route template (e.g. `/api/designs/:id`), or
 *          `'__unknown__'` if no route was matched.
 */
function resolveRouteLabel(req: Request): string {
  // The narrow, defensive cast surfaces only the two fields we need
  // (`route?.path?` and `baseUrl?`) without trusting Express's full
  // `Request` shape. We can't simply `req.route.path` because the
  // `Request` type's `route` is typed as `any` in older `@types/express`
  // versions, which would lock us out of strict null checks.
  const matched = (req as Request & { route?: { path?: string } }).route;
  if (matched !== undefined && matched !== null && typeof matched.path === 'string') {
    const baseUrl = (req as Request & { baseUrl?: string }).baseUrl ?? '';
    return normalizeRouteLabel(`${baseUrl}${matched.path}`);
  }
  // Express never matched a route; consolidate under a single label.
  return '__unknown__';
}

/**
 * Normalize a route template for use as a metric label.
 *
 * The two normalizations are:
 *   1. Collapse runs of `/` into a single `/`. This handles the rare
 *      case where `req.baseUrl` ends with a `/` and `req.route.path`
 *      starts with a `/`, producing `//api//designs` if naively
 *      concatenated. The collapse normalizes that to `/api/designs`.
 *   2. Remove a trailing `/`. Express's matcher treats `/api` and
 *      `/api/` as the same route, but they would emit different label
 *      values without normalization, splitting the same logical route
 *      across two metric series.
 *
 * The empty-string fallback (after both replacements remove
 * everything) returns `'/'` so the root path's label is non-empty.
 * Practically the input is never empty, but the defensive return makes
 * the function total.
 *
 * @param path - The concatenated `baseUrl + route.path` string.
 * @returns A canonical route label.
 */
function normalizeRouteLabel(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Express middleware that records request count, error count, and
 * duration histogram for every inbound HTTP request.
 *
 * Composition order:
 *   The composition root in `backend/src/index.ts` mounts this as a
 *   GLOBAL middleware (i.e. `app.use(metricsMiddleware)`) BEFORE any
 *   route. The placement matters because:
 *     - It must run before routing so that the duration timer starts
 *       before any handler logic.
 *     - It must capture the matched route template, which requires
 *       Express's routing layer to have run by the time the
 *       `'finish'` event fires (it has, by definition: the response
 *       cannot finish before the handler runs).
 *
 * Self-skip:
 *   Requests to `/metrics` are deliberately skipped so that the scrape
 *   endpoint does not count itself. Including the scrape in the request
 *   counter creates a misleading self-referential tail at scrape
 *   intervals that obscures the application traffic signal.
 *
 * Timing precision:
 *   `process.hrtime.bigint()` returns a nanosecond-precision monotonic
 *   timestamp. Subtracting two readings yields the elapsed wall-clock
 *   time without susceptibility to system clock adjustments (NTP,
 *   DST). We convert to seconds at the end (`/ 1e9`) so the histogram
 *   is in the same unit as the bucket boundaries.
 *
 * Labelling:
 *   - `method` : the HTTP method, uppercased so `'GET'` and `'get'`
 *                are not treated as different labels (RFC 7230 says
 *                methods are case-sensitive in the wire protocol, but
 *                Express normalizes inbound methods).
 *   - `route`  : the matched template (see `resolveRouteLabel`).
 *   - `status` : the actual status code emitted to the client,
 *                stringified for label use. The status reflects any
 *                error-handler-applied transformation since we read
 *                it inside the `'finish'` hook.
 *
 * Error counter:
 *   Incremented only when `res.statusCode` is in [500, 599]. Every 5xx
 *   is also counted by `http_requests_total`, so the error rate can be
 *   computed both ways: directly from `http_errors_total` or as a ratio
 *   of `http_errors_total / http_requests_total` partitioned by route.
 *
 * @param req  - Inbound Express request.
 * @param res  - Outbound Express response.
 * @param next - Continuation function. Called synchronously after the
 *               timer is registered.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip the scrape endpoint to avoid self-referential counting. We
  // check `req.path` (which strips query strings and base URL) rather
  // than `req.url` so a query string like `/metrics?compress=true`
  // would also be skipped.
  if (req.path === '/metrics') {
    next();
    return;
  }

  // Capture the request start. `hrtime.bigint()` is monotonic and
  // unaffected by system clock adjustments, so the elapsed duration
  // stays correct even if the wall clock changes mid-request.
  const start = process.hrtime.bigint();

  // The `'finish'` event fires when the response headers AND body have
  // been flushed to the network. By the time this handler runs:
  //   - Express's routing has matched (if any handler matched), so
  //     `req.route.path` is populated for `resolveRouteLabel`.
  //   - `res.statusCode` reflects any error-handler transformation.
  //   - The duration is the full request-to-response wall time.
  //
  // The handler is synchronous and self-contained — no `await`, no
  // external resources, no exceptions thrown into the listener. Even
  // though listener errors can technically crash a Node process, the
  // operations below (counter increment, histogram observation) are
  // pure in-memory state mutations on prom-client's data structures
  // that throw only on input-validation errors, which we cannot
  // produce from this code path because `labelNames` is a closed set.
  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    // BigInt -> Number conversion is safe here because durations
    // exceeding 2^53 ns (~104 days) are well outside any sensible
    // request lifetime; a request that long would be a defect.
    const durationSeconds = Number(durationNs) / 1e9;

    const method = req.method.toUpperCase();
    const status = String(res.statusCode);
    const route = resolveRouteLabel(req);

    httpRequestsTotal.inc({ method, route, status }, 1);
    httpRequestDurationSeconds.observe({ method, route, status }, durationSeconds);

    // 5xx-only error counter. The closed range [500, 599] covers every
    // RFC 7231 server-error class (and HTTP/2's WebDAV extensions) and
    // explicitly excludes the 4xx client-error range. The 599 upper
    // bound is generous; the IANA registry currently tops out at 511.
    if (res.statusCode >= 500 && res.statusCode <= 599) {
      httpErrorsTotal.inc({ method, route, status }, 1);
    }
  });

  // Synchronous continuation — the timer above runs in the background
  // when the response finishes. Calling `next()` here releases the
  // request to the next middleware in the chain.
  next();
}

/**
 * Build the Express `Router` exposing the Prometheus scrape endpoint.
 *
 * The router has a single route: `GET /metrics`. The composition root
 * mounts this router at the application ROOT (i.e. `app.use(router)`),
 * so the final URL is `/metrics`.
 *
 * Response shape:
 *   - 200 + Prometheus text-exposition body on success.
 *   - 5xx via Express's central error handler if `registry.metrics()`
 *     throws (extremely rare; only happens when prom-client's internal
 *     state is corrupted, which is a programming defect, not a runtime
 *     condition).
 *
 * Content-Type:
 *   `registry.contentType` is `text/plain; version=0.0.4;
 *   charset=utf-8` — the canonical Prometheus exposition header.
 *   Setting it explicitly rather than letting Express infer
 *   `text/html` from the body's content guarantees that scrapers parse
 *   the response correctly.
 *
 * Why an async handler that catches into `next(err)`?
 *   - `registry.metrics()` returns a `Promise<string>` because newer
 *     prom-client versions support async metric collectors. Awaiting
 *     it inside an Express handler requires either `async`/`await` or
 *     `.then()`/`.catch()`. We use `async`/`await` for readability.
 *   - The repository's `@typescript-eslint/no-misused-promises` and
 *     `@typescript-eslint/no-floating-promises` rules require async
 *     route handlers to either return a Promise to a Promise-aware
 *     consumer (Express does NOT consume Promises from handlers) or
 *     handle errors via `next(err)`. The try/catch around the await
 *     ensures every error path is funnelled through Express's error
 *     handler — Rule R8 fail-closed.
 *
 * Why no `_req: Request` consumption?
 *   - The scrape endpoint does not interpret request headers, query
 *     strings, or path parameters. Anything we read from `req` would
 *     be a label-cardinality risk (see `resolveRouteLabel`'s
 *     rationale). Discarding `req` via the `_req` underscore
 *     convention is intentional and is allowed by the project's
 *     `@typescript-eslint/no-unused-vars` rule (`argsIgnorePattern:
 *     "^_"`).
 *
 * @returns An `express.Router` ready to be mounted at the application
 *          root via `app.use(router)`.
 */
export function createMetricsRoutes(): Router {
  const router = Router();

  // Implemented as a non-async outer handler that delegates to an async
  // worker. This keeps the handler signature aligned with Express's
  // `void`-returning `RequestHandler` type (and with the project's
  // `@typescript-eslint/no-misused-promises` rule), while preserving the
  // readability of `await` inside the worker. Any error thrown by the
  // worker — including rejection of `registry.metrics()` — is forwarded
  // to Express's central error handler via `next(err)` per Rule R8.
  // This is the same idiom used in `routes/health.ts` for `/readyz`.
  router.get('/metrics', (_req: Request, res: Response, next: NextFunction): void => {
    void handleMetricsScrape(res).catch((err: unknown) => {
      // Rule R8: fail closed. Forward to Express's central error
      // handler, which logs via the redacting pino logger (Rule R2)
      // and responds 500. There is NO silent-success path here.
      next(err);
    });
  });

  return router;
}

/**
 * Async worker for the `/metrics` scrape endpoint.
 *
 * Serializes the module-scoped registry into the Prometheus text
 * exposition format and writes the response. Separated from the route
 * handler so the route handler itself can have a synchronous,
 * `void`-returning signature compatible with Express's
 * `RequestHandler` contract — see `createMetricsRoutes` for rationale.
 *
 * Rejection semantics:
 *   This function rejects only if `registry.metrics()` rejects, which
 *   in prom-client v15 happens only on extremely rare internal
 *   errors (e.g. a custom collector throwing). Any rejection is
 *   propagated to the caller, which forwards it to Express's central
 *   error handler.
 *
 * @param res - The Express response. The function sets the
 *              `Content-Type` header BEFORE invoking `res.send()` so
 *              scrapers parse the body correctly.
 */
async function handleMetricsScrape(res: Response): Promise<void> {
  // The Content-Type header MUST be set BEFORE the body is sent.
  // Setting it after `res.send()` is a no-op (headers have already
  // been flushed). Express's `res.set()` mutates the pending
  // response headers; the actual flush happens at the start of
  // `res.send()`.
  res.set('Content-Type', registry.contentType);
  const body = await registry.metrics();
  res.status(200).send(body);
}

/**
 * Reset the values of the four module-level application metrics.
 *
 * INTENDED FOR TEST USE ONLY. Production callers MUST NOT invoke this
 * function — it would erase real telemetry mid-flight and produce
 * misleading dashboard data.
 *
 * Why expose it as a named export?
 *   - Jest unit tests for this module (and integration tests that
 *     assert against `/metrics` output) need to start each test from a
 *     known baseline. Without this helper, the counter value of
 *     `http_requests_total` would carry over between tests, breaking
 *     order-independence (ST-043-AC3: "repeated runs produce the same
 *     verdict").
 *   - The alternative — clearing the registry entirely with
 *     `registry.clear()` — would deregister our metric instances from
 *     the registry, breaking subsequent emissions until the module is
 *     re-imported. Per-metric `.reset()` is the correct primitive for
 *     test isolation.
 *
 * What is reset?
 *   - `httpRequestsTotal.reset()` — counter back to 0 for every label
 *     combination.
 *   - `httpErrorsTotal.reset()` — same.
 *   - `httpRequestDurationSeconds.reset()` — bucket counts and sum
 *     back to 0 for every label combination.
 *   - `processUp.set(1)` — gauge back to its initial 1 (a `.reset()`
 *     on a Gauge would set it to 0, which would imply the process is
 *     down — wrong semantically).
 *
 * What is NOT reset?
 *   - The default process metrics emitted by `collectDefaultMetrics`.
 *     Those are sampled live from the process at scrape time, so
 *     "resetting" them is meaningless — they reflect the live state
 *     of the running process regardless of what tests have done.
 *   - The registry's default labels. Those are configured at module
 *     load and are constant across the process's lifetime.
 */
export function resetMetricsForTests(): void {
  httpRequestsTotal.reset();
  httpErrorsTotal.reset();
  httpRequestDurationSeconds.reset();
  processUp.set(1);
}
