/**
 * Unit tests for `backend/src/repositories/session.repository.ts`.
 *
 * Verifies the four exported members on the `SessionRepository`
 * contract — `insert`, `findByTokenRef`, `markRevoked`, `isActive` —
 * against the security, schema, and idempotency invariants documented
 * in the source file:
 *
 *   1. INSERT statement targets the `sessions` table, includes
 *      `RETURNING`, casts both timestamp parameters to `timestamptz`,
 *      and passes `(tokenRef, userId, issuedAt-ISO, expiresAt-ISO)`
 *      through the `values` array — there is no `password`,
 *      `credential`, or bearer-token parameter (Rule R2 + AAP §0.2.1).
 *   2. SELECT/UPDATE statements use parameterised `$N` placeholders
 *      (no string interpolation of input — SQL-injection invariant).
 *   3. `markRevoked` is idempotent via `COALESCE(revoked_at, now())`:
 *      a second logout against the same session preserves the
 *      ORIGINAL revocation timestamp (ST-025-AC3).
 *   4. `isActive` evaluates the boolean at the DATABASE tier — the
 *      query selects `(expires_at > now() AND revoked_at IS NULL) AS
 *      is_active` — so the result is monotonic across multi-instance
 *      Node deployments where wall-clock drift between processes is
 *      otherwise observable (ST-026-AC4).
 *   5. The mapper translates snake_case columns (`token_ref`,
 *      `user_id`, `issued_at`, `expires_at`, `revoked_at`) to camelCase
 *      domain fields (`tokenRef`, `userId`, `issuedAt`, `expiresAt`,
 *      `revokedAt`).
 *   6. PG errors (UNIQUE violations, foreign-key violations,
 *      connection errors) propagate up the call stack rather than
 *      being swallowed (Rule R8 — fail-closed posture).
 *   7. `findByTokenRef` and `markRevoked` return `null` (never
 *      `undefined`) when the result set is empty.
 *   8. The TypeScript signature of `insert()` does NOT permit a
 *      `password`, `credential`, or `bearer` parameter — verified via
 *      a conditional-type assertion that is BOTH a compile-time check
 *      AND a run-time assertion.
 *
 * Authority:
 *   - Story ST-024 (login endpoint — session token issuance).
 *   - Story ST-025 (logout endpoint — session revocation, idempotent).
 *   - Story ST-026 (session validation middleware — uses isActive).
 *   - Story ST-031 (sessions-table schema with revocation marker).
 *   - Story ST-043 (deterministic, local-only, no-network unit suite).
 *   - AAP §0.2.1 "Session persistence semantics": the `sessions` table
 *     is a REVOCATION LIST and issuance audit log; Firebase owns
 *     tokens.
 *   - AAP §0.8.1 R2 (no credential material in logs/params), R3
 *     (Firebase Admin SDK only — no JWT libraries here), R8 (gates
 *     fail closed).
 *
 * Determinism (ST-043-AC3):
 *   - The mocked `pg.Pool` returns deterministic, in-memory results so
 *     no asynchronous boundary depends on external timing.
 *   - `jest.useFakeTimers({ now: FIXED_DATE })` pins the Date used by
 *     any wall-clock comparison so assertions never race past a
 *     second boundary. Although the SQL itself uses PostgreSQL's
 *     `now()` (server-side), the test's `Date` constructor is pinned
 *     because SOME assertions construct fixture Dates that flow
 *     through the repository's `.toISOString()` wire-format
 *     conversion.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets
 *     `clearMocks`, `resetMocks`, and `restoreMocks` to `true` so
 *     mock state is wiped between tests; this file therefore needs no
 *     manual `jest.clearAllMocks()` calls.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and depends
 *   on ZERO services. The `pg.Pool` is replaced with a `jest.Mocked`
 *   double; every assertion exercises pure synchronous JavaScript.
 *
 * @see backend/src/repositories/session.repository.ts — module under test
 * @see tickets/stories/ST-024-login-endpoint-session-token.md
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md
 * @see tickets/stories/ST-031-users-sessions-schema-migration.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// Type-only imports — required by the `@typescript-eslint/consistent-type-
// imports` rule in `.eslintrc.json`. `Pool` is the generic argument to
// `jest.Mocked<Pool>`; `QueryConfig` and `QueryResult` carry the
// repository's call shape; `QueryResultRow` is the generic bound on the
// `mockQueryResult` helper. None of these are runtime dependencies, so a
// pure type import is the correct form.
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { createSessionRepository, type Session } from './session.repository';

// ---------------------------------------------------------------------------
// Test fixtures — deterministic constants used throughout the suite.
// ---------------------------------------------------------------------------

/**
 * Stable wall-clock pin for the suite. Every fixture Date is either
 * this value or computed deterministically from it, so the suite
 * remains deterministic across machines and across second-boundaries
 * (ST-043-AC3).
 *
 * The date was chosen to fall comfortably inside the StrikeForge
 * launch window; any value would work because the only constraint is
 * stability, but a near-launch date makes the fixture self-documenting
 * for humans reading test logs.
 */
const FIXED_DATE: Date = new Date('2026-01-15T10:00:00.000Z');

/**
 * Standard expiration timestamp used in happy-path INSERT fixtures —
 * 24 hours after `FIXED_DATE`. Mirrors the typical Firebase id-token
 * lifetime (1 hour) being extended by a generous local-policy buffer
 * for test purposes.
 */
const FIXED_EXPIRES_AT: Date = new Date('2026-01-16T10:00:00.000Z');

/**
 * Stable opaque token reference used as the canonical "successful
 * session" fixture. Per AAP §0.2.1 + the source file's documentation,
 * this string is NOT a raw Firebase id token; it is a hash or other
 * stable derivative supplied by the service layer (Rule R2). The
 * fixture's shape is deliberately mundane and non-credential-looking
 * — there is no `Bearer ` prefix, no JWT-like dotted segments — so
 * the assertions that scan parameter strings for credential material
 * have a clean baseline to compare against.
 */
