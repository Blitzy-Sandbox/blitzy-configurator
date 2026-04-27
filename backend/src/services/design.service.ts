/**
 * Design Business-Logic Orchestrator — ST-027, ST-028
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/services/design.service.ts | Create/list/share-link
 *        orchestration"
 *   - §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/services/design.service.ts | Create/list/share
 *        orchestration"
 *   - tickets/stories/ST-027-create-design-endpoint.md
 *   - tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md
 *
 * Responsibilities:
 *   1. Validate inbound payload shape before touching the persistence layer
 *      (ST-027-AC3). Validation errors short-circuit with {@link
 *      ValidationError} and never result in a partial DB write.
 *   2. Enforce the ownership invariant at the service boundary: every
 *      method requires `userId`; the repository SQL filters by `user_id`;
 *      the service additionally null-filters cross-ownership on `getById`
 *      to prevent enumeration via a defense-in-depth check.
 *   3. Clamp `limit` to {@link MAX_PAGE_SIZE} (= 100) for `listByUser` per
 *      ST-028-AC5. The repository ALSO clamps; the service-layer clamp is
 *      the first line of defense.
 *   4. Forward opaque cursor tokens verbatim to the repository's keyset
 *      pagination mechanism. The cursor format is the repository's
 *      concern (`encodeCursor` / `decodeCursor` in `design.repository.ts`);
 *      the service layer never inspects, parses, or invents cursors.
 *
 * Architectural intent:
 *   The service is the single composition point between Express route
 *   handlers (`backend/src/routes/designs.ts`, ST-027/ST-028) and the
 *   data-access layer (`backend/src/repositories/design.repository.ts`).
 *   It owns input validation, structural log emission, and ownership
 *   defense-in-depth — concerns that belong neither in the route layer
 *   (which should stay thin) nor in the repository (which should deal
 *   with SQL outcomes only).
 *
 *   The factory pattern (`createDesignService(deps)`) makes dependency
 *   injection explicit at the composition root and keeps each method
 *   trivially mockable in unit tests.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R1 (story ACs authoritative): every ST-027 and ST-028 acceptance
 *     criterion is mapped to a code path in this file. Verification
 *     lives in the co-located `design.service.test.ts`.
 *   - R2 (no credential material in logs): logs emit STRUCTURAL
 *     metadata only (event names, ids, lengths, booleans). Payload
 *     contents are never echoed. The validation helper additionally
 *     drops unknown keys from `payload` so a hostile client cannot
 *     smuggle a field named `password` into the JSONB column. The
 *     pino serializer allow-list is the second line of defense; the
 *     per-call discipline is the first.
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`. Token
 *     verification is the exclusive responsibility of the upstream
 *     session middleware (`backend/src/middleware/session.ts`).
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. All dependencies are injected via {@link
 *     DesignServiceDeps}.
 *   - R8 (gates fail closed): repository errors propagate via `await`;
 *     no `try / catch { }` swallow blocks. Validation errors throw
 *     before any side effect (no partial writes).
 *   - R9 (no payment processing): this service has zero financial
 *     logic; cart/order flows are handled by `order.service.ts`.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/repositories/design.repository.ts` — primary collaborator;
 *     supplies the `DesignRepository` interface this service consumes.
 *   - `backend/src/services/gcs.service.ts` — injected for future
 *     enrichment of design payload logo references with signed read
 *     URLs. The factory currently validates its presence and retains the
 *     reference in the deps closure so that adding read-URL enrichment
 *     later does not require a composition-root refactor.
 *   - `backend/src/logging/pino.ts` — module-level logger used for
 *     structured-metadata-only emission per Rule R2.
 *   - `backend/src/routes/designs.ts` — primary consumer; translates
 *     {@link ValidationError} to HTTP 400 and `null` from `getById` to
 *     HTTP 404.
 */

// ---------------------------------------------------------------------------
// Section 1: Imports
// ---------------------------------------------------------------------------
//
// All type-only imports use `import type` to satisfy the
// `consistent-type-imports` ESLint rule. Value imports
// (`MAX_PAGE_SIZE`, `DEFAULT_PAGE_SIZE`, `logger`) are split into a
// separate runtime-import statement.

import type {
  Design,
  DesignListPage,
  DesignPayload,
  DesignRepository,
  InsertDesignParams,
  ListDesignsByUserParams,
  FindDesignByIdParams,
} from '../repositories/design.repository';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../repositories/design.repository';
import type { GcsService } from './gcs.service';
import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Section 2: Validation error class
// ---------------------------------------------------------------------------

