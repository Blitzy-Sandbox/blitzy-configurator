/**
 * Session Validation Middleware — ST-026 contract
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/middleware/session.ts — Session validation: extract
 *        bearer, call `verifyIdToken`, check `sessions` revocation marker,
 *        attach `uid` to request"
 *   - AAP §0.6.4 Track 1 Backend T1-C:
 *       "ST-026 session validation contract; applies to all `/api/*`
 *        except `/api/auth/register` and `/api/auth/login`"
 *   - AAP §0.8.1 Rule C2 (verbatim):
 *       "The authentication middleware MUST extract the rawBearerToken
 *        from the Authorization: Bearer <token> header and call
 *        admin.auth().verifyIdToken(rawBearerToken) exclusively."
 *   - AAP §0.8.1 Rule R3 (verbatim):
 *       "Token validation MUST call admin.auth().verifyIdToken()
 *        exclusively. No jsonwebtoken, jose, or jwt-decode in
 *        backend/package.json."
 *   - tickets/stories/ST-026-session-validation-middleware-contract.md
 *
 * Rule C2 / R3 — Firebase Admin SDK only:
 *   Token validation is delegated to the injected `sessionService`, which
 *   wraps `admin.auth().verifyIdToken(rawBearerToken)` exclusively. No
 *   custom JWT parsing, signature verification, expiry checking, or JWKS
 *   fetching is permitted in this file. The only `firebase-admin` import
 *   is a TYPE-ONLY import of `DecodedIdToken` — TypeScript erases this at
 *   compile time, so the produced JavaScript contains zero runtime
 *   references to `firebase-admin` here. This is the documented "firewall"
 *   pattern: the middleware never directly imports the SDK at runtime.
 *
 * Rule C5 — Correlation/uid identity propagation:
 *   On successful validation, the middleware updates the correlation store
 *   to attach `uid` as the single permitted identity field. Log records
 *   for authenticated requests therefore carry BOTH `correlationId` and
 *   `uid` — automatically, via the pino mixin in `../logging/pino.ts`.
 *
 * Rule R2 — No credential material in logs:
 *   This middleware NEVER logs the raw bearer token or the decoded token
 *   claims (email, picture, custom claims). Failure-path logs include only
 *   the error class name and a length-bounded error message; the success
 *   log records only `event`, `uid`, and `durationMs`. The pino serializer
 *   allow-list in `../logging/pino.ts` is the SECOND line of defense; this
 *   file's per-call discipline is the FIRST.
 *
 * Rule R8 — Fail-closed:
 *   On any validation failure (missing header, malformed header, invalid
 *   token, revoked session, revocation-check error), the middleware MUST
 *   respond with HTTP 401 and MUST NOT call `next()`. A revocation-check
 *   exception fails closed: we cannot prove the session is valid, so we
 *   reject. Silent pass is forbidden.
 *
 * Composition (factory pattern, per AAP §0.5.2):
 *   The middleware is a FACTORY that takes a `SessionMiddlewareDeps`
 *   object and returns an Express `RequestHandler`. The factory pattern
 *   enables composition-root dependency injection — the concrete
 *   `SessionService` implementation lives in
 *   `backend/src/services/session.service.ts` and is wired in
 *   `backend/src/index.ts`:
 *
 *     app.use('/api', sessionMiddleware({ sessionService }));
 *
 *   ST-026 mandates the middleware is mounted on every protected route
 *   under `/api/*` EXCEPT the public auth endpoints
 *   (`/api/auth/register`, `/api/auth/login`) and the public share read
 *   endpoint (`/api/share/:token`).
 *
 * Forbidden patterns (per AAP Phase 11):
 *   - DO NOT import firebase-admin at runtime (only `import type` allowed).
 *   - DO NOT call `admin.auth().verifyIdToken()` directly.
 *   - DO NOT log the raw bearer token or decoded token claims.
 *   - DO NOT use jsonwebtoken / jose / jwt-decode (Rule R3 forbidden).
 *   - DO NOT read environment variables (deps come through factory).
 *   - DO NOT silently pass on auth failure — Rule R8 fail-closed.
 *   - DO NOT call `next(err)` for auth failures — respond directly.
 *   - DO NOT store full decoded token claims on req — only `req.uid`.
 *   - DO NOT overwrite `correlationId` in the ALS store — only mutate `uid`.
 *
 * Contract Reference:
 *   /tickets/stories/ST-026-session-validation-middleware-contract.md
 */

