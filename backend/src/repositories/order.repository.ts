/**
 * Order repository — data-access layer for the `orders` and `order_items`
 * tables.
 *
 * This module owns every direct read or write of the `orders` and
 * `order_items` tables. Higher layers (services, routes) depend ONLY on the
 * typed {@link OrderRepository} interface — they do not import `pg` and do
 * not know any SQL. Co-locating SQL with its schema knowledge keeps
 * migration changes localised and makes the layer trivially mockable in
 * unit tests.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/repositories/order.repository.ts | CRUD for orders
 *        and order_items tables`
 *   - AAP §0.6.4 Track 1 T1-C: repositories belong to the dependency-ordered
 *     backend API implementation.
 *   - Story ST-032 (create order from cart contents via order endpoint).
 *   - Story ST-033 (retrieve cart endpoint).
 *   - Story ST-034 (finalize order post-processing).
 *   - Story ST-035 (orders + order_items schema migration with indexes).
 *
 * Architectural intent:
 *   The `orders` table is the durable home for every persisted purchase
 *   intent. Each row is owned by exactly one user (FK to `users.id`, the
 *   Firebase uid per AAP §0.2.1) and carries a `state` enum that drives
 *   the lifecycle: `cart` → `created` → `finalized` (with `cancelled` as
 *   an off-ramp). The `order_items` table is the parent-child detail
 *   table; one `orders` row can have N `order_items` rows. Both tables
 *   share the same composite ownership story: every multi-row operation
 *   filters by `user_id` (in SQL) so a bug in the session middleware
 *   cannot leak another user's orders or items.
 *
 *   Three properties are enforced uniformly across every query in this
 *   file:
 *     1. Ownership is enforced IN SQL — every single-row SELECT/UPDATE
 *        filters by `user_id = $N`. Defense-in-depth against a
 *        middleware-attribution defect (AAP §0.5.1).
 *     2. `last_modified_at` is mutated SERVER-SIDE via PostgreSQL's
 *        `now()`, never via an application-supplied timestamp. Clock
 *        skew between the API server and PG cannot perturb the order
 *        history audit trail.
 *     3. The `metadata` column on `order_items` is bound through an
 *        explicit `$N::jsonb[]` cast with each element pre-serialised
 *        via `JSON.stringify`. This is the most portable pattern across
 *        pg minor versions and matches the query plan PostgreSQL
 *        expects.
 *
 * Why a transaction for createOrderFromCart (the headline insight here):
 *   Inserting an `orders` row and its `order_items` rows is a multi-
 *   statement write. If we used `pool.query` for each statement, a
 *   failure on the second statement would leave a stranded `orders` row
 *   with no items — a corrupted business object. The only correct
 *   pattern is `BEGIN`/`COMMIT`/`ROLLBACK` against a single
 *   {@link import('pg').PoolClient}: acquire one with `pool.connect()`,
 *   wrap every statement in BEGIN/COMMIT, ROLLBACK on any error, and
 *   release the client in a `finally` block so the connection cannot
 *   leak even when an error occurs mid-transaction. Every other method
 *   in this repository is a single statement and can use `pool.query`
 *   directly.
 *
 * Cart modeling decision (recorded in `docs/decisions/README.md`):
 *   The "cart" is modeled as `orders` rows where `state = 'cart'` rather
 *   than as a separate `cart` table. Rationale:
 *     - One source of truth: the same row evolves from cart to created
 *       to finalized via state transitions; no record-copying needed.
 *     - Schema simplicity: ST-035 already asks for `orders` +
 *       `order_items`, and reusing them for the cart projection avoids
 *       a third table whose only job is to collect things that will
 *       become an order.
 *     - Query parity: `findCartForUser` and `findOrderById` share the
 *       same join pattern; the only difference is the state predicate.
 *
 *   Trade-off accepted: there is at most one `state='cart'` row per user
 *   at a time. Enforcing that invariant is a service-layer concern (the
 *   service should refuse to create a second cart row); the repository
 *   surfaces the FIRST matching row via `LIMIT 1` on the subtotal query.
 *
 * Idempotent finalization (ST-034-AC3):
 *   `updateOrderState` accepts both a `newState` and an `expectedState`,
 *   and the SQL predicate `WHERE state = $4` (i.e. `state = expectedState`)
 *   is part of the UPDATE itself. This makes the operation idempotent at
 *   the database tier:
 *     - First call:  `state` is `expectedState` → row updates → returns
 *                    the new row.
 *     - Second call: `state` is `newState` (already transitioned) → no
 *                    rows match → RETURNING produces empty → repository
 *                    returns `null` → service treats as "already
 *                    finalized" without raising.
 *   Crucially, this is RACE-FREE under PostgreSQL's READ COMMITTED
 *   isolation: two concurrent finalization requests that both observe
 *   `state='created'` will serialize at the row lock; the second waits
 *   for the first to commit, then re-reads the row, finds
 *   `state='finalized'`, and the WHERE clause excludes it.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): this repository never logs
 *     and never accepts credential material. The `metadata` column is
 *     JSONB intended for per-line-item rendering hints (e.g. selected
 *     color, quantity adjustments) — it is the service layer's
 *     responsibility to ensure no credentials reach this column. The
 *     repository treats metadata as opaque `Record<string, unknown>`.
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. Token verification is the
 *     exclusive responsibility of `backend/src/auth/firebase-admin.ts`.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. The {@link import('pg').Pool} is dependency-injected
 *     by the caller (`backend/src/db/pool.ts` builds the pool from
 *     `DATABASE_URL`).
 *   - R9 (no payment processing): this module is FULLY COMPLIANT. The
 *     {@link OrderState} enum is exactly `'cart' | 'created' |
 *     'finalized' | 'cancelled'` — no payment-processor or
 *     financial-settlement vocabulary appears anywhere in this file
 *     (see AAP §0.7.2 for the explicit exclusion list). The
 *     `subtotal` column is a bookkeeping value (sum of line-item
 *     amounts) and carries no financial-settlement semantics.
 *   - R10 (migration filename pattern): N/A here; this module is consumed
 *     by — but does not author — the migration file
 *     `backend/migrations/{ts}_ST-035_orders_order_items.js`.
 *
 * Why `subtotal` is a `string` and not a `number` everywhere:
 *   PostgreSQL's `NUMERIC(12,2)` is an arbitrary-precision decimal type.
 *   The default `pg` driver returns NUMERIC values as JavaScript strings
 *   to preserve exact precision — converting to `number` would silently
 *   lose precision for amounts above 2^53 cents (`Number.MAX_SAFE_INTEGER
 *   / 100` ≈ $90,071,992,547,409.91). For a configurator that may one
 *   day handle B2B bulk orders, that ceiling is too low to assume away.
 *   The cost is that arithmetic on subtotals must go through a decimal-
 *   safe library at the service layer; the repository simply preserves
 *   the precision the database hands it.
 *
 * Design discipline:
 *   - Parameterised queries only. Every SQL constant uses `$1`, `$2`
 *     placeholders; user-supplied values flow through the `values` array
 *     of the `QueryConfig`. There is no string interpolation of input
 *     anywhere in this file (SQL-injection invariant).
 *   - The repository is constructed via a factory (`createOrderRepository`)
 *     rather than as a class. Factories make dependency injection
 *     explicit, support `Object.freeze` of the returned record
 *     (preventing accidental method monkey-patching), and play well
 *     with tree-shaking.
 *   - Bulk inserts of `order_items` use the `UNNEST(...)` pattern. Each
 *     parameter is bound exactly once; the SQL has fixed cardinality
 *     ($1..$4) regardless of how many rows are inserted. This is both
 *     SQL-injection safe and dramatically faster than building a
 *     `VALUES ($1,$2,$3),($4,$5,$6),...` list at runtime.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/db/pool.ts` — provides the `Pool` injected here.
 *   - `backend/src/services/order.service.ts` — primary consumer; calls
 *     `createOrderFromCart` (POST `/api/orders`), `findOrderById` (GET
 *     order detail when added later), `updateOrderState` (POST
 *     `/api/orders/:id/finalize`), and `findCartForUser` (GET `/api/cart`).
 *   - `backend/src/routes/orders.ts` + `backend/src/routes/cart.ts` —
 *     thin HTTP shells that delegate to the service.
 *   - `backend/src/repositories/user.repository.ts` — the `users` table
 *     is the parent for the `user_id` foreign-key column.
 *   - `backend/src/repositories/design.repository.ts` — the `designs`
 *     table is the parent for the `order_items.design_id` foreign-key
 *     column.
 *   - `backend/migrations/{ts}_ST-035_orders_order_items.js` — defines
 *     the schema, FKs, and indexes (`(user_id, state)` is what makes
 *     `findCartForUser` index-only).
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Section 1: Public types — domain shape exposed to higher layers.
// ---------------------------------------------------------------------------

/**
 * Order state enum. Drives the order lifecycle exposed to the service and
 * route layers.
 *
 * Acceptable values:
 *   - `'cart'`
 *       The pre-order projection. A user may have at most one
 *       `state='cart'` row at a time (enforced by the service layer).
 *       This is the "shopping cart" the user is composing.
 *   - `'created'`
 *       The initial post-submission state. The order has been
 *       persisted as a durable record but has not yet completed
 *       post-processing. This is the documented non-terminal state
 *       referenced by ST-032-AC4.
 *   - `'finalized'`
 *       The order has completed the post-processing workflow named
 *       in ST-034 (inventory reservation, confirmation notification,
 *       bookkeeping entries). This is the documented finalized state
 *       referenced by ST-034-AC1.
 *   - `'cancelled'`
 *       The order was cancelled before finalization. This is NOT a
 *       financial-settlement operation; it simply marks the order
 *       as no longer active.
 *
 * Explicitly EXCLUDED values (per Rule R9 — AAP §0.8.1 / §0.7.2):
 *   No financial-settlement vocabulary appears anywhere in this enum.
 *   Payment processing is out of scope for the entire backend (see
 *   AAP §0.7.2). The decision to use this exact enum vocabulary is
 *   documented in `docs/decisions/README.md` per the user-provided
 *   Explainability Rule.
 */