/**
 * Thrown when inbound data fails schema or value validation.
 *
 * Per ST-027-AC3, invalid input MUST be rejected with a descriptive
 * error and MUST NOT leave partial state. The route layer catches this
 * exception and translates it to HTTP 400 with a structured error body
 * (`{ error: { code, message, field } }`).
 *
 * Members exposed (per the file's export schema):
 *   - `name`     — fixed string `'ValidationError'`. Override of
 *                  `Error.name` so that `err instanceof Error` is true
 *                  while `err.name === 'ValidationError'` lets a generic
 *                  error handler distinguish validation failures
 *                  without an `instanceof` check (which is sometimes
 *                  unreliable across module-boundary realms in
 *                  TypeScript).
 *   - `field`    — optional parameter name that failed validation
 *                  (e.g. `'title'`, `'payload.primaryColor'`). Operators
 *                  and clients use this to identify the invalid input
 *                  without scraping the error message.
 *   - `code`     — machine-readable error code; defaults to
 *                  `'VALIDATION_FAILED'`. Used by the route layer to
 *                  emit a stable error code in the HTTP 400 response
 *                  body so frontends can render localized messages
 *                  without parsing server-side strings.
 *   - `message`  — inherited from `Error`; human-readable description.
 *                  Per Rule R2, the message MUST NOT contain credential
 *                  material — callers below ensure messages stay
 *                  credential-clean.
 *
 * Information-disclosure posture:
 *   The `message` and `field` values surface to the client. The
 *   validators below intentionally describe SHAPE failures
 *   ("title is required", "payload.primaryColor is required") rather
 *   than embedding the offending value. A hostile client cannot
 *   determine the validation rules from the error text alone in any
 *   way that helps them — and an honest client gets enough information
 *   to surface a useful UI message.
 *
 * Pattern parity:
 *   This class is intentionally distinct from the `ValidationError`
 *   classes defined in `gcs.service.ts`, `session.service.ts`, and
 *   `share-link.service.ts`. Each service owns its own typed error
 *   class so consumers can `catch` precisely the variant from the
 *   service they invoked. A shared base class would couple unrelated
 *   services and complicate future refactoring.
 */
export class ValidationError extends Error {
  /**
   * Optional parameter name that failed validation (e.g. `'title'`,
   * `'payload.primaryColor'`, `'limit'`). When omitted, the failure is
   * not attributable to a single field (rare in this service; included
   * for completeness).
   */
  public readonly field?: string;

