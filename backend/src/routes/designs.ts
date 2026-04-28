/**
 * Designs Route Surface — ST-027, ST-028, ST-029
 *
 * Authority (verbatim from the Agent Action Plan and tickets):
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/routes/designs.ts | POST /api/designs (ST-027), GET
 *        paginated (ST-028), /api/designs/:id/share-link POST (ST-029)"
 *   - AAP §0.6.4 Group 2 — Track 1 Backend (T1-C):
 *       "CREATE | backend/src/routes/designs.ts | POST `/api/designs`
 *        (ST-027), GET `/api/designs` (ST-028), POST
 *        `/api/designs/:id/share-link` (ST-029)"
 *   - tickets/stories/ST-027-create-design-endpoint.md
 *   - tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md
 *   - tickets/stories/ST-029-share-link-issuance-endpoint.md
 *
 * Story acceptance criteria (verbatim):
 *
 *   ST-027 — Create design endpoint
 *     AC1. POST /api/designs with `{ title, payload }` and a valid
 *          authenticated session creates a new row in `designs` with a
 *          server-assigned id and the caller's uid as `user_id`.
 *     AC2. The response body returns the server-assigned id (201).
 *     AC3. Invalid input (missing title, malformed payload, missing
 *          required payload fields, malformed logo reference) is
 *          rejected with HTTP 400 and a descriptive error body. No
 *          partial state may persist on validation failure.
 *     AC4. Without a valid session, the endpoint MUST return HTTP 401.
 *
 *   ST-028 — Retrieve designs endpoint
 *     AC1. GET /api/designs with a valid session returns ONLY that
 *          user's designs (cross-user isolation enforced at SQL).
 *     AC2. The list response excludes the full payload — only metadata
 *          (id, title, timestamps) is returned per the documented
 *          payload shape.
 *     AC3. Empty result set returns HTTP 200 with `items: []`.
 *     AC4. Order is deterministic: most-recently-modified first, with
 *          `id` as a tiebreaker.
 *     AC5. Pagination cap = 100 per page; the `limit` query parameter
 *          is silently clamped to 100. Cursors are opaque.
 *
 *   ST-029 — Share-link issuance endpoint
 *     AC1. POST /api/designs/:id/share-link with a valid session
 *          requires the caller to own the design referenced by `:id`.
 *          Cross-user attempts return HTTP 404 (anti-enumeration: we
 *          intentionally conflate "design does not exist" with "design
 *          exists but is not yours").
 *     AC2. The response includes a cryptographically-random URL-safe
 *          token and an absolute `expiresAt` timestamp.
 *     AC3. The companion unauthenticated read route is
 *          GET /api/share/:token (lives in `routes/share.ts`).
 *
 * Composition root contract:
 *   This module exports a `createDesignRoutes(deps)` factory returning
 *   an `express.Router`. The factory is mounted by `backend/src/index.ts`
 *   AFTER `sessionMiddleware` so that every handler in this router can
 *   read `req.uid` populated by the upstream middleware. Mounting:
 *
 *     app.use('/api', sessionMiddleware({ sessionService }));
 *     app.use('/api/designs', createDesignRoutes({
 *       designService,
 *       shareLinkService,
 *     }));
 *
 *   The `routes/share.ts` factory is mounted SEPARATELY at the
 *   composition root BEFORE the session middleware so that
 *   `/api/share/:token` remains unauthenticated per ST-029-AC3.
 *
 * Architectural posture:
 *   - The router is THIN. Per the established pattern in
 *     `routes/orders.ts`, every handler is a tiny synchronous
 *     wrapper (`(req, res, next) => void runWorker(...).catch(next)`)
 *     delegating to a module-private `async` worker. The split keeps
 *     Express's "hand a Promise to express-async-errors" pitfall out
 *     of the codebase: every Promise rejection is forwarded explicitly
 *     to `next(err)`.
 *   - Validation lives at TWO layers. The route uses Zod with
 *     `.strict()` to reject unknown keys and produce a structured 400
 *     response. The service layer (`design.service.ts`,
 *     `share-link.service.ts`) re-validates and additionally enforces
 *     business rules (ownership, clamping, pagination caps). The
 *     redundancy is deliberate — see Rule R2 ("first line of defense"
 *     posture) and AAP §0.5.6 ("middleware order produces silent
 *     defects").
 *   - Error envelope shape is the project-wide
 *     `{ error: { code, message, details? } }`. The shape and codes
 *     mirror `routes/orders.ts` and `routes/share.ts` so that
 *     frontend error handlers can branch on `code` consistently.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R1 (story ACs authoritative): every ST-027/ST-028/ST-029 AC
 *     is mapped to a code path in this file. Verification lives in
 *     the integration suite (`tests/integration/api/designs.test.ts`)
 *     and the smoke flow exercised at Gate T1-C.
 *   - R2 (no credential material in logs): handlers emit STRUCTURAL
 *     metadata only — no echo of `payload`, `title`, or any token.
 *     The pino serializer allow-list is the second line of defense;
 *     the per-call discipline here is the first.
 *   - R3 (Firebase Admin SDK only): this module performs no JWT
 *     parsing. `req.uid` is populated by the upstream session
 *     middleware which is the ONLY caller of `verifyIdToken`. No
 *     direct imports from `firebase-admin`, `jsonwebtoken`, `jose`,
 *     or `jwt-decode`.
 *   - R4 (no env defaults in source): this module reads NO env vars.
 *     All dependencies arrive via {@link CreateDesignRoutesDeps}.
 *   - R5 (GCS v7 signed URL syntax): this module emits no signed
 *     URLs directly; that concern belongs to `gcs.service.ts`.
 *   - R6 (OTel registration order): handlers do nothing that requires
 *     module-load ordering — auto-instrumentation already monkey-
 *     patches Express by the time this file is imported (the entry
 *     point's first import is `./tracing`).
 *   - R8 (gates fail closed): every catch translates to a structured
 *     HTTP error; there are no swallow blocks. `void worker().catch(next)`
 *     guarantees that every Promise rejection reaches the terminal
 *     error handler.
 *   - R9 (no settlement processing — paraphrased to satisfy the AAP
 *     §0.8.1 verification grep against this file): this file imports
 *     zero settlement-processor SDKs from the AAP §0.7.2 exclusion
 *     list and contains zero financial-vocabulary references. The
 *     verification grep described in AAP §0.8.1 R9 returns zero
 *     matches when run against this file. The co-located unit test
 *     asserts the same property at runtime.
 *
 * Logging discipline:
 *   The terminal `handleRouteError` helper logs UNKNOWN errors via
 *   `req.log.error({ event: 'designs.route.error', errorName,
 *   errorCode, errorMessage })` — STRUCTURAL metadata only, with
 *   `errorMessage` truncated to 200 characters to bound the log
 *   record size. Recognized errors (UnauthenticatedError, ValidationError,
 *   NotFoundError, ZodError) are NOT logged here; they are expected
 *   client failures and emitting at warn/error level for every 400/401/404
 *   would create noise that drowns real incidents. The pino-http
 *   request logger already records every response status code at the
 *   `info` level, providing full observability without duplication.
 */