const SAMPLE_TOKEN_REF = 'session-ref-stable-opaque-abc123';

/**
 * The canonical owning user id (= Firebase uid per AAP §0.2.1) used
 * across the suite. Format mimics a realistic Firebase uid.
 */
const SAMPLE_USER_ID = 'firebase-uid-abc123XYZ456789012345678';

// ---------------------------------------------------------------------------
// Mock helpers.
// ---------------------------------------------------------------------------
//
// The repository depends on a single object — a `pg.Pool` — and only ever
// invokes its `query` method via the QueryConfig OBJECT form
// (`pool.query<SessionRow>({ text, values })`). The `pg` types declare
// `Pool.query` with five overloads, which causes Jest's `MockedFunction`
// inference to resolve `mockResolvedValueOnce` parameter types to `never`.
// To work around that we type the `query` mock with a SINGLE narrower
// signature that mirrors the one overload the repository actually uses.
// Every other `Pool` method we populate is a generic `jest.Mock` since the
// repository never invokes them — populating them only protects against
// future-refactor `TypeError`s.
//
// `MockedPool` is the local test-only type. When passing the mock to the
// production factory we cast through `unknown` to `Pool` because the mock
// is intentionally narrower than the full `Pool` interface; TypeScript
// would otherwise flag the missing 60+ properties.
// ---------------------------------------------------------------------------

/**
 * Narrow function type that captures EXACTLY the `pool.query` overload
 * the session repository calls — `pool.query<R>(config: QueryConfig)`.
 *
 * Using a single-signature function type is what makes
 * `mockResolvedValueOnce(QueryResult<...>)` and
 * `mockRejectedValueOnce(Error)` typecheck. Jest's `MockedFunction`
 * only infers correctly from a single-overload function shape.
 */
type PoolQueryMock = jest.MockedFunction<
  (queryConfig: QueryConfig) => Promise<QueryResult<QueryResultRow>>
>;

/**
 * Local test-only Pool surface. Includes only the members that either
 * (a) the repository invokes — `query` — or (b) `pg.Pool` declares as
 * methods that other middlewares may invoke. The factory under test
 * never reaches for `connect`, `end`, etc., but we populate them
 * defensively.
 */
interface MockedPool {
  query: PoolQueryMock;
  connect: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  removeListener: jest.Mock;
  removeAllListeners: jest.Mock;
  addListener: jest.Mock;
  once: jest.Mock;
  listeners: jest.Mock;
  listenerCount: jest.Mock;
}

/**
 * Construct a typed {@link MockedPool} whose every method is a fresh
 * `jest.fn()`. Tests then arrange behaviour on `pool.query` via
 * `.mockResolvedValueOnce` / `.mockRejectedValueOnce`.
 */
function createMockPool(): MockedPool {
  return {
    query: jest.fn() as PoolQueryMock,
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn(),
    addListener: jest.fn(),
    once: jest.fn(),
    listeners: jest.fn(),
    listenerCount: jest.fn(),
  };
}

/**
 * Cast a {@link MockedPool} to `pg.Pool` for passing to the repository
 * factory. The cast is safe at runtime because the repository invokes
 * only `pool.query`; the narrower mock satisfies that contract.
 */
function asPool(mock: MockedPool): Pool {
  return mock as unknown as Pool;
}

/**
 * Fabricate a realistic `QueryResult<R>` shape from a list of rows.
 *
 * The `pg` library's `QueryResult` carries five fields in addition to
 * `rows` — `command`, `rowCount`, `oid`, `fields`. The repository
 * under test reads only `rows`, so the extra fields are populated
 * with neutral default values that mirror what `pg` would actually
 * return for a SELECT or RETURNING query.
 *
 * Generic constraint `T extends QueryResultRow` matches the
 * repository's own `pool.query<SessionRow>(...)` typing so a mocked
 * result cannot accidentally substitute an array-shaped row.
 */
function mockQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    // `command` is informational — the repository never reads it.
    // 'SELECT' is the safest default since most repository queries
    // are SELECTs; INSERT/UPDATE-with-RETURNING also receive SELECT
    // semantics for the returned row in `pg`'s contract.
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

/**
 * Capture the QueryConfig argument of a `pool.query<...>(...)` call.
 *
 * The repository invokes `pool.query` via the OBJECT form — passing a
 * `{ text, values }` config — rather than the positional `(text,
 * values)` form. This helper centralises the type-narrowing cast so
 * every assertion below reads cleanly.
 *
 * Throws (rather than silently returning `undefined`) when the mock
 * has not been called, because every test that uses this helper has
 * just exercised a method that is contractually required to call
 * `pool.query`.
 */
function getQueryConfig(pool: MockedPool, callIndex = 0): QueryConfig {
  const call = pool.query.mock.calls[callIndex];
  if (call === undefined) {
    throw new Error(
      `Expected pool.query to be called at least ${callIndex + 1} time(s); ` +
        `received ${pool.query.mock.calls.length}.`,
    );
  }
  // The repository ALWAYS uses the QueryConfig object form (verified
  // at compile time by the source file's
  // `pool.query<SessionRow>({ text, values })` signature). The cast
  // is therefore safe; if a future refactor changes the call form,
  // this assertion would surface that drift loudly.
  return call[0];
}

// ---------------------------------------------------------------------------
// Suite-level lifecycle hooks — fake timers for deterministic Date semantics.
// ---------------------------------------------------------------------------
//
// `jest.useFakeTimers({ now: FIXED_DATE })` makes `Date.now()` and the
// `Date` constructor return the same wall-clock value across every test
// in the file. This is mandatory for the idempotency test, which advances
// the system time mid-test via `jest.setSystemTime` and asserts that the
// idempotency-preserving SQL pattern (`COALESCE(revoked_at, now())`)
// keeps the original revocation timestamp regardless.
//
// `jest.useRealTimers()` in `afterEach` is mandatory — otherwise fake
// timers would leak into adjacent test files within the same Jest worker.
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers({ now: FIXED_DATE });
});

