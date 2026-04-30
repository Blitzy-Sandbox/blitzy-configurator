/**
 * Unit tests for `backend/src/routes/cart.ts` — ST-033
 * (Retrieve Current Cart for Authenticated User).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-033 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "The retrieval endpoint requires a valid session and returns
 *             only the cart belonging to the authenticated user, never
 *             cart data belonging to other users."
 *
 *       AC2: "The response includes each cart line item with quantity,
 *             referenced design identifier, and any per-item metadata
 *             required to render the cart, along with a calculated
 *             subtotal."
 *
 *       AC3: "When the authenticated user has no active cart, the
 *             endpoint returns an empty cart representation with a
 *             success status rather than a not-found error."
 *
 *       AC4: "The endpoint does not create, mutate, or finalize the cart
 *             and is safe to call repeatedly from the client without
 *             side effects."
 *
 *   - Story ST-043 acceptance criteria (Rule R1):
 *       AC3: "A failing assertion, a test exception, or a coverage
 *             percentage below the documented threshold produces a
 *             failed verdict; the suite is deterministic."
 *       AC4: "The suite runs in the local development environment
 *             without any additional services or network access beyond
 *             the standard local toolchain."
 *
 *   - AAP §0.7.1: backend co-located *.test.ts files are in scope.
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * Factory wiring:
 *   1. `createCartRoutes` returns a usable Express Router that mounts a
 *      single `GET /` handler.
 *   2. The factory throws when `deps` is missing or non-object.
 *   3. The factory throws when `deps.orderService` is missing.
 *   4. The factory throws when `deps.orderService.getCart` is not a
 *      function.
 *
 * Authenticated GET / (ST-033-AC1, AC2, AC3, AC4):
 *   5. Returns 200 with the cart payload from the service when `req.uid`
 *      is set (AC1, AC2).
 *   6. Forwards the user id from `req.uid` into
 *      `orderService.getCart({ userId })` so the service queries only
 *      the authenticated user's cart (AC1).
 *   7. Returns 200 with the documented empty representation
 *      (`items: []`, `subtotal: 0`) when the service reports no
 *      cart history — NOT 404 (AC3). The wire format coerces the
 *      service-layer NUMERIC string to a JS number; see
 *      `backend/src/routes/_serialize.ts`.
 *   8. Two consecutive requests against the same authenticated context
 *      return identical bodies; no service mutation method is called
 *      between them (AC4).
 *
 * Defensive 401 (composition-root misconfiguration):
 *   9. Returns 401 with `code: 'UNAUTHENTICATED'` when `req.uid` is
 *      undefined despite the route being mounted — this would indicate
 *      a misconfigured composition root, but the route surfaces a
 *      clean 401 rather than a 500.
 *
 * Error translation (Rule R8 fail-closed):
 *  10. Translates a service-layer ValidationError to 400 with the
 *      service's `code` and `message`.
 *  11. Translates an unrecognised error to 500 INTERNAL_ERROR with the
 *      generic envelope (no stack, no cause, no echoed body).
 *  12. Logs the unrecognised error via the request-scoped pino logger
 *      with bounded structural metadata only — message truncated to
 *      200 characters; no echoed body or credential material.
 *
 * Rule R9 verification (no settlement vocabulary):
 *  13. The cart route file contains zero matches for the AAP §0.8.1
 *      forbidden-vocabulary grep.
 *
 * ============================================================================
 * Determinism (ST-043-AC3) and Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` drives Express via an
 *     in-memory ephemeral-port loopback that supertest manages; no
 *     external host, no DNS resolution.
 *   - Zero file-system access. The route reads no files; the test
 *     reads no fixtures from disk.
 *   - Zero environment-variable reads. `cart.ts` consumes no env vars
 *     directly.
 *   - The `OrderService` dependency is replaced by a `jest.fn()`-backed
 *     shim built per test; no real database, repository, or pg pool.
 *   - The Jest config (`jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, `restoreMocks` to `true`, so jest.fn state is wiped
 *     between tests.
 *
 * @see backend/src/routes/cart.ts — module under test
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-033-retrieve-cart-endpoint.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// `express` is imported as a runtime default — the test invokes
// `express()` to construct an in-memory app that mounts the router
// under test. `supertest` is also a runtime default.
//
// Both packages declare these defaults via CommonJS `module.exports = ...`
// and the project's `esModuleInterop: true` compiler option (see
// `backend/tsconfig.json`) makes the `import x from 'y'` form resolve
// to `module.exports` under the hood.
//
// `OrderService` is type-only — the test substitutes a `jest.fn()`-
// backed shim and never instantiates the real service. The
// `import type` form satisfies the workspace's
// `@typescript-eslint/consistent-type-imports` rule.
//
// `createCartRoutes` and `CreateCartRoutesDeps` are runtime/named
// imports from the sibling `./cart` module — the surface under test.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import type { OrderService } from '../services/order.service';

import { createCartRoutes } from './cart';
import type { CreateCartRoutesDeps } from './cart';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Minimal jest-mock-backed `OrderService` shim.
 *
 * Only the `getCart` method is consumed by `cart.ts`; the other
 * methods are present as `jest.fn()` placeholders so the shim
 * satisfies the structural type contract. Each test overrides
 * `getCart` with `mockResolvedValueOnce` / `mockRejectedValueOnce`
 * to produce the scenario under test.
 */
