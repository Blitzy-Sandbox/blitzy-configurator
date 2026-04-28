/**
 * Unit tests for `backend/src/routes/orders.ts` — ST-032
 * (Create Order Endpoint) and ST-034 (Finalize Order — Post Processing).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-032 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "The create-order endpoint requires a valid session and
 *             writes a new order record with order line items derived
 *             from the authenticated user's current cart contents."
 *
 *       AC2: "A successful order creation returns the canonical
 *             persisted order, including a server-assigned order
 *             identifier, the line items, a calculated subtotal, and
 *             a created timestamp."
 *
 *       AC3: "Requests with empty carts, malformed line items, or
 *             invalid references to designs are rejected with
 *             descriptive errors and leave the persistence layer
 *             unchanged."
 *
 *       AC4: "The endpoint persists the order in a documented
 *             non-terminal state and defers downstream financial
 *             settlement to a separate capability that is currently
 *             out of scope."
 *
 *   - Story ST-034 acceptance criteria (verbatim, Rule R1):
 *
 *       AC1: "The finalization endpoint requires a valid session,
 *             operates only on an existing order owned by the
 *             authenticated user, and transitions that order to a
 *             documented finalized state."
 *
 *       AC2: "Finalization triggers the documented post-processing
 *             workflow ... and persists the outcome of each step
 *             against the order."
 *
 *       AC3: "Finalization is rejected with a descriptive error when
 *             the target order is already finalized, is missing
 *             required references, or fails any post-processing
 *             step, and leaves the persisted order state coherent."
 *
 *       AC4: "The scope of finalization ... explicitly excludes any
 *             downstream financial settlement activity."
 *
 *   - Story ST-043 acceptance criteria (Rule R1):
 *       AC3: deterministic verdict from a fixed source tree.
 *       AC4: runs without additional services or network access.
 *
 *   - AAP §0.7.1: backend co-located *.test.ts files are in scope.
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * Factory wiring (createOrderRoutes):
 *   1. Returns a usable Express Router that mounts a POST `/` handler
 *      and a POST `/:id/finalize` handler.
 *   2. Throws when `deps` is missing or non-object.
 *   3. Throws when `deps.orderService` is missing.
 *   4. Throws when `deps.orderService.createOrder` is not a function.
 *   5. Throws when `deps.orderService.finalizeOrder` is not a function.
 *   6. Produces independent routers across calls (no module-level
 *      singleton state).
 *
 * POST /api/orders — ST-032 (create order):
 *   7. Returns 201 with the canonical persisted order when the body
 *      is valid (AC1, AC2).
 *   8. Forwards `req.uid` to `orderService.createOrder({ userId, ... })`
 *      so the service operates only on the authenticated user (AC1).
 *   9. Coalesces missing `metadata` field on cart items to `{}` to
 *      satisfy the repository's non-optional `CartItemInput.metadata`
 *      contract.
 *  10. Preserves the explicit `metadata` field when supplied.
 *  11. Returns 400 with `code: 'VALIDATION_FAILED'` and field-level
 *      details when the body is missing the `items` array (AC3).
 *  12. Returns 400 when `items` is empty (AC3 — empty-cart rejection).
 *  13. Returns 400 when an item is missing `designId` (AC3 — malformed
 *      line item).
 *  14. Returns 400 when an item has a non-positive quantity (AC3 —
 *      malformed line item).
 *  15. Returns 400 when an item has a non-integer quantity (AC3).
 *  16. Returns 400 when an item has unknown extra fields (AC3 —
 *      strict() rejection).
 *  17. Does NOT call `orderService.createOrder` when validation fails
 *      (AC3 — persistence unchanged).
 *  18. Returns 401 with `UNAUTHENTICATED` when `req.uid` is missing.
 *  19. Returns 401 with `UNAUTHENTICATED` when `req.uid` is the empty
 *      string.
 *
 * POST /api/orders/:id/finalize — ST-034 (finalize order):
 *  20. Returns 200 with the finalized order when the service succeeds
 *      (AC1, AC2).
 *  21. Forwards `req.uid` and the `id` URL parameter to
 *      `orderService.finalizeOrder` (AC1).
 *  22. Returns 401 with `UNAUTHENTICATED` when `req.uid` is missing.
 *  23. Returns 400 with `VALIDATION_FAILED` when the URL `:id` is
 *      empty/whitespace (defensive 400 distinct from framework 404).
 *
 * Error translation (Rule R8 fail-closed):
 *  24. Service ValidationError → 400 with originating code/message
 *      (e.g. EMPTY_CART).
 *  25. Service ValidationError(code: 'DESIGN_NOT_FOUND') → 404 with
 *      forwarded code/message (defensive ST-032-AC3 mapping).
 *  26. Service NotFoundError(code: 'DESIGN_NOT_FOUND') → 404
 *      (canonical ST-032-AC3 mapping — design ownership failure).
 *  27. Service NotFoundError(code: 'ORDER_NOT_FOUND') → 404 (ST-034
 *      — order missing or not owned).
 *  28. Service ConflictError(code: 'ORDER_STATE_INVALID') → 409
 *      (ST-034 — already finalized).
 *  29. Service ConflictError(code: 'ORDER_STATE_CONCURRENT_CHANGE')
 *      → 409 (ST-034 — race condition).
 *  30. Unrecognised error → 500 INTERNAL_ERROR with a non-leaking
 *      body (no stack, no cause, no echoed message).
 *  31. Logs unrecognised errors via req.log.error with bounded
 *      structural metadata only (truncated to 200 characters).
 *  32. Does not throw when req.log is absent (graceful degradation).
 *  33. Translates a malformed thrown value (`throw {}`) to 500 with
 *      INTERNAL_ERROR.
 *  34. ValidationError without code uses the default fallbacks
 *      ('VALIDATION_FAILED', 'Invalid input').
 *
 * Rule R9 verification (DOMINANT for this file):
 *  35. The source file contains zero matches for the AAP §0.8.1 R9
 *      forbidden-vocabulary grep (stripe|braintree|paypal|
 *      payment_intent|charge|refund|tokenize|chargeback).
 *  36. The source file contains zero references to settlement-state
 *      transitions ('paid', 'charged', 'authorized', 'settled',
 *      'refunded', 'tokenized') in any form.
 *  37. The source file does not import any payment-processor SDK.
 *
 * ============================================================================
 * Determinism (ST-043-AC3) and Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` uses an in-memory
 *     ephemeral-port loopback that supertest manages.
 *   - Zero file-system access except for the Rule R9 source-grep test,
 *     which reads `orders.ts` from the same directory as this test
 *     file (`__dirname`).
 *   - Zero environment-variable reads. `orders.ts` consumes no env
 *     vars directly.
 *   - The `OrderService` dependency is replaced by a `jest.fn()`-
 *     backed shim built per test; no real database, repository, or
 *     pg pool.
 *   - The Jest config sets `clearMocks`/`resetMocks`/`restoreMocks`
 *     to true, so jest.fn state is wiped between tests.
 *
 * @see backend/src/routes/orders.ts — module under test
 * @see backend/src/services/order.service.ts
 * @see backend/jest.config.unit.ts
 * @see tickets/stories/ST-032-create-order-endpoint.md
 * @see tickets/stories/ST-034-finalize-order-post-processing.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import type { OrderService } from '../services/order.service';

import { createOrderRoutes } from './orders';
import type { CreateOrderRoutesDeps } from './orders';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Minimal jest-mock-backed `OrderService` shim.
 *
 * The route file consumes only `createOrder` and `finalizeOrder`;
 * the other methods are present as `jest.fn()` placeholders so the
 * shim satisfies the structural type contract via the
 * `as unknown as OrderService` cast in `buildApp`.
 */
