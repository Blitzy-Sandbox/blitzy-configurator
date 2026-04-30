/**
 * PostgreSQL connection pool singleton — Rule C3 / R4 / R2 / R6.
 *
 * This module owns the ONE `pg.Pool` per process. Every repository in
 * `backend/src/repositories/` (and every call from `backend/src/db/client.ts`)
 * obtains the pool via {@link getPool} and issues queries against it. The
 * pool is started once at backend bootstrap (see `backend/src/index.ts`)
 * via {@link initializePool} and closed once at SIGTERM via {@link closePool}.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/db/pool.ts | pg connection pool reading DATABASE_URL (C3)"
 *   - §0.6.4 Track 1 Backend API (T1-C):
 *       "CREATE | backend/src/db/pool.ts | pg.Pool using DATABASE_URL only (C3)"
 *   - §0.8.1 Rule C3 (verbatim):
 *       "The database connection module in backend/src/db/ MUST construct a
 *        connection configuration entirely from DATABASE_URL. When running on
 *        Cloud Run, the URL form uses Unix socket host
 *        /cloudsql/<PROJECT>:<REGION>:<INSTANCE>. When running locally or in
 *        CI, the URL form uses TCP host 127.0.0.1 on port 5432. There must be
 *        zero hard-coded host paths in connection logic — both paths are
 *        encoded only in DATABASE_URL."
 *   - §0.8.1 Rule R4 (verbatim): "All six required environment variables MUST
 *     throw at startup when unset — no fallback values in source code.
 *     Verification: starting the backend without DATABASE_URL set exits
 *     non-zero with a descriptive error within 2 seconds."
 *
 * Rule C3 compliance — design summary:
 *   The single mechanism used here is `pg`'s built-in connection-string
 *   parser. Both URL forms are encoded in the URL itself; this module does
 *   NOT branch on environment, NEVER inspects K_SERVICE / NODE_ENV, and
 *   passes ONLY `connectionString` (plus C3-orthogonal performance tunables)
 *   to `PoolConfig`. The fields `host`, `port`, `user`, `password`,
 *   `database`, and `ssl` are intentionally ABSENT from the constructed
 *   config — every connection parameter is DERIVED from `connectionString`
 *   by `pg`'s parser:
 *
 *     TCP form (local / CI):
 *       postgres://postgres:postgres@127.0.0.1:5432/strikeforge
 *
 *     Unix-socket form (Cloud SQL via Cloud Run):
 *       postgres://user:pass@/strikeforge?host=/cloudsql/PROJECT:REGION:INSTANCE
 *
 *   When the URL's authority component contains no hostname (i.e. the
 *   `@` is followed directly by `/`), `pg` looks for a `host` query
 *   parameter — that is how the Unix-socket form works without any
 *   conditional code in this file.
 *
 * OpenTelemetry auto-instrumentation (Rule R6 / Constraint C4):
 *   `backend/src/tracing.ts` is imported as the FIRST line of
 *   `backend/src/index.ts`, which means by the time this module is
 *   evaluated and `import { Pool } from 'pg'` resolves, the `pg` module has
 *   already been monkey-patched by `@opentelemetry/instrumentation-pg`.
 *   Every query issued against the returned pool automatically produces a
 *   trace span with `db.statement`, `db.operation`, `db.system`, and
 *   duration attributes — NO manual OTel code is added (or required) in
 *   this file. Rule R6 is upheld by the import-order discipline of
 *   `index.ts`, not by anything written here.
 *
 * Observability (Rule R2):
 *   Background pool errors are logged via the pino logger with
 *   `event: 'db.pool.error'`. The logger applies its serializer allow-list
 *   to every record, so even if the underlying `Error` somehow carries
 *   credential-shaped properties (e.g. via a wrapped pg error that quoted
 *   a connection string in its message), pino's `err` serializer plus the
 *   redact-paths defense ensure no credential material reaches the log
 *   record. Pool lifecycle events (`db.pool.initialized`, `db.pool.closed`)
 *   carry only the operator-useful `poolMax` so diagnostics for pool-
 *   exhaustion incidents have the configured ceiling readily visible.
 *
 * Forbidden patterns (per AAP Phase 9 of this file's prompt):
 *   - DO NOT set `host`, `port`, `user`, `password`, `database`, or `ssl`
 *     fields on the PoolConfig. Rule C3 requires connection-string-only
 *     configuration.
 *   - DO NOT branch on `process.env.NODE_ENV`, `process.env.K_SERVICE`, or
 *     any other "are we on Cloud Run?" signal. Let pg parse the URL.
 *   - DO NOT read `process.env.DATABASE_URL` directly. Use `requireEnv`
 *     from `../config/env` so Rule R4 errors route through the validator.
 *   - DO NOT export the `pg.Pool` constructor. Callers MUST go through
 *     {@link getPool} so the process owns exactly one pool.
 *   - DO NOT add manual OTel spans. Auto-instrumentation covers `pg` per
 *     Rule R6 / C4.
 *   - DO NOT silently swallow the pool 'error' event. Always log via pino
 *     with `event: 'db.pool.error'`.
 *   - DO NOT eagerly call `pool.connect()` in {@link initializePool}.
 *     Eager connections (a) duplicate the readiness probe's job and
 *     (b) reduce effective pool capacity by holding a client until shutdown.
 */

