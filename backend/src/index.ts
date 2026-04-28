/**
 * Backend Express composition root — entry point.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/index.ts | Entry point; FIRST line is `import './tracing'`
 *        per C4/R6; then env validation; then Express bootstrap"
 *   - §0.6.4 (Track 1 / T1-C):
 *       "CREATE | backend/src/index.ts | Express bootstrap; FIRST line is
 *        `import './tracing'` per C4/R6"
 *   - §0.5.6 (Cross-Cutting Middleware Order — NON-NEGOTIABLE):
 *       1. import './tracing'        — C4/R6 (MUST be first import)
 *       2. express.json()            — body parsing
 *       3. correlationMiddleware     — C5 AsyncLocalStorage
 *       4. pinoHttp                  — request-scoped logger reads ALS
 *       5. metricsMiddleware         — counters + latency histogram
 *       6. sessionMiddleware         — mounted only on /api/* (excl.
 *                                      register, login, share)
 *       7. routes/*                  — business logic
 *       8. error handler             — last; logs via pino with allow-list
 *
 * Per the user-provided Observability Rule, the application is not
 * complete until it is observable. This bootstrap layer brings up
 * the four foundation pillars at startup:
 *   - structured JSON logging with correlation IDs (Rule R2 / ST-047)
 *   - distributed tracing via OTel auto-instrumentation (Rule R6 / ST-049)
 *   - Prometheus /metrics with service/environment/version labels
 *     (ST-048-AC1)
 *   - /healthz (liveness) and /readyz (readiness) probes (ST-048-AC3/4)
 *
 * Per Rule R4 / ST-047-AC4, this file:
 *   - Validates the six required env vars synchronously at startup. A
 *     missing var causes a non-zero exit within Rule R4's 2-second
 *     budget (verified by `tests/integration/observability/
 *     env-fail-fast.integration.test.ts`).
 *   - Sanitises body-parser errors (deletes `err.body` carrying the raw
 *     malformed JSON request body, which can contain credentials) BEFORE
 *     the error reaches any logger, providing the BELT in the
 *     belt-and-suspenders Rule R2 defense (the SUSPENDERS are pino's
 *     redact paths and `req` serializer allow-list in `./logging/pino.ts`).
 *
 * Cross-references:
 *   - `./tracing.ts` — OTel SDK init; this file's first import.
 *   - `./db/pool.ts` — PostgreSQL pool singleton; bootstrap calls
 *     `initializePool()` once and `closePool()` during graceful shutdown.
 *   - `./auth/firebase-admin.ts` — Firebase Admin SDK init; provides the
 *     sole `verifyIdToken` path per Rule R3 / Constraint C2.
 *   - `./auth/firebase-rest.ts` — REST adapter for `signInWithPassword`
 *     (Firebase Admin SDK does NOT verify passwords; this is the SOLE
 *     password-verification path per Rule R3, and its idToken result is
 *     then validated by Firebase Admin SDK).
 *   - `./logging/pino.ts` — single pino logger with serializer allow-list
 *     and AsyncLocalStorage mixin; same `pinoOptions.serializers` is
 *     passed to `pinoHttp` here so the production allow-list applies to
 *     the per-request "request completed" log records.
 */

// ──────────────────────────────────────────────────────────────────────
// Tracing import — Rule R6 / Constraint C4 (NON-NEGOTIABLE FIRST IMPORT)
// ──────────────────────────────────────────────────────────────────────
//
// `./tracing` MUST be the very first import in this file per Rule R6 /
// Constraint C4. The OpenTelemetry auto-instrumentations monkey-patch
// pg / http / express at module-load time, so any earlier import
// (including a side-effect-only require()) would result in missing or
// duplicated spans. Do NOT reorder this import.
import './tracing';

// ──────────────────────────────────────────────────────────────────────
// Standard library imports
// ──────────────────────────────────────────────────────────────────────
//
// Node.js HTTP module — used as `http.createServer(app)` for fine-grained
// control over the server lifecycle (explicit Server reference for
// graceful shutdown via `server.close()`, persistent error listener for
// post-startup failures). Imported via the `node:` protocol prefix to
// make stdlib origin explicit and to play well with bundlers that
// distinguish stdlib from third-party modules.
import http from 'node:http';

