/**
 * backend/src/db/client.ts
 *
 * Thin query + transaction helpers over the shared `pg.Pool` singleton.
 *
 * This module hosts the two convenience functions every repository in
 * `backend/src/repositories/` consumes:
 *
 *   - {@link query}           — single-shot SELECT/INSERT/UPDATE/DELETE.
 *   - {@link withTransaction} — atomic multi-statement BEGIN/COMMIT block.
 *
 * It intentionally stays TINY. Any helper beyond the two listed exports
 * (e.g. `queryOne`, `queryPaginated`, custom row-mapper machinery) belongs
 * in the calling repository module where per-resource business logic lives.
 *
 * ============================================================================
 * Authority (verbatim from the Agent Action Plan)
 * ============================================================================
 *
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/db/client.ts | Query helpers with pool acquisition,
 *        release, and OTel span annotation"
 *
 *   - AAP §0.6.4 Track 1 Backend API (T1-C):
 *       "CREATE | backend/src/db/client.ts | Query helpers"
 *
 *   - AAP §0.8.1 Rule R2 (verbatim):
 *       "No credential material in logs. Log records MUST NOT contain
 *        passwords, bearer tokens, session tokens, or API keys. MUST
 *        enforce via pino serializer allow-list, not per-call discipline."
 *
 *   - AAP §0.8.1 Rule C4 / R6 (verbatim relevant excerpt):
 *       "C4 — OpenTelemetry auto-instrumentation registration order. This
 *        is required because auto-instrumentation monkey-patches `pg`,
 *        `http`, and `express`."
 *
 *   - Story ST-032-AC3 (atomic order creation):
 *       "Requests with empty carts, malformed line items, or invalid
 *        references to designs are rejected with descriptive errors and
 *        leave the persistence layer unchanged."
 *
 *   - Story ST-034-AC3 (coherent state on finalize failure):
 *       "Finalization is rejected with a descriptive error … and leaves
 *        the persisted order state coherent (either fully finalized or
 *        unchanged)."
 *
 *   - Story ST-047-AC4 (serializer-enforced no-credentials log contract):
 *       "No emitted log record … contains passwords, bearer tokens,
 *        session identifiers, API keys … this exclusion is enforced by a
 *        documented serializer or allow-list mechanism so that
 *        sensitive-data redaction is a verifiable property of the logging
 *        contract rather than an ad-hoc per-call discipline."
 *
 *   - Story ST-043 (deterministic, local-only, no-network unit suite):
 *       The corresponding unit suite at `backend/src/db/client.test.ts`
 *       exercises every code path through this module without touching
 *       a real database.
 *
 * ============================================================================
 * Contract invariants
 * ============================================================================
 *
 *   1. THIN WRAPPERS ONLY
 *      No ORM, no query builder, no caching layer. Raw SQL with `$N`
 *      parameter placeholders is the contract; this matches the user
 *      prompt §3 "Database client" = `pg` directly.
 *
 *   2. POOL SINGLETON
 *      The `pg.Pool` is acquired via {@link getPool} from `./pool` —
 *      NEVER instantiated here. Instantiation happens exactly once in
 *      `backend/src/index.ts` via the bootstrap's call to
 *      `initializePool()`. Rule C3 places connection-string handling
 *      entirely in `pool.ts`; this file is unaware of `DATABASE_URL`.
 *
 *   3. NO MANUAL OPENTELEMETRY SPANS (Rule C4 / R6)
 *      `@opentelemetry/auto-instrumentations-node` is registered FIRST in
 *      `backend/src/tracing.ts` (per Rule R6) and monkey-patches the
 *      `pg` module. Every call to `pool.query(...)` or `client.query(...)`
 *      automatically opens a span with `db.statement`, `db.operation`,
 *      `db.system = 'postgresql'`, `db.name`, and duration attributes.
 *      Manual spans here would DUPLICATE those auto-spans and produce
 *      operator confusion in trace viewers. This file therefore has
 *      ZERO `@opentelemetry/*` imports.
 *
 *   4. RULE R2 COMPLIANCE
 *      The `db.query.error` log record below DOES NOT include the
 *      `params` array. Even after Firebase-only authentication, request
 *      payloads can contain user-supplied credential-shaped strings
 *      (e.g. an attacker logging in with `password: "SENTINEL_CRED_99"`
 *      per the Rule R2 user example). Excluding `params` from log records
 *      enforces the allow-list discipline CENTRALLY rather than relying
 *      on per-call review. The SQL TEXT itself is safe to log because it
 *      is application-authored and uses positional placeholders (`$1`,
 *      `$2`); user values never appear in the SQL string.
 *
 *   5. CLIENT RELEASE IN `finally`
 *      {@link withTransaction} returns the acquired `PoolClient` to the
 *      pool from a `finally` block on EVERY path — successful commit,
 *      failed BEGIN, callback throw, failed COMMIT, failed ROLLBACK.
 *      Without this, an exception in the catch arm of a try/catch that
 *      forgot the finally would silently leak clients until pool
 *      exhaustion.
 *
 *   6. ORIGINAL ERROR PRECEDENCE
 *      If the callback throws AND the subsequent ROLLBACK also throws,
 *      the ORIGINAL callback error is re-thrown to the caller. The
 *      ROLLBACK error is logged (`event: 'db.transaction.rollback.failed'`)
 *      so operators see the connection-dropout pattern, but the caller's
 *      control flow sees the actual root cause. Re-throwing the rollback
 *      error would mask the real failure and make incidents debuggable
 *      only by reading server logs.
 *
 *   7. POOL-VS-CLIENT DISCIPLINE FOR TRANSACTION CALLBACKS
 *      Inside the {@link withTransaction} callback, all queries MUST go
 *      through the supplied `client.query(...)` — NEVER through the
 *      module-level `query(...)` helper or `getPool().query(...)`. The
 *      pool acquires a FRESH client per call (internally via
 *      `pool.connect()`), so a stray pool-level query inside a
 *      transactional callback runs on a DIFFERENT connection — outside
 *      the transaction — which silently breaks atomicity.
 *
 * ============================================================================
 * Forbidden patterns (per AAP Phase 7 of this file's prompt)
 * ============================================================================
 *
 *   - DO NOT import `Pool` (or any other runtime export) from `pg`. Only
 *     the type-only `PoolClient` import is allowed; the runtime `pg.Pool`
 *     is owned by `./pool`.
 *   - DO NOT instantiate `new Pool(...)` here. Violates the single-pool
 *     invariant.
 *   - DO NOT add `@opentelemetry/api` imports or `trace.getTracer(...)`
 *     calls. Auto-instrumentation is the SOLE source of pg spans.
 *   - DO NOT log the `params` array on the error path (Rule R2).
 *   - DO NOT omit the `finally` block or move `client.release()` into
 *     `try` or `catch`. The release MUST run on every path.
 *   - DO NOT mask the original callback error with the rollback error.
 *     The rollback error is LOGGED, never re-thrown.
 *   - DO NOT read `process.env.*` here. Env handling lives in
 *     `./pool` (Rule C3).
 *   - DO NOT change the `query` return type from `Promise<T[]>` to
 *     `Promise<QueryResult<T>>`. Repositories want rows; the `rowCount`
 *     escape hatch is reachable via `getPool().query(...)` if ever needed.
 *
 * ============================================================================
 * Used by
 * ============================================================================
 *
 *   - `backend/src/repositories/user.repository.ts`
 *   - `backend/src/repositories/session.repository.ts`
 *   - `backend/src/repositories/design.repository.ts`
 *   - `backend/src/repositories/share-link.repository.ts`
 *   - `backend/src/repositories/order.repository.ts` (also accepts a
 *     `PoolClient` for its atomic createOrderFromCart flow per ST-032)
 *   - `backend/src/services/order.service.ts` may invoke
 *     {@link withTransaction} when orchestrating cross-repository atomic
 *     operations.
 */

