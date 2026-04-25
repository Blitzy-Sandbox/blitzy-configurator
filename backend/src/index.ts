// IMPORTANT: `./tracing` MUST be the very first import in this file
// per Rule R6 / Constraint C4. The OpenTelemetry auto-instrumentations
// monkey-patch pg / http / express at module-load time, so any earlier
// import (including a side-effect-only require()) would result in
// missing or duplicated spans. Do NOT reorder this import.
import './tracing';

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';

import { requireEnv, validateEnv } from './config/env';
import { createLogger } from './logging/pino';
import { correlationMiddleware, correlationStore } from './middleware/correlation';
import { createHealthRoutes } from './routes/health';
import { createMetrics } from './routes/metrics';

/**
 * Pino mixin that reads the active `CorrelationContext` from the
 * `correlationStore` AsyncLocalStorage and emits its `correlationId`
 * (and `uid` when present) on every log record.
 *
 * This function is defined HERE (not in `./middleware/correlation`)
 * because the correlation module is the FOUNDATIONAL layer and must
 * not import from `./logging/pino` (which would create a circular
 * dependency). The mixin is a pure consumer of the exported
 * `correlationStore` and has no other dependencies.
 *
 * Per Rule R2 / Rule C5 the only identity fields ever returned are
 * `correlationId` and `uid`. The pino redaction allow-list in
 * `./logging/pino.ts` provides defence-in-depth against any other
 * field accidentally appearing in a log record.
 */
function pinoCorrelationMixin(): Record<string, string> {
  const ctx = correlationStore.getStore();
  if (ctx === undefined) {
    return {};
  }
  const fields: Record<string, string> = { correlationId: ctx.correlationId };
  if (ctx.uid !== undefined) {
    fields['uid'] = ctx.uid;
  }
  return fields;
}

/**
 * Application entry point.
 *
 * The `bootstrap()` function is invoked synchronously at the bottom
 * of this file. It is intentionally tiny — composition only, no
 * business logic — because Phase A's Gate A only requires that the
 * process come up, expose /healthz, and fail-fast when any of the
 * six required environment variables is missing (Rule R4).
 *
 * The middleware chain order matches AAP §0.5.6 verbatim:
 *   1. (already done) `import './tracing'` — auto-instrumentations
 *   2. express.json()                       — body parsing
 *   3. correlationMiddleware                — C5 AsyncLocalStorage
 *   4. pino-http (via app-level logger)     — request logging
 *   5. metrics.middleware                   — request counter
 *   6. session middleware (Track 1)         — added when Track 1 wires auth
 *   7. routes                               — /healthz, /readyz, /metrics
 *   8. error handler                        — last resort
 *
 * Per the user-provided Observability Rule, the application is not
 * complete until it is observable. This bootstrap layer brings up
 * the four foundation pillars at startup time:
 *   - structured JSON logging with correlation IDs (R2-compliant)
 *   - distributed tracing via OTel auto-instrumentation (R6)
 *   - Prometheus /metrics with service/environment/version labels
 *   - /healthz and /readyz probes
 */

interface Bootstrapped {
  app: Express;
  /** Resolves when the HTTP server has stopped listening. */
  shutdown: () => Promise<void>;
}

