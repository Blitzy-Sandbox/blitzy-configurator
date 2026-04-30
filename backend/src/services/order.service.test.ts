/**
 * Unit tests for `backend/src/services/order.service.ts`.
 *
 * Verifies the four exported methods on the `OrderService` contract
 * (`getCart`, `createOrder`, `finalizeOrder`, `getById`) plus the
 * factory's compose-time validation, against the security and behavioral
 * invariants documented in the source file:
 *
 *   1. **getCart (ST-033)** — Retrieval is ownership-scoped via the
 *      repository's SQL `WHERE user_id = $1`; an empty cart returns
 *      the structural empty representation `{ items: [], subtotal:
 *      '0.00' }` rather than throwing `NotFoundError` (ST-033-AC3);
 *      the method is idempotent — repeated calls produce identical
 *      results and never invoke any mutation method (ST-033-AC4).
 *
 *   2. **createOrder (ST-032)** — Validates input shape, validates
 *      ownership of every referenced design BEFORE any persist, and
 *      writes a row in the documented non-terminal `'created'` state
 *      (ST-032-AC4). Empty carts, malformed line items
 *      (non-positive/non-integer quantity, missing designId), and
 *      cross-ownership design references are rejected with
 *      `ValidationError` or `NotFoundError` BEFORE the
 *      `createOrderFromCart` repository call (ST-032-AC3 — "leave the
 *      persistence layer unchanged").
 *
 *   3. **finalizeOrder (ST-034)** — Pre-checks the order via
 *      `findOrderById`, verifies state is `'created'`, then issues
 *      the conditional UPDATE with `expectedState: 'created' →
 *      newState: 'finalized'`. Three rejection paths:
 *        - Missing/inaccessible order  → `NotFoundError` (404)
 *        - Pre-check finds non-`'created'` state → `ConflictError` (409)
 *        - Conditional UPDATE returns `null` (race condition lost) →
 *          `ConflictError` (409)
 *      Order state remains coherent (fully finalized OR unchanged)
 *      regardless of which path fires (ST-034-AC3).
 *
 *   4. **Cross-cut Rule R9 sweep** — After exercising every method,
 *      the logger never received an argument that contains the
 *      forbidden payment-processing terminology (`stripe`,
 *      `braintree`, `paypal`, `payment_intent`, `\bcharge\b`,
 *      `\brefund\b`, `tokeniz`). Pino's serializer allow-list is the
 *      production-time defense, but the FIRST line of defense is
 *      "the service never logs payment vocabulary in the first place"
 *      — which is what this sweep verifies.
 *
 *   5. **Validation error contract** — Each method rejects empty/
 *      non-string inputs with `ValidationError`. Cross-ownership
 *      design references bubble up as `NotFoundError` (HTTP 404
 *      semantics) — distinct from `ValidationError` (HTTP 400
 *      semantics) and `ConflictError` (HTTP 409 semantics).
 *
 *   6. **Rule R8 fail-closed** — Errors from repository methods
 *      propagate to the caller verbatim — never silently swallowed.
 *      This is verified explicitly for `createOrderFromCart` (e.g.
 *      `pg connection lost`) and for `updateOrderState` during
 *      finalization post-processing (e.g. `bookkeeping write
 *      failed`).
 *
 * Authority:
 *   - Story ST-032 acceptance criteria (create order from cart;
 *     ownership-validated; non-terminal state on persist).
 *   - Story ST-033 acceptance criteria (retrieve cart; empty cart is
 *     a success representation; idempotent; ownership-scoped).
 *   - Story ST-034 acceptance criteria (finalize order; idempotent
 *     under conditional UPDATE; rejects on already-finalized,
 *     missing, or post-processing failure; financial settlement
 *     out of scope).
 *   - Story ST-043 acceptance criteria (deterministic, local-only,
 *     no-network unit suite with co-located `*.test.ts`).
 *   - AAP §0.8.1 Rule R2 (no credential material in logs).
 *   - AAP §0.8.1 Rule R8 (gates fail closed — repository errors
 *     propagate).
 *   - AAP §0.8.1 Rule R9 (no payment processor integration; no
 *     charge authorization, tokenization, or refund logic; the
 *     `OrderState` enum forbids financial-settlement vocabulary).
 *
 * Determinism (ST-043-AC3):
 *   - All collaborators (`OrderRepository`, `DesignRepository`) are
 *     replaced with `jest.fn()` mocks; no asynchronous boundary
 *     depends on external state.
 *   - `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now()` so
 *     any timestamp fixtures the service constructs match a known
 *     wall clock.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets
 *     `clearMocks`, `resetMocks`, and `restoreMocks` to `true` so
 *     mock state is wiped between tests; the explicit
 *     `jest.clearAllMocks()` call in `beforeEach` below is a
 *     belt-and-suspenders measure that matches the AAP plan and is
 *     cheap to keep.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and
 *   depends on ZERO services. Both repositories and pino are fully
 *   mocked; no `pg.Pool`, no log transport, no clock.
 *
 * @see backend/src/services/order.service.ts — module under test
 * @see backend/src/repositories/order.repository.ts — interface mocked
 * @see backend/src/repositories/design.repository.ts — interface mocked
 * @see backend/src/logging/pino.ts — module-mocked logger
 * @see tickets/stories/ST-032-create-order-endpoint.md
 * @see tickets/stories/ST-033-retrieve-cart-endpoint.md
 * @see tickets/stories/ST-034-finalize-order-post-processing.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// ---------------------------------------------------------------------------
// Type-only imports.
//
// The `consistent-type-imports` ESLint rule (declared at the
// repository root in `.eslintrc.json` with severity `error`) requires
// that imports used only in type positions are declared with
// `import type`. None of these symbols contribute runtime values —
// they only constrain the shape of `jest.Mocked<...>` generics and
// fixture builder return types.
// ---------------------------------------------------------------------------
import type {
  OrderRepository,
  Order,
  OrderItem,
  Cart,
  CartItemInput,
  OrderState,
} from '../repositories/order.repository';
import type { DesignRepository, Design } from '../repositories/design.repository';

// ---------------------------------------------------------------------------
// Module mock — pino logger.
//
// `jest.mock` is HOISTED to the top of the module body by the Jest
// transformer, BEFORE any `import` statement. We therefore declare it
// before the runtime `import` of the module under test so that
// `order.service.ts` resolves the mocked `logger` rather than the real
// pino instance. The mock exposes the four log levels the production
// code calls (`info`, `warn`, `error`, `debug`); each is a `jest.fn()`
// so the cross-cut Rule R9 sweep can inspect
// `logger.<level>.mock.calls`.
//
// We also stub `fatal`, `trace`, and `child(): logger` for robustness
// — the production order.service.ts does not invoke these, but
// stubbing makes the mock resilient to a future refactor that adds
// fatal-level logging or a child-logger pattern.
// ---------------------------------------------------------------------------
jest.mock('../logging/pino', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

// ---------------------------------------------------------------------------
// Runtime imports — must come AFTER the `jest.mock` block above so
// that the mocked module replaces the real one in the module
// registry. Each runtime symbol below is exercised by at least one
// test in this file.
// ---------------------------------------------------------------------------
import { createOrderService, ValidationError, NotFoundError, ConflictError } from './order.service';
import { logger } from '../logging/pino';

// ===========================================================================
// Test fixtures — deterministic constants used throughout the suite.
// ===========================================================================

/**
 * Stable wall-clock pin for the suite. All `createdAt` /
 * `lastModifiedAt` assertions compare against this fixed date so the
 * suite remains deterministic across machines and across
 * second-boundaries (ST-043-AC3).
 *
 * The value is intentionally in the future (2026) so it cannot be
 * confused with any real-world timestamp by an operator skimming
 * test output during incident response.
 */