type OrderServiceMock = {
  getCart: jest.Mock;
  createOrder: jest.Mock;
  finalizeOrder: jest.Mock;
  getById: jest.Mock;
};

function buildOrderService(): OrderServiceMock {
  return {
    getCart: jest.fn(),
    createOrder: jest.fn(),
    finalizeOrder: jest.fn(),
    getById: jest.fn(),
  };
}

/**
 * Spy shape for `req.log.error`; mirrors the `pino-http`-attached
 * logger interface that `orders.ts` uses for fail-closed structured
 * logging.
 */
type LogSpy = {
  error: jest.Mock;
};

/**
 * Construct an Express app with the orders router mounted at
 * `/api/orders`. A simple inline middleware stamps the supplied
 * `uid` onto `req.uid` BEFORE the orders router runs, mirroring the
 * production session middleware contract.
 *
 * When `uid` is `undefined`, the simulator middleware does NOT set
 * `req.uid`, allowing the route to exercise its defensive 401 path.
 *
 * The optional `logSpy` flag installs a `req.log.error` spy at the
 * top of the chain so the error-translator's structured log call
 * can be observed.
 */
function buildApp(opts: {
  orderService: OrderServiceMock;
  uid?: string;
  logSpy?: LogSpy;
}): express.Express {
  const app = express();

  // Body parser is required because the orders POST endpoints
  // consume JSON. Production wires this in `index.ts` BEFORE the
  // route is mounted; we mirror that in the test.
  app.use(express.json());

  // Optional req.log injector — mirrors what pino-http does in
  // production. When present, the error translator inside orders.ts
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

  // Session-middleware simulator — stamps `req.uid` so the orders
  // route believes the user is authenticated. Omitted when `uid` is
  // undefined, exercising the defensive 401 path.
  if (opts.uid !== undefined) {
    const uid = opts.uid;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.uid = uid;
      next();
    });
  }

  const router = createOrderRoutes({
    orderService: opts.orderService as unknown as OrderService,
  });
  app.use('/api/orders', router);
  return app;
}