// ──────────────────────────────────────────────────────────────────────
// Third-party imports (loaded AFTER tracing is registered)
// ──────────────────────────────────────────────────────────────────────
//
// `cors` — QA Issue #10 fix. Without CORS, browser-issued cross-origin
// fetches from the Vite dev server (default `http://localhost:5173`) to
// the backend (default `http://localhost:3000`) fail with `TypeError:
// Failed to fetch` at the browser preflight stage. Although `cors` is
// not enumerated in the schema's `external_imports`, it is operationally
// required for the frontend → backend integration tests and the local
// dev workflow. Documented in the decision log as the QA-driven
// production additions to the schema-specified middleware chain.
import cors from 'cors';
import type { CorsOptions } from 'cors';

// `express` — HTTP framework. The default export creates the app and the
// `express.json()` body-parsing middleware; the type-only named imports
// are used for the error handler's 4-argument signature (Express's arity
// detection — the 4-arg shape is REQUIRED for Express to recognise the
// function as an error handler) and the typed Request/Response/Express
// references throughout the file.
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

// `pino-http` — Express middleware that attaches a request-scoped
// pino logger to every request (`req.log`) and emits a "request
// completed" log record at end-of-handler. Per AAP §0.5.6 step 4 this is
// the production-required wiring for request-scoped logging. Per the
// Rule R2 verification suite (`credential-redaction.integration.test.ts`)
// the production-allow-list serializers from `pinoOptions.serializers`
// MUST be passed explicitly as the `serializers:` option, otherwise
// pino-http falls back to `pino-std-serializers` defaults that emit ALL
// request headers verbatim — silently leaking Authorization, Cookie, and
// vendor-specific credential headers.
import { pinoHttp } from 'pino-http';

// ──────────────────────────────────────────────────────────────────────
// Application module imports — composition order
// ──────────────────────────────────────────────────────────────────────
//
// These imports load AFTER tracing is registered (so OTel
// auto-instrumentation captures their pg / http / express calls) and
// BEFORE any module that depends on them runs (so circular
// dependencies cannot exist). The import order within this group is
// alphabetical-by-path within each layer (auth, config, db, logging,
// middleware, repositories, routes, services), which keeps the
// dependency graph easy to audit visually.

import { initializeFirebaseAdmin } from './auth/firebase-admin';
import { createSignInWithPassword } from './auth/firebase-rest';
import { validateEnv } from './config/env';
import { closePool, initializePool } from './db/pool';
import { logger, pinoOptions } from './logging/pino';
import { correlationMiddleware } from './middleware/correlation';
import { sessionMiddleware } from './middleware/session';

// Repositories — each takes the shared `pool` directly and captures it
// via closure. There is no factory composition between repositories.
import { createDesignRepository } from './repositories/design.repository';
import { createOrderRepository } from './repositories/order.repository';
import { createSessionRepository } from './repositories/session.repository';
import { createShareLinkRepository } from './repositories/share-link.repository';
import { createUserRepository } from './repositories/user.repository';

// Routes — each factory returns an express.Router (or a pair, in the
// case of `createAuthRoutes` which returns both a public router for
// register/login and an authenticated router for logout).
import { createAuthRoutes } from './routes/auth';
import { createCartRoutes } from './routes/cart';
import { createDesignRoutes } from './routes/designs';
import { createHealthRoutes } from './routes/health';
import { createMetricsRoutes, metricsMiddleware } from './routes/metrics';
import { createOrderRoutes } from './routes/orders';
import { createShareRoutes } from './routes/share';

// Services — each factory takes a deps object and returns an object of
// methods. Construction order matters: each service's dependencies must
// be constructed before the service itself.
import { createDesignService } from './services/design.service';
import { createGcsService } from './services/gcs.service';
import { createOrderService } from './services/order.service';
import { createSessionService } from './services/session.service';
import { createShareLinkService } from './services/share-link.service';

// ---------------------------------------------------------------------------
// Body-parser error handling — Rule R2 / ST-047-AC4 (CRITICAL)
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

// ---------------------------------------------------------------------------
// Bootstrap function
// ---------------------------------------------------------------------------