  /**
   * Machine-readable error code. Defaults to `'VALIDATION_FAILED'` but
   * is overridden by every helper below for more specific failure
   * classes (e.g. `'VALIDATION_TITLE_MISSING'`,
   * `'VALIDATION_LIMIT_RANGE'`).
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason. Per Rule R2, the
   *   message MUST NOT contain credential material.
   * @param options Optional discriminators:
   *   - `field`: the parameter name that failed validation.
   *   - `code`:  machine-readable error code (default
   *     `'VALIDATION_FAILED'`).
   */
  public constructor(message: string, options?: { field?: string; code?: string }) {
    super(message);
    // Override Error.name so error handlers can branch on the
    // discriminator without relying on `instanceof` (which can fail
    // across realms / hot-reload boundaries in TypeScript).
    this.name = 'ValidationError';
    this.field = options?.field;
    this.code = options?.code ?? 'VALIDATION_FAILED';
    // Restore the prototype chain after `super()`. Required for
    // reliable `instanceof` semantics when transpiling to ES5 / older
    // CommonJS targets, even though our pinned target is ES2022 and
    // would handle this automatically — the explicit call is
    // essentially free and bullet-proofs the class against downstream
    // tooling that re-targets older runtimes (e.g. legacy test
    // harnesses).
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Section 3: Validation helpers (private)
// ---------------------------------------------------------------------------

/**
 * Maximum permitted title length, in code-units. Bound chosen to
 * comfortably accommodate human-readable design names while preventing
 * pathological input (e.g. multi-megabyte titles) from bloating the
 * `designs.title` column or breaking dashboard rendering.
 *
 * The constant is private to this file because the bound is a
 * service-layer concern — the repository column itself is sized in the
 * ST-030 migration. If a future story raises the limit, both the
 * migration and this constant must be updated together.
 */
const TITLE_MAX_LENGTH = 200;

/**
 * Minimum permitted title length, in code-units, AFTER trimming. A
 * title of `'   '` (whitespace only) trims to `''` and fails this
 * check — the contract is "a title means something a human can read",
 * not "any non-empty string at all".
 */
const TITLE_MIN_LENGTH = 1;

/**
 * Validate and normalize a design title.
 *
 * Returns the trimmed title on success. Throws {@link ValidationError}
 * on failure.
 *
 * Trim-before-check policy: a title of `"   "` (whitespace only) after
 * trim becomes `""` which fails the min-length check. This matches the
 * UX expectation that leading/trailing whitespace is an accident, not a
 * deliberate value, and prevents the configurator's design list from
 * displaying invisible entries.
 *
 * @param title The caller-supplied title; expected to be a string but
 *   typed as `unknown` so a JS caller passing the wrong type is
 *   rejected at the validation boundary rather than producing a
 *   cryptic downstream error.
 * @returns The trimmed title.
 * @throws {ValidationError} when `title` is missing, empty after trim,
 *   or longer than {@link TITLE_MAX_LENGTH}.
 */
function validateTitle(title: unknown): string {
  if (typeof title !== 'string') {
    throw new ValidationError('title is required', {
      field: 'title',
      code: 'VALIDATION_TITLE_MISSING',
    });
  }
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN_LENGTH) {
    throw new ValidationError('title cannot be empty', {
      field: 'title',
      code: 'VALIDATION_TITLE_EMPTY',
    });
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new ValidationError(`title cannot exceed ${TITLE_MAX_LENGTH} characters`, {
      field: 'title',
      code: 'VALIDATION_TITLE_TOO_LONG',
    });
  }
  return trimmed;
}

/**
 * Validate and normalize a design payload.
 *
 * The configurator persists color selections, stitching pattern,
 * material finish, and an optional logo reference + placement per
 * ST-027-AC1. This function accepts unknown input and returns a
 * narrowed, allow-listed payload object.
 *
 * **Allow-list semantics (Rule R2 defense-in-depth):**
 *   Fields NOT in the allow-list are SILENTLY DROPPED. A client sending
 *   `payload.password = 'xxx'` gets that field discarded — it never
 *   reaches the JSONB column. Pino's serializer allow-list redacts
 *   known credential keys at log time, but the FIRST line of defense
 *   is "do not let the data into the persistence layer at all", which
 *   is what this function provides.
 *
 * **Required fields (per ST-027-AC1 / ST-027-AC3):**
 *   - `primaryColor` — non-empty string.
 *   - `pattern`      — non-empty string (any of the six configurator
 *                       patterns; the service validates non-empty,
 *                       the configurator UI enforces the enum).
 *   - `finish`       — non-empty string (matte | glossy | metallic).
 *
 * **Optional fields:**
 *   - `secondaryColor` — non-empty string when present.
 *   - `accentColor`    — non-empty string when present.
 *   - `logo`           — `null` or an object with `objectKey: string`
 *                         and optional numeric `offsetX`, `offsetY`,
 *                         `scale`, `rotation`. ST-027-AC3 explicitly
 *                         requires that "malformed logo reference" be
 *                         rejected.
 *
 * @param payload The caller-supplied payload; expected to be a plain
 *   object.
 * @returns The normalized {@link DesignPayload} with only allow-listed
 *   keys.
 * @throws {ValidationError} when `payload` is missing, not an object,
 *   missing a required field, or contains a malformed logo reference.
 */
function validateAndNormalizePayload(payload: unknown): DesignPayload {
  // Reject null / undefined explicitly so the field-level error
  // attribution stays accurate. Falling through to the typeof check
  // below would still reject these, but the message would be less
  // actionable.
  if (payload === null || payload === undefined) {
    throw new ValidationError('payload is required', {
      field: 'payload',
      code: 'VALIDATION_PAYLOAD_MISSING',
    });
  }
  // Reject arrays explicitly: `typeof [] === 'object'` in JS, and a
  // top-level array is never a valid configurator payload.
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('payload must be a JSON object', {
      field: 'payload',
      code: 'VALIDATION_PAYLOAD_TYPE',
    });
  }

  // After the guards above, `payload` is a plain object. Cast to a
  // string-keyed record for property access — TypeScript's narrowing
  // does not flow through the `typeof === 'object'` guard.
  const p = payload as Record<string, unknown>;

