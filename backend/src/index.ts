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
import { createMetricsRoutes, metricsMiddleware } from './routes/metrics';

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

// ---------------------------------------------------------------------------
// Body-parser error handling — Rule R2 / ST-047-AC4
// ---------------------------------------------------------------------------

/**
 * Shape of an error thrown by the body-parser ecosystem (the
 * `body-parser` and `http-errors` packages used by `express.json()`,
 * `express.urlencoded()`, etc.).
 *
 * When JSON parsing fails, body-parser's `read.js:128` calls:
 *   next(createError(400, err, { body: str, type: err.type ||
 *                                'entity.parse.failed' }))
 *
 * `createError` (from the `http-errors` package) attaches the
 * provided `body` (the RAW REQUEST BODY STRING) and `type` fields to
 * the wrapped error, plus `statusCode` (400) and `expose` (true).
 *
 * The `body` field is the QA-discovered Rule R2 leak surface: an
 * adversary or a buggy client that sends `{"password":"SECRET","bad`
 * causes the credential to be attached to the error verbatim. Without
 * the defense in this file, `logger.error({ err })` would serialize
 * the body verbatim into the log record.
 *
 * The `type` discriminants we recognise here are body-parser's stable
 * named identifiers documented at:
 *   https://www.npmjs.com/package/body-parser#errors
 *
 *   - 'entity.parse.failed'   — JSON parse failure
 *   - 'entity.too.large'      — request larger than `limit`
 *   - 'request.aborted'       — connection closed before parsing
 *   - 'encoding.unsupported'  — Content-Encoding not supported
 *   - 'charset.unsupported'   — text charset not supported
 *   - 'request.size.invalid'  — Content-Length mismatch
 *   - 'entities.bytes'        — internal bytes mismatch
 *   - 'parameters.too.many'   — querystring parameters > limit
 *   - 'stream.encoding.set'   — stream had encoding set
 *   - 'stream.not.readable'   — stream was unreadable
 */
interface BodyParserError extends Error {
  type?: string;
  body?: unknown;
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

/**
 * Returns true when `err` is a body-parser–origin error.
 *
 * The check uses the `type` discriminant (always set by body-parser
 * via `createError`'s third argument) AND verifies it begins with one
 * of the known body-parser type prefixes (`entity.`, `request.`,
 * `encoding.`, `charset.`, `parameters.`, `stream.`). The prefix
 * check defends against accidentally matching unrelated errors that
 * happen to define a `type` field of their own.
 *
 * The narrowing predicate guarantees that the caller's `delete err.body`
 * is type-safe — the QA report's exact CRITICAL leak path.
 */
function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error)) {
    return false;
  }
  const candidate = err as BodyParserError;
  if (typeof candidate.type !== 'string') {
    return false;
  }
  // Body-parser type names always start with one of these prefixes.
  // Validating the prefix prevents accidental matches against unrelated
  // libraries that set `err.type` for their own purposes.
  return (
    candidate.type.startsWith('entity.') ||
    candidate.type.startsWith('request.') ||
    candidate.type.startsWith('encoding.') ||
    candidate.type.startsWith('charset.') ||
    candidate.type.startsWith('parameters.') ||
    candidate.type.startsWith('stream.')
  );
}

/**
 * Sanitise a body-parser error in place by deleting the `body` field
 * BEFORE the error reaches any logger or downstream middleware.
 *
 * This is the BELT in the belt-and-suspenders defense: even though the
 * pino `err` serializer in `./logging/pino.ts` strips `err.body` at
 * serialization time, removing the field at the very first opportunity
 * (at `express.json()`'s next(err) callback) ensures that no future
 * code path — middleware, error handler, library — can possibly
 * observe the raw body string. The serializer remains as the
 * SUSPENDERS for any library that bypasses this pre-processing.
 *
 * Also strips `expose` for symmetry with the err serializer (it's
 * `http-errors` housekeeping with no debugging value).
 *
 * The sanitisation is in-place because `next(err)` requires the same
 * error reference to flow through Express's error middleware chain;
 * cloning would lose stack-trace fidelity in some debuggers.
 */