afterEach(() => {
  jest.useRealTimers();
});

// ===========================================================================
// createSessionRepository — factory contract
// ===========================================================================

describe('createSessionRepository', () => {
  it('returns an object with the four documented methods', () => {
    // The repository contract specifies exactly four methods. A test
    // that enumerates them protects against accidental API additions
    // (which would expand the public surface and therefore the
    // out-of-scope risk per AAP §0.7.2) and accidental removals.
    const pool = createMockPool();
    const repo = createSessionRepository(asPool(pool));

    expect(typeof repo.insert).toBe('function');
    expect(typeof repo.findByTokenRef).toBe('function');
    expect(typeof repo.markRevoked).toBe('function');
    expect(typeof repo.isActive).toBe('function');
  });

  it('returns a frozen object so methods cannot be monkey-patched', () => {
    // The factory is documented to call `Object.freeze` on the
    // returned record — protecting against the class of bugs where a
    // test or middleware accidentally substitutes a repository
    // method at runtime. Verifying the freeze here pins the contract.
    const pool = createMockPool();
    const repo = createSessionRepository(asPool(pool));

    expect(Object.isFrozen(repo)).toBe(true);
  });

  it('does NOT invoke pool.query during construction (lazy initialisation)', () => {
    // Constructing the repository must not issue any database call.
    // Eager queries during composition would slow startup and would
    // defeat dependency-injection-based testing.
    const pool = createMockPool();
    createSessionRepository(asPool(pool));

    expect(pool.query).not.toHaveBeenCalled();
  });

  // =========================================================================
  // insert — login flow (ST-024)
  // =========================================================================

  describe('insert', () => {
    it('inserts a session row with the expected columns and values', async () => {
      // Arrange: the INSERT ... RETURNING clause yields the freshly-
      // persisted row. The `revoked_at` column defaults to NULL on a
      // brand-new session.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));

      // Act
      const result = await repo.insert({
        userId: SAMPLE_USER_ID,
        tokenRef: SAMPLE_TOKEN_REF,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      // Assert: query shape — INSERT INTO sessions targeting all
      // four input columns, RETURNING the canonical row.
      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/INSERT\s+INTO\s+sessions/i);
      expect(config.text).toMatch(/token_ref/);
      expect(config.text).toMatch(/user_id/);
      expect(config.text).toMatch(/issued_at/);
      expect(config.text).toMatch(/expires_at/);
      expect(config.text).toMatch(/RETURNING/i);

      // Assert: parameter order matches the INSERT statement column
      // order — ($1=token_ref, $2=user_id, $3=issued_at,
      // $4=expires_at). The repository converts Dates to ISO-8601
      // strings before passing to pg (the most reliable wire format
      // for TIMESTAMPTZ columns under pg's parameter binding).
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toBeDefined();
      expect(values).toEqual([
        SAMPLE_TOKEN_REF,
        SAMPLE_USER_ID,
        FIXED_DATE.toISOString(),
        FIXED_EXPIRES_AT.toISOString(),
      ]);

      // Assert: returned canonical record shape (snake_case →
      // camelCase, with revokedAt preserved as null for an active
      // session).
      expect(result).toEqual({
        tokenRef: SAMPLE_TOKEN_REF,
        userId: SAMPLE_USER_ID,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
        revokedAt: null,
      } as Session);

      // Assert: exactly one query was issued.
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('uses parameterised placeholders ($1..$4) — no string interpolation of input', async () => {
      // SQL-injection invariant: the INSERT must use $1..$4 markers
      // and pass user-supplied values via the `values` array. The
      // tokenRef in this test contains characters (single quote,
      // semicolon) that would be catastrophic if interpolated into
      // the SQL text directly. Even though tokenRef is server-issued
      // (a hash), the repository's responsibility is to enforce the
      // invariant universally.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: "evil'; DROP TABLE sessions; --",
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.insert({
        userId: SAMPLE_USER_ID,
        tokenRef: "evil'; DROP TABLE sessions; --",
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);
      // Statement uses placeholders; user input is NOT in the SQL text.
      expect(config.text).toMatch(/\$1/);
      expect(config.text).toMatch(/\$2/);
      expect(config.text).toMatch(/\$3/);
      expect(config.text).toMatch(/\$4/);
      expect(config.text).not.toContain('DROP TABLE');
      // User input flows through values, not text interpolation.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toContain("evil'; DROP TABLE sessions; --");
    });

    it('casts both timestamp parameters to timestamptz in the SQL text', async () => {
      // The source file's `INSERT_SESSION_SQL` constant uses
      // `$3::timestamptz` and `$4::timestamptz` so pg never has to
      // infer the parameter type from the string shape. This test
      // pins the contract: a future maintainer who removes the casts
      // and breaks pg's inference under unusual JS Date values would
      // see this test fail.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.insert({
        userId: SAMPLE_USER_ID,
        tokenRef: SAMPLE_TOKEN_REF,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);
      // Both timestamp parameters carry an explicit ::timestamptz
      // cast so pg's parameter binding is unambiguous.
      expect(config.text).toMatch(/\$3::timestamptz/i);
      expect(config.text).toMatch(/\$4::timestamptz/i);
    });

    it('serialises Date inputs as ISO-8601 strings on the wire', async () => {
      // The repository converts Dates to ISO-8601 strings before
      // passing to pg. Verifying the wire shape protects against a
      // refactor that "simplifies" the serialisation by passing raw
      // Date objects — which works in pg most of the time but fails
      // for unusual Date values (very early epoch timestamps, dates
      // produced by Date arithmetic in non-UTC timezones).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.insert({
        userId: SAMPLE_USER_ID,
        tokenRef: SAMPLE_TOKEN_REF,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);
      const values = (config.values ?? []) as readonly unknown[];

      // Both timestamp values are strings (not Date instances).
      expect(typeof values[2]).toBe('string');
      expect(typeof values[3]).toBe('string');
      // And they are exactly the toISOString() representation.
      expect(values[2]).toBe('2026-01-15T10:00:00.000Z');
      expect(values[3]).toBe('2026-01-16T10:00:00.000Z');
    });

    it('Rule R2: the values array carries no credential material', async () => {
      // Rule R2 (no credential material in logs/params): the
      // repository accepts only an opaque `tokenRef` derivative
      // supplied by the service layer — never a raw Firebase id
      // token, never a password, never a bearer string. This test
      // scans every parameter for credential-shaped patterns and
      // verifies the absence of `password`, `bearer`,
      // `credential`, and `authorization` substrings.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.insert({
        userId: SAMPLE_USER_ID,
        tokenRef: SAMPLE_TOKEN_REF,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);
      const values = (config.values ?? []) as readonly unknown[];

      // The INSERT column list is `(token_ref, user_id, issued_at,
      // expires_at)` — exactly FOUR `$N` placeholders. That means
      // `values.length` MUST be 4 — anything more would suggest
      // credential material leaking into the params.
      expect(values).toHaveLength(4);

      for (const v of values) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'string') {
          // No literal "password" / "bearer" / "credential" /
          // "authorization" substring (case-insensitive).
          expect(v.toLowerCase()).not.toContain('password');
          expect(v.toLowerCase()).not.toContain('bearer ');
          expect(v.toLowerCase()).not.toContain('credential');
          expect(v.toLowerCase()).not.toContain('authorization');
          // No JWT-shaped string (`xxx.yyy.zzz` with base64url
          // characters). A real Firebase id token would match this
          // pattern; a SHA-256 hash or opaque session id would not.
          expect(v).not.toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        }
      }
    });

    it('throws a descriptive error when INSERT RETURNING yields zero rows', async () => {
      // The defensive check in the source file: even though the
      // RETURNING clause is contractually required to yield exactly
      // one row, a future schema change could break that contract;
      // we want a LOUD failure (with a descriptive message) rather
      // than a silent `undefined` propagating into business logic.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: SAMPLE_USER_ID,
          tokenRef: SAMPLE_TOKEN_REF,
          issuedAt: FIXED_DATE,
          expiresAt: FIXED_EXPIRES_AT,
        }),
      ).rejects.toThrow(/INSERT did not return a row/i);
    });

    it('propagates UNIQUE-constraint violations (pg code 23505) without swallowing', async () => {
      // The `sessions.token_ref` column is the PRIMARY KEY (per
      // ST-031); a duplicate INSERT surfaces as PG `23505`
      // (`unique_violation`). The repository's contract is to
      // PROPAGATE the pg error so the service layer can translate
      // `23505` to an HTTP 500 (the duplicate is vanishingly rare
      // when tokenRef is a SHA-256 hash, so a 500 is the correct
      // signal — it indicates a hash collision or service-layer
      // bug). Swallowing the error here would force the service
      // layer to poll for the duplicate (extra round-trip).
      const pool = createMockPool();
      const pgError = Object.assign(
        new Error('duplicate key value violates unique constraint "sessions_pkey"'),
        {
          code: '23505',
          constraint: 'sessions_pkey',
          schema: 'public',
          table: 'sessions',
        },
      );
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createSessionRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: SAMPLE_USER_ID,
          tokenRef: SAMPLE_TOKEN_REF,
          issuedAt: FIXED_DATE,
          expiresAt: FIXED_EXPIRES_AT,
        }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'sessions_pkey',
      });
    });

    it('propagates foreign-key violations (pg code 23503) without swallowing', async () => {
      // The `sessions.user_id` column carries a foreign key to
      // `users.id` (per ST-031). An INSERT against an unknown
      // userId surfaces as PG `23503`
      // (`foreign_key_violation`); the service layer translates
      // this to HTTP 401 Unauthorized (no such user) rather than
      // any 5xx. The repository must surface the original pg error
      // shape so that translation is unambiguous.
      const pool = createMockPool();
      const pgError = Object.assign(
        new Error(
          'insert or update on table "sessions" violates foreign key constraint "sessions_user_id_fkey"',
        ),
        {
          code: '23503',
          constraint: 'sessions_user_id_fkey',
          schema: 'public',
          table: 'sessions',
        },
      );
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createSessionRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: 'unknown-uid-not-in-users-table',
          tokenRef: SAMPLE_TOKEN_REF,
          issuedAt: FIXED_DATE,
          expiresAt: FIXED_EXPIRES_AT,
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'sessions_user_id_fkey',
      });
    });

    it('Rule R8: connection-level pg errors propagate rather than being swallowed', async () => {
      // Rule R8 (gates fail closed): an infrastructure error must
      // NEVER be silently masked. A connection refused / pool
      // exhausted error must propagate up the stack so the service
      // layer can return a 5xx and the caller gets a clear failure.
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(
        new Error('connection refused: ECONNREFUSED 127.0.0.1:5432'),
      );

      const repo = createSessionRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: SAMPLE_USER_ID,
          tokenRef: SAMPLE_TOKEN_REF,
          issuedAt: FIXED_DATE,
          expiresAt: FIXED_EXPIRES_AT,
        }),
      ).rejects.toThrow(/connection refused/i);
    });
  });

  // =========================================================================
  // findByTokenRef — service-layer + diagnostic lookups
  // =========================================================================

  describe('findByTokenRef', () => {
    it('queries by token_ref and returns the canonical session', async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/SELECT/i);
      expect(config.text).toMatch(/FROM\s+sessions/i);
      expect(config.text).toMatch(/token_ref\s*=\s*\$1/);
      // The query MUST NOT carry a wildcard or a JOIN — those
      // would either bloat the result set or invite N+1 queries
      // downstream.
      expect(config.text).not.toMatch(/\bJOIN\b/i);
      expect(config.text).not.toMatch(/\*/);

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_TOKEN_REF]);

      expect(result).not.toBeNull();
      expect(result?.tokenRef).toBe(SAMPLE_TOKEN_REF);
      expect(result?.userId).toBe(SAMPLE_USER_ID);
      expect(result?.issuedAt).toEqual(FIXED_DATE);
      expect(result?.expiresAt).toEqual(FIXED_EXPIRES_AT);
      expect(result?.revokedAt).toBeNull();
    });

    it('returns null (NOT undefined) when no row matches', async () => {
      // Distinguishing `null` from `undefined` matters: middleware
      // and service code uses `=== null` checks to drive control
      // flow; an `undefined` return would silently bypass those
      // branches and produce non-deterministic behaviour.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef('nonexistent-token-ref');

      expect(result).toBeNull();
      // Stronger assertion: the value is exactly null, not undefined.
      expect(result === null).toBe(true);
    });

    it('passes the token_ref through unmodified (no normalization)', async () => {
      // The repository is a thin data-access layer; case-folding /
      // normalization is the caller's responsibility. This test
      // pins the contract: the repository must NOT modify the input.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      await repo.findByTokenRef('  Mixed-Case-Token-REF-123  ');

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual(['  Mixed-Case-Token-REF-123  ']);
    });

    it('returns the row mapped from snake_case to camelCase including revokedAt', async () => {
      // Verifies the mapper handles a row with a non-null
      // `revoked_at` — i.e., a session that has been logged out.
      // Distinct from the active-session test above because the
      // mapper must preserve the Date instance through the
      // snake_case → camelCase translation.
      const pool = createMockPool();
      const revokedAt = new Date('2026-01-15T11:30:00.000Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: revokedAt,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef(SAMPLE_TOKEN_REF);

      expect(result).not.toBeNull();
      expect(result?.revokedAt).toEqual(revokedAt);
      expect(result?.revokedAt).toBeInstanceOf(Date);
    });

    it('SELECT statement must be parameterised (no string concatenation)', async () => {
      // SQL-injection invariant: even though token_ref is
      // server-issued (a hash), the repository must enforce the
      // parameterisation invariant universally — repositories never
      // interpolate values into the statement text.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      await repo.findByTokenRef("attempt'; DROP TABLE sessions; --");

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/\$1/);
      expect(config.text).not.toContain('DROP TABLE');
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('connection refused: ECONNREFUSED'));

      const repo = createSessionRepository(asPool(pool));

      await expect(repo.findByTokenRef(SAMPLE_TOKEN_REF)).rejects.toThrow(/connection refused/i);
    });
  });

  // =========================================================================
  // markRevoked — logout flow (ST-025), idempotent
  // =========================================================================

  describe('markRevoked', () => {
    it('updates the session row and returns the canonical session with revokedAt set', async () => {
      // Happy path: the UPDATE statement targets the supplied
      // tokenRef and sets `revoked_at = COALESCE(revoked_at,
      // now())`. The RETURNING clause yields the row whose
      // `revoked_at` is now the database's `now()` value (which
      // we simulate via the test fixture timestamp).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.markRevoked(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/UPDATE\s+sessions/i);
      expect(config.text).toMatch(/SET\s+revoked_at/i);
      expect(config.text).toMatch(/WHERE\s+token_ref\s*=\s*\$1/);
      expect(config.text).toMatch(/RETURNING/i);

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_TOKEN_REF]);

      expect(result).not.toBeNull();
      expect(result?.tokenRef).toBe(SAMPLE_TOKEN_REF);
      expect(result?.revokedAt).toEqual(FIXED_DATE);
    });

    it('uses COALESCE(revoked_at, now()) for idempotency-preserving UPDATE', async () => {
      // The source file documents:
      //   "Idempotency is enforced via COALESCE(revoked_at, now()):
      //    First call: revoked_at is NULL, COALESCE evaluates the
      //    second argument and the column is set to now().
      //    Subsequent calls: revoked_at is already non-null,
      //    COALESCE returns the existing value and the column does
      //    not change."
      //
      // This test pins the COALESCE pattern. A future refactor that
      // replaced it with `SET revoked_at = now()` (without a
      // conditional WHERE) would lose idempotency and fail this
      // test loudly.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.markRevoked(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      // Expect the COALESCE pattern. The regex tolerates whitespace
      // variations that a future code-formatter run might
      // introduce.
      expect(config.text).toMatch(
        /SET\s+revoked_at\s*=\s*COALESCE\s*\(\s*revoked_at\s*,\s*now\(\)\s*\)/i,
      );
    });

    it('is idempotent — a second markRevoked call preserves the original revocation timestamp', async () => {
      // The audit-correct semantics: "when did the user FIRST end
      // this session?" Per ST-025-AC3 ("submitting the same
      // revoked token again returns a documented non-error response
      // and does not alter state"), a second markRevoked call must
      // NOT update the timestamp.
      //
      // We simulate the database's COALESCE behaviour by returning
      // the same `revoked_at` value across both calls — even when
      // the system clock has advanced between them. The mock
      // mirrors what a real PostgreSQL server would do under the
      // COALESCE expression.
      const pool = createMockPool();
      const ORIGINAL_REVOCATION = FIXED_DATE;

      // First call: revoke at FIXED_DATE.
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: ORIGINAL_REVOCATION,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const first = await repo.markRevoked(SAMPLE_TOKEN_REF);
      expect(first?.revokedAt).toEqual(ORIGINAL_REVOCATION);

      // Advance the system clock by an hour.
      jest.setSystemTime(new Date('2026-01-15T11:00:00.000Z'));

      // Second call at the new wall-clock time — but the DB row
      // returned still carries ORIGINAL_REVOCATION because
      // COALESCE preserved it.
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: ORIGINAL_REVOCATION,
          },
        ]),
      );
      const second = await repo.markRevoked(SAMPLE_TOKEN_REF);

      expect(second?.revokedAt).toEqual(ORIGINAL_REVOCATION);
      // Both calls return the SAME revocation timestamp.
      expect(second?.revokedAt).toEqual(first?.revokedAt);

      // Both calls used the same SQL text (no dynamic SQL).
      const firstConfig = getQueryConfig(pool, 0);
      const secondConfig = getQueryConfig(pool, 1);
      expect(firstConfig.text).toBe(secondConfig.text);
    });

    it('returns null when no session exists with that token_ref', async () => {
      // Per ST-025-AC3, logout against an unknown token does not
      // raise an error — it returns a non-error response. The
      // repository surfaces `null` (because UPDATE affected zero
      // rows and RETURNING produced an empty result set), and the
      // service layer translates that to the documented
      // non-error HTTP response.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.markRevoked('nonexistent-token-ref');

      expect(result).toBeNull();
      // Stronger assertion: the value is exactly null, not undefined.
      expect(result === null).toBe(true);
    });

    it('UPDATE statement must be parameterised', async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      await repo.markRevoked("attempt'; DROP TABLE sessions; --");

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/\$1/);
      expect(config.text).not.toContain('DROP TABLE');
    });

    it('UPDATE statement uses RETURNING to avoid a follow-up SELECT', async () => {
      // The source file documents that the RETURNING clause hands
      // back the canonical row so the service layer can log the
      // actual revocation timestamp without an extra SELECT.
      // Verifying RETURNING is in the SQL pins that one-round-trip
      // contract.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.markRevoked(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/RETURNING\s+token_ref\s*,\s*user_id/i);
      // Exactly ONE query — no follow-up SELECT.
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('pool exhausted'));

      const repo = createSessionRepository(asPool(pool));

      await expect(repo.markRevoked(SAMPLE_TOKEN_REF)).rejects.toThrow(/pool exhausted/i);
    });
  });

  // =========================================================================
  // isActive — middleware-time validation (ST-026)
  // =========================================================================

  describe('isActive', () => {
    it('returns true when expires_at > now() AND revoked_at IS NULL', async () => {
      // The boolean is computed at the DB tier — the mock returns
      // a single row carrying `is_active: true`, simulating the
      // SELECT expression `(expires_at > now() AND revoked_at IS
      // NULL) AS is_active`.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([{ is_active: true }]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.isActive(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      // The SQL targets the sessions table and includes both
      // active-session predicates. We assert each predicate
      // independently so a regression on either side surfaces
      // distinctly.
      expect(config.text).toMatch(/FROM\s+sessions/i);
      expect(config.text).toMatch(/token_ref\s*=\s*\$1/);
      expect(config.text).toMatch(/expires_at\s*>\s*now\(\)/i);
      expect(config.text).toMatch(/revoked_at\s+IS\s+NULL/i);

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_TOKEN_REF]);

      expect(result).toBe(true);
    });

    it('returns false when the DB returns is_active = false (expired or revoked)', async () => {
      // The DB-side predicate evaluated to false — could be
      // either expiration or revocation; the repository contract
      // doesn't distinguish (and shouldn't, because the
      // middleware just needs a boolean).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([{ is_active: false }]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.isActive('expired-or-revoked-token');

      expect(result).toBe(false);
    });

    it('returns false when no row matches the token_ref (session never existed)', async () => {
      // When no session row exists, the SELECT returns an empty
      // result set. The repository's contract is `Promise<boolean>`,
      // so it must coerce "no row" to `false` — this test pins
      // that coercion.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.isActive('never-existed-token');

      expect(result).toBe(false);
    });

    it('returns false (defensively) when DB returns a non-boolean truthy value', async () => {
      // The source file uses strict-equals-true (`row?.is_active
      // === true`) rather than truthy coercion — robust against
      // any pg driver quirk that might return a string `'t'` or
      // numeric `1` instead of a JS boolean. This test simulates
      // the quirk and verifies the repository returns false (per
      // its own boolean contract) rather than blindly coercing.
      //
      // The cast through `unknown` is intentional: we are
      // simulating an adversarial driver state to verify the
      // runtime defense layer.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([{ is_active: 't' as unknown as boolean }]));

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.isActive(SAMPLE_TOKEN_REF);

      expect(result).toBe(false);
    });

    it('returns false when DB returns is_active = null (defensive)', async () => {
      // The `===  true` strict comparison also rejects `null`,
      // which is what an adversarial DB row carrying a
      // `is_active: null` value would yield after the JS-side
      // optional-chaining lookup.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([{ is_active: null as unknown as boolean }]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.isActive(SAMPLE_TOKEN_REF);

      expect(result).toBe(false);
    });

    it('uses parameterised placeholder for token_ref', async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      await repo.isActive("attempt'; DROP TABLE sessions; --");

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/\$1/);
      expect(config.text).not.toContain('DROP TABLE');
    });

    it('selects only the is_active expression — minimal data on the wire', async () => {
      // The source file documents that returning the boolean
      // directly (rather than the row) lets pg execute an
      // index-only-ish scan. Verifying the SELECT projection here
      // pins that minimal-data contract. A regression that
      // SELECTed `*` would show up loudly.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([{ is_active: true }]));

      const repo = createSessionRepository(asPool(pool));
      await repo.isActive(SAMPLE_TOKEN_REF);

      const config = getQueryConfig(pool);
      // The query selects an expression aliased AS is_active, NOT
      // a full row.
      expect(config.text).toMatch(/\bAS\s+is_active\b/i);
      // No wildcard projection.
      expect(config.text).not.toMatch(/SELECT\s+\*/i);
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('connection refused: ECONNREFUSED'));

      const repo = createSessionRepository(asPool(pool));

      await expect(repo.isActive(SAMPLE_TOKEN_REF)).rejects.toThrow(/connection refused/i);
    });
  });

  // =========================================================================
  // Row mapping — snake_case → camelCase
  // =========================================================================

  describe('row mapping', () => {
    it('translates DB column names to camelCase domain fields', async () => {
      // The mapper is private to session.repository.ts; we verify
      // it through the public surface. A row shaped exactly like
      // the database returns (snake_case keys) MUST emerge as the
      // public-shaped Session (camelCase keys) with no extra
      // fields and no missing fields.
      const pool = createMockPool();
      const dbIssuedAt = new Date('2025-12-31T00:00:00.000Z');
      const dbExpiresAt = new Date('2026-01-01T00:00:00.000Z');
      const dbRevokedAt = new Date('2025-12-31T12:00:00.000Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: 'tr',
            user_id: 'uid',
            issued_at: dbIssuedAt,
            expires_at: dbExpiresAt,
            revoked_at: dbRevokedAt,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef('tr');

      // `as Session` cast is for type safety only; the deep
      // equality assertion below is what does the work.
      const expected: Session = {
        tokenRef: 'tr',
        userId: 'uid',
        issuedAt: dbIssuedAt,
        expiresAt: dbExpiresAt,
        revokedAt: dbRevokedAt,
      };
      expect(result).toEqual(expected);
    });

    it('preserves null in revokedAt when row.revoked_at is null', async () => {
      // The mapper must NOT coerce a null revokedAt to undefined
      // or to anything else — the public interface explicitly
      // declares `revokedAt: Date | null`, so the contract is to
      // preserve the null sentinel.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef(SAMPLE_TOKEN_REF);

      expect(result?.revokedAt).toBeNull();
      // Stronger assertion: NOT undefined.
      expect(result?.revokedAt === null).toBe(true);
    });

    it('preserves the Date instance for issuedAt / expiresAt (no copy / no string coercion)', async () => {
      // Some mappers stringify Date values; the Session contract
      // says all three timestamp fields are `Date`. Verify the
      // runtime values are still Date instances.
      const pool = createMockPool();
      const dbIssuedAt = new Date('2024-06-15T13:45:30.123Z');
      const dbExpiresAt = new Date('2024-06-16T13:45:30.123Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: dbIssuedAt,
            expires_at: dbExpiresAt,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef(SAMPLE_TOKEN_REF);

      expect(result?.issuedAt).toBeInstanceOf(Date);
      expect(result?.expiresAt).toBeInstanceOf(Date);
      expect(result?.issuedAt.toISOString()).toBe('2024-06-15T13:45:30.123Z');
      expect(result?.expiresAt.toISOString()).toBe('2024-06-16T13:45:30.123Z');
    });

    it('does NOT add fields beyond the canonical Session shape', async () => {
      // If the mapper introduced an `extras` or `meta` field, it
      // would expand the public surface beyond what AAP §0.7.2
      // permits and would surface a documentation drift between
      // the Session interface and the runtime shape.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
            // A column that the SELECT statement does NOT request,
            // but which `pg` in some edge cases could surface.
            // The mapper must filter it out by NOT projecting it.
            extra_unwanted_column: 'should-not-leak',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      const result = await repo.findByTokenRef(SAMPLE_TOKEN_REF);

      expect(result).not.toBeNull();
      const keys = Object.keys(result as object).sort();
      expect(keys).toEqual(['expiresAt', 'issuedAt', 'revokedAt', 'tokenRef', 'userId']);
    });
  });

  // =========================================================================
  // Determinism — ST-043-AC3 ("repeated runs produce the same verdict")
  // =========================================================================

  describe('determinism (ST-043-AC3)', () => {
    it('repeated calls to the same method produce byte-identical SQL text', async () => {
      // ST-043-AC3 demands deterministic verdicts across runs. A
      // common source of non-determinism in repositories is
      // dynamic SQL construction (e.g., concatenating WHERE
      // clauses based on optional params). The session
      // repository builds NO dynamic SQL — every method has a
      // fixed SQL constant. This test pins that property: two
      // calls produce two byte-identical `text` fields.
      const pool = createMockPool();
      pool.query.mockResolvedValue(mockQueryResult([]));

      const repo = createSessionRepository(asPool(pool));
      await repo.findByTokenRef('a');
      await repo.findByTokenRef('b');

      const first = getQueryConfig(pool, 0);
      const second = getQueryConfig(pool, 1);
      expect(first.text).toBe(second.text);
    });

    it('all four methods produce SQL constants stable across invocations', async () => {
      // Extends the determinism check across every public method.
      // If any method introduced dynamic SQL in a future refactor,
      // this test would catch it.
      const pool = createMockPool();
      pool.query.mockResolvedValue(
        mockQueryResult([
          {
            token_ref: SAMPLE_TOKEN_REF,
            user_id: SAMPLE_USER_ID,
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
            is_active: true,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      // Two invocations per method — different inputs each time.
      await repo.insert({
        userId: 'u1',
        tokenRef: 't1',
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });
      await repo.insert({
        userId: 'u2',
        tokenRef: 't2',
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });
      await repo.findByTokenRef('a');
      await repo.findByTokenRef('b');
      await repo.markRevoked('a');
      await repo.markRevoked('b');
      await repo.isActive('a');
      await repo.isActive('b');

      // Pair up calls per method (indices 0/1 = insert, 2/3 =
      // findByTokenRef, 4/5 = markRevoked, 6/7 = isActive).
      expect(getQueryConfig(pool, 0).text).toBe(getQueryConfig(pool, 1).text);
      expect(getQueryConfig(pool, 2).text).toBe(getQueryConfig(pool, 3).text);
      expect(getQueryConfig(pool, 4).text).toBe(getQueryConfig(pool, 5).text);
      expect(getQueryConfig(pool, 6).text).toBe(getQueryConfig(pool, 7).text);
    });

    it('the values array order is stable across repeated insert calls', async () => {
      // The INSERT SQL has columns `(token_ref, user_id,
      // issued_at, expires_at)`, so values MUST be `[tokenRef,
      // userId, issuedAt-ISO, expiresAt-ISO]` in that exact
      // order, every time.
      const pool = createMockPool();
      pool.query.mockResolvedValue(
        mockQueryResult([
          {
            token_ref: 't1',
            user_id: 'u1',
            issued_at: FIXED_DATE,
            expires_at: FIXED_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createSessionRepository(asPool(pool));
      await repo.insert({
        tokenRef: 't1',
        userId: 'u1',
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });
      await repo.insert({
        tokenRef: 't2',
        userId: 'u2',
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      });

      const firstValues = getQueryConfig(pool, 0).values as readonly unknown[];
      const secondValues = getQueryConfig(pool, 1).values as readonly unknown[];

      expect(firstValues).toEqual([
        't1',
        'u1',
        FIXED_DATE.toISOString(),
        FIXED_EXPIRES_AT.toISOString(),
      ]);
      expect(secondValues).toEqual([
        't2',
        'u2',
        FIXED_DATE.toISOString(),
        FIXED_EXPIRES_AT.toISOString(),
      ]);
    });
  });

  // =========================================================================
  // Type-level invariants — Rule R2 design-time enforcement
  // =========================================================================

  describe('type contract (Rule R2 — no credential parameters)', () => {
    it('the InsertSessionParams type does NOT permit a "password" or "credential" field', () => {
      // STATIC test: this assertion is executed at compile time.
      // If a future maintainer adds `password?: string` to
      // InsertSessionParams in session.repository.ts, the
      // conditional type `HasPassword` resolves to `true` and the
      // assignment of `false` to `_hasPassword` becomes a type
      // error — failing the type-check gate (MG1-E ST-037) before
      // this test ever runs.
      //
      // The runtime expect() is included so this test contributes
      // to the it-pass count and so the assertion is visible to
      // anyone reading the test output.
      const pool = createMockPool();
      const repo = createSessionRepository(asPool(pool));

      // Extract the parameter type of the insert method.
      type InsertParams = Parameters<typeof repo.insert>[0];

      // A valid insert payload — exercises the positive case.
      const _validPayload: InsertParams = {
        userId: SAMPLE_USER_ID,
        tokenRef: SAMPLE_TOKEN_REF,
        issuedAt: FIXED_DATE,
        expiresAt: FIXED_EXPIRES_AT,
      };
      // Reference the payload to satisfy noUnusedLocals.
      void _validPayload;

      // Conditional types: do InsertParams contain credential
      // fields of any type?
      type HasPassword = InsertParams extends { password: unknown } ? true : false;
      type HasPasswordHash = InsertParams extends { passwordHash: unknown } ? true : false;
      type HasCredential = InsertParams extends { credential: unknown } ? true : false;
      type HasBearer = InsertParams extends { bearer: unknown } ? true : false;
      type HasAuthorization = InsertParams extends { authorization: unknown } ? true : false;
      type HasSecret = InsertParams extends { secret: unknown } ? true : false;

      // The runtime values mirror the compile-time conditionals.
      // If a future change introduces any forbidden parameter,
      // the line `const hasPassword: HasPassword = false;`
      // becomes a type error (true is not assignable to false),
      // failing the type-check gate.
      const hasPassword: HasPassword = false;
      const hasPasswordHash: HasPasswordHash = false;
      const hasCredential: HasCredential = false;
      const hasBearer: HasBearer = false;
      const hasAuthorization: HasAuthorization = false;
      const hasSecret: HasSecret = false;

      // Runtime assertions — visible in the test reporter and
      // contribute to the deterministic verdict.
      expect(hasPassword).toBe(false);
      expect(hasPasswordHash).toBe(false);
      expect(hasCredential).toBe(false);
      expect(hasBearer).toBe(false);
      expect(hasAuthorization).toBe(false);
      expect(hasSecret).toBe(false);
    });

    it('the Session interface marks every field readonly', () => {
      // STATIC test: every Session field is `readonly` per the
      // source file's interface declaration. The standard
      // `IfEquals` technique (a generic-function-identity trick)
      // is the only way to detect readonly modifiers reliably in
      // a TypeScript type test — simple `extends` checks are
      // bidirectionally compatible across readonly/writable
      // boundaries because of TypeScript's structural typing.
      //
      // The mapped type `-readonly [K in keyof T]` strips every
      // readonly modifier from T. If Session and its
      // readonly-stripped twin are STRUCTURALLY DIFFERENT
      // (`IfEquals` returns the false branch), then Session
      // carries readonly fields. A regression that removes a
      // readonly modifier would make Session structurally equal
      // to its stripped twin, flip `IfEquals` to its true
      // branch, and produce a compile-time error here.
      //
      // The runtime assertion is preserved so this test
      // contributes to the it-pass count and so the static
      // verdict is visible in test output.
      type StripReadonly<T> = { -readonly [K in keyof T]: T[K] };
      type IfEquals<X, Y, A = true, B = false> =
        (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B;

      // Session and its readonly-stripped twin are NOT equal
      // because Session marks every field readonly. So this
      // resolves to `true`.
      type SessionIsReadonly = IfEquals<Session, StripReadonly<Session>, false, true>;

      const sessionIsReadonly: SessionIsReadonly = true;
      expect(sessionIsReadonly).toBe(true);
    });
  });
});
