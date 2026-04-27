/**
 * Share Link Business-Logic Orchestrator — ST-029.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/services/share-link.service.ts | Time-limited share
 *        token generation + validation (ST-029)"
 *   - §0.6.4 Track 1 Backend API (T1-C):
 *       "CREATE | backend/src/services/share-link.service.ts |
 *        Time-limited token generation + validation per ST-029"
 *   - Story ST-029 Acceptance Criteria (verbatim):
 *       AC1: The share-link endpoint requires a valid session and issues a
 *            share link only for a design owned by the authenticated user.
 *       AC2: Each issued share link carries a documented expiration and
 *            points to exactly one design; expired links are rejected by
 *            the read side with a documented error.
 *       AC3: Visiting a valid, unexpired share link returns enough
 *            information for the configurator to render the target design
 *            read-only without requiring the visitor to sign in.
 *       AC4: Revoking a share link (by the owner or by expiration) renders
 *            the link inoperable on subsequent requests and does not affect
 *            the underlying design record.
 *
 * Responsibilities:
 *   1. Ownership verification: only issue a share link for a design owned by
 *      the authenticated user (ST-029-AC1). Consult the design repository
 *      BEFORE calling the share-link repository — ownership is the gate
 *      for any mutation, and the repository layer is intentionally
 *      ownership-blind for the `insert` path (it trusts the service).
 *   2. Token generation: use `crypto.randomBytes(32).toString('base64url')`
 *      — 256 bits of entropy, URL-safe encoding, ~43 chars without padding.
 *      Forbidden alternatives (and why):
 *        - sequential counters: enumerable; one leak compromises every link
 *        - UUID v1: timestamp-exposing; lets attackers narrow the search
 *          space by issuance time
 *        - hash of design id: deterministic; an attacker who guesses a
 *          design id can compute every share link the system has ever
 *          issued for that design
 *   3. Expiration window: server-computed as `now() + SHARE_LINK_TTL_MS`.
 *      The client MUST NOT be able to set the expiration — accepting a
 *      caller-supplied `expiresAt` would let a malicious client mint
 *      effectively-immortal links.
 *   4. Read-side validation: on `getByToken()`, reject links with
 *      `expiresAt <= now()` or `revokedAt !== null` by returning `null` —
 *      the route layer translates `null` into HTTP 404 (Not Found) or 410
 *      (Gone) as appropriate. Returning `null` (rather than throwing) is
 *      the documented signal for "no document to render".
 *   5. Revocation: delegate to the repository; idempotent (revoking zero
 *      active links is not an error — the repository's
 *      `WHERE revoked_at IS NULL` predicate ensures audit-correct first-
 *      revocation timestamps and safe retry semantics).
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs):
 *       The raw `token` is NEVER logged. Every `logger.*` call in this file
 *       includes only structural metadata (`event`, `uid`, `designId`,
 *       `expiresAt`/`revokedAt` ISO strings, `revokedCount`). The pino
 *       serializer allow-list in `logging/pino.ts` provides defense in
 *       depth, but this service's discipline is "do not put the token in
 *       front of the serializer in the first place."
 *   - R3 (Firebase Admin SDK only):
 *       This module imports nothing from `jsonwebtoken`, `jose`, or
 *       `jwt-decode`. Token generation uses Node's standard-library
 *       `crypto.randomBytes` only.
 *   - R4 (no env defaults in source):
 *       This module reads ZERO environment variables. The TTL is a
 *       compile-time constant; the route layer is the boundary at which
 *       env-driven configuration enters.
 *   - R8 (gates fail closed):
 *       Repository errors propagate (no try/catch swallowing). A failed
 *       INSERT raises a thrown error rather than producing a silent
 *       success.
 *   - R9 (no payment processing):
 *       This service has no financial logic. Share-link issuance is purely
 *       a permissions / read-access mechanism.
 *
 * Coordination (consumed by):
 *   - `backend/src/routes/designs.ts`:
 *       POST /api/designs/:id/share-link  -> service.issue(...)
 *       DELETE /api/designs/:id/share-link -> service.revoke(...)  (future)
 *   - `backend/src/routes/share.ts`:
 *       GET /api/share/:token (UNAUTHENTICATED) -> service.getByToken(...)
 *
 * Error translation contract for the route layer:
 *   ValidationError  -> HTTP 400 with { error: { code, message, field } }
 *   NotFoundError    -> HTTP 404 with { error: { code, message } }
 *   null from getByToken -> HTTP 404 (no row found) or 410 Gone
 *                          (expired/revoked) — the route decides based on
 *                          its own observability needs
 *   any other throw  -> HTTP 500 (general error handler)
 */

