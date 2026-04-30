/**
 * Unit tests for `backend/src/routes/health.ts` — ST-048 (AC3, AC4, AC5).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *   - Story ST-048 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC3: "Each service exposes a liveness probe endpoint that returns a
 *             documented success status when the process is running and a
 *             documented failure status when the process has entered a
 *             non-recoverable state."
 *
 *       AC4: "Each service exposes a readiness probe endpoint, distinct
 *             from the liveness probe, that returns a documented success
 *             status only when the service is prepared to accept traffic
 *             (dependencies reachable, warm-up complete) and a documented
 *             failure status otherwise."
 *
 *       AC5: "The metrics endpoint and both probe endpoints can be reached
 *             and interpreted in the local development environment without
 *             any cloud access, and the expected responses are documented
 *             alongside the endpoints."
 *
 *   - Story ST-043 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC3: "A failing assertion, a test exception, or a coverage
 *             percentage below the documented threshold produces a failed
 *             verdict; the suite is deterministic, so repeated runs against
 *             the same source tree produce the same verdict."
 *
 *       AC4: "The suite runs in the local development environment without
 *             any additional services or network access beyond the standard
 *             local toolchain."
 *
 *   - AAP §0.6.5 Track 1 Gate T1-D verification (verbatim from user prompt):
 *
 *         curl -sf localhost:3000/readyz | jq -r '.status'   # expected: ready
 *         docker compose stop postgres && sleep 3;
 *         curl -s -o /dev/null -w "%{http_code}" \
 *             http://localhost:3000/readyz                   # expected: 503
 *
 *     The two assertions in `describe('GET /readyz — Gate T1-D ...')` below
 *     mirror these two shell commands exactly: one for "DB up → 200 ready"
 *     and one for "DB down → 503". A unit test cannot simulate a real
 *     `docker compose stop`, but mocking `pool.query` to reject is
 *     functionally equivalent at this layer of the stack — the route's
 *     dependency on the DB is exclusively through `pool.query`.
 *
 *   - AAP §0.7.1 "Exhaustively In Scope":
 *         backend/src co-located *.test.ts files (per ST-043)
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * Liveness probe (GET /healthz, ST-048-AC3):
 *   1. Returns HTTP 200 with body exactly `{ status: 'ok' }` whenever the
 *      Express loop is alive — there is no failure mode that a unit test
 *      can exercise short of process termination, so we assert the
 *      success path under three different pool states (idle / rejecting /
 *      resolving) to prove the handler is independent of the pool.
 *   2. The handler does NOT call `pool.query` — verified by checking that
 *      the jest.fn() mock was never invoked. Calling the DB on a liveness
 *      probe would couple pod restarts to transient DB hiccups (a known
 *      anti-pattern documented in `health.ts`).
 *   3. The handler responds well under any reasonable runtime timing
 *      bound — a sanity check that no I/O has crept into the path.
 *
 * Readiness probe (GET /readyz, ST-048-AC4):
 *   4. Returns HTTP 200 with body exactly `{ status: 'ready' }` when
 *      `pool.query` resolves successfully.
 *   5. Returns HTTP 503 with body exactly `{ status: 'not_ready' }` when
 *      `pool.query` rejects. Notably, the body MUST NOT contain raw
 *      infrastructure tokens (host, port, error code) — leaking those
 *      would (a) violate Rule R2's no-credential-material posture by
 *      revealing connection-topology info, and (b) hand an attacker a
 *      free reconnaissance vector.
 *   6. Returns HTTP 503 within a bounded time when `pool.query` never
 *      resolves (simulated by `new Promise(() => {})`). The route's
 *      `READYZ_DB_TIMEOUT_MS` (3 s) ensures Cloud Run's own probe timeout
 *      (default 4 s) is not the first to trip — the route's clean 503
 *      surfaces in dashboards instead of socket-reset noise.
 *   7. The query issued is a parameterless `SELECT 1`, NEVER an
 *      application-table query. This decouples readiness from schema
 *      state (so a migration cannot accidentally take a replica off-line)
 *      and keeps the round-trip in single-digit milliseconds.
 *   8. Gate T1-D's two CLI verifications (DB up → 200 ready;
 *      DB down → 503) are mirrored at the unit level.
 *
 * Factory contract (`createHealthRoutes`):
 *   9. Returns a value that is callable as Express middleware (the
 *      `express.Router()` factory itself returns a function). The
 *      composition root in `backend/src/index.ts` mounts the returned
 *      router via `app.use(router)` at the application root — NOT under
 *      `/api` — to match the conventional probe paths expected by Cloud
 *      Run / Kubernetes.
 *  10. Throws synchronously when `deps` is null/undefined, when
 *      `deps.pool` is null/undefined, or when `deps.pool.query` is not a
 *      function. A misconfigured composition root is a bootstrap-time
 *      defect; surfacing it loudly at startup (rather than silently as
 *      a 500 on the first probe in production) is a Rule R8
 *      ("gates fail closed") posture extended to bootstrap.
 *  11. Two factory calls with two different pool stubs return two
 *      distinct router instances — verifying the factory produces no
 *      hidden module-level singleton state.
 *
 * ============================================================================
 * Determinism (ST-043-AC3)
 * ============================================================================
 *   - The Jest config (`backend/jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, and `restoreMocks` to `true`, so every `jest.fn()`
 *     installed in `beforeEach` is wiped between tests automatically.
 *   - No fake timers are used. The bounded-timeout test exercises the
 *     route's REAL `setTimeout` path against a real `Promise.race`; using
 *     fake timers would short-circuit the very behaviour being verified.
 *   - The bounded-timeout test allots a generous Jest per-test budget
 *     (15 s) that comfortably exceeds the route's 3 s timeout plus
 *     supertest's 10 s outer timeout — flake-free under load.
 *   - Latency assertions use generous (200 ms) upper bounds calibrated
 *     for cold-start CI runners, not optimistic local laptops.
 *
 * ============================================================================
 * Locality (ST-043-AC4)
 * ============================================================================
 *   - Zero network calls. `supertest(app)` drives the Express app via an
 *     in-memory ephemeral-port loopback that supertest manages
 *     internally; no DNS, no external host, no cloud access.
 *   - Zero file-system access. The route reads no files; the test reads
 *     no fixtures from disk.
 *   - Zero environment-variable reads. The route's only env-var
 *     consumers (`READYZ_DB_TIMEOUT_MS`, `MAX_LOGGED_ERROR_MESSAGE_LENGTH`)
 *     are file-local module constants, not env-driven.
 *
 * @see backend/src/routes/health.ts — module under test
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-048-metrics-endpoint-health-readiness-probes.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// `express` is imported as a runtime default — the test invokes
// `express()` to construct an in-memory Express application that mounts
// the router under test. Supertest's `request` is also a runtime default
// (the package's primary export). Both packages declare these defaults
// via CommonJS's `module.exports = ...`, and the project's
// `esModuleInterop: true` compiler option (see `backend/tsconfig.json`)
// makes the `import x from 'y'` form resolve to `module.exports` under
// the hood.
//
// `pg`'s `Pool` is type-only — never instantiated in this file — so it
// is imported via `import type` to satisfy the workspace's
// `@typescript-eslint/consistent-type-imports` rule (see
// `.eslintrc.json`). The actual `Pool` instance is replaced by a minimal
// jest.fn-backed shim through a double-cast described in `buildApp`
// below.
//
// `createHealthRoutes` is the subject under test, imported as a named
// runtime export from the sibling `./health` module.

import express from 'express';
import request from 'supertest';

import type { Pool } from 'pg';

import { createHealthRoutes } from './health';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal `pg.Pool`-shaped object for unit tests.
 *
 * The route under test exercises ONLY `pool.query` — no transactions,
 * no `pool.connect()`, no listen/notify, no event-emitter API. A
 * single `query` member typed as `jest.Mock` is therefore both
 * necessary and sufficient.
 *
 * The object is structurally compatible with the `Pool` interface for
 * the call-sites in `health.ts` (`pool.query('SELECT 1')`), but is NOT
 * a nominal `Pool` instance — TypeScript's structural typing accepts
 * the shim through the `as unknown as Pool` double-cast in
 * `buildApp` below.
 *
 * ESLint's `@typescript-eslint/no-explicit-any` rule is disabled for
 * test files (see `.eslintrc.json` overrides), so the variadic `any`
 * arrays in the jest.Mock generic are acceptable here. The mock's
 * argument types are still narrowed at call-sites by the
 * `pool.query(...)` invocation in `health.ts` itself.
 */