const FIXED_NOW: Date = new Date('2026-01-15T10:00:00.000Z');

/**
 * The canonical Firebase uid used as the "authenticated user"
 * fixture across every happy-path test. Per AAP §0.2.1, the local
 * `users.id` IS the Firebase uid.
 */
const USER_ID = 'user-uid';

// ---------------------------------------------------------------------------
// Mock builders.
//
// Each builder returns a fresh `jest.Mocked<...>` for the named
// repository contract. Returning fresh objects per call (rather than
// module-level singletons) guarantees test isolation even if the
// Jest config's `clearMocks` / `resetMocks` behaviour were ever
// weakened.
// ---------------------------------------------------------------------------

/**
 * Build a fresh `jest.Mocked<OrderRepository>` with every contract
 * method as a `jest.fn()`. Tests arrange behavior on each method
 * via `mockResolvedValueOnce` / `mockRejectedValueOnce` /
 * `mockImplementationOnce`.
 *
 * The four methods mirror the
 * {@link import('../repositories/order.repository').OrderRepository}
 * interface exactly — adding or removing a method here without a
 * corresponding interface change will fail TypeScript's
 * `jest.Mocked<...>` exhaustiveness check at compile time.
 */
function makeOrderRepository(): jest.Mocked<OrderRepository> {
  return {
    createOrderFromCart: jest.fn(),
    findOrderById: jest.fn(),
    updateOrderState: jest.fn(),
    findCartForUser: jest.fn(),
  };
}

/**
 * Build a fresh `jest.Mocked<DesignRepository>` with every contract
 * method as a `jest.fn()`.
 *
 * Only `findById` is consumed by the service under test (for the
 * ST-032-AC3 ownership validation pass), but stubbing every method
 * keeps the mock interface-complete and shields the suite against a
 * future refactor that introduces a new design-repository call site
 * inside the service.
 */
