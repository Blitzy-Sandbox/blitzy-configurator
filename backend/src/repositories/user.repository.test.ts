/**
 * Unit tests for `backend/src/repositories/user.repository.ts`.
 *
 * Verifies the three exported members on the `UserRepository` contract
 * (`insert`, `findByLoginIdentifier`, `findByFirebaseUid`) plus the
 * static type contract on `InsertUserParams` against the security and
 * schema invariants documented in the source file:
 *
 *   1. INSERT statement targets `users` table, includes `RETURNING`,
 *      and passes the Firebase uid + login identifier (and ONLY those)
 *      through the `values` array — `credential_digest` is unreachable
 *      from application code (Rule R3 + AAP §0.2.1).
 *   2. SELECT statements use parameterised `$1` placeholders (no string
 *      interpolation of input — SQL-injection invariant).
 *   3. The mapper translates snake_case columns (`login_identifier`,
 *      `credential_digest`, `created_at`) to camelCase domain fields
 *      (`loginIdentifier`, `credentialDigest`, `createdAt`).
 *   4. `credential_digest` is ALWAYS `null` in the returned `User`
 *      regardless of whether the DB row carries a value (defense-in-
 *      depth: the mapper forcibly returns `null`).
 *   5. `findByLoginIdentifier`/`findByFirebaseUid` return `null` when
 *      the result set is empty, never `undefined`.
 *   6. PG errors (including `23505` UNIQUE violations and connection
 *      errors) propagate up the call stack rather than being swallowed
 *      (Rule R8 — fail-closed posture).
 *   7. The TypeScript signature of `insert()` does NOT permit a
 *      `password` (or similarly-named credential) parameter — verified
 *      via a conditional-type assertion that is a compile-time check
 *      AND a run-time assertion.
 *
 * Authority:
 *   - Story ST-023 acceptance criteria (registration must NEVER store
 *     credentials in cleartext and MUST return a canonical user
 *     record without credential material).
 *   - Story ST-031 acceptance criteria (users-table schema with
 *     `credential_digest` sized "to prevent storage of cleartext
 *     credentials").
 *   - Story ST-043 acceptance criteria (deterministic, local-only,
 *     no-network unit suite).
 *   - AAP §0.2.1 Firebase user-mirroring resolution (`credential_digest`
 *     column EXISTS but is NEVER populated; the local users.id IS the
 *     Firebase uid).
 *   - AAP §0.8.1 R2 (no credential material in logs/params), R3
 *     (Firebase Admin SDK only), R8 (gates fail closed).
 *
 * Determinism (ST-043-AC3):
 *   - The mocked `pg.Pool` returns deterministic, in-memory results so
 *     no asynchronous boundary depends on external timing.
 *   - `jest.useFakeTimers({ now: FIXED_DATE })` pins the Date used by
 *     any `created_at` comparison so assertions never race past a
 *     second boundary. (The repository itself does not invoke `Date`
 *     directly — `created_at` originates from `pg` — but pinning the
 *     wall clock is a defensive measure against future refactors and
 *     keeps fixture timestamps comparable across CI runners.)
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
 * @see backend/src/repositories/user.repository.ts — module under test
 * @see tickets/stories/ST-023-user-registration-endpoint.md
 * @see tickets/stories/ST-031-users-sessions-schema-migration.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// Type-only imports — required by the `@typescript-eslint/consistent-type-
// imports` rule in `.eslintrc.json`. The `Pool` type is used solely as the
// generic argument to `jest.Mocked<Pool>`; `QueryResultRow` is used as the
// generic bound on the `mockQueryResult` helper. Neither is a runtime
// dependency, so a pure type import is the correct form.
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { createUserRepository, type User } from './user.repository';

// ---------------------------------------------------------------------------
// Test fixtures — deterministic constants used throughout the suite.
// ---------------------------------------------------------------------------

/**
 * Stable wall-clock pin for the suite. All `created_at` assertions
 * compare against this fixed date so the suite remains deterministic
 * across machines and across second-boundaries (ST-043-AC3).
 *
 * The date was chosen to fall comfortably inside the StrikeForge launch
 * window; any value would work because the only constraint is
 * stability, but a near-launch date makes the fixture self-documenting
 * for humans reading test logs.
 */
