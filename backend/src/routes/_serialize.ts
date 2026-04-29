/**
 * Wire-format serializers for Cart and Order responses.
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.3 / §0.6.4: routes layer is the only place that may
 *     transform repository shapes into the externally-observable wire
 *     format. Internal Cart/Order interfaces preserve PostgreSQL
 *     `NUMERIC(12,2)` precision verbatim by representing `subtotal` as
 *     a `string` (see backend/src/repositories/order.repository.ts
 *     lines 320–369). The wire format, by contrast, is consumed by the
 *     frontend's `frontend/src/api/orders.ts` interfaces which declare
 *     `subtotal: number` so that arithmetic, sorting, and display
 *     formatting can occur without an explicit coercion at every call
 *     site.
 *
 *   - QA Final D Issue #9 (CRITICAL): the GET /api/cart route used to
 *     forward the repository's string subtotal verbatim, and the E2E
 *     suite's contract assertion (`expect(typeof cart.subtotal).toBe(
 *     'number')` at frontend/tests/e2e/cart-and-order-flow.spec.ts:546)
 *     observed the string form. The same drift existed for POST
 *     /api/orders and POST /api/orders/:id/finalize. This module is the
 *     single place where the string→number coercion happens.
 *
 *   - Per ST-033-AC2 the response MUST include "a calculated subtotal".
 *     The story does NOT pin a JSON type for the field; the frontend
 *     contract (number) governs.
 *
 * ============================================================================
 * Why a route-layer serializer (not a repository transform)
 * ============================================================================
 *
 *   - The repository preserves NUMERIC precision because Postgres
 *     drivers serialize NUMERIC as a string by default and the service
 *     layer performs subtotal computation in integer cents (see
 *     backend/src/services/order.service.ts `computeSubtotal`). Mutating
 *     the repository contract would force every internal caller
 *     (services, post-processing, log redactors) to track the new
 *     numeric shape and reason about float precision.
 *
 *   - The route layer is the natural transformation boundary: by the
 *     time the response leaves Express, the value has been finalised
 *     and there are no further service-layer consumers. A shallow
 *     serializer at this boundary keeps the precision-preserving
 *     internal contract intact while giving the wire format what its
 *     consumers actually want.
 *
 * ============================================================================
 * Precision considerations
 * ============================================================================
 *
 *   - PostgreSQL NUMERIC(12,2) admits values up to 9,999,999,999.99.
 *     IEEE 754 double-precision floats can represent every NUMERIC(12,2)
 *     value EXACTLY when the integer-cent value (subtotal × 100) fits in
 *     the safe-integer range (±2^53 - 1). NUMERIC(12,2) max in cents is
 *     999,999,999,999, well under 2^53 (≈9.007×10^15), so coercion via
 *     `Number(s)` is lossless within the documented schema bounds.
 *
 *   - Defensive guard: if `Number(s)` yields `NaN` (string is
 *     malformed), the serializer surfaces a structured error rather
 *     than silently emitting NaN to the wire. NaN is NOT JSON-
 *     serialisable (it round-trips to `null`) and would silently
 *     corrupt downstream consumers. The defensive check makes the
 *     failure mode explicit.
 *
 * ============================================================================
 * Rule compliance
 * ============================================================================
 *
 *   - Rule R2 (no credential material in logs): this module emits no
 *     log records. Any defensive throw is caught by the route's error
 *     handler which uses the project-wide pino logger with serializer
 *     allow-list — credentials cannot leak through this path.
 *
 *   - Rule R8 (gates fail closed): if the input is malformed, the
 *     serializer throws synchronously rather than emitting a 200 with
 *     a corrupted body. The caller (route handler) translates the
 *     throw into a 500 INTERNAL_ERROR through the existing
 *     handleRouteError flow.
 *
 *   - Rule R9 (no payment processing): the serializer touches only
 *     `subtotal` (an arithmetic aggregate) — there is no settlement
 *     vocabulary, no charge state, no tokenization data anywhere in
 *     this file.
 */

import type { Cart, Order, OrderItem } from '../repositories/order.repository';

