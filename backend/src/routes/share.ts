/**
 * Share Routes — ST-029 consumer side (UNAUTHENTICATED read endpoint).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/routes/share.ts | /api/share/:token GET —
 *        unauthenticated read-only design access".
 *   - AAP §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/routes/share.ts | GET /api/share/:token
 *        unauthenticated read-only design".
 *   - tickets/stories/ST-029-share-link-issuance-endpoint.md (verbatim
 *     acceptance criteria — Rule R1):
 *
 *       AC1: "The share-link endpoint requires a valid session and issues
 *             a share link only for a design owned by the authenticated
 *             user." — covered by `routes/designs.ts` (the issuance side,
 *             POST `/api/designs/:id/share-link`). NOT this file.
 *
 *       AC2: "Each issued share link carries a documented expiration and
 *             points to exactly one design; expired links are rejected by
 *             the read side with a documented error." — THE READ SIDE IS
 *             THIS FILE. Expired links → 404 (the route layer collapses
 *             every "the link cannot be honored" failure mode into a
 *             single 404 to defeat enumeration, see Phase D notes below).
 *
 *       AC3: "Visiting a valid, unexpired share link returns enough
 *             information for the configurator to render the target
 *             design read-only without requiring the visitor to sign in."
 *             — THIS IS THE PRIMARY OBJECTIVE OF THIS FILE. The route
 *             MUST NOT be guarded by `sessionMiddleware`; it MUST NOT
 *             read `req.uid`; it MUST return the {@link SharedDesignView}
 *             shape unchanged from the service.
 *
 *       AC4: "Revoking a share link (by the owner or by expiration)
 *             renders the link inoperable on subsequent requests and does
 *             not affect the underlying design record." — Revoked / expired
 *             links collapse to a 404 here. The underlying design record
 *             is untouched (this route only invokes a SELECT-with-JOIN
 *             via `shareLinkService.getByToken`).
 *
 * ============================================================================
 * Composition root contract (UNAUTHENTICATED — read carefully)
 * ============================================================================
 *
 *   This is the ONE unauthenticated route living under the `/api/*`
 *   prefix. The composition root in `backend/src/index.ts` MUST mount
 *   the share router at the APP ROOT (no `/api` prefix), BEFORE the
 *   session middleware:
 *
 *       app.use(createShareRoutes({ shareLinkService }));   // unguarded
 *       app.use('/api', sessionMiddleware({ sessionService })); // guards rest
 *       app.use('/api', createDesignRoutes(...));
 *       app.use('/api', createOrderRoutes(...));
 *       // ... etc.
 *
 *   The internal route path declared by THIS file is the FULL
 *   `/api/share/:token` — the route owns its own absolute path so that
 *   mounting at the app root produces the expected public URL. Mounting
 *   this file under any prefix (e.g. `app.use('/api', shareRouter)`)
 *   would produce `/api/api/share/:token` and break the contract.
 *
 *   Position in the middleware chain is critical: if this router is
 *   mounted AFTER `sessionMiddleware`, every request would be rejected
 *   with 401 by the middleware before reaching this handler — which
 *   would directly violate ST-029-AC3.
 *
 * ============================================================================
 * Routing thinness (AAP §0.6.4)
 * ============================================================================
 *
 *   The handler is intentionally minimal — it:
 *     1. Extracts `req.params.token` and validates it is a non-empty
 *        string (a defense-in-depth pre-check; the service also
 *        validates).
 *     2. Delegates to `shareLinkService.getByToken({ token })`.
 *     3. Translates the service's tri-valued return into HTTP:
 *           SharedDesignView → 200 with the projection
 *           null              → 404 SHARE_LINK_NOT_FOUND (collapsed)
 *           thrown error      → {@link handleRouteError} translation
 *
 *   There is NO business logic here — the service owns the database
 *   lookup, the validity gates (revoked / expired / orphan), the
 *   credential-clean log records, and the read-side projection shape.
 *   This keeps the routing layer trivially testable (a unit test injects
 *   a mock service and asserts request/response shape) and keeps the
 *   service layer transport-agnostic.
 *
 * ============================================================================
 * Enumeration defense — why ALL service-null paths collapse to 404
 * ============================================================================
 *
 *   The service's `getByToken` returns `null` for FOUR distinct
 *   conditions:
 *     (1) unknown token (no row)
 *     (2) revoked share link
 *     (3) expired share link
 *     (4) orphan row (link's design FK no longer resolves)
 *
 *   Some implementations distinguish (1) → 404 and (2/3) → 410 Gone.
 *   THIS IMPLEMENTATION INTENTIONALLY DOES NOT. A unified 404
 *   `SHARE_LINK_NOT_FOUND` response across all four conditions
 *   prevents an attacker from learning whether a token EVER existed,
 *   which would otherwise leak information useful for offline brute
 *   force (e.g. "this token format was once valid; let me try
 *   adjacent values"). The 256-bit token entropy makes this attack
 *   infeasible in practice, but defense-in-depth at the response
 *   layer is cheap and consistent with the service's enumeration-
 *   defense posture (see service §6 "Information-disclosure posture").
 *
 *   Operator visibility into WHICH null condition fired is preserved
 *   by the service's structured log records — `share_link.get.revoked`,
 *   `share_link.get.expired`, `share_link.get.orphan`,
 *   `share_link.get.not_found` — which dashboards can filter on for
 *   rate-of-failure observability.
 *
 * ============================================================================
 * Cross-cutting rule compliance (verbatim from AAP §0.8)
 * ============================================================================
 *
 *   - Rule R1 (story acceptance criteria are authoritative):
 *       ST-029-AC2 (read side) satisfied — expired links are rejected
 *         with a documented error (`SHARE_LINK_NOT_FOUND`, HTTP 404).
 *         The service's `expiresAt <= now()` gate produces the null
 *         that drives this branch.
 *       ST-029-AC3 satisfied — the route handler is reachable WITHOUT
 *         a session token (no session middleware in front of it). On
 *         success it returns the {@link SharedDesignView} verbatim,
 *         which contains exactly the fields the configurator needs to
 *         render the design read-only and intentionally NOT the owner's
 *         identity, the token, or any other internal metadata.
 *       ST-029-AC4 satisfied — revoked links and expired links both
 *         collapse to the same 404 path. The route never invokes any
 *         service method that mutates the underlying design record.
 *
 *   - Rule R2 (no credential material in logs) — DOMINANT for this
 *       file because the share link token IS credential-like material
 *       (whoever holds it can read the design). Mitigations:
 *         (a) The route handler NEVER passes the raw token to any
 *             logger call. The only place the token appears in code is
 *             as the argument to `shareLinkService.getByToken({ token })`.
 *         (b) The error translator emits ONLY structural metadata
 *             (event, errorName, errorCode, truncated errorMessage) via
 *             the request-scoped `req.log`. Pino's serializer allow-list
 *             in `../logging/pino.ts` provides defense-in-depth, but
 *             the route's per-call discipline is the primary defense.
 *         (c) The token DOES appear in the request URL path
 *             (`/api/share/<token>`). HTTP access logs typically
 *             record the URL path; mitigating this is owned by the
 *             logging layer's URL-redaction policy, not by this file.
 *             This file MINIMISES the exposure but cannot eliminate
 *             it (the URL path is the canonical input to the route).
 *
 *   - Rule R3 (Firebase Admin SDK only): N/A — this route does not
 *       perform any token validation. It is unauthenticated.
 *
 *   - Rule R4 (no env defaults in source): This module reads NO
 *       environment variables. Configuration is dependency-injected
 *       via {@link CreateShareRoutesDeps}.
 *
 *   - Rule R5 (GCS v7 signed URL syntax): N/A — this file makes no
 *       calls to `@google-cloud/storage`.
 *
 *   - Rule R8 (gates fail closed):
 *       Every error path produces a non-2xx response:
 *         - 400 VALIDATION_TOKEN_MISSING when path param is empty
 *           (defense-in-depth; Express's `:token` route would not
 *           normally match an empty path segment, but the guard
 *           handles edge cases like `/api/share/%20` where the token
 *           is whitespace-only).
 *         - 404 SHARE_LINK_NOT_FOUND when service returns null OR
 *           when the service throws a NotFoundError.
 *         - 400 VALIDATION_FAILED when service throws a
 *           ValidationError (defensive; the route's pre-check should
 *           catch all validation failures, but the service's inputs
 *           are validated independently).
 *         - 500 INTERNAL_ERROR for any unrecognised error class
 *           (Rule R8 — never a silent pass).
 *
 *   - Rule R9 (no payment processing): N/A — this file imports zero
 *       settlement-processor SDKs and contains zero financial
 *       vocabulary.
 *
 * ============================================================================
 * Coordination (AAP §0.3.3 / §0.5.2)
 * ============================================================================
 *
 *   - `../services/share-link.service` — supplies the
 *     {@link ShareLinkService} interface and the `getByToken({ token })`
 *     method consumed here. The service guarantees a tri-valued return
 *     (SharedDesignView | null | thrown) so the route's translation
 *     logic is total.
 *   - `../middleware/correlation.ts` — populates `req.correlationId`
 *     and attaches it to `req.log` (via the pino-http child logger).
 *     The route inherits both values transparently. The correlation
 *     middleware runs BEFORE this route in the composition root.
 *   - `backend/src/index.ts` — composition root that instantiates the
 *     service, builds the router via `createShareRoutes({ shareLinkService })`,
 *     and mounts it at the APP ROOT (NOT under any prefix).
 *
 * @see tickets/stories/ST-029-share-link-issuance-endpoint.md
 * @see backend/src/services/share-link.service.ts
 * @see backend/src/middleware/correlation.ts
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention (per `.eslintrc.json` rule
// `@typescript-eslint/consistent-type-imports`): split `express` into a
// runtime form (`Router`) and type-only forms (`Request`, `Response`,
// `NextFunction`). Same pattern as `auth.ts`, `cart.ts`, `orders.ts`.
//
// `ShareLinkService` is imported via `import type` because it is
// consumed solely as a TypeScript type — the route never instantiates
// the service, only stores the injected reference. This keeps the
// compiled JS free of any `require('../services/share-link.service')`
// call, eliding a transitive load of the share-link-repository graph
// at module-load time.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

import type { ShareLinkService } from '../services/share-link.service';

// ---------------------------------------------------------------------------
// Section 1: Error envelope helpers
// ---------------------------------------------------------------------------
//
// The service-wide error response envelope is:
//
//   { error: { code: <string>, message: <string> } }
//
// This shape matches the envelope used by `auth.ts`, `cart.ts`,
// `designs.ts`, and `orders.ts`, ensuring clients see a consistent
// error contract across every endpoint. The envelope intentionally
// does NOT include:
//   - HTTP status code (the caller has it; duplicating in the body
//     invites inconsistency).
//   - Stack traces, file paths, internal module names (information
//     disclosure control — particularly important for an unauthenticated
//     endpoint where any internal detail leaks to anonymous visitors).
//   - Echoed request fields (this endpoint accepts no body and only the
//     :token path parameter; we never echo the token because the token
//     is credential-like material per Rule R2).
//   - A `details` field (unlike the auth/designs routes which expose
//     Zod issue lists). Unauthenticated visitors should get zero
//     internal-state hints; the minimal `{ code, message }` envelope is
//     deliberately less informative than the authenticated routes'.
//
// Code values emitted by THIS file:
//   - `VALIDATION_TOKEN_MISSING` — request reached the handler with an
//                                  empty/whitespace-only :token (400).
//   - `VALIDATION_FAILED`         — service-layer ValidationError fallback
//                                  (400). Defensive; the route's
//                                  pre-check should catch this first.
//   - `SHARE_LINK_NOT_FOUND`      — service returned null (any of: unknown
//                                  token, revoked, expired, orphan) OR
//                                  threw a NotFoundError (404). Single
//                                  code for all four cases — enumeration
//                                  defense.
//   - `INTERNAL_ERROR`            — fallback for any unrecognised error
//                                  class (500; Rule R8 fail-closed).
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
 * material — and in particular MUST NOT include the share-link token,
 * which is the credential being probed by this route. This helper does
 * no scrubbing of its own; the contract is owned by the call site.
 *
 * @param code Machine-readable error code (e.g. `'SHARE_LINK_NOT_FOUND'`).
 * @param message Human-readable summary; SHOULD be a generic, non-
 *   discriminating string to maximise information hiding for the
 *   unauthenticated audience of this endpoint.
 * @returns A response-body object ready to pass to `res.json(...)`.
 */