import { Pool, type PoolConfig } from 'pg';

import { requireEnv } from '../config/env';
import { logger } from '../logging/pino';

/**
 * Module-level singleton reference.
 *
 * Re-set to `null` by {@link closePool} so a subsequent {@link initializePool}
 * call can create a fresh pool. This is what enables the integration-test
 * restart pattern (a single Node process starts the backend, runs a test,
 * tears down, and starts the backend again) without leaking a closed pool
 * reference across iterations.
 */
let pool: Pool | null = null;

/**
 * Default maximum pool size when `DATABASE_POOL_MAX` is unset.
 *
 * 10 is a deliberately conservative default for Cloud Run's per-instance
 * concurrency model: each instance defaults to ~80 concurrent requests, and
 * Cloud SQL's small/medium tiers cap connections at 25–100 — running with
 * `max=10` per instance leaves comfortable headroom for at least 2–10
 * concurrent instances before the DB connection ceiling becomes the
 * bottleneck. Operators can override via `DATABASE_POOL_MAX` for
 * higher-capacity tiers.
 */
const DEFAULT_POOL_MAX = 10;

/**
 * Default idle-client retention (milliseconds). Aligned with Cloud SQL's
 * default idle-connection timeout so that idle clients are recycled by
 * the pool BEFORE the DB server forcibly closes them — preventing the
 * spurious `connection terminated unexpectedly` errors that would
 * otherwise hit the {@link pool.on('error')} handler under quiet load.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Default connection-acquisition timeout (milliseconds). Bounded so that
 * the `/readyz` probe (ST-048-AC4) reports `not_ready` within a few
 * seconds of DB unreachability. The user prompt's Gate T1-D example uses
 * a 3-second sleep + probe; 5 seconds is comfortably above that to avoid
 * false negatives during transient slowness while still meeting the
 * "503 within ~5 seconds" expectation.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Resolve the pool's `max` (maximum concurrent clients) from the optional
 * `DATABASE_POOL_MAX` environment variable, falling back to
 * {@link DEFAULT_POOL_MAX} when unset.
 *
 * `DATABASE_POOL_MAX` is INTENTIONALLY NOT one of the six required env
 * vars enforced by Rule R4 — it is a performance tunable with a documented
 * safe default rather than a connection-target identifier. Per Rule R4 the
 * "no defaults in source code" constraint applies ONLY to the six listed
 * required vars (DATABASE_URL, FIREBASE_PROJECT_ID, GCS_BUCKET_NAME,
 * GCS_EMULATOR_HOST, COVERAGE_THRESHOLD, GCP_REGION); a default for a
 * non-required tunable does NOT violate it.
 *
 * Validation behaviour (defensive — avoids silent NaN propagation into
 * pg's pool internals where it would manifest as an opaque "unknown
 * pool size" failure mode):
 *   - Non-numeric override (`"abc"`) → falls back to default with a
 *     warning-level log so operators see the misconfiguration.
 *   - Negative or zero override (`"0"`, `"-1"`) → falls back to default
 *     with a warning-level log; pg requires a positive integer.
 *   - Valid positive integer override → returned verbatim.
 *
 * @returns The resolved positive integer pool maximum.
 */
function resolvePoolMax(): number {
  const raw = process.env['DATABASE_POOL_MAX'];
  if (raw === undefined || raw === '') {
    return DEFAULT_POOL_MAX;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      {
        event: 'db.pool.invalid_max_override',
        rawValue: raw,
        fallback: DEFAULT_POOL_MAX,
      },
      'DATABASE_POOL_MAX is not a positive integer; using default',
    );
    return DEFAULT_POOL_MAX;
  }
  return parsed;
}

/**
 * Creates (or returns the existing) singleton {@link Pool} from
 * `DATABASE_URL`.
 *
 * `pg`'s connection-string parser handles BOTH URL forms — local TCP and
 * Cloud SQL Unix socket — transparently. This module does NOT branch on
 * environment or attempt to detect Cloud Run vs local deployment. Rule C3
 * is satisfied by passing only `connectionString` (plus performance
 * tunables) to the {@link PoolConfig}.
 *
 * Idempotent: repeated calls return the same Pool instance. This protects
 * against accidental double-initialisation during bootstrap or in test
 * harnesses that may invoke setup twice.
 *
 * No eager connection probe: `pg.Pool` is LAZY — connections are
 * established on first query. Eager-connecting here would (a) duplicate
 * the readiness-probe's job (Gate T1-D, ST-048-AC4), and (b) turn startup
 * failures into unrelated config problems (slow DNS, missing
 * docker-compose service). The /readyz route is the documented place for
 * the eager `SELECT 1` probe.
 *
 * @throws {import('../config/env').MissingEnvVarError} When `DATABASE_URL`
 *   is unset or empty (Rule R4). The throw propagates out of this function
 *   to the bootstrap's outer `try`/`catch` in `backend/src/index.ts`,
 *   which logs and exits non-zero. Total elapsed wall-clock time from
 *   process start to non-zero exit is well under 2 seconds (Rule R4
 *   verification budget).
 * @returns The singleton {@link Pool}.
 */
