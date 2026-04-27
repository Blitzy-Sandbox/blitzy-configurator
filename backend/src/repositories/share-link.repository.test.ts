/**
 * Unit tests for `backend/src/repositories/share-link.repository.ts`.
 *
 * Verifies the three exported members of the `ShareLinkRepository`
 * contract — `insert`, `findByToken`, `revoke` — against the security,
 * schema, and behavioural invariants documented in the source file:
 *
 *   1. INSERT statement targets the `share_links` table, names the
 *      four insertable columns (`token`, `design_id`, `owner_uid`,
 *      `expires_at`), uses a `RETURNING` clause to hand back the
 *      canonical row, and binds the `expires_at` parameter as an
 *      ISO-8601 string with an explicit `::timestamptz` cast so pg's
 *      parameter-type inference stays unambiguous (per source-file
 *      INSERT_SHARE_LINK_SQL contract). The application NEVER assigns
 *      `issued_at` or `revoked_at` — those default to `now()` and
 *      `NULL` respectively in the migration (ST-029-AC2 / source-file
 *      Section 4 commentary).
 *   2. SELECT/JOIN statement targets `share_links` with a LEFT JOIN
 *      to the `designs` table so the unauthenticated `/api/share/:token`
 *      route can render read-only design data in a single round-trip
 *      (ST-029-AC3). The repository deliberately does NOT filter on
 *      expiration or revocation in SQL — those checks are the service
 *      layer's responsibility so that 404 vs. 410 ("expired") can be
 *      distinguished without a second query.
 *   3. UPDATE statement marks all active share links for a (design,
 *      owner) tuple revoked in one round-trip. The
 *      `WHERE revoked_at IS NULL` predicate is what makes the
 *      operation idempotent (already-revoked rows are filtered out so
 *      their original `revoked_at` timestamp is preserved — audit
 *      correctness per ST-029-AC4).
 *   4. Parameterised queries throughout: every SQL constant uses
 *      `$1`, `$2` placeholders; user-supplied values flow through
 *      the `values` array. There is no string interpolation of input
 *      anywhere, so SQL-injection is structurally impossible.
 *   5. The mapper translates snake_case columns (`design_id`,
 *      `owner_uid`, `issued_at`, `expires_at`, `revoked_at`) to
 *      camelCase domain fields (`designId`, `ownerUid`, `issuedAt`,
 *      `expiresAt`, `revokedAt`). The JOIN-bearing mapper additionally
 *      reconstructs the embedded `design` from the `design_*`-aliased
 *      columns and treats a fully-null JOIN as `design === null`
 *      (LEFT JOIN safety — defensive against future FK relaxation).
 *   6. `findByToken` returns `null` (never `undefined`) when no row
 *      matches the supplied token; the consumer checks `=== null` to
 *      emit HTTP 404.
 *   7. `revoke` reports the COUNT of rows that ACTUALLY transitioned
 *      active→revoked in this call by reading `result.rowCount` from
 *      the pg driver — NOT `rows.length`. The two are equivalent for
 *      UPDATE-with-RETURNING, but reading `rowCount` is the contract
 *      the repository documents.
 *   8. PG errors (UNIQUE violations, foreign-key violations, network
 *      errors) propagate up the call stack rather than being
 *      swallowed (Rule R8 — fail-closed posture).
 *   9. Token-handling discipline: tokens never appear in error
 *      messages emitted by the repository (Rule R2 — credential-like
 *      material must never appear in any diagnostic surface). The
 *      defensive "INSERT did not return a row" error message
 *      explicitly omits the token value.
 *
 * Authority:
 *   - Story ST-029 (share-link issuance endpoint with expiration and
 *     revocation semantics).
 *   - Story ST-030 (designs schema migration — the FK target of
 *     `share_links.design_id`).
 *   - Story ST-043 (deterministic, local-only, no-network unit suite).
 *   - AAP §0.7.1 (co-located unit tests per ST-043).
 *   - AAP §0.8.1 R2 (no credential material in error messages),
 *     R3 (no JWT libraries — token generation is the service layer's
 *     responsibility), R8 (gates fail closed — pg errors propagate).
 *
 * Determinism (ST-043-AC3):
 *   - The mocked `pg.Pool` returns deterministic, in-memory results
 *     so no asynchronous boundary depends on external timing.
 *   - `jest.useFakeTimers({ now: FIXED_DATE })` pins the Date used by
 *     any wall-clock comparison so assertions never race past a
 *     second boundary. The repository under test does not invoke
 *     `Date` directly when handling rows (timestamps originate from
 *     PostgreSQL's `now()` server-side), but the `insert` method
 *     calls `expiresAt.toISOString()` on the caller-supplied Date —
 *     pinning the wall clock keeps fixture comparisons stable across
 *     runners.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets
 *     `clearMocks`, `resetMocks`, and `restoreMocks` to `true` so
 *     mock state is wiped between tests; this file therefore needs
 *     no manual `jest.clearAllMocks()` calls.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and
 *   depends on ZERO services. The `pg.Pool` is replaced with a
 *   `jest.Mocked` double; every assertion exercises pure synchronous
 *   JavaScript.
 *
 * @see backend/src/repositories/share-link.repository.ts — module under test
 * @see backend/src/repositories/design.repository.ts — provides the
 *      `Design` TYPE used by the JOIN result; no runtime coupling
 * @see tickets/stories/ST-029-share-link-issuance-endpoint.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// Type-only imports — required by the `@typescript-eslint/consistent-type-
// imports` rule in `.eslintrc.json`. `Pool` is the generic argument to
// `jest.Mocked<Pool>` (via `MockedPool` below); `QueryConfig` and
// `QueryResult` carry the repository's call shape; `QueryResultRow` is
// the generic bound on the `mockQueryResult` helper. None of these are
// runtime dependencies, so a pure type import is the correct form.
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { createShareLinkRepository } from './share-link.repository';

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
 * The canonical share-link token used across the suite.
 *
 * Format mirrors what the service layer actually emits via
 * `crypto.randomBytes(32).toString('base64url')` — 256 bits of
 * URL-safe entropy, ~43 characters, no padding. Using a representative
 * string here protects against test scaffolding that might inadvertently
 * accept tokens that violate the documented format.
 */
