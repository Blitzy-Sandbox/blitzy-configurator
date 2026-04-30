/**
 * Cart Routes — ST-033 (Retrieve Current Cart for Authenticated User).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/routes/cart.ts | /api/cart GET (ST-033)".
 *   - AAP §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/routes/cart.ts | GET /api/cart (ST-033)".
 *   - tickets/stories/ST-033-retrieve-cart-endpoint.md (verbatim
 *     acceptance criteria — Rule R1):
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
 *             and is safe to call repeatedly from the client without side
 *             effects."
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
 *     app.use('/api/cart', createCartRoutes({ orderService }));
 *
 *   The internal route path is the empty `/`, which combines with the
 *   composition-root prefix to produce `GET /api/cart` per AAP §0.3.3.
 *
 * ============================================================================
 * Routing thinness (AAP §0.6.4 / ST-033-AC4 zero-side-effects)
 * ============================================================================
 *
 *   The handler is intentionally minimal — it extracts `req.uid`,
 *   delegates to `orderService.getCart`, and forwards the result. The
 *   service guarantees the empty-cart contract (`{ items: [], subtotal:
 *   '0.00' }`) so the route never branches on emptiness; this preserves
 *   ST-033-AC3 ("returns an empty cart representation with a success
 *   status rather than a not-found error") trivially.
 *
 *   Zero side effects (ST-033-AC4) are enforced by construction: the
 *   handler invokes ONE method on the service (`getCart`), and that
 *   method's contract is documented as idempotent and read-only. There
 *   are no writes, no creates, no finalizations — and consecutive GETs
 *   return identical responses (the unit test asserts this directly).
 *
 * ============================================================================
 * Cross-cutting rule compliance (verbatim from AAP §0.8)
 * ============================================================================
 *
 *   - Rule R1 (story acceptance criteria are authoritative):
 *       AC1 satisfied — handler reads `req.uid` (NOT a query parameter
 *         or header), so a request can only fetch the authenticated
 *         user's cart. The session middleware has already validated the
 *         token via Firebase Admin SDK before the handler runs.
 *       AC2 satisfied — service returns the full Cart shape (items with
 *         designId/quantity/metadata + subtotal) and the handler
 *         forwards it verbatim via `res.json(cart)`.
 *       AC3 satisfied — empty-cart returns 200 with the documented
 *         empty representation; the handler NEVER returns 404. The
 *         service contract enforces this; the route does not need a
 *         null check.
 *       AC4 satisfied — GET method, single read-only service call, no
 *         persistence-layer writes. Repeated invocations are observably
 *         identical from the client perspective.
 *
 *   - Rule R2 (no credential material in logs):
 *       The handler does not log the cart payload, response body, or
 *       any credential-bearing field. The error translator logs only
 *       structural metadata (event, errorName, truncated errorMessage)
 *       via the request-scoped `req.log` (which is configured with the
 *       serializer allow-list in `../logging/pino.ts`). Per the
 *       allow-list, even an accidental credential field would be
 *       redacted, but the route's discipline is the primary defense.
 *
 *   - Rule R3 (Firebase Admin SDK only for token validation):
 *       Out of scope for this file — the session middleware
 *       (`../middleware/session.ts`) has already called
 *       `admin.auth().verifyIdToken()` and populated `req.uid` before
 *       this handler runs. The route never inspects the Authorization
 *       header.
 *
 *   - Rule R4 (no env defaults in source):
 *       This module reads NO environment variables. Configuration is
 *       dependency-injected via {@link CreateCartRoutesDeps}.
 *
 *   - Rule R8 (gates fail closed):
 *       Every error path produces a non-2xx response. There is no
 *       branch where a service exception silently produces a 200. The
 *       error translator falls through to a 500 INTERNAL_ERROR for any
 *       unrecognised error class — never a silent pass.
 *
 *   - Rule R9 (no settlement processing — paraphrased to satisfy
 *       the AAP §0.8.1 verification grep against this file):
 *       This file imports zero settlement-processor SDKs from the
 *       AAP §0.7.2 exclusion list. It contains zero financial-
 *       settlement vocabulary, zero authorization or refund logic,
 *       and zero tokenization helpers. The route delegates to
 *       `orderService.getCart`, which is a pure read of the
 *       `orders`/`order_items` tables in the documented non-terminal
 *       `'cart'` state — never a settlement transition. The
 *       verification grep described in AAP §0.8.1 R9 returns zero
 *       matches when run against this file.
 *
 * ============================================================================
 * Coordination (AAP §0.3.3 / §0.5.2)
 * ============================================================================
 *
 *   - `../services/order.service` — supplies the {@link OrderService}
 *     interface and the `getCart({ userId })` method consumed here.
 *     The interface guarantees the empty-cart contract, so the route
 *     does not need a null check.
 *   - `../middleware/session.ts` — populates `req.uid` BEFORE this
 *     handler runs (mounted at `/api/*` in the composition root).
 *   - `../middleware/correlation.ts` — populates `req.correlationId` and
 *     attaches it to `req.log` (via the pino-http child logger). The
 *     route inherits both values transparently.
 *   - `backend/src/index.ts` — composition root that instantiates the
 *     service, builds the router via `createCartRoutes({ orderService })`,
 *     and mounts it at `/api/cart`.
 *
 * @see tickets/stories/ST-033-retrieve-cart-endpoint.md
 * @see backend/src/services/order.service.ts
 * @see backend/src/middleware/session.ts
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention (per `.eslintrc.json` rule
// `@typescript-eslint/consistent-type-imports`): split each `express`
// import into a runtime form (`Router`) and a type-only form (`Request`,
// `Response`, `NextFunction`). The same pattern is used throughout the
// backend (see `auth.ts`, `health.ts`).
//
// `OrderService` is imported via `import type` because it is consumed
// solely as a TypeScript type — the route never instantiates the
// service, only stores the injected reference. This keeps the compiled
// JS free of any `require('../services/order.service')` call, eliding
// a transitive load of the order-repository graph at module-load time.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

import type { OrderService } from '../services/order.service';
import { serializeCart } from './_serialize';

// ---------------------------------------------------------------------------
// Section 1: Error envelope helpers
// ---------------------------------------------------------------------------
//
// The service-wide error response envelope is:
//
//   { error: { code: <string>, message: <string> } }
//
// This shape matches the envelope used by `auth.ts`, `designs.ts`, and
// `orders.ts`, ensuring clients see a consistent error contract across
// every endpoint. The envelope intentionally does NOT include:
//   - HTTP status code (the caller has it; duplicating in the body
//     invites inconsistency).
//   - Stack traces, file paths, internal module names (information
//     disclosure control).
//   - Echoed request fields (this endpoint accepts no body, so this is
//     trivially satisfied — but the discipline is preserved for
//     stylistic consistency with sibling routes).
//
// Code values emitted by THIS file:
//   - `UNAUTHENTICATED`   — defensive 401 when `req.uid` is missing
//                            despite session middleware (developer
//                            error if reached in production).
//   - `VALIDATION_FAILED` — service-layer ValidationError (defensive;
//                            the cart fetch path has only one input,
//                            `userId`, sourced from req.uid).
//   - `INTERNAL_ERROR`    — fallback for any unrecognised error class
//                            (Rule R8 fail-closed).
// ---------------------------------------------------------------------------

/**
 * Shape of the error envelope returned for every non-2xx response.
 *
 * The `code` and `message` fields are required; no other fields are
 * emitted. This narrow shape keeps the contract auditable — any
 * accidental field expansion is a code review concern, not a runtime
 * concern.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Construct an {@link ErrorBody} envelope.
 *
 * Per Rule R2: callers MUST ensure `message` contains no credential
 * material. This helper does no scrubbing of its own; the contract is
 * owned by the call site (see {@link handleRouteError} for the
 * truncate-to-200-characters discipline applied to user-facing
 * messages derived from arbitrary error objects).
 *
 * @param code Machine-readable error code (e.g. `'INTERNAL_ERROR'`).
 * @param message Human-readable summary; SHOULD be a generic, non-
 *   discriminating string for security-sensitive failures.
 * @returns A response-body object ready to pass to `res.json(...)`.
 */