// ---------------------------------------------------------------------------
// Express Request augmentation — ST-026-AC3 documented contract surface.
// ---------------------------------------------------------------------------
//
// Adding `uid` and `correlationId` to `Express.Request` via TypeScript's
// declaration merging is the canonical Express pattern. Both fields are
// declared OPTIONAL (`?`) because they are populated incrementally during
// the middleware chain:
//   - `correlationId` is set by `correlationMiddleware` (always present
//     after that middleware runs, but absent on routes that bypass it).
//   - `uid` is set by THIS middleware after a successful `verifyIdToken`
//     + revocation check (always absent on public routes; always present
//     on protected routes after this middleware runs).
//
// The augmentation is also declared in `./correlation.ts`. TypeScript's
// declaration merging rules state that multiple modules declaring the
// same `Express.Request` interface produce a single merged type with
// the union of all members — so re-declaring both fields here is
// idempotent and matches the convention established by correlation.ts.
//
// The `eslint-disable-next-line` is necessary because
// `@typescript-eslint/no-namespace` flags `namespace` declarations by
// default; `declare global { namespace Express { ... } }` is the
// canonical Express type-augmentation pattern documented in
// `@types/express` and used throughout the StrikeForge backend.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Authenticated Firebase Auth user ID, set by `sessionMiddleware` on
       * successful `verifyIdToken()` + revocation check. Unset on public
       * routes (register, login, share read).
       *
       * Per Rule C5 and ST-026-AC3, this is the SOLE identity field
       * attached to the request beyond the correlation ID. Route handlers
       * MUST read `req.uid` (not full token claims) to identify the
       * authenticated user.
       */
      uid?: string;
      /**
       * Request-scoped correlation ID, set by `correlationMiddleware`.
       * Always present on routes that run after `correlationMiddleware`
       * in the middleware chain.
       */
      correlationId?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention: Node built-ins → third-party (type-only first) → relative.
// Within each block, alphabetical ordering.
//
// `import type` syntax produces ZERO runtime emit per TypeScript spec —
// these imports are erased entirely by the compiler. This is the Rule R3
// "firewall" pattern: `firebase-admin/auth` appears only as a type
// reference; the produced .js file has no `require('firebase-admin')`.

import type { DecodedIdToken } from 'firebase-admin/auth';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../logging/pino';
import { correlationStore } from './correlation';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * SessionService contract consumed by `sessionMiddleware`.
 *
 * Concrete implementation lives in
 * `backend/src/services/session.service.ts`. The service injects:
 *   - The Firebase `Auth` instance (from `auth/firebase-admin.ts`) for
 *     `verifyIdToken()` calls (Rule R3 firewall — only the service calls
 *     the SDK).
 *   - The `session.repository.ts` for revocation lookup against the
 *     PostgreSQL `sessions` table.
 *
 * Per Rule R3: `verifyToken` MUST internally call
 * `admin.auth().verifyIdToken()` and nothing else. This middleware never
 * calls `firebase-admin` directly. Structural typing means a service does
 * not need to import this interface — duck typing suffices — but the
 * interface is exported so integration tests can type their mocks
 * correctly (and so `index.ts` composition can declare its parameter
 * type explicitly).
 */
export interface SessionService {
  /**
   * Verify the inbound bearer token against Firebase Auth.
   *
   * Implementation MUST call `admin.auth().verifyIdToken(rawBearerToken)`
   * exclusively (Rule R3). The decoded token contains the user identity
   * (`uid`) and other claims; this middleware only reads `uid`.
   *
   * @param rawBearerToken - The token extracted from the
   *   `Authorization: Bearer <token>` header (with the "Bearer " prefix
   *   already stripped and surrounding whitespace trimmed).
   * @returns The decoded token; at minimum contains `uid`.
   * @throws any error if the token is invalid, expired, malformed, or
   *   the verification call itself fails (e.g. network error reaching
   *   the Firebase Auth emulator). The middleware treats any thrown
   *   error as `INVALID_SESSION` per ST-026-AC2 and Rule R8.
   */
  verifyToken(rawBearerToken: string): Promise<DecodedIdToken>;

  /**
   * Check whether a session for this `uid` + `rawBearerToken` has been
   * revoked.
   *
   * Implementation reads the `sessions` table revocation marker that is
   * flipped by the logout endpoint (ST-025). Per ST-026-AC2, revoked
   * sessions are rejected with the SAME public error code
   * (`INVALID_SESSION`) as invalid tokens, preventing enumeration
   * attacks (the distinction lives only in server logs).
   *
   * @param uid - The Firebase user ID from the decoded token.
   * @param rawBearerToken - The raw bearer token; implementations may
   *   hash or fingerprint it to look up the corresponding session row.
   * @returns `true` if the session is revoked (reject the request);
   *   `false` if the session is active.
   * @throws if the revocation lookup itself fails (database unreachable,
   *   query error, etc.). Per Rule R8, the middleware fail-closes and
   *   rejects the request when this throws.
   */
  isRevoked(uid: string, rawBearerToken: string): Promise<boolean>;