const SAMPLE_TOKEN = 'kc8z9mYbq2pVtX_LdR4nWF1aJGHE5AsBC6oIuPvN_Tg';

/**
 * The canonical design UUID used across the suite. Format mirrors a
 * realistic UUID v4 — the shape PostgreSQL would generate via
 * `gen_random_uuid()` per the ST-030 migration's column default.
 */
const SAMPLE_DESIGN_ID = '11111111-1111-4111-a111-111111111111';

/**
 * The canonical owning user id (= Firebase uid per AAP §0.2.1) used
 * across the suite. Format mimics a realistic Firebase uid.
 */
const SAMPLE_OWNER_UID = 'firebase-uid-abc123XYZ456789012345678';

/**
 * The canonical expiration timestamp used by `insert` fixtures. Set
 * 7 days after `FIXED_DATE` to mirror the "documented expiration"
 * semantics of ST-029-AC2 — a realistic policy-driven duration the
 * service layer would compute.
 *
 * The repository does not enforce any min/max for `expiresAt`; the
 * value is verbatim what the caller supplies. Pinning the fixture
 * here keeps the `INSERT values[3]` assertion stable across runs.
 */
const SAMPLE_EXPIRES_AT: Date = new Date('2026-01-22T10:00:00.000Z');

/**
 * The expected serialised form of `SAMPLE_EXPIRES_AT` after the
 * repository converts the Date to an ISO-8601 string via
 * `expiresAt.toISOString()`. Centralising the constant here avoids
 * fragile inline repeated calls and makes the assertion intent
 * explicit: pg receives the ISO STRING, NOT the Date object.
 *
 * This is the contractually documented serialisation the source-file
 * comment justifies as "the most reliable wire format for TIMESTAMPTZ
 * columns under pg's parameter binding".
 */
const SAMPLE_EXPIRES_AT_ISO: string = SAMPLE_EXPIRES_AT.toISOString();

// ---------------------------------------------------------------------------
// Mock helpers.
// ---------------------------------------------------------------------------
//
// The repository depends on a single object — a `pg.Pool` — and only ever
// invokes its `query` method via the QueryConfig OBJECT form
// (`pool.query<R>({ text, values })`). The `pg` types declare
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
 * the share-link repository calls — `pool.query<R>(config: QueryConfig)`.
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
 * defensively so an accidental future call surfaces as a TypeError
 * instead of an undefined-method exception.
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
 * The exact row shape returned by `pool.query<ShareLinkRow>()` for the
 * INSERT statement and the share-link half of the JOIN-bearing SELECT.
 * Property names match the database column names verbatim — the
 * repository's private mapper is the single place that converts
 * snake_case columns to camelCase domain fields.
 *
 * Declared locally (rather than imported) because the source file
 * intentionally keeps `ShareLinkRow` private. Tests assert the public
 * mapping behaviour by feeding rows shaped like this through the
 * mocked `pool.query`.
 */