  // -------------------------------------------------------------------
  // Required field: primaryColor (per ST-027-AC1).
  // -------------------------------------------------------------------
  const primaryColor = p.primaryColor;
  if (typeof primaryColor !== 'string' || primaryColor.length === 0) {
    throw new ValidationError('payload.primaryColor is required', {
      field: 'payload.primaryColor',
      code: 'VALIDATION_PRIMARY_COLOR_MISSING',
    });
  }

  // -------------------------------------------------------------------
  // Required field: pattern (per ST-027-AC1).
  // -------------------------------------------------------------------
  const pattern = p.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new ValidationError('payload.pattern is required', {
      field: 'payload.pattern',
      code: 'VALIDATION_PATTERN_MISSING',
    });
  }

  // -------------------------------------------------------------------
  // Required field: finish (per ST-027-AC1).
  // -------------------------------------------------------------------
  const finish = p.finish;
  if (typeof finish !== 'string' || finish.length === 0) {
    throw new ValidationError('payload.finish is required', {
      field: 'payload.finish',
      code: 'VALIDATION_FINISH_MISSING',
    });
  }

  // -------------------------------------------------------------------
  // Build the allow-listed normalized object. Additional fields in
  // `p` are silently dropped — that is the R2 defense-in-depth posture.
  // We start with the three required fields and conditionally append
  // each optional field only when it passes its own typeof check.
  // -------------------------------------------------------------------
  const normalized: DesignPayload = {
    primaryColor,
    pattern,
    finish,
  };

  if (typeof p.secondaryColor === 'string' && p.secondaryColor.length > 0) {
    normalized.secondaryColor = p.secondaryColor;
  }
  if (typeof p.accentColor === 'string' && p.accentColor.length > 0) {
    normalized.accentColor = p.accentColor;
  }

  // -------------------------------------------------------------------
  // Optional logo reference (ST-027-AC1: "logo reference and
  // placement"). When the caller supplies `null`, the field is
  // intentionally omitted from the normalized object — this signals
  // "no logo" in the JSONB payload by absence rather than by an
  // explicit `null` value. When the caller supplies an object, it MUST
  // contain a non-empty `objectKey` (ST-027-AC3 "malformed logo
  // reference is rejected"). Numeric placement fields (offsetX,
  // offsetY, scale, rotation) are allow-listed; unknown keys on the
  // logo sub-object are dropped.
  // -------------------------------------------------------------------
  if (p.logo !== undefined && p.logo !== null) {
    if (typeof p.logo !== 'object' || Array.isArray(p.logo)) {
      throw new ValidationError('payload.logo must be an object or null', {
        field: 'payload.logo',
        code: 'VALIDATION_LOGO_TYPE',
      });
    }
    const logo = p.logo as Record<string, unknown>;
    if (typeof logo.objectKey !== 'string' || logo.objectKey.length === 0) {
      throw new ValidationError('payload.logo.objectKey is required when logo is provided', {
        field: 'payload.logo.objectKey',
        code: 'VALIDATION_LOGO_OBJECT_KEY',
      });
    }
    // Build the normalized logo object explicitly so the allow-list is
    // visible at a glance. Optional placement fields are appended via
    // conditional spread to avoid storing `undefined` values in JSONB
    // (which would otherwise show up as missing keys at read time
    // anyway, but the conditional spread keeps the persisted document
    // tidy).
    const normalizedLogo: Record<string, unknown> = { objectKey: logo.objectKey };
    if (typeof logo.offsetX === 'number' && Number.isFinite(logo.offsetX)) {
      normalizedLogo.offsetX = logo.offsetX;
    }
    if (typeof logo.offsetY === 'number' && Number.isFinite(logo.offsetY)) {
      normalizedLogo.offsetY = logo.offsetY;
    }
    if (typeof logo.scale === 'number' && Number.isFinite(logo.scale)) {
      normalizedLogo.scale = logo.scale;
    }
    if (typeof logo.rotation === 'number' && Number.isFinite(logo.rotation)) {
      normalizedLogo.rotation = logo.rotation;
    }
    normalized.logo = normalizedLogo;
  }

  return normalized;
}

/**
 * Validate a userId (the server-known Firebase uid carried on the
 * authenticated request).
 *
 * Rejects empty / non-string. Does NOT enforce a specific format —
 * Firebase uids follow an opaque format and the application MUST NOT
 * encode assumptions about that format. The check exists to catch
 * wiring bugs (e.g. a route handler that forgets to populate
 * `req.uid` before invoking the service).
 *
 * @param userId The caller-supplied userId.
 * @returns The validated userId string.
 * @throws {ValidationError} when `userId` is missing or empty.
 */