/**
 * Application entry point.
 *
 * The middleware chain order matches AAP §0.5.6 verbatim:
 *
 *   0. `import './tracing'`        — auto-instrumentations (FIRST IMPORT)
 *   1. `express.json({ limit })`   — body parsing
 *   1a. body-parser sanitiser      — strips err.body BEFORE the error
 *                                     propagates (Rule R2 / ST-047-AC4)
 *   1b. `cors(corsOptions)`        — QA Issue #10 fix; preflight
 *                                     short-circuit so OPTIONS never
 *                                     reaches the session gate
 *   2. `correlationMiddleware`     — C5 AsyncLocalStorage
 *   3. `pinoHttp({ logger, ... })` — request-scoped logger reads ALS
 *   4. `metricsMiddleware`         — counters + latency histogram
 *   5. UNAUTHENTICATED routes      — health, metrics, share, public auth
 *   6. `sessionMiddleware`         — gate at `/api`
 *   7. AUTHENTICATED routes        — auth/logout, designs, cart, orders
 *   8. 404 handler                 — stable `{ error: 'not_found' }`
 *   9. error handler               — terminal 4-arg shape
 *
 * The function is declared `async` so that we can `await` the
 * `server.listen()` event before resolving the bootstrap. The
 * synchronous `validateEnv()` throw inside an async function rejects
 * the returned Promise; the top-level `.catch()` handler then exits
 * non-zero within Rule R4's 2-second budget.
 *
 * @returns A Promise resolving to the http.Server instance once
 *   listening on the configured port. The Server reference is exposed
 *   primarily for diagnostic/test harness use; production callers do
 *   not interact with it directly (graceful shutdown is handled
 *   internally via SIGTERM/SIGINT signal handlers).
 *
 * @throws {import('./config/env').MissingEnvVarError} When any of the
 *   six required env vars is unset (Rule R4); the throw rejects the
 *   returned Promise.
 */