// ---------------------------------------------------------------------------
// Section 0: Imports
// ---------------------------------------------------------------------------
//
// Convention: Node built-ins -> relative type-only -> relative runtime.
// Type-only imports (`import type`) are erased at compile time per the
// TypeScript spec; this is the pattern enforced by the workspace's
// `@typescript-eslint/consistent-type-imports` lint rule.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

import type {
  ShareLink,
  ShareLinkRepository,
} from '../repositories/share-link.repository';
import type {
  Design,
  DesignPayload,
  DesignRepository,
} from '../repositories/design.repository';

import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Section 1: Public error classes
// ---------------------------------------------------------------------------
//
// Two named error classes the service throws:
//   - {@link ValidationError} — input failed structural validation. The
//     route layer translates to HTTP 400.
//   - {@link NotFoundError} — the requested design does not exist OR is
//     not owned by the caller. The two cases are intentionally
//     indistinguishable to prevent enumeration. The route layer
//     translates to HTTP 404.
//
// Both classes set their own `name` so `JSON.stringify(err)` and pino's
// `stdSerializers.err` produce a stable, machine-readable type tag. Both
// inherit `message` from `Error` so any tooling that reads `err.message`
// continues to work without modification.
// ---------------------------------------------------------------------------

/**
 * Thrown when an input parameter fails structural validation (empty string,
 * non-string, etc.).
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'ValidationError'`
 *   - `field`    — optional parameter name that failed validation
 *   - `code`     — machine-readable error code (default `'VALIDATION_FAILED'`)
 *   - `message`  — inherited from `Error`
 *
 * Information-disclosure posture:
 *   The `message` MUST NOT contain credential material (Rule R2). This
 *   service's inputs are non-credential identifiers (`uid`, `designId`,
 *   `token`) — the token is never echoed back into a ValidationError
 *   message because the only validation we do on `token` is "non-empty
 *   string", which never requires repeating the value.
 */
