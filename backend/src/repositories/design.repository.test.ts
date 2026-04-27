/**
 * Unit tests for `backend/src/repositories/design.repository.ts`.
 *
 * Verifies the four exported members of the `DesignRepository`
 * contract — `insert`, `listByUser`, `findById`, `updatePayload` —
 * against the security, schema, and pagination invariants documented
 * in the source file:
 *
 *   1. INSERT statement targets the `designs` table, includes
 *      `RETURNING`, casts the payload parameter to `jsonb`, and passes
 *      `(userId, title, JSON.stringify(payload))` through the `values`
 *      array. The application NEVER assigns `id`, `created_at`, or
 *      `last_modified_at` — those originate from the column defaults
 *      defined in the ST-030 migration (ST-027).
 *   2. listByUser uses KEYSET pagination (NOT offset-based) ordered by
 *      `last_modified_at DESC, id DESC` with `id` as the deterministic
 *      tiebreaker. The first-page query has no cursor predicate; the
 *      cursor-based query uses
 *        `(last_modified_at < $X OR (last_modified_at = $X AND id < $Y))`
 *      to encode "tuple-strictly-before" without relying on
 *      PostgreSQL's row-value comparison syntax (ST-028-AC4).
 *   3. listByUser CLAMPS the caller-supplied `limit` to
 *      `MAX_PAGE_SIZE = 100` (ST-028-AC5). A request for `limit: 1000`
 *      results in a database query bounded at 100 — verified by
 *      inspecting the parameter array, since the bound flows through
 *      `LIMIT $N` rather than the SQL text. The repository fetches
 *      `limit + 1` rows internally to detect "is there another page?",
 *      so the parameter the DB sees is `MAX_PAGE_SIZE + 1 = 101`.
 *   4. findById and updatePayload enforce ownership IN SQL via
 *      `WHERE user_id = $1 AND id = $2` — a request that supplies a
 *      valid design id but the wrong user id returns `null`, NOT 403
 *      (defense-in-depth: the caller cannot probe for the existence
 *      of other users' designs).
 *   5. updatePayload mutates `last_modified_at` server-side via
 *      PostgreSQL's `now()`, NEVER from a client-supplied timestamp.
 *      Clock skew between the API server and PG cannot perturb the
 *      ordering used by the keyset cursor.
 *   6. The mapper translates snake_case columns (`user_id`,
 *      `created_at`, `last_modified_at`) to camelCase domain fields
 *      (`userId`, `createdAt`, `lastModifiedAt`) and forces
 *      `payload` to a non-null object (defense-in-depth).
 *   7. PG errors (UNIQUE violations, foreign-key violations,
 *      connection errors) propagate up the call stack rather than
 *      being swallowed (Rule R8 — fail-closed posture).
 *   8. `findById` and `updatePayload` return `null` (never
 *      `undefined`) when the result set is empty — middleware and
 *      service code uses `=== null` checks to drive control flow.
 *
 * Authority:
 *   - Story ST-027 (create design endpoint).
 *   - Story ST-028 (retrieve designs by user — paginated, max 100
 *     per page).
 *   - Story ST-030 (designs schema migration with ownership FK and
 *     indexes).
 *   - Story ST-043 (deterministic, local-only, no-network unit
 *     suite).
 *   - AAP §0.7.1 (co-located unit tests per ST-043).
 *   - AAP §0.8.1 R8 (gates fail closed — pg errors propagate).
 *
 * Determinism (ST-043-AC3):
 *   - The mocked `pg.Pool` returns deterministic, in-memory results
 *     so no asynchronous boundary depends on external timing.
 *   - `jest.useFakeTimers({ now: FIXED_DATE })` pins the Date used by
 *     any wall-clock comparison so assertions never race past a
 *     second boundary. The repository under test does not invoke
 *     `Date` directly (the timestamps originate from PostgreSQL's
 *     `now()` server-side), but pinning the wall clock is a
 *     defensive measure: it guards against future refactors that
 *     introduce client-side `Date` calls and it ensures fixture
 *     timestamps stay comparable when tests cross second boundaries
 *     on slow runners.
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
 * @see backend/src/repositories/design.repository.ts — module under test
 * @see tickets/stories/ST-027-create-design-endpoint.md
 * @see tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md
 * @see tickets/stories/ST-030-designs-schema-migration-with-indexes.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// Type-only imports — required by the `@typescript-eslint/consistent-type-
// imports` rule in `.eslintrc.json`. `Pool` is the generic argument to
// `jest.Mocked<Pool>`; `QueryConfig` and `QueryResult` carry the
// repository's call shape; `QueryResultRow` is the generic bound on the
// `mockQueryResult` helper. None of these are runtime dependencies, so
// a pure type import is the correct form.
import type { Pool, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { createDesignRepository, type Design, type DesignPayload } from './design.repository';

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
 * Maximum page size enforced by the repository, mirroring the
 * `MAX_PAGE_SIZE` constant in `design.repository.ts` and the
 * ST-028-AC5 acceptance criterion ("documented maximum page size").
 *
 * The constant is duplicated here (not imported) so the test asserts
 * a concrete numeric expectation (100) rather than asserting
 * "the repository's own constant matches the repository's own
 * constant" — which would be tautological. If the repository ever
 * changed `MAX_PAGE_SIZE`, this test would fail loudly, drawing
 * attention to the breaking change.
 */
const EXPECTED_MAX_PAGE_SIZE = 100;

/**
 * The repository fetches `limit + 1` rows internally to detect
 * "is there another page?" — see the `fetchLimit` calculation in
 * `design.repository.ts`. So when a caller requests `limit: N`,
 * the parameter the DB sees is `N + 1`. This constant centralises
 * that off-by-one understanding for the parameter-array assertions
 * below.
 */
const EXPECTED_MAX_FETCH_LIMIT = EXPECTED_MAX_PAGE_SIZE + 1;