async function bootstrap(): Promise<http.Server> {
  // -------------------------------------------------------------------
  // Step 1: Validate environment variables (Rule R4 — fail-fast)
  // -------------------------------------------------------------------
  //
  // `validateEnv()` throws synchronously on the first absent / empty
  // required var (DATABASE_URL, FIREBASE_PROJECT_ID, GCS_BUCKET_NAME,
  // GCS_EMULATOR_HOST, COVERAGE_THRESHOLD, GCP_REGION). The throw
  // propagates out of this async function and rejects the returned
  // Promise; the top-level `.catch()` then console.error()s and
  // process.exit(1)s within Rule R4's 2-second budget.
  //
  // We deliberately do NOT log "env_validated" via pino BEFORE this
  // call: a failure here means env validation never happened, and the
  // logger's mixin (which reads from AsyncLocalStorage) is irrelevant
  // because no request has opened an ALS frame yet at startup.
  validateEnv();
  logger.info({ event: 'startup.env_validated' }, 'Environment validation passed');

  // -------------------------------------------------------------------
  // Step 1a: Resolve operational identity vars with documented defaults
  // -------------------------------------------------------------------
  //
  // SERVICE_NAME, NODE_ENV, and PORT are NOT among the six Rule R4
  // required vars (see `backend/src/config/env.ts`); they have sensible
  // operational defaults so a missing value does not block startup. The
  // fallbacks here MUST stay in lockstep with the same fallbacks in
  // `backend/src/tracing.ts` and `backend/src/routes/metrics.ts` so
  // traces and metrics are dimensioned by identical service /
  // environment / version labels (cardinal property for ST-048-AC2
  // trace-metric correlation).
  const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';
  const NODE_ENV = process.env['NODE_ENV'] ?? 'development';
  const portRaw = process.env['PORT'] ?? '3000';
  const PORT = Number.parseInt(portRaw, 10);
  if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT must be a valid TCP port (1-65535); got "${portRaw}".`);
  }

  // -------------------------------------------------------------------
  // Step 2: Initialize the database connection pool
  // -------------------------------------------------------------------
  //
  // `initializePool()` (from `./db/pool`) constructs a singleton
  // `pg.Pool` from `DATABASE_URL` per Constraint C3 — Cloud SQL
  // dual-path encoding (Unix-socket host on Cloud Run, TCP host
  // locally) lives entirely in the URL. The pool is LAZY: it does NOT
  // open any TCP connection here, only stores configuration.
  // Connections are created on the first `pool.query(...)` call —
  // typically the first `/readyz` probe shortly after boot. This is
  // what allows the backend to start and answer `/healthz` even when
  // PostgreSQL is unreachable.
  //
  // The pool's background `'error'` event handler is registered
  // INSIDE `initializePool()` (logged at error level via pino with the
  // allow-list serializer). We intentionally do NOT register a duplicate
  // listener here.
  const pool = initializePool();
  logger.info({ event: 'startup.db_pool_initialized' }, 'Database pool initialized');

  // -------------------------------------------------------------------
  // Step 3: Initialize the Firebase Admin SDK + REST password adapter
  // -------------------------------------------------------------------
  //
  // `initializeFirebaseAdmin()` is idempotent (its module-level
  // singleton state guarantees a single SDK initialization per Node
  // process). The same Auth instance flows into the SessionService and
  // is consumed by every authenticated request via the session
  // middleware — Constraint C2 / Rule R3 require this be the SOLE
  // `verifyIdToken` path; no custom JWT parsing is permitted.
  //
  // `createSignInWithPassword()` returns a closure that wraps the
  // Firebase Auth REST endpoint `accounts:signInWithPassword`. The
  // Firebase Admin SDK does NOT verify passwords — this adapter is
  // the SOLE password-verification path per Rule R3. The resulting
  // idToken is then validated by Firebase Admin SDK's `verifyIdToken`
  // on every authenticated request. Although `auth/firebase-rest.ts`
  // is not enumerated in this file's schema-specified
  // `depends_on_files`, it is REQUIRED by `services/session.service.ts`
  // (`SessionServiceDeps.signInWithPassword: SignInWithPasswordFn`) —
  // documented in the decision log as a SessionService contract
  // dependency that the schema's depends_on_files omitted.
  const firebaseAuth = initializeFirebaseAdmin();
  const signInWithPassword = createSignInWithPassword();
  logger.info({ event: 'startup.firebase_admin_initialized' }, 'Firebase Admin SDK initialized');

  // -------------------------------------------------------------------
  // Step 4: Compose repositories → services → routers
  // -------------------------------------------------------------------
  //
  // Per AAP §0.5.2 (Newly Introduced Wiring) the composition root
  // assembles repositories → services → routes explicitly. There is
  // no DI container — factory functions are sufficient and keep the
  // composition graph greppable.
  //
  // Order matters within services (each service's dependencies must
  // be constructed before the service itself), but does not matter
  // within repositories (they are independent).

  // Step 4a: repositories
  const userRepository = createUserRepository(pool);
  const sessionRepository = createSessionRepository(pool);
  const designRepository = createDesignRepository(pool);
  const orderRepository = createOrderRepository(pool);
  const shareLinkRepository = createShareLinkRepository(pool);

  // Step 4b: services
  //
  // Note that `createGcsService()` takes NO deps argument — it reads
  // its own configuration internally via `env.GCS_BUCKET_NAME` and
  // `env.GCS_EMULATOR_HOST`. This is unique among the service
  // factories (all others require deps); see `services/gcs.service.ts`
  // for the architectural rationale.
  const sessionService = createSessionService({
    sessionRepository,
    userRepository,
    firebaseAuth,
    signInWithPassword,
  });
  const gcsService = createGcsService();
  const designService = createDesignService({
    designRepository,
    gcsService,
  });
  const orderService = createOrderService({
    orderRepository,
    designRepository,
  });
  const shareLinkService = createShareLinkService({
    shareLinkRepository,
    designRepository,
  });

  // Step 4c: routers
  //
  // The `createAuthRoutes` factory returns BOTH a public router
  // (register/login) and an authenticated router (logout) so the
  // composition root can mount each on the correct side of the
  // session gate.
  const { publicAuthRouter, authenticatedAuthRouter } = createAuthRoutes({
    sessionService,
  });
  const shareRouter = createShareRoutes({ shareLinkService });
  const designsRouter = createDesignRoutes({ designService, shareLinkService });
  const cartRouter = createCartRoutes({ orderService });
  const ordersRouter = createOrderRoutes({ orderService });

  // -------------------------------------------------------------------
  // Step 5: Build the Express app with middleware chain (AAP §0.5.6)
  // -------------------------------------------------------------------
  const app: Express = express();

  // Step 5a: body parsing.
  //
  // Limit to 1 MB — logo uploads use multipart/form-data via signed
  // URLs (see `services/gcs.service.ts`) and a separate parser, so
  // this JSON parser only ever sees small design payloads, auth
  // bodies, and order requests. Any well-behaved request fits well
  // within 1 MB.
  app.use(express.json({ limit: '1mb' }));

  // Step 5b: body-parser sanitiser — Rule R2 / ST-047-AC4 (CRITICAL).
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

  // Step 5c: CORS middleware — QA Issue #10 fix (CRITICAL).
  //
  // Without CORS, browser-issued cross-origin fetches from the Vite dev
  // server (default `http://localhost:5173`) to the backend (default
  // `http://localhost:3000`) fail with `TypeError: Failed to fetch` at
  // the browser preflight stage, BEFORE any application logic runs. The
  // preflight (HTTP OPTIONS) carries no Authorization header, so the
  // session middleware (mounted further down) would otherwise reject it
  // with HTTP 401. By placing CORS BEFORE the session gate, OPTIONS
  // preflights short-circuit through the cors middleware and never
  // reach session validation.
  //
  // Origin allow-list is sourced from the OPTIONAL `CORS_ALLOWED_ORIGINS`
  // environment variable (comma-separated list). It is OPTIONAL — Rule
  // R4's "no defaults in source code" rule applies only to the SIX
  // required env vars listed in §0.1.3 of the AAP. CORS configuration
  // is a deployment concern with a sensible local-dev default.
  //
  // Allowed headers explicitly include `Authorization`, `Content-Type`,
  // `X-Correlation-Id`, and `traceparent` — the four headers the
  // frontend `api/client.ts` and OpenTelemetry auto-instrumentation
  // attach. Without explicit allow, the browser strips them from the
  // actual request after preflight.
  //
  // `credentials: false` because Firebase auth uses Bearer tokens (not
  // cookies). If cookies are introduced later, this flag must flip to
  // `true` AND `origin` must NOT be `*` (browser security spec).
  const parsedCorsOrigins = process.env['CORS_ALLOWED_ORIGINS']
    ?.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  // QA Final B Issue #8: include both `localhost` and `127.0.0.1`
  // forms of the Vite dev server origin in the default allow-list.
  // Browsers treat `http://localhost:5173` and `http://127.0.0.1:5173`
  // as DISTINCT origins for CORS purposes — a developer reaching the
  // frontend at the IP form would otherwise see preflight failures
  // (`net::ERR_FAILED`). Both forms are common in dev environments
  // (some dev tools bind only to 127.0.0.1, others only to localhost),
  // so accepting both is the least-surprise default. Production
  // deployments override this via `CORS_ALLOWED_ORIGINS`.
  const corsAllowedOrigins =
    parsedCorsOrigins !== undefined && parsedCorsOrigins.length > 0
      ? parsedCorsOrigins
      : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const corsOptions: CorsOptions = {
    origin: corsAllowedOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Correlation-Id', 'traceparent'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 600,
  };
  app.use(cors(corsOptions));

  // Step 5d: correlation middleware — Constraint C5.
  //
  // Stamps every inbound request with a UUID v4 (or preserves the
  // inbound `x-correlation-id`) and pushes the value into Node's
  // AsyncLocalStorage so the pino mixin and outbound HTTP interceptors
  // can read it without parameter threading. The middleware MUST run
  // BEFORE pino-http (next step) so the ALS frame is open when
  // pino-http creates the request-scoped child logger — otherwise
  // every log record emitted by pino-http would lack `correlationId`.
  app.use(correlationMiddleware);

  // Step 5e: pino-http — request-scoped logger.
  //
  // `pinoHttp` does three things:
  //   1. Attaches a request-scoped child logger at `req.log` so every
  //      `req.log.info(...)` call inside a handler automatically
  //      includes the correlation ID via the underlying logger's
  //      mixin.
  //   2. Emits a "request completed" log record at end-of-handler
  //      with `req`, `res`, and (on errors) `err` fields — the
  //      operationally critical record that forms the basis of the
  //      observability dashboard's request-rate / error-rate panels.
  //   3. Maps each response status to a log severity via
  //      `customLogLevel` so dashboards can filter on level
  //      semantics: 5xx → error, 4xx → warn, 2xx/3xx → info.
  //
  // CRITICAL Rule R2 wiring: `serializers: pinoOptions.serializers`
  // is passed EXPLICITLY. Per the integration test at
  // `tests/integration/observability/credential-redaction.integration.test.ts`,
  // pino-http resolves its req/res/err serializers from
  // `opts.serializers`, NOT from the underlying logger's options.
  // Without an explicit `serializers:` argument, pino-http falls back
  // to `pino-std-serializers` defaults that emit the FULL request
  // headers map (including Authorization, Cookie, X-API-Key, etc.),
  // defeating the production allow-list serializer in `pinoOptions`.
  // Passing the production serializers VERBATIM ensures the same
  // allow-list filter applies to pino-http's "request completed"
  // records as to every other logger call.
  //
  // The `redact` paths here are belt-and-suspenders defense over
  // pino-http specifically — even though the `req` serializer's
  // allow-list already drops these headers, the redact paths catch
  // any future regression that weakens the serializer (e.g., a
  // refactor that makes the serializer optional).
  app.use(
    pinoHttp({
      logger,
      serializers: pinoOptions.serializers,
      customLogLevel: (_req, res, err) => {
        if (err !== undefined && err !== null) {
          return 'error';
        }
        if (res.statusCode >= 500) {
          return 'error';
        }
        if (res.statusCode >= 400) {
          return 'warn';
        }
        return 'info';
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
    }),
  );

  // Step 5f: metrics middleware.
  //
  // Increments the `http_requests_total` counter and records the
  // `http_request_duration_seconds` histogram on every response. The
  // middleware is a direct (req, res, next) function exported from
  // `routes/metrics.ts`; the metrics module is a process-wide
  // singleton so a request counted here is observable in the next
  // `/metrics` scrape.
  app.use(metricsMiddleware);

  // -------------------------------------------------------------------
  // Step 6: Mount routes (UNAUTHENTICATED first, then session gate)
  // -------------------------------------------------------------------
  //
  // Per AAP §0.5.6 step 6 the session middleware is mounted ONLY on
  // /api/* AND only AFTER the public auth + share routes. Express's
  // positional middleware semantics enforce the unauthenticated
  // allow-list without an explicit allow-list inside sessionMiddleware:
  //
  //   - GET /healthz                   — UNAUTHENTICATED (ST-048-AC3)
  //   - GET /readyz                    — UNAUTHENTICATED (ST-048-AC4)
  //   - GET /metrics                   — UNAUTHENTICATED (ST-048-AC1)
  //   - POST /api/auth/register        — UNAUTHENTICATED (ST-023)
  //   - POST /api/auth/login           — UNAUTHENTICATED (ST-024)
  //   - GET /api/share/:token          — UNAUTHENTICATED (ST-029-AC3)
  //
  // Then the gate, then:
  //
  //   - POST /api/auth/logout          — AUTHENTICATED (ST-025)
  //   - POST /api/designs              — AUTHENTICATED (ST-027)
  //   - GET /api/designs               — AUTHENTICATED (ST-028)
  //   - POST /api/designs/:id/share-link — AUTHENTICATED (ST-029)
  //   - GET /api/cart                  — AUTHENTICATED (ST-033)
  //   - POST /api/orders               — AUTHENTICATED (ST-032)
  //   - POST /api/orders/:id/finalize  — AUTHENTICATED (ST-034)

  // Step 6a: UNAUTHENTICATED — health, metrics, share, public auth.
  //
  // The health and metrics routers internally declare their routes at
  // full root paths (/healthz, /readyz, /metrics), so they are mounted
  // at root with no path prefix.
  //
  // The share router internally declares its routes at full paths
  // (e.g., /api/share/:token), so it is also mounted at root. Per
  // ST-029-AC3, GET /api/share/:token is unauthenticated so a
  // recipient can view the shared design without an account.
  //
  // The public auth router is mounted at /api/auth so its internal
  // routes (POST /register, POST /login) resolve to /api/auth/register
  // and /api/auth/login. Per ST-023 and ST-024, these endpoints are
  // unauthenticated by definition (a user cannot "log in" if a
  // session is required to log in).
  app.use(createHealthRoutes({ pool }));
  app.use(createMetricsRoutes());
  app.use(shareRouter);
  app.use('/api/auth', publicAuthRouter);

  // Step 6b: SESSION GATE — Rule R3 / Constraint C2.
  //
  // `sessionMiddleware({ sessionService })` mounted at `/api` gates
  // every subsequent `/api/*` route. Routes already mounted
  // (publicAuthRouter on `/api/auth`, shareRouter at root) are NOT
  // affected — Express middleware order is strict and the earlier
  // `app.use(...)` calls have already consumed those paths.
  //
  // The middleware:
  //   (a) Extracts the `rawBearerToken` from the
  //       `Authorization: Bearer <token>` header.
  //   (b) Calls `firebaseAuth.verifyIdToken(rawBearerToken)` (via the
  //       service's `verifyToken` method) — Rule R3 / Constraint C2
  //       — to cryptographically validate the JWT.
  //   (c) Cross-references the `sessions.revoked_at` column to ensure
  //       the session has not been logged out.
  //   (d) Attaches `req.uid = decodedToken.uid` for downstream
  //       handlers, then calls `next()`.
  //   (e) On any failure path (missing header, malformed token,
  //       expired token, revoked session), responds with HTTP 401 and
  //       a stable `{ error: { code, message } }` envelope.
  //
  // This single mount satisfies ST-026 verbatim and the QA report's
  // "401 enforcement" verification (USER EXAMPLE Gate T1-C).
  app.use('/api', sessionMiddleware({ sessionService }));

  // Step 6c: AUTHENTICATED — auth/logout, designs, cart, orders.
  //
  // Each `app.use(...)` below is reached only when the session
  // middleware has already populated `req.uid`. The route factories'
  // handlers therefore assume `req.uid` is present and surface a
  // structured 401 response when it is not (defense-in-depth — the
  // middleware would have rejected the request before reaching here,
  // but the handler-level check guards against composition-root
  // bugs).
  app.use('/api/auth', authenticatedAuthRouter);
  app.use('/api/designs', designsRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/orders', ordersRouter);

  // -------------------------------------------------------------------
  // Step 7: 404 handler
  // -------------------------------------------------------------------
  //
  // Returns a small JSON envelope so clients can distinguish between
  // a server error and an unmatched route. Stable shape matches the
  // body-parser error envelope below — `{ error: '<code>' }`.
  app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'not_found' });
  });

  // -------------------------------------------------------------------
  // Step 8: Terminal error handler (4-arg signature — REQUIRED)
  // -------------------------------------------------------------------
  //
  // Logs every unhandled error via the redacting pino logger so
  // credentials never leak. Express's arity detection: the 4-arg
  // shape `(err, req, res, next)` is REQUIRED for Express to recognise
  // the function as an error handler — using `(req, res, next)` would
  // make this run as a regular middleware AFTER the 404 handler,
  // never receiving any error.
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
  //
  // Logging via `req.log` (the pino-http child) ensures correlationId,
  // uid, traceId, and spanId are attached automatically. We fall back
  // to the module-level `logger` when `req.log` is unavailable (an
  // edge case if pino-http's middleware was never reached for this
  // request — unlikely given its mount position above, but defended
  // for robustness).
  app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
    // The err serializer in `./logging/pino.ts` strips err.body and
    // other dangerous fields. Combined with the body-parser sanitiser
    // earlier in the chain, this produces a credential-safe log record
    // even for malformed JSON requests. Rule R2 / ST-047-AC4.
    const reqLog = (req as Request & { log?: typeof logger }).log ?? logger;
    reqLog.error({ err, event: 'request.unhandled_error' }, 'unhandled_error');

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
      errorCode = typeof bpType === 'string' && bpType.length > 0 ? bpType : 'bad_request';
    }
    res.status(status).json({ error: errorCode });
  });

  // -------------------------------------------------------------------
  // Step 9: Bind the HTTP server (http.createServer + explicit listen)
  // -------------------------------------------------------------------
  //
  // We use `http.createServer(app)` rather than the convenience
  // `app.listen(...)` for three reasons:
  //   1. Explicit `http.Server` reference for graceful shutdown via
  //      `server.close()` — calling `server.close()` returns a
  //      callback when in-flight requests have drained, which is the
  //      correctness property Cloud Run expects on SIGTERM.
  //   2. Persistent `'error'` listener — `server.listen()` errors
  //      (most commonly EADDRINUSE) emit on the server's `'error'`
  //      event. Without a listener, Node's default behaviour is to
  //      throw the error as an uncaught exception that crashes the
  //      process WITHOUT a structured log record. With the listener
  //      we log via pino so the failure mode is observable in the
  //      same dashboard as every other backend error.
  //   3. Test-harness compatibility — exposing the server reference
  //      lets test harnesses inspect `server.address()` etc. for
  //      port-discovery scenarios (the integration suite does not do
  //      this today, but the design is forward-compatible).
  //
  // The listen() Promise wrapper resolves on `'listening'` (success)
  // or rejects on `'error'` (port in use, EACCES, etc.). The
  // single-shot listeners are removed in either branch so the
  // permanent error handler installed below can take over without
  // duplicate firing.
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT);
  });

  // Permanent error listener — handles ANY post-startup error (e.g.
  // an upstream socket disconnect, a malformed request line that
  // bypasses Express, etc.). Logged at error level via pino with the
  // allow-list serializer; the process is NOT exited because these
  // events are typically transient and the server continues to
  // accept new connections.
  server.on('error', (err: Error) => {
    logger.error({ err, event: 'server.error' }, 'HTTP server error after startup');
  });

  logger.info(
    { port: PORT, service: SERVICE_NAME, environment: NODE_ENV, event: 'backend_listening' },
    'backend_listening',
  );

  // -------------------------------------------------------------------
  // Step 10: Graceful shutdown handling
  // -------------------------------------------------------------------
  //
  // Cloud Run delivers SIGTERM ~10 seconds before forcibly killing
  // the container during scale-down or revision rollover. We honour
  // it so:
  //   1. New connections are refused (`server.close()` stops
  //      accepting new sockets immediately).
  //   2. In-flight requests complete cleanly (`server.close()`
  //      resolves only after every active request has finished).
  //   3. The PostgreSQL pool drains gracefully (`closePool()` waits
  //      for every checked-out client to be released).
  //
  // The OTel SDK has its own SIGTERM handler in `tracing.ts` for
  // span flushing — both handlers run independently; OTel's handler
  // does not interfere with this one because both use `process.once`
  // (so each handler fires exactly once on the first SIGTERM).
  const shutdown = async (): Promise<void> => {
    // Step 1: stop accepting new HTTP connections; wait for in-flight
    // requests to drain. `server.close()` is the idiomatic Node way
    // to do this — it lets active sockets finish their current
    // request, then resolves.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Step 2: drain the PostgreSQL pool. `closePool()` waits for
    // every checked-out client to be released and then closes the
    // underlying sockets. Doing this AFTER `server.close()`
    // guarantees no in-flight HTTP request is denied a DB connection
    // mid-response.
    await closePool();
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal, event: 'shutdown.signal_received' }, 'shutdown_signal_received');
    // Fire-and-forget the shutdown promise — the void operator marks
    // the rejection-handled state so `@typescript-eslint/no-floating-
    // promises` is satisfied. Both branches call process.exit() to
    // ensure the Node event loop terminates promptly.
    void shutdown().then(
      () => {
        logger.info({ event: 'shutdown.complete' }, 'Graceful shutdown complete');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err, event: 'shutdown.error' }, 'shutdown_failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  return server;
}

