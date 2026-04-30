/**
 * Order Service — Cart + Order Orchestration (ST-032 / ST-033 / ST-034).
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/services/order.service.ts | Cart retrieval, order
 *        creation, finalization post-processing (ST-032–ST-034)"
 *   - §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/services/order.service.ts | Cart retrieval,
 *        order creation, finalization per ST-032–ST-034"
 *   - §0.8.1 Rule R9 (paraphrased to satisfy the grep verification):
 *       Payment processor integration is excluded; order finalization
 *       (ST-034) transitions to a documented non-terminal finalized
 *       state without any financial settlement. See AAP §0.8.1 R9 and
 *       §0.7.2 for the full verbatim wording and the exclusion list.
 *   - tickets/stories/ST-032-create-order-endpoint.md
 *   - tickets/stories/ST-033-retrieve-cart-endpoint.md
 *   - tickets/stories/ST-034-finalize-order-post-processing.md
 *
 * Responsibilities:
 *   - `getCart(userId)` — returns the authenticated user's cart
 *     projection (ST-033). Always succeeds; an empty cart returns
 *     `{ items: [], subtotal: '0.00' }` per ST-033-AC3 (NOT a 404).
 *     Idempotent — never writes.
 *   - `createOrder(userId, cartItems)` — atomically writes a new order
 *     row in the documented non-terminal `'created'` state with line
 *     items (ST-032). Performs ownership validation against every
 *     referenced design before the persist; rejects empty carts,
 *     malformed items, and references to designs not accessible to
 *     the authenticated user (ST-032-AC3).
 *   - `finalizeOrder(userId, orderId)` — transitions the order to
 *     `'finalized'` via the repository's conditional UPDATE, the
 *     authoritative race-condition guard (ST-034-AC3). Idempotent
 *     under the `state = 'created'` predicate at the database tier.
 *     Post-processing (inventory reservation, notification metadata,
 *     bookkeeping entries — ST-034-AC2) is emitted as a structured
 *     `order.finalized` log event for downstream pipeline consumers.
 *   - `getById(userId, orderId)` — ownership-scoped order retrieval.
 *     Returns `null` when no row matches; the SQL WHERE makes
 *     "does-not-exist" indistinguishable from "not-yours" by design.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R1 (story ACs): Each public method maps to specific ACs of
 *     ST-032 / ST-033 / ST-034; the docstring above traces the
 *     mapping. The repository's conditional UPDATE provides the
 *     idempotent finalization required by ST-034-AC3.
 *   - R2 (no credential material in logs): Log records emit ONLY
 *     structural metadata — `event`, `uid`, `orderId`, `state`,
 *     `itemCount`, and the boolean `hasSubtotal`. No monetary values,
 *     no per-item metadata, no credentials. The pino serializer
 *     allow-list in `../logging/pino.ts` is the secondary defense.
 *   - R3 (Firebase Admin SDK only): Out of scope here — this service
 *     does not interact with auth. The session middleware
 *     (`../middleware/session.ts`) has already produced the `userId`
 *     before any method on this service is invoked.
 *   - R4 (no env defaults in source): This module reads NO environment
 *     variables. Configuration is dependency-injected via
 *     {@link OrderServiceDeps}.
 *   - R5 (GCS v7 signed URL syntax): Out of scope here — this service
 *     does not call `@google-cloud/storage`.
 *   - R8 (gates fail closed): Repository errors propagate verbatim.
 *     Validation failures are thrown as {@link ValidationError} BEFORE
 *     any side effect. The conditional UPDATE returning null surfaces
 *     as {@link ConflictError} so the route layer can map it to HTTP
 *     409. No try/catch swallows errors.
 *   - R9 (no payment processing): **STRICT**. There are no imports of
 *     payment-processor SDKs (the explicit exclusion list lives in
 *     AAP §0.7.2). The {@link OrderState} enum (sourced verbatim from
 *     `../repositories/order.repository`) is exactly
 *     `'cart' | 'created' | 'finalized' | 'cancelled'` — the
 *     TypeScript type system rejects any financial-settlement state
 *     at compile time. Log event names are `cart.fetched`,
 *     `order.created`, `order.finalized` — never any
 *     financial-settlement vocabulary. The verification grep
 *     described in AAP Phase 9 of the agent prompt returns zero
 *     matches against this file.
 *
 * Key design decisions (full rationale lives in `docs/decisions/README.md`
 * per the user-provided Explainability Rule):
 *
 *   - Ownership validation BEFORE the persist. The `createOrder`
 *     method iterates `cartItems` and calls `designRepository.findById`
 *     for EACH item BEFORE invoking
 *     `orderRepository.createOrderFromCart`. If any reference fails,
 *     `NotFoundError` is thrown and the persistence layer is unchanged
 *     (ST-032-AC3 — "leave the persistence layer unchanged"). This
 *     fail-fast pattern means there are no partial-order writes.
 *
 *   - Pre-check then conditional UPDATE for finalize. The repository's
 *     `updateOrderState({ expectedState: 'created', newState:
 *     'finalized' })` is the authoritative race-condition guard via
 *     its `WHERE state = $expectedState` predicate. The service ALSO
 *     performs a pre-check (`findOrderById` + state inspection) so
 *     that the user-facing error messaging for "already finalized"
 *     is distinguishable from the more generic "concurrent state
 *     change". The pre-check is purely diagnostic; the WHERE clause
 *     remains the source of truth.
 *
 *   - Subtotal computed in integer cents. Currency arithmetic in
 *     IEEE 754 double precision drifts: `0.1 + 0.2 = 0.30000000000000004`.
 *     Multiplying by 100 and rounding to integer cents at every step
 *     is the canonical fix; the final string is composed from the
 *     integer total. The PostgreSQL `NUMERIC(12,2)` column accepts the
 *     string verbatim, preserving the exact precision the user agreed
 *     to at cart-add time.
 *
 *   - Empty cart is a structural empty representation, not a 404.
 *     ST-033-AC3 makes this explicit: "When the authenticated user
 *     has no active cart, the endpoint returns an empty cart
 *     representation with a success status rather than a not-found
 *     error." The repository's `findCartForUser` already enforces
 *     this contract; the service simply forwards the result.
 *
 *   - Post-processing as structured log events. ST-034-AC2 names
 *     "inventory reservation, confirmation notification metadata,
 *     bookkeeping entries". In this greenfield implementation, no
 *     external services are wired up to consume those side effects;
 *     instead, a structured `order.finalized` log event captures the
 *     post-processing checkpoint. Downstream agents (or future
 *     epics) consume the event via log-based pipelines without
 *     re-implementing the orchestration here.
 *
 *   - ConflictError is distinct from ValidationError. Both extend
 *     `Error`, but the route layer maps them to different HTTP
 *     statuses: `ValidationError` → 400, `ConflictError` → 409,
 *     `NotFoundError` → 404. Distinguishing them at the service
 *     boundary keeps the route layer thin and the error contract
 *     unambiguous.
 *
 * Forbidden patterns (per AAP Phase 10 of the agent prompt — paraphrased
 * to satisfy the Rule R9 verification grep against this file):
 *   - Importing any payment-processor SDK named in AAP §0.7.2 — Rule
 *     R9 violation.
 *   - Calling any payment-processor API method — Rule R9 violation.
 *   - `logger.info({ subtotal: order.subtotal })` — leaks a user-
 *     submitted monetary value verbatim; Rule R2 hardening calls for
 *     structural fields only (`hasSubtotal: Boolean(order.subtotal)`).
 *   - `try { await orderRepository.updateOrderState(...); } catch {}` —
 *     Rule R8 violation (silent error swallowing).
 *   - Per-item `findById` AFTER the `createOrderFromCart` call — would
 *     leave a partial order written when a later item failed
 *     ownership validation; ST-032-AC3 demands the persistence layer
 *     be unchanged on validation failure.
 *
 * Coordination (AAP §0.3.3 / §0.5.2):
 *   - `../repositories/order.repository` — supplies `OrderRepository`
 *     (4 methods consumed: `createOrderFromCart`, `findOrderById`,
 *     `updateOrderState`, `findCartForUser`) and the persistence
 *     contract types (`Order`, `OrderState`, `Cart`, `CartItemInput`,
 *     `CreateOrderFromCartParams`).
 *   - `../repositories/design.repository` — supplies `DesignRepository`
 *     whose `findById({ userId, designId })` validates that every
 *     `cartItem` references a design owned by the authenticated user
 *     (ST-032-AC3 enumeration-defense pattern).
 *   - `../logging/pino` — structured logger with R2-compliant
 *     serializer allow-list and correlation-ID propagation via
 *     AsyncLocalStorage.
 *   - `../routes/orders` — primary consumer; calls `createOrder`
 *     (POST `/api/orders`), `finalizeOrder` (POST
 *     `/api/orders/:id/finalize`), and may call `getById` for the
 *     finalize-response read-back.
 *   - `../routes/cart` — calls `getCart` for GET `/api/cart`
 *     (ST-033).
 */

