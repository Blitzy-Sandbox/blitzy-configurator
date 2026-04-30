/**
 * Liveness and readiness probe endpoints — ST-048 (AC3, AC4, AC5).
 *
 * Exposes:
 *   - GET /healthz  — liveness:  always 200 `{"status":"ok"}` while
 *                                 the Express loop is alive. Never
 *                                 queries the DB.
 *   - GET /readyz   — readiness: 200 `{"status":"ready"}` when the
 *                                 PostgreSQL pool answers a `SELECT 1`
 *                                 within `READYZ_DB_TIMEOUT_MS`; 503
 *                                 `{"status":"not_ready"}` otherwise.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/routes/health.ts | /healthz (liveness) and /readyz
 *        (readiness; 503 when DB unreachable) (ST-048)`.
 *   - AAP §0.6.5 Track 1 Gate T1-D verification:
 *       `curl -sf localhost:3000/readyz | jq -r '.status'`  → `ready`
 *       `docker compose stop postgres && sleep 3;
 *        curl -s -o /dev/null -w "%{http_code}" localhost:3000/readyz`
 *       → `503`
 *   - Story ST-048-AC3 (verbatim): "Each service exposes a liveness
 *     probe endpoint that returns a documented success status when the
 *     process is running and a documented failure status when the
 *     process has entered a non-recoverable state."
 *   - Story ST-048-AC4 (verbatim): "Each service exposes a readiness
 *     probe endpoint, distinct from the liveness probe, that returns a
 *     documented success status only when the service is prepared to
 *     accept traffic (dependencies reachable, warm-up complete) and a
 *     documented failure status otherwise."
 *   - Story ST-048-AC5 (verbatim): "The metrics endpoint and both probe
 *     endpoints can be reached and interpreted in the local development
 *     environment without any cloud access".
 *
 * Architectural rationale (Google SRE / Kubernetes / Cloud Run):
 *
 *   Liveness vs readiness is a load-bearing distinction:
 *     - LIVENESS failure ⇒ orchestrator RESTARTS the container.
 *     - READINESS failure ⇒ orchestrator DIVERTS TRAFFIC but the
 *       container keeps running. No restart.
 *   Conflating the two (e.g. liveness probes that query the DB)
 *   produces restart loops on every transient downstream hiccup. We
 *   therefore deliberately keep `/healthz` cheap and dependency-free.
 *
 *   Readiness uses `SELECT 1`, NEVER an application-table query:
 *     - It avoids coupling probe success to schema state — schema
 *       migrations would otherwise be able to take an instance off-line
 *       inadvertently.
 *     - It is a tiny round-trip (≈ a few ms) so the probe stays inside
 *       the platform's probe timeout (Cloud Run's default is 4 s).
 *     - The query is parameterless so PostgreSQL caches the plan and
 *       has zero CPU cost beyond the network round-trip.
 *
 *   Bounded timeout (`READYZ_DB_TIMEOUT_MS = 3_000`):
 *     - Without a soft timeout, a stuck DB (e.g. PostgreSQL in recovery
 *       mode, or a TCP black hole from a misconfigured firewall) would
 *       hang the readiness probe until Cloud Run's hard probe-timeout
 *       (4 s) tears the connection down. That manifests as connection-
 *       reset noise in the platform logs rather than a clean 503.
 *     - 3 s leaves 1 s of headroom under the platform default.
 *     - The underlying `pool.query` is NOT cancelled — the DB will
 *       finish (or fail) the query in the background; we just stop
 *       waiting on it.
 *
 * Cross-cutting rule compliance:
 *   - Rule R1 (story ACs): /healthz delivers AC3 verbatim; /readyz
 *     delivers AC4 verbatim — both use the documented `{status: ...}`
 *     envelope; both are reachable in the local environment per AC5.
 *   - Rule R2 (no credentials in logs): the 503 response body is
 *     `{"status":"not_ready"}` — nothing more. The raw pg error text
 *     contains the connection target (e.g. `connect ECONNREFUSED
 *     127.0.0.1:5432`); that operational topology is logged via the
 *     pino warn channel where `pino`'s redaction allow-list (defined
 *     in `../logging/pino.ts`) takes another defensive pass. The error
 *     message is also truncated to 200 characters before it touches
 *     a log line, keeping log lines bounded.
 *   - Rule R3 (no JWT lib in source): N/A — this file never touches
 *     authentication.
 *   - Rule R4 (no env defaults): N/A — this module reads no env vars.
 *     The port the probe is reachable on is bound by `index.ts`.
 *   - Rule R5 (GCS v7 signed URL syntax): N/A — no GCS interaction.
 *   - Rule R6 (OTel registration order): N/A — this module is a leaf
 *     and is loaded from `index.ts` AFTER the OTel SDK has registered
 *     its auto-instrumentations.
 *   - Rule R8 (gates fail closed): every failure path (`pool.query`
 *     rejected, timeout exceeded, defensive error in handler setup)
 *     returns 503. There is NO branch in this file that returns 200
 *     while the DB is unreachable.
 *   - Rule R9 (no payment processors): N/A.
 *   - Rule R10 (migration filenames): N/A — not a migration file.
 *
 * Mounting (composition root contract):
 *   The composition root in `backend/src/index.ts` mounts the returned
 *   Router at the application ROOT — NOT under `/api`. This matches
 *   the conventional probe paths consumed by Cloud Run, Kubernetes
 *   liveness/readiness probes, and Prometheus blackbox exporters,
 *   which look for `/healthz` and `/readyz` without any prefix.
 *
 * Design discipline:
 *   - Factory pattern: `createHealthRoutes({ pool })` returns the
 *     `Router`. Dependency injection keeps the module mockable in unit
 *     tests (the unit suite passes a stubbed `Pool`-shaped object) and
 *     keeps the module agnostic to how the pool was constructed
 *     (`backend/src/db/pool.ts` owns construction).
 *   - Defensive validation: the factory throws synchronously on
 *     missing or malformed dependencies. A misconfigured composition
 *     root is a bootstrap-time defect; we want it to surface
 *     immediately, not the first time `/readyz` is hit in production.
 *   - Late-rejection containment: `pool.query` may reject AFTER the
 *     timeout has already won the race. Without an explicit rejection
 *     handler the rejection would become an unhandled promise
 *     rejection — which, on Node 15+ with the default
 *     `unhandledRejection` mode, terminates the process. We therefore
 *     attach a rejection handler that captures the error and resolves
 *     to `false` so `Promise.race` always resolves cleanly.
 *   - Timer cleanup: when the DB query wins the race, the still-
 *     pending `setTimeout` is cleared so the Node event loop is not
 *     held open by a defunct timer (matters under load).
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum time (milliseconds) the readiness probe will wait for a
 * `SELECT 1` round-trip before declaring the DB unreachable.
 *
 * Sized at 3 s to leave at least 1 s of headroom under Cloud Run's
 * default probe timeout (4 s). Any value above the platform timeout
 * defeats the purpose of the soft timeout.
 *
 * Documented separately from the implementation so a downstream
 * operator (or an integration test) can find and verify the tolerance
 * without reading the handler body.
 */