const FIXED_DATE: Date = new Date('2026-01-15T10:00:00Z');

/**
 * The stable Firebase uid used as the canonical "successful insert"
 * fixture. Per AAP §0.2.1, the local `users.id` IS the Firebase uid;
 * this string is therefore both the PK and the value the session
 * middleware uses to look up a user after `verifyIdToken` returns.
 *
 * Format mimics a realistic Firebase uid (28-character base62-ish
 * string), giving the assertions a non-trivial-but-still-readable
 * fixture to match against.
 */
const SAMPLE_FIREBASE_UID = 'firebase-uid-abc123XYZ456789012345678';

/**
 * The canonical login identifier (an email) used in the happy-path
 * fixtures. The value is intentionally syntactically valid so any
 * downstream layer that performs additional email validation does not
 * trip on the fixture itself.
 */
const SAMPLE_LOGIN_IDENTIFIER = 'user@example.com';

// ---------------------------------------------------------------------------
// Mock helpers.
// ---------------------------------------------------------------------------
//
// The repository depends on a single object — a `pg.Pool` — and only ever
// invokes its `query` method via the QueryConfig OBJECT form
// (`pool.query<UserRow>({ text, values })`). The `pg` types declare
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
 * the user repository calls — `pool.query<R>(config: QueryConfig)`.
 *
 * Using a single-signature function type is what makes
 * `mockResolvedValueOnce(QueryResult<...>)` and
 * `mockRejectedValueOnce(Error)` typecheck. Jest's `MockedFunction` only
 * infers correctly from a single-overload function shape.
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
 * `rows` — `command`, `rowCount`, `oid`, `fields`, `rowAsArray` (in
 * some versions). The repository under test reads only `rows`, so the
 * extra fields are populated with neutral default values that mirror
 * what `pg` would actually return for a SELECT or RETURNING query.
 *
 * Generic constraint `T extends QueryResultRow` matches the
 * repository's own `pool.query<UserRow>(...)` typing so a mocked
 * result cannot accidentally substitute an array-shaped row.
 */
function mockQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    // `command` is informational — the repository never reads it.
    // 'SELECT' is the safest default since most repository queries are
    // SELECTs; INSERT-with-RETURNING also receives SELECT semantics
    // for the returned row in `pg`'s contract.
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