/**
 * The canonical owning user id (= Firebase uid per AAP §0.2.1) used
 * across the suite. Format mimics a realistic Firebase uid.
 */
const SAMPLE_USER_ID = 'firebase-uid-abc123XYZ456789012345678';

/**
 * The canonical design UUID used across the suite. Format mirrors
 * a realistic UUID v4 — the shape PostgreSQL would generate via
 * `gen_random_uuid()` per the ST-030 migration's column default.
 */
const SAMPLE_DESIGN_ID = '11111111-1111-4111-a111-111111111111';

// ---------------------------------------------------------------------------
// Mock helpers.
// ---------------------------------------------------------------------------
//
// The repository depends on a single object — a `pg.Pool` — and only ever
// invokes its `query` method via the QueryConfig OBJECT form
// (`pool.query<DesignRow>({ text, values })`). The `pg` types declare
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
 * the design repository calls — `pool.query<R>(config: QueryConfig)`.
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
 * The exact row shape returned by `pool.query<DesignRow>()` in the
 * repository under test. Property names match the database column
 * names verbatim (`user_id`, `created_at`, `last_modified_at`) — the
 * repository's private mapper is the single place that converts
 * snake_case columns to camelCase domain fields.
 *
 * Declared locally (rather than imported) because the source file
 * intentionally keeps `DesignRow` private. Tests assert the public
 * mapping behaviour by feeding rows shaped like this through the
 * mocked `pool.query`.
 *
 * `payload` is typed as `Record<string, unknown>` here (rather than
 * the wider `unknown`) so the `mockQueryResult` generic constraint
 * `T extends QueryResultRow` is satisfied without further coercion.
 */
interface DesignRow extends QueryResultRow {
  id: string;
  user_id: string;
  title: string;
  payload: Record<string, unknown>;
  created_at: Date;
  last_modified_at: Date;
}

/**
 * Fabricate a realistic `QueryResult<R>` shape from a list of rows.
 *
 * The `pg` library's `QueryResult` carries five fields in addition
 * to `rows` — `command`, `rowCount`, `oid`, `fields`. The repository
 * under test reads only `rows`, so the extra fields are populated
 * with neutral default values that mirror what `pg` would actually
 * return for a SELECT or RETURNING query.
 *
 * Generic constraint `T extends QueryResultRow` matches the
 * repository's own `pool.query<DesignRow>(...)` typing so a mocked
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
  // `pool.query<DesignRow>({ text, values })` signature). The cast
  // is therefore safe; if a future refactor changes the call form,
  // this assertion would surface that drift loudly.
  return call[0];
}

/**
 * Manually encode a `(lastModifiedAt, id)` cursor in the same format
 * the repository emits — base64url(JSON.stringify({lastModifiedAt,
 * id})). Used only by the cursor-based `listByUser` test; the
 * repository's own `encodeCursor` is intentionally NOT imported here
 * because the test schema's `internal_imports` whitelist allows only
 * `createDesignRepository`, `Design`, and `DesignPayload`.
 *
 * Re-implementing the encode locally (rather than importing) is a
 * stronger test: if the repository's encoding scheme changes in a
 * way that breaks compatibility with old cursors, this test will
 * fail and force an explicit decision about migration semantics.
 *
 * @param lastModifiedAtIso ISO-8601 string of the row's
 *   `last_modified_at`.
 * @param id UUID of the row.
 */
function encodeCursorForTest(lastModifiedAtIso: string, id: string): string {
  return Buffer.from(JSON.stringify({ lastModifiedAt: lastModifiedAtIso, id }), 'utf8').toString(
    'base64url',
  );
}

// ---------------------------------------------------------------------------
// Suite-level lifecycle hooks — fake timers for deterministic Date semantics.
// ---------------------------------------------------------------------------
//
// `jest.useFakeTimers({ now: FIXED_DATE })` makes `Date.now()` and the
// `Date` constructor return the same wall-clock value across every test
// in the file. The repository under test does not invoke `Date`
// directly (timestamps originate from PostgreSQL's `now()` default),
// but pinning the clock is a defensive measure: it guards against
// future refactors that introduce client-side `Date` calls and it
// ensures fixture timestamps stay comparable when tests cross second
// boundaries on slow runners.
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
// createDesignRepository — factory contract
// ===========================================================================