export type OrderState = 'cart' | 'created' | 'finalized' | 'cancelled';

/**
 * A single line item within an order or cart.
 *
 * Field-level contract:
 *
 *   `orderId`
 *     The owning order's UUID. For cart projections (returned via
 *     {@link OrderRepository.findCartForUser}) this is the empty string
 *     `''` because a "cart" is a virtual aggregate — the user does not
 *     have a stable `orders.id` to point at until the cart transitions
 *     to `state='created'`. Service-layer consumers MUST treat the
 *     empty string as "this item is in a cart, not a created order".
 *
 *   `designId`
 *     The UUID of the design referenced by this line item; foreign-key
 *     to `designs.id` (per ST-035-AC2).
 *
 *   `quantity`
 *     A positive integer; the `quantity > 0` CHECK constraint in the
 *     migration enforces this at the DB tier. Per-row, never aggregated.
 *
 *   `metadata`
 *     Opaque per-item rendering or selection metadata. Stored as JSONB.
 *     The service layer is responsible for shape validation; the
 *     repository treats it as `Record<string, unknown>` and never
 *     inspects its contents.
 *
 * The interface is `readonly`-on-every-field so consumers cannot mutate
 * the record after retrieval.
 */
export interface OrderItem {
  /**
   * The owning order's UUID, or the empty string for cart projections.
   * Consumers MUST treat the empty string as "this is a cart line item,
   * not an order line item".
   */
  readonly orderId: string;
  /** UUID of the referenced design; FK to `designs.id`. */
  readonly designId: string;
  /** Positive integer; enforced by DB CHECK constraint. */
  readonly quantity: number;
  /** Opaque per-item metadata; JSONB in storage. */
  readonly metadata: Record<string, unknown>;
}