interface ShareLinkRow extends QueryResultRow {
  token: string;
  design_id: string;
  owner_uid: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * The exact row shape returned by `pool.query<ShareLinkWithDesignRow>()`
 * for the JOIN-bearing FIND_BY_TOKEN_SQL. Inherits the share-link
 * columns and adds the JOINed design columns (prefixed `design_*` to
 * resolve the `share_links.design_id` vs `designs.id` collision in
 * SQL rather than JavaScript).
 *
 * The `design_*` columns are typed as nullable scalars because the
 * source-file SQL uses LEFT JOIN — modelling the LEFT JOIN faithfully
 * in the row type keeps the mapper's null-handling behaviour explicit
 * for any future test that exercises the "no matching design" path.
 *
 * `design_payload` is `Record<string, unknown> | null` here (rather
 * than the wider `unknown | null`) so the `mockQueryResult` generic
 * constraint `T extends QueryResultRow` is satisfied without further
 * coercion. The mapper accepts and narrows the broader `unknown` shape
 * at runtime.
 */
interface ShareLinkWithDesignRow extends ShareLinkRow {
  design_title: string | null;
  design_payload: Record<string, unknown> | null;
  design_user_id: string | null;
  design_created_at: Date | null;
  design_last_modified_at: Date | null;
}

/**
 * The narrow row shape returned by the `revoke` UPDATE-with-RETURNING.
 * The repository declares `pool.query<{ token: string }>(...)` because
 * the only column the UPDATE returns is `token` (sufficient for
 * `rowCount` accuracy without serialising columns the application
 * does not use).
 */
interface RevokedTokenRow extends QueryResultRow {
  token: string;
}

/**
 * Fabricate a realistic `QueryResult<R>` shape from a list of rows.
 *
 * The `pg` library's `QueryResult` carries five fields in addition to
 * `rows` — `command`, `rowCount`, `oid`, `fields`. The repository
 * under test reads `rows` for INSERT and SELECT and reads `rowCount`
 * for the `revoke` UPDATE; populating both fields with values
 * consistent with `rows.length` keeps test arrangement uniform across
 * all three call sites.
 *
 * Generic constraint `T extends QueryResultRow` matches the
 * repository's own `pool.query<...>(...)` typing so a mocked result
 * cannot accidentally substitute an array-shaped row.
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
 * The repository invokes `pool.query` via the OBJECT form — passing
 * a `{ text, values }` config — rather than the positional `(text,
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
  // `pool.query<R>({ text, values })` signature). The cast is
  // therefore safe; if a future refactor changes the call form, this
  // assertion would surface that drift loudly.
  return call[0];
}

// ---------------------------------------------------------------------------
// Suite-level lifecycle hooks — fake timers for deterministic Date semantics.
// ---------------------------------------------------------------------------
//
// `jest.useFakeTimers({ now: FIXED_DATE })` makes `Date.now()` and the
// `Date` constructor return the same wall-clock value across every test
// in the file. The repository under test invokes `Date.toISOString()`
// on the caller-supplied `expiresAt` parameter (in `insert`); pinning
// the wall clock is a defensive measure that ensures timestamp-shaped
// fixture comparisons stay stable on slow runners crossing second
// boundaries.
//
// `jest.useRealTimers()` in `afterEach` is mandatory — otherwise fake
// timers would leak into adjacent test files within the same Jest
// worker.
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers({ now: FIXED_DATE });
});

afterEach(() => {
  jest.useRealTimers();
});

// ===========================================================================
// createShareLinkRepository — factory contract
// ===========================================================================

describe('createShareLinkRepository', () => {
  it('returns an object with the three documented methods', () => {
    // The repository contract specifies exactly three methods. A test
    // that enumerates them protects against accidental API additions
    // (which would expand the public surface and therefore the
    // out-of-scope risk per AAP §0.7.2) and accidental removals.
    const pool = createMockPool();
    const repo = createShareLinkRepository(asPool(pool));

    expect(typeof repo.insert).toBe('function');
    expect(typeof repo.findByToken).toBe('function');
    expect(typeof repo.revoke).toBe('function');
  });

  it('returns a frozen object so methods cannot be monkey-patched', () => {
    // The factory is documented to call `Object.freeze` on the
    // returned record — protecting against the class of bugs where a
    // test or middleware accidentally substitutes a repository method
    // at runtime. Verifying the freeze here pins the contract.
    const pool = createMockPool();
    const repo = createShareLinkRepository(asPool(pool));

    expect(Object.isFrozen(repo)).toBe(true);
  });

  it('does NOT invoke pool.query during construction (lazy initialisation)', () => {
    // Constructing the repository must not issue any database call.
    // Eager queries during composition would slow startup and would
    // defeat dependency-injection-based testing.
    const pool = createMockPool();
    createShareLinkRepository(asPool(pool));

    expect(pool.query).not.toHaveBeenCalled();
  });

  // =========================================================================
  // insert — POST /api/designs/:id/share-link (ST-029-AC1, ST-029-AC2)
  // =========================================================================

  describe('insert', () => {
    it('executes INSERT with correct SQL shape and parameter array', async () => {
      // ST-029-AC1: the share-link endpoint issues a share link only
      // for a design owned by the authenticated user. Ownership is
      // enforced at the SERVICE layer; the repository's job is the
      // mechanical INSERT. ST-029-AC2: each issued link carries a
      // documented expiration that the repository persists verbatim.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkRow>([
          {
            token: SAMPLE_TOKEN,
            design_id: SAMPLE_DESIGN_ID,
            owner_uid: SAMPLE_OWNER_UID,
            issued_at: FIXED_DATE,
            expires_at: SAMPLE_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.insert({
        token: SAMPLE_TOKEN,
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
        expiresAt: SAMPLE_EXPIRES_AT,
      });

      // Exactly one query was issued — the INSERT.
      expect(pool.query).toHaveBeenCalledTimes(1);

      const config = getQueryConfig(pool);

      // The SQL targets the share_links table.
      expect(config.text).toMatch(/INSERT\s+INTO\s+share_links/i);

      // The four insertable columns appear in the column list. The
      // tests use substring matches (rather than exact equality) so
      // formatting changes — e.g. line wrapping or column reordering
      // — do not break the suite. The acceptance criterion is "the
      // four columns are part of the INSERT", not "the INSERT is
      // formatted exactly as the test author imagined".
      expect(config.text).toMatch(/token/);
      expect(config.text).toMatch(/design_id/);
      expect(config.text).toMatch(/owner_uid/);
      expect(config.text).toMatch(/expires_at/);

      // The RETURNING clause is what makes the repository
      // round-trip-efficient (no follow-up SELECT needed to obtain
      // the canonical persisted row).
      expect(config.text).toMatch(/RETURNING/i);

      // The `expires_at` parameter binding includes an explicit
      // `::timestamptz` cast (per the source-file commentary on
      // INSERT_SHARE_LINK_SQL — guards against pg's parameter-type
      // inference across minor versions).
      expect(config.text).toMatch(/\$4::timestamptz/);

      // Parameter array. Note that `expires_at` is bound as the
      // ISO-8601 STRING, not the Date object — the source file
      // explicitly converts via `params.expiresAt.toISOString()`
      // because ISO-8601 is the most reliable wire format for
      // TIMESTAMPTZ columns under pg's parameter binding.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([
        SAMPLE_TOKEN,
        SAMPLE_DESIGN_ID,
        SAMPLE_OWNER_UID,
        SAMPLE_EXPIRES_AT_ISO,
      ]);

      // Returned canonical record (snake_case → camelCase mapping).
      // ST-029-AC2: the issued link carries the documented
      // expiration; the repository round-trips it.
      expect(result).toEqual({
        token: SAMPLE_TOKEN,
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
        issuedAt: FIXED_DATE,
        expiresAt: SAMPLE_EXPIRES_AT,
        revokedAt: null,
      });
    });

    it('binds ONLY four parameters — never `issued_at` or `revoked_at`', async () => {
      // The source file commentary documents that `issued_at` (DB
      // default `now()`) and `revoked_at` (DB default `NULL`) are
      // intentionally omitted from the INSERT column list. Verifying
      // the parameter array's length here pins that contract — a
      // future regression that adds a fifth parameter (or a sixth)
      // would surface immediately.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkRow>([
          {
            token: SAMPLE_TOKEN,
            design_id: SAMPLE_DESIGN_ID,
            owner_uid: SAMPLE_OWNER_UID,
            issued_at: FIXED_DATE,
            expires_at: SAMPLE_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      await repo.insert({
        token: SAMPLE_TOKEN,
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
        expiresAt: SAMPLE_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toHaveLength(4);

      // Cross-check: the SQL placeholder set is exactly $1..$4 and
      // does NOT include $5. The negative assertion guards against
      // a regression in which a developer adds a column to the SQL
      // but forgets to update the values array (or vice-versa).
      expect(config.text).toMatch(/\$1/);
      expect(config.text).toMatch(/\$2/);
      expect(config.text).toMatch(/\$3/);
      expect(config.text).toMatch(/\$4/);
      expect(config.text).not.toMatch(/\$5/);
    });

    it('uses parameterised queries (input never interpolated into SQL)', async () => {
      // SQL-injection invariant. A malicious payload supplied as the
      // `token` (or any other input) MUST appear ONLY in the values
      // array — never in the SQL text. This test exercises a
      // textbook injection payload to make the security boundary
      // visible to anyone reading the suite.
      const maliciousToken = "'; DROP TABLE share_links; --";
      const maliciousDesignId = "deadbeef'; SELECT pg_sleep(99); --";
      const maliciousOwnerUid = '1=1 OR true';

      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkRow>([
          {
            token: maliciousToken,
            design_id: maliciousDesignId,
            owner_uid: maliciousOwnerUid,
            issued_at: FIXED_DATE,
            expires_at: SAMPLE_EXPIRES_AT,
            revoked_at: null,
          },
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      await repo.insert({
        token: maliciousToken,
        designId: maliciousDesignId,
        ownerUid: maliciousOwnerUid,
        expiresAt: SAMPLE_EXPIRES_AT,
      });

      const config = getQueryConfig(pool);

      // The malicious SQL fragments must NOT appear anywhere in the
      // SQL text — the repository's parameterised-query discipline
      // keeps them confined to the values array.
      expect(config.text).not.toContain('DROP TABLE');
      expect(config.text).not.toContain('pg_sleep');
      expect(config.text).not.toContain('1=1 OR true');

      // The payloads must appear in the values array — confirming
      // they did pass through the boundary, just safely.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toContain(maliciousToken);
      expect(values).toContain(maliciousDesignId);
      expect(values).toContain(maliciousOwnerUid);
    });

    it('round-trips the snake_case `revoked_at` Date through the camelCase mapper', async () => {
      // Edge case: although a just-INSERTed row should never carry
      // `revoked_at`, the RETURNING clause is wide enough that a
      // server-side trigger or future schema change could produce
      // a non-null value. Verifying the mapper handles both `null`
      // and a Date faithfully pins the contract.
      const pool = createMockPool();
      const earlyRevokedAt = new Date('2026-01-15T11:00:00.000Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkRow>([
          {
            token: SAMPLE_TOKEN,
            design_id: SAMPLE_DESIGN_ID,
            owner_uid: SAMPLE_OWNER_UID,
            issued_at: FIXED_DATE,
            expires_at: SAMPLE_EXPIRES_AT,
            revoked_at: earlyRevokedAt,
          },
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.insert({
        token: SAMPLE_TOKEN,
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
        expiresAt: SAMPLE_EXPIRES_AT,
      });

      expect(result.revokedAt).toEqual(earlyRevokedAt);
    });

    it('throws a descriptive error when INSERT does not return a row', async () => {
      // Defensive contract: the source file documents that the
      // RETURNING clause guarantees a row when the INSERT succeeds.
      // If a future schema change were to alter that, the repository
      // throws rather than letting a silent `undefined` propagate
      // into business logic. The error message must be DESCRIPTIVE
      // (so on-call engineers can diagnose) but must NOT include the
      // token value (Rule R2 — token-like material must never appear
      // in any diagnostic surface).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<ShareLinkRow>([]));

      const repo = createShareLinkRepository(asPool(pool));

      // Capture the thrown error in a single call so we can assert
      // BOTH the descriptive content AND the absence of the token
      // (Rule R2). Jest's `.rejects.toThrow` would let us assert the
      // descriptive content but not the negative-substring claim
      // about the token, so a try/catch is the right shape.
      let captured: Error | undefined;
      try {
        await repo.insert({
          token: SAMPLE_TOKEN,
          designId: SAMPLE_DESIGN_ID,
          ownerUid: SAMPLE_OWNER_UID,
          expiresAt: SAMPLE_EXPIRES_AT,
        });
      } catch (err) {
        if (err instanceof Error) {
          captured = err;
        }
      }

      // The repository must have rejected — silent resolution would
      // be a fail-closed regression.
      expect(captured).toBeDefined();

      // The error message must be DESCRIPTIVE — on-call engineers
      // need enough context to diagnose without code-spelunking.
      expect(captured?.message).toMatch(/INSERT did not return a row|RETURNING/i);

      // Rule R2 — the token must NEVER appear in error messages
      // emitted by this repository. The defensive `Error` thrown
      // here is constructed without referencing the input parameter
      // values; this assertion pins that contract.
      expect(captured?.message ?? '').not.toContain(SAMPLE_TOKEN);
    });
  });

  // =========================================================================
  // findByToken — GET /api/share/:token (ST-029-AC3)
  // =========================================================================

  describe('findByToken', () => {
    /**
     * Build a fully-populated `ShareLinkWithDesignRow` fixture. Used by
     * the happy-path tests; the LEFT-JOIN-no-design path test below
     * uses an inline literal because it explicitly overrides the
     * `design_*` fields to `null`.
     */
    function makeJoinedRow(
      overrides: Partial<ShareLinkWithDesignRow> = {},
    ): ShareLinkWithDesignRow {
      return {
        token: SAMPLE_TOKEN,
        design_id: SAMPLE_DESIGN_ID,
        owner_uid: SAMPLE_OWNER_UID,
        issued_at: FIXED_DATE,
        expires_at: SAMPLE_EXPIRES_AT,
        revoked_at: null,
        design_title: 'Shared Ball',
        design_payload: { primaryColor: '#FF0000', pattern: 'classic', finish: 'matte' },
        design_user_id: SAMPLE_OWNER_UID,
        design_created_at: new Date('2025-12-01T00:00:00.000Z'),
        design_last_modified_at: new Date('2025-12-02T00:00:00.000Z'),
        ...overrides,
      };
    }