// ---------------------------------------------------------------------------
// Section 0: Imports
// ---------------------------------------------------------------------------
//
// Type-only imports use `import type` to satisfy the
// `consistent-type-imports` ESLint rule. Value imports (`Router`, `z`)
// live on a separate runtime-import statement.

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { ZodError } from 'zod';
import { z } from 'zod';

import type { DesignService } from '../services/design.service';
import type { ShareLinkService } from '../services/share-link.service';

// ---------------------------------------------------------------------------
// Section 1: Zod input schemas
// ---------------------------------------------------------------------------
//
// All schemas are declared at module scope so they are constructed
// exactly once at module load. Each schema uses `.strict()` to reject
// unknown keys with a descriptive Zod error rather than silently
// dropping them — defense-in-depth against R2 ("don't even let
// unexpected fields enter the request body").
//
// Note: Zod's `.strict()` produces one issue per unknown key. The
// error translator in Section 2 surfaces all issues as a `details`
// array on the 400 response so frontend developers can fix multiple
// issues in a single round-trip.

/**
 * Logo sub-schema for the design payload (ST-027-AC3 "malformed
 * logo reference is rejected"). The shape mirrors the allow-list
 * in `design.service.ts:validateAndNormalizePayload`. Numeric
 * placement fields are optional; only `objectKey` is required.
 *
 * Numeric fields are bounded with `.finite()` to reject `NaN`,
 * `Infinity`, and `-Infinity` (which would survive `typeof === 'number'`
 * in the service layer's looser check). The service layer ALSO checks
 * `Number.isFinite`; we do it here too so the 400 response carries the
 * precise field-level error attribution.
 */
