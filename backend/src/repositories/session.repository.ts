/**
 * Session repository — data-access layer for the `sessions` table.
 *
 * This module owns every direct read or write of the `sessions` table.
 * Higher layers (services, middleware, routes) depend ONLY on the typed
 * {@link SessionRepository} interface — they do not import `pg` and do not
 * know any SQL. Co-locating SQL with its schema knowledge keeps migration
 * changes localised and makes the layer trivially mockable in unit tests.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/repositories/session.repository.ts | CRUD for sessions table`
 *   - AAP §0.6.4 Track 1 T1-C: repositories belong to the dependency-ordered
 *     backend API implementation.
 *   - AAP §0.2.1 "Session persistence semantics":
 *       The `sessions` table becomes a revocation-list and issuance-audit
 *       log: a session row is created on login with the `uid`, issued
 *       timestamp, expiration timestamp, and a revocation marker; logout
 *       marks the row revoked; session validation cross-references the
 *       `verifyIdToken` result against the revocation marker.
 *   - Story ST-024 (login endpoint — session token issuance).
 *   - Story ST-025 (logout endpoint — session revocation).
 *   - Story ST-026 (session validation middleware contract).
 *   - Story ST-031 (users + sessions schema migration — defines the
 *     `sessions` table shape this repository targets).
 *
 * Architectural intent (AAP §0.2.1):
 *   The `sessions` table is a REVOCATION LIST, not a token store. Firebase
 *   Auth owns:
 *     - Token issuance (the JWT id token)
 *     - Cryptographic verification (`admin.auth().verifyIdToken`)
 *     - Token expiry enforcement (the `exp` claim inside the JWT)
 *
 *   PostgreSQL owns:
 *     - "Has this session been EXPLICITLY logged out by the user?" — the
 *       only thing this table adds beyond Firebase's own validation.
 *     - The audit-log of when login / logout happened locally.
 *     - Foreign-key linkage from session lifetime to local user records.
 *
 *   This split has three important consequences enforced in the code below:
 *     1. The {@link Session.tokenRef} value is a STABLE OPAQUE STRING — it is
 *        a hash, an opaque server-issued id, or another non-credential
 *        derivative supplied by the service layer. The raw Firebase id token
 *        is NEVER stored here (Rule R2).
 *     2. The active-status check ({@link SessionRepository.isActive}) runs in
 *        the database, not in JavaScript, so it uses PostgreSQL's `now()`
 *        rather than `Date.now()`. This is the only way to guarantee
 *        monotonic results across a multi-instance app where each Node
 *        process may have a slightly different system clock.
 *     3. {@link SessionRepository.markRevoked} is idempotent via
 *        `COALESCE(revoked_at, now())` so a second logout call against the
 *        same session preserves the ORIGINAL revocation timestamp — the
 *        truth of when the session was first terminated, which is what an
 *        audit trail wants to record.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): this repository never logs and
 *     never accepts raw Firebase id tokens. {@link InsertSessionParams.tokenRef}
 *     is documented as "a stable hash/derivative supplied by the service
 *     layer", not the JWT itself. There is no `password`, `Authorization`,
 *     `bearer`, or `credential` text anywhere in this file.
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. Token verification is the
 *     exclusive responsibility of `backend/src/auth/firebase-admin.ts`.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. The {@link Pool} is dependency-injected by the caller
 *     (`backend/src/db/pool.ts` builds the pool from `DATABASE_URL`).
 *   - R10 (migration filename pattern): N/A here; this module is consumed
 *     by — but does not author — the migration file
 *     `backend/migrations/{ts}_ST-031_users_sessions.js`.
 *
 * Design discipline:
 *   - Parameterised queries only. Every SQL constant uses `$1`, `$2`
 *     placeholders; user-supplied values flow through the `values` array of
 *     the `QueryConfig`. There is no string interpolation of input anywhere
 *     in this file (SQL-injection invariant).
 *   - The repository is constructed via a factory (`createSessionRepository`)
 *     rather than as a class. Factories make dependency injection explicit,
 *     support `Object.freeze` of the returned record (preventing accidental
 *     method monkey-patching), and play well with tree-shaking.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/db/pool.ts` — provides the `Pool` injected here.
 *   - `backend/src/services/session.service.ts` — calls `insert` (on login),
 *     `markRevoked` (on logout), and `findByTokenRef` / `isActive` (on
 *     middleware-time validation).
 *   - `backend/src/middleware/session.ts` — after `verifyIdToken`, calls
 *     `isActive(tokenRef)` to cross-check the revocation list (AAP §0.2.1).
 *   - `backend/src/routes/auth.ts` — login endpoint flows into `insert`;
 *     logout endpoint flows into `markRevoked` via the session service.
 *   - `backend/src/repositories/user.repository.ts` — the `users` table is
 *     the parent for the `user_id` foreign-key column.
 *   - `backend/migrations/{ts}_ST-031_users_sessions.js` — defines the
 *     schema this module targets.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Section 1: Public types — domain shape exposed to higher layers.
// ---------------------------------------------------------------------------

/**
 * A session row represents a login-to-logout interval for a single user.
 *
 * Field-level contract (this is the API every consumer of this module
 * relies on):
 *
 *   `tokenRef`
 *     A STABLE OPAQUE REFERENCE supplied by the service layer — typically a
 *     SHA-256 hash of the Firebase id token's `jti` claim, or a server-
 *     issued opaque session id. The raw Firebase id token is NEVER stored
 *     in this column (Rule R2 — no credential material in DB or logs). The
 *     repository does not enforce the derivation; it treats the value as
 *     an opaque unique string and relies on its caller to use a stable,
 *     non-credential representation.
 *
 *   `userId`
 *     The owning user's local primary key, which equals the Firebase `uid`
 *     per AAP §0.2.1. Backed by a foreign key to `users.id` with `ON
 *     DELETE CASCADE` so that deleting a user cleanly removes their
 *     sessions (relevant for test teardown and privacy compliance).
 *
 *   `issuedAt`
 *     The instant at which the session was created — for an audit log
 *     this is the local server-side timestamp of the login event.
 *
 *   `expiresAt`
 *     The instant after which the session must no longer be considered
 *     active, regardless of revocation status. The service layer derives
 *     this from the Firebase id token's `exp` claim or from a server-side
 *     policy; the repository just stores what it is told.
 *
 *   `revokedAt`
 *     `null` for active sessions; non-null for revoked sessions. The
 *     timestamp captures the moment of FIRST revocation — see
 *     {@link SessionRepository.markRevoked} for why subsequent revocation
 *     attempts preserve the original timestamp.
 *
 * The interface is fully `readonly` so consumers cannot mutate the record
 * after retrieval. To "update" a session, callers must go through repository
 * methods that explicitly construct a new row — making every mutation a
 * deliberate database write rather than an in-memory side-effect.
 */