/**
 * Input shape for cart line items when creating an order.
 *
 * Notice what is NOT here:
 *   - No `orderId` field. The order is being created in the same
 *     transaction; pinning the parent's id at input time would make
 *     it impossible to use the `RETURNING id` from the parent INSERT.
 *   - No `subtotal` per item. Per-line-item amounts are folded into
 *     the order-level subtotal by the service layer; the repository
 *     persists the aggregate without re-calculating from individual
 *     items.
 *
 * The shape is intentionally minimal: the smallest set of values the
 * repository needs to populate one row of `order_items`.
 */
export interface CartItemInput {
  /** UUID of the design being added to the cart/order. */
  readonly designId: string;
  /** Positive integer; the service layer rejects 0 / negative values
   * before the repository sees them, but the DB CHECK constraint is
   * the ultimate guard. */
  readonly quantity: number;
  /** Opaque per-item metadata; serialised as JSONB. */
  readonly metadata: Record<string, unknown>;
}

/**
 * An order as persisted in the `orders` table, including its joined line
 * items when fetched by id.
 *
 * Field-level contract:
 *
 *   `id`
 *     The server-assigned UUID primary key. Generated DB-side (per the
 *     ST-035 migration's `DEFAULT gen_random_uuid()`) so the application
 *     never thinks about UUID collision avoidance.
 *
 *   `userId`
 *     The owning user's local id (= Firebase uid, per AAP §0.2.1).
 *     Backed by a foreign key to `users.id` with `ON DELETE CASCADE`.
 *
 *   `state`
 *     Current lifecycle state; see {@link OrderState}.
 *
 *   `subtotal`
 *     The aggregate amount as a string preserving NUMERIC precision.
 *     Format is "999999999.99"-style (12 digits total, 2 after the
 *     decimal point per the migration's `NUMERIC(12,2)`). Service-layer
 *     consumers MUST use a decimal-safe library for arithmetic — see
 *     the file-level docblock for rationale.
 *
 *   `createdAt`
 *     The DB-assigned creation timestamp (column default `now()`).
 *
 *   `lastModifiedAt`
 *     The DB-assigned last-modification timestamp. Bumped to `now()`
 *     by every state transition via {@link OrderRepository.updateOrderState}.
 *
 *   `items`
 *     The joined line items, ordered deterministically by
 *     `design_id`. May be empty for orders fetched without a join (e.g.
 *     by {@link OrderRepository.updateOrderState}, which returns the
 *     bare order row); the empty array is the correct signal in that
 *     case.
 *
 * The interface is fully `readonly` so consumers cannot mutate the
 * record after retrieval. To change an order, callers must go through
 * repository methods that explicitly construct a new state — every
 * mutation is therefore a deliberate database write.
 */
export interface Order {
  /** Server-assigned UUID; primary key. */
  readonly id: string;
  /** Owning user's id (= Firebase uid, per AAP §0.2.1). */
  readonly userId: string;
  /** Current lifecycle state. */
  readonly state: OrderState;
  /** NUMERIC subtotal as a string to preserve precision. */
  readonly subtotal: string;
  /** DB-assigned creation timestamp. */
  readonly createdAt: Date;
  /** DB-assigned last-modification timestamp. */
  readonly lastModifiedAt: Date;
  /** Joined line items; empty array when the row was fetched without
   * a join. */
  readonly items: OrderItem[];
}

/**
 * A cart projection — always rooted by `userId`.
 *
 * When the user has no `state='cart'` order, the repository still
 * returns a well-formed {@link Cart}: `items: []` and `subtotal: '0.00'`.
 * Per ST-033-AC3 this "empty cart" representation is preferred over a
 * not-found error because it makes the client's render logic
 * unconditional.
 *
 * Field-level contract:
 *
 *   `userId`
 *     The user the cart belongs to. Echoed back from the input
 *     parameter so the client can correlate the response to the
 *     request without a server round-trip.
 *
 *   `items`
 *     The cart's line items. Each `OrderItem.orderId` is the empty
 *     string (per the {@link OrderItem.orderId} contract).
 *
 *   `subtotal`
 *     The cart's NUMERIC subtotal as a string; `'0.00'` for an empty
 *     cart.
 */
export interface Cart {
  /** The user this cart belongs to. */
  readonly userId: string;
  /** Line items in the cart; empty array for a fresh user. */
  readonly items: OrderItem[];
  /** NUMERIC subtotal as a string; `'0.00'` for an empty cart. */
  readonly subtotal: string;
}