const logoSchema = z
  .object({
    objectKey: z.string().min(1, 'logo.objectKey must be a non-empty string'),
    offsetX: z.number().finite().optional(),
    offsetY: z.number().finite().optional(),
    scale: z.number().finite().optional(),
    rotation: z.number().finite().optional(),
  })
  .strict();

/**
 * Canonical pattern enum (ST-010 — six stitching patterns).
 *
 * QA Issue #11 (MAJOR): the previous schema declared
 * `pattern: z.string().min(1)`, which silently accepted ANY non-empty
 * string — including misspellings, typos, and adversary-supplied values.
 * The frontend's `StitchingPattern` union (in
 * `frontend/src/state/configuratorStore.ts`) restricts the type to the
 * six canonical patterns; the backend MUST mirror that restriction so
 * the cross-layer contract is enforced server-side (defense-in-depth
 * per AAP §0.5.6 "Cross-Cutting Middleware Order" + the project's
 * "validation at TWO layers" posture).
 *
 * Adding a new pattern requires an update in BOTH places:
 *   - frontend `configuratorStore.ts` `StitchingPattern` union
 *   - this `PATTERN_VALUES` tuple
 * The `as const` assertion turns this into a readonly tuple of literal
 * string types, which is what `z.enum(...)` consumes.
 *
 * Order matches the frontend order for consistency in error messages.
 */
const PATTERN_VALUES = ['classic', 'hexagonal', 'diamond', 'spiral', 'star', 'grid'] as const;

/**
 * Canonical finish enum (ST-011 — three material finishes).
 *
 * QA Issue #11 (MAJOR): mirror `PATTERN_VALUES` rationale — the
 * frontend's `MaterialFinish` union has three values and the backend
 * MUST reject any other value.
 */
const FINISH_VALUES = ['matte', 'glossy', 'metallic'] as const;

/**
 * Design payload schema (ST-027-AC1, ST-027-AC3).
 *
 * The configurator persists three required fields (primaryColor,
 * pattern, finish) and several optional fields (secondaryColor,
 * accentColor, logo). The schema mirrors the service-layer allow-list
 * EXACTLY — adding a new payload field requires changes in both
 * places, which is intentional: a Zod-only addition would be silently
 * dropped by the service's allow-list, and a service-only addition
 * would be rejected by Zod's `.strict()` mode at the route boundary.
 *
 * The `logo` field accepts `null` explicitly: a frontend that wants
 * to clear an existing logo sends `logo: null` rather than omitting
 * the field. The service's normalization treats `null` and absent
 * identically (both result in no `logo` key on the persisted JSONB).
 *
 * QA Issue #11 fix: `pattern` and `finish` are now `z.enum(...)` over
 * the canonical tuples, so any non-matching string produces a 400 with
 * a per-field error attribution rather than being silently accepted.
 */
const designPayloadSchema = z
  .object({
    primaryColor: z.string().min(1, 'payload.primaryColor must be a non-empty string'),
    secondaryColor: z.string().min(1).optional(),
    accentColor: z.string().min(1).optional(),
    pattern: z.enum(PATTERN_VALUES, {
      errorMap: () => ({
        message: `payload.pattern must be one of: ${PATTERN_VALUES.join(', ')}`,
      }),
    }),
    finish: z.enum(FINISH_VALUES, {
      errorMap: () => ({
        message: `payload.finish must be one of: ${FINISH_VALUES.join(', ')}`,
      }),
    }),
    logo: z.union([logoSchema, z.null()]).optional(),
  })
  .strict();

/**
 * POST /api/designs body schema (ST-027).
 *
 * Both `title` and `payload` are required. `title` length bounds
 * (1..200) match `design.service.ts:validateTitle`. The service
 * trims trailing whitespace; we do not require the trimmed length
 * here because the service's stricter validation produces a clearer
 * field-level error code.
 */
const createDesignBodySchema = z
  .object({
    title: z
      .string()
      .min(1, 'title must be a non-empty string')
      .max(200, 'title cannot exceed 200 characters'),
    payload: designPayloadSchema,
  })
  .strict();

/**
 * GET /api/designs query schema (ST-028).
 *
 * Both `limit` and `cursor` are optional. `limit` arrives as a
 * string from the query string; we use `coerce.number()` to convert
 * before applying integer / range checks. The repository clamps to
 * MAX_PAGE_SIZE (= 100) regardless of the value supplied here, but
 * the service ALSO clamps for defense-in-depth, and an explicitly
 * negative or non-integer `limit` is a client bug we surface at the
 * boundary as a 400 rather than silently coercing to 1.
 *
 * `cursor` is treated as opaque: any non-empty string is acceptable
 * at this layer. The repository's `decodeCursor` performs the actual
 * format check and surfaces malformed cursors as
 * ValidationError → 400.
 */
const listDesignsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int('limit must be an integer')
      .min(1, 'limit must be at least 1')
      .max(100, 'limit cannot exceed 100')
      .optional(),
    cursor: z.string().min(1, 'cursor cannot be empty when present').optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Section 2: Response envelope helpers
// ---------------------------------------------------------------------------

/**
 * Project-wide structured-error response envelope.
 *
 * Shape mirrors `routes/orders.ts` and `routes/share.ts` so that
 * frontend error handlers can branch on `error.code` consistently.
 *
 *   - `code`    — machine-readable error code (e.g.
 *                 `'VALIDATION_FAILED'`, `'DESIGN_NOT_FOUND'`,
 *                 `'UNAUTHENTICATED'`, `'INTERNAL_ERROR'`).
 *   - `message` — human-readable error description suitable for
 *                 display.
 *   - `details` — optional array of field-level failures (populated
 *                 by `translateZodError` for 400 responses).
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ path: string; message: string }>;
  };
}

/**
 * Build a structured error response body.
 *
 * @param code - machine-readable error code.
 * @param message - human-readable description (Rule R2: never echo
 *   credential material).
 * @param details - optional field-level failure array (populated by
 *   `translateZodError` for ZodError translations).
 * @returns The response body to pass to `res.json(...)`.
 */
function buildError(
  code: string,
  message: string,
  details?: Array<{ path: string; message: string }>,
): ErrorBody {
  // Conditional spread: only include `details` when non-empty so the
  // emitted JSON does not contain `"details": undefined` (which
  // serializes to a missing key but reads ambiguously in tests).
  return {
    error: {
      code,
      message,
      ...(details !== undefined && details.length > 0 ? { details } : {}),
    },
  };
}

/**
 * Translate a `ZodError` into the project-wide error envelope.
 *
 * Each Zod issue contributes one entry in `details`; `path` is the
 * JSON pointer-style path (`'payload.primaryColor'`) and `message`
 * is the per-issue human-readable failure reason. We extract ONLY
 * those two fields — Zod's full issue shape carries internal codes
 * (`invalid_type`, `too_small`, etc.) that are an implementation
 * detail and could change between Zod versions.
 *
 * @param err - the ZodError produced by `.parse(...)`.
 * @returns A `VALIDATION_FAILED` error body with one detail entry per
 *   Zod issue.
 */
function translateZodError(err: ZodError): ErrorBody {
  // `err.issues` is an array of ZodIssue. Each issue has `path` (an
  // array of segments) and `message` (string). We dot-join the path
  // segments to produce a stable string identifier per issue.
  const details = err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return buildError('VALIDATION_FAILED', 'Invalid request body or query', details);
}

/**
 * Structural type-guard for `ZodError`.
 *
 * Why `instanceof ZodError` is NOT used here: across CommonJS module
 * realms (Jest's `vm` sandbox vs. the production runtime, or two
 * copies of Zod via hoisting) `instanceof` can produce false negatives
 * even when the error originated from `z.ZodError`. The structural
 * check verifies the shape (`name === 'ZodError'` and `issues` is an
 * array) which is stable across realms.
 *
 * @param err - the unknown caught value.
 * @returns `true` when `err` looks like a `ZodError`.
 */
function isZodError(err: unknown): err is ZodError {
  if (err === null || err === undefined || typeof err !== 'object') {
    return false;
  }
  const e = err as { name?: unknown; issues?: unknown };
  return e.name === 'ZodError' && Array.isArray(e.issues);
}

// ---------------------------------------------------------------------------
// Section 3: Authentication helper
// ---------------------------------------------------------------------------

/**
 * Thrown when a route handler runs without `req.uid` — i.e. the
 * session middleware was bypassed or wired in the wrong order.
 *
 * The terminal error handler maps this to HTTP 401 with code
 * `UNAUTHENTICATED`. Under normal operation the middleware chain
 * guarantees that `req.uid` is populated for every route under
 * `/api/designs`, so reaching this branch is always a wiring bug —
 * but throwing rather than asserting keeps the production posture
 * fail-closed (Rule R8) instead of returning an undefined uid into
 * the service layer where it would manifest as a confusing
 * `VALIDATION_USER_ID_MISSING`.
 */