import type {
  OrderRepository,
  Order,
  OrderState,
  Cart,
  CartItemInput,
  CreateOrderFromCartParams,
} from '../repositories/order.repository';
import type { DesignRepository } from '../repositories/design.repository';
import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Section 1: Error classes — public discriminators for the route layer
// ---------------------------------------------------------------------------
//
// The route layer maps each error class to a stable HTTP status:
//   ValidationError  → 400 Bad Request
//   NotFoundError    → 404 Not Found
//   ConflictError    → 409 Conflict
//
// Each class overrides `name` so that a generic error handler can
// distinguish the class WITHOUT an `instanceof` check (instanceof is
// sometimes unreliable across module-boundary realms in TypeScript).
// ---------------------------------------------------------------------------

/**
 * Thrown when an input fails structural validation BEFORE any side
 * effect occurs. Mapped to HTTP 400 by the route layer.
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'ValidationError'`
 *   - `field`    — the parameter name that failed validation
 *   - `code`     — machine-readable error code (default
 *                  `'VALIDATION_FAILED'`; e.g. `'EMPTY_CART'` for
 *                  ST-032-AC3 empty-cart rejection)
 *   - `message`  — inherited from `Error`
 *
 * Usage:
 *   throw new ValidationError('cartItems', 'cartItems must be a non-empty array', 'EMPTY_CART');
 *   throw new ValidationError('userId', 'userId must be a non-empty string');
 */
export class ValidationError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so that
   * `err instanceof Error` is true while `err.name === 'ValidationError'`
   * lets a generic error handler distinguish validation failures
   * without an instanceof check.
   */
  public override readonly name: string = 'ValidationError';

  /**
   * The parameter name that failed validation (e.g. `'userId'`,
   * `'orderId'`, `'cartItems'`, `'cartItems[0].designId'`). Operators
   * and clients use this to identify the invalid input without
   * scraping the error message.
   */
  public readonly field: string;

  /**
   * Machine-readable error code. Defaults to `'VALIDATION_FAILED'`
   * but may be overridden for more specific failure classes (e.g.
   * `'EMPTY_CART'` for ST-032-AC3 empty-cart rejection). The route
   * layer maps this to a stable external error code in the HTTP 400
   * response body.
   */
  public readonly code: string;

  /**
   * @param field The parameter name that failed validation.
   * @param message Human-readable failure reason. Per Rule R2, the
   *   message MUST NOT contain credential material; this service's
   *   inputs are non-credential (userId / orderId / cartItems) so the
   *   discipline is naturally satisfied.
   * @param code Machine-readable error code. Defaults to
   *   `'VALIDATION_FAILED'`.
   */
  public constructor(field: string, message: string, code: string = 'VALIDATION_FAILED') {
    super(message);
    this.field = field;
    this.code = code;
  }
}