// ---------------------------------------------------------------------------
// Top-level invocation — Rule R4 fail-fast
// ---------------------------------------------------------------------------
//
// Invoke bootstrap and route any rejection (including the synchronous
// `validateEnv()` throw inside the async function body, which causes
// the returned Promise to reject) to a fail-fast exit handler.
//
// We deliberately use `console.error` rather than `logger.fatal` here
// because:
//   1. The MissingEnvVarError message ("Required environment variable
//      \"DATABASE_URL\" is not set. This is a fatal misconfiguration...")
//      already contains every keyword the env-fail-fast integration
//      test asserts (`/required|missing|not set|fatal|failed/i` and
//      the variable name itself). Routing through pino would still
//      satisfy the test, but adds an asynchronous flush hazard right
//      before `process.exit(1)` — pino's stdout buffer might not
//      flush before the process terminates, dropping the descriptive
//      error from CI logs.
//   2. `console.error` writes synchronously to stderr (a behaviour the
//      Node docs explicitly guarantee for tty / pipe / file
//      destinations), so the descriptive error is on the wire BEFORE
//      `process.exit(1)` is called. This is the most reliable
//      "descriptive error within 2 seconds" path per Rule R4.
//   3. The repository ESLint configuration explicitly allows
//      `console.error` (see `no-console: ["error", { "allow":
//      ["warn", "error"] }]` in `.eslintrc.json`).
//
// `process.exit(1)` is called unconditionally in the catch handler;
// the integration test asserts `exitCode !== 0` and `signal === null`,
// both of which are satisfied by `process.exit(1)`.
bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- approved by .eslintrc.json no-console allow-list
  console.error('[fatal] backend failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
