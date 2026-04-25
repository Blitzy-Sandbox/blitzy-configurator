/**
 * Prometheus metrics endpoint.
 *
 * Per ST-048-AC2: GET /metrics returns the Prometheus text exposition
 * format — `Content-Type: text/plain; version=0.0.4; charset=utf-8`.
 * The endpoint MUST expose:
 *   - `http_requests_total` (counter) labelled by method, route, and
 *     status code
 *   - `http_request_duration_seconds` (histogram) labelled the same
 *   - `process_up` (gauge) — value is 1 while the process is alive
 *   - prom-client's default Node.js metrics (event-loop lag, GC
 *     pauses, RSS, heap, file-descriptor count, etc.)
 *
 * Every metric carries the constant labels `service`, `environment`,
 * and `version` per ST-048-AC2 so multi-tenant scrapers (Cloud
 * Monitoring, Prometheus, Grafana) can join a single metrics stream
 * across deploys.
 *
 * The middleware factory `metricsMiddleware()` increments the request
 * counter and observes the duration histogram for every inbound HTTP
 * request. It deliberately reads `req.route?.path` rather than
 * `req.path` so cardinality stays bounded — `/api/users/:id` becomes
 * one label value, not one per id.
 */

import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

export interface MetricsBundle {
  /** Prom-client registry holding every metric. */
  registry: Registry;
  /** Express middleware that records request count and duration. */
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /** Express router that serves /metrics in the Prometheus text format. */
  router: Router;
}

export interface CreateMetricsOptions {
  service: string;
  environment: string;
  version: string;
}

/**
 * Builds the metrics bundle: registry, request-recording middleware,
 * and the /metrics route handler.
 *
 * The bundle is constructed once at process startup. The default
 * metrics collector uses the singleton timer registered by
 * `collectDefaultMetrics`; calling this function more than once would
 * register duplicate collectors, so callers MUST cache the returned
 * bundle.
 */
export function createMetrics(options: CreateMetricsOptions): MetricsBundle {
  const registry = new Registry();
  registry.setDefaultLabels({
    service: options.service,
    environment: options.environment,
    version: options.version,
  });

  // Default metrics: event-loop lag, GC pauses, heap, RSS, file
  // descriptors, etc. Sampled every 10 seconds (prom-client default).
  collectDefaultMetrics({ register: registry });

  // Liveness gauge — `process_up == 1` while the metrics endpoint
  // is being scraped. Useful for "instance up?" alerting.
  const processUp = new Gauge({
    name: 'process_up',
    help: 'Indicates that the process is up; constant 1 while running.',
    registers: [registry],
  });
  processUp.set(1);

  // Request counter — labelled by method, route, and status code so
  // dashboards can break down request rate by endpoint and outcome.
  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Count of HTTP requests handled by the backend.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  // Duration histogram — buckets chosen for typical Node.js HTTP
  // workloads (5ms..10s) so dashboards can compute P50/P95/P99
  // without resampling.
  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  // Errors counter — convenience aggregate of 5xx responses for
  // alert-policy thresholds (ST-049-AC5 dashboard panel).
  const httpErrorsTotal = new Counter({
    name: 'http_errors_total',
    help: 'Count of HTTP responses with a 5xx status code.',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  /**
   * Express middleware: records request count and duration for
   * every response. Uses `res.on('finish')` so the actual status
   * code (after error handlers) is captured.
   */
  function middleware(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint();

    res.on('finish', () => {
      // Prefer the matched route path so cardinality stays bounded.
      // Fall back to the request URL only if no route matched (e.g.
      // a 404 for an unknown path) — these accumulate under the
      // single label "unmatched" rather than one label per URL.
      const matchedRoute = (req as Request & { route?: { path?: string } }).route?.path;
      const route = typeof matchedRoute === 'string' ? matchedRoute : 'unmatched';
      const status = String(res.statusCode);
      const labels = { method: req.method, route, status_code: status };

      httpRequestsTotal.inc(labels);
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      httpRequestDurationSeconds.observe(labels, durationSeconds);
      if (res.statusCode >= 500) {
        httpErrorsTotal.inc(labels);
      }
    });

    next();
  }

  const router = Router();
  router.get('/metrics', (_req: Request, res: Response): void => {
    registry
      .metrics()
      .then((body: string) => {
        res.setHeader('Content-Type', registry.contentType);
        res.status(200).send(body);
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : 'metrics collection failed';
        res.status(500).json({ error: reason });
      });
  });

  return { registry, middleware, router };
}