export interface Session {
  /** Stable opaque reference supplied by the service layer; primary key. */
  readonly tokenRef: string;
  /** Owning user's id (= Firebase uid, per AAP §0.2.1). */
  readonly userId: string;
  /** Local server-side issue timestamp. */
  readonly issuedAt: Date;
  /** Expiration timestamp (typically derived from the JWT `exp` claim). */
  readonly expiresAt: Date;
  /** `null` for active sessions; the FIRST revocation timestamp otherwise. */
  readonly revokedAt: Date | null;
}

/**
 * Parameters accepted by {@link SessionRepository.insert}.
 *
 * Notice what is NOT here:
 *   - No raw bearer token, password, or credential field. The
 *     `tokenRef` slot accepts ONLY a stable, non-credential derivative
 *     produced by the service layer (Rule R2). The repository never sees
 *     and never stores the original Firebase id token.
 *   - No `revokedAt` parameter. New sessions are always active at insert
 *     time; the column defaults to `NULL` in the schema.
 *   - No server-side `now()` parameter. Both `issuedAt` and `expiresAt`
 *     are supplied by the caller because the service layer is the
 *     authoritative source for those values (e.g., `expiresAt` mirrors
 *     the Firebase `exp` claim — using the database's `now()` for
 *     issuance would risk drift between the JWT timeline and the
 *     application timeline).
 *
 * The shape is intentionally minimal: the smallest set of values that
 * uniquely defines a new session row.
 */
