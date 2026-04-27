/**
 * backend/src/db/client.test.ts
 *
 * Unit tests for `backend/src/db/client.ts`.
 *
 * ============================================================================
 * Authority (verbatim from the Agent Action Plan and stories)
 * ============================================================================
 *
 *   - Story ST-043-AC3 (verbatim):
 *       "A failing assertion, a test exception, or a coverage percentage
 *        below the documented threshold produces a failed verdict; the
 *        suite is deterministic, so repeated runs against the same source
 *        tree produce the same verdict."
 *
 *   - Story ST-043-AC4 (verbatim):
 *       "The suite runs in the local development environment without any
 *        additional services or network access beyond the standard local
 *        toolchain."
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
 *   - AAP §0.8.1 Rule R2 (verbatim, User Example):
 *       send a login request with `"password":"SENTINEL_CRED_99"` and
 *       verify `grep "SENTINEL_CRED_99"` returns 0 lines.
 *
 * ============================================================================
 * Contracts verified
 * ============================================================================
 *
 *   1. `query<T>()` — happy path
 *      - Acquires the pool via `getPool()` (NOT instantiated here).
 *      - Forwards `(sql, params)` to `pool.query(...)` verbatim.
 *      - Returns the `rows` array, NOT the full `QueryResult` object.
 *      - Empty results return `[]`, not `null`.
 *
 *   2. `query<T>()` — error path
 *      - Re-throws the underlying `pg` error verbatim (no wrapping).
 *      - Emits a `db.query.error` log record with `event`, `err`, and
 *        `durationMs` fields.
 *      - DOES NOT include the `params` array in the log record (Rule R2).
 *      - DOES NOT include any sentinel credential string from `params`
 *        anywhere in the emitted log payload.
 *
 *   3. `withTransaction<T>()` — happy path
 *      - Acquires a client via `pool.connect()`.
 *      - Issues `BEGIN`, runs the callback, then issues `COMMIT`.
 *      - The callback receives the EXACT acquired `PoolClient`.
 *      - Returns the callback's resolved value.
 *      - Releases the client via `client.release()` in the `finally`
 *        block.
 *
 *   4. `withTransaction<T>()` — callback error path
 *      - Issues `ROLLBACK` after the callback throws.
 *      - Re-throws the ORIGINAL callback error (NOT the rollback error,
 *        even when both fail).
 *      - Always releases the client even when the callback throws.
 *      - Emits `db.transaction.rollback.failed` ONLY when the rollback
 *        itself fails.
 *
 *   5. `withTransaction<T>()` — BEGIN error path
 *      - Propagates the BEGIN error without invoking the callback.
 *      - Still releases the client.
 *
 *   6. `withTransaction<T>()` — COMMIT error path
 *      - Propagates the COMMIT error.
 *      - Still releases the client.
 *
 *   7. `withTransaction<T>()` — original-error precedence
 *      - When both the callback and ROLLBACK fail, the ORIGINAL callback
 *        error (NOT the rollback error) is the one re-thrown.
 *      - The rollback failure is logged via
 *        `event: 'db.transaction.rollback.failed'`.
 *
 *   8. Rule R2 — credential sentinel
 *      - A user-supplied string `'SENTINEL_CRED_99'` passed in `params`
 *        NEVER appears in any field of any log record emitted by either
 *        helper.
 *
 * ============================================================================
 * Determinism (ST-043-AC3)
 * ============================================================================
 *
 *   - Mocks `./pool` and `../logging/pino` so the suite makes ZERO network
 *     calls and opens ZERO files.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets
 *     `clearMocks`, `resetMocks`, `restoreMocks` to `true`; mock state is
 *     wiped between tests. The `beforeEach` block reinstalls per-test
 *     mock implementations explicitly for clarity.
 *
 * @see backend/src/db/client.ts        — module under test
 * @see backend/src/db/pool.ts          — mocked dependency (`getPool`)
 * @see backend/src/logging/pino.ts     — mocked dependency (`logger`)
 * @see backend/jest.config.unit.ts     — Jest runner configuration
 */