    it('returns joined share-link + design record when token matches an active row', async () => {
      // ST-029-AC3: visiting a valid, unexpired share link returns
      // enough information for the configurator to render the target
      // design read-only without signing in. The repository delivers
      // that data in a single round-trip via SELECT-with-JOIN.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<ShareLinkWithDesignRow>([makeJoinedRow()]));

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.findByToken(SAMPLE_TOKEN);

      expect(pool.query).toHaveBeenCalledTimes(1);

      const config = getQueryConfig(pool);

      // The SELECT targets the share_links table.
      expect(config.text).toMatch(/FROM\s+share_links/i);

      // The JOIN to designs is the source-file's deliberate choice
      // (LEFT JOIN — see source-file commentary). The substring
      // assertion accepts either INNER or LEFT JOIN syntax to
      // protect against intentional future tightening.
      expect(config.text).toMatch(/JOIN\s+designs/i);

      // Single-parameter SELECT.
      expect(config.text).toMatch(/\$1/);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_TOKEN]);

      // The repository returns a non-null result with the correct
      // share-link AND design fields populated.
      expect(result).not.toBeNull();
      expect(result?.token).toBe(SAMPLE_TOKEN);
      expect(result?.designId).toBe(SAMPLE_DESIGN_ID);
      expect(result?.ownerUid).toBe(SAMPLE_OWNER_UID);
      expect(result?.issuedAt).toEqual(FIXED_DATE);
      expect(result?.expiresAt).toEqual(SAMPLE_EXPIRES_AT);
      expect(result?.revokedAt).toBeNull();