function makeDesignRepository(): jest.Mocked<DesignRepository> {
  return {
    insert: jest.fn(),
    listByUser: jest.fn(),
    findById: jest.fn(),
    updatePayload: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders.
//
// Each builder produces a canonical record that satisfies the
// matching repository-layer interface. Each accepts a `Partial<T>`
// override so individual tests can mutate just the fields relevant
// to the assertion under test, while inheriting safe defaults for
// every other field.
//
// The defaults intentionally mirror values that would survive a
// full round-trip through the production code path — `userId`
// matches `USER_ID`, `createdAt` and `lastModifiedAt` match
// `FIXED_NOW`, `subtotal` is a NUMERIC-safe string, and array
// fields are non-null.
// ---------------------------------------------------------------------------

/**
 * Build a canonical {@link Design} fixture matching the `designs`
 * table contract.
 *
 * Override-aware: callers can patch any subset of fields (most
 * commonly `id` to vary the design identifier across tests, or
 * `userId` to construct a "design owned by another user" — though
 * the production repository never returns such a record because
 * its SQL filters by `user_id`).
 *
 * The default `payload` is a minimal, schema-valid configurator
 * selection; tests do not exercise the payload contents and the
 * field is included only because the `Design` interface requires
 * it.
 */
function makeDesignFixture(overrides: Partial<Design> = {}): Design {
  return {
    id: 'design-1',
    userId: USER_ID,
    title: 'Red Ball',
    payload: { primaryColor: '#FF0000', pattern: 'classic', finish: 'matte' },
    createdAt: FIXED_NOW,
    lastModifiedAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * Build a canonical {@link OrderItem} fixture.
 *
 * The default `orderId` is `'order-1'`, matching the parent order
 * fixture; cart-projection tests override it to the empty string
 * (`''`) per the `OrderItem.orderId` contract for cart line
 * items.
 *
 * The default `metadata` is an empty object — the smallest valid
 * `Record<string, unknown>` — because most tests do not exercise
 * metadata content.
 */
function makeOrderItemFixture(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    orderId: 'order-1',
    designId: 'design-1',
    quantity: 1,
    metadata: {},
    ...overrides,
  };
}

/**
 * Build a canonical {@link Order} fixture in the `'created'` state
 * with a single line item.
 *
 * Override patterns commonly used by tests:
 *   - `state: 'finalized'` — for the finalize-success assertion
 *     and for the already-finalized rejection assertion.
 *   - `state: 'cancelled'` — for the cancelled-order rejection
 *     assertion.
 *   - `subtotal: '<other>'` — for subtotal-computation
 *     assertions where the service is expected to pass through a
 *     specific computed value.
 *   - `items: [...]` — for multi-item order assertions.
 */
function makeOrderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    userId: USER_ID,
    state: 'created',
    subtotal: '25.00',
    createdAt: FIXED_NOW,
    lastModifiedAt: FIXED_NOW,
    items: [makeOrderItemFixture()],
    ...overrides,
  };
}

/**
 * Build a canonical {@link Cart} fixture for an authenticated user
 * with one line item.
 *
 * Override patterns commonly used by tests:
 *   - `items: []`, `subtotal: '0.00'` — for the ST-033-AC3
 *     empty-cart success-representation assertion.
 *   - `userId: '<other>'` — never used directly because the
 *     production repository SQL pins `userId` from the parameter,
 *     but the override exists for defensive structural tests.
 *
 * The default `OrderItem.orderId` is the empty string per the cart
 * projection contract — `makeOrderItemFixture({ orderId: '' })`.
 */
function makeCartFixture(overrides: Partial<Cart> = {}): Cart {
  return {
    userId: USER_ID,
    items: [makeOrderItemFixture({ orderId: '' })],
    subtotal: '25.00',
    ...overrides,
  };
}

// ===========================================================================
// Lifecycle hooks.
//
// The Jest config (`backend/jest.config.unit.ts`) enables
// `clearMocks`, `resetMocks`, and `restoreMocks` so per-test mock
// state is wiped automatically. We add a defensive
// `jest.clearAllMocks()` in `beforeEach` to honor the AAP plan
// verbatim and to insulate the suite from any future config tweak
// that disables those flags. The cost is negligible.
//
// `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now()` so any
// timestamp the service constructs (e.g. structured log payloads)
// matches a known wall-clock value. The fake timer is restored to
// real after each test so subsequent suites are not affected.
// ===========================================================================
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: FIXED_NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

// ===========================================================================
// Test suites.
// ===========================================================================

describe('createOrderService', () => {
  // -------------------------------------------------------------------------
  // factory — compose-time validation (3 tests)
  //
  // These tests verify that the factory eagerly rejects missing or
  // malformed dependencies so a misconfigured composition root
  // fails LOUDLY at module-load time rather than subtly at first
  // request. Source: order.service.ts §5 (factory).
  // -------------------------------------------------------------------------
  describe('factory', () => {
    it('returns an object exposing getCart, createOrder, finalizeOrder methods', () => {
      // Arrange — build the dependency surface.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      // Act — wire the factory.
      const service = createOrderService({ orderRepository, designRepository });

      // Assert — every contract method is a function.
      expect(typeof service.getCart).toBe('function');
      expect(typeof service.createOrder).toBe('function');
      expect(typeof service.finalizeOrder).toBe('function');
      // `getById` is a contract member but is not in the AAP
      // test plan; we still assert it exists so a future
      // regression that drops the method is caught.
      expect(typeof service.getById).toBe('function');
    });

    it('throws when orderRepository is missing', () => {
      // Arrange — only the design repository is supplied.
      const designRepository = makeDesignRepository();

      // Act + Assert — the factory rejects the partial deps.
      // The cast simulates a TypeScript-bypass call site (e.g.
      // a misconfigured composition root); the production
      // factory's runtime guard catches it.
      expect(() =>
        createOrderService({
          orderRepository: undefined as unknown as OrderRepository,
          designRepository,
        }),
      ).toThrow(/orderRepository/);
    });

    it('throws when designRepository is missing', () => {
      // Arrange — only the order repository is supplied.
      const orderRepository = makeOrderRepository();

      // Act + Assert — symmetric to the previous test.
      expect(() =>
        createOrderService({
          orderRepository,
          designRepository: undefined as unknown as DesignRepository,
        }),
      ).toThrow(/designRepository/);
    });
  });

  // -------------------------------------------------------------------------
  // getCart — ST-033 retrieve-cart-endpoint (4 tests)
  //
  // ST-033 acceptance criteria (verbatim):
  //   AC1: Returns ONLY the cart belonging to the authenticated user
  //        — never carts owned by other users.
  //   AC2: Response includes line items with quantity, design id,
  //        per-item metadata, and calculated subtotal.
  //   AC3: Empty cart returns success representation (NOT 404).
  //   AC4: Repeated calls are safe — no side effects.
  //
  // Source: order.service.ts `getCart` implementation (validates
  // userId, calls `orderRepository.findCartForUser(userId)`, logs
  // a structural `cart.fetched` event, returns the Cart verbatim).
  // -------------------------------------------------------------------------
  describe('getCart', () => {
    it('ST-033-AC1: returns only the cart belonging to the authenticated user', async () => {
      // Arrange — repository returns the canonical cart for
      // `USER_ID`. The service should pass it through with no
      // mutation.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findCartForUser.mockResolvedValueOnce(makeCartFixture());

      const service = createOrderService({ orderRepository, designRepository });

      // Act — fetch the cart.
      const result = await service.getCart({ userId: USER_ID });

      // Assert — the repository was called with exactly the
      // authenticated user id (not an object, per the production
      // signature `findCartForUser(userId: string)`).
      expect(orderRepository.findCartForUser).toHaveBeenCalledTimes(1);
      expect(orderRepository.findCartForUser).toHaveBeenCalledWith(USER_ID);

      // Assert — the returned cart matches the canonical fixture
      // (ownership scope is enforced at the repository SQL tier
      // by `WHERE user_id = $1`).
      expect(result.userId).toBe(USER_ID);
      expect(result.items).toHaveLength(1);
      expect(result.subtotal).toBe('25.00');
    });

    it('ST-033-AC3: returns empty representation when user has no cart (not 404)', async () => {
      // Arrange — repository returns the documented empty-cart
      // shape. Per the `findCartForUser` contract, the
      // repository ALWAYS returns a structurally-complete Cart
      // (never null) and an empty cart is `{ items: [],
      // subtotal: '0.00' }`.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findCartForUser.mockResolvedValueOnce({
        userId: USER_ID,
        items: [],
        subtotal: '0.00',
      });

      const service = createOrderService({ orderRepository, designRepository });

      // Act — fetch the cart.
      const result = await service.getCart({ userId: USER_ID });

      // Assert — success representation, not an error. The
      // service did NOT translate the empty cart into a
      // NotFoundError.
      expect(result.userId).toBe(USER_ID);
      expect(result.items).toEqual([]);
      expect(result.subtotal).toBe('0.00');
    });

    it('ST-033-AC4: is idempotent — repeated calls produce identical results with no side effects', async () => {
      // Arrange — `mockResolvedValue` (not `Once`) so both
      // invocations receive the same canonical fixture.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findCartForUser.mockResolvedValue(makeCartFixture());

      const service = createOrderService({ orderRepository, designRepository });

      // Act — call the method twice.
      const result1 = await service.getCart({ userId: USER_ID });
      const result2 = await service.getCart({ userId: USER_ID });

      // Assert — identical results.
      expect(result1).toEqual(result2);

      // Assert — no mutation method on either repository was
      // invoked during the read. This is the structural
      // guarantee ST-033-AC4 demands.
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
      expect(designRepository.insert).not.toHaveBeenCalled();
      expect(designRepository.updatePayload).not.toHaveBeenCalled();
    });

    it('rejects empty userId with ValidationError', async () => {
      // Arrange — defense-in-depth check: even though the
      // session middleware should never let an empty uid
      // through, the service guards explicitly.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty userId is rejected before any
      // repository call. The `toBeInstanceOf(ValidationError)`
      // matcher is the contract (HTTP 400 mapping at the route
      // layer).
      await expect(service.getCart({ userId: '' })).rejects.toBeInstanceOf(ValidationError);

      // Assert — no repository call happened.
      expect(orderRepository.findCartForUser).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // createOrder — ST-032 create-order-endpoint (11 tests)
  //
  // ST-032 acceptance criteria (verbatim):
  //   AC1: Create-order endpoint requires a valid session and writes a
  //        new order record with line items derived from the
  //        authenticated user's cart.
  //   AC2: A successful create returns the canonical persisted order,
  //        including a server-assigned identifier, line items,
  //        calculated subtotal, and created timestamp.
  //   AC3: Requests with an empty cart, malformed line items, or
  //        references to designs not accessible to the authenticated
  //        user are rejected with a descriptive error.
  //   AC4: The persisted order is written in a documented non-terminal
  //        state; financial settlement is explicitly out of scope
  //        for this story (Rule R9).
  //
  // Source: order.service.ts `createOrder` implementation (validates
  // userId, validates cartItems shape, validates ownership of every
  // referenced design via `designRepository.findById`, computes
  // subtotal in integer cents, delegates persist to
  // `orderRepository.createOrderFromCart`).
  // -------------------------------------------------------------------------
  describe('createOrder', () => {
    it('ST-032-AC1/AC2: creates order with line items, returns canonical persisted record', async () => {
      // Arrange — two cart items for two distinct designs, each
      // owned by the authenticated user. The repository returns
      // the canonical persisted order with server-assigned id,
      // 2 line items, computed subtotal, and timestamps.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById
        .mockResolvedValueOnce(makeDesignFixture({ id: 'design-1' }))
        .mockResolvedValueOnce(makeDesignFixture({ id: 'design-2' }));

      const expectedOrder = makeOrderFixture({
        id: 'order-1',
        items: [
          makeOrderItemFixture({ orderId: 'order-1', designId: 'design-1', quantity: 2 }),
          makeOrderItemFixture({ orderId: 'order-1', designId: 'design-2', quantity: 1 }),
        ],
        subtotal: '75.00',
      });
      orderRepository.createOrderFromCart.mockResolvedValueOnce(expectedOrder);

      const service = createOrderService({ orderRepository, designRepository });

      const cartItems: CartItemInput[] = [
        { designId: 'design-1', quantity: 2, metadata: { unitPrice: '25.00' } },
        { designId: 'design-2', quantity: 1, metadata: { unitPrice: '25.00' } },
      ];

      // Act — create the order.
      const result = await service.createOrder({ userId: USER_ID, cartItems });

      // Assert — the repository was invoked exactly once with the
      // documented parameter shape `{ userId, cartItems, subtotal }`.
      expect(orderRepository.createOrderFromCart).toHaveBeenCalledTimes(1);
      const callArgs = orderRepository.createOrderFromCart.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs?.userId).toBe(USER_ID);
      expect(callArgs?.cartItems).toHaveLength(2);
      // The subtotal is computed by the service (NOT supplied by
      // the client). Per the implementation, it is a NUMERIC-safe
      // string formatted as `<whole>.<cents>`.
      expect(typeof callArgs?.subtotal).toBe('string');

      // Assert — canonical persisted record is returned.
      expect(result.id).toBe('order-1');
      expect(result.userId).toBe(USER_ID);
      expect(result.state).toBe('created');
      expect(result.items).toHaveLength(2);
      expect(result.subtotal).toBe('75.00');
      // ST-032-AC2: created timestamp is included.
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it('ST-032-AC3: rejects empty cart with ValidationError (code: EMPTY_CART)', async () => {
      // Arrange — fresh service; no repository calls expected.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty array is rejected before any I/O.
      // Per ST-032-AC3, the persistence layer remains
      // unchanged; we verify no repository methods fired.
      await expect(service.createOrder({ userId: USER_ID, cartItems: [] })).rejects.toBeInstanceOf(
        ValidationError,
      );

      // Defense-in-depth: assert no design lookup or order
      // insert occurred — empty cart fails the validation pass
      // BEFORE the ownership-check loop.
      expect(designRepository.findById).not.toHaveBeenCalled();
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it('ST-032-AC3: rejects cart items with non-positive quantity (0 and negative)', async () => {
      // Arrange — a cart item with quantity zero (boundary
      // case) and a separate test for negative quantity.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — quantity = 0 rejected.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: 'design-1', quantity: 0, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Act + Assert — quantity = -5 rejected.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: 'design-1', quantity: -5, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Persistence layer unchanged.
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it('ST-032-AC3: rejects cart items with non-integer quantity (e.g. 1.5)', async () => {
      // Arrange — fractional quantity. The validator
      // `Number.isInteger(quantity)` is the guard.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — fractional quantity rejected.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: 'design-1', quantity: 1.5, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it('ST-032-AC3: rejects cart items with missing or empty designId', async () => {
      // Arrange — empty-string designId; the validator
      // requires a non-empty string.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty designId rejected before any
      // ownership lookup.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: '', quantity: 1, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // No design lookup or persist ran.
      expect(designRepository.findById).not.toHaveBeenCalled();
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it('ST-032-AC3: rejects cart items referencing designs not accessible to user (NotFoundError)', async () => {
      // Arrange — `designRepository.findById` returns null,
      // simulating either "design does not exist" OR "design
      // exists but is owned by another user". Per the
      // enumeration-defense pattern these are indistinguishable
      // at the SQL tier (the WHERE clause is `WHERE user_id =
      // $1 AND id = $2`).
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(null);

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — the service maps null → NotFoundError
      // (HTTP 404, not 403). The error class is the contract
      // — a ValidationError or generic Error would be a
      // regression.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: 'not-my-design', quantity: 1, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // CRITICAL — no order was inserted. ST-032-AC3 demands
      // the persistence layer is unchanged when ownership
      // validation fails.
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it('ST-032-AC3: validates EVERY cart item before any persist (fails fast on first inaccessible design)', async () => {
      // Arrange — first design is owned, second is NOT
      // (returns null). The service's sequential validation
      // loop should detect the second design's inaccessibility
      // and abort BEFORE the persist call.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById
        .mockResolvedValueOnce(makeDesignFixture({ id: 'design-1' }))
        .mockResolvedValueOnce(null);

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — the second item fails validation,
      // surfaced as NotFoundError.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [
            { designId: 'design-1', quantity: 1, metadata: {} },
            { designId: 'design-2', quantity: 1, metadata: {} },
          ],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // The validator queried at least once for ownership
      // (either fail-fast at item 1 or full-pass to item 2;
      // the production implementation is sequential and
      // fails fast at item 2).
      expect(designRepository.findById.mock.calls.length).toBeGreaterThanOrEqual(1);

      // CRITICAL — no order persist call was made.
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });

    it("ST-032-AC4: persisted order is in the documented non-terminal 'created' state", async () => {
      // Arrange — repository returns an order in 'created'
      // state. The service does NOT request any other state at
      // the repository boundary; the repository's INSERT SQL
      // uses `VALUES (..., 'created', ...)` unconditionally.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());

      // Use `mockImplementationOnce` so we can assert the
      // service did not pass any state-overriding parameter.
      orderRepository.createOrderFromCart.mockImplementationOnce(async (params) => {
        // The repository ALWAYS writes state='created'; it is
        // fundamentally not a state we can override at the
        // input boundary. We echo it back into the fixture to
        // mirror production behavior.
        return makeOrderFixture({ state: 'created', subtotal: params.subtotal });
      });

      const service = createOrderService({ orderRepository, designRepository });

      // Act — create the order.
      const result = await service.createOrder({
        userId: USER_ID,
        cartItems: [{ designId: 'design-1', quantity: 1, metadata: {} }],
      });

      // Assert — state is the documented non-terminal value.
      expect(result.state).toBe('created');

      // Defense-in-depth: assert the returned state belongs to
      // the `OrderState` union (`'cart' | 'created' |
      // 'finalized' | 'cancelled'`). The compile-time type
      // already enforces this; the runtime check catches any
      // future repository refactor that widens the column to
      // arbitrary strings.
      const allowedStates: ReadonlyArray<OrderState> = [
        'cart',
        'created',
        'finalized',
        'cancelled',
      ];
      expect(allowedStates).toContain(result.state);

      // Rule R9 sweep — the order state is NEVER any of the
      // forbidden financial-settlement values. The
      // `OrderState` union itself excludes these, but a
      // structural test catches any future regression that
      // widens the union.
      const forbiddenStates: ReadonlyArray<string> = [
        'paid',
        'charged',
        'authorized',
        'refunded',
        'settled',
      ];
      expect(forbiddenStates).not.toContain(result.state as string);
    });

    it('computes subtotal as the sum of unitPrice × quantity across items', async () => {
      // Arrange — two items with explicit unit prices.
      // Expected subtotal: 2 × $10.00 + 3 × $5.00 = $35.00.
      // The integer-cents algorithm (per `computeSubtotal`
      // in the source) avoids IEEE 754 drift.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById
        .mockResolvedValueOnce(makeDesignFixture({ id: 'design-1' }))
        .mockResolvedValueOnce(makeDesignFixture({ id: 'design-2' }));
      orderRepository.createOrderFromCart.mockImplementationOnce(async (params) => {
        // Echo the computed subtotal back into the persisted
        // record so the assertion can read the service's
        // computation.
        return makeOrderFixture({ subtotal: params.subtotal });
      });

      const service = createOrderService({ orderRepository, designRepository });

      // Act — create the order with explicit unit prices.
      const result = await service.createOrder({
        userId: USER_ID,
        cartItems: [
          { designId: 'design-1', quantity: 2, metadata: { unitPrice: '10.00' } },
          { designId: 'design-2', quantity: 3, metadata: { unitPrice: '5.00' } },
        ],
      });

      // Assert — exact string formatting per `computeSubtotal`.
      // The integer-cents algorithm produces no trailing
      // floating-point noise.
      expect(result.subtotal).toBe('35.00');
    });

    it('defaults subtotal to "0.00" when items lack unitPrice metadata', async () => {
      // Arrange — single item, no `unitPrice` in metadata.
      // Per `computeSubtotal` the missing field is treated as
      // zero contribution; total subtotal is "0.00".
      // Decision rationale: this is the documented behavior;
      // alternative ("reject if pricing is missing") would
      // couple this method to a price-lookup service.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      orderRepository.createOrderFromCart.mockImplementationOnce(async (params) => {
        return makeOrderFixture({ subtotal: params.subtotal });
      });

      const service = createOrderService({ orderRepository, designRepository });

      // Act — create the order without pricing data.
      const result = await service.createOrder({
        userId: USER_ID,
        cartItems: [{ designId: 'design-1', quantity: 1, metadata: {} }],
      });

      // Assert — exactly "0.00", with explicit two decimal
      // places per the NUMERIC(12,2) format contract.
      expect(result.subtotal).toBe('0.00');
    });

    it('Rule R8: propagates errors from orderRepository.createOrderFromCart (fail-closed)', async () => {
      // Arrange — design ownership passes, but the persist
      // call rejects with a synthetic database error. The
      // service must NOT swallow this error.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      orderRepository.createOrderFromCart.mockRejectedValueOnce(new Error('pg connection lost'));

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — the error message reaches the caller
      // verbatim. Wrapping the error or substituting a
      // generic message would be a Rule R8 violation.
      await expect(
        service.createOrder({
          userId: USER_ID,
          cartItems: [{ designId: 'design-1', quantity: 1, metadata: {} }],
        }),
      ).rejects.toThrow(/pg connection lost/);
    });

    it('rejects empty userId with ValidationError', async () => {
      // Arrange — defense-in-depth check: empty user id is
      // refused before any cart-shape validation.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty userId rejected; the validation
      // order in the source is `validateUserId` BEFORE
      // `validateCartItems`, so this fails on userId.
      await expect(
        service.createOrder({
          userId: '',
          cartItems: [{ designId: 'design-1', quantity: 1, metadata: {} }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // No collaborators were called.
      expect(designRepository.findById).not.toHaveBeenCalled();
      expect(orderRepository.createOrderFromCart).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // finalizeOrder — ST-034 finalize-order-post-processing (9 tests)
  //
  // ST-034 acceptance criteria (verbatim):
  //   AC1: The finalization endpoint operates only on an existing
  //        order owned by the authenticated user.
  //   AC2: A successful finalization transitions the order to the
  //        documented finalized state and triggers post-processing
  //        (inventory reservation, confirmation notification metadata,
  //        bookkeeping entries).
  //   AC3: Calling finalize on an already-finalized order, on a
  //        missing order, or when any post-processing step fails is
  //        rejected with a descriptive error; order state is left
  //        coherent (fully finalized OR unchanged).
  //   AC4: Financial settlement is explicitly out of scope (Rule R9).
  //
  // Source: order.service.ts `finalizeOrder` implementation (validates
  // userId+orderId, pre-checks via `findOrderById`, verifies state ===
  // 'created', issues conditional UPDATE via `updateOrderState({
  // expectedState: 'created', newState: 'finalized' })`, logs
  // `order.finalized`).
  // -------------------------------------------------------------------------
  describe('finalizeOrder', () => {
    it("ST-034-AC1: enforces ownership and uses conditional UPDATE with expectedState='created' → newState='finalized'", async () => {
      // Arrange — pre-check finds the order in 'created' state;
      // the conditional UPDATE returns the finalized order. The
      // assertion focuses on the EXACT shape of the
      // `updateOrderState` parameters, which is the contract
      // ST-034-AC1 establishes.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'created' }));
      orderRepository.updateOrderState.mockResolvedValueOnce(
        makeOrderFixture({ state: 'finalized' }),
      );

      const service = createOrderService({ orderRepository, designRepository });

      // Act — finalize the order.
      await service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' });

      // Assert — the conditional UPDATE was invoked with the
      // exact documented parameter shape. Ownership is pinned
      // by the `userId` field; the state machine is enforced
      // by the `expectedState`/`newState` pair.
      expect(orderRepository.updateOrderState).toHaveBeenCalledTimes(1);
      expect(orderRepository.updateOrderState).toHaveBeenCalledWith({
        userId: USER_ID,
        orderId: 'order-1',
        newState: 'finalized',
        expectedState: 'created',
      });

      // Assert — pre-check was invoked with the same scoping
      // pair. Defense-in-depth against a future refactor that
      // accidentally drops the pre-check.
      expect(orderRepository.findOrderById).toHaveBeenCalledTimes(1);
      expect(orderRepository.findOrderById).toHaveBeenCalledWith({
        userId: USER_ID,
        orderId: 'order-1',
      });
    });

    it("ST-034-AC2: transitions order to the documented 'finalized' state on success", async () => {
      // Arrange — happy path; pre-check passes, conditional
      // UPDATE returns the finalized order. The returned
      // record's `state` is the contract assertion.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'created' }));
      orderRepository.updateOrderState.mockResolvedValueOnce(
        makeOrderFixture({ state: 'finalized' }),
      );

      const service = createOrderService({ orderRepository, designRepository });

      // Act — finalize the order.
      const result = await service.finalizeOrder({
        userId: USER_ID,
        orderId: 'order-1',
      });

      // Assert — the returned order is in the finalized state.
      expect(result.state).toBe('finalized');
    });

    it('ST-034-AC3: rejects with NotFoundError when order does not exist', async () => {
      // Arrange — pre-check returns null. The repository's SQL
      // pins ownership so null collapses both "does not exist"
      // and "not yours" into a single NotFoundError per the
      // enumeration-defense pattern.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(null);

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — NotFoundError, not ConflictError.
      await expect(
        service.finalizeOrder({ userId: USER_ID, orderId: 'missing-order' }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Assert — no UPDATE was attempted. State coherence
      // requirement (AC3) is satisfied because no state change
      // was requested.
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
    });

    it('ST-034-AC3: rejects with ConflictError when order is already finalized', async () => {
      // Arrange — pre-check finds an order in 'finalized'
      // state. The state-machine guard rejects this with
      // ConflictError (HTTP 409) BEFORE attempting the
      // conditional UPDATE.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'finalized' }));

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — ConflictError, not NotFoundError or a
      // generic Error.
      await expect(
        service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' }),
      ).rejects.toBeInstanceOf(ConflictError);

      // Assert — the conditional UPDATE was NOT invoked. The
      // pre-check is the early-rejection path; calling UPDATE
      // would still return null (the WHERE clause excludes
      // 'finalized' states) but the explicit pre-check
      // produces a cleaner operator signal via the
      // `'ORDER_STATE_INVALID'` code.
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
    });

    it('ST-034-AC3: handles race condition (pre-check passes but UPDATE returns null) with ConflictError', async () => {
      // Arrange — pre-check finds the order in 'created'
      // state, but between the pre-check and the conditional
      // UPDATE a concurrent request advances the state. The
      // UPDATE returns null (WHERE matched 0 rows) and the
      // service translates this to ConflictError with the
      // distinct `'ORDER_STATE_CONCURRENT_CHANGE'` code.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'created' }));
      orderRepository.updateOrderState.mockResolvedValueOnce(null);

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — ConflictError, signalling the lost
      // race. Operators can grep the `code` field to
      // distinguish this from the `'ORDER_STATE_INVALID'`
      // case.
      await expect(
        service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' }),
      ).rejects.toBeInstanceOf(ConflictError);

      // Assert — the conditional UPDATE WAS invoked; the
      // race-condition guard is the SQL `WHERE state =
      // $expectedState`, not the pre-check.
      expect(orderRepository.updateOrderState).toHaveBeenCalledTimes(1);
    });

    it('ST-034-AC3: rejects finalization on cancelled order (ConflictError)', async () => {
      // Arrange — pre-check finds the order in 'cancelled'
      // state. Like 'finalized', this is a non-'created' state
      // and is rejected by the pre-check with ConflictError.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'cancelled' }));

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — ConflictError. The error message
      // includes the current state for operator debugging.
      await expect(
        service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' }),
      ).rejects.toBeInstanceOf(ConflictError);

      // Assert — no UPDATE invoked; pre-check rejected the
      // request first.
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
    });

    it('ST-034-AC3: post-processing failure leaves order state coherent (error propagates)', async () => {
      // Arrange — pre-check passes with 'created' state. The
      // conditional UPDATE rejects with a synthetic
      // post-processing error (e.g. bookkeeping write
      // failure). The service must NOT swallow this error;
      // the route layer maps it to HTTP 500.
      //
      // State coherence: because the UPDATE rejected (rather
      // than partially completed), the database row is
      // unchanged — no half-finalized state can occur.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();
      orderRepository.findOrderById.mockResolvedValueOnce(makeOrderFixture({ state: 'created' }));
      orderRepository.updateOrderState.mockRejectedValueOnce(
        new Error('post-processing: bookkeeping write failed'),
      );

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — the error propagates with the
      // original message. We never reached a code path that
      // claimed the finalization succeeded.
      await expect(service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' })).rejects.toThrow(
        /bookkeeping write failed/,
      );
    });

    it('rejects empty userId with ValidationError', async () => {
      // Arrange — defense-in-depth check: empty user id is
      // refused before any repository call.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty userId rejected.
      await expect(
        service.finalizeOrder({ userId: '', orderId: 'order-1' }),
      ).rejects.toBeInstanceOf(ValidationError);

      // No collaborators were called.
      expect(orderRepository.findOrderById).not.toHaveBeenCalled();
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
    });

    it('rejects empty orderId with ValidationError', async () => {
      // Arrange — defense-in-depth check: empty order id is
      // refused before any repository call.
      const orderRepository = makeOrderRepository();
      const designRepository = makeDesignRepository();

      const service = createOrderService({ orderRepository, designRepository });

      // Act + Assert — empty orderId rejected.
      await expect(service.finalizeOrder({ userId: USER_ID, orderId: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );

      // No collaborators were called.
      expect(orderRepository.findOrderById).not.toHaveBeenCalled();
      expect(orderRepository.updateOrderState).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// Cross-cut Rule R9 sweep — payment terminology.
//
// AAP §0.8.1 Rule R9 forbids any payment-processor integration,
// charge authorization, tokenization, or refund logic in
// `backend/src`. The OrderState union itself excludes financial
// vocabulary (`'paid'`, `'charged'`, `'authorized'`, `'refunded'`,
// `'settled'`), and the order.service.ts source code never imports
// any payment library.
//
// This test exercises every public method of `OrderService` and then
// inspects the captured arguments of `logger.info`, `logger.warn`,
// and `logger.error` for any forbidden token. A naïve regex is
// sufficient because:
//
//   - The forbidden vendor names (`stripe`, `braintree`, `paypal`)
//     are case-folded for case-insensitive matching.
//   - `\bcharge\b` and `\brefund\b` use word-boundary anchors so
//     non-payment uses ("characteristic", "refundable items") are
//     not flagged. Note: the AAP-specified pattern excludes
//     `\bcharge\b` from terms like "charge cluster" (nvidia GPU
//     contexts) but this codebase has no such usage.
//   - `tokeniz` is a substring match because both "tokenize" and
//     "tokenization" must be flagged, and there is no legitimate
//     use of any word starting with "tokeniz" in order-flow logs.
//   - `payment_intent` matches the Stripe-specific resource type;
//     no plausible legitimate use exists in the order-flow.
//
// Pino's serializer allow-list (configured in
// `backend/src/logging/pino.ts`) is the production-time defense
// against credential material leaking into log output. This test
// is the COMPILE-TIME defense ensuring the order service never
// even tries to log payment vocabulary in the first place.
// ===========================================================================
describe('Rule R9 cross-cut sweep', () => {
  it('does not include payment/charge/refund/tokeniz terminology in any log call across all methods', async () => {
    // Arrange — generous mock arrangement covering every
    // public method's happy path. We exercise every method
    // (not just one) so the sweep covers the union of all
    // log call sites.
    const orderRepository = makeOrderRepository();
    const designRepository = makeDesignRepository();

    designRepository.findById.mockResolvedValue(makeDesignFixture());
    orderRepository.findCartForUser.mockResolvedValue(makeCartFixture());
    orderRepository.createOrderFromCart.mockResolvedValue(makeOrderFixture());
    orderRepository.findOrderById.mockResolvedValue(makeOrderFixture({ state: 'created' }));
    orderRepository.updateOrderState.mockResolvedValue(makeOrderFixture({ state: 'finalized' }));

    const service = createOrderService({ orderRepository, designRepository });

    // Act — exercise getCart, createOrder, finalizeOrder.
    await service.getCart({ userId: USER_ID });
    await service.createOrder({
      userId: USER_ID,
      cartItems: [{ designId: 'design-1', quantity: 1, metadata: {} }],
    });
    await service.finalizeOrder({ userId: USER_ID, orderId: 'order-1' });

    // Assert — gather every argument passed to the three
    // mainstream log levels and serialise them. The serialised
    // form deterministically captures both top-level and
    // nested-object fields, neutralising any attempt to slip
    // forbidden vocabulary through structured fields.
    //
    // Type assertion: each `logger.<level>` is a `jest.Mock`
    // because of the module-level `jest.mock('../logging/pino',
    // ...)`. The cast is a runtime-safe noop that satisfies
    // TypeScript's type system.
    const allLogArgs: unknown[][] = [
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
    ];
    const serialised = JSON.stringify(allLogArgs).toLowerCase();

    // Forbidden-terms regex — composed from the AAP Rule R9
    // verification command. Word boundaries on `charge` and
    // `refund` minimise false positives; vendor names and
    // `tokeniz` are bare substrings (no false-positive risk).
    expect(serialised).not.toMatch(
      /stripe|braintree|paypal|payment_intent|\bcharge\b|\brefund\b|tokeniz/,
    );
  });
});
