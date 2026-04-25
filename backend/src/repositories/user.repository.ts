/**
 * User repository — data-access layer for the `users` table.
 *
 * This module owns every direct read or write of the `users` table. Higher
 * layers (services, routes, middleware) depend ONLY on the typed
 * {@link UserRepository} interface — they do not import `pg` or know any SQL.
 * That separation keeps SQL co-located with its schema knowledge and makes
 * the layer trivially mockable in unit tests.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/repositories/user.repository.ts | CRUD for users table`
 *   - AAP §0.6.4 Track 1 T1-C: repositories belong to the dependency-ordered
 *     backend API implementation.
 *   - Story ST-023 (user registration endpoint).
 *   - Story ST-024 (login endpoint / session token issuance).
 *   - Story ST-026 (session-validation middleware contract — calls
 *     {@link UserRepository.findByFirebaseUid} on every protected request).
 *   - Story ST-031 (users + sessions schema migration — defines the
 *     `users` table shape this repository targets).
 *
 * Firebase user mirroring (AAP §0.2.1, the implicit resolution):
 *   The local `users` table is a MIRROR of Firebase Auth's authoritative
 *   identity store, not a competing one. Firebase owns:
 *     - Credentials (passwords, OAuth tokens, MFA secrets)
 *     - Identity verification (`admin.auth().verifyIdToken`)
 *     - Login-attempt history and session-token issuance
 *
 *   PostgreSQL owns:
 *     - The local `users` row (so `designs.user_id`, `sessions.user_id`,
 *       `orders.user_id` foreign-key references resolve)
 *     - Locally-meaningful audit columns (`created_at`)
 *     - The login_identifier (e.g. email) for application-side conflict
 *       checks during registration without round-tripping to Firebase.
 *
 *   This split has two important consequences enforced in the code below:
 *     1. The PRIMARY KEY of `users.id` IS the Firebase `uid`. After
 *        `verifyIdToken(rawBearerToken)` returns a `uid`, downstream queries
 *        like `SELECT ... FROM designs WHERE user_id = $1` use that uid
 *        directly — no translation table, no extra join.
 *     2. The `users.credential_digest` column EXISTS (per ST-031-AC4 the
 *        schema must be sized to "prevent cleartext storage of credentials")
 *        but is NEVER populated by application code — it is structurally
 *        non-nullable-by-database-default. This module deliberately offers
 *        no write path for the column. The mapper always returns `null`.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): this repository never logs and
 *     never returns credential material. The `User` interface's
 *     `credentialDigest` field is typed as the literal `null` (not `string |
 *     null` or `Buffer | null`), making it a TYPE ERROR for any caller to
 *     attempt to read or assert a non-null value.
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. The repository never parses,
 *     verifies, or issues tokens. Token verification is the exclusive
 *     responsibility of `backend/src/auth/firebase-admin.ts` via
 *     `admin.auth().verifyIdToken`.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. The {@link Pool} is dependency-injected by the caller
 *     (`backend/src/db/pool.ts` builds the pool from `DATABASE_URL`).
 *   - R10 (migration filename pattern): N/A here; this module is consumed
 *     by — but does not author — the migration file
 *     `backend/migrations/{ts}_ST-031_users_sessions.js`.
 *
 * Security-relevant invariants enforced at the type layer:
 *   - {@link InsertUserParams} exposes ONLY `firebaseUid` and
 *     `loginIdentifier`. There is no `password`, no `credentialDigest`, no
 *     `passwordHash` field, so it is a compile-time error for a caller to
 *     attempt to push credential material through this layer.
 *   - {@link User} is fully `readonly` so consumers cannot accidentally
 *     mutate the record after retrieval.
 *
 * Design discipline:
 *   - Parameterised queries only. Every SQL constant uses `$1`, `$2`
 *     placeholders; user-supplied values are passed via the `values` array
 *     of the `QueryConfig`. There is no string interpolation of user input
 *     anywhere in this file (SQL-injection invariant).
 *   - The repository is constructed via a factory (`createUserRepository`)
 *     rather than as a class. Factories make dependency injection
 *     explicit, support `Object.freeze` of the returned record (preventing
 *     accidental method monkey-patching), and play well with tree-shaking.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/db/pool.ts` — provides the `Pool` injected here.
 *   - `backend/src/services/session.service.ts` — calls `insert` (on
 *     registration) and `findByFirebaseUid` (on login + middleware).
 *   - `backend/src/middleware/session.ts` — after `verifyIdToken`, calls
 *     `findByFirebaseUid(uid)` to load the local user mirror and attach
 *     it to the request context.
 *   - `backend/src/routes/auth.ts` — registration endpoint calls
 *     `insert`; login endpoint reads via the service layer.
 *   - `backend/src/repositories/{session,design,order}.repository.ts` —
 *     each carries an FK referencing `users.id`.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Section 1: Public types — domain shape exposed to higher layers.
// ---------------------------------------------------------------------------

/**
 * A user record as persisted in the `users` table.
 *
 * Field-level contract (this is the API every consumer of this module
 * relies on):
 *
 *   `id`
 *     The application-level primary key. Per AAP §0.2.1 this string IS
 *     the Firebase Auth `uid` returned by `admin.auth().verifyIdToken`.
 *     Storing the uid as the local PK lets the session middleware
 *     attach a user context in O(1) — no translation table, no join —
 *     after Firebase returns the verified uid.
 *
 *   `loginIdentifier`
 *     The user-facing identifier (e.g. email) collected at registration.
 *     Backed by a UNIQUE index in the schema (ST-031-AC1) so duplicate
 *     registrations fail at the database tier with PG error code 23505.
 *
 *   `credentialDigest`
 *     ALWAYS `null` per AAP §0.2.1. The column exists in the schema for
 *     ST-031-AC4 conformance ("sized and constrained to prevent storage
 *     of cleartext credentials"), but credentials live exclusively in
 *     Firebase Auth and are NEVER mirrored to PostgreSQL. The literal-
 *     `null` type makes any non-null treatment a compile-time error.
 *
 *   `createdAt`
 *     The local row creation timestamp. Distinct from Firebase's own
 *     account-creation timestamp; this column records when our local
 *     mirror was first populated, which is what audit/forensic queries
 *     against our DB want to know.
 *
 * The interface is `readonly`-on-every-field so consumers cannot mutate
 * the record after retrieval. To "update" a user, callers must go
 * through repository methods that explicitly construct a new row — this
 * design choice surfaces every mutation as a deliberate database write
 * rather than an in-memory side-effect.
 */