/**
 * Public wire-format shape of a cart line item.
 *
 * Mirrors the internal {@link OrderItem} verbatim — line items have no
 * NUMERIC columns and no transformation is needed at this layer. The
 * type alias keeps the wire-format namespace internally consistent
 * (callers see `CartItemWire`/`CartWire`/`OrderWire` rather than a
 * mixture of internal and wire types).
 *
 * Note: Mocks and test fixtures may attach additional pass-through
 * properties (e.g. `id`, `createdAt`) that JSON.stringify will emit
 * verbatim. Such pass-through is permitted because the wire contract
 * says only what fields MUST be present, not what fields MAY NOT.
 */
export type CartItemWire = OrderItem;

/**
 * Public wire-format shape of a cart response.
 *
 * Differs from the internal {@link Cart} interface by emitting
 * `subtotal` as a JavaScript `number` rather than a NUMERIC-safe
 * string.
 */
export interface CartWire {
  readonly userId: string;
  readonly items: readonly CartItemWire[];
  readonly subtotal: number;
}

/**
 * Public wire-format shape of an order response.
 *
 * Differs from the internal {@link Order} interface by emitting
 * `subtotal` as a JavaScript `number` rather than a NUMERIC-safe
 * string. Timestamp fields (`createdAt`, `lastModifiedAt`) remain
 * Express's default `Date` → ISO-8601 serialisation so callers see
 * `string`.
 */
export interface OrderWire {
  readonly id: string;
  readonly userId: string;
  readonly state: string;
  readonly subtotal: number;
  readonly createdAt: Date | string;
  readonly lastModifiedAt: Date | string;
  readonly items: readonly CartItemWire[];
}

/**
 * Coerce a NUMERIC(12,2) string to a JavaScript number with explicit
 * defensive checks.
 *
 * Throws a TypeError if the input is not a number-parseable string.
 * The throw is caught by the route's `handleRouteError` flow, which
 * surfaces a structured 500 INTERNAL_ERROR. The throw is preferred
 * over a silent NaN emission because NaN serialises to JSON `null`
 * and would silently corrupt the consumer's arithmetic.
 *
 * @param raw The repository-layer subtotal (always a string per the
 *   {@link Cart}/{@link Order} interface contracts).
 * @returns The numeric subtotal.
 * @throws TypeError if `raw` cannot be parsed.
 */
function coerceSubtotalToNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    // Defensive guard — repository contract pins subtotal as a
    // NUMERIC(12,2) string; reaching this branch indicates either a
    // schema drift, a corrupted database row, or a test fixture using
    // an invalid sentinel value. We surface the failure explicitly so
    // the route handler can translate to 500 rather than emitting a
    // body with `subtotal: NaN` (which JSON.stringify would coerce to
    // `null`).
    throw new TypeError(
      `subtotal coercion failed: expected NUMERIC string, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Project a {@link Cart} repository shape onto its wire format.
 *
 * The transformation is shallow:
 *   - `userId` and `items` are forwarded verbatim (line items have no
 *     NUMERIC columns).
 *   - `subtotal` is coerced from NUMERIC string to JS number.
 *
 * @param cart The repository-shape cart.
 * @returns The wire-shape cart.
 */
export function serializeCart(cart: Cart): CartWire {
  return {
    userId: cart.userId,
    items: cart.items,
    subtotal: coerceSubtotalToNumber(cart.subtotal),
  };
}

/**
 * Project an {@link Order} repository shape onto its wire format.
 *
 * The transformation is shallow:
 *   - All non-numeric fields are forwarded verbatim.
 *   - `subtotal` is coerced from NUMERIC string to JS number.
 *
 * @param order The repository-shape order.
 * @returns The wire-shape order.
 */
export function serializeOrder(order: Order): OrderWire {
  return {
    id: order.id,
    userId: order.userId,
    state: order.state,
    subtotal: coerceSubtotalToNumber(order.subtotal),
    createdAt: order.createdAt,
    lastModifiedAt: order.lastModifiedAt,
    items: order.items,
  };
}