type PoolMock = {
  query: jest.Mock;
};

/**
 * Construct a fresh `PoolMock` for each test.
 *
 * Centralising the construction in a helper keeps every test's
 * `beforeEach` block to a single line and ensures every test starts
 * from the same baseline (a `jest.fn()` with no implementation, no
 * recorded calls, no resolved/rejected behaviour). Per the global
 * `clearMocks: true` / `resetMocks: true` setting in
 * `jest.config.unit.ts`, the mock state is also wiped between tests
 * by the Jest runtime itself — the helper's role is to provide a
 * fresh REFERENCE per test, which is what guarantees the factory
 * tests below can compare two independent pool instances.
 */
function buildPool(): PoolMock {
  return {
    query: jest.fn(),
  };
}

/**
 * Construct an Express app with the health router mounted at the
 * application root.
 *
 * The route under test mounts `/healthz` and `/readyz` directly on its
 * own router (no `/api` prefix); the composition root in
 * `backend/src/index.ts` mounts the returned router at the app root via
 * `app.use(healthRouter)`. This helper mirrors that production wiring
 * exactly so the supertest-driven HTTP requests below hit the same
 * paths the orchestrator (Cloud Run / Kubernetes) probes use in
 * production.
 *
 * The `as unknown as Pool` double-cast bridges the structural-vs-
 * nominal type gap: TypeScript's `pg.Pool` has dozens of members the
 * mock does not implement, but the route under test consumes only the
 * `query` member. The cast is the canonical pattern for this scenario
 * (see `node_modules/@types/jest` documentation on substituting
 * minimal mocks for richer interfaces).
 */