const READYZ_DB_TIMEOUT_MS = 3_000;

/**
 * Maximum number of characters of the captured DB error's `.message`
 * that we admit into a log record. Bounded so a malicious or
 * misconfigured upstream cannot push enormous strings into log
 * pipelines (which inflate log storage cost and can mask other log
 * records by truncating them downstream).
 */
const MAX_LOGGED_ERROR_MESSAGE_LENGTH = 200;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Dependency contract for {@link createHealthRoutes}.
 *
 * A single member: the PostgreSQL connection pool used by the
 * readiness probe to test DB reachability. Construction of the pool
 * is owned by `backend/src/db/pool.ts`; this file only consumes the
 * already-constructed reference. Keeping ownership and consumption in
 * separate modules:
 *
 *   - lets unit tests inject a stubbed pool with a synthetic
 *     `query()` implementation;
 *   - lets integration tests share a single real pool across
 *     several routers;
 *   - keeps Rule R4 (env-var validation) localised in `db/pool.ts`,
 *     not duplicated here.
 */
export interface CreateHealthRoutesDeps {
  /**
   * The PostgreSQL connection pool. Only `pool.query` is used by this
   * module — no transactions, no listen/notify, no client checkouts.
   */
  pool: Pool;
}

/**
 * Build the Express `Router` exposing the liveness and readiness
 * probes.
 *
 * @param deps - The composition-root supplied dependencies. Only
 *               `pool` is required; see {@link CreateHealthRoutesDeps}.
 * @returns An Express `Router` with `GET /healthz` and `GET /readyz`
 *          mounted at its root. The composition root mounts this
 *          router at the application ROOT (not under `/api`).
 *
 * @throws `Error` synchronously if `deps` is null/undefined, or if
 *          `deps.pool.query` is not a function. A misconfigured
 *          bootstrap is a startup-time defect and we surface it
 *          immediately rather than at the first probe call.
 */