export class ValidationError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so that
   * `err instanceof Error` is true while `err.name === 'ValidationError'`
   * lets a generic error handler distinguish validation failures
   * without an `instanceof` check (which is sometimes unreliable
   * across module-boundary realms in TypeScript).
   */
  public override readonly name: string = 'ValidationError';

  /**
   * Optional parameter name that failed validation (e.g. `'ownerUid'`,
   * `'designId'`, `'token'`). Operators and clients use this to identify
   * the invalid input without scraping the error message.
   */
  public readonly field?: string;

  /**
   * Machine-readable error code. Defaults to `'VALIDATION_FAILED'` but
   * may be overridden for more specific failure classes (e.g.
   * `'VALIDATION_TOKEN_MISSING'`). The route layer maps this to a stable
   * external error code in the HTTP 400 response body.
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason. Per Rule R2, the
   *   message MUST NOT contain credential material. Callers in this
   *   service are responsible for ensuring messages stay credential-clean.
   * @param options Optional discriminators:
   *   - `field`: the parameter name that failed validation.
   *   - `code`: machine-readable error code (default `'VALIDATION_FAILED'`).
   */
  public constructor(message: string, options?: { field?: string; code?: string }) {
    super(message);
    this.field = options?.field;
    this.code = options?.code ?? 'VALIDATION_FAILED';
    // Restore prototype chain after super() — required for reliable
    // `instanceof` checks when transpiling to ES5/CommonJS targets.
    // See https://github.com/microsoft/TypeScript-wiki/blob/main/Breaking-Changes.md#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Thrown when a requested design does not exist OR is not owned by the
 * caller. These two cases are intentionally conflated to prevent
 * enumeration: a client cannot distinguish "design exists but is someone
 * else's" from "design does not exist at all". Route layer maps to HTTP 404.
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'NotFoundError'`
 *   - `code`     — machine-readable error code (default `'NOT_FOUND'`;
 *                  e.g. `'DESIGN_NOT_FOUND'` for ST-029-AC1 ownership failure)
 *   - `message`  — inherited from `Error`
 *
 * Information-disclosure posture:
 *   The `message` MUST NOT distinguish "the design does not exist" from
 *   "the design exists but is not yours". Both cases collapse to a single
 *   404 outcome, neutralising user-enumeration oracles — exactly the
 *   pattern the `design.repository.ts` SQL enforces by filtering with
 *   `WHERE user_id = $1` on every SELECT.
 */
export class NotFoundError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so a generic error
   * handler can distinguish missing-resource failures without an
   * `instanceof` check.
   */
  public override readonly name: string = 'NotFoundError';

  /**
   * Machine-readable error code. Defaults to `'NOT_FOUND'` but may be
   * overridden for more specific failure classes (e.g.
   * `'DESIGN_NOT_FOUND'`). The route layer maps this to a stable
   * external error code in the HTTP 404 response body.
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason. SHOULD be
   *   non-discriminating ("Design X not found or not owned by user")
   *   to prevent enumeration of designs owned by other users.
   * @param options Optional discriminators:
   *   - `code`: machine-readable error code (default `'NOT_FOUND'`).
   */
  public constructor(message: string, options?: { code?: string }) {
    super(message);
    this.code = options?.code ?? 'NOT_FOUND';
    // Restore prototype chain — see ValidationError JSDoc for rationale.
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Section 2: Module constants
// ---------------------------------------------------------------------------

/**
 * Share-link lifetime in milliseconds. Documented value per ST-029-AC2.
 *
 * The 14-day lifetime is the documented expiration window — long enough
 * that a teammate receiving a link can review the shared design without
 * time pressure, short enough that a leaked link does not represent a
 * permanent breach. The decision is recorded in
 * `docs/decisions/README.md` per the user-provided Explainability Rule.
 *
 * Exported for use in tests (which assert that `service.issue()` produces
 * a row with `expiresAt - issuedAt === SHARE_LINK_TTL_MS`) and for
 * documentation (the route layer's OpenAPI description references this
 * constant rather than a magic number).
 *
 * NOT derived from an environment variable: the share-link lifetime is a
 * product / privacy decision, not a deployment knob. Changing it
 * requires a code change PLUS a decision-log update; making it
 * env-configurable would weaken that audit trail.
 */
export const SHARE_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Token entropy in bytes. 32 bytes = 256 bits, the canonical "cannot
 * brute force in any reasonable universe" threshold. base64url-encoded,
 * this produces a 43-character string (no padding).
 *
 * Module-private (not exported) because changing this value is a
 * security-relevant decision that requires recompiling the service —
 * exposing it would invite tests or callers to override it with a
 * smaller value, which would silently weaken the entropy guarantee.
 */
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Section 3: Module-private validation helpers
// ---------------------------------------------------------------------------
//
// These helpers run BEFORE any repository call, ensuring that validation
// failures never trigger persistence-layer side effects. Each helper
// guards against null, undefined, non-string, and empty-string inputs;
// throws {@link ValidationError} with a precise `field` value on failure.
//
// Why these are module-private:
//   The validation contract is an implementation detail of the service.
//   Exposing the helpers would invite callers to short-circuit the
//   service contract (validate-then-call-without-validating-again),
//   which would regress the defense-in-depth posture.
// ---------------------------------------------------------------------------

/**
 * Reject null, undefined, non-string, and empty-string `ownerUid` values.
 *
 * The session middleware (`../middleware/session.ts`) is responsible for
 * producing a non-empty `uid` on the request after `verifyIdToken`; this
 * guard is defense-in-depth against a future middleware refactor that
 * weakens the contract.
 *
 * @throws {ValidationError} when `ownerUid` is not a non-empty string.
 */
function validateOwnerUid(ownerUid: unknown): string {
  if (typeof ownerUid !== 'string' || ownerUid.length === 0) {
    throw new ValidationError('ownerUid is required', {
      field: 'ownerUid',
      code: 'VALIDATION_OWNER_UID_MISSING',
    });
  }
  return ownerUid;
}

/**
 * Reject null, undefined, non-string, and empty-string `designId` values.
 *
 * The route layer extracts `designId` from `req.params.id`; Express
 * always supplies a string for path params, but the service-layer guard
 * keeps the contract honest if the route refactors to accept the id
 * from a body field or from a different source.
 *
 * @throws {ValidationError} when `designId` is not a non-empty string.
 */
function validateDesignId(designId: unknown): string {
  if (typeof designId !== 'string' || designId.length === 0) {
    throw new ValidationError('designId is required', {
      field: 'designId',
      code: 'VALIDATION_DESIGN_ID_MISSING',
    });
  }
  return designId;
}

/**
 * Reject null, undefined, non-string, and empty-string `token` values.
 *
 * Per Rule R2, the validation MUST NOT echo the token value back into
 * any error message. The check is therefore deliberately minimal —
 * "non-empty string or reject" — so the only piece of information
 * surfaced to the caller is "you supplied a malformed token shape," not
 * "your specific token failed for X reason."
 *
 * @throws {ValidationError} when `token` is not a non-empty string.
 */
function validateToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new ValidationError('token is required', {
      field: 'token',
      code: 'VALIDATION_TOKEN_MISSING',
    });
  }
  return token;
}

// ---------------------------------------------------------------------------
// Section 4: Public types
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by {@link ShareLinkService.issue}.
 *
 * Both `ownerUid` and `designId` are required: the service layer does
 * not infer either from elsewhere. The route layer injects `ownerUid`
 * from the authenticated request and `designId` from the URL path.
 *
 * NOTE: `expiresAt` is INTENTIONALLY ABSENT from this shape — the
 * expiration is computed server-side. A caller-supplied expiration
 * would let a malicious client request effectively-immortal links.
 */
export interface IssueShareLinkParams {
  /** Firebase uid of the user requesting the share link. */
  ownerUid: string;
  /** Server-assigned design UUID to be shared. */
  designId: string;
}

/**
 * Parameters accepted by {@link ShareLinkService.getByToken}.
 *
 * Single-field shape modelled as an interface (rather than a bare
 * string parameter) so future additions (e.g. an optional `clientIp`
 * for abuse monitoring) can extend the shape without breaking the
 * public contract.
 */
export interface GetByTokenParams {
  /** Cryptographically-random URL-safe token from the share URL. */
  token: string;
}

/**
 * Parameters accepted by {@link ShareLinkService.revoke}.
 *
 * Both `ownerUid` AND `designId` are required: the bulk-revoke is
 * scoped to a single (design, owner) tuple. This shape supports the
 * primary use case ("revoke all active share links the owner has
 * issued for this design") while preventing two anti-patterns:
 *   - Cross-user revocation: a request scoped only by `designId`
 *     would let one user revoke share links issued by another user.
 *   - Owner-wide revocation: a request scoped only by `ownerUid`
 *     would revoke all share links the owner has ever issued, across
 *     all their designs — far broader than the documented use cases.
 */
export interface RevokeShareLinkParams {
  /** Firebase uid of the owner whose links are being revoked. */
  ownerUid: string;
  /** Server-assigned design UUID whose links are being revoked. */
  designId: string;
}

/**
 * Read-side projection returned by {@link ShareLinkService.getByToken}.
 *
 * The shape is INTENTIONALLY MINIMAL: enough information for the
 * configurator to render the target design read-only without signing
 * in (ST-029-AC3), but not so much that an unauthenticated visitor
 * learns the owner's identity, the share token, or any other internal
 * metadata.
 *
 * Field-level contract:
 *
 *   `design`
 *     The full configurator selection set as a {@link DesignPayload} —
 *     colors, pattern, finish, logo placement, etc. The renderer
 *     consumes this directly; it is the entire point of the read
 *     endpoint.
 *
 *   `designId`
 *     The server-assigned design UUID. Useful for client-side caching
 *     keys and for analytics that count distinct designs viewed via
 *     share links — but deliberately NOT the owner's identity.
 *
 *   `title`
 *     The user-facing label for the design. Renderable in the
 *     configurator's title area without revealing the owner.
 *
 *   `lastModifiedAt`
 *     The DB-assigned last-modification timestamp. Lets the client
 *     show a "last updated" badge if the share recipient revisits
 *     the link — without leaking the original author.
 *
 * INTENTIONALLY ABSENT from this shape:
 *   - `ownerUid`     : would leak the design owner's identity to
 *                      anonymous visitors (privacy regression).
 *   - `token`        : credential-like material (Rule R2).
 *   - `expiresAt`    : not useful client-side; surfaced only via
 *                      log records / metrics.
 *   - `revokedAt`    : not useful client-side; if the link were
 *                      revoked we would have returned `null` rather
 *                      than this projection.
 *   - `createdAt`    : superseded by `lastModifiedAt` for display
 *                      purposes; surfacing it adds no value.
 *
 * Fully `readonly` so consumers cannot mutate the projection in place.
 */
export interface SharedDesignView {
  /** Full configurator selection set for read-only rendering. */
  readonly design: DesignPayload;
  /** Server-assigned design UUID. */
  readonly designId: string;
  /** User-facing label for the design. */
  readonly title: string;
  /** DB-assigned last-modification timestamp. */
  readonly lastModifiedAt: Date;
}

/**
 * Service interface — the public contract callers depend on.
 *
 * Three methods, sized to the actual needs of story ST-029:
 *
 *   - `issue(params)` — POST /api/designs/:id/share-link (ST-029-AC1+AC2).
 *     Issues a new share link for a design owned by the caller, with a
 *     server-computed expiration. Returns the persisted {@link ShareLink}
 *     (the route layer reads `token` from the result to construct the
 *     public share URL).
 *
 *   - `getByToken(params)` — GET /api/share/:token (ST-029-AC3+AC4).
 *     Resolves a token to a read-only design view. Returns `null` when
 *     the token is unknown, the link is revoked, or the link has
 *     expired. The route layer translates `null` into HTTP 404 / 410.
 *
 *   - `revoke(params)` — bulk revocation (ST-029-AC4). Marks all active
 *     share links for the (design, owner) tuple as revoked. Idempotent:
 *     revoking zero active links is a successful no-op.
 *
 * Out-of-scope per AAP §0.7.2: no token-rotation flow, no admin-style
 * cross-user listings, no "list my share links" query. The 49-story
 * acceptance scope does not require those operations.
 */
export interface ShareLinkService {
  /**
   * Issue a new share link for a design owned by the caller.
   *
   * @throws {ValidationError} when input validation fails.
   * @throws {NotFoundError} when the design does not exist OR is not
   *   owned by `params.ownerUid` — the two cases are intentionally
   *   indistinguishable to prevent enumeration.
   * @throws The native pg error on PRIMARY KEY collision (vanishingly
   *   rare given 256-bit token entropy) or foreign-key violation. The
   *   route layer translates these to HTTP 5xx / 404.
   */
  issue(params: IssueShareLinkParams): Promise<ShareLink>;

  /**
   * Resolve a token to a read-only design view.
   *
   * Returns `null` when:
   *   - The token does not match any row.
   *   - The matching row is revoked (`revokedAt !== null`).
   *   - The matching row is expired (`expiresAt <= now()`).
   *   - The matching row references a design that no longer exists
   *     (defensive — should not occur given the FK constraint).
   *
   * @throws {ValidationError} when `params.token` is empty or non-string.
   */
  getByToken(params: GetByTokenParams): Promise<SharedDesignView | null>;

  /**
   * Revoke all active share links for the (design, owner) tuple.
   *
   * Idempotent: calling `revoke` with no active links is a no-op
   * success (the repository's `WHERE revoked_at IS NULL` filter
   * preserves the original `revoked_at` timestamp on already-revoked
   * rows).
   *
   * @throws {ValidationError} when input validation fails.
   */
  revoke(params: RevokeShareLinkParams): Promise<void>;
}

/**
 * Dependency contract for {@link createShareLinkService}.
 *
 * Two repositories are required:
 *
 *   - `shareLinkRepository`
 *     Used for the three primary operations: `insert` on issuance,
 *     `findByToken` on read, `revoke` on cancellation.
 *
 *   - `designRepository`
 *     Used ONLY for ownership verification on `issue()`. Specifically
 *     `findById({ userId, designId })` — the `WHERE user_id = $1` in
 *     that SELECT is the structural enforcement of ST-029-AC1.
 *
 * Why a deps interface (rather than positional constructor args)?
 *   - Self-documenting: the call site reads
 *     `createShareLinkService({ shareLinkRepository, designRepository })`,
 *     which is unambiguous without needing to remember argument order.
 *   - Order-independent: swapping the deps' declaration order in this
 *     interface does not break any caller.
 *   - Easy to extend: future deps (e.g. an URL-builder service) can be
 *     added without breaking existing call sites.
 */
export interface ShareLinkServiceDeps {
  /** Repository for share-link CRUD. */
  shareLinkRepository: ShareLinkRepository;
  /**
   * Repository for design lookup. Used by `issue()` to verify
   * ownership BEFORE persisting a share link.
   */
  designRepository: DesignRepository;
}

// ---------------------------------------------------------------------------
// Section 5: Service factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link ShareLinkService} backed by the supplied repositories.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createShareLinkService({ ... })`) — easier to mock in unit tests
 *     than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *
 * The returned record is `Object.freeze`-d so calling code cannot
 * substitute one of the methods at runtime — preventing a class of
 * bugs where a test or middleware accidentally mutates the shared
 * service instance.
 *
 * The factory THROWS SYNCHRONOUSLY when any required dependency is
 * missing. Composition-root misconfiguration is a programmer error
 * that should fail fast at startup, not at first request — the
 * pattern matches the fail-fast posture of `requireEnv()` for env
 * variables (Rule R4).
 *
 * @param deps Required repositories injected by the composition root.
 * @returns A frozen {@link ShareLinkService} ready for use.
 * @throws {Error} when `deps`, `deps.shareLinkRepository`, or
 *   `deps.designRepository` is missing.
 */