export interface InsertSessionParams {
  /**
   * Owning user's local id (= Firebase uid). Subject to the FK to
   * `users.id`; an unknown uid surfaces as a PG `23503`
   * (`foreign_key_violation`) error which the service layer translates
   * to HTTP 401 Unauthorized.
   */
  userId: string;
  /**
   * Stable opaque reference supplied by the service layer (NOT the raw
   * Firebase id token). Subject to the PRIMARY KEY constraint; collisions
   * (vanishingly rare with a SHA-256 hash) surface as PG `23505`
   * (`unique_violation`) which the service layer can translate to a
   * retry or HTTP 500.
   */
  tokenRef: string;
  /** Local server-side issue timestamp. */
  issuedAt: Date;
  /**
   * Expiration timestamp. Typically derived from the JWT `exp` claim so
   * the local revocation check and the cryptographic JWT check agree on
   * the session's natural end-of-life.
   */
  expiresAt: Date;
}

/**
 * Repository interface — the public contract callers depend on.
 *
 * Four methods, sized to the actual needs of stories ST-024/ST-025/ST-026:
 *
 *   - `insert(params)` — login (ST-024). Returns the persisted
 *     {@link Session}. Idempotent against PRIMARY KEY collision via an
 *     `ON CONFLICT (token_ref) DO UPDATE` clause: a repeated login that
 *     produces the same SHA-256 `tokenRef` (which Firebase Auth does for
 *     identical idTokens issued back-to-back) refreshes the row's
 *     `userId`, `issuedAt`, `expiresAt` and clears `revokedAt`, instead
 *     of raising PG `23505`. Foreign-key violations (PG `23503`) still
 *     surface to the service layer for translation to HTTP statuses.
 *
 *   - `findByTokenRef(tokenRef)` — diagnostic / debug lookups, plus support
 *     for service-layer flows that need the full row (e.g., to log the
 *     `userId` of the session being revoked). Backed by the PRIMARY KEY
 *     index, so this lookup is O(log n).
 *
 *   - `markRevoked(tokenRef)` — logout (ST-025). Idempotent via
 *     `COALESCE(revoked_at, now())` — a repeated call against an already-
 *     revoked session returns the row with the ORIGINAL revocation
 *     timestamp, NOT a new one. Returns `null` when no row matches the
 *     supplied `tokenRef` (e.g., logout against an unknown token).
 *
 *   - `isActive(tokenRef)` — middleware-time validation (ST-026). Returns
 *     `true` when the session row exists, `expires_at > now()`, and
 *     `revoked_at IS NULL`. The boolean is computed by the database, not
 *     by JavaScript, so the result is monotonic across a multi-instance
 *     app where Node clocks may drift relative to one another.
 *
 * Out-of-scope per AAP §0.7.2: no list/paginate methods, no bulk-delete
 * "garbage collection" of expired rows. The 49-story acceptance scope does
 * not require such operations; adding them would violate the explicit AAP
 * §0.7.2 boundary and is deferred to a future garbage-collection epic.
 */
export interface SessionRepository {
  /**
   * Upsert a session row keyed on `tokenRef`.
   *
   * Inserts a new row when `tokenRef` is new; otherwise refreshes
   * `userId`, `issuedAt`, `expiresAt` and clears `revokedAt` to NULL.
   * This idempotency is required by ST-024-AC3: repeated logins (which
   * Firebase Auth fulfils with the same idToken — and therefore the
   * same `tokenRef` — when issued back-to-back) must not surface as
   * HTTP 500 due to a PRIMARY KEY collision.
   *
   * @throws The native pg error on foreign-key violation (code `23503`)
   *   — the service layer is responsible for translation to HTTP
   *   status codes. PRIMARY KEY collisions (PG `23505`) cannot occur:
   *   the underlying SQL has an `ON CONFLICT (token_ref) DO UPDATE`
   *   branch.
   * @throws A wrapping `Error` if the UPSERT executes but does not
   *   return a row (vanishingly rare; a defensive check protects the
   *   downstream non-null contract).
   */
  insert(params: InsertSessionParams): Promise<Session>;