/**
 * Parameters for {@link OrderRepository.createOrderFromCart}.
 *
 *   `userId`
 *     The owning user's id (= Firebase uid). Becomes the `user_id`
 *     column on the inserted `orders` row.
 *
 *   `cartItems`
 *     The line items to insert. May be an empty array; in that case
 *     the order is created with no line items (the service layer
 *     should reject empty carts at the route boundary per ST-032-AC3,
 *     but the repository does not enforce that — it persists what it
 *     is asked to persist).
 *
 *   `subtotal`
 *     The pre-calculated subtotal as a NUMERIC-safe string. The
 *     service layer is responsible for the calculation; the
 *     repository simply persists the value.
 */
export interface CreateOrderFromCartParams {
  /** Owning user id (= Firebase uid). */
  userId: string;
  /** Line items to insert; may be empty. */
  cartItems: CartItemInput[];
  /** Pre-calculated subtotal as a NUMERIC-safe string. */
  subtotal: string;
}

/**
 * Parameters for {@link OrderRepository.findOrderById}.
 *
 * Both `userId` and `orderId` are required because the WHERE clause
 * pins ownership in SQL. A consumer that supplies the wrong `userId`
 * for a real order id will get `null` back (not the order); this is
 * the defense-in-depth posture documented in the file-level docblock.
 */
export interface FindOrderByIdParams {
  /** Owning user id (= Firebase uid). */
  userId: string;
  /** UUID of the order to fetch. */
  orderId: string;
}

/**
 * Parameters for {@link OrderRepository.updateOrderState}.
 *
 *   `userId` + `orderId`
 *     Pin ownership in SQL.
 *
 *   `newState`
 *     The state to transition to.
 *
 *   `expectedState`
 *     The state the row MUST currently be in for the transition to
 *     succeed. The SQL `WHERE state = expectedState` predicate is what
 *     makes finalization idempotent (ST-034-AC3): a second call
 *     against an already-finalized order matches zero rows and the
 *     repository returns `null`.
 *
 * The expected/new pair is also a defense against state-transition
 * skipping bugs: a service layer that wants to go from `'cart'` to
 * `'finalized'` directly would be doing two transitions; the
 * `expectedState` parameter forces the caller to spell out what they
 * thought the row was.
 */
export interface UpdateOrderStateParams {
  /** Owning user id (= Firebase uid). */
  userId: string;
  /** UUID of the order whose state is changing. */
  orderId: string;
  /** Target state. */
  newState: OrderState;
  /** Required current state — the WHERE predicate enforcing
   * idempotency. */
  expectedState: OrderState;
}

/**
 * Repository interface — the public contract callers depend on.
 *
 * Four methods, sized to the actual needs of stories ST-032 / ST-033 /
 * ST-034:
 *
 *   - `createOrderFromCart(params)` — atomic creation of an order with
 *     line items. The ONLY method in this repository that uses a
 *     transaction (BEGIN/COMMIT/ROLLBACK against an acquired
 *     `PoolClient`).
 *
 *   - `findOrderById(params)` — fetch a single order by `(userId,
 *     orderId)`, including its joined line items. Returns `null` if no
 *     row matches (does not exist OR the caller does not own it; the
 *     two cases are intentionally indistinguishable).
 *
 *   - `updateOrderState(params)` — conditional state transition.
 *     Idempotent under the `state = expectedState` predicate (ST-034-AC3).
 *     Returns the updated row, or `null` if the WHERE clause matched
 *     zero rows (which means the order does not exist, the caller
 *     does not own it, or the row is no longer in `expectedState`).
 *     Note: the returned `Order.items` is the empty array; this method
 *     does not re-fetch line items.
 *
 *   - `findCartForUser(userId)` — fetch the user's current cart
 *     projection. ALWAYS returns a {@link Cart} — never `null`. An
 *     empty cart returns `items: []` and `subtotal: '0.00'`
 *     (ST-033-AC3).
 *
 * Out-of-scope per AAP §0.7.2: no `delete*`, no admin-style listings,
 * no payment-related state transitions. The 49-story acceptance scope
 * does not require those operations; adding them would violate the
 * AAP §0.7.2 boundary.
 */
export interface OrderRepository {
  /**
   * Atomically create an order with its line items.
   *
   * The implementation acquires a single `PoolClient`, wraps the
   * INSERTs in `BEGIN`/`COMMIT`, and ROLLBACKs on any error. The
   * client is released in a `finally` block so the connection cannot
   * leak even when an error occurs mid-transaction.
   *
   * @throws The native pg error if any of the INSERTs fails (e.g. an
   *   FK violation on `order_items.design_id` because the supplied
   *   design id does not exist). The service layer is responsible
   *   for translating PG error codes to HTTP status codes.
   * @throws A wrapping `Error` if the order INSERT executes but does
   *   not return a row — vanishingly rare; a defensive guard for the
   *   downstream non-null contract.
   */
  createOrderFromCart(params: CreateOrderFromCartParams): Promise<Order>;

  /**
   * Look up a single order plus its joined line items.
   *
   * The order row and the items rows are fetched in two separate
   * queries (rather than a single LEFT JOIN) to keep row mapping
   * simple — a JOIN would return one row per item, requiring a
   * group-by mapper. The performance cost is negligible because
   * `pg`'s pool keeps round-trips cheap.
   *
   * Returns `null` when no row matches; service-layer consumers map
   * `null` to HTTP 404.
   */
  findOrderById(params: FindOrderByIdParams): Promise<Order | null>;