export interface User {
  /** Firebase uid, also the PostgreSQL primary key. */
  readonly id: string;
  /** User-facing login identifier (e.g. email); UNIQUE in DB. */
  readonly loginIdentifier: string;
  /**
   * ALWAYS `null` per AAP §0.2.1 — credentials live exclusively in
   * Firebase Auth and are never mirrored here. The literal `null` type
   * makes any non-null treatment a TYPE ERROR.
   */
  readonly credentialDigest: null;
  /** Local row-creation timestamp. */
  readonly createdAt: Date;
}

/**
 * Parameters accepted by {@link UserRepository.insert}.
 *
 * Notice what is NOT here:
 *   - No `password`, `passwordHash`, `credential`, or `credentialDigest`
 *     field. The `users.credential_digest` column is intentionally
 *     unreachable from application code (Rule R3 / AAP §0.2.1).
 *   - No `id` field. The PK is exactly the supplied {@link firebaseUid};
 *     having a separate `id` would invite drift between the two values.
 *   - No `createdAt` field. The DB sets `created_at` via the column
 *     `DEFAULT now()` so application code never needs to think about
 *     clock skew between the API server and PG.
 *
 * The shape is intentionally minimal: it is the smallest set of values
 * that uniquely identifies a new local user mirror.
 */
export interface InsertUserParams {
  /**
   * The Firebase uid (from `admin.auth().verifyIdToken` on the inbound
   * registration request). Becomes the `users.id` primary key — see
   * {@link User.id} for why.
   */
  firebaseUid: string;
  /**
   * The user-facing login identifier (e.g. email). Subject to the
   * UNIQUE constraint defined in ST-031; duplicate values surface as a
   * PG `23505` (`unique_violation`) error which the service layer
   * translates to HTTP 409 Conflict.
   */
  loginIdentifier: string;
}