  /**
   * Look up a session by its tokenRef. Returns `null` when no row matches.
   *
   * Backed by the PRIMARY KEY index on `sessions.token_ref`, so this
   * lookup is O(log n) regardless of table size — comfortably inside the
   * ST-026-AC4 latency budget.
   */
  findByTokenRef(tokenRef: string): Promise<Session | null>;

  /**
   * Mark the session associated with `tokenRef` as revoked.
   *
   * Idempotent: a repeated call against an already-revoked session keeps
   * the ORIGINAL `revoked_at` timestamp via `COALESCE(revoked_at, now())`.
   * This is the audit-correct semantics — "when did the user first end
   * this session?" — and is also what ST-025-AC3 requires (logout is
   * idempotent and does not alter state on the second call).
   *
   * Returns the updated session row, or `null` when no row matches the
   * supplied `tokenRef` (e.g., logout against an unknown token, which
   * the service layer can translate to a 200 OK with a documented
   * non-error response per ST-025-AC3 — "submitting the same revoked
   * token again returns a documented non-error response").
   */
  markRevoked(tokenRef: string): Promise<Session | null>;

  /**
   * Return `true` iff a session with `tokenRef` exists, has not yet
   * expired (`expires_at > now()`), AND has not been revoked
   * (`revoked_at IS NULL`).
   *
   * The boolean is computed at the database tier (not in JS) so that:
   *   1. Clock skew between the API server and PG cannot flip the
   *      result between consecutive calls.
   *   2. Multi-instance deployments produce identical answers regardless
   *      of which Node process fielded the request.
   *   3. The check piggybacks on a single index probe (PRIMARY KEY) and
   *      a constant-time clock read, keeping the latency well within
   *      the ST-026-AC4 budget.
   *
   * Returns `false` when:
   *   - No row matches the `tokenRef` (the session never existed, or
   *     has been pruned).
   *   - The row exists but has expired or has been revoked.
   */
  isActive(tokenRef: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Section 2: Private row type — exact mirror of the table's column shape.
// ---------------------------------------------------------------------------

/**
 * The exact row shape returned by `pool.query<SessionRow>()`.
 *
 * Property names match the database column names verbatim
 * (`token_ref`, `user_id`, `issued_at`, `expires_at`, `revoked_at`) —
 * the {@link mapSessionRow} function below is the single place that
 * converts snake_case columns to camelCase domain fields. Centralising
 * the mapping in one function means a column rename only requires
 * updating one file (here) plus the migration; no search-and-replace
 * across services.
 */
interface SessionRow {
  token_ref: string;
  user_id: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

// ---------------------------------------------------------------------------
// Section 3: Private mapper — single source of truth for row → domain.
// ---------------------------------------------------------------------------

/**
 * Convert the raw `pg` row into the public {@link Session} shape.
 *
 * Centralising the conversion in one private function:
 *   - Keeps snake_case → camelCase translation in exactly one place.
 *   - Provides a natural anchor point for future enrichment (e.g.
 *     derived audit fields or computed status enums) without requiring
 *     every caller to be rewritten.
 *   - Lets unit tests assert that the mapping is total and faithful by
 *     exercising the mapper through any of the four public methods.
 */
function mapSessionRow(row: SessionRow): Session {
  return {
    tokenRef: row.token_ref,
    userId: row.user_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// Section 4: SQL constants — parameterised, audit-ready statements.
// ---------------------------------------------------------------------------

/**
 * UPSERT a session row keyed on `token_ref`.
 *
 * The four-column INSERT (`token_ref`, `user_id`, `issued_at`,
 * `expires_at`) leaves `revoked_at` to its column default (`NULL`),
 * which is exactly what every just-issued session needs. The service
 * layer never asks for a session to be "born revoked".
 *
 * The `ON CONFLICT (token_ref) DO UPDATE` clause makes this statement
 * idempotent against the case where the same Firebase `idToken` (and
 * therefore the same SHA-256 `token_ref`) is presented to `/login`
 * more than once in rapid succession — Firebase Auth deliberately
 * returns an identical `idToken` for back-to-back sign-ins issued
 * inside the token's mint-window, which under a strict INSERT would
 * fail with PG error 23505 (unique_violation on `sessions_pkey`) and
 * surface to the user as HTTP 500.
 *
 * The conflict-resolution branch:
 *   - Refreshes `user_id`, `issued_at`, and `expires_at` to the values
 *     supplied by the new login attempt (the latest mint of this same
 *     idToken is the authoritative one).
 *   - Clears `revoked_at` to NULL so a re-login of a previously
 *     revoked-then-reissued idToken reactivates the row — this
 *     matches the user-visible intent of "log me back in".
 *
 * The behaviour satisfies ST-024-AC3 ("repeated logins do not
 * invalidate active sessions from other devices"): a different device
 * obtaining a different idToken produces a different `token_ref` and
 * therefore inserts a fresh row, untouched by this conflict path.
 *
 * Both timestamp parameters are explicitly cast to `timestamptz` so
 * that pg's parameter binding accepts ISO-8601 strings (which we send
 * via `Date.toISOString()`) reliably across pg minor versions. Without
 * the cast, pg may try to infer the column type from the parameter
 * shape, which can fail for unusual JS Date values (very early epoch
 * timestamps, dates produced by Date arithmetic in non-UTC timezones).
 *
 * The RETURNING clause hands back the full canonical row so callers
 * do NOT need a follow-up SELECT to obtain the persisted state. This
 * is both faster (one round-trip) and more correct (no race window).
 */
const INSERT_SESSION_SQL = `
  INSERT INTO sessions (token_ref, user_id, issued_at, expires_at)
  VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
  ON CONFLICT (token_ref) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        revoked_at = NULL
  RETURNING token_ref, user_id, issued_at, expires_at, revoked_at
`;

/**
 * SELECT a session by its tokenRef.
 *
 * Backed by the PRIMARY KEY index on `sessions.token_ref` (per the
 * ST-031 migration) so the lookup is O(log n) regardless of table
 * size. Used by service-layer flows that need the full row (e.g., to
 * log the `userId` for an audit event before revoking) and by the
 * occasional diagnostic / debug query.
 *
 * Returns at most one row because the column is the PRIMARY KEY; the
 * repository's `rows[0]` access is therefore safe.
 */
const FIND_SESSION_BY_TOKEN_REF_SQL = `
  SELECT token_ref, user_id, issued_at, expires_at, revoked_at
  FROM sessions
  WHERE token_ref = $1
`;

/**
 * UPDATE the session's `revoked_at` column to mark it revoked.
 *
 * Idempotency is enforced via `COALESCE(revoked_at, now())`:
 *   - First call: `revoked_at` is `NULL`, so `COALESCE` evaluates the
 *     second argument and the column is set to `now()`.
 *   - Subsequent calls: `revoked_at` is already non-null, so
 *     `COALESCE` returns the existing value and the column does not
 *     change.
 *
 * The audit-correct semantics ("when did the user FIRST end this
 * session?") fall out of this expression naturally — there is no
 * branch in the SQL, so there is no "stale-write" race window between
 * read and write.
 *
 * The RETURNING clause hands back the canonical row so the service
 * layer can log the actual revocation timestamp without an extra
 * SELECT.
 *
 * When no row matches the supplied `tokenRef` the UPDATE affects zero
 * rows, RETURNING produces an empty result set, and the repository
 * surfaces `null` to the caller — see the factory below.
 */
const MARK_REVOKED_SQL = `
  UPDATE sessions
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE token_ref = $1
  RETURNING token_ref, user_id, issued_at, expires_at, revoked_at
`;

/**
 * Check whether the session referenced by `tokenRef` is currently
 * active.
 *
 * The boolean is computed at the database tier:
 *   - `expires_at > now()` uses PostgreSQL's `now()` (the transaction
 *     start time) rather than `Date.now()` so the result is consistent
 *     across multi-instance Node deployments where wall-clock drift
 *     between processes is otherwise observable.
 *   - `revoked_at IS NULL` reads the same column the logout flow
 *     writes, so the read-after-write contract is guaranteed by the
 *     database's MVCC visibility, not by application-side caching.
 *
 * Returning the boolean directly (rather than the row) lets pg execute
 * an index-only-ish scan against the PRIMARY KEY and emit a single
 * computed boolean column — minimal data on the wire, minimal work
 * for the repository to translate.
 *
 * When no row matches, `rows[0]` is `undefined`; the factory uses
 * optional-chaining + strict-equals-true to coerce that to `false`.
 */
const IS_ACTIVE_SQL = `
  SELECT (expires_at > now() AND revoked_at IS NULL) AS is_active
  FROM sessions
  WHERE token_ref = $1
`;

// ---------------------------------------------------------------------------
// Section 5: Factory — wires the SQL constants to a Pool and returns the
// public {@link SessionRepository} interface.
// ---------------------------------------------------------------------------

/**
 * Create a {@link SessionRepository} backed by the supplied pg {@link Pool}.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createSessionRepository(pool)`) — easier to mock in unit tests
 *     than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *
 * The returned record is `Object.freeze`-d so calling code cannot
 * substitute one of the methods at runtime — that prevents a class of
 * bugs where a test or middleware accidentally mutates the shared
 * repository instance.
 *
 * The methods are defined on the literal directly so `repo.insert` and
 * `const { insert } = repo; insert(...)` behave identically — no
 * `this`-binding confusion.
 *
 * @param pool A connected `pg.Pool` instance (typically from
 *   `backend/src/db/pool.ts`). The repository never closes the pool —
 *   pool lifecycle is the caller's responsibility.
 * @returns A frozen {@link SessionRepository} ready for use.
 */
export function createSessionRepository(pool: Pool): SessionRepository {
  const repository: SessionRepository = {
    async insert(params: InsertSessionParams): Promise<Session> {
      // ISO-8601 strings are the most reliable wire format for
      // TIMESTAMPTZ columns under pg's parameter binding. We pair this
      // with the explicit `::timestamptz` casts inside INSERT_SESSION_SQL
      // so pg never has to guess the parameter type.
      const result = await pool.query<SessionRow>({
        text: INSERT_SESSION_SQL,
        values: [
          params.tokenRef,
          params.userId,
          params.issuedAt.toISOString(),
          params.expiresAt.toISOString(),
        ],
      });

      // Defensive: the RETURNING clause guarantees a row when the
      // INSERT succeeds, but if a future schema change were to alter
      // that contract we want a loud, descriptive failure instead of
      // a silent `undefined` propagating into business logic.
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          'sessions INSERT did not return a row; this should be impossible ' +
            'when the INSERT statement contains RETURNING. Investigate ' +
            'recent schema or migration changes.',
        );
      }

      return mapSessionRow(row);
    },

    async findByTokenRef(tokenRef: string): Promise<Session | null> {
      const result = await pool.query<SessionRow>({
        text: FIND_SESSION_BY_TOKEN_REF_SQL,
        values: [tokenRef],
      });

      // The PRIMARY KEY constraint guarantees at most one row; `rows[0]`
      // is `SessionRow | undefined`.
      const row = result.rows[0];
      return row ? mapSessionRow(row) : null;
    },

    async markRevoked(tokenRef: string): Promise<Session | null> {
      const result = await pool.query<SessionRow>({
        text: MARK_REVOKED_SQL,
        values: [tokenRef],
      });

      // When no row matches the supplied tokenRef the UPDATE affects
      // zero rows, RETURNING produces an empty result, and we surface
      // null. The service layer (ST-025) decides whether to translate
      // null to a 200 OK (idempotent logout against an unknown token)
      // or to a different status — that is policy, not mechanism, so it
      // does not belong in the repository.
      const row = result.rows[0];
      return row ? mapSessionRow(row) : null;
    },

    async isActive(tokenRef: string): Promise<boolean> {
      const result = await pool.query<{ is_active: boolean }>({
        text: IS_ACTIVE_SQL,
        values: [tokenRef],
      });

      // `rows[0]` is `{ is_active: boolean } | undefined`. The
      // strict-equals-true comparison (rather than truthy coercion)
      // makes us robust to any pg driver quirk that might return a
      // string `'t'` / `'f'` instead of a JS boolean — the repository's
      // public contract is `Promise<boolean>` and we deliver exactly
      // that.
      const row = result.rows[0];
      return row?.is_active === true;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a repository method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(repository);
}
