/**
 * Live cart and order API module for the StrikeForge frontend.
 *
 * Authority:
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/api/orders.ts → Cart + order API calls.
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       CREATE | frontend/src/api/orders.ts | Real calls to GET /api/cart,
 *       POST /api/orders, POST /api/orders/:id/finalize.
 *   - User stories:
 *       ST-032 (Create Order from Cart Contents via Order Endpoint):
 *         POST /api/orders → returns persisted Order with id, items, subtotal,
 *         and createdAt; rejects empty/malformed carts; persists order in a
 *         documented non-terminal state and defers downstream financial
 *         settlement to a separate capability that is out of scope.
 *       ST-033 (Retrieve Current Cart for Authenticated User):
 *         GET /api/cart → returns cart with line items and subtotal; empty
 *         cart returns 200 with empty items[]; safe to call repeatedly.
 *       ST-034 (Finalize Order with Post-Processing Steps):
 *         POST /api/orders/:id/finalize → transitions order state and runs
 *         documented post-processing (inventory reservation, confirmation
 *         notification, bookkeeping) — explicitly excludes downstream
 *         financial settlement.
 *
 * Cross-cutting rules enforced here:
 *
 *   - Rule R9 (CRITICAL — payment processing excluded). This module is the
 *     frontend surface for the order flow and is THE most likely accidental
 *     entry point for payment-processing creep. Every defensive measure
 *     below is intentional and is enforced by an automated verification
 *     grep that MUST return zero matches against this file:
 *       1. NO imports of any payment-processor SDK whatsoever.
 *       2. NO function names that imply settlement, billing, or financial
 *          transaction handling.
 *       3. NO field names that imply settlement instruments, billing
 *          tokens, or transaction identifiers.
 *       4. The OrderState union is exactly 'created' | 'finalized' — no
 *          payment-outcome states such as 'paid', 'settled', or 'refunded'.
 *       5. ST-034-AC4 explicitly says finalization "explicitly excludes
 *          any downstream financial settlement activity, which remains
 *          out of scope per the epic's scope-exclusion section." Honor
 *          that here in this file's contract.
 *
 *   - Rule R2 (no credentials in logs). This file contains ZERO console.*
 *     calls. Errors are propagated as ApiError (thrown from ./client) so the
 *     calling component decides what to render — never print here.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend). This frontend module does
 *     NOT decode, parse, or validate any JWT. Token attachment is delegated
 *     to ./client which forwards the raw Firebase ID token verbatim to the
 *     backend. The backend's session middleware calls
 *     admin.auth().verifyIdToken() (AAP C2) as the SOLE authority on validity.
 *
 *   - C5 (correlation ID propagation). Every request issued by this module
 *     receives an X-Correlation-Id header generated inside ./client's
 *     request() helper. This file does NOT manage correlation IDs directly.
 *
 * Out of scope (per the file's agent prompt §8):
 *   - Payment processing of any kind (Rule R9).
 *   - addToCart / removeFromCart / updateCartItem — cart manipulation
 *     primitives are not in the 49 stories' surface.
 *   - getOrder(id) / listOrders() — outside ST-032/033/034 scope.
 *   - Optimistic cart updates — calling component's responsibility.
 *   - Client-side subtotal calculation — backend is canonical (ST-033-AC2).
 *   - Network retries — calling component wraps with retry helper if needed.
 */

import { request } from './client';

// ============================================================================
// Cart types — ST-033 response shape
// ============================================================================

/**
 * A single line item in the user's cart.
 *
 * Per ST-033-AC2 the cart response includes "each cart line item with
 * quantity, referenced design identifier, and any per-item metadata required
 * to render the cart, along with a calculated subtotal".
 *
 * Rule R9 note: this type intentionally has NO payment-related fields.
 * Adding a field that names a settlement instrument, billing token, or
 * financial transaction artefact is a Rule R9 violation.
 */
export interface CartItem {
  /**
   * Reference to a saved design owned by the same authenticated user
   * (foreign key to the designs table — see ST-030).
   */
  designId: string;

  /**
   * Positive integer quantity. The backend rejects zero / negative values
   * per ST-032-AC3 ("malformed line items").
   */
  quantity: number;

  /**
   * Optional display title for the design, server-populated as a render
   * convenience. The canonical title source is the designs table; this
   * denormalised copy avoids per-item lookups when rendering the cart UI.
   */
  designTitle?: string;

  /**
   * Per-item metadata; opaque to the frontend. Typed as
   * Record<string, unknown> for forward compatibility — the server may add
   * fields the client does not yet know about. Calling components MUST
   * type-narrow before reading specific keys (e.g.,
   * `if (typeof item.metadata?.color === 'string') { ... }`).
   */
  metadata?: Record<string, unknown>;
}