function bootstrap(): Bootstrapped {
  // Step 1: validate environment variables. Rule R4 mandates this
  // happen synchronously at startup so a misconfigured deploy fails
  // within 2 seconds with a descriptive error, not 30 seconds later
  // with a confusing connection error. validateEnv() throws a
  // MissingEnvVarError on the first absent / empty required var; the
  // throw propagates to the outer try/catch which exits non-zero.
  validateEnv();

  // Step 1a: read non-required operational identity vars with
  // documented safe defaults. These (SERVICE_NAME, SERVICE_VERSION,
  // NODE_ENV, PORT) intentionally do NOT belong to Rule R4's required
  // six (see `backend/src/config/env.ts` for the canonical list);
  // they have sensible operational defaults so a missing value does
  // not block startup. The fallbacks here MUST stay in lockstep with
  // the same fallbacks in `backend/src/tracing.ts` so traces and
  // metrics are dimensioned by identical service/environment/version
  // labels (cardinal property for ST-048-AC2 trace-metric
  // correlation).
  const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';
  const SERVICE_VERSION = process.env['SERVICE_VERSION'] ?? process.env['COMMIT_SHA'] ?? '0.1.0';
  const NODE_ENV = process.env['NODE_ENV'] ?? 'development';
  const portRaw = process.env['PORT'] ?? '3000';
  const PORT = Number.parseInt(portRaw, 10);
  if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT must be a valid TCP port (1-65535); got "${portRaw}".`);
  }

  // Step 2: build the application logger. Rule R2 redaction is
  // applied at logger construction so every record (including those
  // from pino-http, child loggers, and request-scoped binders) is
  // scrubbed of credentials. The `pinoCorrelationMixin` reads the
  // current AsyncLocalStorage context so every log record emitted
  // during a request automatically carries the correlation ID
  // (Constraint C5).
  const logger = createLogger({
    service: SERVICE_NAME,
    environment: NODE_ENV,
    version: SERVICE_VERSION,
    mixin: pinoCorrelationMixin,
  });

  // Step 3: build the Prometheus metrics bundle.
  const metrics = createMetrics({
    service: SERVICE_NAME,
    environment: NODE_ENV,
    version: SERVICE_VERSION,
  });

  // Step 4: assemble the Express app and middleware chain.
  const app = express();

  // Body parsing must run before correlation so that req.body is
  // populated when subsequent middleware reads it. Limit to 1 MB —
  // logo uploads use multipart/form-data and a separate parser.
  app.use(express.json({ limit: '1mb' }));

  // Correlation ID middleware. Stamps every inbound request with a
  // UUID v4 (or preserves the inbound x-correlation-id) and pushes
  // the value into AsyncLocalStorage so the pino mixin and outbound
  // HTTP interceptors can read it without parameter threading. This
  // is a DIRECT middleware (not a factory): it takes (req, res, next)
  // directly and is registered without invoking it.
  app.use(correlationMiddleware);

  // Attach a request-scoped logger reference to every request. The
  // mixin on the root logger (set above) means every log record
  // emitted via `req.log.info(...)` or any child logger automatically
  // includes the correlation ID — there is no need to thread the ID
  // through every function signature.
  app.use((req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { log: typeof logger }).log = logger;
    next();
  });

  // Metrics middleware: increments the request counter and records
  // the duration histogram on every response.
  app.use(metrics.middleware);

  // Step 5: construct the PostgreSQL connection pool.
  //
  // The connection configuration is derived ENTIRELY from
  // `DATABASE_URL` per Constraint C3 (Cloud SQL dual-path: Unix-socket
  // host on Cloud Run, TCP host locally — the URL form encodes both).
  // Because `validateEnv()` has already run, `requireEnv('DATABASE_URL')`
  // is guaranteed to return a non-empty string here.
  //
  // `new Pool(...)` does NOT open any TCP connection — it only stores
  // configuration. Connections are created lazily on the first
  // `pool.query(...)` call (made by `/readyz` shortly after bootup).
  // This is what allows the backend to start and answer `/healthz`
  // even when PostgreSQL is unreachable; readiness then correctly
  // reports `503 not_ready` until the DB is available.
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });

  // Health probes — /healthz never queries the DB (cheap liveness
  // check); /readyz runs `SELECT 1` against the pool with a bounded
  // timeout. The router itself is fully encapsulated; this composition
  // root only injects the pool dependency.
  app.use(createHealthRoutes({ pool }));

  // Metrics endpoint — Prometheus scrapes /metrics every 30s by
  // default; Cloud Monitoring and Grafana use the same path.
  app.use(metrics.router);

  // Step 6: 404 handler. Returns a small JSON envelope so clients
  // can distinguish between a server error and an unmatched route.
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'not_found' });
  });

  // Step 7: terminal error handler. Logs every unhandled error via
  // the redacting pino logger so credentials never leak.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    logger.error({ err }, 'unhandled_error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  // Step 8: bind the listening socket. PORT is validated above.
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, service: SERVICE_NAME, environment: NODE_ENV }, 'backend_listening');
  });

  const shutdown = async (): Promise<void> => {
    // Step 1: stop accepting new HTTP connections; wait for in-flight
    // requests to drain. `server.close()` is the idiomatic Node way to
    // do this — it lets active sockets finish their current request,
    // then resolves.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    // Step 2: drain the PostgreSQL pool. `pool.end()` waits for every
    // checked-out client to be released and then closes the underlying
    // sockets. Doing this AFTER `server.close()` guarantees no in-
    // flight HTTP request is denied a DB connection mid-response.
    await pool.end();
  };

  // Step 9: process-level signal handling. Cloud Run delivers
  // SIGTERM during scale-down; honour it so in-flight requests
  // complete cleanly. The OTel SDK has its own SIGTERM handler in
  // `tracing.ts` for span flushing.
  const handleSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutdown_signal_received');
    void shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown_failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  return { app, shutdown };
}

// Invoke bootstrap synchronously. Any thrown error (e.g. a missing
// environment variable per Rule R4) is caught and re-thrown as an
// uncaught exception — Node's default uncaughtException handler
// prints the stack trace and exits non-zero, which is exactly what
// Rule R4 requires.
try {
  bootstrap();
} catch (err) {
  // Fatal startup failure path. The pino logger is constructed INSIDE
  // bootstrap(); if bootstrap threw (e.g. Rule R4 missing-env-var
  // condition) we cannot use the logger. The repository's ESLint
  // configuration allows `console.error` (see the `no-console` rule's
  // `allow` list) so a direct stderr write is the simplest reliable
  // way to surface a Rule R4 failure within the 2-second budget.
  console.error('[fatal] backend failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
}