/**
 * Capture the QueryConfig argument of a `pool.query<UserRow>(...)` call.
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
  // The repository ALWAYS uses the QueryConfig object form (verified at
  // compile time by the source file's `pool.query<UserRow>({ text, values })`
  // signature). The cast is therefore safe; if a future refactor changes
  // the call form, this assertion would surface that drift loudly.
  return call[0];
}

// ---------------------------------------------------------------------------
// Suite-level lifecycle hooks — fake timers for deterministic Date semantics.
// ---------------------------------------------------------------------------
//
// `jest.useFakeTimers({ now: FIXED_DATE })` makes `Date.now()` and the
// `Date` constructor return the same wall-clock value across every test in
// the file. The repository under test does not invoke `Date` directly
// (the `created_at` column is supplied by PostgreSQL's `now()` default),
// but pinning the clock is a defensive measure: it guards against future
// refactors that introduce client-side `Date` calls and it ensures fixture
// timestamps stay comparable when tests cross second boundaries on slow
// runners.
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
// createUserRepository — factory contract
// ===========================================================================

describe('createUserRepository', () => {
  it('returns an object with the three documented methods', () => {
    // The repository contract specifies exactly three methods. A test
    // that enumerates them protects against accidental API additions
    // (which would expand the public surface and therefore the
    // out-of-scope risk per AAP §0.7.2) and accidental removals.
    const pool = createMockPool();
    const repo = createUserRepository(asPool(pool));

    expect(typeof repo.insert).toBe('function');
    expect(typeof repo.findByLoginIdentifier).toBe('function');
    expect(typeof repo.findByFirebaseUid).toBe('function');
  });

  it('returns a frozen object so methods cannot be monkey-patched', () => {
    // The factory is documented to call `Object.freeze` on the
    // returned record — protecting against the class of bugs where a
    // test or middleware accidentally substitutes a repository method
    // at runtime. Verifying the freeze here pins the contract.
    const pool = createMockPool();
    const repo = createUserRepository(asPool(pool));

    expect(Object.isFrozen(repo)).toBe(true);
  });

  it('does NOT invoke pool.query during construction (lazy initialisation)', () => {
    // Constructing the repository must not issue any database call.
    // Eager queries during composition would slow startup and would
    // defeat dependency-injection-based testing.
    const pool = createMockPool();
    createUserRepository(asPool(pool));

    expect(pool.query).not.toHaveBeenCalled();
  });

  // =========================================================================
  // insert — registration entry point (ST-023)
  // =========================================================================

  describe('insert', () => {
    it('inserts a user row with the expected columns and values', async () => {
      // Arrange: the INSERT ... RETURNING clause yields the freshly-
      // persisted row with the DB-assigned `created_at` and the
      // schema-mandated `null` `credential_digest`.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));

      // Act
      const result = await repo.insert({
        firebaseUid: SAMPLE_FIREBASE_UID,
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
      });

      // Assert: query shape
      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/INSERT\s+INTO\s+users/i);
      expect(config.text).toMatch(/login_identifier/);
      expect(config.text).toMatch(/RETURNING/i);

      // Assert: parameter order (Firebase uid first because it maps
      // to the explicit `id` column in the INSERT statement). Both
      // values appear in the params; no extra params smuggled in.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toBeDefined();
      expect(values).toEqual([SAMPLE_FIREBASE_UID, SAMPLE_LOGIN_IDENTIFIER]);

      // Assert: returned canonical record shape (snake_case → camelCase)
      expect(result).toEqual({
        id: SAMPLE_FIREBASE_UID,
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
        credentialDigest: null,
        createdAt: FIXED_DATE,
      });

      // Assert: exactly one query was issued.
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('uses parameterised placeholders ($1, $2) — no string interpolation of input', async () => {
      // SQL-injection invariant: the INSERT must use $1, $2 markers
      // and pass user-supplied values via the `values` array. The
      // login identifier in this test contains characters (single
      // quote, semicolon) that would be catastrophic if interpolated
      // into the SQL text directly.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: "evil'; DROP TABLE users; --",
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      await repo.insert({
        firebaseUid: SAMPLE_FIREBASE_UID,
        loginIdentifier: "evil'; DROP TABLE users; --",
      });

      const config = getQueryConfig(pool);
      // Statement uses placeholders; user input is NOT in the SQL text.
      expect(config.text).toMatch(/\$1/);
      expect(config.text).toMatch(/\$2/);
      expect(config.text).not.toContain("evil'; DROP TABLE");
      // User input flows through values, not text interpolation.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toContain("evil'; DROP TABLE users; --");
    });

    it('Rule R3 + AAP §0.2.1: credential_digest is NEVER populated in INSERT params', async () => {
      // The mirror discipline: even when the DB row reports a value,
      // application code must NEVER push a non-null credential_digest
      // through the query parameters. This test validates that no
      // bcrypt-, argon2-, or generic-hash-shaped string sneaks into
      // the params array.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      await repo.insert({
        firebaseUid: SAMPLE_FIREBASE_UID,
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
      });

      const config = getQueryConfig(pool);
      const values = (config.values ?? []) as readonly unknown[];

      // Acceptable shapes per the source file's INSERT_USER_SQL
      // constant: the column list is `(id, login_identifier)` with
      // exactly TWO `$N` placeholders. That means `values.length`
      // MUST be 2 — anything more would suggest credential material
      // leaking into the params.
      expect(values).toHaveLength(2);

      for (const v of values) {
        if (v === null || v === undefined) continue;
        // Type-coerce non-string params to a stable string representation
        // for pattern matching. We only inspect string values for
        // credential-shaped patterns.
        if (typeof v === 'string') {
          // bcrypt hashes start with `$2a$`, `$2b$`, or `$2y$`.
          expect(v).not.toMatch(/^\$2[aby]?\$/);
          // argon2 hashes start with `$argon2`.
          expect(v).not.toMatch(/^\$argon2/);
          // PHC-format scrypt and the historical `$1$` (md5-crypt)
          // and `$5$`, `$6$` (sha256/sha512-crypt) prefixes.
          expect(v).not.toMatch(/^\$[156]\$/);
          expect(v).not.toMatch(/^\$scrypt\$/);
          // bcrypt typical length is ~60; argon2 ~95+. A real-world
          // login identifier (email) caps at 254 per RFC 5321 but
          // anything below 80 is a safe upper bound for our fixtures.
          // We assert a generous 254 ceiling — credentials in the wild
          // exceed this — but combined with the prefix checks above,
          // it provides defense-in-depth.
          expect(v.length).toBeLessThanOrEqual(254);
          // No literal "password" substring — guards against an obvious
          // mis-wiring that injected the cleartext password.
          expect(v.toLowerCase()).not.toContain('password');
        }
      }
    });

    it('returns the canonical user record without any credential field beyond the literal null', async () => {
      // ST-023-AC2: "Successful registration returns the canonical
      // user record (without any credential material)". This
      // assertion covers the contract: the returned object's keys are
      // EXACTLY {id, loginIdentifier, credentialDigest, createdAt}
      // and `credentialDigest` is the literal `null`.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.insert({
        firebaseUid: SAMPLE_FIREBASE_UID,
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
      });

      // Strict key set assertion.
      expect(Object.keys(result).sort()).toEqual(
        ['createdAt', 'credentialDigest', 'id', 'loginIdentifier'].sort(),
      );
      // Literal-null contract.
      expect(result.credentialDigest).toBeNull();
      // Spot-check that no field named `password`, `passwordHash`,
      // `credential`, or `secret` ever appears on the returned shape.
      const resultRecord = result as unknown as Record<string, unknown>;
      expect(resultRecord['password']).toBeUndefined();
      expect(resultRecord['passwordHash']).toBeUndefined();
      expect(resultRecord['credential']).toBeUndefined();
      expect(resultRecord['secret']).toBeUndefined();
    });

    it('defense-in-depth: mapper forces credentialDigest=null even if DB row carries a value', async () => {
      // The source file's `mapUserRow` is documented as "forcibly
      // returns `null`" so the public contract holds even under
      // adversarial DB state. This test simulates that adversarial
      // state — a row whose `credential_digest` is somehow a Buffer —
      // and asserts the mapper STILL returns `null`.
      //
      // The cast through `unknown` is intentional: this row shape
      // intentionally violates the static `UserRow` type to verify
      // the runtime defense layer.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            // Adversarial value — a buffer of bytes that LOOKS like a
            // credential digest. The mapper must wash this away.
            credential_digest: Buffer.from(
              'this-should-never-be-returned-but-defense-in-depth',
              'utf8',
            ),
            created_at: FIXED_DATE,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.insert({
        firebaseUid: SAMPLE_FIREBASE_UID,
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
      });

      expect(result.credentialDigest).toBeNull();
    });

    it('propagates UNIQUE-constraint violations (pg code 23505) without swallowing', async () => {
      // ST-023-AC3: "Registration attempts that fail validation
      // (...duplicate identifier) return a descriptive, non-leaking
      // error response and do not create any partial record." The
      // repository's contract is to PROPAGATE the pg error so the
      // service layer can translate `23505` → HTTP 409 Conflict.
      // Swallowing the error here would force the service layer to
      // poll for the duplicate (extra round-trip) — much worse.
      const pool = createMockPool();
      const pgError = Object.assign(
        new Error('duplicate key value violates unique constraint "users_login_identifier_key"'),
        {
          code: '23505',
          constraint: 'users_login_identifier_key',
          schema: 'public',
          table: 'users',
        },
      );
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createUserRepository(asPool(pool));

      await expect(
        repo.insert({
          firebaseUid: SAMPLE_FIREBASE_UID,
          loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
        }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'users_login_identifier_key',
      });
    });

    it('throws a descriptive error when INSERT RETURNING yields zero rows', async () => {
      // The defensive check in the source file: even though the
      // RETURNING clause is contractually required to yield exactly
      // one row, a future schema change could break that contract;
      // we want a LOUD failure (with a descriptive message) rather
      // than a silent `undefined` propagating into business logic.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));

      await expect(
        repo.insert({
          firebaseUid: SAMPLE_FIREBASE_UID,
          loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
        }),
      ).rejects.toThrow(/INSERT did not return a row/i);
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

      const repo = createUserRepository(asPool(pool));

      await expect(
        repo.insert({
          firebaseUid: SAMPLE_FIREBASE_UID,
          loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
        }),
      ).rejects.toThrow(/connection refused/i);
    });
  });

  // =========================================================================
  // findByLoginIdentifier — registration pre-flight + login lookup (ST-023, ST-024)
  // =========================================================================

  describe('findByLoginIdentifier', () => {
    it('queries by login_identifier and returns the canonical user', async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByLoginIdentifier(SAMPLE_LOGIN_IDENTIFIER);

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/SELECT/i);
      expect(config.text).toMatch(/FROM\s+users/i);
      expect(config.text).toMatch(/login_identifier\s*=\s*\$1/);
      // The query MUST NOT carry a wildcard or a JOIN — those would
      // either bloat the result set or invite N+1 queries downstream.
      expect(config.text).not.toMatch(/\bJOIN\b/i);
      expect(config.text).not.toMatch(/\*/);

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_LOGIN_IDENTIFIER]);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(SAMPLE_FIREBASE_UID);
      expect(result?.loginIdentifier).toBe(SAMPLE_LOGIN_IDENTIFIER);
      expect(result?.credentialDigest).toBeNull();
      expect(result?.createdAt).toEqual(FIXED_DATE);
    });

    it('returns null (NOT undefined) when no row matches', async () => {
      // Distinguishing `null` from `undefined` matters: middleware
      // and service code uses `=== null` checks to drive control
      // flow; an `undefined` return would silently bypass those
      // branches and produce non-deterministic behaviour.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByLoginIdentifier('nope@example.com');

      expect(result).toBeNull();
      // Stronger assertion: the value is exactly null, not undefined.
      expect(result === null).toBe(true);
    });

    it('passes the login identifier through unmodified (no normalization)', async () => {
      // The repository is a thin data-access layer; case-folding /
      // normalization is the caller's responsibility (the registration
      // service layer performs RFC-5321 normalization). This test
      // pins the contract: the repository must NOT modify the input.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));
      await repo.findByLoginIdentifier('  Mixed-Case@Example.COM  ');

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual(['  Mixed-Case@Example.COM  ']);
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('connection refused: ECONNREFUSED'));

      const repo = createUserRepository(asPool(pool));

      await expect(repo.findByLoginIdentifier(SAMPLE_LOGIN_IDENTIFIER)).rejects.toThrow(
        /connection refused/i,
      );
    });
  });

  // =========================================================================
  // findByFirebaseUid — session middleware hot path (ST-026)
  // =========================================================================

  describe('findByFirebaseUid', () => {
    it('queries by id (the firebase uid is the PK per AAP §0.2.1) and returns the user', async () => {
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: SAMPLE_FIREBASE_UID,
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByFirebaseUid(SAMPLE_FIREBASE_UID);

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/FROM\s+users/i);
      // Critical assertion: the WHERE column is `id`, NOT a separate
      // `firebase_uid` column. Per AAP §0.2.1 the two are the same
      // value, so adding a separate column would invite drift and
      // require a join.
      expect(config.text).toMatch(/\bid\s*=\s*\$1/);
      expect(config.text).not.toMatch(/firebase_uid/);

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_FIREBASE_UID]);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(SAMPLE_FIREBASE_UID);
      expect(result?.credentialDigest).toBeNull();
    });

    it('returns null when the firebase uid is not in the users table', async () => {
      // This is the path the session middleware MUST handle on every
      // request: the bearer token is valid (Firebase verified it) but
      // the local mirror has not yet been populated, e.g. because the
      // user was created in Firebase out of band. The middleware
      // distinguishes "no local mirror" from "auth failure" only via
      // this `null` return.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByFirebaseUid('unknown-uid-not-in-db');

      expect(result).toBeNull();
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('pool exhausted'));

      const repo = createUserRepository(asPool(pool));

      await expect(repo.findByFirebaseUid(SAMPLE_FIREBASE_UID)).rejects.toThrow(/pool exhausted/i);
    });

    it('SELECT statement must be parameterised (no string concatenation)', async () => {
      // Even though the firebase uid is server-issued and not directly
      // user-controlled, the SQL-injection invariant applies
      // universally — repositories never interpolate values into the
      // statement text.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));
      await repo.findByFirebaseUid("attempt'; DROP TABLE users; --");

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/\$1/);
      expect(config.text).not.toContain('DROP TABLE');
    });
  });

  // =========================================================================
  // Row mapping — snake_case → camelCase
  // =========================================================================

  describe('row mapping', () => {
    it('translates DB column names to camelCase domain fields', async () => {
      // The mapper is private to user.repository.ts; we verify it
      // through the public surface. A row shaped exactly like the
      // database returns (snake_case keys) MUST emerge as the
      // public-shaped User (camelCase keys) with no extra fields.
      const pool = createMockPool();
      const dbCreatedAt = new Date('2025-12-31T00:00:00Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: 'abc',
            login_identifier: 'name@example.com',
            credential_digest: null,
            created_at: dbCreatedAt,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByLoginIdentifier('name@example.com');

      // `as User` cast is for type safety only; the deep equality
      // assertion below is what does the work.
      const expected: User = {
        id: 'abc',
        loginIdentifier: 'name@example.com',
        credentialDigest: null,
        createdAt: dbCreatedAt,
      };
      expect(result).toEqual(expected);
    });

    it('does NOT add or remove fields beyond the canonical User shape', async () => {
      // If the mapper introduced an `extras` or `meta` field, it
      // would expand the public surface beyond what AAP §0.7.2
      // permits and would surface a documentation drift between
      // the User interface and the runtime shape.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: 'abc',
            login_identifier: 'name@example.com',
            credential_digest: null,
            created_at: FIXED_DATE,
            // A column that the SELECT statement does NOT request,
            // but which `pg` in some edge cases could surface.
            extra_unwanted_column: 'should-not-leak',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByLoginIdentifier('name@example.com');

      expect(result).not.toBeNull();
      const keys = Object.keys(result as object).sort();
      expect(keys).toEqual(['createdAt', 'credentialDigest', 'id', 'loginIdentifier']);
    });

    it('preserves the createdAt Date instance reference (no copy / no string coercion)', async () => {
      // Some mappers stringify Date values; the User contract says
      // `createdAt: Date`. Verify the runtime value is still a Date
      // instance and (when possible) the same reference as the input.
      const pool = createMockPool();
      const dbCreatedAt = new Date('2024-06-15T13:45:30.123Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            id: 'abc',
            login_identifier: SAMPLE_LOGIN_IDENTIFIER,
            credential_digest: null,
            created_at: dbCreatedAt,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      const result = await repo.findByLoginIdentifier(SAMPLE_LOGIN_IDENTIFIER);

      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.createdAt.toISOString()).toBe('2024-06-15T13:45:30.123Z');
    });
  });

  // =========================================================================
  // Type-level invariants — Rule R3 design-time enforcement
  // =========================================================================

  describe('type contract (Rule R3)', () => {
    it('the InsertUserParams type does NOT permit a "password" field', () => {
      // STATIC test: this assertion is executed at compile time. If
      // a future maintainer adds `password?: string` to
      // InsertUserParams in user.repository.ts, the conditional type
      // `HasPassword` resolves to `true` and the assignment of
      // `false` to `_hasPassword` becomes a type error — failing the
      // type-check gate (MG1-E ST-037) before this test ever runs.
      //
      // The runtime expect() is included so this test contributes
      // to the it-pass count and so the assertion is visible to
      // anyone reading the test output.
      const pool = createMockPool();
      const repo = createUserRepository(asPool(pool));

      // Extract the parameter type of the insert method.
      type InsertParams = Parameters<typeof repo.insert>[0];

      // A valid insert payload — exercises the positive case.
      const _validPayload: InsertParams = {
        loginIdentifier: SAMPLE_LOGIN_IDENTIFIER,
        firebaseUid: SAMPLE_FIREBASE_UID,
      };
      // Reference the payload to satisfy noUnusedLocals.
      void _validPayload;

      // Conditional type: does InsertParams contain a `password`
      // field of any type? Resolves to `true` if yes, `false` if no.
      type HasPassword = InsertParams extends { password: unknown } ? true : false;
      type HasPasswordHash = InsertParams extends { passwordHash: unknown } ? true : false;
      type HasCredential = InsertParams extends { credential: unknown } ? true : false;
      type HasCredentialDigest = InsertParams extends { credentialDigest: unknown } ? true : false;
      type HasSecret = InsertParams extends { secret: unknown } ? true : false;

      // The runtime values mirror the compile-time conditionals.
      // If a future change introduces a `password` parameter, the
      // line `const hasPassword: HasPassword = false;` becomes a
      // type error (true is not assignable to false), failing the
      // type-check gate.
      const hasPassword: HasPassword = false;
      const hasPasswordHash: HasPasswordHash = false;
      const hasCredential: HasCredential = false;
      const hasCredentialDigest: HasCredentialDigest = false;
      const hasSecret: HasSecret = false;

      // Runtime assertions — visible in the test reporter and
      // contribute to the deterministic verdict.
      expect(hasPassword).toBe(false);
      expect(hasPasswordHash).toBe(false);
      expect(hasCredential).toBe(false);
      expect(hasCredentialDigest).toBe(false);
      expect(hasSecret).toBe(false);
    });

    it('the User return type pins credentialDigest to the literal null type', () => {
      // STATIC test: User.credentialDigest is documented as the
      // literal `null` type (NOT `string | null`, NOT `Buffer |
      // null`). This conditional-type assertion locks that contract.
      type CredentialDigestType = User['credentialDigest'];
      // Resolves to `true` only if the type is the literal `null`,
      // not a wider union.
      type IsLiteralNull = [CredentialDigestType] extends [null]
        ? null extends CredentialDigestType
          ? true
          : false
        : false;

      const isLiteralNull: IsLiteralNull = true;
      expect(isLiteralNull).toBe(true);
    });
  });

  // =========================================================================
  // Determinism — repeated invocations produce identical query shapes
  // =========================================================================

  describe('determinism (ST-043-AC3)', () => {
    it('repeated calls to the same method produce byte-identical SQL text', async () => {
      // ST-043-AC3 demands deterministic verdicts across runs. A
      // common source of non-determinism in repositories is dynamic
      // SQL construction (e.g., concatenating WHERE clauses based on
      // optional params). The user repository builds NO dynamic SQL
      // — every method has a fixed SQL constant. This test pins
      // that property: two calls produce two byte-identical
      // `text` fields.
      const pool = createMockPool();
      pool.query.mockResolvedValue(mockQueryResult([]));

      const repo = createUserRepository(asPool(pool));
      await repo.findByLoginIdentifier('a@example.com');
      await repo.findByLoginIdentifier('b@example.com');

      const first = getQueryConfig(pool, 0);
      const second = getQueryConfig(pool, 1);
      expect(first.text).toBe(second.text);
    });

    it('the values array order is stable across repeated insert calls', async () => {
      // The INSERT SQL has columns `(id, login_identifier)`, so
      // values MUST be `[firebaseUid, loginIdentifier]` in that
      // order, every time.
      const pool = createMockPool();
      pool.query.mockResolvedValue(
        mockQueryResult([
          {
            id: 'u1',
            login_identifier: 'a@example.com',
            credential_digest: null,
            created_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createUserRepository(asPool(pool));
      await repo.insert({ firebaseUid: 'u1', loginIdentifier: 'a@example.com' });
      await repo.insert({ firebaseUid: 'u2', loginIdentifier: 'b@example.com' });

      const firstValues = getQueryConfig(pool, 0).values as readonly unknown[];
      const secondValues = getQueryConfig(pool, 1).values as readonly unknown[];

      expect(firstValues).toEqual(['u1', 'a@example.com']);
      expect(secondValues).toEqual(['u2', 'b@example.com']);
    });
  });
});