/**
 * The cart response shape returned by GET /api/cart.
 *
 * Per ST-033-AC3, when the user has no active cart the backend returns this
 * shape with an empty `items` array and a `subtotal` of 0 with HTTP status
 * 200 — NOT a 404. The calling component checks `cart.items.length === 0`
 * to render the empty-cart UI.
 */
export interface Cart {
  /**
   * Line items currently in the cart. Empty array when the user has no
   * active cart (ST-033-AC3).
   */
  items: CartItem[];

  /**
   * Backend-calculated subtotal in the smallest currency unit (e.g., cents
   * for USD). Per ST-033-AC2 the backend computes this; the frontend MUST
   * NOT recompute or override it to avoid pricing drift between client and
   * server.
   */
  subtotal: number;

  /**
   * Optional ISO-4217 currency code (e.g., "USD"). When omitted the
   * calling component MAY default to USD for display purposes; treat the
   * absence of this field as a non-error.
   */
  currency?: string;
}

// ============================================================================
// Order types — ST-032 / ST-034 / ST-035 response shape
// ============================================================================

/**
 * The documented non-terminal order states.
 *
 * Rule R9 enforcement: this union is intentionally limited to TWO states.
 * Adding a state that names a payment outcome — for example 'paid',
 * 'settled', or 'refunded' — requires explicit Rule R9 review; the backend
 * MUST NOT support such transitions per ST-032-AC4 / ST-034-AC4.
 *
 *   - 'created'    — POST /api/orders just persisted the order from the
 *                    cart contents (ST-032-AC2). The order exists, the line
 *                    items are immutable, but no post-processing has run.
 *   - 'finalized'  — POST /api/orders/:id/finalize completed the documented
 *                    post-processing workflow (ST-034-AC2): inventory
 *                    reservation, confirmation notification, bookkeeping.
 *                    NO downstream financial settlement (ST-034-AC4 / R9).
 */
export type OrderState = 'created' | 'finalized';

/**
 * A line item captured at order creation time.
 *
 * Structurally similar to {@link CartItem} but semantically distinct:
 *   - CartItem represents the LIVE cart (mutable on the server).
 *   - OrderItem represents the SNAPSHOT captured at order creation
 *     (immutable per ST-035 schema).
 *
 * Keeping these as distinct types prevents accidental cross-assignment and
 * documents the snapshot semantics: if a design's title is renamed AFTER
 * the order is created, the order's `designTitle` does NOT update.
 *
 * Rule R9 note: as with CartItem, NO payment-related fields are permitted.
 */
export interface OrderItem {
  /**
   * Reference to the design at the time of order creation. The design row
   * may still exist or may have been deleted — the order retains the
   * reference for audit / replay purposes per ST-035.
   */
  designId: string;

  /**
   * Positive integer quantity captured at order creation. Immutable after
   * creation.
   */
  quantity: number;

  /**
   * Snapshot of the design title at the moment the order was created.
   * Per ST-035 schema this is a captured value, not a back-reference —
   * subsequent design title changes do not propagate here.
   */
  designTitle?: string;

  /**
   * Per-item metadata captured at order creation. Same forward-compatible
   * Record<string, unknown> shape as CartItem; type-narrow before reading.
   */
  metadata?: Record<string, unknown>;
}

/**
 * The canonical persisted order returned by POST /api/orders and
 * POST /api/orders/:id/finalize.
 *
 * Per ST-032-AC2: "A successful order creation returns the canonical
 * persisted order, including a server-assigned order identifier, the line
 * items, a calculated subtotal, and a created timestamp."
 *
 * Rule R9 enforcement: NONE of the fields below name a settlement
 * instrument, billing token, or financial transaction artefact. Order
 * finalization (ST-034) transitions the `state` field from 'created' to
 * 'finalized' WITHOUT any downstream financial settlement.
 */
export interface Order {
  /**
   * Server-assigned order identifier. The backend writes a fresh UUID per
   * ST-032-AC2 ("server-assigned order identifier"). Treated as opaque on
   * the frontend — no parsing, no inspection.
   */
  id: string;

  /**
   * Current state of the order. Transitions:
   *   - 'created'   immediately after POST /api/orders.
   *   - 'finalized' after POST /api/orders/:id/finalize completes
   *                 successfully (ST-034-AC1).
   *
   * Per Rule R9, no further states are valid. The backend MUST NOT
   * advance the order to a state that names a payment outcome.
   */
  state: OrderState;