function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ValidationError('userId is required', {
      field: 'userId',
      code: 'VALIDATION_USER_ID_MISSING',
    });
  }
  return userId;
}

/**
 * Validate a designId (server-assigned UUID).
 *
 * Rejects empty / non-string. The repository's SQL casts to `::uuid`,
 * so a malformed UUID surfaces as a PostgreSQL error rather than a
 * service-layer one — but a missing designId is a wiring bug we
 * surface earlier here for a clearer error message.
 *
 * @param designId The caller-supplied designId.
 * @returns The validated designId string.
 * @throws {ValidationError} when `designId` is missing or empty.
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
 * Validate and clamp a pagination limit per ST-028-AC5.
 *
 * Behavior:
 *   - `undefined` -> {@link DEFAULT_PAGE_SIZE} (caller omitted the
 *     parameter; use the documented default).
 *   - non-integer or non-number -> throws {@link ValidationError}
 *     (e.g. `"abc"`, `1.5`, `NaN`).
 *   - <= 0 -> throws {@link ValidationError} (invalid range).
 *   - > {@link MAX_PAGE_SIZE} -> SILENTLY clamped to {@link
 *     MAX_PAGE_SIZE} (per ST-028-AC5: caller asked for a value above
 *     the documented maximum; we cap at the maximum and serve a
 *     bounded result).
 *
 * The clamp is at the service layer FIRST (this function) and at the
 * repository layer SECOND (`design.repository.ts:listByUser`). Two
 * layers of clamping protect against a future refactor that bypasses
 * the service.
 *
 * @param limit The caller-supplied limit, or `undefined`.
 * @returns The validated, clamped page size.
 * @throws {ValidationError} when `limit` is supplied but is not a
 *   positive integer.
 */
function validateAndClampLimit(limit: unknown): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new ValidationError('limit must be a positive integer', {
      field: 'limit',
      code: 'VALIDATION_LIMIT_TYPE',
    });
  }
  if (limit <= 0) {
    throw new ValidationError('limit must be at least 1', {
      field: 'limit',
      code: 'VALIDATION_LIMIT_RANGE',
    });
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Section 4: Public types — input/output contracts for the service methods
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link DesignService.create}.
 *
 * Members exposed (per the file's export schema):
 *   - `userId`  — the authenticated user's Firebase uid (= local
 *                 `users.id`). Populated by the route layer from
 *                 `req.uid` after the session middleware verifies the
 *                 inbound bearer token.
 *   - `title`   — the user-facing label. Trimmed and bounded by the
 *                 service.
 *   - `payload` — the configurator selection set. Allow-list normalized
 *                 by the service; unknown keys are dropped.
 */
export interface CreateDesignParams {
  /** Authenticated user's Firebase uid. */
  userId: string;
  /** User-facing title; trimmed and length-bounded. */
  title: string;
  /** Configurator selection set; allow-list normalized. */
  payload: DesignPayload;
}

/**
 * Parameters for {@link DesignService.listByUser}.
 *
 * Members exposed (per the file's export schema):
 *   - `userId` — the authenticated user's Firebase uid.
 *   - `limit`  — optional page size; defaults to {@link
 *                 DEFAULT_PAGE_SIZE}, clamped to {@link MAX_PAGE_SIZE}.
 *   - `cursor` — opaque cursor from a prior page's `nextCursor`.
 *                Undefined / null on the first call.
 */
export interface ListDesignsParams {
  /** Authenticated user's Firebase uid; results are scoped to this user. */
  userId: string;
  /**
   * Maximum number of designs to return for this page. Optional;
   * defaults to {@link DEFAULT_PAGE_SIZE}. Values above {@link
   * MAX_PAGE_SIZE} are clamped per ST-028-AC5.
   */
  limit?: number;
  /**
   * Opaque cursor from a prior page's `nextCursor`. Treated as opaque
   * by the service — passed verbatim to the repository's keyset
   * pagination mechanism.
   */
  cursor?: string;
}

/**
 * Parameters for {@link DesignService.getById}.
 *
 * Members exposed (per the file's export schema):
 *   - `userId`   — the authenticated user's Firebase uid.
 *   - `designId` — the server-assigned UUID of the target design.
 *
 * Both fields are required; ownership is enforced by the SQL WHERE
 * (`WHERE user_id = $1 AND id = $2`) so a request that supplies the
 * correct designId but the wrong userId returns `null` (not 403). The
 * service additionally null-filters cross-ownership matches as a
 * defense-in-depth check (see {@link DesignService.getById}).
 */