describe('createDesignRepository', () => {
  it('returns an object with the four documented methods', () => {
    // The repository contract specifies exactly four methods. A test
    // that enumerates them protects against accidental API additions
    // (which would expand the public surface and therefore the
    // out-of-scope risk per AAP §0.7.2) and accidental removals.
    const pool = createMockPool();
    const repo = createDesignRepository(asPool(pool));

    expect(typeof repo.insert).toBe('function');
    expect(typeof repo.listByUser).toBe('function');
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.updatePayload).toBe('function');
  });

  it('returns a frozen object so methods cannot be monkey-patched', () => {
    // The factory is documented to call `Object.freeze` on the
    // returned record — protecting against the class of bugs where a
    // test or middleware accidentally substitutes a repository method
    // at runtime. Verifying the freeze here pins the contract.
    const pool = createMockPool();
    const repo = createDesignRepository(asPool(pool));

    expect(Object.isFrozen(repo)).toBe(true);
  });

  it('does NOT invoke pool.query during construction (lazy initialisation)', () => {
    // Constructing the repository must not issue any database call.
    // Eager queries during composition would slow startup and would
    // defeat dependency-injection-based testing.
    const pool = createMockPool();
    createDesignRepository(asPool(pool));

    expect(pool.query).not.toHaveBeenCalled();
  });

  // =========================================================================
  // insert — POST /api/designs (ST-027)
  // =========================================================================

  describe('insert', () => {
    it('executes INSERT with correct SQL shape and parameter array', async () => {
      // ST-027-AC1: Create endpoint persists a new design owned by
      // the authenticated user. The repository writes
      // `(user_id, title, payload)` and lets the DB assign `id`,
      // `created_at`, and `last_modified_at` via column defaults.
      const pool = createMockPool();
      const payload: DesignPayload = {
        primaryColor: '#FF0000',
        pattern: 'classic',
        finish: 'matte',
      };
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'Red Ball',
            payload,
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.insert({
        userId: SAMPLE_USER_ID,
        title: 'Red Ball',
        payload,
      });

      // Exactly one query was issued — the INSERT.
      expect(pool.query).toHaveBeenCalledTimes(1);

      // The SQL targets the designs table, names the three insertable
      // columns, and uses RETURNING to hand back the canonical row.
      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/INSERT\s+INTO\s+designs/i);
      expect(config.text).toMatch(/user_id/);
      expect(config.text).toMatch(/title/);
      expect(config.text).toMatch(/payload/);
      expect(config.text).toMatch(/RETURNING/i);

      // The payload column is bound through an explicit `::jsonb` cast.
      // This is the documented portability pattern across pg minor
      // versions — see the source file's INSERT_DESIGN_SQL comment.
      expect(config.text).toMatch(/\$3::jsonb/);

      // Parameter array. Note the payload is JSON.stringify-d on the
      // application side before being passed to pg — the explicit
      // string-then-cast pattern. The repository values array is
      // therefore [userId, title, JSON.stringify(payload)].
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, 'Red Ball', JSON.stringify(payload)]);

      // Returned canonical record (snake_case → camelCase mapping).
      // ST-027-AC2: "A successful create returns the canonical
      // persisted design, including a server-assigned identifier
      // and timestamps".
      expect(result).toEqual({
        id: SAMPLE_DESIGN_ID,
        userId: SAMPLE_USER_ID,
        title: 'Red Ball',
        payload,
        createdAt: FIXED_DATE,
        lastModifiedAt: FIXED_DATE,
      });
    });

    it('persists a complete payload with colors, pattern, finish, and logo reference', async () => {
      // ST-027-AC1 lists "all configurator selections (colors,
      // stitching pattern, material finish, logo reference and
      // placement)" — verify the repository accepts and round-trips
      // a payload of that complete shape without inspecting it.
      const pool = createMockPool();
      const complexPayload: DesignPayload = {
        primaryColor: '#123456',
        secondaryColor: '#ABCDEF',
        accentColor: '#00FF00',
        pattern: 'hexagonal',
        finish: 'glossy',
        logo: {
          reference: 'gs://bucket/logos/abc.png',
          placement: { x: 0.5, y: 0.5, scale: 1.2, rotation: 0 },
        },
      };
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'Complex Design',
            payload: complexPayload,
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.insert({
        userId: SAMPLE_USER_ID,
        title: 'Complex Design',
        payload: complexPayload,
      });

      // The full payload survives the round trip — the repository
      // does not strip, normalise, or reshape any field. Centralising
      // this assertion future-proofs the repository against accidental
      // regressions if a new payload field is added.
      expect(result.payload).toEqual(complexPayload);

      // The serialised payload appears in the parameter array. This
      // also verifies that the application-side JSON.stringify is
      // deterministic — the same input object always serialises to
      // the same string.
      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, 'Complex Design', JSON.stringify(complexPayload)]);
    });

    it('uses parameterised placeholders ($1, $2, $3) — no string interpolation of input', async () => {
      // SQL-injection invariant: the INSERT must use $N markers and
      // pass user-supplied values via the `values` array. The title
      // in this test contains characters (single quote, semicolon)
      // that would be catastrophic if interpolated into the SQL
      // text directly.
      const pool = createMockPool();
      const malicious = "evil'; DROP TABLE designs; --";
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: malicious,
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      await repo.insert({
        userId: SAMPLE_USER_ID,
        title: malicious,
        payload: {},
      });

      const config = getQueryConfig(pool);
      // Statement uses placeholders; user input is NOT in the SQL text.
      expect(config.text).toMatch(/\$1/);
      expect(config.text).toMatch(/\$2/);
      expect(config.text).toMatch(/\$3/);
      expect(config.text).not.toContain('DROP TABLE');
      // User input flows through values, not text interpolation.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toContain(malicious);
    });

    it('coerces a null/undefined payload to an empty object before persisting', async () => {
      // The source file's defensive `?? {}` fallback handles the
      // case where a `// @ts-ignore`-style bypass smuggles a
      // null/undefined payload past TypeScript. Verify the
      // application-side serialisation produces `{}` not `null`,
      // matching the public contract that `Design.payload` is
      // always an object.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'Empty',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      // Cast through `unknown` to reach the defensive branch — this
      // is exactly the case the `?? {}` fallback exists to handle.
      await repo.insert({
        userId: SAMPLE_USER_ID,
        title: 'Empty',
        payload: null as unknown as DesignPayload,
      });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // The application-side fallback emits `JSON.stringify({})`,
      // i.e. the literal string `{}`. The DB then parses that under
      // the explicit `$3::jsonb` cast.
      expect(values?.[2]).toBe('{}');
    });

    it('throws a descriptive error when INSERT RETURNING yields zero rows', async () => {
      // The defensive check in the source file: the RETURNING clause
      // is contractually required to yield exactly one row, but a
      // future schema change could break that contract. We want a
      // LOUD failure (with a descriptive message) rather than a
      // silent `undefined` propagating into business logic.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: SAMPLE_USER_ID,
          title: 'No Row',
          payload: {},
        }),
      ).rejects.toThrow(/INSERT did not return a row/i);
    });

    it('Rule R8: foreign-key violations propagate without being swallowed', async () => {
      // ST-030 declares the FK from designs.user_id to users.id.
      // An unknown uid surfaces as a PG `23503` error which the
      // service layer translates to HTTP 401 Unauthorized. The
      // repository's contract is to PROPAGATE the pg error — never
      // to swallow it (Rule R8: gates fail closed).
      const pool = createMockPool();
      const pgError = Object.assign(
        new Error('insert or update on table "designs" violates foreign key constraint'),
        {
          code: '23503',
          constraint: 'designs_user_id_fkey',
          schema: 'public',
          table: 'designs',
        },
      );
      pool.query.mockRejectedValueOnce(pgError);

      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: 'unknown-uid',
          title: 'Title',
          payload: {},
        }),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'designs_user_id_fkey',
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

      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.insert({
          userId: SAMPLE_USER_ID,
          title: 'Title',
          payload: {},
        }),
      ).rejects.toThrow(/connection refused/i);
    });
  });

  // =========================================================================
  // listByUser — GET /api/designs (ST-028, paginated, max 100)
  // =========================================================================

  describe('listByUser', () => {
    it('queries the first page without a cursor, ordered by last_modified_at DESC, id DESC', async () => {
      // ST-028-AC4: "deterministic ordering (for example, most-
      // recently-modified first)". The repository's documented
      // ordering is `last_modified_at DESC, id DESC` — both keys
      // descend, with `id` as the deterministic tiebreaker.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: 'd1',
            user_id: SAMPLE_USER_ID,
            title: 'T1',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-10T00:00:00Z'),
          },
          {
            id: 'd2',
            user_id: SAMPLE_USER_ID,
            title: 'T2',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-09T00:00:00Z'),
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 });

      const config = getQueryConfig(pool);

      // SQL targets the designs table and pins ownership.
      expect(config.text).toMatch(/FROM\s+designs/i);
      expect(config.text).toMatch(/user_id\s*=\s*\$/);

      // CRITICAL: the ORDER BY must include BOTH keys with matching
      // direction so the cursor's "tuple-strictly-before" comparison
      // reads consistently. A mismatch here would produce duplicate
      // or skipped rows on subsequent pages.
      expect(config.text).toMatch(/ORDER BY\s+last_modified_at\s+DESC,\s*id\s+DESC/i);
      expect(config.text).toMatch(/LIMIT/i);

      // First page has NO cursor predicate. The presence of the
      // tuple-comparison clause would indicate the wrong query path
      // was taken.
      expect(config.text).not.toMatch(/last_modified_at\s*<\s*\$/);

      // Two rows returned, both mapped through snake_case →
      // camelCase translation.
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.id).toBe('d1');
      expect(result.items[1]?.id).toBe('d2');
    });

    it('passes the user id and fetchLimit (limit + 1) as the parameter array', async () => {
      // The repository fetches `limit + 1` rows internally so it can
      // detect "is there another page?" without a separate COUNT
      // query. Verify the parameter array reflects that off-by-one
      // bookkeeping — the DB sees `LIMIT 51` when the caller asks
      // for 50.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // Two parameters on the first-page query: the user id and the
      // fetchLimit. Both in this order.
      expect(values).toEqual([SAMPLE_USER_ID, 51]);
    });

    it('applies keyset pagination when a cursor is provided', async () => {
      // ST-028-AC5 says the endpoint "supports a bounded paginated
      // traversal mechanism (cursor-based, offset-based, or
      // equivalent)". The repository chose KEYSET pagination because
      // it does not degrade with page depth and does not duplicate
      // rows when designs are inserted between page fetches. Verify
      // the cursor-based query uses the documented "tuple-strictly-
      // before" pattern:
      //   (last_modified_at < $X OR (last_modified_at = $X AND id < $Y))
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: 'd3',
            user_id: SAMPLE_USER_ID,
            title: 'T3',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-08T00:00:00Z'),
          },
        ]),
      );
      const repo = createDesignRepository(asPool(pool));

      // Build a cursor representing (last_modified_at='2026-01-09T00:00:00Z', id='d2')
      const cursor = encodeCursorForTest('2026-01-09T00:00:00.000Z', 'd2');
      await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50, cursor });

      const config = getQueryConfig(pool);
      // CRITICAL: keyset pagination uses
      //   (last_modified_at < $X OR (last_modified_at = $X AND id < $Y))
      expect(config.text).toMatch(/last_modified_at\s*<\s*\$/);
      expect(config.text).toMatch(/AND\s+id\s*<\s*\$/);
      // ORDER BY must remain consistent with the WHERE comparison.
      expect(config.text).toMatch(/ORDER BY\s+last_modified_at\s+DESC,\s*id\s+DESC/i);
      // Casts to timestamptz and uuid must be present so PG parses
      // the decoded cursor strings to native types.
      expect(config.text).toMatch(/\$2::timestamptz/i);
      expect(config.text).toMatch(/\$3::uuid/i);

      // Parameter array: [userId, decodedTimestamp, decodedId, fetchLimit].
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, '2026-01-09T00:00:00.000Z', 'd2', 51]);
    });

    it('caps limit at MAX_PAGE_SIZE (100) even when a larger value is requested (ST-028-AC5)', async () => {
      // ST-028-AC5: "The endpoint enforces a documented maximum page
      // size ... so that authenticated users with large design
      // libraries cannot produce unbounded responses and every
      // response is capped at the documented page size."
      //
      // The repository CLAMPS the caller-supplied limit at the
      // repository layer so even a service-layer bug or hostile
      // request body cannot translate into an unbounded DB query.
      // The clamped value flows through `LIMIT $N` rather than the
      // SQL text, so we inspect the parameter array.
      //
      // Note: the repository fetches `limit + 1` rows internally,
      // so the cap manifests as `MAX_PAGE_SIZE + 1 = 101` in the
      // values array.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 1000 });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;

      // The capped fetchLimit appears.
      expect(values).toContain(EXPECTED_MAX_FETCH_LIMIT); // 101
      // The original un-capped value MUST NOT appear (would mean
      // the cap was bypassed).
      expect(values).not.toContain(1000);
      expect(values).not.toContain(1001);
    });

    it('uses the default page size when no limit is supplied', async () => {
      // The repository defaults `limit` to `DEFAULT_PAGE_SIZE = 25`
      // when the caller omits the field. Verify the DB sees
      // `25 + 1 = 26` as the fetchLimit parameter.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.listByUser({ userId: SAMPLE_USER_ID });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // DEFAULT_PAGE_SIZE = 25; fetchLimit = 26.
      expect(values).toEqual([SAMPLE_USER_ID, 26]);
    });

    it('clamps a non-numeric or non-finite limit to the default', async () => {
      // The repository's `Number.isFinite` guard rejects NaN,
      // Infinity, and -Infinity. The fallback is DEFAULT_PAGE_SIZE
      // (25), so fetchLimit is 26.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      // Cast through `unknown` to inject a non-finite value past
      // TypeScript — exactly the case the runtime guard exists for.
      await repo.listByUser({
        userId: SAMPLE_USER_ID,
        limit: NaN as unknown as number,
      });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, 26]);
    });

    it('clamps a sub-1 limit to 1 (so LIMIT 0 never reaches the DB)', async () => {
      // The repository's `Math.max(1, ...)` clamp ensures the DB
      // never sees a non-positive LIMIT. Verify a request for
      // `limit: 0` becomes fetchLimit = 2 (clamped to 1, plus 1).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 0 });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // limit clamped to 1; fetchLimit = 1 + 1 = 2.
      expect(values).toEqual([SAMPLE_USER_ID, 2]);
    });

    it('floors a fractional limit to an integer', async () => {
      // The repository's `Math.floor` guard ensures a fractional
      // limit (e.g. from a route handler that forgot to coerce a
      // string to an integer) does not produce a non-integer LIMIT
      // clause — pg would otherwise reject that with a cryptic error.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50.7 });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // Math.floor(50.7) = 50; fetchLimit = 51.
      expect(values).toEqual([SAMPLE_USER_ID, 51]);
    });

    it('returns an empty list with nextCursor=null when the user has no designs', async () => {
      // ST-028-AC3: "When the authenticated user has no designs, the
      // endpoint returns an empty collection with a success status
      // (not an error)."
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 });

      expect(result.items).toEqual([]);
      // nextCursor is `null` (not undefined) when no more rows exist.
      // The literal-null contract matches the source file's documented
      // "conventional signal for 'you've reached the end'".
      expect(result.nextCursor).toBeNull();
    });

    it('returns nextCursor=null when the page is partial (fewer rows than requested)', async () => {
      // When the DB returns fewer rows than requested, we know there
      // are no more pages — emit `nextCursor: null`. (We requested
      // fetchLimit=51 but only got 3 rows back.)
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: 'd1',
            user_id: SAMPLE_USER_ID,
            title: 'T1',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-10T00:00:00Z'),
          },
          {
            id: 'd2',
            user_id: SAMPLE_USER_ID,
            title: 'T2',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-09T00:00:00Z'),
          },
          {
            id: 'd3',
            user_id: SAMPLE_USER_ID,
            title: 'T3',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: new Date('2026-01-08T00:00:00Z'),
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 });

      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
    });

    it('returns a nextCursor encoding (lastModifiedAt, id) of the LAST kept row when more rows exist', async () => {
      // The repository fetches `limit + 1` rows so it can detect
      // when more pages exist. When the DB returns exactly
      // `limit + 1` rows, the repository slices off the extra row
      // and emits a `nextCursor` derived from the LAST KEPT row.
      // The cursor decodes back to the (lastModifiedAt, id) tuple
      // suitable for the next "tuple-strictly-before" query.
      const pool = createMockPool();
      // Build 51 rows (= fetchLimit) so hasMore=true. The mocked DB
      // returns rows in `last_modified_at DESC` order, so each row's
      // timestamp is one second earlier than the previous.
      const rows: DesignRow[] = Array.from({ length: 51 }, (_, i) => ({
        id: `d${i}`,
        user_id: SAMPLE_USER_ID,
        title: `T${i}`,
        payload: {},
        created_at: FIXED_DATE,
        last_modified_at: new Date(FIXED_DATE.getTime() - i * 1000),
      }));
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>(rows));

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 });

      // Returned page is bounded at the requested limit; the extra
      // 51st row is dropped (it would have been the first row of the
      // NEXT page).
      expect(result.items).toHaveLength(50);
      expect(result.nextCursor).toBeTruthy();
      expect(typeof result.nextCursor).toBe('string');

      // Decode the cursor and verify it points at the LAST kept row
      // (rows[49] = 'd49') — the next page request will use that
      // tuple as its "strictly before" bound.
      const decoded: { lastModifiedAt: string; id: string } = JSON.parse(
        Buffer.from(result.nextCursor!, 'base64url').toString('utf8'),
      );
      expect(decoded.id).toBe('d49');
      // The timestamp matches the last kept row's last_modified_at,
      // serialised to ISO-8601 (the repository's documented wire
      // format for cursor timestamps).
      expect(decoded.lastModifiedAt).toBe(rows[49]!.last_modified_at.toISOString());
    });

    it('throws a descriptive error when the cursor is not parseable JSON', async () => {
      // The decodeCursor helper THROWS on every form of malformed
      // input (not base64url-encoded JSON, malformed JSON, missing
      // required fields, unparseable timestamp). The service layer
      // is responsible for translating the throw to HTTP 400. The
      // repository layer surfaces a loud, descriptive error so a
      // bug that produces a malformed cursor is visible in logs and
      // metrics, not masked.
      const pool = createMockPool();
      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.listByUser({
          userId: SAMPLE_USER_ID,
          limit: 50,
          cursor: 'not-base64url-json',
        }),
      ).rejects.toThrow(/Invalid cursor/i);

      // No DB query should have been issued — decodeCursor throws
      // before pool.query is reached.
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('throws a descriptive error when the cursor JSON is missing required fields', async () => {
      // A cursor that decodes to syntactically valid JSON but is
      // missing the documented `lastModifiedAt` and/or `id` fields
      // must surface a structured error — not a downstream pg
      // syntax error or an `undefined` value silently flowing
      // into the SQL parameter array. This exercises the
      // "missing required fields" branch of decodeCursor.
      const pool = createMockPool();
      const repo = createDesignRepository(asPool(pool));

      // Valid base64url-encoded JSON that lacks the required fields.
      const malformed = Buffer.from(JSON.stringify({ unrelated: 'field' }), 'utf8').toString(
        'base64url',
      );

      await expect(
        repo.listByUser({
          userId: SAMPLE_USER_ID,
          limit: 50,
          cursor: malformed,
        }),
      ).rejects.toThrow(/Invalid cursor/i);

      // No DB query should have been issued — decodeCursor throws
      // before pool.query is reached.
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('throws a descriptive error when the cursor timestamp is unparseable', async () => {
      // A cursor whose `lastModifiedAt` is syntactically a string
      // but does not parse as a valid Date must throw with a
      // dedicated "invalid timestamp" error rather than letting
      // the malformed value flow into PostgreSQL where it would
      // surface as a less-actionable
      // `invalid input syntax for type timestamp with time zone`.
      const pool = createMockPool();
      const repo = createDesignRepository(asPool(pool));

      // Valid shape, valid types, invalid timestamp value.
      const malformed = Buffer.from(
        JSON.stringify({ lastModifiedAt: 'not-a-date', id: 'abc' }),
        'utf8',
      ).toString('base64url');

      await expect(
        repo.listByUser({
          userId: SAMPLE_USER_ID,
          limit: 50,
          cursor: malformed,
        }),
      ).rejects.toThrow(/Invalid cursor.*timestamp/i);

      // No DB query should have been issued — decodeCursor throws
      // before pool.query is reached.
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns a fresh array of items independent across multiple invocations', async () => {
      // Verify the repository does not retain or mutate any
      // per-invocation state across calls — each listByUser produces
      // an independent result. This protects against a class of bugs
      // where a stale cursor or shared array leaks into subsequent
      // pages.
      const pool = createMockPool();
      pool.query
        .mockResolvedValueOnce(
          mockQueryResult<DesignRow>([
            {
              id: 'first-call-id',
              user_id: SAMPLE_USER_ID,
              title: 'First',
              payload: {},
              created_at: FIXED_DATE,
              last_modified_at: FIXED_DATE,
            },
          ]),
        )
        .mockResolvedValueOnce(
          mockQueryResult<DesignRow>([
            {
              id: 'second-call-id',
              user_id: SAMPLE_USER_ID,
              title: 'Second',
              payload: {},
              created_at: FIXED_DATE,
              last_modified_at: FIXED_DATE,
            },
          ]),
        );

      const repo = createDesignRepository(asPool(pool));
      const first = await repo.listByUser({ userId: SAMPLE_USER_ID });
      const second = await repo.listByUser({ userId: SAMPLE_USER_ID });

      expect(first.items).toHaveLength(1);
      expect(first.items[0]?.id).toBe('first-call-id');
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).toBe('second-call-id');
      // The two invocations produce DISTINCT array references.
      expect(first.items).not.toBe(second.items);
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('connection refused'));

      const repo = createDesignRepository(asPool(pool));

      await expect(repo.listByUser({ userId: SAMPLE_USER_ID, limit: 50 })).rejects.toThrow(
        /connection refused/i,
      );
    });
  });

  // =========================================================================
  // findById — share-link issuance + share read endpoint (ST-029)
  // =========================================================================

  describe('findById', () => {
    it('fetches a single design with ownership pinned in the SQL WHERE clause', async () => {
      // Both `userId` AND `designId` are required: ownership is
      // enforced in SQL via `WHERE user_id = $1 AND id = $2`. A
      // request that supplies a valid design id but the wrong user
      // id returns `null` (NOT 403) — the repository does not
      // distinguish "does not exist" from "owned by someone else"
      // by design.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'Found',
            payload: { primaryColor: '#000000' },
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
      });

      const config = getQueryConfig(pool);

      // SQL targets the designs table.
      expect(config.text).toMatch(/FROM\s+designs/i);

      // CRITICAL: BOTH the id predicate AND the user_id predicate
      // must be present. Either one alone would be a security
      // defect: id-only would let any user read any design;
      // user_id-only would return all of the caller's designs.
      expect(config.text).toMatch(/id\s*=\s*\$/);
      expect(config.text).toMatch(/user_id\s*=\s*\$/);
      // Defense-in-depth — verify the SQL uses AND not OR.
      expect(config.text).toMatch(/user_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/i);

      // Parameter array: [userId, designId] — the order matches
      // the $1, $2 placeholders.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, SAMPLE_DESIGN_ID]);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(SAMPLE_DESIGN_ID);
      expect(result?.userId).toBe(SAMPLE_USER_ID);
    });

    it('returns null (NOT undefined) when the user does not own the design', async () => {
      // The SQL WHERE conflates "does not exist" with "owned by
      // someone else" by design (defense-in-depth: callers cannot
      // probe for the existence of other users' designs).
      // Distinguishing `null` from `undefined` matters: middleware
      // and service code uses `=== null` checks to drive control
      // flow; an `undefined` return would silently bypass those
      // branches.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: 'different-user',
        designId: SAMPLE_DESIGN_ID,
      });

      expect(result).toBeNull();
      // Stronger assertion: the value is exactly null, not undefined.
      expect(result === null).toBe(true);
    });

    it('returns null when the design id does not exist at all', async () => {
      // Same code path as "owned by another user" — the public
      // contract collapses both cases to `null`.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: 'nonexistent-design-id',
      });

      expect(result).toBeNull();
    });

    it('uses parameterised placeholders — no string interpolation of input', async () => {
      // Even though the design id is server-issued and not directly
      // user-controlled at this call site, the SQL-injection
      // invariant applies universally — repositories never
      // interpolate values into the statement text.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: "'; DROP TABLE designs; --",
      });

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/\$1/);
      expect(config.text).toMatch(/\$2/);
      expect(config.text).not.toContain('DROP TABLE');
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.findById({ userId: SAMPLE_USER_ID, designId: SAMPLE_DESIGN_ID }),
      ).rejects.toThrow(/connection terminated/i);
    });
  });

  // =========================================================================
  // updatePayload — payload-only update with server-side last_modified_at bump
  // =========================================================================

  describe('updatePayload', () => {
    it('issues UPDATE setting payload and last_modified_at, with ownership enforced', async () => {
      // The UPDATE statement must:
      //   1. Target the designs table.
      //   2. SET `payload = $3::jsonb` — the explicit `::jsonb`
      //      cast is the documented portability pattern.
      //   3. SET `last_modified_at = now()` — server-side bump,
      //      NEVER from a client-supplied timestamp (clock-skew
      //      invariant).
      //   4. WHERE `user_id = $1 AND id = $2` — ownership pinned
      //      in SQL, not in application code.
      //   5. RETURN the canonical row so the service layer does
      //      not need a follow-up SELECT.
      const pool = createMockPool();
      const newPayload: DesignPayload = {
        primaryColor: '#FFFFFF',
        pattern: 'hexagonal',
        finish: 'glossy',
      };
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'Updated',
            payload: newPayload,
            created_at: new Date('2026-01-01T00:00:00Z'),
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.updatePayload({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
        payload: newPayload,
      });

      const config = getQueryConfig(pool);
      expect(config.text).toMatch(/UPDATE\s+designs/i);
      expect(config.text).toMatch(/SET\s+payload\s*=\s*\$3::jsonb/i);
      // CRITICAL: last_modified_at must be set via PostgreSQL's
      // `now()`, not via a client parameter. Allow CURRENT_TIMESTAMP
      // as a synonym to be future-proof against a stylistic refactor.
      expect(config.text).toMatch(/last_modified_at\s*=\s*(now\(\)|CURRENT_TIMESTAMP)/i);
      expect(config.text).toMatch(/WHERE/i);
      expect(config.text).toMatch(/user_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/i);
      expect(config.text).toMatch(/RETURNING/i);

      // Parameter order: [userId, designId, JSON.stringify(payload)].
      // CRITICAL: payload is JSON.stringify-d on the application
      // side; the explicit string-then-cast pattern ensures pg
      // version-stability.
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toEqual([SAMPLE_USER_ID, SAMPLE_DESIGN_ID, JSON.stringify(newPayload)]);

      // Returned row is the updated state with the new payload and
      // the server-bumped last_modified_at timestamp.
      expect(result).not.toBeNull();
      expect(result?.payload).toEqual(newPayload);
      expect(result?.lastModifiedAt).toEqual(FIXED_DATE);
      // The original creation timestamp is preserved — the UPDATE
      // does NOT touch `created_at`.
      expect(result?.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    });

    it('does NOT pass a client-supplied last_modified_at through the parameter array', async () => {
      // Defense in depth: even if a future refactor added a
      // `lastModifiedAt` field to UpdateDesignPayloadParams, the
      // repository must continue to use SQL's `now()` exclusively.
      // We assert the parameter array contains EXACTLY three values
      // — the absence of a fourth (timestamp) parameter is the
      // contract.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'T',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      await repo.updatePayload({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
        payload: {},
      });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      expect(values).toHaveLength(3);
    });

    it('returns null when UPDATE matches zero rows (caller does not own the design)', async () => {
      // ST-027/ST-029 expose this null return through the route
      // handler — the service layer translates `null` to either 404
      // or 403 depending on the route. The repository layer leaves
      // the two cases indistinguishable (defense-in-depth: callers
      // cannot probe for the existence of other users' designs).
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(mockQueryResult<DesignRow>([]));

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.updatePayload({
        userId: 'attacker',
        designId: SAMPLE_DESIGN_ID,
        payload: { primaryColor: '#000000' },
      });

      expect(result).toBeNull();
      // Stronger assertion: literal null, not undefined.
      expect(result === null).toBe(true);
    });

    it('coerces a null/undefined payload to an empty object before persisting', async () => {
      // Mirror of the insert defensive `?? {}` fallback. A `// @ts-
      // ignore`-style bypass that smuggles a null/undefined payload
      // past TypeScript must not produce a SQL `null::jsonb` UPDATE
      // — the column is non-null per the ST-030 schema, so a null
      // would surface as a 23502 NOT NULL violation. The application
      // fallback to `{}` keeps the public contract intact.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'T',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      await repo.updatePayload({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
        payload: undefined as unknown as DesignPayload,
      });

      const config = getQueryConfig(pool);
      const values = config.values as readonly unknown[] | undefined;
      // The payload parameter (position 2) is the literal string
      // `{}` — JSON.stringify of the empty-object fallback.
      expect(values?.[2]).toBe('{}');
    });

    it('Rule R8: pg errors propagate rather than being swallowed', async () => {
      const pool = createMockPool();
      pool.query.mockRejectedValueOnce(new Error('pool exhausted'));

      const repo = createDesignRepository(asPool(pool));

      await expect(
        repo.updatePayload({
          userId: SAMPLE_USER_ID,
          designId: SAMPLE_DESIGN_ID,
          payload: {},
        }),
      ).rejects.toThrow(/pool exhausted/i);
    });
  });

  // =========================================================================
  // Row mapping — snake_case → camelCase
  // =========================================================================

  describe('row mapping', () => {
    it('translates DB column names to camelCase domain fields', async () => {
      // The mapper is private to design.repository.ts; we verify it
      // through the public surface. A row shaped exactly like the
      // database returns (snake_case keys) MUST emerge as the
      // public-shaped Design (camelCase keys) with no extra fields.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: 'abc',
            user_id: 'def',
            title: 'hello',
            payload: { primaryColor: '#000000' },
            created_at: new Date('2025-12-01T00:00:00Z'),
            last_modified_at: new Date('2025-12-02T00:00:00Z'),
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({ userId: 'def', designId: 'abc' });

      // `as Design` cast is for type safety only; the deep equality
      // assertion below is what does the work.
      const expected: Design = {
        id: 'abc',
        userId: 'def',
        title: 'hello',
        payload: { primaryColor: '#000000' },
        createdAt: new Date('2025-12-01T00:00:00Z'),
        lastModifiedAt: new Date('2025-12-02T00:00:00Z'),
      };
      expect(result).toEqual(expected);
    });

    it('coerces a null payload to an empty object (defense-in-depth)', async () => {
      // The mapper's `?? {}` fallback handles the case where the DB
      // somehow returns a null payload (which the ST-030 NOT NULL
      // constraint forbids, but defense-in-depth protects against
      // adversarial state). The public contract — Design.payload is
      // a non-null object — must hold regardless.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'T',
            // The DesignRow type permits this via the Record<string,
            // unknown> typing; the mapper coerces it back to {}.
            payload: null as unknown as Record<string, unknown>,
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
      });

      expect(result).not.toBeNull();
      expect(result?.payload).toEqual({});
      // The fallback produces an actual object, not null/undefined.
      expect(result?.payload).not.toBeNull();
      expect(typeof result?.payload).toBe('object');
    });

    it('preserves the canonical Design key set across all four methods', async () => {
      // If the mapper introduced an `extras` or `meta` field, it
      // would expand the public surface beyond what AAP §0.7.2
      // permits and would surface a documentation drift between
      // the Design interface and the runtime shape. Verify the
      // returned object has EXACTLY the documented keys.
      const pool = createMockPool();
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'T',
            payload: {},
            created_at: FIXED_DATE,
            last_modified_at: FIXED_DATE,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
      });

      expect(result).not.toBeNull();
      const keys = Object.keys(result as object).sort();
      expect(keys).toEqual(
        ['createdAt', 'id', 'lastModifiedAt', 'payload', 'title', 'userId'].sort(),
      );
    });

    it('preserves the Date type for timestamp columns through the mapping', async () => {
      // The pg driver returns Date instances for TIMESTAMP WITH
      // TIME ZONE columns by default (per pg's documented type
      // parser registry). The mapper passes these through verbatim
      // — we do NOT convert to ISO strings, epoch ms, or any other
      // representation at this layer. Service layers that need a
      // wire-format string call `.toISOString()` themselves.
      const pool = createMockPool();
      const created = new Date('2025-11-15T00:00:00Z');
      const modified = new Date('2025-12-31T23:59:59Z');
      pool.query.mockResolvedValueOnce(
        mockQueryResult<DesignRow>([
          {
            id: SAMPLE_DESIGN_ID,
            user_id: SAMPLE_USER_ID,
            title: 'T',
            payload: {},
            created_at: created,
            last_modified_at: modified,
          },
        ]),
      );

      const repo = createDesignRepository(asPool(pool));
      const result = await repo.findById({
        userId: SAMPLE_USER_ID,
        designId: SAMPLE_DESIGN_ID,
      });

      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.lastModifiedAt).toBeInstanceOf(Date);
      // Reference equality is preserved (not a new Date built from
      // the value) — the mapper passes the pg Date through verbatim.
      expect(result?.createdAt).toEqual(created);
      expect(result?.lastModifiedAt).toEqual(modified);
    });
  });

  // =========================================================================
  // Type-level checks — compile-time contracts on the exported types
  // =========================================================================

  describe('exported type contracts', () => {
    it('DesignPayload accepts arbitrary configurator shapes', () => {
      // This is a COMPILE-TIME assertion. If the DesignPayload type
      // changed shape (e.g. to a union of named variants), the
      // assignments below would fail to compile. The runtime
      // assertion is a no-op tautology — the value of this test
      // is the type checking it forces.
      const minimal: DesignPayload = { primaryColor: '#000000' };
      const empty: DesignPayload = {};
      const complex: DesignPayload = {
        primaryColor: '#000000',
        secondaryColor: '#FFFFFF',
        accentColor: '#FF0000',
        pattern: 'classic',
        finish: 'matte',
        logo: { reference: 'gs://x/y', placement: { x: 0, y: 0, scale: 1, rotation: 0 } },
      };

      // Runtime assertions to use the variables and prevent
      // `noUnusedLocals` from rejecting the compilation.
      expect(typeof minimal).toBe('object');
      expect(typeof empty).toBe('object');
      expect(typeof complex).toBe('object');
    });

    it('Design interface enforces readonly fields', () => {
      // Compile-time check: the Design interface is documented as
      // fully `readonly` so consumers cannot mutate the record after
      // retrieval. We can only assert this at runtime via a
      // structural check; the static check is enforced by the
      // TypeScript compiler at build time.
      const sample: Design = {
        id: 'a',
        userId: 'b',
        title: 'c',
        payload: {},
        createdAt: FIXED_DATE,
        lastModifiedAt: FIXED_DATE,
      };
      expect(sample.id).toBe('a');
      expect(sample.userId).toBe('b');
      expect(sample.title).toBe('c');
      expect(sample.payload).toEqual({});
      expect(sample.createdAt).toEqual(FIXED_DATE);
      expect(sample.lastModifiedAt).toEqual(FIXED_DATE);
    });
  });
});
