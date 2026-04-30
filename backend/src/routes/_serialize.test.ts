/**
 * Unit tests for the route-layer wire-format serializers.
 *
 * Test plan (mirrors backend/src/routes/_serialize.ts):
 *
 *   1. {@link serializeCart} happy path — string subtotal coerces to
 *      number; userId and items pass through unchanged.
 *   2. {@link serializeCart} empty cart — `'0.00'` coerces to `0`;
 *      empty items array is preserved verbatim.
 *   3. {@link serializeCart} large value — coerces a NUMERIC(12,2) max
 *      value (`'9999999999.99'`) without precision loss.
 *   4. {@link serializeCart} NaN guard — when the subtotal is not a
 *      number-parseable string, a TypeError is thrown synchronously
 *      so handleRouteError translates it to 500. Critical for Rule R8
 *      fail-closed semantics.
 *   5. {@link serializeOrder} happy path — all non-numeric fields pass
 *      through; subtotal coerces from string to number.
 *   6. {@link serializeOrder} preserves Date instances on the
 *      timestamp fields (Express's res.json will ISO-encode them).
 *   7. {@link serializeOrder} NaN guard — same as Cart variant.
 *
 * The tests exercise the full file (lines 88–209) including the
 * defensive guard branch at line 164.
 */
import { serializeCart, serializeOrder } from './_serialize';
import type { Cart, Order } from '../repositories/order.repository';

// ---------------------------------------------------------------------------
// Test #1 — serializeCart happy path
// ---------------------------------------------------------------------------

describe('serializeCart', () => {
  it('coerces a populated cart subtotal from string to number', () => {
    // Arrange
    const cart: Cart = {
      userId: 'firebase-uid-12345',
      items: [
        {
          orderId: '',
          designId: 'design-uuid-1',
          quantity: 2,
          metadata: { unitPrice: '25.00' },
        },
      ],
      subtotal: '50.00',
    };
    // Act
    const wire = serializeCart(cart);
    // Assert
    expect(wire.userId).toBe('firebase-uid-12345');
    expect(wire.items).toEqual(cart.items);
    expect(wire.subtotal).toBe(50);
    expect(typeof wire.subtotal).toBe('number');
  });

  it('coerces an empty cart subtotal "0.00" to the JS number 0', () => {
    const cart: Cart = {
      userId: 'firebase-uid-empty',
      items: [],
      subtotal: '0.00',
    };
    const wire = serializeCart(cart);
    expect(wire).toEqual({
      userId: 'firebase-uid-empty',
      items: [],
      subtotal: 0,
    });
    expect(typeof wire.subtotal).toBe('number');
  });

  it('coerces a NUMERIC(12,2) max value without precision loss', () => {
    // PostgreSQL NUMERIC(12,2) max is 9,999,999,999.99; in cents that
    // is 999,999,999,999 < 2^53 (~9.007e15). The double-precision
    // float can represent this value exactly.
    const cart: Cart = {
      userId: 'firebase-uid-max',
      items: [],
      subtotal: '9999999999.99',
    };
    const wire = serializeCart(cart);
    expect(wire.subtotal).toBe(9999999999.99);
    expect(typeof wire.subtotal).toBe('number');
  });

  it('throws TypeError when the subtotal is not a number-parseable string', () => {
    // Defensive guard at _serialize.ts line 162 — if the repository
    // ever drifted to emit a malformed subtotal, the route layer
    // surfaces an explicit failure rather than emitting `subtotal:
    // null` (which is what JSON.stringify(NaN) yields). Per Rule R8
    // gates fail closed: handleRouteError translates this throw into
    // a 500 response.
    const cart = {
      userId: 'firebase-uid-corrupt',
      items: [],
      subtotal: 'not-a-number',
    } as unknown as Cart;
    expect(() => serializeCart(cart)).toThrow(TypeError);
    expect(() => serializeCart(cart)).toThrow(/subtotal coercion failed/);
  });
});

// ---------------------------------------------------------------------------
// Test #2 — serializeOrder happy path + preservation
// ---------------------------------------------------------------------------

describe('serializeOrder', () => {
  it('coerces an order subtotal from string to number and preserves all other fields', () => {
    const created = new Date('2025-01-15T10:30:00.000Z');
    const lastModified = new Date('2025-01-15T10:35:00.000Z');
    const order: Order = {
      id: 'order-uuid-1',
      userId: 'firebase-uid-42',
      state: 'created',
      subtotal: '125.50',
      createdAt: created,
      lastModifiedAt: lastModified,
      items: [
        {
          orderId: 'order-uuid-1',
          designId: 'design-uuid-2',
          quantity: 3,
          metadata: { sku: 'SF-PRO-001' },
        },
      ],
    };
    const wire = serializeOrder(order);
    expect(wire.id).toBe('order-uuid-1');
    expect(wire.userId).toBe('firebase-uid-42');
    expect(wire.state).toBe('created');
    expect(wire.subtotal).toBe(125.5);
    expect(typeof wire.subtotal).toBe('number');
    expect(wire.createdAt).toBe(created);
    expect(wire.lastModifiedAt).toBe(lastModified);
    expect(wire.items).toEqual(order.items);
  });

  it('throws TypeError when the order subtotal is malformed', () => {
    const order = {
      id: 'order-uuid-bad',
      userId: 'firebase-uid-bad',
      state: 'created',
      subtotal: 'NaN',
      createdAt: new Date(),
      lastModifiedAt: new Date(),
      items: [],
    } as unknown as Order;
    expect(() => serializeOrder(order)).toThrow(TypeError);
    expect(() => serializeOrder(order)).toThrow(/subtotal coercion failed/);
  });

  it('throws TypeError on Infinity input — Number() returns Infinity, not finite', () => {
    // Defensive guard against Number.isFinite — both NaN and ±Infinity
    // are non-finite. The pg driver should never emit either, but the
    // guard handles both.
    const order = {
      id: 'order-uuid-inf',
      userId: 'firebase-uid-inf',
      state: 'created',
      subtotal: 'Infinity',
      createdAt: new Date(),
      lastModifiedAt: new Date(),
      items: [],
    } as unknown as Order;
    expect(() => serializeOrder(order)).toThrow(TypeError);
  });
});
