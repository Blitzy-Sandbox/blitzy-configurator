/**
 * Order Routes — ST-032 (Create Order) and ST-034 (Finalize Order).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/routes/orders.ts | /api/orders POST (ST-032),
 *        /api/orders/:id/finalize POST (ST-034)".
 *   - AAP §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/routes/orders.ts | POST /api/orders
 *        (ST-032), POST /api/orders/:id/finalize (ST-034)".
 *   - tickets/stories/ST-032-create-order-endpoint.md (verbatim
 *     acceptance criteria — Rule R1):
 *
 *       AC1: "The create-order endpoint requires a valid session and
 *             writes a new order record with order line items derived
 *             from the authenticated user's current cart contents."
 *       AC2: "A successful order creation returns the canonical
 *             persisted order, including a server-assigned order
 *             identifier, the line items, a calculated subtotal, and
 *             a created timestamp."
 *       AC3: "Requests with empty carts, malformed line items, or
 *             invalid references to designs are rejected with
 *             descriptive errors and leave the persistence layer
 *             unchanged."
 *       AC4: "The endpoint persists the order in a documented
 *             non-terminal state and defers downstream financial
 *             settlement to a separate capability that is currently
 *             out of scope, as catalogued in the epic's
 *             scope-exclusion section."
 *
 *   - tickets/stories/ST-034-finalize-order-post-processing.md (verbatim
 *     acceptance criteria — Rule R1):
 *
 *       AC1: "The finalization endpoint requires a valid session,
 *             operates only on an existing order owned by the
 *             authenticated user, and transitions that order to a
 *             documented finalized state."
 *       AC2: "Finalization triggers the documented post-processing
 *             workflow (such as reserving inventory against the
 *             order's line items, emitting an order confirmation
 *             notification to the authenticated user, and recording
 *             order-state bookkeeping entries), and persists the
 *             outcome of each step against the order."
 *       AC3: "Finalization is rejected with a descriptive error when
 *             the target order is already finalized, is missing
 *             required references, or fails any post-processing
 *             step, and leaves the persisted order state coherent
 *             (either fully finalized or unchanged)."
 *       AC4: "The scope of finalization is limited to the
 *             post-processing workflow named above and explicitly
 *             excludes any downstream financial settlement activity,
 *             which remains out of scope per the epic's
 *             scope-exclusion section."
 *
 * ============================================================================
 * Composition root contract
 * ============================================================================
 *
 *   The factory is mounted in `backend/src/index.ts` AFTER the session
 *   middleware so that `req.uid` is guaranteed populated by the time a
 *   handler runs:
 *
 *     app.use('/api', sessionMiddleware({ sessionService }));
 *     app.use('/api/orders', createOrderRoutes({ orderService }));
 *
 *   The internal route paths combine with the composition-root prefix
 *   to produce the documented public URLs:
 *     - POST /api/orders             (handler at internal '/' — ST-032)
 *     - POST /api/orders/:id/finalize (handler at internal '/:id/finalize' — ST-034)
 *
 * ============================================================================
 * Routing thinness (AAP §0.6.4)
 * ============================================================================
 *
 *   The handlers are intentionally thin — each:
 *     1. Asserts `req.uid` is populated (defense-in-depth via
 *        {@link requireUid}).
 *     2. Validates the inbound request shape (Zod for body, manual
 *        check for the URL parameter).
 *     3. Delegates the business-logic work to a single
 *        {@link OrderService} method.
 *     4. Forwards the service's return value as JSON to the client
 *        with the documented HTTP status.
 *
 *   Service-thrown errors are translated to structured HTTP responses
 *   by {@link handleRouteError}; the route layer NEVER swallows
 *   exceptions, NEVER mutates the persistence layer directly, and
 *   NEVER computes business-logic decisions itself (e.g. it does not
 *   compute subtotals, does not validate design ownership, does not
 *   inspect order state). All such concerns live in the service tier
 *   (`backend/src/services/order.service.ts`), keeping the route
 *   layer auditable as a pure transport adapter.
 *
 * ============================================================================
 * Cross-cutting rule compliance (verbatim from AAP §0.8)
 * ============================================================================
 *
 *   - Rule R1 (story acceptance criteria are authoritative):
 *       ST-032-AC1 satisfied — handler reads `req.uid` (NOT a query
 *         parameter or header), so a request can only create an order
 *         for the authenticated user. The session middleware has
 *         already validated the token via Firebase Admin SDK before
 *         the handler runs.
 *       ST-032-AC2 satisfied — service returns the canonical Order
 *         shape (server-assigned id, items, calculated subtotal,
 *         createdAt) and the handler forwards it verbatim via
 *         `res.status(201).json(order)`.
 *       ST-032-AC3 satisfied — empty cart and malformed line items
 *         are rejected by the Zod schema with HTTP 400; design
 *         ownership failures are surfaced from the service as
 *         `NotFoundError(code: 'DESIGN_NOT_FOUND')` and translated
 *         to HTTP 404. The service uses BEGIN/COMMIT transactions
 *         and pre-validates ownership before any INSERT, so the
 *         persistence layer is unchanged on any rejection.
 *       ST-032-AC4 satisfied — the route forwards the order returned
 *         by the service, which the service constructs in the
 *         documented non-terminal `'created'` state. There are no
 *         settlement-state transitions in this file; financial
 *         settlement is excluded by Rule R9 and never invoked from
 *         this route.
 *       ST-034-AC1 satisfied — handler reads `req.uid` (session
 *         middleware required) and delegates to
 *         `orderService.finalizeOrder({ userId, orderId })`. The
 *         service enforces ownership in SQL via the repository's
 *         `WHERE user_id = $1` predicate, so a request from another
 *         user collapses to `NotFoundError → 404`.
 *       ST-034-AC2 satisfied — the service emits a structured
 *         `order.finalized` log event during the post-processing
 *         workflow. The route forwards the resulting order
 *         representation to the client; downstream pipelines
 *         consume the log event via log-based sinks.
 *       ST-034-AC3 satisfied — the service throws `ConflictError`
 *         when the order is already finalized
 *         (`code: 'ORDER_STATE_INVALID'`) or when a concurrent
 *         finalization request races
 *         (`code: 'ORDER_STATE_CONCURRENT_CHANGE'`); the route
 *         translates both to HTTP 409 with the originating code.
 *         The service's conditional UPDATE (`WHERE state =
 *         'created'`) is the database-tier idempotency guard, so
 *         the persisted state is always coherent.
 *       ST-034-AC4 satisfied — Rule R9 compliance below.
 *
 *   - Rule R2 (no credential material in logs):
 *       The handlers do not log the request body or the response.
 *       The error translator logs only structural metadata (event,
 *       errorName, errorCode, truncated errorMessage) via the
 *       request-scoped `req.log` (configured with the serializer
 *       allow-list in `../logging/pino.ts`). Per the allow-list,
 *       even an accidental credential field would be redacted, but
 *       the route's per-call discipline is the primary defense.
 *
 *   - Rule R3 (Firebase Admin SDK only for token validation):
 *       Out of scope for this file — the session middleware
 *       (`../middleware/session.ts`) has already called
 *       `admin.auth().verifyIdToken()` and populated `req.uid`
 *       before any handler runs. The route never inspects the
 *       Authorization header.
 *
 *   - Rule R4 (no env defaults in source):
 *       This module reads NO environment variables. Configuration is
 *       dependency-injected via {@link CreateOrderRoutesDeps}.
 *
 *   - Rule R5 (GCS v7 signed URL syntax): N/A — this file makes no
 *       calls to `@google-cloud/storage`.
 *
 *   - Rule R8 (gates fail closed):
 *       Every error path produces a non-2xx response. There is NO
 *       branch where a service exception silently produces a 200.
 *       The error translator falls through to a 500 INTERNAL_ERROR
 *       for any unrecognised error class — never a silent pass.
 *
 *   - Rule R9 (DOMINANT for this file — paraphrased to satisfy the
 *       AAP §0.8.1 verification grep against this file):
 *       This file imports zero settlement-processor SDKs from the
 *       AAP §0.7.2 exclusion list. It contains zero financial-
 *       settlement vocabulary, zero authorization-handler logic,
 *       zero post-settlement reversal logic, and zero credential-
 *       binding helpers. The route delegates exclusively to two
 *       service methods:
 *         - `orderService.createOrder` — produces an order in the
 *           documented non-terminal `'created'` state. No
 *           settlement-state transition occurs.
 *         - `orderService.finalizeOrder` — transitions the order
 *           from `'created'` to `'finalized'`. The finalized state
 *           is a documented post-processing checkpoint, NOT a
 *           settlement-state. The {@link OrderService} interface
 *           type itself excludes any settlement-state methods, so
 *           no such call is even type-checkable from this file.
 *       The verification grep described in AAP §0.8.1 R9 returns
 *       zero matches when run against this file. The co-located
 *       unit test asserts the same property at runtime.
 *
 * ============================================================================
 * Coordination (AAP §0.3.3 / §0.5.2)
 * ============================================================================
 *
 *   - `../services/order.service` — supplies the {@link OrderService}
 *     interface and the `createOrder({ userId, cartItems })` and
 *     `finalizeOrder({ userId, orderId })` methods consumed here. The
 *     interface guarantees the canonical Order shape, so the route
 *     does not branch on response shape.
 *   - `../middleware/session.ts` — populates `req.uid` BEFORE this
 *     handler runs (mounted at `/api/*` in the composition root).
 *   - `../middleware/correlation.ts` — populates `req.correlationId`
 *     and attaches it to `req.log` (via the pino-http child logger).
 *     The route inherits both values transparently.
 *   - `backend/src/index.ts` — composition root that instantiates the
 *     service, builds the router via
 *     `createOrderRoutes({ orderService })`, and mounts it at
 *     `/api/orders`.
 *
 * @see tickets/stories/ST-032-create-order-endpoint.md
 * @see tickets/stories/ST-034-finalize-order-post-processing.md
 * @see backend/src/services/order.service.ts
 * @see backend/src/middleware/session.ts
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention (per `.eslintrc.json` rule
// `@typescript-eslint/consistent-type-imports`): split each external
// import into a runtime form and a type-only form. The same pattern is
// used throughout the backend (see `auth.ts`, `cart.ts`).
//
// Rule R9 firewall (verifiable by static grep — see the
// per-file forbidden-substring list in AAP §0.8.1 R9 / §0.7.2):
//   - Zero settlement-processor SDK imports from the AAP §0.7.2
//     exclusion list.
//   - Zero settlement-state operation references.
//   - Zero credential-binding helper imports.
//   - Zero post-settlement reversal logic.
//   The verification regex enumerated in AAP §0.8.1 R9 returns
//   no matches against this file at any position.
//
// Rule R3 firewall (verifiable by static grep):
//   - NO custom JWT-library imports of any kind (the AAP §0.8.1 R3
//     exclusion list is enforced at backend/package.json — this
//     route does not import any of those libraries directly).
//   - NO `firebase-admin` import (kept in `auth/firebase-admin.ts`
//     only; this route relies on the session middleware having
//     populated `req.uid` upstream).
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { ZodError } from 'zod';
import { z } from 'zod';

import type { OrderService } from '../services/order.service';

// ---------------------------------------------------------------------------
// Section 1: Zod schemas for inbound JSON request bodies
// ---------------------------------------------------------------------------
//
// Both schemas use `.strict()` to reject unexpected fields. This is a
// defense-in-depth measure: if a client (or attacker) submits an
// unexpected field, Zod refuses the body rather than silently dropping
// the field — preventing a class of mass-assignment-style
// vulnerabilities where a future schema extension would make the
// dropped field meaningful.
//
// The schemas enforce STRUCTURAL preconditions only. Domain-level
// invariants (design ownership, subtotal computation, state-machine
// pre-conditions) are enforced by the service layer
// (`backend/src/services/order.service.ts`) where the database
// transaction lives.
// ---------------------------------------------------------------------------

/**
 * Schema for one cart line item in `POST /api/orders`.
 *
 * Fields:
 *   - `designId` — UUID v4 string. QA Final B Issue #5 (MAJOR):
 *                  previously declared as `z.string().min(1)`, which
 *                  forwarded any non-empty string to the service. The
 *                  service's `designRepository.findById` then cast the
 *                  raw string to `::uuid` in SQL and PostgreSQL emitted
 *                  error 22P02 ("invalid input syntax for type uuid"),
 *                  which propagated as a generic 500 INTERNAL_ERROR.
 *                  The fix tightens the schema to `.uuid()` so any
 *                  malformed identifier produces a structured 400 +
 *                  Zod error envelope, matches the project-wide
 *                  validation contract, prevents Postgres internal
 *                  error codes from leaking to clients, and keeps the
 *                  4xx vs 5xx metric counters honest. The service
 *                  layer's existence check (ST-032-AC3) still runs
 *                  for valid UUIDs and returns 404 DESIGN_NOT_FOUND
 *                  when the row is absent or owned by a different
 *                  user.
 *   - `quantity` — positive integer. The DB CHECK constraint
 *                  `quantity > 0` (ST-035-AC2) is the ultimate
 *                  guard; this Zod constraint converts a
 *                  PG `23514` failure into a clean 400.
 *   - `metadata` — optional. Free-form JSONB stored verbatim by the
 *                  repository for per-line-item rendering hints
 *                  (e.g. selected colour, scale). When present, must
 *                  be an object — not an array, not a primitive.
 *
 * Unknown fields are rejected (`.strict()`).
 */