  /**
   * Conditionally transition an order's state. Idempotent under the
   * `state = expectedState` predicate.
   *
   * Returns the updated `Order` (with `items: []` — this method does
   * NOT re-fetch line items) on success, or `null` when the WHERE
   * clause matches zero rows. Service-layer consumers can interpret
   * `null` as "already in `newState`", "does not exist", or "not
   * owned" — the three cases are intentionally indistinguishable.
   */
  updateOrderState(params: UpdateOrderStateParams): Promise<Order | null>;

  /**
   * Fetch the user's current cart projection. Always returns a
   * well-formed `Cart`, never `null`. An empty cart is `{ userId,
   * items: [], subtotal: '0.00' }`.
   */
  findCartForUser(userId: string): Promise<Cart>;
}

// ---------------------------------------------------------------------------
// Section 2: Private row types — exact mirror of the table column shape.
// ---------------------------------------------------------------------------

/**
 * The exact row shape returned by `pool.query<OrderRow>()` when selecting
 * from `orders`.
 *
 * Property names match database column names verbatim (`user_id`,
 * `created_at`, `last_modified_at`); the mapper function below is the
 * single place that converts snake_case to camelCase. Centralising the
 * conversion means a column rename only requires updating one file
 * (here) plus the migration; no search-and-replace across services.
 */
interface OrderRow {
  id: string;
  user_id: string;
  state: OrderState;
  /** NUMERIC(12,2) — pg returns this as a string to preserve precision. */
  subtotal: string;
  created_at: Date;
  last_modified_at: Date;
}

/**
 * The exact row shape returned by `pool.query<OrderItemRow>()` when
 * selecting from `order_items`.
 *
 * `metadata` is typed as `unknown` because pg deserialises JSONB into
 * a plain JS value (object, array, string, number, boolean, or null);
 * the mapper coerces it back into the public `Record<string, unknown>`
 * contract.
 */
interface OrderItemRow {
  order_id: string;
  design_id: string;
  quantity: number;
  metadata: unknown;
}

/**
 * The exact row shape returned when selecting cart line items via the
 * cart-projection JOIN.
 *
 * No `order_id` column because the cart projection erases the
 * underlying `orders.id` (per the {@link OrderItem.orderId} contract,
 * cart line items have an empty-string `orderId`).
 */
interface CartItemRow {
  design_id: string;
  quantity: number;
  metadata: unknown;
}

// ---------------------------------------------------------------------------
// Section 3: Private mapper functions — single source of truth row → domain.
// ---------------------------------------------------------------------------

/**
 * Convert a raw `pg` order_items row into the public {@link OrderItem}
 * shape.
 *
 * The `metadata ?? {}` fallback is defensive: in well-formed
 * deployments the `metadata` column is `NOT NULL DEFAULT '{}'::jsonb`
 * so the mapper should always see a populated object, but historical
 * rows or out-of-band writes could surface `null` and we'd rather hand
 * the caller `{}` than `null` for the public contract.
 */