// Type-only import per `@typescript-eslint/consistent-type-imports`.
// `PoolClient` is used SOLELY as the parameter type of the callback passed
// to {@link withTransaction}; no runtime `pg` code is loaded by this file.
// Rule C3 places all runtime `pg.Pool` instantiation in `./pool.ts`.
import type { PoolClient } from 'pg';

import { getPool } from './pool';
import { logger } from '../logging/pino';

/**
 * Executes a single parameterized SQL statement against the shared pool
 * and returns the resulting rows array typed as `T[]`.
 *
 * Prefer this helper over direct `pool.query()` calls for readability in
 * repository modules:
 *
 * ```ts
 * import { query } from '../db/client';
 *
 * interface UserRow { id: string; email: string; created_at: Date; }
 *
 * const rows = await query<UserRow>(
 *   'SELECT id, email, created_at FROM users WHERE id = $1 LIMIT 1',
 *   [userId],
 * );
 * ```
 *
 * Parameterization (CRITICAL):
 *   Callers MUST use `$1`, `$2`, … placeholders with the `params` array.
 *   Never string-interpolate user values into the SQL text — that is the
 *   classic SQL-injection vector. `pg` binds the `params` array to the
 *   server using the extended-query protocol, so user input is never
 *   parsed as SQL.
 *
 * Observability:
 *   The underlying `pg` module is auto-instrumented by
 *   `@opentelemetry/auto-instrumentations-node` (registered first in
 *   `backend/src/tracing.ts` per Rule R6). Every invocation produces a
 *   trace span with SQL statement, duration, status, and database
 *   attributes. Rule C4 forbids ADDITIONAL manual spans here — the
 *   auto-span is the canonical record.
 *
 * Logging on failure (Rule R2):
 *   On query failure we emit a structured `event: 'db.query.error'`
 *   record with the error object and computed duration — but NOT the
 *   `params` array. Params can contain user-supplied values that may
 *   include credential-shaped strings; excluding them centralises the
 *   no-credentials-in-logs invariant rather than relying on per-call
 *   discipline at every call site.
 *
 *   The SQL TEXT is safe to log because it is application-authored and
 *   uses positional placeholders; user values never appear in it. Pino
 *   propagates the `correlationId`, `uid`, `traceId`, and `spanId`
 *   fields automatically via the mixin in `../logging/pino.ts`, so the
 *   emitted record can be joined to the originating request and trace
 *   without any per-call work here.
 *
 * Error semantics (Rule R8 — fail closed):
 *   Errors from the underlying driver are RE-THROWN verbatim after the
 *   `db.query.error` record is emitted. The caller's error handler
 *   (Express error middleware in `index.ts`) is responsible for HTTP
 *   response and user-facing messaging. This module never swallows
 *   errors and never wraps them in a different error class — preserving
 *   the original `pg` error code (e.g. `'23505'` for UNIQUE violations)
 *   so callers can branch on it.
 *
 * @template T - The expected row shape. Defaults to `unknown` if the
 *   caller omits the type parameter; supplying a concrete shape (e.g.
 *   `query<UserRow>(...)`) lets the consumer treat the result as
 *   `UserRow[]` without an extra cast at the call site.
 * @param sql - Parameterized SQL statement using `$1`, `$2`, …
 *   placeholders. MUST NOT contain interpolated user input.
 * @param params - Positional parameter values. Defaults to an empty
 *   array; pass a non-empty array when the SQL uses `$N` placeholders.
 *   Type is `unknown[]` (rather than `any[]`) so callers must narrow
 *   types explicitly at the call site, catching accidental `undefined`
 *   parameter bugs.
 * @returns A promise resolving to the `rows` array from the query
 *   result, typed as `T[]`. Empty results return `[]`, never `null`.
 * @throws Re-throws any error from the underlying `pg` driver after
 *   logging a `db.query.error` record. The thrown error is the original
 *   `pg.DatabaseError` (or its subclass) with all native fields intact.
 */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = getPool();
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    // The runtime row shape is determined by the SQL projection; the
    // caller asserted the shape via the `T` type parameter. `pg` types
    // rows as `any[]` on its own, so the cast here is the documented
    // boundary between the structurally-typed JS result and the
    // nominal `T` the caller supplied. Schema-vs-type drift is caught
    // by integration tests, not at this boundary.
    return result.rows as T[];
  } catch (err) {
    logger.error(
      {
        event: 'db.query.error',
        err,
        durationMs: Date.now() - start,
        // Rule R2: intentionally omit `params` — they may contain
        // user-supplied values that would violate the
        // credential-material-in-logs rule. The SQL text is also omitted
        // here because the auto-instrumentation span (configured in
        // `src/tracing.ts`) already records `db.statement`; duplicating it
        // in the log record adds noise without adding diagnostic value.
        // Operators correlate the error log with the trace via the
        // `traceId` / `spanId` fields injected by the pino mixin.
      },
      'Database query failed',
    );
    throw err;
  }
}