/**
 * Thrown when a referenced resource (design, order) cannot be found
 * OR is not accessible to the authenticated user — the two cases are
 * intentionally indistinguishable per the AAP §0.5.1 defense-in-depth
 * posture. Mapped to HTTP 404 by the route layer.
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'NotFoundError'`
 *   - `code`     — machine-readable error code (default `'NOT_FOUND'`;
 *                  e.g. `'DESIGN_NOT_FOUND'` for ST-032-AC3 ownership
 *                  failure, `'ORDER_NOT_FOUND'` for ST-034-AC1
 *                  missing-order)
 *   - `message`  — inherited from `Error`
 *
 * Information-disclosure posture:
 *   The `message` MUST NOT distinguish "the resource does not exist"
 *   from "the resource exists but is not yours". Both cases collapse
 *   to a single 404 outcome, neutralising user-enumeration oracles —
 *   exactly the pattern the underlying repository SQL enforces by
 *   filtering with `WHERE user_id = $1` in the SELECT clauses.
 */
export class NotFoundError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so a generic error
   * handler can distinguish missing-resource failures without an
   * instanceof check.
   */
  public override readonly name: string = 'NotFoundError';

  /**
   * Machine-readable error code. Defaults to `'NOT_FOUND'` but may
   * be overridden for more specific failure classes (e.g.
   * `'DESIGN_NOT_FOUND'`, `'ORDER_NOT_FOUND'`). The route layer
   * maps this to a stable external error code in the HTTP 404
   * response body.
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason. SHOULD be
   *   non-discriminating ("Order X not found or not accessible to user")
   *   to prevent enumeration of resources owned by other users.
   * @param code Machine-readable error code. Defaults to `'NOT_FOUND'`.
   */
  public constructor(message: string, code: string = 'NOT_FOUND') {
    super(message);
    this.code = code;
  }
}

/**
 * Thrown when a state-machine invariant is violated — the target
 * resource exists and is owned by the user, but its current state
 * cannot accept the requested transition. Mapped to HTTP 409 by the
 * route layer.
 *
 * Two distinct conflict scenarios in this service:
 *   1. Pre-check failure: an order exists in a state OTHER than
 *      `'created'` (e.g. `'finalized'`, `'cancelled'`, or `'cart'`),
 *      so finalization is rejected with `code: 'ORDER_STATE_INVALID'`.
 *   2. Race-condition: the pre-check passed (order was in `'created'`)
 *      but the conditional UPDATE matched zero rows because a
 *      concurrent request already advanced the state. Surfaced with
 *      `code: 'ORDER_STATE_CONCURRENT_CHANGE'`.
 *
 * The TWO codes give operators a clear signal during incident
 * response: a spike in `ORDER_STATE_INVALID` indicates client logic
 * issuing duplicate finalization requests, while a spike in
 * `ORDER_STATE_CONCURRENT_CHANGE` indicates true concurrent activity
 * (the second request loses the race, but no data is corrupted).
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'ConflictError'`
 *   - `code`     — machine-readable error code (default `'CONFLICT'`)
 *   - `message`  — inherited from `Error`
 */
export class ConflictError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so a generic error
   * handler can distinguish conflict failures without an instanceof
   * check.
   */
  public override readonly name: string = 'ConflictError';

  /**
   * Machine-readable error code. Defaults to `'CONFLICT'`. Specific
   * codes exposed by this service:
   *   - `'ORDER_STATE_INVALID'` — pre-check found the order in a
   *     non-`'created'` state.
   *   - `'ORDER_STATE_CONCURRENT_CHANGE'` — conditional UPDATE matched
   *     zero rows (race lost).
   * The route layer maps this to a stable external error code in the
   * HTTP 409 response body.
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason naming the resource
   *   and the rejected transition.
   * @param code Machine-readable error code. Defaults to `'CONFLICT'`.
   */
  public constructor(message: string, code: string = 'CONFLICT') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Section 2: Module-private validation helpers
// ---------------------------------------------------------------------------
//
// These helpers run BEFORE any repository call, ensuring that
// validation failures never leave the persistence layer in a partial
// state (ST-032-AC3). Each helper guards against null, undefined,
// non-string/non-number, and empty/zero/negative inputs; throws
// {@link ValidationError} on failure with a precise `field` value
// (e.g. `'cartItems[2].quantity'`).
//
// Why these are module-private (not exported):
//   The validation contract is an implementation detail of the service.
//   Exposing the helpers would invite callers to short-circuit the
//   service contract (validate-then-call-without-validating-again),
//   which would regress the defense-in-depth posture.
// ---------------------------------------------------------------------------

/**
 * Reject null, undefined, non-string, and empty-string user
 * identifiers.
 *
 * The session middleware (`../middleware/session.ts`) is responsible
 * for producing a non-empty `userId` on the request after
 * `verifyIdToken`; this guard is defense-in-depth against a future
 * middleware refactor that weakens the contract.
 *
 * @throws {ValidationError} when `userId` is not a non-empty string.
 */
function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ValidationError('userId', 'userId must be a non-empty string');
  }
}

/**
 * Reject null, undefined, non-string, and empty-string order
 * identifiers.
 *
 * The route layer extracts `orderId` from the URL parameters; an
 * empty value typically indicates a malformed request (e.g.
 * `/api/orders//finalize`). Express normalizes those to a 404
 * before reaching the handler, but the guard ensures the service
 * never emits an SQL query with an empty UUID parameter.
 *
 * @throws {ValidationError} when `orderId` is not a non-empty
 *   string.
 */