// Type-only imports — used as generics on `jest.MockedFunction<...>` and
// for narrow shapes of `Pool` and `PoolClient`. No runtime `pg` code is
// loaded; the runtime pool is mocked via `./pool` below.
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// ---------------------------------------------------------------------------
// Hoisted mocks — installed BEFORE the module under test loads
// ---------------------------------------------------------------------------
//
// Jest's transformer hoists `jest.mock(...)` calls above all imports, so
// these factories run before the `import` statements below resolve. Each
// factory creates `jest.fn()` instances inline (jest is a global at
// factory-evaluation time); typed handles are recovered after the imports
// via `as jest.MockedFunction<...>` casts.
//
// Both factories are SELF-CONTAINED — they only reference `jest` (a
// global) and string/number literals — which avoids the well-known
// "Cannot access X before initialization" hoist hazard.

jest.mock('./pool', () => ({
  __esModule: true,
  // Returns a `Pool`-shaped mock; per-test implementations install
  // `getPoolMock.mockReturnValue(...)` in `beforeEach`.
  getPool: jest.fn(),
}));

jest.mock('../logging/pino', () => ({
  __esModule: true,
  logger: {
    // Only `error` is needed by the module under test (both
    // `db.query.error` and `db.transaction.rollback.failed` use the
    // error level). Other levels are stubbed defensively so a future
    // call site does not silently no-op against an undefined function.
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports of the mocked modules and the module under test
// ---------------------------------------------------------------------------
//
// These imports MUST come AFTER the `jest.mock` calls above. Jest's
// Babel/SWC transformer hoists `jest.mock` over imports automatically,
// but keeping the imports physically below the mocks documents the
// intended load order for human readers and survives any future
// refactor that disables hoisting.

import { getPool } from './pool';
import { logger } from '../logging/pino';

import { query, withTransaction } from './client';

// ---------------------------------------------------------------------------
// Typed handles to the mock functions
// ---------------------------------------------------------------------------
//
// At runtime, `getPool` is the `jest.fn()` created inside the mock
// factory above. TypeScript still sees it as the original `() => Pool`
// signature; casting through `jest.MockedFunction<typeof getPool>`
// recovers Jest-specific methods (`mockReturnValue`, `mockReset`, etc.)
// while preserving the exact call signature.

const getPoolMock = getPool as jest.MockedFunction<typeof getPool>;

const loggerErrorMock = logger.error as jest.MockedFunction<typeof logger.error>;

// ---------------------------------------------------------------------------
// Mock construction helpers
// ---------------------------------------------------------------------------

/**
 * Narrow function type capturing both the positional-string and the
 * QueryConfig forms of `pool.query` / `client.query`. Required so
 * `mockResolvedValueOnce(QueryResult)` and `mockRejectedValueOnce(Error)`
 * typecheck cleanly across all call shapes the module under test uses.
 */
type QueryMock = jest.MockedFunction<(...args: unknown[]) => Promise<QueryResult<QueryResultRow>>>;

/**
 * Narrow function type for `pool.connect()`. The `PoolClient` cast is
 * applied at the mock-setup site so the per-test `MockedClient` (which
 * is intentionally narrower than the full `PoolClient` interface) flows
 * through the typed boundary without leaking implementation details
 * into the production source.
 */
type ConnectMock = jest.MockedFunction<() => Promise<PoolClient>>;

/**
 * Local test-only `PoolClient` surface. Includes only the members
 * `withTransaction` actually invokes — `query` and `release`. The full
 * `PoolClient` interface declares dozens of methods (event-emitter
 * wiring, transaction state, copy streams) the module under test never
 * reaches for; populating them on the mock would add type noise without
 * protective value.
 */
interface MockedClient {
  query: QueryMock;
  release: jest.Mock;
}

/**
 * Local test-only `Pool` surface. Includes the members the module under
 * test invokes (`query`, `connect`) plus minimal event-emitter scaffolding
 * so a future caller cannot break the mock by depending on them.
 *
 * `_client` is a back-channel field — NOT a real `pg.Pool` member — that
 * exposes the mocked `PoolClient` returned by `pool.connect()` so tests
 * can script its `query` mock and assert its `release` calls.
 */
interface MockedPool {
  query: QueryMock;
  connect: ConnectMock;
  end: jest.Mock;
  on: jest.Mock;
  /** Back-channel for tests; not a real Pool member. */
  _client: MockedClient;
}

/**
 * Construct a typed {@link MockedPool} with fresh `jest.fn()` instances
 * on every property. `pool.connect()` is wired to resolve with the
 * embedded `_client` mock so `withTransaction` finds a `PoolClient` to
 * drive the transaction against.
 *
 * Called per-test (rather than once at module scope) so Jest's
 * `resetMocks: true` setting does not leave stale implementations
 * leaking across tests. A fresh `createMockPool()` each test is the
 * cleanest way to guarantee known starting state.
 */
function createMockPool(): MockedPool {
  const client: MockedClient = {
    query: jest.fn() as QueryMock,
    release: jest.fn(),
  };

  const connect = jest.fn().mockResolvedValue(client) as unknown as ConnectMock;

  return {
    query: jest.fn() as QueryMock,
    connect,
    end: jest.fn(),
    on: jest.fn(),
    _client: client,
  };
}

/**
 * Build a deterministic `pg.QueryResult` from a `rows` array.
 *
 * pg's `QueryResult` is a structural type with `command`, `rowCount`,
 * `oid`, `fields`, and `rows`. Tests only inspect `rows`, but populating
 * the other fields with realistic defaults keeps the mock usable when a
 * future caller starts inspecting them — failure modes change from
 * "TypeError on undefined.x" to "assertion failure on the wrong field",
 * which is much easier to debug.
 */
function mockQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Suite-wide state
// ---------------------------------------------------------------------------

/**
 * Shared mock pool instance for the current test. Re-created in
 * `beforeEach` so each test starts from a clean state.
 *
 * Declared as `MockedPool` so per-test code reaches for `_client` and
 * `connect` without an extra cast at every call site.
 */
let mockPool: MockedPool;

beforeEach(() => {
  // Clean slate per test. Jest's resetMocks/restoreMocks already wipe
  // implementations, but explicitly building a fresh pool here makes
  // the "what is in scope" answer trivially obvious to readers.
  mockPool = createMockPool();
  getPoolMock.mockReturnValue(mockPool as unknown as Pool);
});

// =============================================================================
// query<T>()
// =============================================================================

describe('query<T>()', () => {
  it('returns the rows array from the underlying pool query', async () => {
    interface UserRow extends QueryResultRow {
      id: string;
      email: string;
    }
    const rows: UserRow[] = [
      { id: 'uid-1', email: 'alice@example.com' },
      { id: 'uid-2', email: 'bob@example.com' },
    ];
    mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

    const result = await query<UserRow>('SELECT id, email FROM users WHERE id = ANY($1)', [
      ['uid-1', 'uid-2'],
    ]);

    expect(result).toEqual(rows);
    // Must NOT return the full QueryResult — the contract is rows only.
    expect(result).not.toHaveProperty('rowCount');
    expect(result).not.toHaveProperty('command');
  });

  it('forwards (sql, params) verbatim to the pool', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const sql = 'SELECT 1 WHERE $1::text = $2::text';
    const params = ['hello', 'world'];
    await query(sql, params);

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledWith(sql, params);
  });

  it('defaults params to an empty array when omitted', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    await query('SELECT 1');

    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1', []);
  });

  it('returns an empty array (not null/undefined) on empty results', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const result = await query<{ id: string }>('SELECT id FROM users WHERE id = $1', [
      'nonexistent',
    ]);

    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
    // Belt-and-suspenders: a future refactor that returns `null` for
    // empty results would silently break repository null-checks; this
    // explicit assertion prevents that drift.
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('acquires the pool via getPool() and not via direct instantiation', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    await query('SELECT 1');

    // Each invocation MUST call `getPool()` exactly once. This assertion
    // protects against a future refactor that caches the pool in module
    // scope, which would defeat the singleton-rotation pattern in
    // pool.ts (closePool() + initializePool() in test harnesses).
    expect(getPoolMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws the underlying pg error verbatim on failure', async () => {
    const dbError = Object.assign(new Error('duplicate key value'), {
      code: '23505', // unique_violation
      detail: 'Key (login_identifier)=(taken@example.com) already exists.',
    });
    mockPool.query.mockRejectedValueOnce(dbError);

    await expect(
      query<{ id: string }>('INSERT INTO users (login_identifier) VALUES ($1) RETURNING id', [
        'taken@example.com',
      ]),
    ).rejects.toBe(dbError);

    // The caller branches on `pg.DatabaseError.code` (e.g. '23505' for
    // unique violations); preserving the native error fields is the
    // contract that lets routes translate to HTTP status codes.
    // Note: rejects.toBe checks reference equality, which already
    // confirms native fields are intact.
  });

  it('logs db.query.error on failure with event, err, and durationMs', async () => {
    const dbError = new Error('connection lost');
    mockPool.query.mockRejectedValueOnce(dbError);

    await expect(query('SELECT 1')).rejects.toBe(dbError);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logRecord, message] = loggerErrorMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];

    expect(logRecord).toMatchObject({
      event: 'db.query.error',
      err: dbError,
    });
    expect(typeof logRecord['durationMs']).toBe('number');
    expect(logRecord['durationMs']).toBeGreaterThanOrEqual(0);
    expect(message).toBe('Database query failed');
  });

  it('does NOT include the params array in the error log record (Rule R2)', async () => {
    const dbError = new Error('boom');
    mockPool.query.mockRejectedValueOnce(dbError);

    const sentinelParams = ['SENTINEL_CRED_99', 'another-secret'];
    await expect(
      query('SELECT * FROM users WHERE password = $1 OR id = $2', sentinelParams),
    ).rejects.toBe(dbError);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logRecord] = loggerErrorMock.mock.calls[0] as unknown as [Record<string, unknown>];

    // Direct field assertion: no `params` key on the log record.
    expect(logRecord).not.toHaveProperty('params');

    // Defense-in-depth: stringify the entire log payload and confirm
    // none of the sentinel values appear ANYWHERE in it. This catches
    // a future refactor that might log params under a different key
    // (e.g. `args`, `values`, `bindings`).
    const payload = JSON.stringify(logRecord, (_key, value: unknown) =>
      // Errors don't serialize cleanly via default JSON.stringify; the
      // pino `err` serializer handles that in production. Here we
      // expand the error fields into a plain object so the sentinel
      // assertion can search the full surface area.
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    );
    expect(payload).not.toContain('SENTINEL_CRED_99');
    expect(payload).not.toContain('another-secret');
  });

  it('measures durationMs as a non-negative number', async () => {
    // Force a synchronous failure so durationMs is computed
    // immediately; the value should still be a non-negative number.
    mockPool.query.mockImplementationOnce(() => Promise.reject(new Error('fast fail')));

    await expect(query('SELECT 1')).rejects.toThrow('fast fail');

    const [logRecord] = loggerErrorMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(logRecord['durationMs']).toBeGreaterThanOrEqual(0);
    // Sanity bound: in a unit test, the duration should never exceed a
    // few hundred milliseconds. A test environment under extreme load
    // could overshoot, so we allow a generous 5-second ceiling.
    expect(logRecord['durationMs']).toBeLessThan(5000);
  });
});