function buildApp(pool: PoolMock): express.Express {
  const app = express();
  // `as unknown as Pool` — see helper-doc above.
  const router = createHealthRoutes({ pool: pool as unknown as Pool });
  app.use(router);
  return app;
}

// ---------------------------------------------------------------------------
// GET /healthz — ST-048-AC3 (liveness)
// ---------------------------------------------------------------------------

describe('GET /healthz — ST-048-AC3 (liveness)', () => {
  let pool: PoolMock;
  let app: express.Express;

  beforeEach(() => {
    pool = buildPool();
    app = buildApp(pool);
  });

  it('returns 200 with the documented success body { status: "ok" }', async () => {
    // The success-path assertion mirrors AC3 verbatim: "returns a
    // documented success status when the process is running". The
    // body shape is the documented contract — supertest parses the
    // JSON response automatically (the route uses `res.json(...)`,
    // which sets Content-Type: application/json).
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does NOT query the database (liveness is process-presence only)', async () => {
    // Liveness probe MUST NOT call `pool.query`. A liveness probe that
    // depended on the DB would convert every transient DB hiccup
    // (network blip, brief PostgreSQL restart, connection-pool
    // exhaustion) into a pod restart, producing a death-spiral the
    // moment any downstream blip occurs. The fix is architectural —
    // the liveness handler must be DB-independent — and this test
    // pins that invariant.
    await request(app).get('/healthz');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 200 even when the pool is degraded (liveness ≠ readiness)', async () => {
    // Defence-in-depth: even if a future refactor accidentally wired
    // the pool into the liveness handler, this test would catch the
    // regression — when the pool is wired up to reject every query,
    // the liveness handler must still respond 200. The whole point of
    // the liveness/readiness split is that liveness must NEVER reflect
    // downstream-dependency state.
    pool.query.mockRejectedValue(new Error('connection refused'));
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('responds quickly because no I/O is involved', async () => {
    // Unit-level latency assertion — not a perf test, just a smoke
    // signal that no hidden I/O has crept into the liveness path.
    // 200 ms is a generous upper bound calibrated for cold-start
    // CI runners; a clean liveness round-trip on any modern machine
    // completes well under 50 ms. Anything slower than 200 ms in a
    // unit test indicates a real problem (an awaited DB call, an
    // unawaited event-loop block, etc.) worth investigating.
    const start = Date.now();
    await request(app).get('/healthz');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// GET /readyz — ST-048-AC4 (readiness)
// ---------------------------------------------------------------------------

describe('GET /readyz — ST-048-AC4 (readiness)', () => {
  let pool: PoolMock;
  let app: express.Express;

  beforeEach(() => {
    pool = buildPool();
    app = buildApp(pool);
  });

  it('returns 200 with { status: "ready" } when pool.query resolves', async () => {
    // The DB-up success path — the route awaits `pool.query('SELECT 1')`
    // and, on resolution, returns 200 with the documented body shape.
    // The mock's resolved value mirrors what `pg` would actually
    // return for `SELECT 1`: a single-row result with one nameless
    // column. The route does NOT inspect the row contents (it only
    // cares THAT the query resolved), so any plausible result shape
    // is acceptable here.
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('returns 503 with { status: "not_ready" } when pool.query rejects', async () => {
    // The DB-down failure path — when `pool.query` rejects, the route
    // must return 503 with the documented `not_ready` body. Critically,
    // the body must not echo the raw pg error message; doing so would
    // leak connection-topology info (host, port, error class) to less-
    // trusted clients. We assert the absence of every infrastructure
    // token the rejected error contains.
    pool.query.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:5432'));
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  });

  it('does NOT leak raw pg error tokens (host/port/code) into the response body', async () => {
    // Defence-in-depth on the previous test: even if a future refactor
    // changes the body shape (e.g. adds a diagnostic field), the
    // serialised body must NEVER contain the connection-topology
    // tokens that pg surfaces in error messages. R2 applies even to
    // operational text — an attacker hitting `/readyz` against an
    // exposed instance must not be able to glean the DB host/port
    // from the response.
    pool.query.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:5432'));
    const res = await request(app).get('/readyz');
    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain('econnrefused');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('5432');
  });

  it('returns 503 within a bounded time when pool.query hangs forever', async () => {
    // Bounded-timeout invariant — the route's `READYZ_DB_TIMEOUT_MS`
    // (3 s) ensures Cloud Run's default probe timeout (4 s) is NOT
    // the first to trip when the DB is hung.
    //
    // We simulate the hang with a never-resolving promise. The
    // route's `Promise.race` against its internal `setTimeout`
    // guarantees the request resolves with 503 after ~3 s.
    // Supertest's outer timeout of 10 s leaves ample headroom; the
    // Jest per-test budget of 15 s leaves further headroom against
    // CI scheduling jitter.
    pool.query.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Intentionally never resolves — simulates a hung DB.
        }),
    );
    const res = await request(app).get('/readyz').timeout(10_000);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  }, 15_000);

  it('issues a lightweight `SELECT 1` query (parameterless, schema-independent)', async () => {
    // The choice of `SELECT 1` for readiness is architectural: it
    // avoids coupling the probe to schema state (so a migration
    // cannot inadvertently take a replica off-line) and stays inside
    // the platform's probe timeout (the round-trip is a few
    // milliseconds, parameterless, and plan-cached).
    //
    // The route may pass the query as a string (`pool.query('SELECT 1')`)
    // or as a config object (`pool.query({ text: 'SELECT 1' })`); both
    // forms are valid pg API. The assertion normalises whitespace and
    // upper-cases before comparing so either form passes.
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    await request(app).get('/readyz');
    expect(pool.query).toHaveBeenCalledTimes(1);

    const callArg: unknown = pool.query.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    const queryText: string =
      typeof callArg === 'string' ? callArg : (callArg as { text: string }).text;
    expect(queryText.replace(/\s+/g, ' ').trim().toUpperCase()).toMatch(/^SELECT 1$/);
  });

  it('does NOT pass values to pool.query (parameterless contract)', async () => {
    // Sister assertion to the previous test: not only is the query
    // text `SELECT 1`, but the call is also parameterless. Passing
    // unused values would (a) cost a small amount of pg parsing work
    // and (b) hint that the readiness contract had drifted toward an
    // application-specific check.
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    await request(app).get('/readyz');
    const callArgs = pool.query.mock.calls[0];
    expect(callArgs).toBeDefined();
    // Either `pool.query('SELECT 1')` (single string arg) or
    // `pool.query({ text: 'SELECT 1' })` (single object arg) is fine.
    // What matters is that no second `values` argument is passed.
    if (callArgs && callArgs.length > 1) {
      // If a second argument is passed at all, it must be undefined.
      expect(callArgs[1]).toBeUndefined();
    }
  });

  describe('Gate T1-D verification (per AAP §0.6.5)', () => {
    // These two tests mirror the user prompt's verbatim Gate T1-D
    // shell commands at the unit level. A real Gate T1-D run uses
    // `docker compose stop postgres` to take the DB offline; at the
    // unit level, the equivalent is `pool.query.mockRejectedValueOnce`.

    it('"DB up → status: ready" — curl -sf localhost:3000/readyz | jq -r ".status" → ready', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const res = await request(app).get('/readyz');
      expect(res.body.status).toBe('ready');
    });

    it('"DB down → 503" — docker compose stop postgres; curl -w "%{http_code}" → 503', async () => {
      pool.query.mockRejectedValueOnce(new Error('connection refused'));
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
    });
  });

  it('returns 503 only on rejection, not on unusual but resolved results', async () => {
    // Documents the actual contract: the route checks whether
    // `pool.query` RESOLVED (it does NOT inspect `rowCount` or
    // `rows.length`). An empty result set therefore still produces a
    // 200 ready response.
    //
    // This is a deliberate design choice (and is documented in the
    // route's comments): a resolved promise from `pool.query` proves
    // the connection is alive and the server responded, which is
    // exactly what the readiness contract asks. Inspecting the row
    // shape would couple the probe to PostgreSQL's specific behaviour
    // for `SELECT 1` — a coupling not worth the marginal extra signal.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('does NOT propagate the pool error as an unhandled rejection', async () => {
    // Late-rejection containment — `pool.query` may reject AFTER the
    // route's timeout has already won the race. The route attaches a
    // `.then(_, onRejected)` handler that captures the error and
    // resolves to `false`, ensuring `Promise.race` never sees a raw
    // rejection and Node's `unhandledRejection` mode never fires.
    //
    // The smoke test here: a pool rejection produces a clean 503
    // (not a 500 from Express's central error handler, and not a
    // process termination from `unhandledRejection` mode). If the
    // rejection escaped the worker, the route would invoke `next(err)`
    // and Express would either return a 500 with a stack trace or, in
    // extreme cases, terminate the process — both observable as a
    // non-503 response here.
    pool.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });
});

// ---------------------------------------------------------------------------
// GET /readyz — operational logging contract
// ---------------------------------------------------------------------------
//
// The route emits a single bounded WARN log record on every readiness
// failure (via `logReadinessFailure`). The log record is the operator-
// facing diagnostic that powers the dashboard panel "readiness failures
// per minute" referenced in `docs/observability/dashboard-template.md`
// (per ST-049-AC5). These tests verify that the log record:
//
//   - is emitted when the request has a `req.log` attached,
//   - is silently skipped when `req.log` is absent (no throw),
//   - carries the documented payload shape (`event`, `errorName`,
//     `errorMessage`),
//   - bounds the error message at the source-file's documented cap
//     (`MAX_LOGGED_ERROR_MESSAGE_LENGTH = 200`).
//
// To inject a logger into the per-request scope, we mount a small
// middleware BEFORE the health router that attaches a `jest.fn()`-
// backed `log.warn` to the request object. That mirrors the
// production wiring (where `pino-http` attaches a request-scoped
// logger), but with a deterministic mock the test can assert against.

describe('GET /readyz — operational logging (Rule R2 + ST-049 dashboard)', () => {
  let pool: PoolMock;
  let app: express.Express;
  let warnSpy: jest.Mock;

  beforeEach(() => {
    pool = buildPool();
    warnSpy = jest.fn();
    app = express();
    // Inject a request-scoped logger ahead of the health router. In
    // production, `pino-http` does this; here, a one-line middleware
    // is sufficient to exercise the logger-present code path.
    app.use((req, _res, next) => {
      // The route reads `req.log.warn`; the structural cast in
      // `health.ts` accepts any object with that method shape.
      (req as unknown as { log: { warn: jest.Mock } }).log = { warn: warnSpy };
      next();
    });
    app.use(createHealthRoutes({ pool: pool as unknown as Pool }));
  });

  it('emits a single WARN log record on readiness failure', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    await request(app).get('/readyz');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('log payload includes event, errorName, errorMessage; second arg is human message', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    await request(app).get('/readyz');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toEqual(
      expect.objectContaining({
        event: 'health.readiness.failure',
        errorName: 'Error',
        errorMessage: 'connection refused',
      }),
    );
    expect(message).toBe('readiness probe failed');
  });

  it('log payload truncates oversized error messages defensively', async () => {
    // The source file caps `errorMessage` at 200 characters
    // (`MAX_LOGGED_ERROR_MESSAGE_LENGTH`). A rogue error message
    // larger than the cap must be sliced — this protects log storage
    // cost and prevents downstream log-line truncation from masking
    // other records. The test uses a 1024-char message to be well
    // beyond the cap, then asserts that the recorded message is
    // exactly 200 chars long and is a prefix of the original.
    const HUGE_LENGTH = 1024;
    const CAP = 200;
    const hugeMessage = 'x'.repeat(HUGE_LENGTH);
    pool.query.mockRejectedValueOnce(new Error(hugeMessage));
    await request(app).get('/readyz');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    const recordedMessage = payload.errorMessage;
    expect(typeof recordedMessage).toBe('string');
    expect((recordedMessage as string).length).toBe(CAP);
    expect(hugeMessage.startsWith(recordedMessage as string)).toBe(true);
  });

  it('log is NOT emitted on the readiness SUCCESS path (no spurious noise)', async () => {
    // Success path emits no log record — the dashboard panel counts
    // FAILURES, so any success-path emission would inflate the
    // failure counter. Verifying the negative path here pins that
    // contract at the unit level.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await request(app).get('/readyz');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('handles non-Error rejection values without throwing (defensive extraction)', async () => {
    // pg's older code paths and userland middlewares may reject with
    // strings, plain objects, or null. The route's
    // `logReadinessFailure` uses optional chaining + narrow type
    // assertions so every access is a no-throw — the test exercises
    // the string-rejection path here. Critically, the response is
    // STILL a clean 503 (the logging defect must never bubble up
    // to the response layer).
    pool.query.mockRejectedValueOnce('rejected with a plain string');
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
    // The logger is still called — but errorName/errorMessage may be
    // undefined since strings don't have `.name` or `.message`.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toEqual(expect.objectContaining({ event: 'health.readiness.failure' }));
  });

  it('handles null rejection values without throwing', async () => {
    // Edge case: a userland middleware rejects with `null`. The
    // route's defensive extraction must treat this without throwing
    // and must still produce a clean 503 response.
    //
    // Note on observable behaviour: the worker's `capturedDbError`
    // sentinel is initialised to `null`, so a rejection-with-null
    // is INDISTINGUISHABLE from "no error captured yet" (i.e. a
    // timeout). The route therefore substitutes its synthetic
    // `Error('readiness check timed out')` for the log record. This
    // is a deliberate design simplification documented in the
    // route's comments — the response body is identical for both
    // failure modes (`{ status: 'not_ready' }`), so operators rely
    // on the LOG to distinguish them. A null-rejection is rare
    // enough in practice that conflating it with timeout is
    // acceptable.
    pool.query.mockRejectedValueOnce(null);
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload.event).toBe('health.readiness.failure');
  });

  it('logs a synthetic timeout error when the DB query never resolves', async () => {
    // When the timeout wins the race (pool.query never settled), the
    // worker constructs a synthetic Error with the documented
    // message "readiness check timed out" and feeds it to
    // `logReadinessFailure`. The unit test verifies that the log
    // record carries this synthetic message — operators rely on it
    // to distinguish "DB rejected" from "DB hung" in dashboards.
    pool.query.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Never resolves — simulates a hung DB.
        }),
    );
    const res = await request(app).get('/readyz').timeout(10_000);
    expect(res.status).toBe(503);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload.event).toBe('health.readiness.failure');
    expect(payload.errorMessage).toBe('readiness check timed out');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// createHealthRoutes — factory contract
// ---------------------------------------------------------------------------

describe('createHealthRoutes — factory contract', () => {
  it('returns a callable Express router', () => {
    // `express.Router()` returns a function (the router IS its own
    // request handler — `app.use(router)` works because `router` is
    // callable as `(req, res, next)`). `typeof router === 'function'`
    // is therefore the appropriate structural assertion.
    const router = createHealthRoutes({ pool: buildPool() as unknown as Pool });
    expect(typeof router).toBe('function');
  });

  it('throws synchronously when the deps object itself is null', () => {
    // A null `deps` object is a composition-root bug — the bootstrap
    // failed to construct the dependencies. Surfacing it as a
    // synchronous throw at startup (vs. a 500 on the first probe in
    // production) is the Rule R8 fail-closed posture extended to
    // bootstrap.
    expect(() => createHealthRoutes(null as unknown as { pool: Pool })).toThrow();
  });

  it('throws synchronously when the deps object itself is undefined', () => {
    // Symmetric to the null case — TypeScript permits `undefined` in
    // many call-sites where it does not permit `null`, so we cover
    // both explicitly.
    expect(() => createHealthRoutes(undefined as unknown as { pool: Pool })).toThrow();
  });

  it('throws synchronously when deps.pool is missing (empty object)', () => {
    // This is the most likely real-world failure mode — a developer
    // wires the factory with `createHealthRoutes({})` having forgotten
    // to pass the pool. The throw must surface immediately, with a
    // descriptive message that points at the missing dependency.
    expect(() => createHealthRoutes({} as unknown as { pool: Pool })).toThrow();
  });

  it('throws synchronously when deps.pool is null', () => {
    // Defensive: null is structurally a valid value for an optional
    // property at TypeScript's type level under some configurations,
    // but it is never a valid runtime pool — so we throw.
    expect(() => createHealthRoutes({ pool: null } as unknown as { pool: Pool })).toThrow();
  });

  it('throws synchronously when deps.pool exists but pool.query is not a function', () => {
    // Tighter validation — the route depends on `pool.query` being
    // callable. A pool object missing `query` (or with a non-function
    // `query` member) would crash on the first `/readyz` request with
    // a confusing TypeError; throwing at factory time produces a
    // clear, immediate error message instead.
    const malformedPool = { query: 'not a function' };
    expect(() =>
      createHealthRoutes({ pool: malformedPool } as unknown as { pool: Pool }),
    ).toThrow();
  });

  it('factory is a pure function — two calls produce two distinct router instances', () => {
    // No hidden module-level singleton: each `createHealthRoutes`
    // invocation returns its own router. This matters because Express
    // routers are stateful (they own a stack of middleware and route
    // handlers); a hidden singleton would cause cross-test contamination
    // in the broader test suite and would prevent multiple Express
    // apps from being composed in the same process (which integration
    // tests routinely do).
    const p1 = buildPool();
    const p2 = buildPool();
    const r1 = createHealthRoutes({ pool: p1 as unknown as Pool });
    const r2 = createHealthRoutes({ pool: p2 as unknown as Pool });
    expect(r1).not.toBe(r2);
  });

  it('two factory instances do not share routing state', async () => {
    // Sister assertion to the previous test: not just distinct
    // references, but distinct routing tables. We mount each router
    // on its own Express app and verify each app behaves
    // independently. Crucially, after exercising r1's `/readyz`
    // route, r2's pool.query MUST still report zero invocations —
    // proving the two routers do not share any backing state.
    const p1 = buildPool();
    const p2 = buildPool();
    const r1 = createHealthRoutes({ pool: p1 as unknown as Pool });
    const r2 = createHealthRoutes({ pool: p2 as unknown as Pool });

    const app1 = express();
    const app2 = express();
    app1.use(r1);
    app2.use(r2);

    p1.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await request(app1).get('/readyz');

    expect(p1.query).toHaveBeenCalledTimes(1);
    expect(p2.query).not.toHaveBeenCalled();
  });
});