  /**
   * Snapshot line items captured at order creation. Immutable thereafter
   * per ST-035.
   */
  items: OrderItem[];

  /**
   * Subtotal at order creation time. NOT recomputed during finalization
   * per ST-034 ("scope of finalization is limited to the post-processing
   * workflow named above") — finalization runs inventory reservation,
   * notification, and bookkeeping; it does NOT re-price the order.
   */
  subtotal: number;

  /**
   * Optional ISO-4217 currency code. As with Cart.currency, when omitted
   * the calling component defaults to USD for display.
   */
  currency?: string;

  /**
   * ISO-8601 timestamp recorded when the order was created
   * (ST-032-AC2: "a created timestamp").
   */
  createdAt: string;

  /**
   * ISO-8601 timestamp of the last state change. Equal to `createdAt`
   * immediately after creation; updates on finalization to reflect the
   * post-processing completion time per ST-034-AC2.
   */
  lastModifiedAt: string;
}

/**
 * Optional input payload for {@link createOrder}.
 *
 * Per ST-032-AC1, the endpoint "writes a new order record with order line
 * items derived from the authenticated user's current cart contents". The
 * backend is therefore the canonical source of cart contents.
 *
 * The optional `items` field exists to support a defensive contract:
 *   1. Default contract — caller passes no items; backend reads the cart
 *      and creates the order from it. This is the documented behaviour
 *      and the path tested by ST-045 E2E flows.
 *   2. Override contract — caller passes an explicit items array; if the
 *      backend supports an override mode, those items are used. If not,
 *      the field is ignored without harm.
 *
 * The cleaner contract is (1); (2) is forward-compatible defence.
 */
export interface CreateOrderInput {
  /**
   * Optional explicit line items. Omit (the typical case) to let the
   * backend derive items from the authenticated user's current cart per
   * ST-032-AC1.
   */
  items?: CartItem[];
}

// ============================================================================
// API functions — every call delegates to ./client's request() helper
// ============================================================================
//
// The cross-cutting concerns enforced by request() are:
//   - Authorization: Bearer ${idToken} attachment (Rule R3).
//   - X-Correlation-Id: ${uuid} attachment (AAP C5).
//   - JSON serialization of the request body.
//   - JSON parsing of 2xx response bodies.
//   - ApiError thrown for non-2xx responses, with the parsed body attached.
//   - Zero console.* calls (Rule R2).
// ============================================================================

/**
 * Retrieve the authenticated user's current cart from the backend (ST-033).
 *
 * Endpoint: GET /api/cart
 * Auth: requires a Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-033 acceptance criteria):
 *   - AC1: returns ONLY the cart belonging to the authenticated user; the
 *     backend's session middleware enforces ownership before this call's
 *     response is constructed.
 *   - AC2: response includes line items with design id, quantity, optional
 *     metadata, and a backend-calculated subtotal.
 *   - AC3: when the user has no active cart, the backend returns an empty
 *     cart `{ items: [], subtotal: 0 }` with HTTP 200 — NOT a 404. The
 *     calling component renders an empty-cart UI based on
 *     `cart.items.length === 0`, NOT on a thrown ApiError.
 *   - AC4: this call is side-effect-free and idempotent. It is safe to
 *     re-issue on every render of a cart-viewing component.
 *
 * Rule R9: this is a READ-ONLY call. It does NOT initiate any settlement,
 * does NOT create any order, and does NOT mutate cart state. The endpoint
 * is "safe to call repeatedly from the client without side effects" per
 * ST-033-AC4.
 *
 * @returns The user's current cart. May contain zero items per ST-033-AC3.
 * @throws ApiError 401 when the Firebase session is invalid or expired.
 *   The calling component prompts re-authentication.
 * @throws ApiError 5xx for backend errors. The calling component shows a
 *   generic retry UI.
 */
export async function getCart(): Promise<Cart> {
  return request<Cart>('/api/cart');
}