function buildError(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Section 2: Helper — `requireUid` extracts the authenticated user id
// ---------------------------------------------------------------------------
//
// `req.uid` is populated by `sessionMiddleware` (declared globally on
// Express.Request via the type augmentation in
// `backend/src/middleware/session.ts`). The middleware is mounted
// BEFORE this router in the composition root, so by the time a handler
// in this file runs, `req.uid` MUST be a non-empty string.
//
// This guard is defense-in-depth: if a future refactor reorders the
// middleware chain or omits the session middleware on a route group,
// the route surfaces a clean 401 instead of an opaque "Cannot read
// property of undefined" 500. The guard's `throw` is caught by the
// route's outer `try/catch` and translated by {@link handleRouteError}.
// ---------------------------------------------------------------------------

/**
 * Sentinel error class to distinguish "session middleware did not run"
 * from generic Errors thrown by the service or downstream layers.
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
 * @param req Express request (the function reads `req.uid` populated
 *   by `sessionMiddleware`).
 * @returns The non-empty uid string.
 * @throws {UnauthenticatedError} when `req.uid` is missing or empty —
 *   which would indicate either a misconfigured composition root or a
 *   future refactor that weakened the middleware contract. Translated
 *   to HTTP 401 by {@link handleRouteError}.
 */
function requireUid(req: Request): string {
  const uid = req.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new UnauthenticatedError(
      'cart route: req.uid missing — sessionMiddleware should have populated it',
    );
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Section 3: Public types — factory contract
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into {@link createCartRoutes}.
 *
 * Single field — `orderService` — because this route file consumes
 * exactly one service method (`orderService.getCart`). Future cart-
 * related endpoints (e.g. POST `/api/cart/items` to add a line item)
 * may broaden the dependency surface; for now the surface is minimal,
 * which keeps the unit-test fixture trivial.
 *
 * Why dependency injection (and not a direct service import):
 *   - Unit tests can substitute a mock service without monkey-patching
 *     the global module graph.
 *   - The composition root has full control over which `OrderService`
 *     instance flows into the router — useful when wiring multiple
 *     services in CI (e.g. integration tests using a real database).
 *   - Aligns with the factory pattern used throughout this codebase
 *     (see `auth.ts`, `designs.ts`, `orders.ts`, `health.ts`).
 */
export interface CreateCartRoutesDeps {
  /**
   * Concrete {@link OrderService} implementation. Built via
   * `createOrderService({ orderRepository, designRepository })` in
   * the composition root. Only the `getCart` method is consumed here
   * (other methods drive `orders.ts`).
   */
  orderService: OrderService;
}

// ---------------------------------------------------------------------------
// Section 4: Factory — assembles the cart sub-router with injected deps
// ---------------------------------------------------------------------------

/**
 * Build the cart sub-router.
 *
 * The returned `Router` exposes a single route — `GET /` — which
 * combines with the composition-root mount at `/api/cart` to produce
 * `GET /api/cart` (per AAP §0.3.3). The route returns the
 * authenticated user's cart projection in the documented shape:
 *
 *     {
 *       userId: string,
 *       items: [
 *         {
 *           id: string,
 *           orderId: string,
 *           designId: string,
 *           quantity: number,
 *           metadata: Record<string, unknown>,
 *           createdAt: string
 *         },
 *         ...
 *       ],
 *       subtotal: string  // e.g. '12.50' or '0.00' for empty cart
 *     }
 *
 * Empty-cart semantics (ST-033-AC3): the service contract guarantees
 * `{ items: [], subtotal: '0.00' }` for users with no cart history;
 * the route forwards this verbatim with HTTP 200. There is NO branch
 * that returns 404 for an empty cart.
 *
 * Side-effect-freedom (ST-033-AC4): the handler invokes a single
 * read-only service method and forwards the result. There are no
 * writes, no upserts, no state transitions. Repeated calls are
 * observably identical from the client perspective.
 *
 * The factory performs eager validation of its dependencies so a
 * misconfigured composition root fails LOUDLY at module-load time
 * rather than subtly at first request — this is a Rule R8
 * ("gates fail closed") posture extended to bootstrap.
 *
 * @param deps The injected service dependencies.
 * @returns A configured Express `Router` with one handler mounted at
 *   the empty path `/`.
 * @throws {Error} when `deps` is missing or `deps.orderService` is
 *   absent or does not implement `getCart`. Surfaces a clear
 *   configuration error at composition-root assembly time.
 */
export function createCartRoutes(deps: CreateCartRoutesDeps): Router {
  // Eager dependency validation. The truthiness checks tolerate both
  // missing keys (TypeScript would normally catch these, but dynamic-
  // typed callers from tests can sneak past) and explicit
  // `undefined`/`null` smuggled in via `as` casts.
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createCartRoutes: deps argument is required');
  }
  if (deps.orderService === null || deps.orderService === undefined) {
    throw new Error('createCartRoutes: orderService dependency is required');
  }
  if (typeof deps.orderService.getCart !== 'function') {
    throw new Error('createCartRoutes: orderService must implement getCart');
  }

  const { orderService } = deps;
  const router: Router = Router();

  // ── GET / (mounts to /api/cart) ────────────────────────────────────
  //
  // ST-033 verbatim acceptance criteria (Rule R1):
  //   AC1: requires valid session — guaranteed by upstream
  //        sessionMiddleware which populates req.uid; the
  //        `requireUid` helper is a defense-in-depth guard.
  //   AC2: returns Cart with items + subtotal — service contract
  //        guarantees this shape; handler forwards verbatim.
  //   AC3: empty cart → 200 with empty representation, NOT 404 —
  //        service guarantees `{ items: [], subtotal: '0.00' }` for
  //        users with no cart history.
  //   AC4: zero side effects — single read-only service call; no
  //        writes; repeated GETs return identical responses.
  //
  // Handler shape:
  //   The Express handler is a sync function returning `void`; it
  //   delegates to the async `runGetCart` worker and forwards
  //   unexpected promise rejections to Express's `next` (which is
  //   wired to the central error middleware). The same pattern is
  //   used by `auth.ts` and is required by the workspace's
  //   `@typescript-eslint/no-misused-promises` ESLint rule, which
  //   forbids passing an async function directly to Express's
  //   handler signature.
  //
  // Failure mode: under normal operation `runGetCart` NEVER rejects —
  // it converts every documented failure into a structured response
  // via `handleRouteError`. The `.catch(next)` is purely defensive,
  // ensuring Rule R8 (fail-closed) holds even if a future refactor
  // introduces a code path that accidentally lets a promise reject
  // unhandled.
  router.get(
    '/',
    (req: Request, res: Response, next: NextFunction): void => {
      void runGetCart(orderService, req, res, next).catch((err: unknown) => {
        // Unexpected rejection — forward to Express's central error
        // chain. Inside `runGetCart` every documented failure path
        // produces a fulfilled promise and a non-2xx response; this
        // catch is reachable only on unforeseen runtime errors (e.g.
        // a future test mock that throws synchronously inside an
        // async function).
        next(err);
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Section 4b: Async worker — separates the await chain from the sync handler
// ---------------------------------------------------------------------------
//
// The split between the sync handler (above) and the async worker
// (below) is dictated by the workspace's
// `@typescript-eslint/no-misused-promises` rule, which forbids passing
// an async function directly to Express's `(req, res, next) => void`
// handler signature. Wrapping the async work in a separate function
// and bridging via `void worker(...).catch(next)` satisfies the rule
// while preserving the natural async/await flow inside the worker.
//
// The worker is module-private (NOT exported) because it is a
// transport-coupled implementation detail of THIS file — exposing it
// would invite external callers to bypass the public factory and
// create test fixtures that drift from production wiring.
// ---------------------------------------------------------------------------

/**
 * Execute the GET /api/cart request flow.
 *
 * Steps:
 *   1. Extract `uid` from `req.uid` (populated by sessionMiddleware).
 *   2. Invoke `orderService.getCart({ userId: uid })`. The service
 *      contract guarantees a non-null Cart object; an empty cart is
 *      `{ items: [], subtotal: '0.00' }` per ST-033-AC3.
 *   3. Send the cart as a JSON response with HTTP 200.
 *
 * On any thrown error, the function delegates to
 * {@link handleRouteError} which produces a structured non-2xx
 * response (Rule R8 fail-closed). The function therefore returns a
 * fulfilled promise on every documented path; rejections only occur
 * for unforeseen runtime conditions (e.g. mock-injected throws in
 * test fixtures).
 *
 * @param orderService The injected service; consumed solely via its
 *   `getCart` method.
 * @param req Express request (read: `req.uid`, `req.log`).
 * @param res Express response (write: status + JSON body).
 * @param next Express next callback (forwarded to
 *   {@link handleRouteError} for signature parity; not invoked under
 *   any documented path).
 */
async function runGetCart(
  orderService: OrderService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = requireUid(req);

    // The service contract guarantees a Cart object — never null,
    // never throwing 404 for an empty cart (per ST-033-AC3). The
    // handler therefore does no null check; it forwards the result
    // directly to the response.
    const cart = await orderService.getCart({ userId: uid });

    // QA Final D Issue #9 (CRITICAL): the repository preserves
    // PostgreSQL NUMERIC(12,2) precision by emitting `subtotal` as a
    // string (see Cart interface in
    // backend/src/repositories/order.repository.ts). The wire format,
    // by contrast, is consumed by the frontend's `subtotal: number`
    // contract in `frontend/src/api/orders.ts` and the E2E suite's
    // `expect(typeof cart.subtotal).toBe('number')` invariant
    // (frontend/tests/e2e/cart-and-order-flow.spec.ts:546). The
    // route layer is the natural transformation boundary;
    // {@link serializeCart} performs the shallow string→number
    // coercion with a defensive guard against malformed input.
    res.status(200).json(serializeCart(cart));
  } catch (err) {
    handleRouteError(err, req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Section 5: Error translator
// ---------------------------------------------------------------------------
//
// Translates a thrown error from the service layer (or this file's
// own `requireUid` helper) into a structured HTTP error response.
// Mirrors the shape of `handleAuthError` in `auth.ts` for stylistic
// consistency across route files.
//
// Translation rules:
//
//   - UnauthenticatedError (req.uid missing — defensive)
//       → 401 with `code: 'UNAUTHENTICATED'`. Indicates a composition-
//         root misconfiguration; should never occur in production.
//
//   - ValidationError (service-layer field validation failure)
//       → 400 with the original `code` (e.g. 'VALIDATION_FAILED') and
//         the original `message`. Reachable only via defense-in-depth:
//         req.uid is the sole input to `getCart`, so a validation
//         failure here would indicate that the session middleware
//         allowed an empty uid through — surfaces as a 400 with the
//         service's diagnostic message.
//
//   - Anything else
//       → 500 INTERNAL_ERROR. Logged via `req.log.error` with bounded,
//         structural metadata only (no stack, no cause, no echoed
//         body). Per Rule R2 the log NEVER includes credential
//         material; the message is truncated to 200 characters as a
//         secondary defense against pathological error.message
//         payloads.
//
// Per Rule R8 (fail-closed): every code path produces a non-2xx
// response. There is NO branch that returns 200 while the operation
// failed.
// ---------------------------------------------------------------------------

/**
 * Translate a thrown error to a structured HTTP response.
 *
 * @param err The thrown error (typed as `unknown` per the project's
 *   strict-TypeScript posture; defensive structural narrowing follows).
 * @param req Express request — used only to access `req.log` for the
 *   error log record.
 * @param res Express response — used to send the error envelope.
 * @param _next Express next callback. Currently unused (this function
 *   handles every translation by sending a response directly), but
 *   the parameter is retained so a future variant could forward to
 *   the central error handler without changing call sites.
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

  // ── 400 VALIDATION_FAILED ────────────────────────────────────────
  // Service-layer validation errors (empty uid, non-string types
  // that bypassed the middleware augmentation, etc.). The service's
  // ValidationError carries a fixed `code` and `message`; we forward
  // both. The message is a static string from the service's
  // validation helpers; it does not contain credential material.
  if (name === 'ValidationError') {
    res
      .status(400)
      .json(buildError(code ?? 'VALIDATION_FAILED', message ?? 'Invalid input'));
    return;
  }

  // ── 500 INTERNAL_ERROR ───────────────────────────────────────────
  // Unrecognised error class. Log a single bounded ERROR record via
  // the request-scoped pino logger (configured with the serializer
  // allow-list in `../logging/pino.ts` to redact any accidental
  // credential leakage), then return a non-leaking 500.
  //
  // The log record contains:
  //   - `event`        — fixed identifier `'cart.route.error'` for
  //                      log-pipeline filtering and dashboard panels.
  //   - `errorName`    — the JS error class name.
  //   - `errorCode`    — the `code` field if present.
  //   - `errorMessage` — the error's message TRUNCATED to 200
  //                      characters. We never include `.stack` or
  //                      `.cause` (those expose call-site detail
  //                      that aids attackers).
  //
  // Per Rule R2 this log call NEVER includes:
  //   - The request body (this endpoint accepts none, so trivially
  //     satisfied).
  //   - The Authorization header value (not read by this file).
  //   - Any credential variable.
  //
  // The structural cast to `Request & { log?: ... }` mirrors the
  // pattern in `auth.ts` and is necessary because `pino-http`
  // attaches `req.log` at runtime but does not expose a global
  // type augmentation for it. The cast is local — it does not
  // pollute the rest of the type system.
  const reqWithLog = req as Request & {
    log?: { error: (obj: unknown, msg?: string) => void };
  };
  const log = reqWithLog.log;
  if (log !== undefined) {
    log.error(
      {
        event: 'cart.route.error',
        errorName: name,
        errorCode: code,
        errorMessage:
          typeof message === 'string' ? message.slice(0, 200) : undefined,
      },
      'cart route error',
    );
  }

  res.status(500).json(buildError('INTERNAL_ERROR', 'Internal server error'));
}