  /**
   * Ensure a local `users` row exists for the supplied uid —
   * QA Final B Issue #7 fix (Just-In-Time user mirroring).
   *
   * The frontend authenticates end users directly via the Firebase JS
   * SDK and bypasses the backend `/api/auth/register` endpoint, so a
   * Firebase-authenticated user reaching a protected route may NOT have
   * a corresponding row in our local `users` table. The first attempt
   * to persist a design (which has a foreign key to `users`) would
   * therefore surface as a generic HTTP 500 (PostgreSQL `23503` FK
   * violation). This method idempotently creates the missing row.
   *
   * Concrete implementation lives in
   * `backend/src/services/session.service.ts`. The middleware MUST
   * call this method on every authenticated request AFTER `verifyToken`
   * and `isRevoked` succeed and BEFORE `req.uid` is set.
   *
   * Per Rule R8 (fail-closed): if this method throws, the middleware
   * MUST treat it as `INVALID_SESSION` and respond with HTTP 401 — we
   * cannot prove the user can be safely admitted, so we reject.
   *
   * Per Rule R2 (no credential material in logs): the implementation
   * logs ONLY `uid` and `emailPresent` (boolean). Raw email values are
   * NEVER logged.
   *
   * @param params Object with `uid` (required) and `email` (optional).
   * @returns Resolves when a row is guaranteed to exist for `uid`.
   * @throws if the underlying find or insert fails for any reason
   *   other than a UNIQUE-violation race condition (which is treated
   *   as success internally).
   */
  ensureUser(params: { uid: string; email?: string }): Promise<void>;
}

/**
 * Dependencies required by the `sessionMiddleware` factory.
 *
 * The factory pattern is mandated by the composition root snippet in
 * `backend/src/index.ts`:
 *
 *   app.use('/api', sessionMiddleware({ sessionService }));
 *
 * Using a destructuring-object shape (rather than a positional argument)
 * makes the middleware extensible: future dependencies can be added
 * without breaking existing call sites. It also documents each dependency
 * by name at the call site, which is operationally useful.
 */
export interface SessionMiddlewareDeps {
  sessionService: SessionService;
}

// ---------------------------------------------------------------------------
// Error codes (public surface — re-exported below)
// ---------------------------------------------------------------------------

/**
 * Distinct error codes for session validation failures.
 *
 * Per ST-026-AC1 / AC2:
 *   - AC1 ("requests without a session token") -> `UNAUTHENTICATED` or
 *     `MALFORMED_AUTHORIZATION` (the latter is a sub-case for a present
 *     but malformed Authorization header — both are "no valid token").
 *   - AC2 ("expired, malformed, or revoked tokens") -> `INVALID_SESSION`,
 *     distinct from `UNAUTHENTICATED`.
 *
 * The HTTP status remains 401 for all three failure paths; operators
 * distinguish them via log events and via the `code` field in the
 * response body. Revocation is masked as `INVALID_SESSION` (not a
 * separate code) by design — this prevents enumeration attacks where a
 * threat actor could differentiate "token never existed" from "token was
 * once valid, now revoked". The internal log events DO distinguish the
 * two for operator visibility.
 *
 * Re-exported at the bottom of this file so integration tests can assert
 * on specific error codes:
 *
 *   import { ERROR_CODES } from '../src/middleware/session';
 *   expect(body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
 *
 * The `as const` assertion narrows each value to its literal type, so
 * downstream consumers receive the precise union
 * `'UNAUTHENTICATED' | 'MALFORMED_AUTHORIZATION' | 'INVALID_SESSION'`.
 */
const ERROR_CODES = {
  /** No Authorization header present. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Authorization header present but does not begin with `Bearer `. */
  MALFORMED_AUTHORIZATION: 'MALFORMED_AUTHORIZATION',
  /** Bearer token present but rejected by verifyIdToken or revoked. */
  INVALID_SESSION: 'INVALID_SESSION',
} as const;

/**
 * Human-readable error messages corresponding to each error code.
 *
 * Messages are written for DEVELOPERS (this is an API, not a user-facing
 * site) and intentionally do NOT leak implementation details. "Session
 * is invalid, expired, or revoked." is sufficient — developers can
 * inspect server logs for the specific reason. This is a deliberate
 * information-leakage control aligned with the ST-026-AC2 prevent-
 * enumeration design.
 */
const ERROR_MESSAGES = {
  [ERROR_CODES.UNAUTHENTICATED]: 'Authentication required.',
  [ERROR_CODES.MALFORMED_AUTHORIZATION]: 'Authorization header must use the Bearer scheme.',
  [ERROR_CODES.INVALID_SESSION]: 'Session is invalid, expired, or revoked.',
} as const;

/**
 * The literal union of valid error code strings.
 *
 * The `keyof typeof ERROR_CODES` mapped type produces the union of keys;
 * indexing yields the union of values. This narrow type lets
 * `respondUnauthorized` accept ONLY the three valid codes — a future
 * change that accidentally passes a wrong string fails at compile time.
 */