export interface GetDesignByIdParams {
  /** Authenticated user's Firebase uid. */
  userId: string;
  /** Server-assigned UUID of the target design. */
  designId: string;
}

/**
 * Public service interface — the contract route handlers depend on.
 *
 * Three methods cover the ST-027 / ST-028 acceptance set:
 *
 *   - `create(params)`    — POST `/api/designs` (ST-027). Validates
 *                            input, persists the design, returns the
 *                            canonical record.
 *   - `listByUser(params)` — GET `/api/designs` (ST-028). Returns a
 *                            paginated page of designs owned by
 *                            `userId`.
 *   - `getById(params)`   — GET `/api/designs/:id`. Returns the
 *                            target design (with ownership enforced)
 *                            or `null` when not found / not owned.
 *
 * Out of scope per AAP §0.7.2: no `update`, no `delete`. Future
 * stories may add them — the interface and the underlying repository
 * already support `updatePayload`, but this milestone does not expose
 * it through the service.
 */
export interface DesignService {
  /**
   * Create a new design owned by the authenticated user (ST-027).
   *
   * Validates input (ST-027-AC3), persists the row (ST-027-AC1), and
   * returns the canonical record including the server-assigned id and
   * timestamps (ST-027-AC2).
   *
   * @throws {ValidationError} when input fails validation (HTTP 400).
   * @throws Native pg error (FK violation `23503`) when `userId` does
   *   not exist in the `users` table — the route layer translates to
   *   HTTP 401 (the user identity is invalid).
   */
  create(params: CreateDesignParams): Promise<Design>;

  /**
   * List the designs owned by the authenticated user (ST-028).
   *
   * Returns at most `limit` designs ordered by `last_modified_at DESC,
   * id DESC` (ST-028-AC4). The page object includes a `nextCursor`
   * field that is `null` when there are no more rows (ST-028-AC3 — an
   * empty page has `items: []` and `nextCursor: null`).
   *
   * @throws {ValidationError} when `limit` is supplied but invalid
   *   (HTTP 400).
   * @throws Native repository error when the supplied cursor cannot
   *   be decoded — the route layer translates to HTTP 400.
   */
  listByUser(params: ListDesignsParams): Promise<DesignListPage>;

  /**
   * Look up a single design by id, with ownership enforced.
   *
   * Returns `null` when the design does not exist OR the caller does
   * not own it. The two cases are intentionally indistinguishable
   * (defense-in-depth: a caller cannot probe for the existence of
   * other users' designs).
   *
   * @throws {ValidationError} when `designId` or `userId` is missing
   *   (HTTP 400).
   */
  getById(params: GetDesignByIdParams): Promise<Design | null>;
}

/**
 * Dependencies required by {@link createDesignService}.
 *
 * Members exposed (per the file's export schema):
 *   - `designRepository` — the data-access layer for the `designs`
 *                           table (ST-027 / ST-028 / ST-029).
 *   - `gcsService`       — reserved for future enrichment of design
 *                           payload logo references with signed read
 *                           URLs. Currently retained in the deps
 *                           closure so adding read-URL enrichment
 *                           later does not require a composition-root
 *                           refactor. The factory validates its
 *                           presence at construction time so a
 *                           misconfigured wiring fails fast at
 *                           startup rather than at first request.
 */
export interface DesignServiceDeps {
  /** Data-access layer for the `designs` table. */
  designRepository: DesignRepository;
  /**
   * Reserved for future signed-URL enrichment of design payload logo
   * references. Validated at factory construction time; the service
   * methods do not currently invoke it.
   */
  gcsService: GcsService;
}

// ---------------------------------------------------------------------------
// Section 5: Factory implementation
// ---------------------------------------------------------------------------