/**
 * Repository interface — the public contract callers depend on.
 *
 * Three methods, sized to the actual needs of stories ST-023/ST-024/
 * ST-026:
 *
 *   - `insert(params)` — registration (ST-023). Returns the persisted
 *     {@link User}. Throws on UNIQUE violation; the service layer
 *     catches the PG `23505` error and returns HTTP 409.
 *
 *   - `findByLoginIdentifier(loginIdentifier)` — registration
 *     pre-flight (ST-023) and login lookup (ST-024). Returns `null`
 *     when no user exists; the database UNIQUE index makes this an
 *     O(log n) lookup.
 *
 *   - `findByFirebaseUid(uid)` — session-validation middleware
 *     (ST-026). Called on EVERY protected request after
 *     `verifyIdToken` returns a uid, so this query is on the hot path.
 *     Backed by the PRIMARY KEY index on `users.id`, so it is also
 *     O(log n) — comfortably inside the ST-026-AC4 latency budget.
 *
 * Out-of-scope per AAP §0.7.2: no `update*`, no `delete*`, no list/
 * paginate methods. The 49-story acceptance scope does not require user
 * profile mutations or admin-style listings; adding such methods would
 * be in violation of the explicit AAP §0.7.2 boundary.
 */
export interface UserRepository {
  /**
   * Insert a new user row.
   *
   * @throws The native pg error on UNIQUE violation (code `23505`) —
   *   service layer is responsible for translation to HTTP 409.
   * @throws A wrapping `Error` if the INSERT executes but does not
   *   return a row (vanishingly rare; a defensive check protects the
   *   downstream non-null contract).
   */
  insert(params: InsertUserParams): Promise<User>;

  /**
   * Look up a user by login identifier. Returns `null` when no row
   * matches.
   */
  findByLoginIdentifier(loginIdentifier: string): Promise<User | null>;

  /**
   * Look up a user by Firebase uid (which equals `users.id`). Returns
   * `null` when no row matches. Used by the session middleware on every
   * protected request — must remain O(log n) (PK index).
   */
  findByFirebaseUid(uid: string): Promise<User | null>;
}

// ---------------------------------------------------------------------------
// Section 2: Private row type — exact mirror of the table's column shape.
// ---------------------------------------------------------------------------

/**
 * The exact row shape returned by `pool.query<UserRow>()`.
 *
 * Property names match the database column names verbatim
 * (`login_identifier`, `credential_digest`, `created_at`) — the mapper
 * function below is the single place that converts snake_case columns
 * to camelCase domain fields. Centralising the mapping in one function
 * means a column rename only requires updating one file (here) plus
 * the migration; no search-and-replace across services.
 *
 * The `credential_digest` column is typed as the literal `null` to mirror
 * the {@link User.credentialDigest} contract: at runtime `pg` may decode
 * a populated BYTEA cell as `Buffer`, but our schema's CHECK constraint
 * (defined in the ST-031 migration) makes that physically impossible
 * unless someone bypasses the application layer to write directly to
 * the table. If that ever happens the mapper still returns `null`
 * because the public contract demands it — see {@link mapUserRow}.
 */