function buildError(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Section 2: Public types — factory contract
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into {@link createShareRoutes}.
 *
 * Single field — `shareLinkService` — because this route file consumes
 * exactly one service method (`shareLinkService.getByToken`). Future
 * share-link related read endpoints (e.g. a metadata-only HEAD probe)
 * may broaden the dependency surface; for now the surface is minimal,
 * which keeps the unit-test fixture trivial.
 *
 * Why dependency injection (and not a direct service import):
 *   - Unit tests can substitute a mock service without monkey-patching
 *     the global module graph.
 *   - The composition root has full control over which `ShareLinkService`
 *     instance flows into the router — useful when wiring multiple
 *     services in CI (e.g. integration tests using a real database).
 *   - Aligns with the factory pattern used throughout this codebase
 *     (see `auth.ts`, `cart.ts`, `designs.ts`, `orders.ts`, `health.ts`).
 */
export interface CreateShareRoutesDeps {
  /**
   * Concrete {@link ShareLinkService} implementation. Built via
   * `createShareLinkService({ shareLinkRepository, designRepository })`
   * in the composition root. Only the `getByToken` method is consumed
   * here (the `issue` and `revoke` methods drive `designs.ts`).
   */
  shareLinkService: ShareLinkService;
}

// ---------------------------------------------------------------------------
// Section 3: Factory — assembles the share sub-router with injected deps
// ---------------------------------------------------------------------------

/**
 * Build the share sub-router.
 *
 * The returned `Router` exposes a single route — `GET /api/share/:token`.
 * Because the share endpoint is UNAUTHENTICATED (the visitor MUST be
 * able to render a shared design without signing in per ST-029-AC3),
 * the composition root mounts this router at the APP ROOT, BEFORE the
 * session middleware:
 *
 *       app.use(createShareRoutes({ shareLinkService }));   // unguarded
 *       app.use('/api', sessionMiddleware({ sessionService }));
 *
 * The route's INTERNAL path string is therefore the FULL
 * `/api/share/:token` (not `/share/:token`), so the resulting public
 * URL matches AAP §0.3.3 verbatim. Mounting this router under any
 * prefix (e.g. `app.use('/api', shareRouter)`) would produce
 * `/api/api/share/:token` and break the contract.
 *
 * On success: the handler returns the {@link SharedDesignView}
 * projection — `{ design, designId, title, lastModifiedAt }` — verbatim
 * from the service. The shape is fully typed; the compiler enforces
 * that no field outside this projection (e.g. `ownerUid`, `token`,
 * `expiresAt`) leaks to the unauthenticated visitor.
 *
 * On any null return from the service (unknown / revoked / expired /
 * orphan): the handler returns a 404 with `code: 'SHARE_LINK_NOT_FOUND'`.
 * All four null causes collapse to the same response — enumeration
 * defense (see file header §"Enumeration defense").
 *
 * On thrown error: the handler delegates to {@link handleRouteError},
 * which translates `ValidationError → 400`, `NotFoundError → 404`,
 * and any other class to a non-leaking 500 INTERNAL_ERROR.
 *
 * The factory performs eager validation of its dependencies so a
 * misconfigured composition root fails LOUDLY at module-load time
 * rather than subtly at first request — extending Rule R8's
 * fail-closed posture to bootstrap.
 *
 * @param deps The injected service dependencies.
 * @returns A configured Express `Router` with one handler mounted at
 *   the absolute path `/api/share/:token`.
 * @throws {Error} when `deps` is missing, `deps.shareLinkService` is
 *   absent, or `deps.shareLinkService.getByToken` is not a function.
 *   Surfaces a clear configuration error at composition-root assembly
 *   time, BEFORE any request can reach a misconfigured handler.
 */
export function createShareRoutes(deps: CreateShareRoutesDeps): Router {
  // -------------------------------------------------------------------
  // Compose-time fail-fast on missing/invalid dependencies.
  //
  // TypeScript's `strict` checks already reject most malformed call
  // sites at compile time, but the runtime guard defends against
  // `any`-cast call sites and JS callers (e.g. ad-hoc test harnesses
  // that bypass the type system). The errors are intentionally
  // descriptive so a developer can identify the missing dep without
  // consulting source.
  //
  // Order of checks: deps presence → service presence → method shape.
  // This order surfaces the highest-level configuration mistake first,
  // which is the most informative for a developer debugging the
  // composition root.
  // -------------------------------------------------------------------
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createShareRoutes: deps argument is required');
  }
  if (deps.shareLinkService === null || deps.shareLinkService === undefined) {
    throw new Error('createShareRoutes: shareLinkService dependency is required');
  }
  if (typeof deps.shareLinkService.getByToken !== 'function') {
    throw new Error('createShareRoutes: shareLinkService must implement getByToken');
  }

  // Destructure into a stable closure-captured reference. This also
  // makes the returned router's handler independent of the `deps`
  // argument's lifetime — the caller can safely discard `deps` after
  // the factory returns.
  const { shareLinkService } = deps;
  const router: Router = Router();

  // ── GET /api/share/:token ────────────────────────────────────────
  //
  // Mounted at the app root in the composition root, so the FULL
  // public URL is `/api/share/:token` exactly as documented.
  //
  // ST-029 verbatim acceptance criteria (Rule R1):
  //   AC2 (read side): expired link → documented error
  //                    (404 SHARE_LINK_NOT_FOUND).
  //   AC3: valid unexpired link → SharedDesignView projection
  //        without requiring sign-in (no session middleware in front).
  //   AC4: revoked link → inoperable on subsequent requests
  //        (404 SHARE_LINK_NOT_FOUND, same response as expired).
  //
  // Handler shape:
  //   The Express handler is a sync function returning `void`; it
  //   delegates to the async `runGetShare` worker and forwards
  //   unexpected promise rejections to Express's `next` (which is
  //   wired to the central error middleware). This pattern matches
  //   the auth/cart/orders routes and is required by the workspace's
  //   `@typescript-eslint/no-misused-promises` ESLint rule, which
  //   forbids passing an async function directly to Express's
  //   handler signature.
  //
  // Failure mode: under normal operation `runGetShare` NEVER rejects
  // — it converts every documented failure into a structured response
  // via `handleRouteError`. The `.catch(next)` is purely defensive,
  // ensuring Rule R8 (fail-closed) holds even if a future refactor
  // introduces a code path that accidentally lets a promise reject
  // unhandled.
  router.get(
    '/api/share/:token',
    (req: Request, res: Response, next: NextFunction): void => {
      void runGetShare(shareLinkService, req, res, next).catch((err: unknown) => {
        // Unexpected rejection — forward to Express's central error
        // chain. Inside `runGetShare` every documented failure path
        // produces a fulfilled promise and a non-2xx response; this
        // catch is reachable only on unforeseen runtime errors (e.g.
        // a future test mock that throws synchronously inside an
        // async function or a logger spy that throws during error
        // translation).
        next(err);
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Section 4: Async worker — separates the await chain from the sync handler
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
 * Execute the GET /api/share/:token request flow.
 *
 * Steps:
 *   1. Read `req.params.token`. If empty/whitespace-only, respond 400
 *      with `VALIDATION_TOKEN_MISSING` (defense-in-depth — Express's
 *      `:token` matcher would not normally bind to an empty path
 *      segment, but `/api/share/%20` and similar edge cases reach
 *      this branch).
 *   2. Invoke `shareLinkService.getByToken({ token })`. The service
 *      contract guarantees a tri-valued return:
 *        - `SharedDesignView` on a valid, unexpired, unrevoked link
 *          whose underlying design exists.
 *        - `null` for any of: unknown token, revoked, expired, orphan.
 *        - thrown error for: empty token (ValidationError — defensive),
 *          repository / pg failures (any other class).
 *   3. On `null`: respond 404 with the unified `SHARE_LINK_NOT_FOUND`
 *      envelope. Operator visibility into WHICH null condition fired
 *      lives in the service's structured logs (`share_link.get.revoked`
 *      etc.) — see service file §6 "Information-disclosure posture".
 *   4. On `SharedDesignView`: respond 200 with the projection. Express's
 *      `res.json(view)` serialises `Date` fields to ISO-8601 automatically
 *      via JSON.stringify's default Date.toJSON behaviour, so the
 *      client receives `lastModifiedAt` as a string.
 *   5. On thrown error: delegate to {@link handleRouteError} which
 *      produces a structured non-2xx response (Rule R8 fail-closed).
 *
 * The function therefore returns a fulfilled promise on every
 * documented path; rejections only occur for unforeseen runtime
 * conditions (e.g. mock-injected throws in test fixtures or a logger
 * spy that throws during error translation).
 *
 * @param shareLinkService The injected service; consumed solely via
 *   its `getByToken` method.
 * @param req Express request (read: `req.params.token`, `req.log`).
 *   The route NEVER reads `req.uid`, `req.headers.authorization`, or
 *   `req.body` — this is an unauthenticated endpoint with no body.
 * @param res Express response (write: status + JSON body).
 * @param next Express next callback (forwarded to {@link handleRouteError}
 *   for signature parity; not invoked under any documented path).
 */
async function runGetShare(
  shareLinkService: ShareLinkService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Step 1: extract and pre-validate the path parameter.
    //
    // Express provides `req.params.token` as a string for any path
    // segment that matches the `:token` pattern. The route guard's
    // belt-and-braces check covers:
    //   - `typeof token !== 'string'` — should be unreachable per
    //     Express's contract, but defensive against future Express
    //     versions or middlewares that mutate `req.params`.
    //   - `token.trim() === ''` — `/api/share/%20` (URL-encoded
    //     space) decodes to a whitespace-only path segment, which
    //     Express WILL bind to `:token`. Without this check, the
    //     whitespace token would be forwarded to the service, which
    //     would reject it with its own ValidationError — but a
    //     400 here is faster (no service round-trip) and more
    //     descriptive (`VALIDATION_TOKEN_MISSING` vs the generic
    //     service-layer `VALIDATION_FAILED`).
    //
    // Per Rule R2: this branch's response NEVER includes the token
    // value itself. The fixed message string `'Token required'` is
    // deliberately laconic — it does not echo the input, does not
    // describe what a "valid" token looks like, and does not hint
    // at the token's expected format. An attacker submitting a
    // probing request gets back zero useful information.
    const token: unknown = req.params['token'];
    if (typeof token !== 'string' || token.trim() === '') {
      res
        .status(400)
        .json(buildError('VALIDATION_TOKEN_MISSING', 'Token required'));
      return;
    }

    // Step 2: delegate to the service.
    //
    // The service's `getByToken({ token })` performs:
    //   - Input validation (`validateToken`) — throws ValidationError
    //     for empty/non-string. The route's pre-check should have
    //     caught this, but the service is independently safe.
    //   - Repository lookup (`findByToken`) — single SELECT-with-JOIN
    //     against `share_links` JOINed to `designs`. Returns a row
    //     OR null.
    //   - Three validity gates in order: revoked, expired, orphan.
    //     Each gate that trips returns null; each gate also emits a
    //     distinct log event for operator visibility.
    //   - Read-side projection — explicit field-by-field copy that
    //     EXCLUDES `ownerUid`, `token`, `revokedAt`, `expiresAt`,
    //     `createdAt`. The compiler enforces the projection shape;
    //     a future leak would surface as a type error during the
    //     type-check gate.
    //
    // This route forwards the result with NO additional shaping. If
    // the projection ever needs to expand (e.g. add a public-facing
    // expiration label), the change is owned by the service and its
    // SharedDesignView interface — not by this route.
    const view = await shareLinkService.getByToken({ token });

    // Step 3: translate the tri-valued return to HTTP.
    //
    // `null` collapses ALL FOUR underlying conditions (unknown token,
    // revoked, expired, orphan) into the same 404 response. The
    // service's logs (filtered on `event=share_link.get.revoked`
    // etc.) preserve operator visibility into which specific
    // condition fired without leaking that information to the
    // unauthenticated visitor — see file header §"Enumeration
    // defense" for the full rationale.
    if (view === null) {
      res
        .status(404)
        .json(
          buildError('SHARE_LINK_NOT_FOUND', 'Share link not found or expired'),
        );
      return;
    }

    // Step 4: success path. The SharedDesignView shape is enforced by
    // the service's TypeScript signature; we forward it verbatim.
    //
    // Status 200 (NOT 304 Not Modified, NOT 206 Partial Content) —
    // the service contract guarantees a fully-populated projection
    // when the return is non-null, so a 200 with body is the
    // semantically correct outcome.
    //
    // `res.json(view)` serialises Dates via `Date.prototype.toJSON`
    // (which produces ISO-8601 strings); clients consuming this
    // endpoint will receive `lastModifiedAt` as a string. This is
    // the same convention used by `/api/designs` GET — see the
    // designs route for the equivalent handling.
    res.status(200).json(view);
  } catch (err) {
    // Step 5: structured error translation.
    //
    // Every documented failure path inside the try-block produces a
    // fulfilled response BEFORE reaching this catch (the handler
    // returns from each branch). The catch is therefore reached
    // only on:
    //   - Service-layer ValidationError (defensive — the route's
    //     pre-check should normalise empty inputs first, but the
    //     service validates independently).
    //   - Service-layer NotFoundError (currently unused by
    //     `getByToken` — the service uses null returns — but the
    //     translator handles it for forward-compatibility).
    //   - Repository / pg errors (PG_CONNECTION_FAIL, query timeout,
    //     etc.) — translated to 500 INTERNAL_ERROR by the
    //     translator's fall-through branch.
    //   - Any other thrown class.
    //
    // The translator NEVER lets an exception escape this function
    // unhandled — its own internal logger call is wrapped in a
    // graceful-degradation pattern (see {@link handleRouteError}).
    handleRouteError(err, req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Section 5: Error translator
// ---------------------------------------------------------------------------
//
// Translates a thrown error from the service layer into a structured
// HTTP error response. Mirrors the shape of `handleRouteError` in
// `cart.ts` and `handleAuthError` in `auth.ts` for stylistic
// consistency across route files.
//
// Translation rules:
//
//   - ValidationError (`name === 'ValidationError'`)
//       → 400 with the original `code` (e.g. 'VALIDATION_TOKEN_MISSING')
//         and the original `message`. Defensive: the route's pre-check
//         normalises empty tokens before the service is called; this
//         branch handles edge cases where the service receives a
//         token the route's pre-check accepted but the service
//         rejects (e.g. a future stricter token format check).
//
//   - NotFoundError (`name === 'NotFoundError'`)
//       → 404 with the original `code` (defaulting to 'NOT_FOUND' if
//         absent) and the original `message`. Currently unused by
//         `getByToken` (which returns null for not-found cases), but
//         the translator handles it so a future service refactor that
//         throws NotFoundError would not regress to a 500.
//
//   - Anything else
//       → 500 INTERNAL_ERROR. Logged via `req.log.error` with bounded,
//         structural metadata only (no stack, no cause, no echoed
//         body). Per Rule R2 the log NEVER includes the token; the
//         `errorMessage` is truncated to 200 characters as a
//         secondary defense against pathological error.message
//         payloads.
//
// Per Rule R8 (fail-closed): every code path produces a non-2xx
// response. There is NO branch that returns 200 while the operation
// failed.
//
// Information-disclosure posture for unauthenticated visitors:
//   - The 500 response body is the fixed string 'Internal server
//     error' — never the original message, never the stack, never
//     the cause. This is STRICTER than the auth/cart/orders routes,
//     which expose more detail to authenticated users.
//   - The 400 response forwards the service's ValidationError
//     message because the service's messages are static, well-
//     reviewed strings (e.g. "token is required") that don't echo
//     user input.
//   - The 404 response is fixed to "Share link not found or expired"
//     — never distinguishes between "we don't have a row for this
//     token" and "we have a row but it's revoked/expired/orphan".
//     See file header §"Enumeration defense" for rationale.
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
 *   the central error handler without changing call sites. The leading
 *   underscore conforms to the workspace's
 *   `@typescript-eslint/no-unused-vars` rule
 *   `argsIgnorePattern: '^_'`.
 */
function handleRouteError(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Defensive structural extraction — each access uses optional
  // chaining and a type narrowing so a malformed throw value (e.g.
  // `throw 42`, `throw null`, `throw "oops"`) does not itself raise
  // and crash the response. The same pattern is used in `cart.ts`
  // and `auth.ts`.
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

  // ── 400 VALIDATION_FAILED ────────────────────────────────────────
  // Service-layer ValidationError. The route's pre-check should have
  // caught empty inputs before reaching the service; this branch is
  // defense-in-depth against:
  //   (a) future service-layer validators that enforce stricter
  //       token format rules than the route's pre-check.
  //   (b) the case where the route's pre-check is bypassed (which
  //       cannot happen given the current code, but a future
  //       refactor might introduce alternate paths).
  // The service's ValidationError carries a fixed `code` (e.g.
  // `'VALIDATION_TOKEN_MISSING'`) and a static `message`; we forward
  // both. The `??` fallbacks defend against partial error objects
  // (no `code`, no `message`).
  if (name === 'ValidationError') {
    res
      .status(400)
      .json(buildError(code ?? 'VALIDATION_FAILED', message ?? 'Invalid input'));
    return;
  }

  // ── 404 NOT_FOUND ────────────────────────────────────────────────
  // Service-layer NotFoundError. Currently unused by `getByToken`
  // (the service uses null returns for not-found cases), but the
  // translator handles it so a future service refactor that throws
  // NotFoundError would not regress to a 500. The `??` fallbacks
  // defend against partial error objects.
  if (name === 'NotFoundError') {
    res
      .status(404)
      .json(buildError(code ?? 'NOT_FOUND', message ?? 'Resource not found'));
    return;
  }

  // ── 500 INTERNAL_ERROR ───────────────────────────────────────────
  // Unrecognised error class. Log a single bounded ERROR record via
  // the request-scoped pino logger (configured with the serializer
  // allow-list in `../logging/pino.ts` to redact any accidental
  // credential leakage), then return a non-leaking 500.
  //
  // The log record contains:
  //   - `event`        — fixed identifier `'share.route.error'` for
  //                      log-pipeline filtering and dashboard panels.
  //   - `errorName`    — the JS error class name.
  //   - `errorCode`    — the `code` field if present.
  //   - `errorMessage` — the error's message TRUNCATED to 200
  //                      characters. We never include `.stack` or
  //                      `.cause` (those expose call-site detail
  //                      that aids attackers).
  //
  // Per Rule R2 this log call NEVER includes:
  //   - The raw `:token` path parameter (which IS the credential
  //     for this endpoint — it grants read access to a design).
  //   - The Authorization header value (not read by this file —
  //     this is an unauthenticated endpoint).
  //   - Any credential variable.
  //
  // The structural cast to `Request & { log?: ... }` mirrors the
  // pattern in `cart.ts` and `auth.ts` and is necessary because
  // `pino-http` attaches `req.log` at runtime but does not expose a
  // global type augmentation for it. The cast is local — it does
  // not pollute the rest of the type system.
  //
  // Graceful degradation: if `req.log` is absent (e.g. unit tests
  // that do not install pino-http, early bootstrap before middleware
  // mounts), the log call is silently skipped. The 500 response is
  // still produced — Rule R8 is preserved.
  const reqWithLog = req as Request & {
    log?: { error: (obj: unknown, msg?: string) => void };
  };
  const log = reqWithLog.log;
  if (log !== undefined) {
    log.error(
      {
        event: 'share.route.error',
        errorName: name,
        errorCode: code,
        errorMessage:
          typeof message === 'string' ? message.slice(0, 200) : undefined,
      },
      'share route error',
    );
  }

  res.status(500).json(buildError('INTERNAL_ERROR', 'Internal server error'));
}