function mapOrderItemRow(row: OrderItemRow): OrderItem {
  return {
    orderId: row.order_id,
    designId: row.design_id,
    quantity: row.quantity,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Convert a raw `pg` orders row into the public {@link Order} shape.
 *
 * The `items` argument is provided by the caller because not every
 * code path joins the items table:
 *   - {@link OrderRepository.findOrderById} runs a second query and
 *     passes the mapped items.
 *   - {@link OrderRepository.createOrderFromCart} builds the items
 *     array from the bulk-INSERT result.
 *   - {@link OrderRepository.updateOrderState} passes `[]` because
 *     the UPDATE only touches `orders` and the caller does not need
 *     items echoed back.
 */
function mapOrderRow(row: OrderRow, items: OrderItem[] = []): Order {
  return {
    id: row.id,
    userId: row.user_id,
    state: row.state,
    subtotal: row.subtotal,
    createdAt: row.created_at,
    lastModifiedAt: row.last_modified_at,
    items,
  };
}

/**
 * Convert a raw cart-projection row into the public {@link OrderItem}
 * shape.
 *
 * The key distinction from {@link mapOrderItemRow} is the `orderId: ''`
 * convention: cart projections do not expose the underlying `orders.id`
 * because the "cart" is conceptually a virtual aggregate (even though
 * physically it is a `state='cart'` row in `orders`). Service-layer
 * code that relies on this convention is documented in the
 * {@link OrderItem.orderId} field contract.
 */
function mapCartItemRow(row: CartItemRow): OrderItem {
  return {
    orderId: '', // cart line items have no exposed parent order id
    designId: row.design_id,
    quantity: row.quantity,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Section 4: SQL constants — parameterised, audit-ready statements.
// ---------------------------------------------------------------------------

/**
 * INSERT a new `orders` row in the initial `'created'` state.
 *
 * Two columns are explicitly written (`user_id`, `subtotal`); the
 * remainder come from column defaults:
 *   - `id`               : `gen_random_uuid()`
 *   - `state`            : the literal `'created'` (set in this SQL
 *                          rather than as a column default so the
 *                          intent is visible in the call site)
 *   - `created_at`       : `now()`
 *   - `last_modified_at` : `now()`
 *
 * The `state` column is set to the literal `'created'` rather than
 * relying on a default because the `cart`-vs-`created` distinction is
 * meaningful: a default of `'created'` would make it impossible to
 * INSERT a cart row directly, and a default of `'cart'` would risk a
 * forgotten state transition leaving orders stuck in `cart` after the
 * service believes they were created. Spelling out `'created'` in the
 * SQL is the cleanest way to make the intent unambiguous in the
 * call-site.
 *
 * The RETURNING clause hands back the full canonical row so the
 * caller does not need a follow-up SELECT to discover the assigned id
 * or timestamps. This matters most inside the transaction in
 * {@link OrderRepository.createOrderFromCart}, where the returned id
 * is needed to populate `order_items.order_id`.
 */
const INSERT_ORDER_SQL = `
  INSERT INTO orders (user_id, state, subtotal)
  VALUES ($1, 'created', $2::numeric)
  RETURNING id, user_id, state, subtotal, created_at, last_modified_at
`;

/**
 * Bulk INSERT into `order_items` using `UNNEST` to expand parallel
 * arrays into rows.
 *
 * Why `UNNEST` and not a generated `VALUES ($1,$2,$3),($4,$5,$6),...`
 * list:
 *   - SQL with FIXED cardinality ($1..$4) regardless of the number of
 *     items inserted. The query plan is cached once by PostgreSQL for
 *     all sizes; a generated VALUES list defeats statement caching.
 *   - Each parameter binds exactly once. SQL injection is impossible
 *     even if the SQL string were leaked to a user-controlled context
 *     (which it isn't, but the safety margin matters).
 *   - The pg driver passes JS arrays through directly; no string
 *     concatenation, no per-row binding loop in JS.
 *
 * Casts:
 *   - `$1::uuid`           : the parent `orders.id` is the same value
 *                            for every line item, repeated implicitly
 *                            via the SELECT.
 *   - `$2::uuid[]`         : the array of `design_id` values.
 *   - `$3::int[]`          : the array of `quantity` values.
 *   - `$4::jsonb[]`        : the array of `metadata` values; the
 *                            caller pre-serialises each metadata
 *                            object via `JSON.stringify`. PostgreSQL
 *                            parses the textual array elements as
 *                            JSONB on the way in.
 *
 * The arrays MUST be the same length; the caller (in the factory
 * below) zips them together from `params.cartItems`, so the
 * lengths are guaranteed to match by construction.
 *
 * The RETURNING clause hands back the inserted rows so the caller
 * can map them into the {@link Order.items} array of the response —
 * no second SELECT needed.
 */
const INSERT_ORDER_ITEMS_SQL = `
  INSERT INTO order_items (order_id, design_id, quantity, metadata)
  SELECT $1::uuid, design_id, quantity, metadata
  FROM UNNEST($2::uuid[], $3::int[], $4::jsonb[]) AS t(design_id, quantity, metadata)
  RETURNING order_id, design_id, quantity, metadata
`;

/**
 * SELECT a single `orders` row by `(user_id, id)`.
 *
 * Backed by the PRIMARY KEY index on `orders.id`; the `user_id`
 * predicate is enforced by the database, NOT by application
 * middleware:
 *   - A bug elsewhere (e.g. a session middleware that attaches the
 *     wrong uid) cannot leak another user's order through this path.
 *   - The order simply does not exist from the caller's perspective
 *     — no 403/404 distinction, no probing surface for the existence
 *     of other users' orders.
 *
 * Returns at most one row (the PK guarantees uniqueness), so the
 * repository's `rows[0]` access is safe.
 */
const FIND_ORDER_BY_ID_SQL = `
  SELECT id, user_id, state, subtotal, created_at, last_modified_at
  FROM orders
  WHERE user_id = $1 AND id = $2
`;

/**
 * SELECT all `order_items` belonging to a given `order_id`, ordered
 * by `design_id` for a deterministic shape.
 *
 * Ordering by `design_id` (the natural foreign-key column) makes the
 * test fixtures stable: two runs with the same data produce the
 * same response shape regardless of physical row order. Backed by
 * the index on `order_items(order_id)` per ST-035-AC3.
 *
 * No `user_id` predicate is needed because the caller has already
 * verified ownership by selecting the `orders` row first; if the
 * caller had no right to the order they would not have its `id`.
 */
const FIND_ORDER_ITEMS_BY_ORDER_SQL = `
  SELECT order_id, design_id, quantity, metadata
  FROM order_items
  WHERE order_id = $1
  ORDER BY design_id
`;

/**
 * Conditional UPDATE of `orders.state`, idempotent under the
 * `state = expectedState` predicate (ST-034-AC3).
 *
 * The full WHERE clause:
 *   - `user_id = $1`        — pin ownership in SQL.
 *   - `id = $2`             — pin to the specific order.
 *   - `state = $4`          — the IDEMPOTENCY GUARD; a row already in
 *                             `newState` will not match.
 *
 * `last_modified_at = now()` is the SECOND mutation in the SET
 * clause. Server-side `now()` (rather than an application-supplied
 * timestamp) is used for the same clock-skew reason documented in
 * `design.repository.ts`: multi-instance API deployments do not
 * have synchronised wall clocks; PostgreSQL is the single source of
 * truth for "when did this row last change".
 *
 * The RETURNING clause hands back the canonical row so the caller
 * can echo the new state to the client without a follow-up SELECT.
 * When the WHERE matches zero rows the RETURNING list is empty —
 * the repository surfaces that as `null`.
 */
const UPDATE_ORDER_STATE_SQL = `
  UPDATE orders
  SET state = $3, last_modified_at = now()
  WHERE user_id = $1
    AND id = $2
    AND state = $4
  RETURNING id, user_id, state, subtotal, created_at, last_modified_at
`;

/**
 * SELECT the cart's line items via JOIN over the user's `state='cart'`
 * order.
 *
 * The JOIN is the cheapest way to express "items belonging to the
 * user's cart": pg's planner sees the `(user_id, state)` index on
 * `orders` (per ST-035-AC3), filters orders to the single
 * `state='cart'` row for this user, and uses the `(order_id)` index
 * on `order_items` to locate the matching items. Total cost: two
 * index probes plus N row reads.
 *
 * Ordering by `design_id` matches the convention used in
 * {@link FIND_ORDER_ITEMS_BY_ORDER_SQL}, so cart-vs-order responses
 * have the same item ordering for a given (user, design-set).
 *
 * If the user has no `state='cart'` row, the join produces zero rows
 * and the repository emits `items: []`. This is exactly the empty-
 * cart contract from ST-033-AC3.
 */
const FIND_CART_ITEMS_FOR_USER_SQL = `
  SELECT oi.design_id, oi.quantity, oi.metadata
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.user_id = $1
    AND o.state = 'cart'
  ORDER BY oi.design_id
`;

/**
 * SELECT the cart's subtotal — the `orders.subtotal` value of the
 * user's `state='cart'` row, or `'0.00'` if no cart exists.
 *
 * The `LIMIT 1` is defensive: the service layer enforces the
 * "at most one cart row per user" invariant, but a corrupted database
 * state (or a future schema change that relaxes the invariant) should
 * not cause this query to return multiple values. We pick the first
 * row deterministically; integration tests can verify the invariant
 * separately.
 *
 * `COALESCE(..., '0.00')` is NOT in this SQL because the absence of
 * a row is signalled at the JS layer (an empty `rows` array) rather
 * than via a NULL. The factory below substitutes `'0.00'` when
 * `rows[0]` is undefined, which keeps the SQL simple and the
 * fallback explicit at the call site.
 */
const FIND_CART_SUBTOTAL_FOR_USER_SQL = `
  SELECT subtotal
  FROM orders
  WHERE user_id = $1
    AND state = 'cart'
  LIMIT 1
`;

// ---------------------------------------------------------------------------
// Section 5: Constants — shared across the factory.
// ---------------------------------------------------------------------------

/**
 * The string representation of the empty subtotal (`0.00` formatted
 * as a NUMERIC(12,2) string).
 *
 * Centralised so the empty-cart fallback in `findCartForUser` and any
 * future zero-init paths agree on the exact string. PostgreSQL's
 * `to_char(0, 'FM999999999.00')` produces `0.00`; the JS-side
 * `(0).toFixed(2)` produces the same value. We pin the literal to
 * avoid any `Number → string` formatting drift.
 */
const EMPTY_SUBTOTAL = '0.00';

// ---------------------------------------------------------------------------
// Section 6: Factory — wires the SQL constants to a Pool and returns the
// public {@link OrderRepository} interface.
// ---------------------------------------------------------------------------

/**
 * Create an {@link OrderRepository} backed by the supplied pg
 * {@link Pool}.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createOrderRepository(pool)`) — easier to mock in unit tests
 *     than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *
 * The returned record is `Object.freeze`-d so calling code cannot
 * substitute one of the methods at runtime — that prevents a class of
 * bugs where a test or middleware accidentally mutates the shared
 * repository instance.
 *
 * The methods are defined on the literal directly so `repo.createOrder
 * FromCart` and `const { createOrderFromCart } = repo;
 * createOrderFromCart(...)` behave identically — no `this`-binding
 * confusion.
 *
 * @param pool A connected `pg.Pool` instance (typically from
 *   `backend/src/db/pool.ts`). The repository never closes the pool —
 *   pool lifecycle is the caller's responsibility.
 * @returns A frozen {@link OrderRepository} ready for use.
 */
export function createOrderRepository(pool: Pool): OrderRepository {
  const repository: OrderRepository = {
    /**
     * Atomic create. The ONLY method in this repository that uses a
     * transaction; see the file-level docblock for the rationale.
     */
    async createOrderFromCart(params: CreateOrderFromCartParams): Promise<Order> {
      // Acquire a dedicated client for the transaction. Using the pool
      // directly (`pool.query`) for each statement would borrow a
      // different connection per statement — incompatible with
      // BEGIN/COMMIT semantics, which require all statements in the
      // transaction to run on the SAME connection.
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Step 1: insert the parent `orders` row. The RETURNING
        // clause hands back `id` so we can populate
        // `order_items.order_id` in step 2 without a follow-up
        // SELECT.
        const orderResult = await client.query<OrderRow>({
          text: INSERT_ORDER_SQL,
          values: [params.userId, params.subtotal],
        });

        // Defensive: the RETURNING clause guarantees a row when the
        // INSERT succeeds, but if a future schema change were to
        // alter that contract we want a loud, descriptive failure
        // instead of a silent `undefined` propagating into business
        // logic.
        const orderRow = orderResult.rows[0];
        if (!orderRow) {
          throw new Error(
            'orders INSERT did not return a row; this should be impossible ' +
              'when the INSERT statement contains RETURNING. Investigate ' +
              'recent schema or migration changes.',
          );
        }

        // Step 2: bulk-insert the `order_items` rows via UNNEST.
        // Build three parallel arrays — the pg driver passes them
        // through to PostgreSQL as native ARRAY values, where UNNEST
        // expands them into rows.
        //
        // Each metadata object is pre-serialised to a JSON string;
        // the SQL casts the array element-wise to `jsonb[]`, which
        // parses each string element as JSONB on the way in. This
        // pattern avoids pg's auto-serialisation logic (which is
        // driver-version-sensitive) and produces a deterministic
        // wire format.
        let items: OrderItem[] = [];
        if (params.cartItems.length > 0) {
          const designIds = params.cartItems.map((i) => i.designId);
          const quantities = params.cartItems.map((i) => i.quantity);
          // `i.metadata ?? {}` is defensive against a `// @ts-ignore`
          // bypass that smuggles `null`/`undefined` through the
          // typed boundary; the documented shape says
          // `metadata: Record<string, unknown>`.
          const metadatas = params.cartItems.map((i) => JSON.stringify(i.metadata ?? {}));

          const itemsResult = await client.query<OrderItemRow>({
            text: INSERT_ORDER_ITEMS_SQL,
            values: [orderRow.id, designIds, quantities, metadatas],
          });
          items = itemsResult.rows.map(mapOrderItemRow);
        }

        await client.query('COMMIT');
        return mapOrderRow(orderRow, items);
      } catch (err) {
        // ROLLBACK on any error. We swallow errors from ROLLBACK
        // itself: a failed ROLLBACK typically means the connection
        // is already broken (e.g. network drop mid-transaction), in
        // which case `client.release()` below will discard the
        // connection from the pool, and the original error is what
        // the caller actually needs.
        try {
          await client.query('ROLLBACK');
        } catch {
          // Intentionally swallowed — see comment above.
        }
        throw err;
      } finally {
        // ALWAYS release the client back to the pool. Skipping this
        // in any code path leaks a pg connection; under sustained
        // load that exhausts the pool and the service hangs.
        client.release();
      }
    },

    /**
     * Single-order fetch with line items. Uses TWO queries (order
     * row + items rows) rather than a JOIN so the row mapper stays
     * simple. Round-trip cost is negligible because pg's pool
     * keeps connections warm.
     */
    async findOrderById(params: FindOrderByIdParams): Promise<Order | null> {
      // Query 1: the order row itself, ownership-pinned.
      const orderResult = await pool.query<OrderRow>({
        text: FIND_ORDER_BY_ID_SQL,
        values: [params.userId, params.orderId],
      });
      const orderRow = orderResult.rows[0];
      if (!orderRow) {
        // No row means the order does not exist OR the caller does
        // not own it; the two cases are intentionally
        // indistinguishable (defense-in-depth — callers cannot
        // probe for the existence of other users' orders).
        return null;
      }

      // Query 2: the joined items. We use `orderRow.id` (rather
      // than `params.orderId`) because the source of truth is the
      // database, even though by construction the two values are
      // equal at this point.
      const itemsResult = await pool.query<OrderItemRow>({
        text: FIND_ORDER_ITEMS_BY_ORDER_SQL,
        values: [orderRow.id],
      });
      const items = itemsResult.rows.map(mapOrderItemRow);

      return mapOrderRow(orderRow, items);
    },

    /**
     * Conditional state transition; idempotent under the
     * `state = expectedState` predicate (ST-034-AC3). Returns the
     * updated order row with `items: []` — this method does NOT
     * re-fetch line items, by design.
     */
    async updateOrderState(params: UpdateOrderStateParams): Promise<Order | null> {
      const result = await pool.query<OrderRow>({
        text: UPDATE_ORDER_STATE_SQL,
        values: [params.userId, params.orderId, params.newState, params.expectedState],
      });

      // When the WHERE matches zero rows (order does not exist,
      // is not owned by the user, or is no longer in
      // `expectedState`), the UPDATE affects zero rows, RETURNING
      // is empty, and we surface `null`. Service-layer consumers
      // can interpret the three causes as they need; the
      // repository keeps them indistinguishable for defense-in-
      // depth.
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      // We pass `[]` for items because:
      //   - The UPDATE only touched `orders`; we have no item rows
      //     to map.
      //   - Adding a follow-up SELECT for items would double the
      //     wire cost of finalize for callers who don't need the
      //     items echoed back. Callers who DO need them should
      //     follow finalize with a `findOrderById` call.
      return mapOrderRow(row, []);
    },

    /**
     * Cart projection. Always returns a `Cart` (never `null`).
     * Uses `Promise.all` to fan the items query and the subtotal
     * query out concurrently — they share no inputs other than
     * `userId` and write to no shared state, so parallel execution
     * is safe and cuts the round-trip cost roughly in half.
     */
    async findCartForUser(userId: string): Promise<Cart> {
      const [itemsResult, subtotalResult] = await Promise.all([
        pool.query<CartItemRow>({
          text: FIND_CART_ITEMS_FOR_USER_SQL,
          values: [userId],
        }),
        pool.query<{ subtotal: string }>({
          text: FIND_CART_SUBTOTAL_FOR_USER_SQL,
          values: [userId],
        }),
      ]);

      const items = itemsResult.rows.map(mapCartItemRow);

      // Empty cart → no `state='cart'` row → `subtotalResult.rows`
      // is empty → fall back to '0.00'. This matches ST-033-AC3:
      // an empty cart is a successful response, not a 404.
      const subtotal = subtotalResult.rows[0]?.subtotal ?? EMPTY_SUBTOTAL;

      return {
        userId,
        items,
        subtotal,
      };
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a repository method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(repository);
}