interface UserRow {
  id: string;
  login_identifier: string;
  /**
   * Database column. Per the schema CHECK constraint in the ST-031
   * migration this MUST be NULL in well-behaved deployments. The type
   * here pins to `null` to match the public contract.
   */
  credential_digest: null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Section 3: Private mapper — single source of truth for row → domain.
// ---------------------------------------------------------------------------

/**
 * Convert the raw `pg` row into the public {@link User} shape.
 *
 * Centralising the conversion in one private function:
 *   - Keeps snake_case → camelCase translation in exactly one place.
 *   - Lets us defensively force `credentialDigest` to `null` even if the
 *     DB layer somehow surfaces a non-null value (defense-in-depth for
 *     the public contract).
 *   - Provides a natural anchor point for future enrichment (e.g. derived
 *     audit fields) without rewriting every caller.
 */
function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    loginIdentifier: row.login_identifier,
    // Per AAP §0.2.1 — credentials live exclusively in Firebase. We
    // forcibly return `null` here so the public contract holds even
    // under adversarial DB state (defense-in-depth).
    credentialDigest: null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Section 4: SQL constants — parameterised, audit-ready statements.
// ---------------------------------------------------------------------------

/**
 * INSERT a new user row.
 *
 * The two-column INSERT (`id`, `login_identifier`) leaves
 * `credential_digest` and `created_at` to their column defaults
 * (`NULL` and `now()` respectively). Per AAP §0.2.1 the column
 * `credential_digest` is intentionally UNREACHABLE from application
 * code — the SQL constant deliberately omits it from the column list
 * so a future maintainer cannot accidentally smuggle a credential
 * value through.
 *
 * Setting `id` explicitly to the Firebase uid (rather than relying on
 * a server-side `gen_random_uuid()` default) is the architectural
 * decision documented in `docs/decisions/README.md`: every authenticated
 * request can resolve `uid → user record` without an extra lookup.
 *
 * The RETURNING clause hands back the full canonical row so callers do
 * NOT need a follow-up SELECT to obtain the DB-assigned `created_at`.
 * This is both faster (one round-trip instead of two) and more correct
 * (no race window between INSERT and SELECT).
 */
const INSERT_USER_SQL = `
  INSERT INTO users (id, login_identifier)
  VALUES ($1, $2)
  RETURNING id, login_identifier, credential_digest, created_at
`;

/**
 * SELECT a user by login identifier.
 *
 * Backed by the UNIQUE index on `users.login_identifier` (ST-031-AC1)
 * so the lookup is O(log n) regardless of table size. Used during
 * registration pre-flight conflict checks and during login email-based
 * lookups.
 *
 * Returns at most one row because the column carries a UNIQUE
 * constraint; the repository's `rows[0]` access is safe.
 */
const FIND_USER_BY_LOGIN_IDENTIFIER_SQL = `
  SELECT id, login_identifier, credential_digest, created_at
  FROM users
  WHERE login_identifier = $1
`;

/**
 * SELECT a user by Firebase uid (which is also the primary key).
 *
 * This is the HOT-PATH query for every authenticated request: after
 * the session middleware verifies the inbound bearer token via
 * `admin.auth().verifyIdToken`, it calls this method to load the
 * local mirror. The PK index on `users.id` keeps this within the
 * ST-026-AC4 latency budget.
 *
 * Note that the WHERE column is `id`, not a separate `firebase_uid`
 * column, because per AAP §0.2.1 the two are the same value. Adding
 * a separate column would invite drift and require a join.
 */
const FIND_USER_BY_FIREBASE_UID_SQL = `
  SELECT id, login_identifier, credential_digest, created_at
  FROM users
  WHERE id = $1
`;

// ---------------------------------------------------------------------------
// Section 5: Factory — wires the SQL constants to a Pool and returns the
// public {@link UserRepository} interface.
// ---------------------------------------------------------------------------

/**
 * Create a {@link UserRepository} backed by the supplied pg {@link Pool}.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createUserRepository(pool)`) — easier to mock in unit tests
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
 * The methods themselves are arrow-function-bound on the literal so
 * `repo.insert` and `const { insert } = repo; insert(...)` behave
 * identically — no `this` confusion.
 *
 * @param pool A connected `pg.Pool` instance (typically from
 *   `backend/src/db/pool.ts`). The repository never closes the pool —
 *   pool lifecycle is the caller's responsibility.
 * @returns A frozen {@link UserRepository} ready for use.
 */
export function createUserRepository(pool: Pool): UserRepository {
  const repository: UserRepository = {
    async insert(params: InsertUserParams): Promise<User> {
      // Note: we do NOT accept a credential digest. The `users.
      // credential_digest` column exists for ST-031-AC4 schema
      // conformance only and is always NULL in well-formed
      // deployments. The CHECK constraint in the migration enforces
      // this at the database tier; this method enforces it at the
      // application tier by simply not having a parameter for it.
      const result = await pool.query<UserRow>({
        text: INSERT_USER_SQL,
        values: [params.firebaseUid, params.loginIdentifier],
      });

      // Defensive: the RETURNING clause guarantees a row when the
      // INSERT succeeds, but if a future schema change were to alter
      // that contract we want a loud, descriptive failure instead of
      // a silent `undefined` propagating into business logic.
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          'users INSERT did not return a row; this should be impossible ' +
            'when the INSERT statement contains RETURNING. Investigate ' +
            'recent schema or migration changes.',
        );
      }

      return mapUserRow(row);
    },

    async findByLoginIdentifier(loginIdentifier: string): Promise<User | null> {
      const result = await pool.query<UserRow>({
        text: FIND_USER_BY_LOGIN_IDENTIFIER_SQL,
        values: [loginIdentifier],
      });

      // The UNIQUE constraint on login_identifier guarantees at most
      // one row. `rows[0]` is `UserRow | undefined` when the result
      // is empty.
      const row = result.rows[0];
      return row ? mapUserRow(row) : null;
    },

    async findByFirebaseUid(uid: string): Promise<User | null> {
      const result = await pool.query<UserRow>({
        text: FIND_USER_BY_FIREBASE_UID_SQL,
        values: [uid],
      });

      // The PRIMARY KEY constraint guarantees at most one row.
      const row = result.rows[0];
      return row ? mapUserRow(row) : null;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a repository method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(repository);
}