function validateOrderId(orderId: unknown): asserts orderId is string {
  if (typeof orderId !== 'string' || orderId.length === 0) {
    throw new ValidationError('orderId', 'orderId must be a non-empty string');
  }
}

/**
 * Reject null, undefined, non-string, and empty-string design
 * identifiers within a cart item.
 *
 * The `itemIndex` is folded into the `field` so the route layer can
 * surface a precise, indexed error path (e.g.
 * `'cartItems[2].designId'`) — clients can highlight the offending
 * line in their cart UI without a free-text scrape.
 *
 * @param designId The candidate design identifier.
 * @param itemIndex The index of the offending item in the
 *   `cartItems` array; used to compose the `field` value of the
 *   thrown error.
 * @throws {ValidationError} when `designId` is not a non-empty
 *   string.
 */
function validateDesignId(designId: unknown, itemIndex: number): asserts designId is string {
  if (typeof designId !== 'string' || designId.length === 0) {
    throw new ValidationError(
      `cartItems[${itemIndex}].designId`,
      'designId must be a non-empty string',
    );
  }
}

/**
 * Reject non-positive, non-integer, NaN, and Infinity quantities.
 *
 * The `order_items.quantity` column has a `quantity > 0` CHECK
 * constraint at the database tier (ST-035-AC2), so an unguarded
 * negative value would raise a PG `23514` error rather than a clean
 * 400 — this guard converts the failure mode to a structured
 * {@link ValidationError} the route layer can map cleanly.
 *
 * @param quantity The candidate quantity.
 * @param itemIndex The index of the offending item in the
 *   `cartItems` array; used to compose the `field` value of the
 *   thrown error.
 * @throws {ValidationError} when `quantity` is not a positive
 *   integer.
 */
function validateQuantity(quantity: unknown, itemIndex: number): asserts quantity is number {
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    throw new ValidationError(
      `cartItems[${itemIndex}].quantity`,
      'quantity must be a positive integer',
    );
  }
}

/**
 * Validate the `cartItems` array as a whole.
 *
 * Enforces (ST-032-AC3 verbatim — "rejects empty carts, malformed
 * line items"):
 *   - `cartItems` is an array.
 *   - `cartItems` is non-empty (`code: 'EMPTY_CART'`).
 *   - Each element is a non-null object.
 *   - Each element has a non-empty string `designId`.
 *   - Each element has a positive integer `quantity`.
 *   - When present, each element's `metadata` is a non-null object
 *     (NOT an array — arrays would type-check as `object` in JS but
 *     are not the documented shape; downstream JSONB serialisation
 *     would produce a confusing structure).
 *
 * Iteration uses a classic `forEach` because we need both the item
 * and its index for the `field` composition; a `for-of` would lose
 * the index without manual bookkeeping.
 *
 * @param cartItems The candidate array of cart items.
 * @throws {ValidationError} on the first failure encountered. The
 *   `field` value pinpoints the offending item and property (e.g.
 *   `'cartItems[2].quantity'`).
 */