export function createHealthRoutes(deps: CreateHealthRoutesDeps): Router {
  // Defensive validation. Express won't reach this block during normal
  // bootstrap (the composition root constructs `deps` directly), but a
  // fault here is far easier to debug as a synchronous startup failure
  // than as a 500 on the first probe request after deploy.
  if (deps === null || deps === undefined) {
    throw new Error('createHealthRoutes: dependencies object is required');
  }
  // `deps.pool` should be a non-null `Pool` instance. We allow any
  // truthy value here so unit tests can inject a stubbed pool, but we
  // explicitly reject `undefined`/`null` to surface composition-root
  // bugs at bootstrap time.
  if (deps.pool === null || deps.pool === undefined) {
    throw new Error('createHealthRoutes: pool dependency is required');
  }
  if (typeof deps.pool.query !== 'function') {
    throw new Error('createHealthRoutes: pool must implement query()');
  }

  const { pool } = deps;
  const router = Router();

  // ── GET /healthz — liveness ───────────────────────────────────────
  // Returns 200 `{"status":"ok"}` for as long as the Express loop is
  // alive. We DO NOT query the database here on purpose: a liveness
  // failure causes the orchestrator to RESTART the pod, and we never
  // want a transient DB hiccup to escalate into a restart loop.
  router.get('/healthz', (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // ── GET /readyz — readiness ───────────────────────────────────────
  // Returns 200 `{"status":"ready"}` when DB is reachable, 503
  // `{"status":"not_ready"}` otherwise. Readiness failure causes the
  // orchestrator to DIVERT TRAFFIC away from this replica without
  // restarting it — exactly the behaviour we want when the DB is
  // briefly unavailable.
  //
  // Implemented as a non-async handler that delegates to an async
  // worker. This keeps the handler signature aligned with Express's
  // `void`-returning `RequestHandler` type (and with the project's
  // `@typescript-eslint/no-misused-promises` rule), while preserving
  // the readability of `await` inside the worker.
  router.get('/readyz', (req: Request, res: Response, next: NextFunction): void => {
    void handleReadinessProbe(pool, req, res).catch((err: unknown) => {
      // The worker swallows expected failure modes internally. Anything
      // reaching this catch is an UNEXPECTED error in our own logic
      // (e.g. a programming defect in this file). Forward to Express's
      // error handler so the central error middleware can log + return
      // 500 with the redacting pino logger.
      next(err);
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Async worker for the readiness probe.
 *
 * Race semantics:
 *   - `readinessCheck` resolves with `true` on `SELECT 1` success,
 *     `false` on `SELECT 1` failure (with the error captured in
 *     `capturedDbError` for logging). It NEVER rejects — that
 *     guarantees `Promise.race` itself never rejects, eliminating the
 *     unhandled-rejection footgun.
 *   - `timeout` resolves with `false` after `READYZ_DB_TIMEOUT_MS`.
 *
 * Outcome interpretation:
 *   - race → `true` ⇒ DB answered in time → 200 ready.
 *   - race → `false` AND `capturedDbError !== null` ⇒ DB rejected
 *     before the timeout fired → 503 not_ready (with DB error logged).
 *   - race → `false` AND `capturedDbError === null` ⇒ timeout fired
 *     first → 503 not_ready (with synthetic timeout error logged).
 *
 * Observability:
 *   On every 503, we emit a single `WARN` log record via the
 *   request-scoped pino logger. The record is bounded in size (the
 *   error message is truncated) and never includes the response body
 *   itself — operational info for operators stays out of the response
 *   that may be returned to less-trusted clients.
 */
async function handleReadinessProbe(pool: Pool, req: Request, res: Response): Promise<void> {
  // Absorb DB errors into the resolution path. Two consequences:
  //   1. `Promise.race` never sees a rejection, so it never rejects.
  //   2. We retain the error object in `capturedDbError` for logging
  //      AFTER the race settles, regardless of which racer won.
  let capturedDbError: unknown = null;
  const readinessCheck: Promise<boolean> = pool.query('SELECT 1').then(
    () => true,
    (err: unknown) => {
      capturedDbError = err;
      return false;
    },
  );

  // Bounded timeout. We track the timer id so we can clear it when the
  // DB query wins the race — leaving an active `setTimeout` in the
  // event loop would (a) hold the loop open at process shutdown until
  // the timer fires and (b) accumulate dozens of concurrent timers
  // under high probe traffic.
  let timeoutId: NodeJS.Timeout | undefined;
  const timeout: Promise<false> = new Promise<false>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(false);
    }, READYZ_DB_TIMEOUT_MS);
  });

  let ready: boolean;
  try {
    ready = await Promise.race([readinessCheck, timeout]);
  } finally {
    // Clear the timer regardless of which racer won. If the DB won,
    // this prevents the unused timer from sitting in the event loop.
    // If the timeout already fired, `clearTimeout` is a no-op.
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  if (ready) {
    res.status(200).json({ status: 'ready' });
    return;
  }

  // DB unreachable OR slow. Distinguish for the log record so operators
  // can tell the two failure modes apart in dashboards. The response
  // body, however, is the SAME for both — we never leak which mode
  // failed to less-trusted clients.
  const failureErr: unknown =
    capturedDbError !== null ? capturedDbError : new Error('readiness check timed out');
  logReadinessFailure(req, failureErr);
  res.status(503).json({ status: 'not_ready' });
}

/**
 * Emit a single bounded WARN log record for a readiness failure.
 *
 * The log record is intentionally minimal:
 *   - `event` — fixed identifier for log-pipeline filtering and
 *     dashboard panels (ST-049-AC5 alert policy: "readiness failures
 *     per minute").
 *   - `errorName` — the JS error class name (`Error`, `TypeError`,
 *     pg's named errors) for quick alerting on specific classes.
 *   - `errorMessage` — the error's human-readable message, truncated
 *     defensively. We never include `.stack` or `.cause` here: those
 *     would expose call-site detail (file paths, internal modules)
 *     and increase log volume substantially.
 *
 * If `req.log` is absent (e.g. in unit tests that skip the request-
 * scoped logger middleware), this function is a silent no-op — never
 * a throw. A logger-binding bug must NEVER prevent a 503 from being
 * returned to the orchestrator.
 *
 * Rule R2: this function is the ONLY place in this file where error
 * detail enters a log record, and the truncation cap bounds the
 * blast radius of any unexpectedly large error message.
 */
function logReadinessFailure(req: Request, err: unknown): void {
  // Read the request-scoped logger via a typed cast. The cast is
  // structural (we only require a `.warn(obj, msg?)` shape) so unit
  // tests can inject a minimal logger without depending on pino.
  const log = (
    req as unknown as {
      log?: { warn: (obj: unknown, msg?: string) => void };
    }
  ).log;
  if (log === undefined) {
    return;
  }

  // Defensive extraction. `err` is typed `unknown` because we cannot
  // assume the rejection from `pool.query` will always be an `Error`
  // instance — pg's older code paths and userland middlewares can
  // reject with strings, plain objects, or `null`. Optional chaining
  // plus narrow type assertions make every access a no-throw.
  const name = (err as { name?: string } | null | undefined)?.name;
  const rawMessage = (err as { message?: string } | null | undefined)?.message;
  const errorMessage =
    typeof rawMessage === 'string'
      ? rawMessage.slice(0, MAX_LOGGED_ERROR_MESSAGE_LENGTH)
      : undefined;

  log.warn(
    {
      event: 'health.readiness.failure',
      errorName: name,
      errorMessage,
    },
    'readiness probe failed',
  );
}