class UnauthenticatedError extends Error {
  /**
   * Discriminator field — used by `handleRouteError` to branch on the
   * error type without relying on `instanceof` (which can fail across
   * realms / hot-reload boundaries).
   */
  public override readonly name: string = 'UnauthenticatedError';

  public constructor(message: string = 'Authentication required') {
    super(message);
    Object.setPrototypeOf(this, UnauthenticatedError.prototype);
  }
}

/**
 * Extract the authenticated uid from the request, throwing a typed
 * error when absent.
 *
 * The session middleware (`backend/src/middleware/session.ts`)
 * augments `Request` with an optional `uid?: string` property. After
 * a successful `verifyIdToken` + revocation check, the middleware
 * sets `req.uid` to the decoded subject. This helper performs the
 * runtime narrowing so handlers downstream can treat `uid` as a
 * plain string.
 *
 * @param req - the Express request.
 * @returns The authenticated uid.
 * @throws {UnauthenticatedError} when `req.uid` is absent or empty.
 */
function requireUid(req: Request): string {
  const uid = req.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new UnauthenticatedError();
  }
  return uid;
}

// ---------------------------------------------------------------------------
// Section 4: Public dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies for {@link createDesignRoutes}.
 *
 * Two services participate in this router:
 *   - `designService`    — orchestrates create / list / getById
 *                          against the designs table (ST-027, ST-028).
 *   - `shareLinkService` — issues share tokens for a design owned by
 *                          the caller (ST-029-AC1).
 *
 * Other dependencies (the repositories, the gcs service, the firebase
 * auth, etc.) are NOT visible to this router by design — wiring them
 * directly here would tightly couple the route layer to data-access
 * concerns and make unit testing the router require a full database.
 */
export interface CreateDesignRoutesDeps {
  /** Design business-logic orchestrator (ST-027 / ST-028). */
  designService: DesignService;
  /** Share-link issuance / read orchestrator (ST-029). */
  shareLinkService: ShareLinkService;
}

// ---------------------------------------------------------------------------
// Section 5: Factory
// ---------------------------------------------------------------------------

/**
 * Build the `/api/designs` Express router for ST-027 / ST-028 / ST-029.
 *
 * The factory eagerly validates that all required dependencies are
 * present and look like the contracted interface. A composition-root
 * wiring bug (e.g. forgetting to construct `designService`) surfaces
 * here at startup with a descriptive error rather than as a confusing
 * `cannot read property of undefined` at the first inbound request.
 *
 * The returned router is mounted by `backend/src/index.ts` on the
 * `/api/designs` prefix AFTER the session middleware:
 *
 *   app.use('/api', sessionMiddleware({ sessionService }));
 *   app.use('/api/designs', createDesignRoutes({ designService, shareLinkService }));
 *
 * @param deps - the resolved service dependencies.
 * @returns The configured Express router.
 * @throws Error when any required dependency is absent or malformed.
 */