type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Helper: emit a 401 response with structured error body
// ---------------------------------------------------------------------------

/**
 * Send an HTTP 401 response with a structured error body and halt the
 * middleware chain.
 *
 * Per Rule R8, this function MUST NOT call `next()`. The middleware
 * chain terminates here for any failure path.
 *
 * The response body shape `{ error: { code, message } }` is the
 * service-wide error envelope convention. The body contains:
 *   - NO credential material (Rule R2).
 *   - NO sensitive diagnostic data — the client only learns whether a
 *     token was present AND whether it was valid; not why it was
 *     rejected (which lives in server logs).
 *
 * @param res Express `Response` object.
 * @param code The error code to communicate to the client.
 */
function respondUnauthorized(res: Response, code: ErrorCode): void {
  res.status(401).json({
    error: {
      code,
      message: ERROR_MESSAGES[code],
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: extract the bearer token from the Authorization header
// ---------------------------------------------------------------------------

/**
 * Result type for `extractBearerToken`. Discriminated union with a `ok`
 * boolean tag — this shape allows callers to use exhaustive narrowing:
 *
 *   const result = extractBearerToken(header);
 *   if (!result.ok) {
 *     // result.code is ErrorCode here
 *   } else {
 *     // result.token is string here
 *   }
 */
type ExtractResult = { ok: true; token: string } | { ok: false; code: ErrorCode };

/**
 * Extract the raw bearer token from an Authorization header value.
 *
 * Returns the token string on success, or a specific error code on
 * failure. The contract follows RFC 6750 §2.1 with one documented
 * permissive deviation:
 *   - The "Bearer " prefix is treated case-insensitively. RFC 6750
 *     specifies case-sensitive "Bearer", but in practice many clients
 *     emit lowercase ("bearer ..."), and rejecting them produces a
 *     poor developer experience. The case-insensitive parse is
 *     documented and consistent across the StrikeForge backend.
 *
 * Edge cases (each maps to a distinct error code):
 *   - `undefined` / `null`         -> `UNAUTHENTICATED`
 *   - empty / whitespace-only      -> `UNAUTHENTICATED`
 *   - non-string (rare; defense)   -> `UNAUTHENTICATED`
 *   - present but no "Bearer "     -> `MALFORMED_AUTHORIZATION`
 *   - "Bearer " with empty token   -> `MALFORMED_AUTHORIZATION`
 *   - valid Bearer + token         -> `{ ok: true, token: <stripped> }`
 *
 * Express may present a header as `string | string[]` (when the same
 * header appears multiple times in the request); we take the first
 * element of an array, matching Express's own `req.header()` behaviour.
 *
 * @param authHeader The raw value of `req.headers.authorization`.
 * @returns Discriminated union: `{ ok: true, token }` or
 *   `{ ok: false, code }`.
 */
function extractBearerToken(authHeader: string | string[] | undefined): ExtractResult {
  // Step 1: handle absent / null header.
  if (authHeader === undefined || authHeader === null) {
    return { ok: false, code: ERROR_CODES.UNAUTHENTICATED };
  }

  // Step 2: normalise array-valued headers to a single string.
  // RFC 7230 allows multiple values for the same header name; in practice
  // Express collapses to either string or string[]. Take the first
  // element to match Express's own `req.header(name)` behaviour.
  const headerValue: string | undefined = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  // Step 3: defensive type and emptiness check.
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return { ok: false, code: ERROR_CODES.UNAUTHENTICATED };
  }

  const trimmed: string = headerValue.trim();

  // Step 4: verify the Bearer scheme prefix (case-insensitive).
  // The regex `^Bearer\s+/i` requires:
  //   - "Bearer" at start (case-insensitive via /i flag)
  //   - at least one whitespace character after "Bearer"
  // This rejects "Basic ..." (Basic auth), "Bearer<no-space>...", and
  // any other non-Bearer scheme.
  const bearerPrefix = /^Bearer\s+/i;
  if (!bearerPrefix.test(trimmed)) {
    return { ok: false, code: ERROR_CODES.MALFORMED_AUTHORIZATION };
  }

  // Step 5: strip the prefix and validate the remaining token is non-empty.
  const token: string = trimmed.replace(bearerPrefix, '').trim();
  if (token.length === 0) {
    return { ok: false, code: ERROR_CODES.MALFORMED_AUTHORIZATION };
  }

  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Public: the middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the session validation middleware.
 *
 * Usage (composition root, see `backend/src/index.ts`):
 *
 * ```ts
 * import { sessionMiddleware } from './middleware/session';
 * import { sessionService } from './services/session.service';
 *
 * app.use('/api', sessionMiddleware({ sessionService }));
 * ```
 *
 * The factory pattern keeps the middleware pure (no module-level mutable
 * state), enables dependency injection (trivial mocking in tests), and
 * fails fast at composition time if dependencies are missing.
 *
 * Performance contract (ST-026-AC4): the middleware emits a
 * `session.validated` log record on success with a `durationMs` field
 * for empirical P95 latency tracking. Operators query:
 *
 *   docker compose logs backend --tail 100 \
 *     | jq 'select(.event == "session.validated") | .durationMs' \
 *     | sort -n
 *
 * to derive the P95 budget. The Prometheus histogram in
 * `backend/src/routes/metrics.ts` captures the same timing for SLO
 * dashboards (ST-049-AC5).
 *
 * @param deps Object containing the `sessionService` to delegate to.
 * @returns An Express `RequestHandler` ready for `app.use(...)`.
 * @throws synchronously at composition time if `deps.sessionService` is
 *   missing or does not implement the required methods. This is a
 *   developer-ergonomics check, not a production failure path — runtime
 *   never sees a missing service because the factory throws at startup.
 */
export function sessionMiddleware(deps: SessionMiddlewareDeps): RequestHandler {
  // Guard against `undefined` / `null` deps argument; TypeScript's `strict`
  // null checks already catch most of these at compile time, but the
  // runtime check defends against `any`-cast call sites and JS callers.
  if (deps === undefined || deps === null) {
    throw new Error('sessionMiddleware: deps argument is required');
  }

  const { sessionService } = deps;

  // Compose-time fail-fast: a missing `sessionService` or a service that
  // does not implement the required methods is a developer error and
  // MUST surface immediately at app boot rather than at request time.
  // This is consistent with the Rule R4 fail-closed startup posture.
  if (
    sessionService === undefined ||
    sessionService === null ||
    typeof sessionService.verifyToken !== 'function'
  ) {
    throw new Error('sessionMiddleware: sessionService.verifyToken is required');
  }
  if (typeof sessionService.isRevoked !== 'function') {
    throw new Error('sessionMiddleware: sessionService.isRevoked is required');
  }
  // QA Final B Issue #7 — JIT user creation. The middleware MUST be
  // able to call `ensureUser` on every authenticated request to mirror
  // Firebase-authenticated users into the local `users` table before
  // they reach any FK-bearing route handler. A missing `ensureUser` is
  // a developer error and MUST surface at app boot per Rule R4 fail-
  // fast posture.
  if (typeof sessionService.ensureUser !== 'function') {
    throw new Error('sessionMiddleware: sessionService.ensureUser is required');
  }

  /**
   * The actual session-validation middleware.
   *
   * SYNCHRONOUS RequestHandler that delegates to an async worker. This
   * pattern is used throughout the StrikeForge backend (see
   * `backend/src/routes/health.ts` for the canonical example) so that:
   *
   *   - The handler matches Express's `void`-returning `RequestHandler`
   *     type exactly.
   *   - The project's `@typescript-eslint/no-misused-promises` ESLint
   *     rule is satisfied — async functions are not passed where a
   *     `void`-returning function is expected.
   *   - The async worker's `await` syntax remains readable.
   *
   * The `void` operator on the worker call is the canonical TypeScript
   * idiom for "I am intentionally ignoring this Promise" and silences
   * `@typescript-eslint/no-floating-promises`. The `.catch()` handler
   * forwards any UNEXPECTED error (a programming defect in this file or
   * an unexpected throw in `sessionService` that wasn't caught by the
   * inner try/catch) to Express's error chain via `next(err)`.
   *
   * Under normal operation, the worker NEVER throws — every auth failure
   * path produces a 401 response and a fulfilled `void` promise.
   *
   * The function is named `sessionMiddlewareHandler` (not anonymous) so
   * stack traces and profilers display a meaningful name.
   */
  return function sessionMiddlewareHandler(req: Request, res: Response, next: NextFunction): void {
    void runSessionValidation(sessionService, req, res, next).catch((err: unknown) => {
      // This catch handles UNEXPECTED errors from the async worker —
      // i.e. a programming defect in this file or any code path the
      // worker does not internally handle. Per Express conventions,
      // forward to the central error handler. Note that the worker's
      // own try/catch blocks already convert documented auth failure
      // paths into 401 responses; reaching this catch indicates a
      // bug, not an auth failure.
      next(err);
    });
  };
}

// ---------------------------------------------------------------------------
// Private async worker
// ---------------------------------------------------------------------------

/**
 * Async worker that performs the actual session validation.
 *
 * Separated from the public `RequestHandler` for two reasons:
 *
 *   1. The public handler must return `void` (not `Promise<void>`) to
 *      match Express's `RequestHandler` type and the project's
 *      `@typescript-eslint/no-misused-promises` ESLint rule.
 *   2. The async worker's `await` syntax remains readable and the
 *      validation pipeline is straight-line — no callback nesting.
 *
 * The worker's contract:
 *
 *   - Resolves with `void` on every documented outcome (success AND
 *     auth failures). Auth failures are NOT exceptions — they are
 *     documented business outcomes that produce a 401 response and a
 *     fulfilled `void` promise.
 *   - REJECTS only on UNEXPECTED errors (programming defects). The
 *     calling handler forwards those to Express's error chain.
 *
 * @param sessionService Injected service with `verifyToken` and
 *   `isRevoked` methods (Rule R3 firewall).
 * @param req Express request object.
 * @param res Express response object.
 * @param next Express next callback (called only on the success path).
 */
async function runSessionValidation(
  sessionService: SessionService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // High-resolution start timestamp for `durationMs` measurement.
  // `process.hrtime.bigint()` returns nanoseconds (BigInt). We convert
  // to Number (milliseconds with 3-decimal precision) at the success-
  // path log emission below; Number can safely represent the duration
  // (single-request latencies are sub-millisecond to sub-second, well
  // within Number's 2^53 safe integer range when expressed in ns).
  const startNs: bigint = process.hrtime.bigint();

  // -------------------------------------------------------------------
  // Step 1: Extract the bearer token from the Authorization header
  // (ST-026-AC1: reject requests without a valid session token).
  // -------------------------------------------------------------------
  const extraction = extractBearerToken(req.headers.authorization);
  if (!extraction.ok) {
    const code = extraction.code;

    // Internal reason sub-tag distinguishes "no header" from "bad
    // header format" for operator debugging. Both surface the same
    // public information posture: the request is rejected.
    const reason: string =
      code === ERROR_CODES.UNAUTHENTICATED
        ? 'missing_authorization_header'
        : 'malformed_authorization_header';

    logger.info(
      {
        event: 'session.rejected',
        reason,
        code,
      },
      'session validation rejected: header contract violation',
    );
    respondUnauthorized(res, code);
    return;
  }

  const rawBearerToken: string = extraction.token;

  // -------------------------------------------------------------------
  // Step 2: Verify the token via Firebase Admin SDK (Rule R3 / C2).
  //
  // The verification is delegated to the injected `sessionService`,
  // which internally calls `admin.auth().verifyIdToken(rawBearerToken)`.
  // Any thrown error (auth/id-token-expired, auth/argument-error,
  // network failure, etc.) is treated as `INVALID_SESSION` per
  // ST-026-AC2 and Rule R8.
  //
  // Rule R2: the error class name and a length-bounded message are
  // logged; the raw token is NEVER logged. The 200-character message
  // truncation is defense-in-depth against the rare Firebase error
  // path that includes a fragment of the token in its message.
  // -------------------------------------------------------------------
  let decodedToken: DecodedIdToken;
  try {
    decodedToken = await sessionService.verifyToken(rawBearerToken);
  } catch (err) {
    const errorName: string = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage: string =
      err instanceof Error ? String(err.message).slice(0, 200) : 'verification failed';

    logger.info(
      {
        event: 'session.rejected',
        reason: 'verify_id_token_failed',
        code: ERROR_CODES.INVALID_SESSION,
        errorName,
        errorMessage,
      },
      'session validation rejected: token verification failed',
    );
    respondUnauthorized(res, ERROR_CODES.INVALID_SESSION);
    return;
  }

  // -------------------------------------------------------------------
  // Step 2a: Defensive uid validation.
  //
  // `verifyIdToken` should always return a token with a non-empty
  // string `uid`, but we guard against future SDK evolution or
  // misconfiguration. An empty/missing uid is treated as
  // `INVALID_SESSION` and logged at warn level (this is unusual
  // enough to deserve operator attention).
  // -------------------------------------------------------------------
  const uid: string = decodedToken.uid;
  if (typeof uid !== 'string' || uid.length === 0) {
    logger.warn(
      {
        event: 'session.rejected',
        reason: 'decoded_token_missing_uid',
        code: ERROR_CODES.INVALID_SESSION,
      },
      'session validation rejected: decoded token has no uid',
    );
    respondUnauthorized(res, ERROR_CODES.INVALID_SESSION);
    return;
  }

  // -------------------------------------------------------------------
  // Step 3: Check the revocation marker (ST-025 / ST-026-AC2).
  //
  // The logout endpoint (ST-025) flips the revocation marker on the
  // `sessions` row corresponding to the issued token. A revoked
  // session is rejected with the SAME public error code
  // (`INVALID_SESSION`) as an invalid token to prevent enumeration
  // attacks; the distinction lives only in server logs.
  //
  // Rule R8 fail-closed: if the revocation lookup itself fails
  // (database unreachable, query error), we CANNOT prove the session
  // is valid and MUST reject. A naive implementation might "assume
  // valid" to avoid user-facing errors, but Rule R8 mandates the
  // opposite: a tooling failure produces a failed verdict, not a
  // silent pass.
  // -------------------------------------------------------------------
  let revoked: boolean;
  try {
    revoked = await sessionService.isRevoked(uid, rawBearerToken);
  } catch (err) {
    const errorName: string = err instanceof Error ? err.name : 'UnknownError';

    logger.error(
      {
        event: 'session.rejected',
        reason: 'revocation_check_failed',
        code: ERROR_CODES.INVALID_SESSION,
        errorName,
        uid,
      },
      'session validation rejected: revocation lookup failed (fail-closed per R8)',
    );
    respondUnauthorized(res, ERROR_CODES.INVALID_SESSION);
    return;
  }

  if (revoked) {
    logger.info(
      {
        event: 'session.rejected',
        reason: 'revoked',
        code: ERROR_CODES.INVALID_SESSION,
        uid,
      },
      'session validation rejected: session is revoked',
    );
    respondUnauthorized(res, ERROR_CODES.INVALID_SESSION);
    return;
  }

  // -------------------------------------------------------------------
  // Step 3b: Just-In-Time user mirroring — QA Final B Issue #7 fix.
  //
  // Background:
  //   The frontend (`frontend/src/auth/firebase-client.ts`)
  //   authenticates end users directly via the Firebase JS SDK and
  //   never invokes our `/api/auth/register` endpoint. As a result,
  //   the very first protected request from a Firebase-authenticated
  //   user reaches this middleware with NO corresponding row in the
  //   local `users` table. Without remediation, the next FK-bearing
  //   write (e.g. `INSERT INTO designs ... user_id = uid`) surfaces
  //   as PostgreSQL `23503` (foreign key violation) which the global
  //   error handler maps to a generic HTTP 500 — observed by QA as
  //   "first design save returns 500".
  //
  // Resolution:
  //   Call `sessionService.ensureUser({ uid, email })` to idempotently
  //   create the missing row. Implementations MUST be:
  //     - O(1)/O(log n) on the common path (PK index lookup) so this
  //       step does not regress ST-026-AC4 latency.
  //     - Idempotent (calling twice returns the same outcome).
  //     - Concurrency-safe (two simultaneous first-requests for the
  //       same uid resolve to one inserted row, not two errors).
  //
  // Ordering:
  //   This step runs AFTER `verifyToken` and `isRevoked` succeed (so
  //   we know the token is valid and the session is not revoked) and
  //   BEFORE `req.uid = uid` (so a JIT failure produces 401 INVALID_
  //   SESSION rather than allowing the request to proceed without a
  //   local row).
  //
  // Rule R8 fail-closed:
  //   If the JIT step throws (database unreachable, FK violation
  //   against an unrelated row, permission error), we CANNOT prove
  //   the user can be safely admitted to FK-bearing routes and MUST
  //   reject with 401 INVALID_SESSION. A naive implementation might
  //   admit the user anyway and let the downstream FK violation
  //   surface as 500, but Rule R8 mandates the opposite: a tooling
  //   failure produces a failed verdict, not a silent pass.
  //
  // Rule R2 (no credential material in logs):
  //   The decoded Firebase idToken's `email` claim is passed to
  //   `ensureUser` so the JIT-created row can be populated with a
  //   meaningful loginIdentifier. The middleware itself NEVER logs
  //   the email — log records emitted by `ensureUser` use only
  //   `emailPresent` (boolean).
  // -------------------------------------------------------------------
  try {
    // Read `email` from the decoded token via index access to avoid
    // the implicit 'undefined' return with TypeScript's strict mode
    // when `email` is not on the DecodedIdToken type's required
    // fields. The Firebase Admin SDK declares `email` as optional.
    const tokenEmail: unknown = (decodedToken as unknown as Record<string, unknown>)['email'];
    const emailParam: string | undefined =
      typeof tokenEmail === 'string' && tokenEmail.length > 0 ? tokenEmail : undefined;

    await sessionService.ensureUser({ uid, email: emailParam });
  } catch (err) {
    // Per Rule R2: log the error CLASS NAME and a length-bounded
    // message only. Tokens, emails, and stack traces are NEVER
    // logged. Per Rule R8: respond 401 INVALID_SESSION (a tooling
    // failure cannot prove the user is admissible).
    const errorName: string = err instanceof Error ? err.name : 'UnknownError';
    const errorMessage: string =
      err instanceof Error ? String(err.message).slice(0, 200) : 'JIT user creation failed';

    logger.error(
      {
        event: 'session.rejected',
        reason: 'jit_user_create_failed',
        code: ERROR_CODES.INVALID_SESSION,
        errorName,
        errorMessage,
        uid,
      },
      'session validation rejected: JIT user creation failed (fail-closed per R8)',
    );
    respondUnauthorized(res, ERROR_CODES.INVALID_SESSION);
    return;
  }

  // -------------------------------------------------------------------
  // Step 4: Attach identity to request context and update the
  // correlation store (ST-026-AC3 + Rule C5).
  //
  // - `req.uid = uid` is the documented contract per ST-026-AC3 — the
  //   "authenticated user identity attached to the request context".
  //   Route handlers and downstream middleware read `req.uid` to
  //   identify the authenticated user.
  //
  // - `correlationStore.getStore().uid = uid` updates the per-request
  //   `AsyncLocalStorage` context so the pino mixin
  //   (`backend/src/logging/pino.ts`) automatically includes `uid` on
  //   every subsequent log record during the request lifecycle.
  //
  // Mutation pattern: we MUTATE the existing store object in place
  // rather than calling `correlationStore.run({...}, cb)` again.
  // Calling `run` would create a nested ALS frame, which is
  // unnecessary and could complicate async-boundary accounting. The
  // store object reference is stable across the request's async
  // continuations; mutating it is the simpler, correct approach (and
  // is the documented contract from `correlation.ts`).
  //
  // Rule R2 compliance: we store ONLY `uid` in the correlation store
  // — never the raw token, never the decoded token claims (email,
  // picture, custom claims), never any other PII. Per Rule C5, `uid`
  // is the SOLE permitted identity field beyond `correlationId`.
  // -------------------------------------------------------------------
  req.uid = uid;

  const currentStore = correlationStore.getStore();
  if (currentStore !== undefined) {
    // Mutate the existing store object — same reference, so the pino
    // mixin picks up `uid` on subsequent log records automatically.
    currentStore.uid = uid;
  } else {
    // The correlation store is undefined only if `correlationMiddleware`
    // did not run before this middleware (a composition-root bug). We
    // proceed anyway because ST-026 does not depend on correlation ID
    // presence — the session validation contract is independent.
    // Logging a warning provides operator visibility so the composition
    // bug is surfaced and fixed quickly.
    logger.warn(
      {
        event: 'session.correlation_store_missing',
        uid,
      },
      'session middleware ran without an active correlation store; check middleware ordering',
    );
  }

  // -------------------------------------------------------------------
  // Step 5: Emit success log with `durationMs` for P95 tracking
  // (ST-026-AC4).
  //
  // `process.hrtime.bigint()` returns nanoseconds as BigInt. We
  // convert to Number (milliseconds with 3-decimal precision) for
  // pino compatibility (BigInt is not JSON-serializable by default,
  // and pino's serializer prefers Number). The conversion is safe
  // because single-request latencies are well within Number's
  // precision range when expressed in milliseconds.
  //
  // The `durationMs` field is consumed:
  //   - By operators querying log records to derive P95 empirically
  //     (see the `jq` example above).
  //   - By the Prometheus histogram in `backend/src/routes/metrics.ts`
  //     for SLO dashboard tracking (ST-049-AC5).
  // -------------------------------------------------------------------
  const durationNs: bigint = process.hrtime.bigint() - startNs;
  // Number(BigInt) conversion is safe for any duration up to ~285
  // years of nanoseconds; single-request latencies are trivially
  // within the safe range. Divide by 1,000,000 to convert ns -> ms.
  const durationMs: number = Number(durationNs) / 1_000_000;
  // Round to 3 decimal places (microsecond precision) — sufficient for
  // P95 percentile reasoning, while avoiding the noise of float
  // precision artifacts in log records.
  const durationMsRounded: number = Math.round(durationMs * 1000) / 1000;

  logger.info(
    {
      event: 'session.validated',
      uid,
      durationMs: durationMsRounded,
    },
    'session validation succeeded',
  );

  // -------------------------------------------------------------------
  // Step 6: Hand off to the next middleware / route handler.
  //
  // Per Express's middleware contract, calling `next()` without an
  // argument advances to the next middleware (the success path). We
  // intentionally do NOT call `next(err)` anywhere in this file for
  // documented auth failures — auth failures are documented business
  // outcomes, not runtime errors. Responding directly with
  // `res.status(401).json(...)` is more correct (it produces a typed
  // response body) and avoids the error handler accidentally logging
  // the failure as an error (which could leak the request body via
  // `err.body` if upstream body-parser sanitisation is bypassed).
  // -------------------------------------------------------------------
  next();
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Re-export of `ERROR_CODES` for integration tests and other code that
 * needs to assert on specific error codes:
 *
 *   import { ERROR_CODES } from '../middleware/session';
 *   expect(body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
 *
 * This prevents string drift between test and implementation: any future
 * rename of an error code is caught by the type checker because
 * `ERROR_CODES` is a `const` assertion (not a plain object).
 */
export { ERROR_CODES };