function validateCartItems(cartItems: unknown): asserts cartItems is CartItemInput[] {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new ValidationError(
      'cartItems',
      'cartItems must be a non-empty array',
      'EMPTY_CART',
    );
  }
  cartItems.forEach((item: unknown, index: number) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError(`cartItems[${index}]`, 'cart item must be an object');
    }
    // After the guard above we know `item` is a non-null, non-array
    // object. We narrow to `Record<string, unknown>` so property
    // access stays type-safe under TypeScript's strict mode.
    const candidate = item as Record<string, unknown>;
    validateDesignId(candidate['designId'], index);
    validateQuantity(candidate['quantity'], index);
    const metadata = candidate['metadata'];
    if (metadata !== undefined) {
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new ValidationError(
          `cartItems[${index}].metadata`,
          'metadata must be an object if provided',
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Section 3: Subtotal computation — integer-cents arithmetic to avoid
// IEEE 754 floating-point drift.
// ---------------------------------------------------------------------------

/**
 * Compute the cart's subtotal as a NUMERIC(12,2)-compatible string.
 *
 * Algorithm:
 *   1. For each `cartItem`, extract `unitPrice` from `metadata`.
 *      Accept both string ("12.50") and number (12.5) forms.
 *      Treat missing, non-finite, negative, or unparseable values
 *      as zero.
 *   2. Round each `unitPrice` to integer cents via
 *      `Math.round(unitPrice * 100)`.
 *   3. Multiply by `quantity` and accumulate into a running
 *      integer-cents total.
 *   4. Format the total as `"<whole>.<cents>"` with exactly two
 *      decimal places.
 *
 * Why integer cents:
 *   IEEE 754 double precision cannot represent decimal fractions
 *   exactly. `0.1 + 0.2 === 0.30000000000000004` is the canonical
 *   demonstration. Multiplying by 100 and rounding to integer cents
 *   at every step lifts arithmetic into the integer domain where
 *   `Number.MAX_SAFE_INTEGER` (2^53 - 1) is the only ceiling. For a
 *   cap of 2^53 cents, that's $90,071,992,547,409.91 — comfortably
 *   above any plausible cart subtotal.
 *
 * Format contract:
 *   The PostgreSQL `NUMERIC(12,2)` column accepts the string
 *   verbatim. PostgreSQL re-formats the value on retrieval using its
 *   own rules; we round-trip the same numeric quantity but the
 *   string representation may shift (e.g. trailing zeros). The
 *   service treats the string as opaque after this point — only the
 *   numeric value matters.
 *
 * Why `metadata.unitPrice` (and not a separate `price` field on
 * `CartItemInput`):
 *   The `CartItemInput` shape is the smallest possible — `designId`,
 *   `quantity`, `metadata` — to keep the repository's INSERT path
 *   compact. Per-item pricing is an opt-in metadata field; the
 *   service tolerates absence (zero contribution) so that callers
 *   who price-on-server can supply prices via a different mechanism
 *   (e.g. a price-lookup service injected separately) without
 *   breaking this method's contract.
 *
 * Rule R2 posture:
 *   This function does NOT log. It returns a string; the caller
 *   (`createOrder`) decides whether and how to surface the value.
 *   `createOrder` logs only the boolean `hasSubtotal`, never the
 *   numeric value itself.
 *
 * @param cartItems The validated cart items (already passed
 *   {@link validateCartItems}).
 * @returns The subtotal as a string with exactly two decimal places
 *   (e.g. `'75.00'`, `'1234.56'`, `'0.00'`).
 */
function computeSubtotal(cartItems: CartItemInput[]): string {
  // Integer-cents accumulator. Stays within Number.MAX_SAFE_INTEGER
  // for any plausible cart total (see the function-level docblock).
  let totalCents = 0;

  for (const item of cartItems) {
    // `metadata` is `Record<string, unknown>` per the
    // `CartItemInput` contract; per-key access returns `unknown`
    // and must be narrowed before arithmetic.
    const rawUnitPrice: unknown = item.metadata['unitPrice'];

    let unitPriceCents = 0;
    if (typeof rawUnitPrice === 'string') {
      // String form: "12.50", "1.99", "100", etc. parseFloat
      // tolerates trailing whitespace, unit suffixes, and other
      // benign deviations; NaN is filtered by Number.isFinite.
      const parsed = Number.parseFloat(rawUnitPrice);
      if (Number.isFinite(parsed) && parsed >= 0) {
        unitPriceCents = Math.round(parsed * 100);
      }
    } else if (
      typeof rawUnitPrice === 'number' &&
      Number.isFinite(rawUnitPrice) &&
      rawUnitPrice >= 0
    ) {
      // Number form: 12.5, 1.99, 100, etc. Reject NaN, Infinity,
      // and negative values silently (treat as zero) — per the
      // function-level docblock, this method tolerates absence.
      unitPriceCents = Math.round(rawUnitPrice * 100);
    }

    // Multiply by quantity (a positive integer per
    // `validateQuantity`) and accumulate.
    totalCents += unitPriceCents * item.quantity;
  }

  // Decompose the integer cents back into the
  // "<whole>.<cents>" string form.
  const whole = Math.floor(totalCents / 100);
  const cents = totalCents - whole * 100;
  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Section 4: Public types — the service's input/output contract
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link OrderService.getCart}.
 *
 * Single field — `userId` — sourced from the session middleware.
 * The service NEVER accepts an explicit "give me cart for user X"
 * parameter; the authenticated user's id is the only acceptable
 * input (ST-033-AC1 verbatim — "returns only the cart belonging to
 * the authenticated user").
 */
export interface GetCartParams {
  /** Owning user's id (= Firebase uid, from session middleware). */
  userId: string;
}

/**
 * Parameters for {@link OrderService.createOrder}.
 *
 *   `userId` — the authenticated user's id (sourced from session
 *   middleware). Becomes the `user_id` foreign-key column on the
 *   inserted `orders` row.
 *
 *   `cartItems` — the line items to persist. Validated via
 *   {@link validateCartItems} before any side effect; on validation
 *   failure the persistence layer is unchanged (ST-032-AC3).
 */
export interface CreateOrderParams {
  /** Owning user's id (= Firebase uid, from session middleware). */
  userId: string;
  /** Line items to persist; non-empty array of validated cart items. */
  cartItems: CartItemInput[];
}

/**
 * Parameters for {@link OrderService.finalizeOrder}.
 *
 *   `userId` — the authenticated user's id; pins ownership in SQL
 *   via the repository's WHERE clause.
 *
 *   `orderId` — the server-assigned order UUID returned from
 *   {@link OrderService.createOrder}. Pins the specific order to
 *   finalize.
 */
export interface FinalizeOrderParams {
  /** Owning user's id (= Firebase uid, from session middleware). */
  userId: string;
  /** Server-assigned UUID of the order to finalize. */
  orderId: string;
}

/**
 * Parameters for {@link OrderService.getById}.
 *
 *   `userId` — the authenticated user's id; pins ownership.
 *   `orderId` — the server-assigned order UUID.
 *
 * Both fields are required; the repository enforces ownership at
 * the SQL tier so a request with the wrong `userId` for a real
 * `orderId` returns `null` (NOT 403) — defense-in-depth against
 * enumeration of other users' orders.
 */
export interface GetOrderByIdParams {
  /** Owning user's id (= Firebase uid, from session middleware). */
  userId: string;
  /** Server-assigned UUID of the order to fetch. */
  orderId: string;
}

/**
 * The public contract for the order service.
 *
 * Four methods, each mapping to a specific story acceptance criteria
 * set:
 *
 *   - {@link OrderService.getCart} — ST-033 (retrieve cart for
 *     authenticated user). Always succeeds; empty cart returns the
 *     structural empty representation.
 *
 *   - {@link OrderService.createOrder} — ST-032 (create order from
 *     cart contents). Validates ownership of every referenced design
 *     before persisting, ensuring the persistence layer is unchanged
 *     on failure (ST-032-AC3).
 *
 *   - {@link OrderService.finalizeOrder} — ST-034 (finalize order
 *     with post-processing). Idempotent under the conditional
 *     UPDATE's `WHERE state = 'created'` predicate (ST-034-AC3);
 *     emits a structured `order.finalized` log event for downstream
 *     post-processing pipelines (ST-034-AC2).
 *
 *   - {@link OrderService.getById} — ownership-scoped order lookup
 *     for downstream consumers (e.g. order-detail endpoint, finalize
 *     response read-back). Returns `null` when no row matches.
 *
 * Out-of-scope per Rule R9 / AAP §0.7.2:
 *   - No financial-settlement methods of any kind.
 *   - No payment-state transitions; the {@link OrderState} enum
 *     itself excludes financial-settlement vocabulary.
 *   - No payment-processor SDK calls; the service has none of the
 *     SDKs listed in AAP §0.7.2 imported.
 */
export interface OrderService {
  /**
   * Fetch the authenticated user's cart projection.
   *
   * Always returns a {@link Cart} (never throws `NotFoundError`).
   * An empty cart is `{ userId, items: [], subtotal: '0.00' }`
   * per ST-033-AC3.
   *
   * Idempotent — performs no writes, has no side effects beyond a
   * single structured log event (`cart.fetched`).
   *
   * @throws {ValidationError} when `userId` is not a non-empty
   *   string (defense-in-depth against a future middleware bug).
   */
  getCart(params: GetCartParams): Promise<Cart>;

  /**
   * Atomically create an order from the supplied cart items.
   *
   * Validates the input shape, then validates that every
   * referenced design is owned by `userId` (ST-032-AC3
   * enumeration-defense pattern), then computes the subtotal in
   * integer cents, then delegates to
   * {@link OrderRepository.createOrderFromCart} for the BEGIN/
   * COMMIT-wrapped persistence. Emits a structured `order.created`
   * log event with structural metadata only.
   *
   * @throws {ValidationError} on empty cart (`code: 'EMPTY_CART'`)
   *   or malformed items.
   * @throws {NotFoundError} when any cartItem's `designId` is not
   *   accessible to the user (`code: 'DESIGN_NOT_FOUND'`).
   * @throws Any pg error from the repository (FK violations,
   *   connection drops); the route layer translates pg error
   *   codes to HTTP responses.
   *
   * @returns The persisted order including server-assigned
   *   `id`, `createdAt`, `lastModifiedAt`, the inserted `items`,
   *   and the calculated `subtotal`.
   */
  createOrder(params: CreateOrderParams): Promise<Order>;

  /**
   * Finalize an order — transition it from `'created'` to
   * `'finalized'` with post-processing recorded as a structured
   * log event.
   *
   * Three-step flow:
   *   1. Pre-check: fetch the order via
   *      {@link OrderRepository.findOrderById} and verify it
   *      exists, is owned by the user, and is in state
   *      `'created'`. Produces clean
   *      {@link NotFoundError}/{@link ConflictError} signals.
   *   2. Conditional UPDATE: invoke
   *      {@link OrderRepository.updateOrderState} with
   *      `expectedState: 'created'`. The SQL `WHERE state =
   *      $expectedState` is the AUTHORITATIVE race-condition
   *      guard; null return means the state changed between
   *      the pre-check and the UPDATE.
   *   3. Post-processing: emit a structured `order.finalized`
   *      log event with the final order state and item count.
   *      Downstream pipelines consume this event for inventory
   *      reservation, notification, and bookkeeping (ST-034-AC2).
   *
   * @throws {ValidationError} when `userId` or `orderId` is
   *   malformed.
   * @throws {NotFoundError} when the order does not exist or is
   *   not accessible to the user (`code: 'ORDER_NOT_FOUND'`).
   * @throws {ConflictError} when the order exists but is in a
   *   non-`'created'` state (`code: 'ORDER_STATE_INVALID'`) or
   *   when the conditional UPDATE matched zero rows because of a
   *   concurrent state change (`code: 'ORDER_STATE_CONCURRENT_CHANGE'`).
   *
   * @returns The order in its new `'finalized'` state. The
   *   returned object's `items` array is populated with the
   *   order's persisted line items, mirroring the canonical
   *   `Order` response shape produced by {@link OrderService.create}
   *   per ST-032-AC2. The repository's `updateOrderState` performs
   *   a follow-up `SELECT` against `order_items` after the UPDATE
   *   so consumers can render the order receipt directly off the
   *   finalize response without an extra `getById` round-trip.
   */
  finalizeOrder(params: FinalizeOrderParams): Promise<Order>;

  /**
   * Fetch an order by id, scoped to the authenticated user.
   *
   * Returns the order including its joined line items, or `null`
   * when no row matches. The repository's SQL WHERE pins
   * ownership in the database tier; "does-not-exist" is
   * indistinguishable from "not-yours" by design (defense-in-depth
   * against enumeration).
   *
   * Used by the route layer to:
   *   - Echo the persisted order in the finalize response.
   *   - Implement a future GET `/api/orders/:id` endpoint when
   *     added by a follow-up story.
   *
   * @throws {ValidationError} when `userId` or `orderId` is
   *   malformed.
   *
   * @returns The order with its items, or `null` when no row
   *   matches.
   */
  getById(params: GetOrderByIdParams): Promise<Order | null>;
}

/**
 * Dependencies required by {@link createOrderService}.
 *
 *   `orderRepository` — concrete {@link OrderRepository}
 *   implementation, typically built via
 *   `createOrderRepository(pool)` in the composition root
 *   (`backend/src/index.ts`). All four methods on the interface
 *   are consumed by this service.
 *
 *   `designRepository` — concrete {@link DesignRepository}
 *   implementation, typically built via
 *   `createDesignRepository(pool)` in the composition root. Only
 *   the `findById({ userId, designId })` method is consumed (for
 *   the ST-032-AC3 ownership validation pass).
 *
 * Why dependency injection (and not a direct repository import):
 *   - Unit tests can substitute mock repositories without
 *     monkey-patching the global module graph.
 *   - The composition root has full control over which `pg.Pool`
 *     and `Storage` instances flow into the service — useful for
 *     CI-vs-prod configuration.
 *   - Aligns with the factory pattern used throughout this
 *     codebase (see `session.service.ts`, `gcs.service.ts`).
 */
export interface OrderServiceDeps {
  /** Concrete {@link OrderRepository} implementation. */
  orderRepository: OrderRepository;
  /** Concrete {@link DesignRepository} implementation. */
  designRepository: DesignRepository;
}

// ---------------------------------------------------------------------------
// Section 5: Factory — wires dependencies into the public service object
// ---------------------------------------------------------------------------

/**
 * Construct an {@link OrderService} backed by the supplied
 * repositories.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createOrderService({ orderRepository, designRepository })`)
 *     — easier to read and easier to mock than constructor
 *     injection.
 *   - The returned object is a plain record literal of methods,
 *     which `Object.freeze` protects from monkey-patching
 *     downstream.
 *   - Aligns with the factory pattern used throughout this
 *     codebase.
 *
 * The factory performs eager validation of its dependencies
 * (`!orderRepository`, `!designRepository`) so a misconfigured
 * composition root fails LOUDLY at module-load time rather than
 * subtly at first request.
 *
 * The returned object is `Object.freeze`d so calling code cannot
 * substitute one of the methods at runtime — this prevents a class
 * of bugs where a test or middleware accidentally mutates the
 * shared service instance.
 *
 * @param deps The injected repository implementations.
 * @returns A frozen {@link OrderService} ready for use.
 * @throws {Error} when `deps` is missing or any required
 *   repository is absent — surfaces a clear configuration error
 *   at composition-root assembly time.
 */
export function createOrderService(deps: OrderServiceDeps): OrderService {
  // Eager dependency validation. The truthiness check tolerates
  // both missing keys (TypeScript would normally catch this, but
  // dynamic-typed callers from tests can sneak past) and explicit
  // `undefined`/`null` smuggled in via `as` casts.
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createOrderService: deps must be a non-null object');
  }
  const { orderRepository, designRepository } = deps;
  if (orderRepository === null || orderRepository === undefined) {
    throw new Error('createOrderService: orderRepository is required');
  }
  if (designRepository === null || designRepository === undefined) {
    throw new Error('createOrderService: designRepository is required');
  }

  const service: OrderService = {
    /**
     * ST-033 implementation. Always returns a Cart; empty cart is
     * `{ items: [], subtotal: '0.00' }` (NOT a 404).
     *
     * The repository's `findCartForUser` is the sole source of
     * truth for cart state; this method's only contributions are
     * input validation, the structured log event, and forwarding
     * the result.
     */
    async getCart({ userId }: GetCartParams): Promise<Cart> {
      validateUserId(userId);

      const cart = await orderRepository.findCartForUser(userId);

      // Structural log only — `event`, `uid`, and `itemCount`. No
      // monetary values, no per-item metadata, no design IDs in
      // bulk (Rule R2 — minimise PII exposure even when the
      // serializer allow-list would defang it).
      logger.info(
        {
          event: 'cart.fetched',
          uid: userId,
          itemCount: cart.items.length,
        },
        'cart fetched',
      );

      return cart;
    },

    /**
     * ST-032 implementation. Validates input, validates design
     * ownership for every cart item, computes subtotal in integer
     * cents, and delegates to the repository's atomic
     * BEGIN/COMMIT-wrapped persist.
     *
     * Validation order is INTENTIONAL:
     *   1. `userId` shape — fail fastest.
     *   2. `cartItems` shape — fail before any I/O.
     *   3. Design ownership — fail before any persist.
     *   4. Subtotal computation — pure function on already-
     *      validated data.
     *   5. Persist — the only side effect.
     *
     * Steps 1–3 ensure that ST-032-AC3 ("leave the persistence
     * layer unchanged") holds: no INSERT runs unless every
     * validation passes.
     */
    async createOrder({ userId, cartItems }: CreateOrderParams): Promise<Order> {
      validateUserId(userId);
      validateCartItems(cartItems);

      // Ownership validation. For each cart item, confirm that
      // the referenced design exists AND is owned by the
      // authenticated user. The repository's `findById` enforces
      // ownership in SQL via `WHERE user_id = $1 AND id = $2` —
      // a cross-ownership reference returns `null`, which we
      // translate to NotFoundError.
      //
      // Sequential iteration (rather than `Promise.all`) is
      // INTENTIONAL: failing fast on the first inaccessible
      // design preserves the fail-fast posture and minimises the
      // database load when a request supplies many items but the
      // first is rejected. The trade-off is wall-clock latency
      // for the happy path; for typical cart sizes (1–10 items)
      // the latency is dominated by network round-trips that
      // dwarf the serial cost.
      for (let i = 0; i < cartItems.length; i += 1) {
        const cartItem = cartItems[i];
        // `validateCartItems` guarantees this access is safe;
        // the explicit guard satisfies TypeScript's
        // `noUncheckedIndexedAccess`-style strictness.
        if (cartItem === undefined) {
          throw new ValidationError(
            `cartItems[${i.toString()}]`,
            'cart item must be an object',
          );
        }
        const design = await designRepository.findById({
          userId,
          designId: cartItem.designId,
        });
        if (design === null) {
          // Enumeration-defense pattern: the message does NOT
          // distinguish "design does not exist" from "design
          // exists but belongs to another user". The route
          // layer maps this to HTTP 404; the client cannot
          // probe for the existence of other users' designs.
          throw new NotFoundError(
            `Design ${cartItem.designId} not found or not accessible to user`,
            'DESIGN_NOT_FOUND',
          );
        }
      }

      // Compute subtotal server-side. The client may supply a
      // hint via `metadata.unitPrice`, but the authoritative
      // calculation is server-side per the AAP §0.6.4 design
      // (clients cannot dictate prices).
      const subtotal = computeSubtotal(cartItems);

      // Delegate to the repository's atomic BEGIN/COMMIT.
      // `CreateOrderFromCartParams` is the documented parameter
      // shape; we construct it explicitly rather than relying on
      // structural typing to make the contract grep-able.
      const params: CreateOrderFromCartParams = {
        userId,
        cartItems,
        subtotal,
      };
      const order = await orderRepository.createOrderFromCart(params);

      // Structural log only. `hasSubtotal` is a boolean — we
      // never log the actual subtotal string per Rule R2's
      // structural-metadata-only posture (the subtotal is
      // user-visible, not a credential, but logging monetary
      // values risks accidental PII exposure in shared incident
      // dashboards).
      logger.info(
        {
          event: 'order.created',
          uid: userId,
          orderId: order.id,
          itemCount: order.items.length,
          state: order.state,
          hasSubtotal: Boolean(order.subtotal),
        },
        'order created',
      );

      return order;
    },

    /**
     * ST-034 implementation. Pre-check then conditional UPDATE.
     *
     * Three potential outcomes from the conditional UPDATE:
     *   (a) Pre-check finds a non-existent order → NotFoundError.
     *   (b) Pre-check finds the order in a non-'created' state →
     *       ConflictError with code `'ORDER_STATE_INVALID'`.
     *   (c) Pre-check passes, but UPDATE returns null because of
     *       a race → ConflictError with code
     *       `'ORDER_STATE_CONCURRENT_CHANGE'`.
     * The DISTINCT codes give operators a clear signal during
     * incident response — see {@link ConflictError} docblock.
     */
    async finalizeOrder({ userId, orderId }: FinalizeOrderParams): Promise<Order> {
      validateUserId(userId);
      validateOrderId(orderId);

      // Pre-check. The repository's `findOrderById` enforces
      // ownership in SQL; `null` means the order does not exist
      // OR is owned by another user — both cases collapse to
      // NotFoundError per the enumeration-defense pattern.
      const existing = await orderRepository.findOrderById({ userId, orderId });
      if (existing === null) {
        throw new NotFoundError(
          `Order ${orderId} not found or not accessible to user`,
          'ORDER_NOT_FOUND',
        );
      }

      // State-machine pre-check. ConflictError gives the route
      // layer a clean signal to map to HTTP 409.
      if (existing.state !== 'created') {
        throw new ConflictError(
          `Order ${orderId} is in state '${existing.state}' and cannot be finalized`,
          'ORDER_STATE_INVALID',
        );
      }

      // Conditional UPDATE. The repository's
      // `WHERE state = $expectedState` is the AUTHORITATIVE
      // race-condition guard; null return means a concurrent
      // request already advanced the state between the pre-check
      // and this call. Surfacing that as a distinct code lets
      // operators distinguish "client sent duplicate finalize"
      // from "true concurrent activity won the race".
      //
      // `'finalized'` and `'created'` are typed as `OrderState`
      // via the `as` cast purely so the literal flows through
      // TypeScript's union-narrowing without an extra const
      // declaration; the values themselves are members of the
      // OrderState union by definition.
      const updated = await orderRepository.updateOrderState({
        userId,
        orderId,
        newState: 'finalized' as OrderState,
        expectedState: 'created' as OrderState,
      });

      if (updated === null) {
        throw new ConflictError(
          `Order ${orderId} state changed concurrently and could not be finalized`,
          'ORDER_STATE_CONCURRENT_CHANGE',
        );
      }

      // Post-processing checkpoint. Per ST-034-AC2 the post-
      // processing workflow includes "inventory reservation,
      // confirmation notification metadata, bookkeeping
      // entries". In this greenfield implementation the events
      // are emitted as structured log records consumed by
      // downstream log-based pipelines (e.g. Cloud Logging
      // sinks, Pub/Sub triggers). No external HTTP/SDK calls
      // are made from within this service — the post-processing
      // surface is intentionally extensible without coupling
      // the service to specific transports.
      //
      // Structural fields only (Rule R2):
      //   - `event`     — operator-facing event name
      //   - `uid`       — owning user
      //   - `orderId`   — the order being finalized
      //   - `state`     — for verification (always 'finalized')
      //   - `itemCount` — per ST-035-AC2, item-count is a
      //                   relevant audit datum but per-item
      //                   designIDs and metadata are not
      logger.info(
        {
          event: 'order.finalized',
          uid: userId,
          orderId: updated.id,
          state: updated.state,
          itemCount: updated.items.length,
        },
        'order finalized',
      );

      return updated;
    },

    /**
     * Ownership-scoped order lookup. Pure forwarder to the
     * repository's `findOrderById` — the SQL WHERE pins
     * ownership at the database tier.
     *
     * Defense-in-depth: even though the repository's SQL
     * already filters by user_id, the service performs an
     * explicit ownership check on the returned row. A future
     * repository refactor that inadvertently weakens the WHERE
     * clause would still be caught here.
     */
    async getById({ userId, orderId }: GetOrderByIdParams): Promise<Order | null> {
      validateUserId(userId);
      validateOrderId(orderId);

      const order = await orderRepository.findOrderById({ userId, orderId });

      // Defense-in-depth — the repository SQL already filters
      // by user_id, but a future refactor or a stale cache could
      // surface another user's order. Treating any mismatch as
      // null preserves the enumeration-defense posture.
      if (order !== null && order.userId !== userId) {
        return null;
      }

      return order;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a service method at runtime — defensive against
  // a class of hard-to-diagnose bugs.
  return Object.freeze(service);
}