      // The embedded design payload is the read-only render data
      // ST-029-AC3 mandates. The mapper reconstructs the `Design`
      // shape from the `design_*`-aliased columns:
      //   - `id` is the share-link's `design_id` (= designs.id by
      //     JOIN condition).
      //   - `userId` is `design_user_id`.
      //   - `title`, `payload`, `createdAt`, `lastModifiedAt` come
      //     from the joined design row.
      expect(result?.design).not.toBeNull();
      expect(result?.design?.id).toBe(SAMPLE_DESIGN_ID);
      expect(result?.design?.userId).toBe(SAMPLE_OWNER_UID);
      expect(result?.design?.title).toBe('Shared Ball');
      expect(result?.design?.payload).toEqual({
        primaryColor: '#FF0000',
        pattern: 'classic',
        finish: 'matte',
      });
      expect(result?.design?.createdAt).toEqual(new Date('2025-12-01T00:00:00.000Z'));
      expect(result?.design?.lastModifiedAt).toEqual(new Date('2025-12-02T00:00:00.000Z'));
    });

    it('returns null when no row matches the token', async () => {
      // ST-029-AC2 / ST-029-AC4: an unknown or revoked token surfaces
      // as "not found" at the repository tier. The service layer
      // turns `null` into HTTP 404. Returning `null` (not
      // `undefined`) keeps the consumer's `=== null` check
      // unambiguous.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<ShareLinkWithDesignRow>([]));

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.findByToken('nonexistent-token');

      expect(result).toBeNull();
    });

    it('returns expiration and revocation timestamps so the consumer can evaluate validity', async () => {
      // ST-029-AC2 / ST-029-AC4: the repository deliberately does
      // NOT filter on expiration or revocation. Whether a link is
      // valid is a business decision the SERVICE layer makes by
      // comparing the returned `expiresAt`/`revokedAt` against the
      // current time. This test pins the contract: both timestamps
      // are returned faithfully even when the row is "logically
      // invalid" (e.g. revoked, expired, or both).
      const pool = createMockPool();
      const revokedAt = new Date('2026-01-05T00:00:00.000Z');
      const expiresAt = new Date('2026-01-08T00:00:00.000Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkWithDesignRow>([
          makeJoinedRow({
            token: 'revoked-token',
            issued_at: new Date('2026-01-01T00:00:00.000Z'),
            expires_at: expiresAt,
            revoked_at: revokedAt,
          }),
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.findByToken('revoked-token');

      // Both flags are present — the repository does NOT pre-filter.
      expect(result).not.toBeNull();
      expect(result?.revokedAt).toEqual(revokedAt);
      expect(result?.expiresAt).toEqual(expiresAt);
    });

    it('returns design === null when the LEFT JOIN finds no matching design row', async () => {
      // The source-file mapper documents a defensive null path: if
      // any of `design_user_id`, `design_title`, `design_created_at`,
      // or `design_last_modified_at` is null (the LEFT JOIN missed),
      // the embedded `design` is set to `null` rather than a partial
      // / corrupt object. This test exercises that path so a future
      // refactor that "always" populates `design` is caught.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkWithDesignRow>([
          {
            token: SAMPLE_TOKEN,
            design_id: SAMPLE_DESIGN_ID,
            owner_uid: SAMPLE_OWNER_UID,
            issued_at: FIXED_DATE,
            expires_at: SAMPLE_EXPIRES_AT,
            revoked_at: null,
            design_title: null,
            design_payload: null,
            design_user_id: null,
            design_created_at: null,
            design_last_modified_at: null,
          },
        ]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.findByToken(SAMPLE_TOKEN);

      // The share-link itself is still populated…
      expect(result).not.toBeNull();
      expect(result?.token).toBe(SAMPLE_TOKEN);
      expect(result?.designId).toBe(SAMPLE_DESIGN_ID);

      // …but the embedded design is explicitly `null`, faithfully
      // reflecting the LEFT-JOIN-with-no-match condition.
      expect(result?.design).toBeNull();
    });

    it('coerces a null `design_payload` to an empty object when the rest of the design is present', async () => {
      // The source-file mapper applies `payload ?? {}` so the public
      // `Design.payload` contract (always a non-null object) holds
      // even if a row was somehow written with a NULL payload. This
      // is defense-in-depth against legacy or out-of-band writes; the
      // payload-less but otherwise-present path is the one that
      // exercises the coercion.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<ShareLinkWithDesignRow>([makeJoinedRow({ design_payload: null })]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.findByToken(SAMPLE_TOKEN);

      expect(result).not.toBeNull();
      expect(result?.design).not.toBeNull();
      // The fallback is `{}` — an empty object, not `null`, not
      // `undefined`. The strict-equal `toEqual({})` is the right
      // assertion here.
      expect(result?.design?.payload).toEqual({});
    });

    it('does NOT filter on revocation or expiration in SQL (deferred to service layer)', async () => {
      // The source-file commentary explicitly says: "the repository
      // deliberately does NOT filter on expiration or revocation
      // here — the consumer (typically the service layer) decides
      // whether to render the design or surface an 'expired' /
      // 'revoked' error". This test pins that contract by asserting
      // the SQL text contains NEITHER an `expires_at >` predicate
      // NOR a `revoked_at IS NULL` predicate.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<ShareLinkWithDesignRow>([makeJoinedRow()]));

      const repo = createShareLinkRepository(asPool(pool));
      await repo.findByToken(SAMPLE_TOKEN);

      const config = getQueryConfig(pool);
      // Negative assertions — these predicates would push the
      // expiration/revocation decision into SQL, which the source
      // file deliberately avoids so the service layer can produce
      // distinct HTTP responses (404 vs. 410 vs. 200).
      expect(config.text).not.toMatch(/expires_at\s*[><]/i);
      expect(config.text).not.toMatch(/revoked_at\s+IS\s+NULL/i);
    });
  });

  // =========================================================================
  // revoke — bulk revocation (ST-029-AC4)
  // =========================================================================

  describe('revoke', () => {
    it('executes UPDATE setting revoked_at = now() for matching rows', async () => {
      // ST-029-AC4: revoking a share link by the owner renders the
      // link inoperable on subsequent requests. The repository's
      // bulk-revoke marks ALL active links for the (design, owner)
      // tuple revoked in a single round-trip. The mock returns 2
      // affected tokens; the repository reports `revokedCount = 2`
      // by reading `result.rowCount`.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<RevokedTokenRow>([{ token: 'token-1' }, { token: 'token-2' }]),
      );

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.revoke({
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
      });

      expect(pool.query).toHaveBeenCalledTimes(1);

      const config = getQueryConfig(pool);

      // The SQL is an UPDATE on share_links setting `revoked_at =
      // now()`. The DB-side `now()` ensures clock-skew between the
      // API server and PG cannot perturb the audit timestamp.
      expect(config.text).toMatch(/UPDATE\s+share_links/i);
      expect(config.text).toMatch(/SET\s+revoked_at\s*=\s*now\(\)/i);

      // The composite WHERE clause scopes the revocation to a single
      // (design, owner) tuple. Both predicates are required — see
      // the source-file commentary on `RevokeShareLinkParams`.
      expect(config.text).toMatch(/WHERE/i);
      expect(config.text).toMatch(/design_id\s*=\s*\$1/);
      expect(config.text).toMatch(/owner_uid\s*=\s*\$2/);

      // The `revoked_at IS NULL` predicate is what makes this UPDATE
      // idempotent — already-revoked rows are filtered out so their
      // ORIGINAL `revoked_at` timestamp is preserved (audit-correct).
      expect(config.text).toMatch(/revoked_at\s+IS\s+NULL/i);

      // Parameter array — designId first, ownerUid second.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_DESIGN_ID, SAMPLE_OWNER_UID]);

      // The `revokedCount` reflects the number of rows that
      // ACTUALLY transitioned active→revoked in this call.
      expect(result).toEqual({ revokedCount: 2 });
    });

    it('returns revokedCount = 0 when no active rows match the (design, owner) tuple', async () => {
      // A return value of 0 is NOT an error; it simply means the
      // tuple had no active share links. Per the source-file
      // commentary, this is "a perfectly valid state" (e.g. the
      // owner already revoked all their links, or never created
      // any). The repository must report the value honestly so the
      // service layer's idempotent retry semantics work.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<RevokedTokenRow>([]));

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.revoke({
        designId: 'unknown-design',
        ownerUid: 'unknown-owner',
      });

      expect(result).toEqual({ revokedCount: 0 });
    });

    it('coerces null `rowCount` to 0 (defensive against pg driver edge cases)', async () => {
      // The source-file commentary documents `result.rowCount ?? 0`
      // as a defensive coercion against driver edge cases that
      // could theoretically produce a null `rowCount`. Verifying the
      // coercion here pins the public contract (`revokedCount` is
      // ALWAYS a non-negative integer, never null/undefined).
      const pool = createMockPool();
      // Construct a result with `rowCount: null` — this is not a
      // shape pg ever produces for UPDATE-with-RETURNING, but the
      // code-side defence ensures the public type holds even under
      // the hypothetical driver edge case.
      pool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: null,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      } as unknown as QueryResult<RevokedTokenRow>);

      const repo = createShareLinkRepository(asPool(pool));
      const result = await repo.revoke({
        designId: SAMPLE_DESIGN_ID,
        ownerUid: SAMPLE_OWNER_UID,
      });

      expect(result).toEqual({ revokedCount: 0 });
    });

    it('uses parameterised queries (input never interpolated into SQL)', async () => {
      // SQL-injection invariant — restated for the `revoke` path so
      // the security contract is visible at every call site, not
      // implied by the `insert` test.
      const maliciousDesignId = "deadbeef'; UPDATE share_links SET revoked_at = NULL; --";
      const maliciousOwnerUid = "owner' OR '1'='1";

      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<RevokedTokenRow>([]));

      const repo = createShareLinkRepository(asPool(pool));
      await repo.revoke({ designId: maliciousDesignId, ownerUid: maliciousOwnerUid });

      const config = getQueryConfig(pool);

      // The malicious SQL fragments must NOT appear anywhere in the
      // SQL text — the parameterised-query discipline keeps them
      // confined to the values array.
      expect(config.text).not.toContain('UPDATE share_links SET revoked_at = NULL');
      expect(config.text).not.toContain("OR '1'='1");

      const values = config.values as readonly unknown[] | undefined;
      expect(values).toContain(maliciousDesignId);
      expect(values).toContain(maliciousOwnerUid);
    });
  });

  // =========================================================================
  // Error propagation — Rule R8 fail-closed posture (across all methods).
  // =========================================================================

  describe('error propagation', () => {
    it('propagates pg unique-violation errors (23505) from insert without swallowing', async () => {
      // Rule R8 (gates fail closed): pg errors propagate up the call
      // stack as native pg errors. The service layer is responsible
      // for translating them to HTTP statuses (e.g. 23505 → 409
      // Conflict for a primary-key collision on the token). The
      // repository deliberately does NOT translate or wrap the
      // error so the error code is preserved verbatim.
      const pool = createMockPool();
      const pgError: Error & { code?: string } = Object.assign(
        new Error('duplicate key value violates unique constraint "share_links_pkey"'),
        { code: '23505' },
      );
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createShareLinkRepository(asPool(pool));

      // Capture the rejected error in a single call so we can assert
      // BOTH on the message (via the caught error directly) AND on
      // the preserved `.code` property the service layer relies on.
      // The fail-fast `else` arm protects against a regression that
      // would silently resolve `insert` instead of rejecting.
      let captured: (Error & { code?: string }) | undefined;
      try {
        await repo.insert({
          token: SAMPLE_TOKEN,
          designId: SAMPLE_DESIGN_ID,
          ownerUid: SAMPLE_OWNER_UID,
          expiresAt: SAMPLE_EXPIRES_AT,
        });
      } catch (err) {
        captured = err as Error & { code?: string };
      }

      // Must have rejected — a resolved insert here would be a
      // silent regression of the fail-closed contract.
      expect(captured).toBeDefined();
      expect(captured?.message).toMatch(/duplicate key|unique/i);

      // The thrown error must carry the original pg error code so
      // the service layer can translate to HTTP 409 / 404 / 500
      // appropriately.
      expect(captured?.code).toBe('23505');
    });

    it('propagates pg foreign-key-violation errors (23503) from insert', async () => {
      // The `designs.id` foreign-key constraint with `ON DELETE
      // CASCADE` produces a pg `23503` (`foreign_key_violation`)
      // when the supplied `designId` does not exist. The service
      // layer translates this to HTTP 404 — but only because the
      // repository propagates the error verbatim.
      const pool = createMockPool();
      const fkError: Error & { code?: string } = Object.assign(
        new Error('insert or update on table "share_links" violates foreign key constraint'),
        { code: '23503' },
      );
      pool.query.mockRejectedValueOnce(fkError);

      const repo = createShareLinkRepository(asPool(pool));

      let captured: (Error & { code?: string }) | undefined;
      try {
        await repo.insert({
          token: SAMPLE_TOKEN,
          designId: 'nonexistent-design-id',
          ownerUid: SAMPLE_OWNER_UID,
          expiresAt: SAMPLE_EXPIRES_AT,
        });
      } catch (err) {
        captured = err as Error & { code?: string };
      }

      expect(captured).toBeDefined();
      expect(captured?.code).toBe('23503');
    });

    it('propagates connection errors from findByToken without swallowing', async () => {
      // Network/connection failures must NEVER be silently
      // converted to "not found" — that would mask infrastructure
      // problems and leave the user staring at a confusing 404.
      // The repository's only correct response is to bubble the
      // error so the upstream error handler can return 5xx and the
      // observability stack can flag the degraded state.
      const pool = createMockPool();
      const connError = new Error('Connection terminated unexpectedly');
      pool.query.mockRejectedValueOnce(connError);

      const repo = createShareLinkRepository(asPool(pool));

      await expect(repo.findByToken(SAMPLE_TOKEN)).rejects.toThrow(/Connection terminated/);
    });

    it('propagates pg errors from revoke without swallowing', async () => {
      // Symmetric assertion for the `revoke` path. Without this
      // test, a regression that catches the error and returns
      // `{ revokedCount: 0 }` (which would look "fine") could ship
      // unnoticed — but it would falsely tell the service layer
      // that the revocation succeeded when in fact the DB never
      // applied the UPDATE.
      const pool = createMockPool();
      const pgError = new Error('connection refused');
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createShareLinkRepository(asPool(pool));

      await expect(
        repo.revoke({ designId: SAMPLE_DESIGN_ID, ownerUid: SAMPLE_OWNER_UID }),
      ).rejects.toThrow(/connection refused/);
    });
  });
});