type OrderServiceMock = {
  getCart: jest.Mock;
  createOrder: jest.Mock;
  finalizeOrder: jest.Mock;
  getById: jest.Mock;
};

/**
 * Construct a fresh `OrderServiceMock` for each test. Centralising
 * construction in a helper guarantees every test starts from the
 * same baseline — a `jest.fn()` with no implementation, no recorded
 * calls.
 */
function buildOrderService(): OrderServiceMock {
  return {
    getCart: jest.fn(),
    createOrder: jest.fn(),
    finalizeOrder: jest.fn(),
    getById: jest.fn(),
  };
}

/**
 * Construct an Express app with the cart router mounted at
 * `/api/cart` (mirroring the production composition root in
 * `backend/src/index.ts`). A simple inline middleware stamps the
 * supplied `uid` onto `req.uid` BEFORE the cart router runs,
 * mirroring the production `sessionMiddleware` contract.
 *
 * When `uid` is `undefined`, the simulator middleware does NOT set
 * `req.uid`, allowing the route to exercise its defensive 401 path.
 *
 * The optional `attachLogger` flag installs a `req.log.error`
 * spy at the top of the chain so the error-translator's structured
 * log call can be observed.
 *
 * The `as unknown as OrderService` double-cast bridges the
 * structural-vs-nominal type gap. The route under test consumes
 * only the `getCart` member; the cast is the canonical pattern
 * for substituting minimal mocks for richer interfaces (see
 * `health.test.ts` for the same pattern applied to `pg.Pool`).
 */
type LogSpy = {
  error: jest.Mock;
};

function buildApp(opts: {
  orderService: OrderServiceMock;
  uid?: string;
  logSpy?: LogSpy;
}): express.Express {
  const app = express();

  // Optional req.log injector — mirrors what pino-http does in
  // production. When present, the error translator inside cart.ts
  // will invoke `req.log.error(...)`.
  if (opts.logSpy !== undefined) {
    const spy = opts.logSpy;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Bypass the `pino-http` module augmentation of
      // `IncomingMessage.log: pino.Logger`. The augmentation is
      // activated project-wide as soon as `pino-http` is imported by
      // `backend/src/index.ts`. In production, pino-http itself
      // replaces `req.log` with a real Logger; in this unit test we
      // are deliberately injecting a minimal `{ error: jest.Mock }`
      // spy, so we cast through `unknown` to substitute a thin
      // structural mock for the richer Logger interface.
      (req as unknown as { log: LogSpy }).log = spy;
      next();
    });
  }

  // Session-middleware simulator — stamps req.uid so the cart route
  // believes the user is authenticated. Omitted when `uid` is
  // undefined, exercising the defensive 401 path.
  if (opts.uid !== undefined) {
    const uid = opts.uid;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.uid = uid;
      next();
    });
  }

  const router = createCartRoutes({
    orderService: opts.orderService as unknown as OrderService,
  });
  app.use('/api/cart', router);
  return app;
}

// ---------------------------------------------------------------------------
// Factory wiring
// ---------------------------------------------------------------------------