function sanitiseBodyParserError(err: BodyParserError): void {
  // `delete` on an own-enumerable property is the canonical way to
  // remove a field; the property is permanently gone for any
  // subsequent JSON.stringify or property enumeration.
  delete err.body;
  delete err.expose;
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
 *   2a. body-parser sanitiser              — strips err.body BEFORE
 *                                             the error propagates
 *                                             (Rule R2 / ST-047-AC4)
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

  // Step 3: the Prometheus metrics module is a singleton.
  //
  // The metrics module derives its `service`/`environment`/`version`
  // labels from the SAME env vars that this composition root reads
  // (`SERVICE_NAME` / `NODE_ENV` / `SERVICE_VERSION` with the same
  // documented fallbacks), so the labels emitted on every metric are
  // dimensionally identical to the ones used by `tracing.ts` for OTel
  // span resource attributes — that's the cardinal property required
  // for trace-metric correlation in dashboards (ST-048-AC2).
  //
  // The two consumers — `metricsMiddleware` (request-recording) and
  // `createMetricsRoutes()` (the `/metrics` scrape endpoint) — share
  // the SAME module-scoped `Registry` via closure, so a request
  // counted by the middleware is observable in the next scrape.

  // Step 4: assemble the Express app and middleware chain.
  const app = express();

  // Body parsing must run before correlation so that req.body is
  // populated when subsequent middleware reads it. Limit to 1 MB —
  // logo uploads use multipart/form-data and a separate parser.
  app.use(express.json({ limit: '1mb' }));

  // ────────────────────────────────────────────────────────────────────
  // Body-parser error sanitiser — Rule R2 / ST-047-AC4 (CRITICAL).
  // ────────────────────────────────────────────────────────────────────
  //
  // QA-discovered Issue 3: when `express.json()` fails to parse a
  // malformed JSON body, the body-parser library throws a SyntaxError
  // wrapped via `createError(400, err, { body: str, ... })`. The
  // resulting error has `err.body` set to the RAW REQUEST BODY STRING
  // — which can contain credentials embedded in malformed JSON (e.g.
  // `{"password":"SENTINEL_99","bad`). Path-based pino redaction
  // CANNOT match credentials embedded inside a string value, so any
  // subsequent `logger.error({ err })` would leak the credential
  // verbatim into the log record.
  //
  // This 4-arg error middleware runs IMMEDIATELY after `express.json()`
  // in the middleware chain. Express's error-routing semantics: when
  // `express.json()` calls `next(err)`, Express walks forward through
  // the chain SKIPPING all 3-arg middleware until it finds a 4-arg
  // (error) middleware — which is THIS one. We strip the `body` field
  // (and `expose`) BEFORE the error propagates anywhere else, then
  // call `next(err)` to let the regular error-handling chain emit the
  // response and the (now-safe) log record.
  //
  // The pino `err` serializer in `./logging/pino.ts` provides
  // belt-and-suspenders: even if a future code path BYPASSES this
  // sanitiser, the serializer will still strip `err.body` at log
  // emission time. Both layers are mandatory.
  //
  // We DO NOT respond from this handler — we delegate to the terminal
  // error handler below, which already sets the correct response
  // shape and HTTP status. Centralising error responses in one place
  // keeps the response contract consistent (every error response is
  // `{ error: '<code>' }`) regardless of error origin.
  app.use((err: Error, _req: Request, _res: Response, next: NextFunction): void => {
    if (isBodyParserError(err)) {
      sanitiseBodyParserError(err);
    }
    next(err);
  });

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
  // the duration histogram on every response. The middleware is a
  // direct (req, res, next) function, registered without invocation.
  app.use(metricsMiddleware);

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

  // ────────────────────────────────────────────────────────────────────
  // Pool error handler — QA Issue 2 (MINOR) defense.
  // ────────────────────────────────────────────────────────────────────
  //
  // The `pg` Pool emits an `'error'` event when an IDLE client (a
  // connection sitting in the pool not currently servicing a query)
  // encounters an error — most commonly when PostgreSQL terminates
  // the connection (e.g. `terminating connection due to administrator
  // command` after `docker compose stop postgres`).
  //
  // Without this listener, the error becomes an UNHANDLED EventEmitter
  // 'error' event. Node's documented behaviour for an unhandled
  // 'error' event is: throw the error as an uncaught exception. With
  // ts-node-dev's `--exit-child` flag (used by `npm run dev` in
  // development), the dev container's child process then exits, and
  // the dev container becomes unresponsive until the orchestrator
  // restarts it (~5–10 seconds of blackout).
  //
  // Production behaviour: the production multi-stage Dockerfile uses
  // `node dist/index.js` (no ts-node-dev wrapper), so the unhandled
  // pg pool error would crash the production process directly — even
  // worse than the dev-environment behaviour. Adding the listener is
  // therefore not just a dev-experience fix but a production
  // correctness fix.
  //
  // The handler logs at WARN (not ERROR) because:
  //   - The pool will automatically attempt to re-establish lost
  //     connections on the next `pool.query()` call (pg's documented
  //     resilience behaviour).
  //   - Treating expected reconnect-on-DB-restart as an ERROR would
  //     produce alarm fatigue; readiness probe degradation already
  //     covers operator visibility for actual DB outages.
  //
  // The `event` field is fixed (`db.pool.error`) so dashboard panels
  // can filter on it directly.
  pool.on('error', (err: Error) => {
    logger.warn(
      {
        err,
        event: 'db.pool.error',
      },
      'PostgreSQL pool encountered an error on an idle client',
    );
  });

  // Health probes — /healthz never queries the DB (cheap liveness
  // check); /readyz runs `SELECT 1` against the pool with a bounded
  // timeout. The router itself is fully encapsulated; this composition
  // root only injects the pool dependency.
  app.use(createHealthRoutes({ pool }));

  // Metrics endpoint — Prometheus scrapes /metrics every 30s by
  // default; Cloud Monitoring and Grafana use the same path. The
  // factory returns a router with a single `GET /metrics` route
  // mounted at root.
  app.use(createMetricsRoutes());

  // Step 6: 404 handler. Returns a small JSON envelope so clients
  // can distinguish between a server error and an unmatched route.
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'not_found' });
  });

  // Step 7: terminal error handler. Logs every unhandled error via
  // the redacting pino logger so credentials never leak.
  //
  // Status code resolution (Rule R8 — fail-closed semantics):
  //   1. If the error carries an explicit `statusCode` or `status`
  //      field (the http-errors / Boom convention), honour it. This
  //      ensures body-parser errors propagate as 400 (their stated
  //      status) rather than being masked as 500.
  //   2. Only valid HTTP status codes (100-599) are honoured; other
  //      values fall back to 500 to avoid emitting nonsensical codes.
  //   3. The default is 500 — the canonical "we don't know what
  //      happened" response.
  //
  // Response body is intentionally MINIMAL — never include the err
  // message in the response payload, because err messages can include
  // operationally sensitive data (file paths, stack frames, internal
  // state). Operators get the full detail in the log; clients get a
  // stable error code.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction): void => {
    // The err serializer in `./logging/pino.ts` strips err.body and
    // other dangerous fields. Combined with the body-parser sanitiser
    // earlier in the chain, this produces a credential-safe log record
    // even for malformed JSON requests. Rule R2 / ST-047-AC4.
    logger.error({ err }, 'unhandled_error');

    // Resolve status code from err.statusCode || err.status || 500,
    // bounded to a valid HTTP status code range. The bounded check
    // defends against malformed http-errors usage (e.g. statusCode of
    // -1 or 99999) which would otherwise produce protocol errors.
    const candidateStatus =
      (err as { statusCode?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
    const status =
      typeof candidateStatus === 'number' &&
      Number.isInteger(candidateStatus) &&
      candidateStatus >= 100 &&
      candidateStatus <= 599
        ? candidateStatus
        : 500;

    // Stable error-code envelope. Body-parser errors carry a `type`
    // field we can surface as a stable code; other errors get the
    // generic `internal_server_error` code.
    let errorCode = 'internal_server_error';
    if (status >= 400 && status < 500) {
      // Client-side error: prefer body-parser's `type` discriminant
      // when present (e.g. `entity.parse.failed` becomes a stable
      // contract clients can switch on), otherwise the generic 4xx
      // code.
      const bpType = (err as BodyParserError).type;
      errorCode =
        typeof bpType === 'string' && bpType.length > 0 ? bpType : 'bad_request';
    }
    res.status(status).json({ error: errorCode });
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