// =============================================================================
// withTransaction<T>()
// =============================================================================

describe('withTransaction<T>()', () => {
  it('executes BEGIN, the callback, and COMMIT in order on success', async () => {
    mockPool._client.query.mockImplementation((arg: unknown) => {
      // BEGIN, COMMIT, and the callback's mid-transaction queries all
      // resolve with an empty result. The mock's call log is what the
      // assertions below inspect.
      void arg;
      return Promise.resolve(mockQueryResult([]));
    });

    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO orders (user_id) VALUES ($1)', ['uid-1']);
      return 'callback-return-value';
    });

    expect(result).toBe('callback-return-value');

    // Verify the call sequence: BEGIN, INSERT, COMMIT.
    const calls = mockPool._client.query.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toBe('BEGIN');
    expect(calls[1]?.[0]).toBe('INSERT INTO orders (user_id) VALUES ($1)');
    expect(calls[2]?.[0]).toBe('COMMIT');
  });

  it('passes the EXACT acquired PoolClient to the callback', async () => {
    mockPool._client.query.mockResolvedValue(mockQueryResult([]));

    let receivedClient: PoolClient | null = null;
    await withTransaction(async (client) => {
      receivedClient = client;
    });

    // Reference-equality: the callback must receive the same client
    // instance that BEGIN/COMMIT were issued against.
    expect(receivedClient).toBe(mockPool._client);
  });

  it('releases the client to the pool after a successful transaction', async () => {
    mockPool._client.query.mockResolvedValue(mockQueryResult([]));

    await withTransaction(async () => {
      // No-op callback — happy path verifies release on success.
    });

    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
    // No error argument: `release()` is called with zero args so pg
    // does NOT discard the client (preserves the TCP setup for
    // future requests).
    expect(mockPool._client.release).toHaveBeenCalledWith();
  });

  it('issues ROLLBACK and re-throws the original callback error', async () => {
    const callbackError = new Error('business rule violated');

    mockPool._client.query.mockImplementation((arg: unknown) => {
      // BEGIN succeeds; ROLLBACK succeeds; the callback's own
      // statements would never run (callback throws synchronously).
      void arg;
      return Promise.resolve(mockQueryResult([]));
    });

    await expect(
      withTransaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    const calls = mockPool._client.query.mock.calls;
    // BEGIN then ROLLBACK; no COMMIT.
    expect(calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    // Client released even on error.
    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
    // No db.transaction.rollback.failed log because ROLLBACK succeeded.
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('issues ROLLBACK when the callback rejects with a PG error', async () => {
    const pgError = Object.assign(new Error('foreign key violation'), {
      code: '23503',
    });

    mockPool._client.query
      .mockResolvedValueOnce(mockQueryResult([])) // BEGIN
      .mockRejectedValueOnce(pgError) // INSERT inside callback
      .mockResolvedValueOnce(mockQueryResult([])); // ROLLBACK

    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO order_items (order_id) VALUES ($1)', ['orphan']);
      }),
    ).rejects.toBe(pgError);

    const calls = mockPool._client.query.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      'BEGIN',
      'INSERT INTO order_items (order_id) VALUES ($1)',
      'ROLLBACK',
    ]);
    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
  });

  it('propagates BEGIN failures and still releases the client', async () => {
    const beginError = new Error('cannot start transaction');

    mockPool._client.query.mockImplementation((arg: unknown) => {
      if (arg === 'BEGIN') {
        return Promise.reject(beginError);
      }
      // ROLLBACK against a never-started transaction is harmless.
      return Promise.resolve(mockQueryResult([]));
    });

    const callbackSpy = jest.fn();

    await expect(
      withTransaction(async (client) => {
        callbackSpy();
        await client.query('SELECT 1');
      }),
    ).rejects.toBe(beginError);

    // Callback was never invoked because BEGIN failed.
    expect(callbackSpy).not.toHaveBeenCalled();
    // Client still released via finally.
    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
  });

  it('propagates COMMIT failures and still releases the client', async () => {
    const commitError = new Error('serialization failure');

    mockPool._client.query.mockImplementation((arg: unknown) => {
      if (arg === 'COMMIT') {
        return Promise.reject(commitError);
      }
      return Promise.resolve(mockQueryResult([]));
    });

    await expect(
      withTransaction(async (client) => {
        await client.query('UPDATE orders SET state = $1', ['finalized']);
      }),
    ).rejects.toBe(commitError);

    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the ORIGINAL callback error when ROLLBACK also fails', async () => {
    const callbackError = new Error('business rule violated');
    const rollbackError = new Error('connection terminated mid-rollback');

    mockPool._client.query.mockImplementation((arg: unknown) => {
      if (arg === 'BEGIN') return Promise.resolve(mockQueryResult([]));
      if (arg === 'ROLLBACK') return Promise.reject(rollbackError);
      return Promise.resolve(mockQueryResult([]));
    });

    // The callback rejects FIRST, then ROLLBACK fails — the caller
    // must still see the ORIGINAL callbackError, not the rollbackError.
    // This is the canonical pg idiom and the most operationally
    // important property of the helper.
    await expect(
      withTransaction(async () => {
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    // The rollback failure is logged (so operators see it), but is NOT
    // re-thrown.
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logRecord, message] = loggerErrorMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(logRecord).toMatchObject({
      event: 'db.transaction.rollback.failed',
      err: rollbackError,
    });
    expect(message).toBe('ROLLBACK failed after transaction error');

    // Client still released — never leak even when rollback fails.
    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
  });

  it('preserves the COMMIT error when ROLLBACK after a failed COMMIT also fails', async () => {
    // Edge case: COMMIT fails (e.g. serialization failure), pg's
    // implementation lets us attempt ROLLBACK as a cleanup, and that
    // ROLLBACK also fails (e.g. socket already torn down). The original
    // COMMIT error must be the one the caller sees.
    const commitError = new Error('serialization failure');
    const rollbackError = new Error('socket closed');

    mockPool._client.query.mockImplementation((arg: unknown) => {
      if (arg === 'BEGIN') return Promise.resolve(mockQueryResult([]));
      if (arg === 'COMMIT') return Promise.reject(commitError);
      if (arg === 'ROLLBACK') return Promise.reject(rollbackError);
      return Promise.resolve(mockQueryResult([]));
    });

    await expect(
      withTransaction(async (client) => {
        await client.query('UPDATE orders SET state = $1', ['finalized']);
      }),
    ).rejects.toBe(commitError);

    // The rollback-failed log was emitted.
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logRecord] = loggerErrorMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(logRecord).toMatchObject({
      event: 'db.transaction.rollback.failed',
      err: rollbackError,
    });

    // Client still released.
    expect(mockPool._client.release).toHaveBeenCalledTimes(1);
  });

  it('returns the callback value verbatim (preserving generic type T)', async () => {
    mockPool._client.query.mockResolvedValue(mockQueryResult([]));

    interface OrderResult {
      id: string;
      createdAt: Date;
    }
    const expected: OrderResult = {
      id: 'order-42',
      createdAt: new Date('2026-04-27T00:00:00Z'),
    };

    const actual = await withTransaction<OrderResult>(async () => expected);

    expect(actual).toBe(expected);
  });

  it('does NOT leak credential-shaped strings from callback rejections to log records (Rule R2)', async () => {
    // Even if the callback rejects with an error whose MESSAGE contains
    // a sentinel credential, the rollback-failed log should never be
    // emitted on the success path. This tests the negative case: a
    // successful rollback after a credential-laden callback error.
    const credLeakingError = new Error('failed to insert user with password=SENTINEL_CRED_99');

    mockPool._client.query.mockResolvedValue(mockQueryResult([]));

    await expect(
      withTransaction(async () => {
        throw credLeakingError;
      }),
    ).rejects.toBe(credLeakingError);

    // No db.transaction.rollback.failed log because ROLLBACK succeeded.
    expect(loggerErrorMock).not.toHaveBeenCalled();

    // The credential never reached a log record because no log record
    // was emitted. (If callback errors WERE logged here, the sentinel
    // could leak — proving the helper's restraint is operationally
    // important.)
  });

  it('propagates a connect() failure without invoking BEGIN or the callback', async () => {
    const connectError = new Error('pool exhausted');
    (mockPool.connect as jest.Mock).mockRejectedValueOnce(connectError);
    const callbackSpy = jest.fn();

    await expect(
      withTransaction(async () => {
        callbackSpy();
      }),
    ).rejects.toBe(connectError);

    // BEGIN never issued because we never got a client.
    expect(mockPool._client.query).not.toHaveBeenCalled();
    expect(callbackSpy).not.toHaveBeenCalled();
    // No client to release.
    expect(mockPool._client.release).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Cross-cutting Rule R2 sentinel sweep
// =============================================================================

describe('Rule R2 — credential sentinel sweep across the full module surface', () => {
  it('never includes the sentinel credential in any log record from query()', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('boom'));
    await expect(
      query('INSERT INTO users (password) VALUES ($1)', ['SENTINEL_CRED_99']),
    ).rejects.toThrow('boom');

    for (const call of loggerErrorMock.mock.calls) {
      const payload = JSON.stringify(call, (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      );
      expect(payload).not.toContain('SENTINEL_CRED_99');
    }
  });

  it('never includes the sentinel credential in any log record from withTransaction()', async () => {
    // Force ROLLBACK to fail so the only log record path inside
    // withTransaction is exercised. Critically, even though the
    // callback's parameters carry a credential sentinel, the helper
    // must NOT include them in any emitted record.
    mockPool._client.query.mockImplementation((arg: unknown) => {
      if (arg === 'BEGIN') return Promise.resolve(mockQueryResult([]));
      if (arg === 'ROLLBACK') return Promise.reject(new Error('rollback boom'));
      return Promise.resolve(mockQueryResult([]));
    });

    const callbackError = new Error('callback failed');
    await expect(
      withTransaction(async (client) => {
        // The credential flows into pg.query as a param value; the
        // helper must not capture or log it.
        await client.query('INSERT INTO users (password) VALUES ($1)', ['SENTINEL_CRED_99']);
        throw callbackError;
      }),
    ).rejects.toBe(callbackError);

    for (const call of loggerErrorMock.mock.calls) {
      const payload = JSON.stringify(call, (_key, value: unknown) =>
        value instanceof Error
          ? { name: value.name, message: value.message, stack: value.stack }
          : value,
      );
      expect(payload).not.toContain('SENTINEL_CRED_99');
    }
  });
});