export function initializePool(): Pool {
  if (pool !== null) {
    return pool;
  }

  // Rule R4: `requireEnv` throws a descriptive `MissingEnvVarError` when
  // `DATABASE_URL` is unset or empty. We deliberately do NOT catch the
  // error here — it propagates upward to the bootstrap so the process
  // exits non-zero within Rule R4's 2-second budget.
  const connectionString = requireEnv('DATABASE_URL');

  // The PoolConfig is constructed with ONLY the connection string plus
  // C3-orthogonal performance tunables. Intentionally ABSENT (Rule C3):
  //   host, port, user, password, database, ssl.
  // Every connection parameter is DERIVED from `connectionString` by
  // `pg`'s built-in URL parser.
  const config: PoolConfig = {
    connectionString,
    // Performance tunables (NOT C3-constrained — they configure pool
    // behaviour, not connection target):
    max: resolvePoolMax(),
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
  };

  const created = new Pool(config);

  // Background error handler (Rule R2 / operational footgun defense).
  //
  // `pg.Pool` emits `error` events for BACKGROUND failures: an idle
  // client's TCP connection is closed by the server, a Cloud SQL proxy
  // restart, a network blip while the client was checked back into the
  // pool. These do NOT reject in-flight queries; they are housekeeping
  // events. Without this listener Node's default EventEmitter behaviour
  // RE-THROWS the error on the next tick, terminating the backend
  // process — a major production correctness issue.
  //
  // The handler is intentionally simple: log via pino (which applies the
  // allow-list serializer per Rule R2) and return. The pool self-heals
  // by creating a new connection on the next query.
  created.on('error', (err: Error) => {
    logger.error({ event: 'db.pool.error', err }, 'Background pool error');
  });

  // Assign to the module-level singleton AFTER successful construction
  // and listener registration so that a hypothetical mid-construction
  // throw does not leave a half-initialised pool reachable via
  // {@link getPool}.
  pool = created;

  // Lifecycle log — operationally useful for diagnosing pool-exhaustion
  // incidents because the configured ceiling is visible without
  // inspecting environment variables on the running container.
  logger.info({ event: 'db.pool.initialized', poolMax: config.max }, 'Database pool initialized');

  return pool;
}

/**
 * Returns the initialized singleton {@link Pool}.
 *
 * Throws — rather than lazily initialising — to surface bootstrap-order
 * bugs LOUDLY. If any code path calls {@link getPool} before
 * {@link initializePool}, that is a programming error worth catching at
 * development time. Lazy initialisation here would mask such bugs by
 * silently building a pool from whatever environment happens to be
 * present at first call, sometimes crossing test boundaries in
 * unexpected ways.
 *
 * @throws {Error} When called before {@link initializePool}. The message
 *   identifies the bootstrap as the expected initialisation site so
 *   operators / developers can find it quickly.
 * @returns The initialized singleton {@link Pool}.
 */
export function getPool(): Pool {
  if (pool === null) {
    throw new Error(
      'Database pool not initialized. Call initializePool() from the backend bootstrap (src/index.ts) before any repository or route handler runs.',
    );
  }
  return pool;
}

/**
 * Gracefully ends the pool, draining active queries.
 *
 * Called during SIGTERM handling in `backend/src/index.ts`. Safe to call
 * when the pool has not yet been initialized (returns immediately) — this
 * defends the (extremely unlikely but defensible) scenario where
 * SIGTERM arrives between process start and the bootstrap's call to
 * {@link initializePool}.
 *
 * Ordering note: the module-level reference is cleared FIRST, then
 * `pool.end()` is awaited. The "clear-first" ordering means a concurrent
 * {@link getPool} call arriving DURING shutdown fails fast with the
 * "not initialized" error rather than receiving a half-closed pool.
 * For the singleton-per-process model this matters only in test harnesses
 * (production has a single shutdown path), but is essentially free and
 * removes a class of races by construction.
 *
 * After `pool.end()` resolves the module is in the "uninitialised" state
 * — a subsequent {@link initializePool} call will create a fresh pool.
 * This supports the integration-test restart pattern where a test harness
 * starts the backend, runs a test, calls {@link closePool}, and starts
 * the backend again in the same Node process.
 *
 * `pool.end()` itself drains active queries (waits for every checked-out
 * client to be released back to the pool, then closes the underlying
 * sockets) before resolving. For Cloud Run's 10-second graceful-shutdown
 * window this is comfortable.
 *
 * @returns A promise that resolves when `pool.end()` completes.
 */
export async function closePool(): Promise<void> {
  if (pool === null) {
    return;
  }
  // Capture the reference, then clear the singleton FIRST so a
  // concurrent {@link getPool} call sees the uninitialised state
  // immediately (fail-fast) instead of returning a closing pool.
  const reference = pool;
  pool = null;
  await reference.end();
  logger.info({ event: 'db.pool.closed' }, 'Database pool closed');
}