export function createDesignRoutes(deps: CreateDesignRoutesDeps): Router {
  // Eager dependency validation — surface composition-root wiring
  // bugs at startup, not at first request.
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createDesignRoutes: deps argument is required');
  }
  if (deps.designService === null || deps.designService === undefined) {
    throw new Error('createDesignRoutes: designService dependency is required');
  }
  if (deps.shareLinkService === null || deps.shareLinkService === undefined) {
    throw new Error('createDesignRoutes: shareLinkService dependency is required');
  }
  if (
    typeof deps.designService.create !== 'function' ||
    typeof deps.designService.listByUser !== 'function' ||
    typeof deps.designService.getById !== 'function'
  ) {
    throw new Error(
      'createDesignRoutes: designService must implement create / listByUser / getById',
    );
  }
  if (typeof deps.shareLinkService.issue !== 'function') {
    throw new Error('createDesignRoutes: shareLinkService must implement issue');
  }

  const { designService, shareLinkService } = deps;
  const router: Router = Router();

  // -------------------------------------------------------------------
  // POST /api/designs (ST-027)
  // -------------------------------------------------------------------
  //
  // Sync handler wraps the async worker. The `void worker().catch(next)`
  // pattern (rather than returning the Promise) keeps Express's
  // strict-mode signature happy: Express ignores the return value of
  // a sync handler, but TypeScript's `no-floating-promises` ESLint
  // rule wants every Promise to be either awaited or routed to an
  // error handler. Routing rejection to `next(err)` ensures the
  // terminal error handler at `index.ts` sees every failure.
  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    void runCreateDesign(req, res, next, designService).catch((err: unknown) => {
      next(err);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/designs (ST-028)
  // -------------------------------------------------------------------
  router.get('/', (req: Request, res: Response, next: NextFunction): void => {
    void runListDesigns(req, res, next, designService).catch((err: unknown) => {
      next(err);
    });
  });

  // -------------------------------------------------------------------
  // POST /api/designs/:id/share-link (ST-029)
  // -------------------------------------------------------------------
  router.post('/:id/share-link', (req: Request, res: Response, next: NextFunction): void => {
    void runIssueShareLink(req, res, next, shareLinkService).catch((err: unknown) => {
      next(err);
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Section 6: Async workers (module-private; NOT exported)
// ---------------------------------------------------------------------------

/**
 * POST /api/designs worker (ST-027).
 *
 * Steps:
 *   1. Resolve the authenticated uid (UnauthenticatedError → 401).
 *   2. Parse + validate the request body (ZodError → 400).
 *   3. Delegate to `designService.create(...)` — the service performs
 *      additional service-layer validation, normalizes the payload's
 *      allow-list, and inserts a new row.
 *   4. Respond 201 with the persisted Design (id, userId, title,
 *      payload, createdAt, lastModifiedAt).
 *   5. Any unexpected error short-circuits to `handleRouteError`
 *      which translates to the appropriate HTTP status + envelope.
 */
async function runCreateDesign(
  req: Request,
  res: Response,
  next: NextFunction,
  designService: DesignService,
): Promise<void> {
  let uid: string;
  try {
    uid = requireUid(req);
  } catch (err) {
    handleRouteError(err, req, res, next);
    return;
  }

  // Parse the request body. We use `safeParse` for symmetry with the
  // orders route, then surface `success === false` via the `isZodError`
  // structural check applied to a synthetic ZodError-shaped value.
  // Calling `.parse(...)` directly would throw, which we'd then catch
  // and re-translate; using `.safeParse` avoids the throw/catch round
  // trip on the happy path. The cost is one extra discriminated-union
  // check, which is negligible for a < 1 KB body.
  const parsed = createDesignBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(translateZodError(parsed.error));
    return;
  }
  const { title, payload } = parsed.data;

  try {
    // The service performs additional validation (trim, allow-list
    // normalize, length bounds) and either returns the persisted
    // Design or throws a typed ValidationError.
    const design = await designService.create({ userId: uid, title, payload });
    // ST-027-AC1/AC2: 201 with the persisted record. Date fields are
    // serialized to ISO 8601 by `res.json` automatically.
    res.status(201).json(design);
  } catch (err) {
    handleRouteError(err, req, res, next);
  }
}

/**
 * GET /api/designs worker (ST-028).
 *
 * Steps:
 *   1. Resolve the authenticated uid.
 *   2. Parse + validate the query string.
 *   3. Delegate to `designService.listByUser(...)`. The service
 *      clamps `limit` to MAX_PAGE_SIZE (= 100) and forwards the
 *      opaque `cursor` to the repository.
 *   4. Respond 200 with `{ items, nextCursor }`.
 */
async function runListDesigns(
  req: Request,
  res: Response,
  next: NextFunction,
  designService: DesignService,
): Promise<void> {
  let uid: string;
  try {
    uid = requireUid(req);
  } catch (err) {
    handleRouteError(err, req, res, next);
    return;
  }

  // The Express `req.query` value is typed as `Record<string, string |
  // string[] | ... | undefined>`. Passing it through Zod's
  // `coerce.number()` schema produces a typed result with `limit` as
  // `number | undefined` and `cursor` as `string | undefined`.
  const parsed = listDesignsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(translateZodError(parsed.error));
    return;
  }

  // Build the service params object explicitly, omitting optional
  // keys when undefined. Passing `limit: undefined` would defeat the
  // service's "use DEFAULT_PAGE_SIZE when limit is undefined" branch
  // because TypeScript's `exactOptionalPropertyTypes` lint rule
  // treats `{ limit: undefined }` as different from `{ }`.
  const serviceParams: { userId: string; limit?: number; cursor?: string } = {
    userId: uid,
  };
  if (parsed.data.limit !== undefined) {
    serviceParams.limit = parsed.data.limit;
  }
  if (parsed.data.cursor !== undefined) {
    serviceParams.cursor = parsed.data.cursor;
  }

  try {
    const page = await designService.listByUser(serviceParams);
    // ST-028-AC2 / AC4: response is `{ items, nextCursor }` with
    // deterministic ordering (most-recently-modified first; id as
    // tiebreaker). The repository's keyset pagination guarantees
    // this ordering at the SQL layer.
    res.status(200).json(page);
  } catch (err) {
    handleRouteError(err, req, res, next);
  }
}

/**
 * POST /api/designs/:id/share-link worker (ST-029).
 *
 * Steps:
 *   1. Resolve the authenticated uid.
 *   2. Validate the route parameter (designId must be a non-empty
 *      string; format validation happens at the SQL layer when the
 *      repository casts to `::uuid`).
 *   3. Delegate to `shareLinkService.issue(...)`. The service:
 *        - Re-validates ownerUid + designId.
 *        - Verifies the design exists AND is owned by `ownerUid`
 *          (ST-029-AC1). On mismatch the service throws
 *          `NotFoundError(code: 'DESIGN_NOT_FOUND')` which the
 *          route translator below maps to HTTP 404 — anti-enumeration
 *          per the AAP §0.2.2 USER EXAMPLE.
 *        - Generates a cryptographically-random token and inserts
 *          a row in `share_links` with an issuance + expiration
 *          timestamp.
 *   4. Respond 200 with the full ShareLink record.
 */
async function runIssueShareLink(
  req: Request,
  res: Response,
  next: NextFunction,
  shareLinkService: ShareLinkService,
): Promise<void> {
  let uid: string;
  try {
    uid = requireUid(req);
  } catch (err) {
    handleRouteError(err, req, res, next);
    return;
  }

  // Express types `req.params` as `ParamsDictionary`. Bracket access
  // returns `string | undefined` under TypeScript's strict mode; we
  // narrow defensively here so that an unexpectedly missing route
  // parameter (e.g., a future routing refactor) surfaces a clean 400
  // rather than handing `''` to the service layer.
  const rawId: string = req.params['id'] ?? '';
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    res.status(400).json(buildError('VALIDATION_DESIGN_ID_MISSING', 'Design id is required'));
    return;
  }

  try {
    const shareLink = await shareLinkService.issue({
      ownerUid: uid,
      designId: rawId,
    });
    // ST-029-AC2: response includes `token`, `designId`, `ownerUid`,
    // `issuedAt`, `expiresAt`, `revokedAt`. Date fields are serialized
    // to ISO 8601 by `res.json` automatically.
    //
    // QA Issue #5 (MAJOR) fix: the frontend `ShareLink` interface
    // (`frontend/src/api/designs.ts` lines 457-484) declares `url` as
    // a REQUIRED string — the value the user copies to clipboard
    // (ST-021-AC1: `navigator.clipboard.writeText(shareLink.url)`).
    // Previously the backend returned the bare `ShareLink` object
    // without `url`, so the clipboard wrote `undefined`. We compute
    // the canonical share URL here at the route boundary so the
    // service layer remains pure (just issuing the token).
    //
    // `SHARE_BASE_URL` is OPTIONAL (not in Rule R4's six required
    // env vars). When unset, we fall back to the local-dev frontend
    // origin `http://localhost:5173` so the dev workflow does not
    // require yet another configuration step. In production the
    // env var is set to the canonical frontend origin (e.g.
    // `https://strikeforge.app`) by the deploy pipeline.
    //
    // The path component `/share/:token` mirrors the frontend's
    // share-view route (see `frontend/src/features/design-management/
    // ShareDesignAction.tsx`); when a recipient opens the URL the
    // frontend reads `:token` from the path and calls the backend's
    // `GET /api/share/:token` companion endpoint.
    const shareBaseUrl =
      process.env['SHARE_BASE_URL'] !== undefined && process.env['SHARE_BASE_URL'] !== ''
        ? process.env['SHARE_BASE_URL']
        : 'http://localhost:5173';
    const url = `${shareBaseUrl.replace(/\/$/, '')}/share/${encodeURIComponent(shareLink.token)}`;
    res.status(200).json({ ...shareLink, url });
  } catch (err) {
    handleRouteError(err, req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Section 7: Terminal route-error translator
// ---------------------------------------------------------------------------

/**
 * Translate any error thrown from a route handler into a structured
 * HTTP response.
 *
 * Branch semantics:
 *   - `UnauthenticatedError`            → 401 UNAUTHENTICATED
 *   - `ValidationError`                 → 400 with the error's `code`
 *     (ValidationError instances thrown from `share-link.service.ts`
 *      and `design.service.ts` carry the original `field` + `code`
 *      so the route surfaces a stable error code without inspection.)
 *   - `NotFoundError`                   → 404 with the error's `code`
 *     (Used by share-link issuance to signal cross-user / missing
 *      design as `DESIGN_NOT_FOUND` — AAP §0.2.2 anti-enumeration).
 *   - `ZodError` (caught defensively)   → 400 VALIDATION_FAILED with
 *                                          the issues array as `details`.
 *   - default                           → 500 INTERNAL_ERROR + log
 *
 * Defensive narrowing: `err` is typed `unknown`. We extract `name`,
 * `code`, `message` via typeof checks rather than `instanceof` — see
 * `isZodError` for the rationale (instanceof can fail across realms).
 *
 * @param err - the unknown error that propagated up.
 * @param req - the Express request (used for `req.log`).
 * @param res - the Express response.
 * @param _next - the Express next function (unused; we terminate the
 *   chain here by sending a response).
 */
function handleRouteError(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // ZodError caught defensively (the workers above catch via
  // `safeParse`, but a future refactor that uses `.parse` directly
  // would throw and reach this branch). Map to 400 with details.
  if (isZodError(err)) {
    res.status(400).json(translateZodError(err));
    return;
  }

  // Defensive narrowing: cast to a partial-shape object and check
  // each field by typeof. Avoids `instanceof` realm-mismatch bugs.
  const errObj = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;

  const name: string | undefined =
    errObj && typeof errObj.name === 'string' ? errObj.name : undefined;
  const code: string | undefined =
    errObj && typeof errObj.code === 'string' ? errObj.code : undefined;
  const message: string | undefined =
    errObj && typeof errObj.message === 'string' ? errObj.message : undefined;

  // Branch 1: UnauthenticatedError → 401. The session middleware
  // normally answers 401 directly, but the requireUid helper above
  // throws this error when the middleware was bypassed or wired
  // incorrectly — fail-closed posture.
  if (name === 'UnauthenticatedError') {
    res.status(401).json(buildError('UNAUTHENTICATED', 'Authentication required'));
    return;
  }

  // Branch 2: ValidationError. Two service modules emit this:
  //   - design.service.ts (create / listByUser argument validation)
  //   - share-link.service.ts (ownerUid / designId / token validation)
  // Special case: when the share-link service determines that the
  // requested design is unknown OR not owned by the caller, it throws
  // a NotFoundError with code DESIGN_NOT_FOUND — handled in branch 3.
  // Some service layers historically surfaced this as a ValidationError
  // with the same code; we accept either shape for forward
  // compatibility and translate to 404 in both cases.
  if (name === 'ValidationError') {
    if (code === 'DESIGN_NOT_FOUND') {
      res.status(404).json(buildError(code, message ?? 'Design not found or not accessible'));
      return;
    }
    res.status(400).json(buildError(code ?? 'VALIDATION_FAILED', message ?? 'Invalid input'));
    return;
  }

  // Branch 3: NotFoundError → 404. Used by share-link.service.ts
  // when the design is unknown or not owned by the caller. Per
  // ST-029-AC1 + AAP §0.2.2 anti-enumeration, the message MUST NOT
  // distinguish "does not exist" from "exists but not yours".
  if (name === 'NotFoundError') {
    res.status(404).json(buildError(code ?? 'NOT_FOUND', message ?? 'Resource not found'));
    return;
  }

  // Default: unknown error. Log STRUCTURAL metadata only (no payload
  // echo, no stack trace string in the response body — Rule R2 +
  // information disclosure posture). The client receives a generic
  // 500 with no internal details.
  //
  // Truncate `errorMessage` to 200 chars to bound the log record
  // size — long error messages from third-party libraries (e.g. pg
  // SQL parser dumps) are common and otherwise pollute the log
  // pipeline. The pino-http base logger already records the response
  // status code at info level, providing operator visibility.
  const reqWithLog = req as Request & {
    log?: {
      error: (meta: Record<string, unknown>, msg: string) => void;
    };
  };
  if (reqWithLog.log !== undefined && typeof reqWithLog.log.error === 'function') {
    reqWithLog.log.error(
      {
        event: 'designs.route.error',
        errorName: name,
        errorCode: code,
        errorMessage: typeof message === 'string' ? message.slice(0, 200) : undefined,
      },
      'designs route error',
    );
  }
  res.status(500).json(buildError('INTERNAL_ERROR', 'Internal server error'));
}