/**
 * Construct a {@link DesignService} bound to the supplied repositories
 * and adapters.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createDesignService({ designRepository, gcsService })`) — easier
 *     to mock in unit tests than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream — a
 *     defensive measure against a class of bugs that are typically
 *     very hard to diagnose.
 *   - The methods are defined on the literal directly so destructured
 *     access (`const { create } = designService;`) behaves identically
 *     to property access — no `this`-binding confusion.
 *   - There is no per-instance state to encapsulate; a class would
 *     add ceremony without benefit.
 *
 * Compose-time fail-fast (Rule R8):
 *   The factory throws a descriptive `Error` synchronously when any
 *   dependency is missing. TypeScript's `strict` null checks already
 *   catch most of these at compile time, but the runtime checks
 *   defend against `any`-cast call sites and JS callers (e.g. ad-hoc
 *   test harnesses that bypass the type system).
 *
 * @param deps The dependency bundle. Both `designRepository` and
 *   `gcsService` are required even though `gcsService` is not yet
 *   invoked — see {@link DesignServiceDeps} for rationale.
 * @returns A frozen {@link DesignService} ready for use.
 */
export function createDesignService(deps: DesignServiceDeps): DesignService {
  // -------------------------------------------------------------------
  // Step 1: Compose-time dependency validation (Rule R8 fail-closed).
  //
  // Each missing dep produces a descriptive error so a developer can
  // identify the misconfigured wiring without consulting source.
  // -------------------------------------------------------------------
  if (deps === undefined || deps === null || typeof deps !== 'object') {
    throw new Error('createDesignService: deps argument is required and must be an object');
  }
  if (deps.designRepository === undefined || deps.designRepository === null) {
    throw new Error('createDesignService: designRepository dependency is required');
  }
  if (deps.gcsService === undefined || deps.gcsService === null) {
    throw new Error('createDesignService: gcsService dependency is required');
  }

  // -------------------------------------------------------------------
  // Step 2: Bind the repository for use in the closure.
  //
  // `gcsService` is intentionally NOT destructured at this revision —
  // the service has no current call site that requires it, and the
  // TypeScript `noUnusedLocals` strict-mode check would flag a bound-
  // but-unused local. Future code adding signed-URL enrichment of
  // logo references should bind it via `const { gcsService } = deps;`
  // alongside `designRepository`. The validation above guarantees the
  // dependency was provided; the deps object itself is captured by
  // the closure of the returned methods (so a future code change can
  // reach `gcsService` via `deps.gcsService` without altering the
  // factory signature).
  // -------------------------------------------------------------------
  const { designRepository } = deps;

  // -------------------------------------------------------------------
  // Step 3: Build the service record. Each method is defined on the
  // literal directly so destructured access behaves identically to
  // property access. The record is frozen below to prevent
  // monkey-patching.
  // -------------------------------------------------------------------
  const service: DesignService = {
    /**
     * Create a new design — ST-027.
     *
     * Implementation flow:
     *   1. Validate userId, title, and payload (ST-027-AC3 — invalid
     *      input rejected before any side effect).
     *   2. Emit a structural-metadata-only `design.create.received`
     *      log line (Rule R2 — payload contents not logged).
     *   3. Call `designRepository.insert` to persist the row
     *      (ST-027-AC1 — all configurator selections owned by the
     *      authenticated user).
     *   4. Emit a `design.create.persisted` log line with the new
     *      design id.
     *   5. Return the canonical record (ST-027-AC2 — server-assigned
     *      id and timestamps included).
     *
     * Error paths:
     *   - {@link ValidationError} on validation failure (HTTP 400).
     *   - Native pg `foreign_key_violation` (`23503`) when `userId`
     *     does not exist in the `users` table — the route layer
     *     translates to HTTP 401 (the user identity is invalid).
     *   - Native pg error on a vanishingly rare `id` PK collision —
     *     propagates to the route layer's general error handler
     *     (HTTP 500).
     */
    async create(params: CreateDesignParams): Promise<Design> {
      // ---------------------------------------------------------------
      // Validate inputs first. Failures throw before any DB contact,
      // satisfying ST-027-AC3 ("...leave the persistence layer
      // unchanged").
      // ---------------------------------------------------------------
      const userId = validateUserId(params.userId);
      const title = validateTitle(params.title);
      const payload = validateAndNormalizePayload(params.payload);

      // ---------------------------------------------------------------
      // Structural log emission (Rule R2-safe).
      //
      // We log STRUCTURAL metadata (event name, uid, title length,
      // logo presence boolean) — never the payload contents
      // themselves. Logging the payload would risk leaking arbitrary
      // client-supplied keys (e.g. a hostile `password` field) even
      // though the allow-list above drops those before they reach the
      // DB. Defense in depth: do not log what we do not need.
      // ---------------------------------------------------------------
      logger.info(
        {
          event: 'design.create.received',
          uid: userId,
          titleLength: title.length,
          payloadHasLogo: payload.logo !== undefined,
        },
        'creating new design',
      );

      // ---------------------------------------------------------------
      // Persist via the repository. The repository performs its own
      // SQL-injection-safe parameter binding and returns the
      // canonical row including the DB-assigned id, created_at, and
      // last_modified_at.
      // ---------------------------------------------------------------
      const insertParams: InsertDesignParams = {
        userId,
        title,
        payload,
      };
      const design = await designRepository.insert(insertParams);

      logger.info(
        {
          event: 'design.create.persisted',
          uid: userId,
          designId: design.id,
        },
        'design persisted',
      );

      // Return the canonical record verbatim (ST-027-AC2). The route
      // layer JSON-serialises this for the HTTP response.
      return design;
    },

    /**
     * List the designs owned by the authenticated user — ST-028.
     *
     * Implementation flow:
     *   1. Validate userId, validate-and-clamp limit (ST-028-AC5 —
     *      bounded page size).
     *   2. Forward the opaque cursor verbatim to the repository (the
     *      repository owns cursor encoding/decoding).
     *   3. Call `designRepository.listByUser` which orders by
     *      `last_modified_at DESC, id DESC` (ST-028-AC4 — deterministic
     *      ordering).
     *   4. Emit a structural log line with the page size and a
     *      hasNextCursor boolean.
     *   5. Return the page (ST-028-AC2 — ids, titles, last-modified
     *      timestamps; ST-028-AC3 — empty collection on no results).
     *
     * Error paths:
     *   - {@link ValidationError} on bad userId or invalid limit
     *     (HTTP 400).
     *   - Native repository error when the cursor cannot be decoded —
     *     the route layer translates to HTTP 400.
     */
    async listByUser(params: ListDesignsParams): Promise<DesignListPage> {
      // Validate user, clamp limit, normalise cursor.
      const userId = validateUserId(params.userId);
      const limit = validateAndClampLimit(params.limit);
      // Cursor is forwarded verbatim. We coerce to a string when
      // present so a non-string sneaking through the route layer (e.g.
      // a query string handler that returns `string | string[]`) is
      // normalised into the repository's expected shape.
      const cursor = params.cursor === undefined ? undefined : String(params.cursor);

      const repoParams: ListDesignsByUserParams = {
        userId,
        limit,
        cursor,
      };

      const page = await designRepository.listByUser(repoParams);

      logger.info(
        {
          event: 'design.list.returned',
          uid: userId,
          count: page.items.length,
          hasNextCursor: page.nextCursor !== null,
        },
        'designs listed',
      );

      return page;
    },

    /**
     * Look up a single design by id with ownership enforced.
     *
     * Implementation flow:
     *   1. Validate userId and designId (ValidationError on missing).
     *   2. Call `designRepository.findById` which filters by `user_id`
     *      in SQL — a request that supplies the correct designId but
     *      the wrong userId already returns `null` from the repository.
     *   3. Defense-in-depth: if the repository ever returned a row
     *      whose `userId` did not match the requested userId, mask it
     *      as `null` and emit a `warn`-level structural log so
     *      operators see the anomaly. This branch SHOULD NEVER fire
     *      in correct operation; it is purely a safety net.
     *   4. Return the design or `null`.
     *
     * Error paths:
     *   - {@link ValidationError} on bad userId / designId (HTTP 400).
     *   - Native pg error when `designId` is not a valid UUID —
     *     propagates as HTTP 500 (the route layer SHOULD prevent this
     *     by validating UUID shape upstream, but the repository's
     *     `::uuid` cast is the final guard).
     */
    async getById(params: GetDesignByIdParams): Promise<Design | null> {
      const userId = validateUserId(params.userId);
      const designId = validateDesignId(params.designId);

      const repoParams: FindDesignByIdParams = { userId, designId };
      const design = await designRepository.findById(repoParams);

      // Defense-in-depth ownership check. The repository SQL filters
      // by `user_id = $1` so this branch should never fire; but if a
      // future repository refactor loosens that contract, the service
      // layer still enforces the invariant.
      if (design !== null && design.userId !== userId) {
        logger.warn(
          {
            event: 'design.getById.ownership_mismatch',
            uid: userId,
            designId,
            designOwnerUid: design.userId,
          },
          'design ownership mismatch at service layer; masking as not found',
        );
        return null;
      }

      return design;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a service method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(service);
}