describe('createCartRoutes — factory wiring', () => {
  it('returns an Express Router when dependencies are valid', () => {
    const orderService = buildOrderService();
    const router = createCartRoutes({
      orderService: orderService as unknown as OrderService,
    });
    // Express Router instances are functions in addition to having
    // `use` / `get` / `post` methods. Asserting both confirms the
    // factory returned a real Router, not a structural impostor.
    expect(typeof router).toBe('function');
    expect(typeof (router as unknown as { use: unknown }).use).toBe('function');
    expect(typeof (router as unknown as { get: unknown }).get).toBe('function');
  });

  it('throws when deps argument is null', () => {
    expect(() => createCartRoutes(null as unknown as CreateCartRoutesDeps)).toThrow(
      /deps argument is required/,
    );
  });

  it('throws when deps argument is undefined', () => {
    expect(() =>
      createCartRoutes(undefined as unknown as CreateCartRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps.orderService is missing', () => {
    expect(() =>
      createCartRoutes({} as unknown as CreateCartRoutesDeps),
    ).toThrow(/orderService dependency is required/);
  });

  it('throws when deps.orderService.getCart is not a function', () => {
    const broken = { orderService: { getCart: 'not a function' } };
    expect(() =>
      createCartRoutes(broken as unknown as CreateCartRoutesDeps),
    ).toThrow(/orderService must implement getCart/);
  });

  it('produces independent routers across calls (no module-level singleton)', () => {
    const orderServiceA = buildOrderService();
    const orderServiceB = buildOrderService();
    const a = createCartRoutes({
      orderService: orderServiceA as unknown as OrderService,
    });
    const b = createCartRoutes({
      orderService: orderServiceB as unknown as OrderService,
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// GET /api/cart — ST-033-AC1, AC2 (authenticated, returns user's cart)
// ---------------------------------------------------------------------------

describe('GET /api/cart — ST-033-AC1/AC2 (authenticated, returns cart)', () => {
  let orderService: OrderServiceMock;
  let app: express.Express;
  const TEST_UID = 'firebase-uid-12345';

  beforeEach(() => {
    orderService = buildOrderService();
    app = buildApp({ orderService, uid: TEST_UID });
  });

  it('returns 200 with the cart payload from the service', async () => {
    // Arrange — service returns a cart with one line item and a
    // calculated subtotal. Per ST-033-AC2, the response must include
    // each item with quantity, designId, metadata, plus the subtotal.
    //
    // The repository contract preserves PostgreSQL NUMERIC(12,2) by
    // emitting `subtotal` as a string ('50.00'). The route layer's
    // {@link serializeCart} coerces this to a JS number (50) for the
    // wire format; the assertion below pins the post-serialisation
    // shape that callers actually observe.
    const cart = {
      userId: TEST_UID,
      items: [
        {
          id: 'item-id-1',
          orderId: 'cart-order-id-1',
          designId: 'design-uuid-1',
          quantity: 2,
          metadata: { unitPrice: '25.00' },
          createdAt: '2025-01-15T10:30:00.000Z',
        },
      ],
      subtotal: '50.00',
    };
    orderService.getCart.mockResolvedValueOnce(cart);

    // Act
    const res = await request(app).get('/api/cart');

    // Assert — status + body shape match the service result with
    // subtotal coerced to number per the wire-format contract.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...cart, subtotal: 50 });
    expect(typeof res.body.subtotal).toBe('number');
  });

  it('forwards req.uid to orderService.getCart (AC1 ownership scoping)', async () => {
    // ST-033-AC1: the endpoint MUST return only the authenticated
    // user's cart. The route enforces this by passing `req.uid`
    // (NOT a query parameter) as the `userId` argument to the
    // service. This test pins the invariant.
    orderService.getCart.mockResolvedValueOnce({
      userId: TEST_UID,
      items: [],
      subtotal: '0.00',
    });

    await request(app).get('/api/cart');

    expect(orderService.getCart).toHaveBeenCalledTimes(1);
    expect(orderService.getCart).toHaveBeenCalledWith({ userId: TEST_UID });
  });

  it('does not call any other order service method (AC4 zero side effects)', async () => {
    // ST-033-AC4: GET MUST NOT create, mutate, or finalize. The
    // route only invokes `getCart`; this test asserts that none of
    // the mutation methods are called.
    orderService.getCart.mockResolvedValueOnce({
      userId: TEST_UID,
      items: [],
      subtotal: '0.00',
    });

    await request(app).get('/api/cart');

    expect(orderService.getCart).toHaveBeenCalledTimes(1);
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/cart — ST-033-AC3 (empty cart returns 200, NOT 404)
// ---------------------------------------------------------------------------

describe('GET /api/cart — ST-033-AC3 (empty cart returns 200, NOT 404)', () => {
  it('returns 200 with the documented empty representation when items is empty', async () => {
    // ST-033-AC3 verbatim: "When the authenticated user has no
    // active cart, the endpoint returns an empty cart representation
    // with a success status rather than a not-found error."
    //
    // The service contract guarantees the empty representation
    // shape `{ userId, items: [], subtotal: '0.00' }`; the route
    // layer's {@link serializeCart} coerces the NUMERIC-safe string
    // to a JS number (0) for the wire format consumed by the
    // frontend (see `frontend/src/api/orders.ts` Cart interface and
    // QA Final D Issue #9 — the E2E suite asserts
    // `typeof cart.subtotal === 'number'`).
    const orderService = buildOrderService();
    const TEST_UID = 'fresh-user-uid';
    orderService.getCart.mockResolvedValueOnce({
      userId: TEST_UID,
      items: [],
      subtotal: '0.00',
    });
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    // Critical assertions — status is 200 (NEVER 404), body is the
    // empty shape, items is an empty array, subtotal is the
    // documented `0` JS number after coercion.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.body).toEqual({
      userId: TEST_UID,
      items: [],
      subtotal: 0,
    });
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.subtotal).toBe(0);
    expect(typeof res.body.subtotal).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// GET /api/cart — ST-033-AC4 (zero side effects, idempotent)
// ---------------------------------------------------------------------------

describe('GET /api/cart — ST-033-AC4 (idempotent, zero side effects)', () => {
  it('two consecutive GET calls return identical bodies', async () => {
    // ST-033-AC4: "safe to call repeatedly from the client without
    // side effects". The service contract is read-only; consecutive
    // GETs must return the same payload.
    const orderService = buildOrderService();
    const TEST_UID = 'repeat-user-uid';
    const cart = {
      userId: TEST_UID,
      items: [
        {
          id: 'item-id-A',
          orderId: 'cart-A',
          designId: 'design-A',
          quantity: 1,
          metadata: {},
          createdAt: '2025-02-01T00:00:00.000Z',
        },
      ],
      subtotal: '10.00',
    };
    // The mock returns the SAME response on every call — a real
    // service backed by SELECT-only SQL would do the same.
    orderService.getCart.mockResolvedValue(cart);
    const app = buildApp({ orderService, uid: TEST_UID });

    const first = await request(app).get('/api/cart');
    const second = await request(app).get('/api/cart');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // No mutation methods called on either invocation.
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/cart — defensive 401 when req.uid missing
// ---------------------------------------------------------------------------

describe('GET /api/cart — defensive 401 when req.uid missing', () => {
  it('returns 401 UNAUTHENTICATED when sessionMiddleware did not run', async () => {
    // Defense-in-depth: if a future composition-root refactor
    // omits the session middleware on this path, the route MUST
    // surface a clean 401 rather than a 500. This test pins that
    // invariant.
    const orderService = buildOrderService();
    // Build app WITHOUT a uid-stamping middleware — req.uid will
    // be undefined when the cart handler runs.
    const app = buildApp({ orderService /* no uid */ });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    // The service was never reached because the guard tripped
    // BEFORE the service call.
    expect(orderService.getCart).not.toHaveBeenCalled();
  });

  it('returns 401 when req.uid is an empty string', async () => {
    // Same defense-in-depth posture for the edge case where the
    // session middleware accidentally sets `req.uid = ''`.
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: '' });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(orderService.getCart).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/cart — error translation (Rule R8 fail-closed)
// ---------------------------------------------------------------------------

describe('GET /api/cart — error translation (Rule R8 fail-closed)', () => {
  const TEST_UID = 'error-test-uid';

  it('translates a service-layer ValidationError to 400 with code/message', async () => {
    // Service-layer ValidationError has `name: 'ValidationError'`,
    // `code: '<service code>'`, and a fixed `message`. The route
    // translator MUST forward both `code` and `message` verbatim.
    const orderService = buildOrderService();
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'VALIDATION_FAILED';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.getCart.mockRejectedValueOnce(
      new FakeValidationError('userId must be a non-empty string'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'userId must be a non-empty string',
      },
    });
  });

  it('translates an unrecognised error to 500 INTERNAL_ERROR with non-leaking body', async () => {
    // Per Rule R8 (fail-closed): an unrecognised error MUST produce
    // a non-2xx response. Per the route's information-disclosure
    // posture, the body MUST NOT include the original message,
    // stack, or cause — only the generic 'Internal server error'.
    const orderService = buildOrderService();
    orderService.getCart.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    // Original error details MUST NOT appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(JSON.stringify(res.body)).not.toContain('pg socket');
  });

  it('logs unrecognised errors with bounded structural metadata via req.log.error', async () => {
    // The error translator uses `req.log.error(...)` to emit a
    // single bounded ERROR record with `event`, `errorName`,
    // `errorCode`, `errorMessage` (truncated to 200 chars). Per
    // Rule R2 the log MUST NOT contain credential material.
    const orderService = buildOrderService();
    const logSpy: LogSpy = { error: jest.fn() };
    const longMessage = 'X'.repeat(500); // exceeds the 200-char cap
    const customErr = new Error(longMessage);
    Object.defineProperty(customErr, 'code', {
      value: 'PG_CONN_FAIL',
      enumerable: true,
    });
    orderService.getCart.mockRejectedValueOnce(customErr);
    const app = buildApp({ orderService, uid: TEST_UID, logSpy });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs, logMsg] = logSpy.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logMsg).toBe('cart route error');
    expect(logArgs).toMatchObject({
      event: 'cart.route.error',
      errorName: 'Error',
      errorCode: 'PG_CONN_FAIL',
    });
    // The message MUST be truncated to ≤ 200 characters.
    expect(typeof logArgs['errorMessage']).toBe('string');
    expect((logArgs['errorMessage'] as string).length).toBeLessThanOrEqual(200);
  });

  it('does not throw when req.log is absent (graceful degradation)', async () => {
    // If pino-http is not wired (e.g. in unit tests, in CLI tools,
    // in early bootstrap before middleware mounts), the route MUST
    // still produce a 500 — silently skipping the log call rather
    // than crashing.
    const orderService = buildOrderService();
    orderService.getCart.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp({ orderService, uid: TEST_UID /* no logSpy */ });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates a malformed thrown value (no name, no message) to 500 with INTERNAL_ERROR', async () => {
    // Defense-in-depth: a non-Error throw value (e.g. `throw 42`,
    // `throw null`, `throw {}`) MUST produce a structured 500
    // response rather than crash the worker. The error translator's
    // structural narrowing (typeof checks against err.name,
    // err.message) handles this without a re-throw.
    const orderService = buildOrderService();
    // Throw an object literal with no name, no message, no code —
    // exercises the `: undefined` branches of the typeof narrowing.
    orderService.getCart.mockRejectedValueOnce({});
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('translates a ValidationError without code to 400 with default code/message fallback', async () => {
    // Defense-in-depth: a ValidationError with only `name` set (no
    // `code`, no `message`) MUST surface the ?? fallbacks. This
    // covers the two `??` branches in the 400 path.
    const orderService = buildOrderService();
    const minimalErr = { name: 'ValidationError' };
    orderService.getCart.mockRejectedValueOnce(minimalErr);
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  it('logs an unrecognised error with no message via req.log.error (errorMessage undefined branch)', async () => {
    // Defense-in-depth: an unrecognised error throw with no
    // `message` (e.g. `throw {}`) MUST still produce a structured
    // log call with `errorMessage: undefined`. Covers the `:
    // undefined` branch of the message-truncation ternary.
    const orderService = buildOrderService();
    const logSpy: LogSpy = { error: jest.fn() };
    // A bare object — no name, no message, no code.
    orderService.getCart.mockRejectedValueOnce({});
    const app = buildApp({ orderService, uid: TEST_UID, logSpy });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({
      event: 'cart.route.error',
      errorName: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it('forwards an unhandled rejection in runGetCart to Express next() (defensive .catch)', async () => {
    // The route wraps `runGetCart` in a sync handler with a
    // defensive `.catch(next)`. Under documented operation,
    // `runGetCart` never rejects — it converts every error into a
    // structured response via `handleRouteError`. This test
    // engineers a path where `handleRouteError` itself throws (by
    // installing a `req.log.error` that throws synchronously when
    // invoked DURING handleRouteError's execution). The thrown
    // value escapes runGetCart's catch and propagates through the
    // sync handler's `.catch(next)`, which forwards it to Express's
    // central error middleware — a Rule R8 fail-closed posture.
    const orderService = buildOrderService();
    // The originating error — handleRouteError will fall through to
    // its 500 INTERNAL_ERROR branch and try to call `req.log.error`.
    orderService.getCart.mockRejectedValueOnce(new Error('original failure'));
    // The malicious log spy throws when invoked. Because this is
    // inside handleRouteError's (synchronous) 500 branch, the throw
    // propagates out of runGetCart's catch.
    const malformedLog: LogSpy = {
      error: jest.fn().mockImplementation(() => {
        throw new Error('log subsystem failure');
      }),
    };

    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Cast through `unknown` to bypass the `pino-http` module
      // augmentation (IncomingMessage.log: pino.Logger) so a thin
      // throwing spy can be substituted for the rich Logger interface.
      (req as unknown as { log: LogSpy }).log = malformedLog;
      req.uid = TEST_UID;
      next();
    });
    // Install Express's terminal error middleware so the thrown
    // value lands as a 500 (Express's default error handler does
    // this when no other middleware catches it).
    const errorHandlerSpy = jest.fn(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ caught: true, message: err.message });
      },
    );
    const router = createCartRoutes({
      orderService: orderService as unknown as OrderService,
    });
    app.use('/api/cart', router);
    app.use(errorHandlerSpy);

    const res = await request(app).get('/api/cart');

    // The defensive catch forwarded the error to Express's chain;
    // our terminal error handler caught it and responded 500.
    expect(res.status).toBe(500);
    expect(errorHandlerSpy).toHaveBeenCalledTimes(1);
    expect(errorHandlerSpy.mock.calls[0]?.[0]?.message).toBe(
      'log subsystem failure',
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP method scoping — only GET is supported on /api/cart
// ---------------------------------------------------------------------------
//
// Per AAP §0.6.4 Track 1 Backend (T1-C) and ST-033 narrative, the cart
// endpoint exposes ONLY a GET handler at `/api/cart`. Mutation methods
// (POST, PUT, DELETE) MUST NOT be wired by the cart router — Express
// surfaces them as 404 (no matching route) or 405 (Method Not Allowed)
// per default semantics. This block pins that contract so a future
// refactor that accidentally adds a `router.post(...)` or
// `router.delete(...)` call is caught by the test gate.
//
// The contract is also a Rule R9 (no payment processing) reinforcement:
// any future "POST /api/cart/checkout" or "DELETE /api/cart/items/:id"
// would constitute a side-effecting cart-mutation surface that is
// explicitly OUT OF SCOPE for ST-033's read-only retrieval mandate
// (ST-033-AC4).
// ---------------------------------------------------------------------------

describe('GET /api/cart — only GET is supported (other methods rejected)', () => {
  // Single shared fixture is sufficient — every assertion here is
  // method-only and shares no per-test state. Per ST-033-AC4
  // (no side effects) the service should never be invoked even if
  // a mutation method somehow reached the handler; this fixture
  // includes a fresh `OrderServiceMock` so we can assert that
  // negative invariant.
  const TEST_UID = 'method-test-uid';

  it('rejects POST /api/cart with 404 or 405 (only GET is wired)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).post('/api/cart').send({});

    // Express returns 404 by default when no router matches the
    // method+path combination. Some servers (with explicit method-
    // not-allowed wiring) would return 405. Both are acceptable
    // per the AAP test coverage matrix (ST-033 §0.6 supports
    // either status), and either status confirms the cart router
    // does NOT accept POST.
    expect([404, 405]).toContain(res.status);
    // Critical: the service MUST NOT have been invoked.
    expect(orderService.getCart).not.toHaveBeenCalled();
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });

  it('rejects PUT /api/cart with 404 or 405 (only GET is wired)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).put('/api/cart').send({});

    expect([404, 405]).toContain(res.status);
    expect(orderService.getCart).not.toHaveBeenCalled();
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });

  it('rejects DELETE /api/cart with 404 or 405 (only GET is wired)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).delete('/api/cart').send();

    expect([404, 405]).toContain(res.status);
    expect(orderService.getCart).not.toHaveBeenCalled();
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });

  it('rejects PATCH /api/cart with 404 or 405 (only GET is wired)', async () => {
    // PATCH coverage is included for completeness — the cart
    // surface is read-only by design, and PATCH is the most
    // common HTTP verb for partial mutations. Pinning that
    // PATCH is rejected gives the test gate the broadest
    // possible defense against accidental mutation surfaces.
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).patch('/api/cart').send({});

    expect([404, 405]).toContain(res.status);
    expect(orderService.getCart).not.toHaveBeenCalled();
    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rule R9 verification — no payment vocabulary in the response body
// ---------------------------------------------------------------------------
//
// Per AAP §0.8.1 R9 the cart route MUST NOT introduce any payment-
// processor vocabulary into the API surface. The complementary
// source-file check below grep-matches the file on disk; this block
// is the runtime sibling — it drives the route through supertest with
// representative payloads and asserts the serialized JSON response
// body is free of payment-processor terminology.
//
// The two checks together provide layered defense:
//   - The source-file grep catches code-time leaks (e.g. a comment
//     mentioning "Stripe" or a constant named PAYPAL_REGION).
//   - The runtime body sweep catches data-shape leaks (e.g. a
//     service returning `{ paymentIntent: ... }` that the route
//     would forward verbatim).
//
// Verification mirrors the AAP `grep -ri` command applied to the
// response body's JSON serialization, lower-cased to match the `-i`
// flag's case-insensitive semantics.
// ---------------------------------------------------------------------------

describe('Rule R9 — no payment-processor vocabulary in response body', () => {
  const TEST_UID = 'r9-body-sweep-uid';

  it('200 cart response body contains zero matches for the AAP forbidden-vocabulary grep', async () => {
    const orderService = buildOrderService();
    // Representative cart payload — a non-trivial item shape
    // exercises the JSON serialization of every documented field.
    orderService.getCart.mockResolvedValueOnce({
      userId: TEST_UID,
      items: [
        {
          id: 'item-id-1',
          orderId: 'cart-order-id-1',
          designId: 'design-uuid-1',
          quantity: 2,
          metadata: { unitPrice: '25.00', title: 'StrikeForge Pro' },
          createdAt: '2025-01-15T10:30:00.000Z',
        },
      ],
      subtotal: '50.00',
    });
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    // The serialized body — JSON.stringify on the parsed body
    // round-trips the response shape and lower-cases for the
    // case-insensitive AAP grep equivalence.
    const serialized = JSON.stringify(res.body).toLowerCase();
    // Each forbidden term from AAP §0.7.2 / §0.8.1 R9.
    expect(serialized).not.toContain('stripe');
    expect(serialized).not.toContain('paypal');
    expect(serialized).not.toContain('braintree');
    expect(serialized).not.toContain('payment_intent');
    expect(serialized).not.toContain('paymentintent');
    expect(serialized).not.toContain('charge');
    expect(serialized).not.toContain('refund');
    expect(serialized).not.toContain('tokenize');
  });

  it('200 empty-cart response body contains zero matches for the AAP forbidden-vocabulary grep', async () => {
    // The empty-cart path has a different serialized shape (zero
    // items, '0.00' subtotal). Sweeping it independently confirms
    // the empty representation is also free of forbidden tokens —
    // a Rule R9 belt-and-suspenders posture.
    const orderService = buildOrderService();
    orderService.getCart.mockResolvedValueOnce({
      userId: TEST_UID,
      items: [],
      subtotal: '0.00',
    });
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain('stripe');
    expect(serialized).not.toContain('paypal');
    expect(serialized).not.toContain('braintree');
    expect(serialized).not.toContain('payment_intent');
    expect(serialized).not.toContain('paymentintent');
    expect(serialized).not.toContain('charge');
    expect(serialized).not.toContain('refund');
    expect(serialized).not.toContain('tokenize');
  });

  it('500 error response body contains zero matches for the AAP forbidden-vocabulary grep', async () => {
    // The error envelope has yet another serialized shape (a
    // single `error: { code, message }` object). Sweeping it
    // independently confirms even the failure path is free of
    // forbidden tokens. Per Rule R8 (fail-closed) we trigger
    // a 500 by rejecting the service call.
    const orderService = buildOrderService();
    orderService.getCart.mockRejectedValueOnce(new Error('synthetic failure'));
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    const serialized = JSON.stringify(res.body).toLowerCase();
    expect(serialized).not.toContain('stripe');
    expect(serialized).not.toContain('paypal');
    expect(serialized).not.toContain('braintree');
    expect(serialized).not.toContain('payment_intent');
    expect(serialized).not.toContain('paymentintent');
    expect(serialized).not.toContain('charge');
    expect(serialized).not.toContain('refund');
    expect(serialized).not.toContain('tokenize');
  });
});

// ---------------------------------------------------------------------------
// Rule R2 verification — no infrastructure detail leaked in error response
// ---------------------------------------------------------------------------
//
// Per Rule R2 (no credential material in logs) and Rule R8
// (gates fail closed), an unexpected error path MUST produce a
// generic, non-leaking 500 envelope. This block exercises the
// AAP-specified test scenario: `database connection refused`-style
// errors must NOT have their raw message echoed in the response
// body. The route's error translator pins to the static
// 'Internal server error' string for INTERNAL_ERROR responses,
// satisfying this contract.
// ---------------------------------------------------------------------------

describe('Rule R2 — no infrastructure detail leaked in 500 response body', () => {
  const TEST_UID = 'r2-leak-test-uid';

  it('database-style error message is NOT echoed in response body', async () => {
    // The AAP test coverage matrix (§0.6 Phase 3 of cart.test.ts
    // requirements) specifies that infrastructure detail must not
    // leak per Rule R2. Drive a representative pg-style error and
    // assert the response body is free of low-level diagnostic
    // tokens (database, refused, connection).
    const orderService = buildOrderService();
    orderService.getCart.mockRejectedValueOnce(
      new Error('database connection refused at 127.0.0.1:5432'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).get('/api/cart');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    // The original error message MUST be redacted from the
    // response body. Lower-case the body to make the match
    // case-insensitive — `Database` and `database` both fail.
    const responseMessage =
      typeof res.body.error.message === 'string'
        ? res.body.error.message.toLowerCase()
        : '';
    expect(responseMessage).not.toContain('database');
    expect(responseMessage).not.toContain('refused');
    expect(responseMessage).not.toContain('connection');
    expect(responseMessage).not.toContain('127.0.0.1');
    expect(responseMessage).not.toContain('5432');
    // The allowed message is the generic envelope.
    expect(res.body.error.message).toBe('Internal server error');
  });
});

// ---------------------------------------------------------------------------
// Rule R9 verification — no settlement vocabulary in cart.ts
// ---------------------------------------------------------------------------

describe('Rule R9 — no settlement-processor vocabulary in cart.ts', () => {
  it('the source file contains zero matches for the AAP forbidden-vocabulary grep', () => {
    // Read the source file from disk and run the AAP §0.8.1 R9 grep
    // pattern against it. The pattern is "stripe|braintree|paypal|
    // payment_intent|charge" per AAP §0.7.2 / §0.8.1 R9.
    //
    // The test is parameterised on the source file path so the
    // pattern is verified WITHIN this test rather than by an
    // external shell command — a Rule R8 fail-closed posture
    // applied at the test layer.
    const source = fs.readFileSync(
      path.join(__dirname, 'cart.ts'),
      'utf-8',
    );
    const forbidden = /stripe|braintree|paypal|payment_intent|charge/i;
    expect(source).not.toMatch(forbidden);
  });
});