/**
 * Runs a callback inside a PostgreSQL transaction block.
 *
 * The callback receives a dedicated {@link PoolClient} that represents
 * the transactional connection; ALL queries executed inside the
 * transaction MUST use this client (not the pool), otherwise the query
 * runs on a DIFFERENT connection — outside the transaction — and the
 * atomicity contract is silently broken.
 *
 * Lifecycle:
 *   1. Acquire a client from the pool (`pool.connect()`).
 *   2. Issue `BEGIN`.
 *   3. Invoke the callback with the acquired client.
 *   4. On callback success: issue `COMMIT` and return the callback's
 *      resolved value.
 *   5. On callback failure (or BEGIN/COMMIT failure): issue `ROLLBACK`
 *      best-effort.
 *   6. ALWAYS release the client back to the pool (finally block).
 *
 * Error semantics:
 *   - If the callback throws, the THROWN error is re-raised to the
 *     caller (NOT any subsequent ROLLBACK failure — that is logged
 *     only). This is the canonical pg idiom and preserves operator
 *     visibility into the actual failure root cause.
 *   - If `BEGIN` itself fails, the error propagates without invoking
 *     the callback; ROLLBACK is still attempted (a no-op against a
 *     non-existent transaction is harmless), and `release()` runs via
 *     the finally block.
 *   - If `COMMIT` fails, the COMMIT error propagates up the catch arm
 *     where ROLLBACK is then attempted. pg may already consider the
 *     transaction terminated; the ROLLBACK is best-effort and any
 *     failure there is logged but not re-thrown.
 *   - If the callback's operation AND the rollback BOTH fail, the
 *     ORIGINAL callback error is preserved; the rollback failure is
 *     logged via `event: 'db.transaction.rollback.failed'` for
 *     operator visibility.
 *
 * Caller responsibility:
 *
 * ```ts
 * await withTransaction(async (client) => {
 *   await client.query('INSERT INTO orders ...');       // ✓ uses client
 *   await client.query('INSERT INTO order_items ...');  // ✓ uses client
 * });
 * ```
 *
 * NOT:
 *
 * ```ts
 * await withTransaction(async () => {
 *   await query('INSERT INTO orders ...');              // ✗ uses pool!
 * });
 * ```
 *
 * The latter form silently breaks atomicity because the `query` helper
 * obtains a FRESH client from the pool, so the INSERT runs OUTSIDE the
 * transaction; a subsequent failure cannot ROLLBACK the row.
 *
 * Why ROLLBACK failures are logged-only:
 *   If the ROLLBACK itself fails (typically because the connection died
 *   mid-transaction — Cloud SQL proxy restart, TCP RST, server-side
 *   query cancellation), the callback's original error is the one the
 *   caller needs to understand. Re-throwing the rollback error would
 *   MASK the real cause. We log `db.transaction.rollback.failed` so
 *   operators can investigate connection-dropout patterns separately,
 *   but the caller's control flow sees the original error.
 *
 * Why we do NOT pass an error argument to `client.release()`:
 *   `pg.PoolClient.release(err?)` discards the client (closes the
 *   underlying socket) when called with an error argument. For our
 *   error cases either:
 *     (a) the connection is still valid (callback threw a business
 *         error, not a DB error) — discarding it would needlessly burn
 *         a TCP setup; or
 *     (b) pg has already detected a dead connection from a failed query
 *         and will discard the client on plain `release()` anyway.
 *   Passing the error explicitly is a micro-optimization that risks
 *   masking pool behaviour and is NOT a Rule C3 concern.
 *
 * Used by:
 *   - `backend/src/services/order.service.ts` for the atomic order
 *     creation flow (ST-032-AC3 requires "leave the persistence layer
 *     unchanged" on failure).
 *   - `backend/src/services/order.service.ts` for the finalize flow
 *     (ST-034-AC3 requires "leaves the persisted order state coherent").
 *   - Any future cross-repository atomic operation.
 *
 * @template T - The callback's return type. Inferred from the callback's
 *   resolved value, e.g. `withTransaction(async (c) => 42)` resolves to
 *   `Promise<number>`.
 * @param fn - Async callback receiving a `PoolClient` that carries the
 *   transaction. The callback MUST use `client.query(...)` for every
 *   statement that should participate in the transaction.
 * @returns A promise resolving to the callback's value on COMMIT, or
 *   rejecting with the original callback / BEGIN / COMMIT error on
 *   failure.
 * @throws The error thrown by the callback, BEGIN, or COMMIT —
 *   whichever occurred first. ROLLBACK failures are logged via
 *   `event: 'db.transaction.rollback.failed'` but are NEVER re-thrown.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Best-effort rollback. Wrap in its own try/catch so a rollback
    // failure cannot mask the original error — the caller needs to
    // see WHY the transaction failed, not WHY the cleanup failed.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error(
        {
          event: 'db.transaction.rollback.failed',
          // The pino `err` serializer (configured in ../logging/pino.ts)
          // emits the standard error shape (type, message, stack). The
          // log record carries `correlationId`, `uid`, `traceId`, and
          // `spanId` automatically via the pino mixin so this entry
          // joins the originating request flow.
          err: rollbackErr,
        },
        'ROLLBACK failed after transaction error',
      );
    }
    throw err;
  } finally {
    // ALWAYS return the client to the pool. `pg.PoolClient.release()` is
    // synchronous and never throws in practice; calling it on every
    // path (success, rollback, rollback-after-rollback-failure) prevents
    // silent client leaks that would eventually exhaust the pool.
    client.release();
  }
}