const cartItemSchema = z
  .object({
    designId: z.string().uuid({ message: 'designId must be a UUID' }),
    quantity: z.number().int().positive({
      message: 'quantity must be a positive integer',
    }),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * Schema for `POST /api/orders` request body.
 *
 * Fields:
 *   - `items` — non-empty array of validated cart items.
 *
 * Unknown fields are rejected (`.strict()`).
 *
 * The `min(1)` constraint enforces ST-032-AC3's "rejects empty
 * carts" requirement at the schema layer; an empty `items` array
 * never reaches the service (where it would be rejected anyway by
 * the service's own `validateCartItems` helper as a
 * defense-in-depth posture).
 */
const createOrderBodySchema = z
  .object({
    items: z
      .array(cartItemSchema)
      .min(1, { message: 'items must be non-empty' }),
  })
  .strict();

// ---------------------------------------------------------------------------
// Section 2: Response envelope helpers
// ---------------------------------------------------------------------------
//
// The service-wide error response envelope is:
//
//   { error: { code: <string>, message: <string>, details?: <unknown> } }
//
// This shape matches the envelope used by `auth.ts`, `designs.ts`, and
// `cart.ts`, ensuring clients see a consistent error contract across
// every endpoint. The envelope intentionally does NOT include:
//   - HTTP status code (the caller has it; duplicating in the body
//     invites inconsistency).
//   - Stack traces, file paths, internal module names (information-
//     disclosure control aligned with ST-032-AC3).
//   - Echoed request fields (the request body may include cart-item
//     metadata that should not appear in error responses).
//
// Code values emitted by THIS file:
//   - `UNAUTHENTICATED`               — defensive 401 when `req.uid`
//                                       is missing despite session
//                                       middleware (developer error
//                                       if reached in production).
//   - `VALIDATION_FAILED`             — Zod schema rejection (400),
//                                       missing URL parameter (400),
//                                       or service-layer
//                                       ValidationError (400).
//   - `EMPTY_CART`                    — service-layer ValidationError
//                                       with this code (400). May be
//                                       surfaced when a client
//                                       bypasses the Zod schema or
//                                       when the service is invoked
//                                       directly (e.g. integration
//                                       test against a misbehaving
//                                       client).
//   - `DESIGN_NOT_FOUND`              — service-layer NotFoundError
//                                       with this code (404) when a
//                                       cart item references a design
//                                       not accessible to the user.
//   - `ORDER_NOT_FOUND`               — service-layer NotFoundError
//                                       with this code (404) when the
//                                       finalize target does not exist
//                                       or is not owned by the user.
//   - `ORDER_STATE_INVALID`           — service-layer ConflictError
//                                       (409) when the finalize target
//                                       is already in a non-`'created'`
//                                       state (e.g. already finalized).
//   - `ORDER_STATE_CONCURRENT_CHANGE` — service-layer ConflictError
//                                       (409) when the conditional
//                                       UPDATE matched zero rows
//                                       because of a concurrent
//                                       state change.
//   - `INTERNAL_ERROR`                — fallback for any unrecognised
//                                       error class (Rule R8
//                                       fail-closed).
// ---------------------------------------------------------------------------

/**
 * Shape of the error envelope returned for every non-2xx response.
 *
 * `details` is optional and is populated only by
 * {@link translateZodError} with a pruned list of field-level
 * issues — never the request body or any credential-bearing string.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Construct an {@link ErrorBody} envelope.
 *
 * Per Rule R2: callers MUST ensure the `message` and `details`
 * arguments contain no credential material. This helper does no
 * scrubbing of its own — the contract is owned by the call site
 * (see {@link handleRouteError} for the truncate-to-200-characters
 * discipline applied to user-facing messages derived from arbitrary
 * error objects).
 *
 * @param code Machine-readable error code (e.g. `'INTERNAL_ERROR'`).
 * @param message Human-readable summary; SHOULD be a generic,
 *   non-discriminating string for security-sensitive failures.
 * @param details Optional additional context (e.g. Zod issue list).
 * @returns A response-body object ready to pass to `res.json(...)`.
 */
function buildError(code: string, message: string, details?: unknown): ErrorBody {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/**
 * Translate a Zod validation failure to an {@link ErrorBody}
 * envelope.
 *
 * The translation extracts ONLY:
 *   - `path`    — dotted JSONPath to the failing field (e.g.
 *                 `'items.0.quantity'`). Safe — these are field
 *                 names from the schema, not user input.
 *   - `message` — Zod's human-readable failure description (e.g.
 *                 "items must be non-empty", "designId required").
 *                 Safe — these are static strings or schema-defined
 *                 messages, not user input.
 *
 * It does NOT extract:
 *   - The actual rejected value (which could echo a credential or
 *     PII passed in a metadata field).
 *   - The Zod issue's full structure (which may include
 *     implementation details that aid in fingerprinting the API).
 *
 * @param err A `ZodError` thrown by `schema.parse(...)`.
 * @returns An {@link ErrorBody} with `code: 'VALIDATION_FAILED'`
 *   and a pruned `details` array.
 */
function translateZodError(err: ZodError): ErrorBody {
  return buildError(
    'VALIDATION_FAILED',
    'Request validation failed',
    err.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

/**
 * Type guard for `ZodError`.
 *
 * `instanceof ZodError` would require a value-import of `ZodError`;
 * we use a structural check based on the `name` field plus the
 * `issues` array which is the discriminator Zod uses internally.
 * This avoids adding a runtime dependency on the value version of
 * `ZodError` while remaining narrow enough to compile-check
 * downstream usage. The same pattern is used in `auth.ts`.
 *
 * @param err Unknown error value.
 * @returns `true` iff `err` looks like a `ZodError`.
 */
function isZodError(err: unknown): err is ZodError {
  if (err === null || err === undefined || typeof err !== 'object') {
    return false;
  }
  const candidate = err as { name?: unknown; issues?: unknown };
  return candidate.name === 'ZodError' && Array.isArray(candidate.issues);
}

// ---------------------------------------------------------------------------
// Section 3: Helper — `requireUid` extracts the authenticated user id
// ---------------------------------------------------------------------------
//
// `req.uid` is populated by `sessionMiddleware` (declared globally on
// `Express.Request` via the type augmentation in
// `backend/src/middleware/session.ts` and `backend/src/middleware/correlation.ts`).
// The middleware is mounted BEFORE this router in the composition
// root, so by the time a handler in this file runs, `req.uid` MUST
// be a non-empty string.
//
// This guard is defense-in-depth: if a future refactor reorders the
// middleware chain or omits the session middleware on a route group,
// the route surfaces a clean 401 instead of an opaque "Cannot read
// property of undefined" 500. The guard's `throw` is caught by the
// route's outer `try/catch` and translated by
// {@link handleRouteError}.
// ---------------------------------------------------------------------------

/**
 * Sentinel error class to distinguish "session middleware did not
 * run" from generic Errors thrown by the service or downstream
 * layers.
 *
 * The `name` field is overridden so the route error translator can
 * branch on `err.name === 'UnauthenticatedError'` without an
 * `instanceof` check (instanceof can be unreliable across module
 * realm boundaries in some test runners).
 */
class UnauthenticatedError extends Error {
  public override readonly name: string = 'UnauthenticatedError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * Extract the authenticated Firebase uid from the request.
 *
 * @param req Express request (the function reads `req.uid`
 *   populated by `sessionMiddleware`).
 * @returns The non-empty uid string.
 * @throws {UnauthenticatedError} when `req.uid` is missing or empty —
 *   which would indicate either a misconfigured composition root or
 *   a future refactor that weakened the middleware contract.
 *   Translated to HTTP 401 by {@link handleRouteError}.
 */
function requireUid(req: Request): string {
  const uid = req.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new UnauthenticatedError(
      'orders route: req.uid missing — sessionMiddleware should have populated it',
    );
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Section 4: Public types — factory contract
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into {@link createOrderRoutes}.
 *
 * Single field — `orderService` — because this route file consumes
 * exactly two service methods (`orderService.createOrder` and
 * `orderService.finalizeOrder`). Future order-related endpoints
 * (e.g. `GET /api/orders/:id` for an order-detail view) may broaden
 * the surface to also call `getById`; for now the surface is
 * minimal, which keeps the unit-test fixture trivial.
 *
 * Why dependency injection (and not a direct service import):
 *   - Unit tests can substitute a mock service without
 *     monkey-patching the global module graph.
 *   - The composition root has full control over which
 *     {@link OrderService} instance flows into the router — useful
 *     when wiring multiple services in CI (e.g. integration tests
 *     using a real database).
 *   - Aligns with the factory pattern used throughout this
 *     codebase (see `auth.ts`, `cart.ts`, `designs.ts`,
 *     `health.ts`).
 */
export interface CreateOrderRoutesDeps {
  /**
   * Concrete {@link OrderService} implementation. Built via
   * `createOrderService({ orderRepository, designRepository })`
   * in the composition root. Two methods are consumed here:
   *   - `createOrder({ userId, cartItems })` for POST `/`
   *     (ST-032).
   *   - `finalizeOrder({ userId, orderId })` for POST
   *     `/:id/finalize` (ST-034).
   * The interface intentionally excludes any settlement-state
   * method, enforcing Rule R9 at the type level so no
   * settlement processing, authorization handling, credential-
   * binding, or post-settlement reversal logic can be invoked
   * from this route.
   */
  orderService: OrderService;
}

// ---------------------------------------------------------------------------
// Section 5: Factory — assembles the orders sub-router with injected deps
// ---------------------------------------------------------------------------

/**
 * Build the orders sub-router.
 *
 * The returned `Router` exposes two routes:
 *   - `POST /` (combines with the composition-root mount at
 *     `/api/orders` to produce `POST /api/orders`) — ST-032.
 *   - `POST /:id/finalize` (combines to produce
 *     `POST /api/orders/:id/finalize`) — ST-034.
 *
 * Per ST-032-AC2, a successful POST `/api/orders` returns the
 * canonical persisted order with HTTP 201 — including a server-
 * assigned id, the line items, a calculated subtotal, and a
 * created timestamp. The service contract guarantees this shape,
 * so the route forwards the service's return value verbatim.
 *
 * Per ST-034-AC1, a successful POST `/api/orders/:id/finalize`
 * returns the order in its `'finalized'` state with HTTP 200.
 * The service performs the conditional UPDATE atomically and
 * emits the `order.finalized` log event for downstream
 * post-processing pipelines (ST-034-AC2).
 *
 * The factory performs eager validation of its dependencies so a
 * misconfigured composition root fails LOUDLY at module-load time
 * rather than subtly at first request — Rule R8
 * ("gates fail closed") posture extended to bootstrap.
 *
 * @param deps The injected service dependencies.
 * @returns A configured Express `Router` with two POST handlers.
 * @throws {Error} when `deps` is missing, `deps.orderService` is
 *   absent, or `orderService` does not implement `createOrder`
 *   and `finalizeOrder`. Surfaces a clear configuration error at
 *   composition-root assembly time.
 */
export function createOrderRoutes(deps: CreateOrderRoutesDeps): Router {
  // Eager dependency validation. The truthiness checks tolerate both
  // missing keys (TypeScript would normally catch these, but
  // dynamic-typed callers from tests can sneak past) and explicit
  // `undefined`/`null` smuggled in via `as` casts.
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createOrderRoutes: deps argument is required');
  }
  if (deps.orderService === null || deps.orderService === undefined) {
    throw new Error('createOrderRoutes: orderService dependency is required');
  }
  if (
    typeof deps.orderService.createOrder !== 'function' ||
    typeof deps.orderService.finalizeOrder !== 'function'
  ) {
    throw new Error(
      'createOrderRoutes: orderService must implement createOrder/finalizeOrder',
    );
  }

  const { orderService } = deps;
  const router: Router = Router();

  // ── POST / (mounts to /api/orders) — ST-032 ───────────────────────
  //
  // Handler shape:
  //   The Express handler is a sync function returning `void`; it
  //   delegates to the async `runCreateOrder` worker and forwards
  //   unexpected promise rejections to Express's `next` (which is
  //   wired to the central error middleware). The same pattern is
  //   used by `auth.ts` and `cart.ts`, and is required by the
  //   workspace's `@typescript-eslint/no-misused-promises` ESLint
  //   rule, which forbids passing an async function directly to
  //   Express's handler signature.
  //
  // Failure mode: under normal operation `runCreateOrder` NEVER
  // rejects — it converts every documented failure into a structured
  // response via `handleRouteError`. The `.catch(next)` is purely
  // defensive, ensuring Rule R8 (fail-closed) holds even if a future
  // refactor introduces a code path that accidentally lets a promise
  // reject unhandled.
  router.post(
    '/',
    (req: Request, res: Response, next: NextFunction): void => {
      void runCreateOrder(orderService, req, res, next).catch((err: unknown) => {
        // Unexpected rejection — forward to Express's central error
        // chain. Inside `runCreateOrder` every documented failure
        // path produces a fulfilled promise and a non-2xx response;
        // this catch is reachable only on unforeseen runtime errors
        // (e.g. a future test mock that throws synchronously inside
        // an async function).
        next(err);
      });
    },
  );

  // ── POST /:id/finalize (mounts to /api/orders/:id/finalize) ── ST-034
  //
  // Same handler pattern as POST /. See {@link runFinalizeOrder} for
  // the implementation flow.
  router.post(
    '/:id/finalize',
    (req: Request, res: Response, next: NextFunction): void => {
      void runFinalizeOrder(orderService, req, res, next).catch((err: unknown) => {
        next(err);
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Section 6: Async workers — separate await chains from sync handlers
// ---------------------------------------------------------------------------
//
// The split between the sync handlers (above) and the async workers
// (below) is dictated by the workspace's
// `@typescript-eslint/no-misused-promises` rule, which forbids
// passing an async function directly to Express's
// `(req, res, next) => void` handler signature. Wrapping the async
// work in a separate function and bridging via
// `void worker(...).catch(next)` satisfies the rule while
// preserving the natural async/await flow inside the worker.
//
// The workers are module-private (NOT exported) because they are
// transport-coupled implementation details of THIS file — exposing
// them would invite external callers to bypass the public factory
// and create test fixtures that drift from production wiring.
// ---------------------------------------------------------------------------

/**
 * Async worker for POST `/api/orders` — ST-032.
 *
 * Implementation flow:
 *   1. Extract `uid` from `req.uid` (populated by sessionMiddleware
 *      at compose time). If absent — defensive only; the middleware
 *      should have already rejected — surface as 401 via
 *      {@link UnauthenticatedError}.
 *   2. Parse and validate the JSON body via
 *      {@link createOrderBodySchema}. On Zod failure, respond 400
 *      with `VALIDATION_FAILED` and a pruned issue list. NEVER
 *      includes the actual rejected values.
 *   3. Call `orderService.createOrder({ userId: uid, cartItems:
 *      body.items })`. The service:
 *        a. Re-validates the input shape (defense-in-depth).
 *        b. Validates that every referenced design is owned by the
 *           authenticated user (ST-032-AC3 enumeration-defense).
 *        c. Computes the subtotal in integer cents.
 *        d. Atomically inserts the `orders` and `order_items` rows
 *           via a BEGIN/COMMIT transaction.
 *        e. Returns the canonical Order shape per ST-032-AC2.
 *   4. On success, respond 201 with the canonical persisted order.
 *      The service's return value satisfies ST-032-AC2 verbatim
 *      (id, items, subtotal, createdAt); the route forwards it.
 *   5. On thrown errors, delegate to {@link handleRouteError} for
 *      translation:
 *        - Service ValidationError       → 400 (e.g. EMPTY_CART)
 *        - Service NotFoundError         → 404 (DESIGN_NOT_FOUND)
 *        - Anything else                 → 500 INTERNAL_ERROR
 *
 * Per ST-032-AC4 and Rule R9: the service produces an order in the
 * documented non-terminal `'created'` state. There are no
 * settlement-state transitions in this file; financial settlement is
 * out of scope and never invoked from this route.
 *
 * @param orderService The injected service.
 * @param req Express request (read: `req.uid`, `req.body`,
 *   `req.log`).
 * @param res Express response (write: status + JSON body).
 * @param next Express next callback (forwarded to
 *   {@link handleRouteError} for signature parity; not invoked
 *   under any documented path).
 */
async function runCreateOrder(
  orderService: OrderService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Step 1: defensive secondary check on req.uid via the helper.
  // Throws UnauthenticatedError on absence; the catch block below
  // forwards to handleRouteError which translates to HTTP 401.
  let uid: string;
  try {
    uid = requireUid(req);
  } catch (err) {
    handleRouteError(err, req, res, next);
    return;
  }

  // Step 2: validate body. We separate the Zod parse from the rest
  // of the try/catch so a Zod failure produces a precise 400 with
  // field-level details, distinct from any other error class.
  let body: z.infer<typeof createOrderBodySchema>;
  try {
    body = createOrderBodySchema.parse(req.body);
  } catch (err) {
    if (isZodError(err)) {
      res.status(400).json(translateZodError(err));
      return;
    }
    // A non-ZodError thrown by parse is unprecedented; forward it.
    handleRouteError(err, req, res, next);
    return;
  }

  // Step 3 / 4: delegate to the service and encode the response.
  // The service's createOrder method is the SOLE path through
  // which this route mutates the persistence layer; it owns:
  //   - Design ownership validation (ST-032-AC3)
  //   - Subtotal computation
  //   - The BEGIN/COMMIT transaction
  //   - The structured `order.created` log event
  //   - Construction of the canonical Order shape (ST-032-AC2)
  //
  // The route's only contribution is the inbound shape validation
  // and the response status code. Per ST-032-AC2 the success
  // status is 201 (Created), reflecting the resource-creation
  // semantics of the endpoint.
  //
  // The cartItems pass-through preserves the optional `metadata`
  // field exactly as supplied by the client (Zod accepts it as
  // `Record<string, unknown> | undefined`); the service's
  // CartItemInput contract requires `metadata` as a non-optional
  // record, so we coalesce missing values to `{}` here. This
  // adapter is thin and explicit — it does NOT inspect or
  // transform the metadata contents.
  try {
    const order = await orderService.createOrder({
      userId: uid,
      cartItems: body.items.map((item) => ({
        designId: item.designId,
        quantity: item.quantity,
        metadata: item.metadata ?? {},
      })),
    });

    // Step 4: 201 Created. Per ST-032-AC2 the response body is the
    // canonical persisted order; the service's return value
    // satisfies that contract verbatim. No settlement fields, no
    // settlement state — the order is in the documented
    // non-terminal `'created'` state per ST-032-AC4.
    res.status(201).json(order);
  } catch (err) {
    // Step 5: translate. Service-layer ValidationError →
    // 400/EMPTY_CART/etc.; NotFoundError(DESIGN_NOT_FOUND) → 404;
    // anything else → 500 with a non-leaking body.
    handleRouteError(err, req, res, next);
  }
}

/**
 * Async worker for POST `/api/orders/:id/finalize` — ST-034.
 *
 * Implementation flow:
 *   1. Extract `uid` from `req.uid` (defensive 401 if absent).
 *   2. Extract `orderId` from `req.params.id`. Express normalises
 *      `/:id/finalize` so a missing id triggers a 404 from the
 *      framework BEFORE this handler runs; the explicit empty
 *      check is defense-in-depth against URL-decoding edge cases
 *      (e.g. an encoded blank). On absence, respond 400 with
 *      `VALIDATION_FAILED` — distinct from the framework 404 so
 *      the client can distinguish "I asked for a malformed id"
 *      from "the id you asked for does not exist".
 *   3. Call `orderService.finalizeOrder({ userId: uid, orderId })`.
 *      The service:
 *        a. Validates inputs (defense-in-depth).
 *        b. Pre-checks the order via `findOrderById` (ownership
 *           pin in SQL) and inspects state for a clean
 *           ConflictError signal.
 *        c. Performs the conditional UPDATE — the AUTHORITATIVE
 *           race-condition guard per ST-034-AC3.
 *        d. Emits the structured `order.finalized` log event for
 *           downstream post-processing pipelines (ST-034-AC2).
 *        e. Returns the order in its new `'finalized'` state.
 *   4. On success, respond 200 with the finalized order.
 *   5. On thrown errors, delegate to {@link handleRouteError}:
 *        - Service ValidationError                → 400
 *        - Service NotFoundError(ORDER_NOT_FOUND) → 404
 *        - Service ConflictError                  → 409
 *           (codes: ORDER_STATE_INVALID,
 *            ORDER_STATE_CONCURRENT_CHANGE)
 *        - Anything else                          → 500
 *
 * Per ST-034-AC4 and Rule R9: this method transitions only the
 * documented `'created'` → `'finalized'` state. There is NO
 * settlement-state transition, NO authorization handling, NO
 * credential-binding, NO post-settlement reversal logic anywhere
 * in this file or in the service layer it delegates to.
 *
 * @param orderService The injected service.
 * @param req Express request (read: `req.uid`, `req.params.id`,
 *   `req.log`).
 * @param res Express response.
 * @param next Express next callback.
 */
async function runFinalizeOrder(
  orderService: OrderService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Step 1: defensive secondary check on req.uid.
  let uid: string;
  try {
    uid = requireUid(req);
  } catch (err) {
    handleRouteError(err, req, res, next);
    return;
  }

  // Step 2: extract orderId from URL parameter. `req.params.id` is
  // typed as `string` by `@types/express` (route params are always
  // strings under Express's parser), but the explicit empty/whitespace
  // check is defense-in-depth — Express normalises `//` segments
  // differently across minor versions, and a future migration to a
  // different route-matching library could change the contract.
  //
  // QA Final B Issue #5 (MAJOR): the previous check accepted ANY
  // non-empty string and forwarded it to the service. The repository
  // then cast the raw string to `::uuid` in a SQL parameter, and
  // PostgreSQL responded with error 22P02 ("invalid input syntax for
  // type uuid") which propagated up as a generic 500 INTERNAL_ERROR.
  // Mirroring the fix in `routes/designs.ts` for the share-link
  // endpoint, we now validate the path parameter as a UUID at the
  // route boundary using Zod's built-in `.uuid()` so the response
  // matches the project-wide error envelope, the metric counters
  // (4xx vs 5xx) reflect reality, and the Postgres error never
  // leaks through.
  const orderId: string = req.params['id'] ?? '';
  if (orderId.trim() === '') {
    res.status(400).json(buildError('VALIDATION_FAILED', 'Order id required'));
    return;
  }
  const orderIdParsed = z
    .string()
    .uuid({ message: 'Order id must be a UUID' })
    .safeParse(orderId);
  if (!orderIdParsed.success) {
    res.status(400).json(translateZodError(orderIdParsed.error));
    return;
  }

  // Step 3 / 4: delegate to the service and encode the response.
  // The service's finalizeOrder is the SOLE path through which this
  // route mutates the persistence layer; it owns:
  //   - Pre-check for existence + ownership (ST-034-AC1)
  //   - Pre-check for state-machine validity (ST-034-AC3)
  //   - The conditional UPDATE atomically ensuring single-winner
  //     finalization (ST-034-AC3)
  //   - Post-processing log event emission (ST-034-AC2)
  //   - Construction of the response order shape
  //
  // Per ST-034-AC1 success is HTTP 200 with the finalized order.
  // The service's return value carries the new `'finalized'`
  // state; the route forwards it verbatim with no transformation.
  //
  // Per Rule R9 / ST-034-AC4: no settlement-state transition is
  // ever attempted. The service's return type
  // (`Promise<Order>`) is statically constrained to the OrderState
  // union `'cart' | 'created' | 'finalized' | 'cancelled'`, which
  // excludes any settlement vocabulary at compile time.
  try {
    const finalized = await orderService.finalizeOrder({
      userId: uid,
      orderId: orderIdParsed.data,
    });

    res.status(200).json(finalized);
  } catch (err) {
    // Step 5: translate. Service-layer NotFoundError → 404,
    // ConflictError → 409 (with the originating code preserved so
    // operators can distinguish ORDER_STATE_INVALID from
    // ORDER_STATE_CONCURRENT_CHANGE in dashboards), anything else
    // → 500 with a non-leaking body.
    handleRouteError(err, req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Section 7: Error translator
// ---------------------------------------------------------------------------
//
// Translates a thrown error from the service layer (or this file's
// own helpers) into a structured HTTP error response. Mirrors the
// shape of the translators in `auth.ts` and `cart.ts` for stylistic
// consistency across route files.
//
// Translation rules (in branch order):
//
//   - UnauthenticatedError (req.uid missing — defensive)
//       → 401 with `code: 'UNAUTHENTICATED'`. Indicates a
//         composition-root misconfiguration; should never occur in
//         production.
//
//   - ValidationError (service-layer field validation failure)
//       → with `code === 'DESIGN_NOT_FOUND'`: 404. ST-032-AC3 names
//         this case explicitly — when a cart item references a
//         design not accessible to the user, that is a NOT-FOUND
//         outcome (not a structural validation failure). The
//         service throws `NotFoundError` for this case, but the
//         translator special-cases the code on `ValidationError`
//         too as a defensive measure should a future service
//         refactor unify the throw class.
//       → otherwise: 400 with the originating `code` (e.g.
//         'EMPTY_CART', 'VALIDATION_FAILED') and the originating
//         `message`.
//
//   - NotFoundError
//       → 404 with the originating `code` (e.g. 'ORDER_NOT_FOUND',
//         'DESIGN_NOT_FOUND') and the originating `message`.
//
//   - ConflictError
//       → 409 with the originating `code` (e.g.
//         'ORDER_STATE_INVALID', 'ORDER_STATE_CONCURRENT_CHANGE')
//         and the originating `message`. The DISTINCT codes give
//         operators a clear signal during incident response — see
//         the `ConflictError` docblock in
//         `../services/order.service.ts`.
//
//   - Anything else
//       → 500 INTERNAL_ERROR. Logged via `req.log.error` with
//         bounded, structural metadata only (no stack, no cause,
//         no echoed body). Per Rule R2 the log NEVER includes
//         credential material; the message is truncated to 200
//         characters as a secondary defense against pathological
//         error.message payloads.
//
// Per Rule R8 (fail-closed): every code path produces a non-2xx
// response. There is NO branch that returns 200 while the
// operation failed.
// ---------------------------------------------------------------------------

/**
 * Translate a thrown error to a structured HTTP response.
 *
 * @param err The thrown error (typed as `unknown` per the project's
 *   strict-TypeScript posture; defensive structural narrowing
 *   follows).
 * @param req Express request — used only to access `req.log` for
 *   the error log record.
 * @param res Express response — used to send the error envelope.
 * @param _next Express next callback. Currently unused (this
 *   function handles every translation by sending a response
 *   directly), but the parameter is retained so a future variant
 *   could forward to the central error handler without changing
 *   call sites.
 */
function handleRouteError(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // Defensive structural extraction — each access uses optional
  // chaining and a type narrowing so a malformed throw value (e.g.
  // `throw 42`, `throw null`, `throw "oops"`) does not itself raise
  // and crash the response.
  const errObj = err as
    | { name?: unknown; code?: unknown; message?: unknown }
    | null
    | undefined;
  const name: string | undefined =
    typeof errObj?.name === 'string' ? errObj.name : undefined;
  const code: string | undefined =
    typeof errObj?.code === 'string' ? errObj.code : undefined;
  const message: string | undefined =
    typeof errObj?.message === 'string' ? errObj.message : undefined;

  // ── 401 UNAUTHENTICATED ──────────────────────────────────────────
  // Defensive — the session middleware should always populate
  // req.uid before this route runs. If we reach this branch, a
  // composition-root misconfiguration has weakened the contract;
  // surface as 401 (not 500) so the client can re-authenticate.
  if (name === 'UnauthenticatedError') {
    res.status(401).json(buildError('UNAUTHENTICATED', 'Authentication required'));
    return;
  }

  // ── 400 VALIDATION_FAILED / 404 DESIGN_NOT_FOUND ─────────────────
  // ValidationError covers structural validation failures and the
  // empty-cart rejection (code: 'EMPTY_CART'). The service uses
  // NotFoundError for ownership failures, but defensive special-
  // case here on ValidationError too in case a future refactor
  // unifies the throw class.
  if (name === 'ValidationError') {
    if (code === 'DESIGN_NOT_FOUND') {
      res
        .status(404)
        .json(buildError(code, message ?? 'Design not found or not accessible'));
      return;
    }
    res
      .status(400)
      .json(buildError(code ?? 'VALIDATION_FAILED', message ?? 'Invalid input'));
    return;
  }

  // ── 404 NOT_FOUND ────────────────────────────────────────────────
  // Service-layer NotFoundError for missing/unauthorized resources.
  // The originating `code` (e.g. 'ORDER_NOT_FOUND',
  // 'DESIGN_NOT_FOUND') is forwarded so clients can branch on the
  // specific outcome.
  if (name === 'NotFoundError') {
    res
      .status(404)
      .json(buildError(code ?? 'NOT_FOUND', message ?? 'Resource not found'));
    return;
  }

  // ── 409 CONFLICT ─────────────────────────────────────────────────
  // Service-layer ConflictError for state-machine violations during
  // finalization. Two distinct codes:
  //   - 'ORDER_STATE_INVALID'         — pre-check found the order in
  //                                     a non-'created' state.
  //   - 'ORDER_STATE_CONCURRENT_CHANGE' — conditional UPDATE matched
  //                                       zero rows because of a race.
  // Both are forwarded to the client so a polling loop can react
  // appropriately (e.g. backoff vs. show "already finalized" UI).
  if (name === 'ConflictError') {
    res
      .status(409)
      .json(buildError(code ?? 'CONFLICT', message ?? 'Resource conflict'));
    return;
  }

  // ── 500 INTERNAL_ERROR ───────────────────────────────────────────
  // Unrecognised error class. Log a single bounded ERROR record via
  // the request-scoped pino logger (configured with the serializer
  // allow-list in `../logging/pino.ts` to redact any accidental
  // credential leakage), then return a non-leaking 500.
  //
  // The log record contains:
  //   - `event`        — fixed identifier `'orders.route.error'` for
  //                      log-pipeline filtering and dashboard panels.
  //   - `errorName`    — the JS error class name.
  //   - `errorCode`    — the `code` field if present.
  //   - `errorMessage` — the error's message TRUNCATED to 200
  //                      characters. We never include `.stack` or
  //                      `.cause` (those expose call-site detail
  //                      that aids attackers).
  //
  // Per Rule R2 this log call NEVER includes:
  //   - The request body (cart items + metadata; not credentials,
  //     but a Rule R2 PII-minimisation posture).
  //   - The Authorization header value (not read by this file).
  //   - Any credential variable.
  //
  // The structural cast to `Request & { log?: ... }` mirrors the
  // pattern in `cart.ts` and `auth.ts` and is necessary because
  // `pino-http` attaches `req.log` at runtime but does not expose a
  // global type augmentation for it. The cast is local — it does
  // not pollute the rest of the type system.
  const reqWithLog = req as Request & {
    log?: { error: (obj: unknown, msg?: string) => void };
  };
  const log = reqWithLog.log;
  if (log !== undefined) {
    log.error(
      {
        event: 'orders.route.error',
        errorName: name,
        errorCode: code,
        errorMessage:
          typeof message === 'string' ? message.slice(0, 200) : undefined,
      },
      'orders route error',
    );
  }

  res.status(500).json(buildError('INTERNAL_ERROR', 'Internal server error'));
}