export function createShareLinkService(deps: ShareLinkServiceDeps): ShareLinkService {
  // Fail-fast composition validation. We narrow `deps` to its concrete
  // shape with explicit checks rather than relying on TypeScript's
  // compile-time guarantees because the composition root may be
  // assembled from runtime values (env-driven feature flags, plugin
  // architecture, etc.) and the cost of a clear startup error is
  // dramatically lower than the cost of an `undefined.insert` runtime
  // crash on first request.
  if (deps === null || deps === undefined) {
    throw new Error('createShareLinkService: deps argument is required');
  }
  if (!deps.shareLinkRepository) {
    throw new Error(
      'createShareLinkService: shareLinkRepository dependency is required',
    );
  }
  if (!deps.designRepository) {
    throw new Error(
      'createShareLinkService: designRepository dependency is required',
    );
  }

  // Destructure into stable references so the closures below capture
  // the dependencies once at construction time. This also makes the
  // returned object's methods independent of the `deps` argument's
  // lifetime — the caller can safely discard the deps reference after
  // the factory returns.
  const { shareLinkRepository, designRepository } = deps;

  const service: ShareLinkService = {
    async issue(params: IssueShareLinkParams): Promise<ShareLink> {
      // -----------------------------------------------------------------
      // Phase A: Validate inputs.
      // -----------------------------------------------------------------
      // The service-layer validation runs BEFORE any repository call so
      // that a malformed request never reaches the persistence layer.
      // Each validator throws ValidationError synchronously on failure;
      // the route layer maps that to HTTP 400.
      const ownerUid = validateOwnerUid(params?.ownerUid);
      const designId = validateDesignId(params?.designId);

      // -----------------------------------------------------------------
      // Phase B: Ownership verification (ST-029-AC1).
      // -----------------------------------------------------------------
      // The design repository's `findById({ userId, designId })` issues
      // a SELECT scoped by `WHERE user_id = $1 AND id = $2`, so a
      // request that supplies a valid `designId` but the wrong `userId`
      // returns null. Returning null is exactly the case we map to
      // NotFoundError — the conflated 404 (vs. 403 for "not yours") is
      // deliberate enumeration defense.
      const design: Design | null = await designRepository.findById({
        userId: ownerUid,
        designId,
      });
      if (design === null) {
        // The 'DESIGN_NOT_FOUND' code lets the route layer's response
        // body distinguish this case from other 404 paths in
        // observability dashboards, while still presenting the same
        // surface to the client.
        throw new NotFoundError('Design not found or not owned by user', {
          code: 'DESIGN_NOT_FOUND',
        });
      }

      // -----------------------------------------------------------------
      // Phase C: Token generation.
      // -----------------------------------------------------------------
      // 32 bytes of cryptographic randomness (256 bits of entropy),
      // base64url-encoded for URL-safety without percent-escaping.
      // base64url replaces '+' and '/' with '-' and '_' respectively,
      // and omits '=' padding — producing a 43-character ASCII string
      // that fits cleanly into a URL path segment.
      //
      // The token NEVER appears in any logger.* call below — Rule R2
      // applies to the token even though it is not a "credential" in
      // the classic sense; it grants read access to a design and is
      // therefore credential-like material.
      const token: string = randomBytes(TOKEN_BYTES).toString('base64url');

      // -----------------------------------------------------------------
      // Phase D: Server-computed expiration.
      // -----------------------------------------------------------------
      // We compute `expiresAt` from `Date.now()` rather than passing
      // it through from the caller — the caller MUST NOT be able to
      // request a longer-than-policy lifetime.
      //
      // Both `issuedAt` and `expiresAt` are JavaScript Dates here. The
      // repository's INSERT statement then accepts either a Date or
      // an ISO-8601 string; the repository internally converts via
      // `expiresAt.toISOString()` and an explicit `::timestamptz` cast.
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + SHARE_LINK_TTL_MS);

      // -----------------------------------------------------------------
      // Phase E: Pre-persistence log record.
      // -----------------------------------------------------------------
      // Structural metadata only; the token is INTENTIONALLY ABSENT
      // (Rule R2). The `event` field uses a stable dotted name so
      // dashboard panels can filter on `event = "share_link.issue.received"`.
      logger.info(
        {
          event: 'share_link.issue.received',
          uid: ownerUid,
          designId,
          expiresAt: expiresAt.toISOString(),
        },
        'issuing share link',
      );

      // -----------------------------------------------------------------
      // Phase F: Persist via the repository.
      // -----------------------------------------------------------------
      // Errors propagate (Rule R8 — fail-closed). The pg driver throws
      // synchronously-rejected promises for UNIQUE / FK violations;
      // the route layer's general error handler maps those to HTTP 500.
      const shareLink = await shareLinkRepository.insert({
        token,
        designId,
        ownerUid,
        expiresAt,
      });

      // -----------------------------------------------------------------
      // Phase G: Post-persistence log record.
      // -----------------------------------------------------------------
      // The token remains absent. We log the persisted `expiresAt` from
      // the row (rather than our locally-computed value) so that any
      // future column default that overrides the application-supplied
      // value would be visible in operator logs.
      logger.info(
        {
          event: 'share_link.issue.persisted',
          uid: ownerUid,
          designId,
          expiresAt: shareLink.expiresAt.toISOString(),
          // NOTE: shareLink.token is INTENTIONALLY ABSENT (Rule R2).
          // The route layer reads it from the returned object to
          // construct the public share URL — but it never appears in
          // any log record emitted by this service.
        },
        'share link persisted',
      );

      // -----------------------------------------------------------------
      // Phase H: Return the canonical record.
      // -----------------------------------------------------------------
      // The route layer is responsible for translating `shareLink.token`
      // into a public URL (e.g. `https://strikeforge.example/share/<token>`)
      // before responding to the client.
      return shareLink;
    },

    async getByToken(params: GetByTokenParams): Promise<SharedDesignView | null> {
      // -----------------------------------------------------------------
      // Phase A: Validate inputs.
      // -----------------------------------------------------------------
      const token = validateToken(params?.token);

      // -----------------------------------------------------------------
      // Phase B: Lookup via repository.
      // -----------------------------------------------------------------
      // The repository's `findByToken` issues a single SELECT-with-JOIN
      // so we receive the share-link record AND the underlying design
      // payload in one round-trip. No second `findById` call is
      // needed, and no race window exists between the two.
      const row = await shareLinkRepository.findByToken(token);
      if (row === null) {
        // No row matched — the token is unknown. Log with structural
        // metadata only; do NOT include the token in the log record
        // (Rule R2 — the token is what the lookup probed against,
        // never what we emit).
        logger.info(
          { event: 'share_link.get.not_found' },
          'share link lookup returned no row',
        );
        return null;
      }

      // -----------------------------------------------------------------
      // Phase C: Validity gates (ST-029-AC2 + ST-029-AC4).
      // -----------------------------------------------------------------
      // Three gates, evaluated in this order so the most-specific
      // observability event fires for each rejection class:
      //   1. Revoked  -> share_link.get.revoked (operator action)
      //   2. Expired  -> share_link.get.expired (natural expiration)
      //   3. Orphan   -> share_link.get.orphan  (defensive; FK invariant)
      // ALL three return null — the route layer maps any null to a
      // single 404/410 outcome. Splitting the rejection into three
      // events lets dashboards distinguish "many revocations" from
      // "many expirations" from "data integrity issue."
      const now = new Date();

      // Gate 1: revoked share links.
      if (row.revokedAt !== null) {
        logger.info(
          {
            event: 'share_link.get.revoked',
            designId: row.designId,
            revokedAt: row.revokedAt.toISOString(),
          },
          'share link is revoked',
        );
        return null;
      }

      // Gate 2: expired share links. Inclusive boundary: `expiresAt
      // === now()` counts as expired. The `<=` is intentional — an
      // exclusive comparison would let a link issued at exactly
      // `now() + TTL` and queried at exactly `now() + TTL` to slip
      // through, which is a pathological corner case but real if
      // wall-clock granularity is coarse.
      if (row.expiresAt.getTime() <= now.getTime()) {
        logger.info(
          {
            event: 'share_link.get.expired',
            designId: row.designId,
            expiresAt: row.expiresAt.toISOString(),
          },
          'share link is expired',
        );
        return null;
      }

      // Gate 3: orphan rows. The FK constraint with ON DELETE CASCADE
      // means this should be unreachable in normal operation, but the
      // repository models the LEFT JOIN faithfully (`design: Design |
      // null`) so the service handles the impossible case explicitly
      // rather than crashing on a null property access.
      if (row.design === null) {
        logger.warn(
          {
            event: 'share_link.get.orphan',
            designId: row.designId,
          },
          'share link references a missing design; treating as not found',
        );
        return null;
      }

      // -----------------------------------------------------------------
      // Phase D: Build the read-side projection.
      // -----------------------------------------------------------------
      // Explicit field-by-field copy ensures we never accidentally
      // surface fields the read side must NOT see (ownerUid, token,
      // revokedAt, expiresAt, createdAt). The compiler enforces the
      // SharedDesignView shape — adding a leak would surface as a
      // type error during the type-check gate.
      return {
        design: row.design.payload,
        designId: row.design.id,
        title: row.design.title,
        lastModifiedAt: row.design.lastModifiedAt,
      };
    },

    async revoke(params: RevokeShareLinkParams): Promise<void> {
      // -----------------------------------------------------------------
      // Phase A: Validate inputs.
      // -----------------------------------------------------------------
      const ownerUid = validateOwnerUid(params?.ownerUid);
      const designId = validateDesignId(params?.designId);

      // -----------------------------------------------------------------
      // Phase B: Pre-revocation log record.
      // -----------------------------------------------------------------
      logger.info(
        {
          event: 'share_link.revoke.received',
          uid: ownerUid,
          designId,
        },
        'revoking share links for design',
      );

      // -----------------------------------------------------------------
      // Phase C: Delegate to repository.
      // -----------------------------------------------------------------
      // The repository's UPDATE is filtered by both `design_id` AND
      // `owner_uid`, providing defense-in-depth against a service-layer
      // bug that might attempt to revoke another user's links. The
      // `WHERE revoked_at IS NULL` predicate makes the operation
      // idempotent: already-revoked rows are skipped without
      // overwriting their original revocation timestamp.
      //
      // Note: we do NOT pre-check ownership via designRepository.findById
      // here. The repository's WHERE clause IS the ownership check —
      // adding a pre-check would be a redundant round-trip and would
      // introduce a TOCTOU window between the SELECT and the UPDATE.
      // ST-029-AC4 is satisfied by the repository's atomic UPDATE.
      const result = await shareLinkRepository.revoke({ designId, ownerUid });

      // -----------------------------------------------------------------
      // Phase D: Post-revocation log record.
      // -----------------------------------------------------------------
      // `revokedCount` is informational. A value of 0 is NOT an error —
      // it means there were no active share links for this (design,
      // owner) tuple, which is a perfectly valid state (e.g. the user
      // never issued one, or all of them are already revoked/expired).
      // We log the count for operator visibility but do NOT surface it
      // to the caller — the public method returns void.
      logger.info(
        {
          event: 'share_link.revoke.completed',
          uid: ownerUid,
          designId,
          revokedCount: result.revokedCount,
        },
        'share link revocation completed',
      );

      // Return void — the count is logged but not exposed via the
      // public API. A method that returned the count would invite
      // callers to branch on "0 revoked" as an error condition,
      // which would regress the idempotent-revocation contract.
      return;
    },
  };

  // Freeze the service so middlewares, routes, or tests cannot
  // monkey-patch a method at runtime — a defensive measure against a
  // class of bugs that are typically very hard to diagnose.
  return Object.freeze(service);
}