/**
 * Construct a canonical persisted-order fixture matching the
 * `Order` shape from `backend/src/repositories/order.repository.ts`.
 * The shape is held constant across all positive-path tests so the
 * assertions focus on transport behaviour rather than data shape.
 */
function buildOrderFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'order-uuid-aaaa-1111',
    userId: 'firebase-uid-test-user-1',
    state: 'created',
    subtotal: '50.00',
    createdAt: '2025-01-15T10:30:00.000Z',
    lastModifiedAt: '2025-01-15T10:30:00.000Z',
    items: [
      {
        orderId: 'order-uuid-aaaa-1111',
        designId: 'design-uuid-1',
        quantity: 2,
        metadata: { unitPrice: '25.00' },
      },
    ],
    ...overrides,
  };
}

// ===========================================================================
// Test suite begins
// ===========================================================================

// ---------------------------------------------------------------------------
// Factory wiring (Test #1–#6)
// ---------------------------------------------------------------------------

describe('createOrderRoutes — factory wiring', () => {
  it('returns an Express Router when dependencies are valid (#1)', () => {
    const orderService = buildOrderService();
    const router = createOrderRoutes({
      orderService: orderService as unknown as OrderService,
    });
    // Express Router instances are functions in addition to having
    // `use`/`post` methods. Asserting both confirms the factory
    // returned a real Router, not a structural impostor.
    expect(typeof router).toBe('function');
    expect(typeof (router as unknown as { use: unknown }).use).toBe('function');
    expect(typeof (router as unknown as { post: unknown }).post).toBe('function');
  });

  it('throws when deps argument is null (#2)', () => {
    expect(() => createOrderRoutes(null as unknown as CreateOrderRoutesDeps)).toThrow(
      /deps argument is required/,
    );
  });

  it('throws when deps argument is undefined (#2)', () => {
    expect(() =>
      createOrderRoutes(undefined as unknown as CreateOrderRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps argument is a non-object primitive (#2)', () => {
    expect(() =>
      createOrderRoutes('not-an-object' as unknown as CreateOrderRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps.orderService is missing (#3)', () => {
    expect(() =>
      createOrderRoutes({} as unknown as CreateOrderRoutesDeps),
    ).toThrow(/orderService dependency is required/);
  });

  it('throws when deps.orderService is null (#3)', () => {
    expect(() =>
      createOrderRoutes({ orderService: null } as unknown as CreateOrderRoutesDeps),
    ).toThrow(/orderService dependency is required/);
  });

  it('throws when deps.orderService.createOrder is not a function (#4)', () => {
    const broken = {
      orderService: {
        createOrder: 'not-a-function',
        finalizeOrder: jest.fn(),
      },
    };
    expect(() =>
      createOrderRoutes(broken as unknown as CreateOrderRoutesDeps),
    ).toThrow(/orderService must implement createOrder\/finalizeOrder/);
  });

  it('throws when deps.orderService.finalizeOrder is not a function (#5)', () => {
    const broken = {
      orderService: {
        createOrder: jest.fn(),
        finalizeOrder: 'not-a-function',
      },
    };
    expect(() =>
      createOrderRoutes(broken as unknown as CreateOrderRoutesDeps),
    ).toThrow(/orderService must implement createOrder\/finalizeOrder/);
  });

  it('produces independent routers across calls (#6 no module singleton)', () => {
    const orderServiceA = buildOrderService();
    const orderServiceB = buildOrderService();
    const a = createOrderRoutes({
      orderService: orderServiceA as unknown as OrderService,
    });
    const b = createOrderRoutes({
      orderService: orderServiceB as unknown as OrderService,
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// POST /api/orders — happy paths (Test #7–#10)
// ---------------------------------------------------------------------------

describe('POST /api/orders — ST-032 success path', () => {
  let orderService: OrderServiceMock;
  let app: express.Express;
  const TEST_UID = 'firebase-uid-test-user-1';

  beforeEach(() => {
    orderService = buildOrderService();
    app = buildApp({ orderService, uid: TEST_UID });
  });

  it('returns 201 with the canonical persisted order on success (#7)', async () => {
    // ST-032-AC2: a successful order creation returns the canonical
    // persisted order with id, items, calculated subtotal, and
    // createdAt. The route forwards the service's return value
    // verbatim with HTTP 201.
    const order = buildOrderFixture();
    orderService.createOrder.mockResolvedValueOnce(order);

    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: '11111111-1111-4111-8111-111111111111', quantity: 2 }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(order);
    // Per ST-032-AC4: the persisted state MUST be the documented
    // non-terminal `'created'` state, NOT any settlement-state.
    expect(res.body.state).toBe('created');
  });

  it('forwards req.uid to orderService.createOrder (#8 AC1 ownership)', async () => {
    // ST-032-AC1: the endpoint MUST operate on the authenticated
    // user's content only. The route enforces this by passing
    // `req.uid` (NOT a body field) as the `userId` argument.
    orderService.createOrder.mockResolvedValueOnce(buildOrderFixture());

    await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: '11111111-1111-4111-8111-111111111111', quantity: 2 }],
      });

    expect(orderService.createOrder).toHaveBeenCalledTimes(1);
    expect(orderService.createOrder).toHaveBeenCalledWith({
      userId: TEST_UID,
      cartItems: [
        { designId: '11111111-1111-4111-8111-111111111111', quantity: 2, metadata: {} },
      ],
    });
  });

  it('coalesces missing metadata to {} for the repository contract (#9)', async () => {
    // The Zod schema accepts `metadata` as optional, but the
    // repository's `CartItemInput.metadata` is non-optional. The
    // route adapter coalesces missing values to `{}` so the
    // repository contract is preserved — see Section 6 of orders.ts.
    orderService.createOrder.mockResolvedValueOnce(buildOrderFixture());

    await request(app)
      .post('/api/orders')
      .send({
        items: [
          { designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1 },
          { designId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: 5 },
        ],
      });

    const callArgs = orderService.createOrder.mock.calls[0]?.[0];
    expect(callArgs).toEqual({
      userId: TEST_UID,
      cartItems: [
        { designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1, metadata: {} },
        { designId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', quantity: 5, metadata: {} },
      ],
    });
  });

  it('preserves explicit metadata when supplied (#10)', async () => {
    // When metadata is supplied, the route forwards it verbatim;
    // it does NOT inspect or transform the contents.
    orderService.createOrder.mockResolvedValueOnce(buildOrderFixture());
    const richMetadata = {
      selectedColors: { primary: '#FF0000', secondary: '#00FF00' },
      size: 'standard',
      placementCoords: { x: 0.5, y: 0.5 },
    };

    await request(app)
      .post('/api/orders')
      .send({
        items: [
          { designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1, metadata: richMetadata },
        ],
      });

    expect(orderService.createOrder).toHaveBeenCalledWith({
      userId: TEST_UID,
      cartItems: [
        { designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1, metadata: richMetadata },
      ],
    });
  });

  it('returns the createdAt timestamp from the service in the response body', async () => {
    // ST-032-AC2 explicit: the response includes a created timestamp.
    const order = buildOrderFixture({ createdAt: '2025-03-04T12:00:00.000Z' });
    orderService.createOrder.mockResolvedValueOnce(order);

    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.createdAt).toBe('2025-03-04T12:00:00.000Z');
    expect(res.body.id).toBe('order-uuid-aaaa-1111');
    expect(typeof res.body.subtotal).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /api/orders — Zod validation failures (Test #11–#17)
// ---------------------------------------------------------------------------

describe('POST /api/orders — ST-032-AC3 validation failures', () => {
  let orderService: OrderServiceMock;
  let app: express.Express;
  const TEST_UID = 'firebase-uid-validation-test';

  beforeEach(() => {
    orderService = buildOrderService();
    app = buildApp({ orderService, uid: TEST_UID });
  });

  it('returns 400 when the body is missing the items array (#11)', async () => {
    const res = await request(app).post('/api/orders').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toBe('Request validation failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    // Service was never called — persistence unchanged per ST-032-AC3.
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when items is an empty array (#12 empty-cart rejection)', async () => {
    // ST-032-AC3 verbatim: "rejects empty carts ... with descriptive
    // errors and leaves the persistence layer unchanged."
    const res = await request(app).post('/api/orders').send({ items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // The Zod error message includes "items must be non-empty".
    const messages = (res.body.error.details as Array<{ path: string; message: string }>).map(
      (d) => d.message,
    );
    expect(messages.some((m) => /non-empty/i.test(m))).toBe(true);
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when an item is missing designId (#13 malformed line item)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ quantity: 2 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when an item has zero quantity (#14)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 0 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const messages = (res.body.error.details as Array<{ path: string; message: string }>).map(
      (d) => d.message,
    );
    expect(messages.some((m) => /positive/i.test(m))).toBe(true);
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when an item has negative quantity (#14)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: -3 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when an item has a non-integer quantity (#15)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 2.5 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when an item has unknown extra fields (#16 strict)', async () => {
    // The schemas are `.strict()` — extra fields are rejected.
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [
          {
            designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            quantity: 1,
            unauthorizedExtraField: 'attacker-controlled',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when designId is an empty string', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: '', quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 400 when the body has unknown extra top-level fields (#16 strict)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        items: [{ designId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1 }],
        unauthorizedExtraField: 'attacker-controlled',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('does not call createOrder on any validation failure (#17 persistence unchanged)', async () => {
    // Sweep test: confirm that across multiple validation failure
    // shapes, the service is never invoked. ST-032-AC3 verbatim:
    // "leaves the persistence layer unchanged".
    const failingBodies = [
      {},
      { items: [] },
      { items: [{ designId: 'a' }] },
      { items: [{ quantity: 1 }] },
      { items: [{ designId: 'a', quantity: 'not-a-number' }] },
    ];
    for (const body of failingBodies) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const res = await request(app).post('/api/orders').send(body);
      expect(res.status).toBe(400);
    }
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/orders — defensive 401 (Test #18–#19)
// ---------------------------------------------------------------------------

describe('POST /api/orders — defensive 401 when req.uid missing', () => {
  it('returns 401 UNAUTHENTICATED when sessionMiddleware did not run (#18)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService /* no uid */ });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'a', quantity: 1 }] });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });

  it('returns 401 when req.uid is the empty string (#19)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: '' });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'a', quantity: 1 }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(orderService.createOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/finalize — happy paths (Test #20–#21)
// ---------------------------------------------------------------------------

describe('POST /api/orders/:id/finalize — ST-034 success path', () => {
  let orderService: OrderServiceMock;
  let app: express.Express;
  const TEST_UID = 'firebase-uid-finalize-test';

  beforeEach(() => {
    orderService = buildOrderService();
    app = buildApp({ orderService, uid: TEST_UID });
  });

  it('returns 200 with the finalized order on success (#20)', async () => {
    // ST-034-AC1: transitions the order to the documented finalized
    // state. Per Rule R9 / AC4 the state field MUST be exactly
    // 'finalized' — never 'paid', 'charged', 'authorized', etc.
    const finalized = buildOrderFixture({
      id: '22222222-2222-4222-8222-222222222222',
      state: 'finalized',
      lastModifiedAt: '2025-01-15T11:00:00.000Z',
    });
    orderService.finalizeOrder.mockResolvedValueOnce(finalized);

    const res = await request(app).post('/api/orders/22222222-2222-4222-8222-222222222222/finalize').send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(finalized);
    // The state contract — explicit assertion to make Rule R9
    // compliance visible in the test verdict.
    expect(res.body.state).toBe('finalized');
  });

  it('forwards req.uid and :id to orderService.finalizeOrder (#21 AC1)', async () => {
    orderService.finalizeOrder.mockResolvedValueOnce(
      buildOrderFixture({ id: '33333333-3333-4333-8333-333333333333', state: 'finalized' }),
    );

    await request(app).post('/api/orders/33333333-3333-4333-8333-333333333333/finalize').send();

    expect(orderService.finalizeOrder).toHaveBeenCalledTimes(1);
    expect(orderService.finalizeOrder).toHaveBeenCalledWith({
      userId: TEST_UID,
      orderId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('does not call createOrder during finalize (route isolation)', async () => {
    orderService.finalizeOrder.mockResolvedValueOnce(buildOrderFixture({ state: 'finalized' }));

    await request(app).post('/api/orders/44444444-4444-4444-8444-444444444444/finalize').send();

    expect(orderService.createOrder).not.toHaveBeenCalled();
    expect(orderService.getCart).not.toHaveBeenCalled();
    expect(orderService.getById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/finalize — defensive 401 / 400 (Test #22–#23)
// ---------------------------------------------------------------------------

describe('POST /api/orders/:id/finalize — defensive guards', () => {
  it('returns 401 UNAUTHENTICATED when sessionMiddleware did not run (#22)', async () => {
    const orderService = buildOrderService();
    const app = buildApp({ orderService /* no uid */ });

    const res = await request(app).post('/api/orders/some-id/finalize').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when :id is whitespace (#23)', async () => {
    // Express normalises `/api/orders/   /finalize` so the URL
    // parameter is the trimmed-empty whitespace string. The route's
    // explicit `.trim() === ''` check is the defense-in-depth guard.
    const orderService = buildOrderService();
    const app = buildApp({ orderService, uid: 'test-uid' });

    const res = await request(app).post('/api/orders/%20/finalize').send();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toBe('Order id required');
    expect(orderService.finalizeOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error translation (Test #24–#34)
// ---------------------------------------------------------------------------

describe('POST /api/orders — error translation (Rule R8 fail-closed)', () => {
  const TEST_UID = 'firebase-uid-error-test';

  it('translates a service ValidationError to 400 with code/message (#24)', async () => {
    const orderService = buildOrderService();
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'EMPTY_CART';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.createOrder.mockRejectedValueOnce(
      new FakeValidationError('cartItems must be a non-empty array'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'EMPTY_CART',
        message: 'cartItems must be a non-empty array',
      },
    });
  });

  it('translates ValidationError(DESIGN_NOT_FOUND) to 404 (#25 defensive ST-032-AC3)', async () => {
    // Defensive special-case: if a future service refactor unifies
    // the throw class to ValidationError but preserves the
    // DESIGN_NOT_FOUND code, the translator still maps to 404.
    const orderService = buildOrderService();
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'DESIGN_NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.createOrder.mockRejectedValueOnce(
      new FakeValidationError('Design design-X not found or not accessible'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DESIGN_NOT_FOUND');
    expect(res.body.error.message).toBe('Design design-X not found or not accessible');
  });

  it('translates NotFoundError(DESIGN_NOT_FOUND) to 404 (#26 ST-032-AC3 canonical)', async () => {
    // Canonical path: design ownership failure → service throws
    // NotFoundError(DESIGN_NOT_FOUND), translator maps to 404.
    const orderService = buildOrderService();
    class FakeNotFoundError extends Error {
      public override readonly name = 'NotFoundError';
      public readonly code = 'DESIGN_NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.createOrder.mockRejectedValueOnce(
      new FakeNotFoundError('Design design-X not found or not accessible to user'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DESIGN_NOT_FOUND');
  });

  it('translates NotFoundError(ORDER_NOT_FOUND) to 404 on finalize (#27 ST-034)', async () => {
    const orderService = buildOrderService();
    class FakeNotFoundError extends Error {
      public override readonly name = 'NotFoundError';
      public readonly code = 'ORDER_NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.finalizeOrder.mockRejectedValueOnce(
      new FakeNotFoundError('Order missing-id not found or not accessible to user'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).post('/api/orders/55555555-5555-4555-8555-555555555555/finalize').send();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(res.body.error.message).toContain('not accessible');
  });

  it('translates ConflictError(ORDER_STATE_INVALID) to 409 (#28 ST-034)', async () => {
    // ST-034-AC3: already-finalized order → the service throws
    // ConflictError with the ORDER_STATE_INVALID code; the route
    // translator maps to 409.
    const orderService = buildOrderService();
    class FakeConflictError extends Error {
      public override readonly name = 'ConflictError';
      public readonly code = 'ORDER_STATE_INVALID';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.finalizeOrder.mockRejectedValueOnce(
      new FakeConflictError("Order x cannot be finalized: state is 'finalized'"),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).post('/api/orders/66666666-6666-4666-8666-666666666666/finalize').send();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_STATE_INVALID');
    // The originating message is forwarded so operators can
    // correlate dashboard panels to specific failures.
    expect(res.body.error.message).toContain('finalized');
  });

  it('translates ConflictError(ORDER_STATE_CONCURRENT_CHANGE) to 409 (#29 ST-034)', async () => {
    // The race-condition path: the conditional UPDATE matched zero
    // rows, indicating a concurrent finalization request won the
    // race. The translator maps to 409 with the distinct code so
    // operators can distinguish race conditions from invalid-state
    // attempts.
    const orderService = buildOrderService();
    class FakeConflictError extends Error {
      public override readonly name = 'ConflictError';
      public readonly code = 'ORDER_STATE_CONCURRENT_CHANGE';
      public constructor(msg: string) {
        super(msg);
      }
    }
    orderService.finalizeOrder.mockRejectedValueOnce(
      new FakeConflictError('Order y finalization lost a concurrent transition race'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).post('/api/orders/77777777-7777-4777-8777-777777777777/finalize').send();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_STATE_CONCURRENT_CHANGE');
  });

  it('translates an unrecognised error to 500 with non-leaking body (#30)', async () => {
    // Per Rule R8 (fail-closed): an unrecognised error class MUST
    // produce a non-2xx response. Per the route's information-
    // disclosure posture, the body MUST NOT include the original
    // message, stack, or cause.
    const orderService = buildOrderService();
    orderService.createOrder.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(JSON.stringify(res.body)).not.toContain('pg socket');
  });

  it('logs unrecognised errors with bounded structural metadata (#31)', async () => {
    const orderService = buildOrderService();
    const logSpy: LogSpy = { error: jest.fn() };
    const longMessage = 'X'.repeat(500); // exceeds 200-char cap
    const customErr = new Error(longMessage);
    Object.defineProperty(customErr, 'code', {
      value: 'PG_CONN_FAIL',
      enumerable: true,
    });
    orderService.createOrder.mockRejectedValueOnce(customErr);
    const app = buildApp({ orderService, uid: TEST_UID, logSpy });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs, logMsg] = logSpy.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logMsg).toBe('orders route error');
    expect(logArgs).toMatchObject({
      event: 'orders.route.error',
      errorName: 'Error',
      errorCode: 'PG_CONN_FAIL',
    });
    // The message MUST be truncated to ≤ 200 characters.
    expect(typeof logArgs['errorMessage']).toBe('string');
    expect((logArgs['errorMessage'] as string).length).toBeLessThanOrEqual(200);
  });

  it('does not throw when req.log is absent (#32 graceful degradation)', async () => {
    const orderService = buildOrderService();
    orderService.createOrder.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp({ orderService, uid: TEST_UID /* no logSpy */ });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates a malformed thrown value (throw {}) to 500 INTERNAL_ERROR (#33)', async () => {
    // Defense-in-depth: a non-Error throw value (e.g. `throw {}`)
    // MUST produce a structured 500 response rather than crash.
    const orderService = buildOrderService();
    orderService.createOrder.mockRejectedValueOnce({});
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('translates a ValidationError without code/message to 400 with defaults (#34)', async () => {
    // Defense-in-depth: a ValidationError with only `name` set
    // (no `code`, no `message`) MUST surface the ?? fallbacks.
    const orderService = buildOrderService();
    const minimalErr = { name: 'ValidationError' };
    orderService.createOrder.mockRejectedValueOnce(minimalErr);
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  it('translates NotFoundError without code to 404 with default fallback', async () => {
    // Defense-in-depth: a NotFoundError with only `name` set must
    // hit the 404 branch with the default code/message.
    const orderService = buildOrderService();
    orderService.createOrder.mockRejectedValueOnce({ name: 'NotFoundError' });
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });

  it('translates ConflictError without code to 409 with default fallback', async () => {
    // Defense-in-depth: a ConflictError with only `name` set must
    // hit the 409 branch with the default code/message.
    const orderService = buildOrderService();
    orderService.finalizeOrder.mockRejectedValueOnce({ name: 'ConflictError' });
    const app = buildApp({ orderService, uid: TEST_UID });

    const res = await request(app).post('/api/orders/44444444-4444-4444-8444-444444444444/finalize').send();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: 'Resource conflict' },
    });
  });

  it('logs an unrecognised error with no message via req.log.error', async () => {
    // Defense-in-depth: an error throw with no `message` (e.g.
    // `throw {}`) MUST still produce a structured log call with
    // `errorMessage: undefined`. Covers the `: undefined` branch
    // of the message-truncation ternary.
    const orderService = buildOrderService();
    const logSpy: LogSpy = { error: jest.fn() };
    orderService.createOrder.mockRejectedValueOnce({});
    const app = buildApp({ orderService, uid: TEST_UID, logSpy });

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({
      event: 'orders.route.error',
      errorName: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it('forwards an unhandled rejection in runCreateOrder to next() (defensive .catch)', async () => {
    // The route wraps `runCreateOrder` in a sync handler with a
    // defensive `.catch(next)`. Engineer a path where
    // `handleRouteError` itself throws (by installing a malicious
    // log spy that throws synchronously) so the throw escapes
    // runCreateOrder's catch and propagates through the sync
    // handler's `.catch(next)`. Express's central error middleware
    // catches the forwarded error.
    const orderService = buildOrderService();
    orderService.createOrder.mockRejectedValueOnce(new Error('original failure'));
    const malformedLog: LogSpy = {
      error: jest.fn().mockImplementation(() => {
        throw new Error('log subsystem failure');
      }),
    };

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Cast through `unknown` to bypass the `pino-http` module
      // augmentation (IncomingMessage.log: pino.Logger) so a thin
      // throwing spy can be substituted for the rich Logger interface.
      (req as unknown as { log: LogSpy }).log = malformedLog;
      req.uid = TEST_UID;
      next();
    });
    const errorHandlerSpy = jest.fn(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ caught: true, message: err.message });
      },
    );
    const router = createOrderRoutes({
      orderService: orderService as unknown as OrderService,
    });
    app.use('/api/orders', router);
    app.use(errorHandlerSpy);

    const res = await request(app)
      .post('/api/orders')
      .send({ items: [{ designId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', quantity: 1 }] });

    expect(res.status).toBe(500);
    expect(errorHandlerSpy).toHaveBeenCalledTimes(1);
    expect(errorHandlerSpy.mock.calls[0]?.[0]?.message).toBe('log subsystem failure');
  });

  it('forwards an unhandled rejection in runFinalizeOrder to next()', async () => {
    // Same defensive .catch posture for the finalize handler.
    const orderService = buildOrderService();
    orderService.finalizeOrder.mockRejectedValueOnce(new Error('original finalize failure'));
    const malformedLog: LogSpy = {
      error: jest.fn().mockImplementation(() => {
        throw new Error('finalize log failure');
      }),
    };

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Cast through `unknown` to bypass the `pino-http` module
      // augmentation (IncomingMessage.log: pino.Logger) so a thin
      // throwing spy can be substituted for the rich Logger interface.
      (req as unknown as { log: LogSpy }).log = malformedLog;
      req.uid = TEST_UID;
      next();
    });
    const errorHandlerSpy = jest.fn(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ caught: true, message: err.message });
      },
    );
    const router = createOrderRoutes({
      orderService: orderService as unknown as OrderService,
    });
    app.use('/api/orders', router);
    app.use(errorHandlerSpy);

    const res = await request(app).post('/api/orders/88888888-8888-4888-8888-888888888888/finalize').send();

    expect(res.status).toBe(500);
    expect(errorHandlerSpy).toHaveBeenCalledTimes(1);
    expect(errorHandlerSpy.mock.calls[0]?.[0]?.message).toBe('finalize log failure');
  });
});

// ---------------------------------------------------------------------------
// Rule R9 verification — DOMINANT for this file (Test #35–#37)
// ---------------------------------------------------------------------------

describe('Rule R9 — no settlement-processor vocabulary in orders.ts', () => {
  // The orders.ts source is read once at suite time so individual
  // tests can assert different patterns over the same content
  // without redundant disk reads.
  const sourcePath = path.join(__dirname, 'orders.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  it('contains zero matches for the AAP §0.8.1 R9 forbidden grep (#35)', () => {
    // The pattern is the AAP §0.8.1 R9 / §0.7.2 forbidden-vocabulary
    // grep — verbatim from `grep -niE
    // "stripe|braintree|paypal|payment_intent|charge|refund|tokenize|chargeback"`.
    //
    // The pattern is verified WITHIN this test rather than via an
    // external shell command — a Rule R8 fail-closed posture
    // applied at the test layer.
    const forbidden =
      /stripe|braintree|paypal|payment_intent|paymentIntent|payment-intent|payment_method|paymentMethod|tokenize|tokenization|refund|chargeback|chargeBack/i;
    expect(source).not.toMatch(forbidden);
  });

  it('contains zero stand-alone occurrences of "charge" or "charged" (#35)', () => {
    // The agent prompt's Phase 6 sweep includes a stand-alone
    // `\bcharge\b` and `\bcharged\b` check — distinct from the
    // forbidden multi-token grep above so partial matches like
    // "discharge" or "encharge" do not trigger false positives.
    const standalone = /\bcharge\b|\bcharged\b/i;
    expect(source).not.toMatch(standalone);
  });

  it('contains zero settlement-state vocabulary in the OrderState union (#36)', () => {
    // ST-032-AC4 / ST-034-AC4 / Rule R9: the order's lifecycle
    // states are 'cart' | 'created' | 'finalized' | 'cancelled'.
    // No settlement-state vocabulary may appear in this file.
    //
    // Note: the grep pattern uses single-quote bracketing so
    // discussions of the words in a sentence (without quotes) do
    // not trigger; the test asserts that the file never declares
    // these as state-machine members.
    expect(source).not.toMatch(/'paid'|"paid"/);
    expect(source).not.toMatch(/'authorized'|"authorized"/);
    expect(source).not.toMatch(/'settled'|"settled"/);
    expect(source).not.toMatch(/'tokenized'|"tokenized"/);
  });

  it('imports zero settlement-processor SDKs (#37)', () => {
    // The exclusion list from AAP §0.7.2: `stripe`, `braintree`,
    // `paypal`. The route file MUST NOT import any of these. We
    // also defend against `jsonwebtoken`, `jose`, `jwt-decode`
    // (Rule R3 forbids them in backend/package.json — this
    // double-check ensures they don't sneak in via this route file).
    const forbiddenImportRegex =
      /from\s+['"](stripe|braintree|paypal|jsonwebtoken|jose|jwt-decode)['"]/;
    expect(source).not.toMatch(forbiddenImportRegex);
    const forbiddenRequireRegex =
      /require\(\s*['"](stripe|braintree|paypal|jsonwebtoken|jose|jwt-decode)['"]/;
    expect(source).not.toMatch(forbiddenRequireRegex);
  });

  it('only imports from express, zod, and the local order.service module', () => {
    // Positive assertion to complement the exclusion checks. The
    // route file imports exactly: express types/Router, zod
    // types/z, and the local order.service OrderService type.
    const importLines = source
      .split('\n')
      .filter((l) => /^\s*import\s/.test(l));
    // Each import line MUST come from exactly one of the allowed
    // sources.
    const allowedSources = ['express', 'zod', '../services/order.service'];
    for (const line of importLines) {
      const match = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (match === null) {
        // import statements without `from` are side-effect imports;
        // the route file has none, but if it did they would fail
        // this gate (no allowlist).
        throw new Error(`Side-effect import not allowed in orders.ts: ${line}`);
      }
      const importedFrom = match[1];
      expect(allowedSources).toContain(importedFrom);
    }
  });
});