/**
 * Create a persistent order from the authenticated user's cart contents
 * (ST-032).
 *
 * Endpoint: POST /api/orders
 * Auth: requires a Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-032 acceptance criteria):
 *   - AC1: requires a valid session AND derives order line items from the
 *     authenticated user's CURRENT cart contents (the cart is canonical).
 *   - AC2: on success returns the canonical persisted Order with a
 *     server-assigned UUID `id`, the snapshot `items`, a calculated
 *     `subtotal`, and a `createdAt` timestamp.
 *   - AC3: rejects empty carts, malformed line items, and invalid design
 *     references with HTTP 400 and a descriptive message in the response
 *     body — the persistence layer is left UNCHANGED on rejection.
 *   - AC4: persists the order in the documented non-terminal `'created'`
 *     state. Downstream financial settlement is OUT OF SCOPE per the
 *     epic's scope-exclusion section AND per Rule R9 across the entire
 *     codebase.
 *
 * Rule R9: order creation persists line items in the `'created'` state.
 * NO billing authorization, NO settlement, NO tokenization happens on
 * either side of the wire — neither in this frontend wrapper nor in the
 * backend handler that processes the request.
 *
 * Body contract: when `input.items` is omitted (the typical case) the
 * backend uses the cart. The body defaults to `{}` so that the
 * Content-Type negotiation in ./client's request() works correctly even
 * when the caller passes no input.
 *
 * @param input - Optional explicit override; omit for the standard
 *   "create from cart" flow (ST-032-AC1).
 * @returns The newly created Order with `state === 'created'`.
 * @throws ApiError 400 when the cart is empty, line items are malformed,
 *   or design references are invalid (ST-032-AC3). The error body's
 *   message field describes the specific problem.
 * @throws ApiError 401 when the Firebase session is invalid or expired.
 * @throws ApiError 5xx for backend errors. The calling component shows a
 *   generic retry UI; per ST-032-AC3 the persistence layer is left
 *   unchanged so retry is safe.
 */
export async function createOrder(input: CreateOrderInput = {}): Promise<Order> {
  return request<Order>('/api/orders', {
    method: 'POST',
    body: input,
  });
}

/**
 * Finalize an existing order by triggering the documented post-processing
 * workflow (ST-034).
 *
 * Endpoint: POST /api/orders/:id/finalize
 * Auth: requires a Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-034 acceptance criteria):
 *   - AC1: requires a valid session, operates ONLY on an existing order
 *     OWNED by the authenticated user, and transitions that order to the
 *     documented `'finalized'` state.
 *   - AC2: triggers the documented post-processing workflow — reserving
 *     inventory against the order's line items, emitting an order
 *     confirmation notification to the authenticated user, and recording
 *     order-state bookkeeping entries — and persists the outcome of each
 *     step against the order. The `lastModifiedAt` field updates on
 *     successful completion.
 *   - AC3: rejects with HTTP 409 when the order is already finalized; with
 *     HTTP 400 when references are missing or any post-processing step
 *     fails. On rejection the persisted order is left COHERENT (either
 *     fully finalized or unchanged) so callers can safely retry.
 *   - AC4: finalization scope is LIMITED to the post-processing workflow
 *     above and EXPLICITLY EXCLUDES any downstream financial settlement
 *     activity per the epic's scope-exclusion section. This is Rule R9
 *     reified at the most sensitive call site in the entire frontend.
 *
 * Rule R9 enforcement at this call site:
 *   - The endpoint name "/finalize" deliberately does NOT name a billing
 *     verb such as "settle" or "capture".
 *   - The body is an empty `{}` object — there is NO field through which
 *     billing instruments could be transmitted. Future extensibility
 *     (e.g., shipping notes) can populate the body, but adding any field
 *     associated with downstream financial settlement requires explicit
 *     Rule R9 review.
 *   - On success the returned Order's `state` field is `'finalized'`,
 *     never a state that names a payment outcome.
 *
 * The `orderId` is URL-encoded defensively. Per ST-032-AC2 the server
 * assigns the id, so the value is expected to be a UUID string and
 * encoding is a no-op for canonical IDs — but if a future identifier
 * scheme allows characters that are special in URLs (e.g., `/`), this
 * call site already handles them safely.
 *
 * @param orderId - The id of an existing order owned by the
 *   authenticated user (typically obtained from a previous {@link
 *   createOrder} response's `id` field).
 * @returns The finalized Order with `state === 'finalized'` and an
 *   updated `lastModifiedAt` timestamp.
 * @throws ApiError 400 when the order is missing required references or
 *   any post-processing step fails (ST-034-AC3).
 * @throws ApiError 401 when the Firebase session is invalid or expired.
 * @throws ApiError 403 when the authenticated user does not own the
 *   target order (per ST-034-AC1 finalization operates only on orders
 *   the user owns).
 * @throws ApiError 404 when the order does not exist.
 * @throws ApiError 409 when the order is ALREADY in the `'finalized'`
 *   state (ST-034-AC3). The calling component surfaces a "this order
 *   is already finalized" message.
 * @throws ApiError 5xx for backend errors.
 */
export async function finalizeOrder(orderId: string): Promise<Order> {
  const path = `/api/orders/${encodeURIComponent(orderId)}/finalize`;
  return request<Order>(path, {
    method: 'POST',
    body: {},
  });
}
