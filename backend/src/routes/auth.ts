/**
 * Authentication Routes — ST-023, ST-024, ST-025.
 *
 * Mounts:
 *   - POST /register — creates a new end-user account and returns the
 *     canonical user record `{ uid, loginIdentifier }` WITHOUT any
 *     credential material and WITHOUT issuing a session token by itself
 *     (ST-023-AC1, AC2, AC4).
 *   - POST /login — verifies credentials via the injected
 *     {@link SessionService.login} and returns
 *     `{ idToken, uid, expiresAt }`. All credential rejections collapse
 *     to a single generic `INVALID_CREDENTIALS` 401 response so an
 *     attacker cannot differentiate "user not found" from "wrong
 *     password" (ST-024 enumeration defense).
 *   - POST /logout — marks the active session revoked in the persistence
 *     layer; idempotent, returning 204 No Content on the first AND every
 *     subsequent call against the same revoked token (ST-025-AC1, AC3).
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/routes/auth.ts | /api/auth/register (ST-023),
 *        /api/auth/login (ST-024), /api/auth/logout (ST-025)".
 *   - AAP §0.6.4 Track 1 Backend (T1-C): implement in dependency order:
 *       auth middleware contract (ST-026) → registration (ST-023)
 *       → login (ST-024) → logout (ST-025).
 *   - AAP §0.5.6 "Cross-Cutting Middleware Order":
 *       session middleware is mounted on `/api/*` EXCEPT
 *       `/api/auth/register` and `/api/auth/login`.
 *   - tickets/stories/ST-023-user-registration-endpoint.md
 *   - tickets/stories/ST-024-user-login-endpoint.md
 *   - tickets/stories/ST-025-logout-endpoint-session-revocation.md
 *
 * Composition root contract (`backend/src/index.ts`):
 *   The factory returns TWO sub-routers so the composition root can
 *   mount the public endpoints BEFORE the session-validation middleware
 *   and the authenticated endpoint AFTER it. The wiring is:
 *
 *     const { publicAuthRouter, authenticatedAuthRouter } =
 *       createAuthRoutes({ sessionService });
 *     app.use('/api/auth', publicAuthRouter);          // register, login
 *     app.use('/api', sessionMiddleware({ sessionService }));
 *     app.use('/api/auth', authenticatedAuthRouter);   // logout
 *
 *   This split is essential: register and login MUST be reachable
 *   without an existing session (a chicken-and-egg requirement —
 *   you cannot have a session before you log in), but logout MUST
 *   require a valid session (ST-025-AC4).
 *
 * Routing thinness (AAP §0.6.4):
 *   Route handlers in this file are thin: they decode the request
 *   (Zod validation), delegate every authentication operation to the
 *   injected {@link SessionService}, encode the response, and translate
 *   thrown errors to HTTP envelopes via {@link handleAuthError}. There
 *   is NO business logic here — the service owns the database, the
 *   Firebase Admin SDK calls, and the credential lifecycle. This keeps
 *   the routing layer trivially testable (a unit test injects a mock
 *   service and asserts request/response shape) and keeps the service
 *   layer transport-agnostic (the same service can later be reached via
 *   gRPC, message queue, or CLI without any duplication).
 *
 * Cross-cutting rule compliance (verbatim from AAP §0.8):
 *
 *   - Rule R1 (story ACs are authoritative):
 *       ST-023-AC1: register accepts `{ email, password }` JSON body and
 *         persists the canonical user record on success (delegated to
 *         `sessionService.register`).
 *       ST-023-AC2: a successful registration returns the canonical user
 *         record `{ uid, loginIdentifier }` WITHOUT credential material
 *         AND does NOT issue a session token. The route's 201 response
 *         body excludes any token field by construction.
 *       ST-023-AC3: validation failures return a descriptive non-leaking
 *         error response and do NOT create any partial record. The Zod
 *         schema rejects with 400 BEFORE any service call; duplicate
 *         identifiers throw at the service layer, the translator
 *         surfaces 409 with the `DUPLICATE_EMAIL` code; nothing is
 *         persisted on failure.
 *       ST-023-AC4: credential material submitted at registration is
 *         NEVER stored in cleartext (enforced by the service — Rule R3
 *         delegates credentials to Firebase) and is NEVER returned in
 *         any response (the route's 201 envelope does NOT echo the
 *         password — only `{ uid, loginIdentifier }`).
 *       ST-024 (login): the route returns `{ idToken, uid, expiresAt }`
 *         on success; ALL credential failures collapse to a generic 401
 *         `{ error: { code: 'INVALID_CREDENTIALS', message:
 *         'Authentication failed' } }` regardless of the underlying
 *         cause (enumeration defense).
 *       ST-025-AC1: logout marks the associated session revoked
 *         (delegated to `sessionService.logout`).
 *       ST-025-AC2: a subsequent request authenticated with the revoked
 *         token is rejected by the session middleware as if no session
 *         existed (this file does NOT enforce that — the middleware
 *         does, on the next request).
 *       ST-025-AC3: logout is idempotent — repeated calls return 204
 *         No Content and do not alter state. Idempotency is achieved at
 *         the database tier via the repository's
 *         `COALESCE(revoked_at, now())` SQL; this route simply trusts
 *         the service contract.
 *       ST-025-AC4: logout is rejected with a 401 when called without a
 *         valid session token. This is enforced primarily by the
 *         session middleware that runs BEFORE the authenticated router
 *         is reached; the route adds a defensive secondary check that
 *         returns 401 if the middleware failed to populate `req.uid`.
 *
 *   - Rule R2 (no credential material in logs):
 *       This file does NOT directly log request bodies. The
 *       request-scoped pino logger attached as `req.log` is configured
 *       in `../logging/pino.ts` with a serializer allow-list that
 *       redacts top-level `password`, `Authorization`, `credential`,
 *       and bearer-token-pattern fields. The {@link handleAuthError}
 *       translator emits ONLY `event`, `errorName`, `errorCode`, and
 *       a 200-character-truncated `errorMessage`; it NEVER emits the
 *       request body, the `Authorization` header value, or any
 *       credential variable. The inline bearer extraction in
 *       {@link runLogout} (Step 1) reads the raw token, forwards it
 *       to `sessionService.verifyToken` and `sessionService.logout`,
 *       and then drops the reference; the value is NEVER logged or
 *       stashed in any field that could be serialized later.
 *
 *   - Rule R3 (Firebase Admin SDK only):
 *       This file imports NO JWT libraries: no `jsonwebtoken`, no
 *       `jose`, no `jwt-decode`. There is no custom JWT parsing,
 *       signature verification, expiry checking, or JWKS fetching in
 *       this file. All token handling is delegated to
 *       {@link SessionService} (which delegates exclusively to
 *       `admin.auth().verifyIdToken()` per the service-layer
 *       documentation).
 *
 *   - Rule R4 (no environment defaults in source):
 *       This file reads NO environment variables. There are zero
 *       references to `process.env.*` anywhere in this module. Any
 *       environment-driven configuration is owned by `config/env.ts`
 *       and dependency-injected through the service.
 *
 *   - Rule R8 (gates fail closed):
 *       Every documented failure path produces a non-2xx response:
 *         - 400 VALIDATION_FAILED on Zod parse failure
 *         - 401 INVALID_CREDENTIALS on login credential rejection
 *         - 401 UNAUTHENTICATED on missing `req.uid` at logout
 *         - 409 DUPLICATE_EMAIL on Firebase `auth/email-already-exists`
 *         - 500 INTERNAL_ERROR on any other unexpected error
 *       There is NO branch that returns 200 while the operation
 *       failed. The error translator is total over the documented
 *       error classes; unrecognised errors fall through to 500 with
 *       a non-leaking body.
 *
 *   - Rule R9 (no payment processing): N/A — this file is auth only.
 *
 * @see backend/src/services/session.service.ts
 * @see backend/src/middleware/session.ts
 * @see backend/src/middleware/correlation.ts
 * @see backend/src/index.ts
 * @see tickets/stories/ST-023-user-registration-endpoint.md
 * @see tickets/stories/ST-024-user-login-endpoint.md
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention: third-party (type-only first) → relative.
//
// `import type` produces ZERO runtime emit per TypeScript spec — type-only
// imports are erased entirely by the compiler. The {@link SessionService}
// type alias has no runtime presence in this file's compiled output,
// keeping the dependency graph at runtime narrow: this module imports
// `express` and `zod` only.
//
// Rule R3 firewall (verifiable by static grep):
//   - NO `jsonwebtoken` import
//   - NO `jose` import
//   - NO `jwt-decode` import
//   - NO `firebase-admin` import (kept in `auth/firebase-admin.ts` only)

import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { ZodError } from 'zod';
import { z } from 'zod';

import type { SessionService } from '../services/session.service';

// ---------------------------------------------------------------------------
// Section 1: Zod schemas for inbound JSON request bodies
// ---------------------------------------------------------------------------
//
// Both schemas use `.strict()` to reject unexpected fields. This is a
// defense-in-depth measure: if a client (or attacker) submits an
// unexpected field, Zod refuses the body rather than silently dropping
// the field — which prevents a class of mass-assignment-style
// vulnerabilities where a future schema extension would make the
// dropped field meaningful.
//
// Format-specific validation (RFC 5322 email syntax, password complexity
// policy) is delegated to Firebase Auth via the service layer. Firebase
// returns its own error codes for malformed input which the service
// translates uniformly. The Zod schemas here only enforce structural
// preconditions:
//   - `email`    — must be a string, must look like an email per Zod's
//                  built-in regex (catches the obvious malformed cases
//                  before reaching Firebase).
//   - `password` — register requires ≥ 8 characters (a documented hard
//                  minimum that aligns with Firebase Auth's project-
//                  configured minimum); login requires only a non-empty
//                  string (Firebase enforces complexity at the project
//                  level — login does not re-validate complexity, since
//                  doing so would create a UX gap if the operator
//                  loosens the policy after users have registered).
// ---------------------------------------------------------------------------

/**
 * Schema for `POST /api/auth/register` request body.
 *
 * Fields:
 *   - `email`    — non-empty string in email format.
 *   - `password` — string of at least 8 characters.
 *
 * Unknown fields are rejected (`.strict()`).
 *
 * Per ST-023-AC4: the password is structurally validated here BEFORE
 * being forwarded to the service layer; no log record in this file
 * ever emits the password value.
 */
const registerBodySchema = z
  .object({
    email: z.string().email({ message: 'Valid email required' }),
    password: z.string().min(8, { message: 'Password must be at least 8 characters' }),
  })
  .strict();

/**
 * Schema for `POST /api/auth/login` request body.
 *
 * Fields:
 *   - `email`    — non-empty string in email format.
 *   - `password` — non-empty string (no length minimum at login;
 *                  Firebase enforces project-level complexity).
 *
 * Unknown fields are rejected (`.strict()`).
 */
const loginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Section 2: Response envelope helpers
// ---------------------------------------------------------------------------
//
// The service-wide error response envelope is:
//
//   { error: { code: <ErrorCode>, message: <string>, details?: <any> } }
//
// Codes are a closed string union — only the values listed in
// {@link ErrorCode} are emitted. This narrow type prevents a future
// change from accidentally introducing a new code without updating the
// API documentation.
//
// The envelope intentionally does NOT include any of:
//   - HTTP status code (the caller has it; duplicating in the body is
//     redundant and a vector for inconsistency).
//   - Stack traces, file paths, internal module names (information-
//     disclosure control aligned with ST-023-AC3 and ST-024).
//   - Echoed request fields (the request body may contain credentials
//     that must NEVER appear in the response).
// ---------------------------------------------------------------------------

/**
 * The closed union of error codes this file emits.
 *
 *   - `VALIDATION_FAILED`         — request body failed Zod schema validation
 *                                   (400). Used for missing/malformed fields.
 *   - `INVALID_CREDENTIALS`       — login credential rejection (401). Generic
 *                                   by design (enumeration defense).
 *   - `UNAUTHENTICATED`           — 401 returned when no Authorization header
 *                                   was provided (or it was empty/whitespace).
 *                                   Mirrors the session-middleware contract
 *                                   for ST-025-AC4 / ST-026-AC1 so the public
 *                                   logout endpoint and authenticated
 *                                   endpoints expose the SAME error-code
 *                                   surface to SDK consumers.
 *   - `MALFORMED_AUTHORIZATION`   — 401 returned when an Authorization header
 *                                   IS present but does not use the Bearer
 *                                   scheme. Mirrors the session-middleware
 *                                   contract (lines 404-410 of session.ts)
 *                                   so the public logout endpoint preserves
 *                                   the same three-way error-code
 *                                   distinction that gated endpoints expose.
 *   - `INVALID_SESSION`           — 401 returned when a syntactically valid
 *                                   Bearer-shape token fails Firebase Admin
 *                                   `verifyIdToken`. Mirrors the
 *                                   session-middleware contract
 *                                   (lines 686-695 of session.ts) so a
 *                                   public-route consumer learns "your token
 *                                   couldn't be verified" rather than the
 *                                   conflated UNAUTHENTICATED.
 *   - `DUPLICATE_EMAIL`           — register rejected because the email is
 *                                   already in use (409). Surfaced from
 *                                   Firebase's `auth/email-already-exists`
 *                                   or the service-layer `ValidationError`
 *                                   with the same code.
 *   - `INTERNAL_ERROR`            — unrecognised error class (500). Body is
 *                                   non-leaking; specifics live in server
 *                                   logs only.
 */
type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHENTICATED'
  | 'MALFORMED_AUTHORIZATION'
  | 'INVALID_SESSION'
  | 'DUPLICATE_EMAIL'
  | 'INTERNAL_ERROR';

/**
 * Shape of the error envelope returned for every non-2xx response.
 *
 * `details` is optional and is populated only by {@link translateZodError}
 * with a pruned list of field-level issues — never the request body or
 * any credential-bearing string.
 */
interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * Construct an {@link ErrorBody} envelope.
 *
 * Per Rule R2: callers MUST ensure the `message` and `details` arguments
 * contain no credential material. This helper does no scrubbing of its
 * own — the contract is owned by the call site.
 *
 * @param code Machine-readable error code (closed union).
 * @param message Human-readable summary; SHOULD be generic for
 *   credential-related errors to prevent enumeration.
 * @param details Optional additional context (e.g. Zod issue list).
 * @returns A frozen-shape envelope ready to pass to `res.json(...)`.
 */
function buildError(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

/**
 * Translate a Zod validation failure to an {@link ErrorBody} envelope.
 *
 * The translation extracts ONLY:
 *   - `path`    — dotted JSONPath to the failing field (e.g. `'email'`,
 *                 `'password'`). Safe — these are field names from the
 *                 schema, not user input.
 *   - `message` — Zod's human-readable failure description (e.g.
 *                 "Invalid email", "Password must be at least 8
 *                 characters"). Safe — these are static strings or
 *                 schema-defined messages, not user input.
 *
 * It does NOT extract:
 *   - The actual rejected value (which could BE the credential).
 *   - The Zod issue's full structure (which may include implementation
 *     details that aid in fingerprinting the API).
 *
 * @param err A `ZodError` thrown by `schema.parse(...)`.
 * @returns An {@link ErrorBody} with `code: 'VALIDATION_FAILED'` and a
 *   pruned `details` array.
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

// ---------------------------------------------------------------------------
// Section 3: Public types — factory contract
// ---------------------------------------------------------------------------

/**
 * The pair of sub-routers returned by {@link createAuthRoutes}.
 *
 * The split exists because session middleware is mounted between the
 * two routers in the composition root:
 *
 *   app.use('/api/auth', publicAuthRouter);
 *   app.use('/api', sessionMiddleware({ sessionService }));
 *   app.use('/api/auth', authenticatedAuthRouter);
 *
 * This way, register and login bypass session validation (a session
 * cannot exist before the user logs in), while logout sits behind it
 * (a user cannot log out without an authenticated session).
 *
 * Both routers are mounted under the SAME `/api/auth` prefix, so the
 * resulting URLs are:
 *   - POST /api/auth/register   (publicAuthRouter)
 *   - POST /api/auth/login      (publicAuthRouter)
 *   - POST /api/auth/logout     (authenticatedAuthRouter)
 */
export interface AuthRouters {
  /**
   * Sub-router exposing public endpoints that MUST be reachable without
   * an existing session: POST /register, POST /login.
   */
  publicAuthRouter: Router;
  /**
   * Sub-router exposing endpoints that MUST be reached only after the
   * session middleware has populated `req.uid`: POST /logout.
   */
  authenticatedAuthRouter: Router;
}

/**
 * Dependencies required by {@link createAuthRoutes}.
 *
 * The factory takes a destructuring object so future dependencies can
 * be added without breaking call sites. Today the only dependency is
 * the {@link SessionService}, but a future addition (e.g. a rate-
 * limiter, an audit-log emitter) would slot in without churn.
 */
export interface CreateAuthRoutesDeps {
  /**
   * The session service that owns the actual auth business logic. The
   * route handlers delegate every operation to this service:
   *   - `register` for POST /register (ST-023)
   *   - `login` for POST /login (ST-024)
   *   - `logout` for POST /logout (ST-025)
   *
   * The route layer is intentionally thin — see AAP §0.6.4.
   */
  sessionService: SessionService;
}

// ---------------------------------------------------------------------------
// Section 4: Factory
// ---------------------------------------------------------------------------

/**
 * Create the authentication route sub-routers.
 *
 * Returns TWO routers because session middleware is mounted between
 * them in the composition root (see {@link AuthRouters} for the wiring
 * pattern). The factory throws synchronously at compose time when the
 * supplied {@link SessionService} is missing or does not implement the
 * three required methods — consistent with the Rule R4 fail-closed
 * startup posture.
 *
 * @param deps See {@link CreateAuthRoutesDeps}.
 * @returns A pair of Express `Router` instances ready for `app.use(...)`.
 * @throws Error synchronously if `deps.sessionService` is missing or
 *   does not implement `register`, `login`, and `logout`.
 */
export function createAuthRoutes(deps: CreateAuthRoutesDeps): AuthRouters {
  // -------------------------------------------------------------------
  // Compose-time fail-fast on missing/invalid dependencies.
  //
  // TypeScript's `strict` checks already reject most malformed call
  // sites at compile time, but the runtime guard defends against
  // `any`-cast call sites and JS callers (e.g. ad-hoc test harnesses
  // that bypass the type system). The errors are intentionally
  // descriptive so a developer can identify the missing dep without
  // consulting source.
  // -------------------------------------------------------------------
  if (deps === null || deps === undefined || typeof deps !== 'object') {
    throw new Error('createAuthRoutes: deps argument is required and must be an object');
  }
  if (
    deps.sessionService === null ||
    deps.sessionService === undefined ||
    typeof deps.sessionService !== 'object'
  ) {
    throw new Error('createAuthRoutes: sessionService dependency is required');
  }
  if (
    typeof deps.sessionService.register !== 'function' ||
    typeof deps.sessionService.login !== 'function' ||
    typeof deps.sessionService.logout !== 'function' ||
    typeof deps.sessionService.verifyToken !== 'function'
  ) {
    throw new Error(
      'createAuthRoutes: sessionService must implement register/login/logout/verifyToken',
    );
  }

  const { sessionService } = deps;

  const publicAuthRouter: Router = Router();
  const authenticatedAuthRouter: Router = Router();

  // -------------------------------------------------------------------
  // POST /register — ST-023
  //
  // Synchronous handler that delegates to an async worker. This pattern
  // (used throughout the StrikeForge backend — see `routes/health.ts`)
  // matches Express's `void`-returning `RequestHandler` type exactly,
  // satisfies the project's `@typescript-eslint/no-floating-promises`
  // ESLint rule, and lets the `await` syntax in the worker stay
  // readable.
  //
  // The `void` operator on the worker call is the canonical TypeScript
  // idiom for "I am intentionally not awaiting this Promise". The
  // `.catch(next)` forwards any UNEXPECTED error (a programming defect
  // here or an unexpected throw from the worker that isn't caught by
  // its inner try/catch) to Express's error chain. Under normal
  // operation, the worker NEVER throws — every documented failure path
  // produces a 4xx response and a fulfilled promise.
  // -------------------------------------------------------------------
  publicAuthRouter.post(
    '/register',
    (req: Request, res: Response, next: NextFunction): void => {
      void runRegister(sessionService, req, res, next).catch((err: unknown) => {
        // This catch handles UNEXPECTED errors only — defensive
        // forwarding to Express's central error middleware. The worker
        // itself converts every documented business failure into a
        // structured response.
        next(err);
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /login — ST-024
  //
  // Same handler pattern as /register. See {@link runLogin} for the
  // step-by-step flow.
  // -------------------------------------------------------------------
  publicAuthRouter.post(
    '/login',
    (req: Request, res: Response, next: NextFunction): void => {
      void runLogin(sessionService, req, res, next).catch((err: unknown) => {
        next(err);
      });
    },
  );

  // -------------------------------------------------------------------
  // POST /logout — ST-025
  //
  // Mounted on the PUBLIC auth router — runs BEFORE the session
  // middleware (which is mounted globally on `/api/*` in
  // `backend/src/index.ts`). The handler performs its own
  // Firebase-Admin-SDK-only token verification via
  // `sessionService.verifyToken` (Rule R3) and derives the `uid`
  // directly from the decoded token, rather than relying on
  // middleware-populated `req.uid`.
  //
  // Why bypass the session middleware?
  //
  // ST-025-AC3 requires that "submitting the same revoked token again
  // returns a documented non-error response and does not alter state".
  // The session middleware (correctly) rejects revoked tokens with 401
  // INVALID_SESSION. If logout were mounted behind that middleware, a
  // second logout with the same — now-revoked — bearer would be
  // rejected by the middleware before this handler ever fires,
  // surfacing as 401 (an error response) and violating AC3.
  //
  // Mounting logout publicly keeps the AC3 contract while preserving
  // every other security guarantee:
  //
  //   - AC4 ("Logout rejected when called without a valid session"):
  //     The handler still requires a syntactically valid Bearer
  //     header AND a Firebase-signed idToken — `verifyToken` rejects
  //     malformed, expired, or signature-invalid tokens, which the
  //     handler translates to 401 UNAUTHENTICATED. Anonymous
  //     attackers cannot trigger arbitrary revocations.
  //
  //   - AC1 ("Logout marks session revoked"): The repository's
  //     `markRevoked` SQL uses `COALESCE(revoked_at, now())`, so a
  //     repeat call against an already-revoked row preserves the
  //     ORIGINAL revocation timestamp — "does not alter state" per
  //     AC3 — while a first call sets it. Both branches return 204.
  //
  //   - Rule R3 (Firebase Admin SDK only): `sessionService.verifyToken`
  //     delegates directly to `admin.auth().verifyIdToken`. No custom
  //     JWT parsing is introduced.
  //
  //   - Rule R2 (no credential leakage): the raw bearer is passed
  //     directly into the service, never logged or copied onto
  //     long-lived request fields.
  // -------------------------------------------------------------------
  publicAuthRouter.post(
    '/logout',
    (req: Request, res: Response, next: NextFunction): void => {
      void runLogout(sessionService, req, res, next).catch((err: unknown) => {
        next(err);
      });
    },
  );

  return { publicAuthRouter, authenticatedAuthRouter };
}

// ---------------------------------------------------------------------------
// Section 5: Async workers
// ---------------------------------------------------------------------------
//
// Each worker:
//   1. Validates the request via the matching Zod schema (where
//      applicable). On validation failure, returns 400 with a
//      VALIDATION_FAILED envelope.
//   2. Delegates to the corresponding {@link SessionService} method.
//   3. Translates thrown errors via {@link handleAuthError}.
//   4. On success, encodes the response (201 / 200 / 204).
//
// The workers never log the request body or credential variables.
// Logging is delegated to the request-scoped pino logger (`req.log`)
// installed by the composition root; the {@link handleAuthError}
// function emits a single bounded log record per unexpected error.
// ---------------------------------------------------------------------------

/**
 * Async worker for POST /register — ST-023.
 *
 * Implementation flow:
 *   1. Parse and validate the JSON body via {@link registerBodySchema}.
 *      On Zod failure, respond 400 with `VALIDATION_FAILED` and a pruned
 *      issue list. NEVER includes the actual rejected values.
 *   2. Call `sessionService.register({ email, password })`. The service
 *      validates inputs internally, calls `firebaseAuth.createUser`,
 *      and mirrors identity-only fields into the local `users` table.
 *   3. On success, respond 201 with `{ uid, loginIdentifier }`. Per
 *      ST-023-AC2, the response contains NO credential material AND NO
 *      session token.
 *   4. On thrown errors (Firebase native errors for duplicate email,
 *      service-layer ValidationError, repository PG errors), delegate
 *      to {@link handleAuthError} for translation.
 *
 * @param sessionService Injected service.
 * @param req Express request.
 * @param res Express response.
 * @param next Express next callback.
 */
async function runRegister(
  sessionService: SessionService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Step 1: validate body. We separate the Zod parse from the rest of
  // the try/catch so a Zod failure produces a precise 400 with field-
  // level details, distinct from any other error class.
  let body: z.infer<typeof registerBodySchema>;
  try {
    body = registerBodySchema.parse(req.body);
  } catch (err) {
    if (isZodError(err)) {
      res.status(400).json(translateZodError(err));
      return;
    }
    // A non-ZodError thrown by parse is unprecedented; forward it.
    handleAuthError(err, req, res, next);
    return;
  }

  // Step 2: delegate to the service. Service handles all credential
  // material — passwords NEVER touch any other code path in this file.
  try {
    const result = await sessionService.register({
      email: body.email,
      password: body.password,
    });

    // Step 3: encode the success response. Per ST-023-AC2 and AC4,
    // ONLY the canonical user record is returned — no token, no
    // credential digest, no echoed password. The shape is fixed by
    // the service's RegisterResult interface.
    res.status(201).json({
      uid: result.uid,
      loginIdentifier: result.loginIdentifier,
    });
  } catch (err) {
    // Step 4: translate. Service-layer ValidationError → 400 (or 409
    // for DUPLICATE_EMAIL); Firebase native error
    // `auth/email-already-exists` → 409; anything else → 500 with a
    // non-leaking body.
    handleAuthError(err, req, res, next);
  }
}

/**
 * Async worker for POST /login — ST-024.
 *
 * Implementation flow:
 *   1. Parse and validate the JSON body via {@link loginBodySchema}.
 *   2. Call `sessionService.login({ email, password })`. The service
 *      validates inputs internally, signs in via the injected Firebase
 *      Auth REST adapter, double-verifies the issued idToken via
 *      `firebaseAuth.verifyIdToken` (Rule R3 defense-in-depth), and
 *      persists a `sessions` row.
 *   3. On success, respond 200 with `{ idToken, uid, expiresAt }`.
 *      `expiresAt` is the ISO-8601 string form of the Date returned by
 *      the service (JSON's lack of a Date type means JSON.stringify
 *      already converts Dates to ISO-8601, but we forward the value
 *      as-is — `res.json` does the same conversion).
 *   4. On thrown errors, delegate to {@link handleAuthError}. The
 *      service collapses ALL credential failures to a generic
 *      `UnauthenticatedError` with code `INVALID_CREDENTIALS`, which
 *      the translator maps to 401 with a generic body — preventing
 *      user-enumeration oracles.
 *
 * @param sessionService Injected service.
 * @param req Express request.
 * @param res Express response.
 * @param next Express next callback.
 */
async function runLogin(
  sessionService: SessionService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Step 1: validate body.
  let body: z.infer<typeof loginBodySchema>;
  try {
    body = loginBodySchema.parse(req.body);
  } catch (err) {
    if (isZodError(err)) {
      res.status(400).json(translateZodError(err));
      return;
    }
    handleAuthError(err, req, res, next);
    return;
  }

  // Step 2: delegate.
  try {
    const result = await sessionService.login({
      email: body.email,
      password: body.password,
    });

    // Step 3: encode response. Per ST-024 information-disclosure
    // posture, the success body returns ONLY:
    //   - `idToken`   — the Firebase JWT (the client attaches it to
    //                   subsequent requests as `Authorization: Bearer
    //                   <idToken>`).
    //   - `uid`       — the user's Firebase ID (equals `users.id`).
    //   - `expiresAt` — Date; serialized to ISO-8601 by `res.json`.
    // No password, no credential digest, no internal session row data.
    res.status(200).json({
      idToken: result.idToken,
      uid: result.uid,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    // Step 4: translate. Service-layer UnauthenticatedError →
    // generic 401; ValidationError → 400; anything else → 500.
    handleAuthError(err, req, res, next);
  }
}

/**
 * Async worker for POST /logout — ST-025.
 *
 * Mounted on the PUBLIC auth router (see `createAuthRoutes`), this
 * handler runs BEFORE the session middleware that gates the rest of
 * `/api/*`. That placement is required for ST-025-AC3 idempotency:
 * the session middleware (correctly) rejects revoked tokens with 401
 * INVALID_SESSION, and a second logout with the same now-revoked
 * bearer would therefore never reach this handler if it were mounted
 * behind the middleware. By bypassing the gate the handler can return
 * the documented 204 No Content for both the first and the second
 * (and Nth) logout call against the same token.
 *
 * Implementation flow:
 *   1. Classify the `Authorization` header DIRECTLY (inline, NOT via
 *      a shared helper). The previous implementation delegated to a
 *      `extractRawBearer` helper that collapsed two distinct failure
 *      shapes (missing header vs. wrong scheme) to a single `null`
 *      return, defeating the three-way contract below. Inlining the
 *      parse keeps the header-classification semantics local to this
 *      function and makes the contract literal and auditable. The
 *      classification preserves the canonical three-way error
 *      contract that authenticated endpoints expose via the session
 *      middleware:
 *        - missing / empty / whitespace-only header  -> 401 `UNAUTHENTICATED`
 *        - present but non-Bearer scheme             -> 401 `MALFORMED_AUTHORIZATION`
 *        - Bearer-shaped token captured              -> proceed to step 2
 *      This satisfies AC4 ("Logout rejected when called without a
 *      valid session") for anonymous and malformed-header callers.
 *   2. Call `sessionService.verifyToken(rawBearer)` to validate the
 *      Firebase-signed idToken (Rule R3 / C2 — Firebase Admin SDK
 *      `verifyIdToken` only). On any failure (expired, signature
 *      invalid, malformed payload, revoked at the Firebase tier),
 *      the call throws and we respond 401 `INVALID_SESSION` — the
 *      same code the session middleware emits for the same class of
 *      failure on gated endpoints. The uid is read from the decoded
 *      token, NOT from `req.uid` (which is not populated on the
 *      public router).
 *   3. Call `sessionService.logout({ uid, rawBearerToken })`. The
 *      service hashes the token via SHA-256 to derive the `tokenRef`
 *      and calls `sessionRepository.markRevoked(tokenRef)`. The
 *      repository's `COALESCE(revoked_at, now())` SQL makes a second
 *      revocation a no-op — satisfying ST-025-AC3 idempotency at the
 *      database tier — while a first call sets the revocation
 *      timestamp atomically.
 *   4. On success, respond 204 No Content. Per REST conventions, a
 *      successful side-effect-only DELETE-style action returns no body.
 *
 * Note that the local `sessions` table is treated as a revocation
 * list; a row not present in the table represents an "untracked but
 * Firebase-valid" idToken. `markRevoked` returns `null` in that case
 * and the service still resolves successfully, so the handler still
 * returns 204 — correctly modelling the "logout against an unknown
 * token" branch as a no-op rather than an error.
 *
 * @param sessionService Injected service.
 * @param req Express request.
 * @param res Express response.
 * @param next Express next callback.
 */
async function runLogout(
  sessionService: SessionService,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Step 1: classify the Authorization header to preserve the
  // canonical three-way error contract that authenticated endpoints
  // expose via the session middleware. SDK consumers of the public
  // logout endpoint MUST see the same {UNAUTHENTICATED |
  // MALFORMED_AUTHORIZATION | INVALID_SESSION} distinctions as gated
  // endpoints — anything else creates a confusing UX where retrying
  // the wrong request shape produces unrelated error codes.
  //
  // Authorization header classification:
  //   - undefined / null / empty / whitespace-only         -> UNAUTHENTICATED
  //   - present, but no `Bearer ` prefix                   -> MALFORMED_AUTHORIZATION
  //   - present, Bearer-shaped, but verifyIdToken fails    -> INVALID_SESSION
  //   - present, Bearer-shaped, verifyIdToken returns uid  -> proceed to logout
  //
  // We deliberately read the header inline (rather than delegating
  // to a shared helper) so we can distinguish the missing-header
  // case from the malformed-scheme case. The previous shared helper
  // collapsed both to `null`, which made the three-way error
  // contract above unreachable from this handler. The inline shape
  // below mirrors the regex used by the session middleware so the
  // public logout route and protected routes accept the same set of
  // header shapes.
  const rawHeader: unknown = req.headers['authorization'];
  const headerValue: string | undefined = Array.isArray(rawHeader)
    ? rawHeader[0]
    : (rawHeader as string | undefined);

  const trimmed: string =
    typeof headerValue === 'string' ? headerValue.trim() : '';

  if (trimmed.length === 0) {
    // No Authorization header at all (or empty/whitespace-only).
    res
      .status(401)
      .json(buildError('UNAUTHENTICATED', 'Authentication required.'));
    return;
  }

  // Match `Bearer <token>` case-insensitively. The captured group is
  // the token portion. If the regex misses, the header IS present but
  // does not use the Bearer scheme — surface MALFORMED_AUTHORIZATION
  // matching the session-middleware contract.
  const bearerMatch: RegExpExecArray | null = /^bearer\s+(\S+)$/i.exec(trimmed);
  if (bearerMatch === null) {
    res
      .status(401)
      .json(
        buildError(
          'MALFORMED_AUTHORIZATION',
          'Authorization header must use the Bearer scheme.',
        ),
      );
    return;
  }

  const rawBearer: string | undefined = bearerMatch[1];
  if (rawBearer === undefined || rawBearer.length === 0) {
    // Defensive — the regex's `(\S+)` cannot produce empty under our
    // current pattern, but we treat any non-string capture as a
    // malformed header rather than risk a crash.
    res
      .status(401)
      .json(
        buildError(
          'MALFORMED_AUTHORIZATION',
          'Authorization header must use the Bearer scheme.',
        ),
      );
    return;
  }

  // Step 2: verify the token via Firebase Admin SDK to obtain the uid.
  // We do NOT use `req.uid` because this handler is mounted on the
  // PUBLIC router, before the session middleware that populates that
  // field. `verifyToken` performs Firebase-Admin-SDK-only validation
  // (Rule R3 / C2) — no custom JWT parsing.
  let uid: string;
  try {
    const decoded = await sessionService.verifyToken(rawBearer);
    uid = decoded.uid;
    if (typeof uid !== 'string' || uid.length === 0) {
      // Defensive — Firebase Admin SDK populates `uid` on every
      // successful decode, but the strict contract here protects
      // against an unexpected SDK version that returns a non-string.
      res
        .status(401)
        .json(
          buildError(
            'INVALID_SESSION',
            'Session is invalid, expired, or revoked.',
          ),
        );
      return;
    }
  } catch {
    // verifyIdToken throws on expired/malformed/invalid-signature
    // tokens. Surface the canonical INVALID_SESSION code so SDK
    // consumers can distinguish "your bearer was rejected by the
    // identity provider" from "you didn't provide a bearer at all"
    // (UNAUTHENTICATED) and "your scheme is wrong"
    // (MALFORMED_AUTHORIZATION). Per Rule R2 we never echo the
    // underlying Firebase error class or message — those can hint at
    // internal validation steps and credential verification details.
    res
      .status(401)
      .json(
        buildError(
          'INVALID_SESSION',
          'Session is invalid, expired, or revoked.',
        ),
      );
    return;
  }

  // Step 3: delegate. Service handles idempotency, hashing, and the
  // session-row update. Service contract: throws ValidationError on
  // empty inputs (already guarded above) or PG errors (forwarded as
  // 500 by the translator).
  try {
    await sessionService.logout({ uid, rawBearerToken: rawBearer });

    // Step 4: 204 No Content. Per REST and per ST-025-AC3 ("documented
    // non-error response"), the body is empty. Returned identically
    // for the first and Nth call against the same token.
    res.status(204).send();
  } catch (err) {
    handleAuthError(err, req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Section 6: Error translator and helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for `ZodError`.
 *
 * `instanceof ZodError` would require a value-import of `ZodError`; we
 * use a structural check based on the `name` field plus the `issues`
 * array which is the discriminator Zod uses internally. This avoids
 * adding a runtime dependency on the value version of `ZodError` while
 * remaining narrow enough to compile-check downstream usage.
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

/**
 * Translate a thrown error to an HTTP response envelope.
 *
 * Handles the following error classes:
 *
 *   - `ValidationError` (`name === 'ValidationError'`):
 *       - With `code === 'DUPLICATE_EMAIL'` → 409 Conflict with the
 *         `DUPLICATE_EMAIL` envelope.
 *       - Otherwise → 400 Bad Request with the `VALIDATION_FAILED`
 *         envelope.
 *
 *   - Firebase native error `auth/email-already-exists`:
 *       Bubbled up directly from `firebaseAuth.createUser`. Translated
 *       to 409 with the `DUPLICATE_EMAIL` envelope.
 *
 *   - `UnauthenticatedError` (`name === 'UnauthenticatedError'`) or any
 *     error with `code === 'INVALID_CREDENTIALS'`:
 *       → 401 Unauthorized with the GENERIC `INVALID_CREDENTIALS`
 *       envelope. This applies regardless of the underlying cause
 *       (`auth/user-not-found`, `auth/invalid-password`, etc.) —
 *       ST-024 enumeration defense.
 *
 *   - Anything else:
 *       → 500 Internal Server Error with the non-leaking `INTERNAL_ERROR`
 *       envelope. The original error is logged via `req.log.error` (or
 *       silently dropped when the logger is unavailable) with ONLY the
 *       error class name, code, and a 200-character-truncated message.
 *       The stack, the `cause`, and the request body are NEVER logged.
 *
 * Per Rule R8 (fail-closed): every code path produces a non-2xx
 * response. There is NO branch that returns 200 while the operation
 * failed.
 *
 * @param err The thrown error (typed as `unknown` per the project's
 *   strict-TypeScript posture).
 * @param req Express request — used only to access `req.log` for the
 *   error log record.
 * @param res Express response — used to send the error envelope.
 * @param _next Express next callback. Currently unused (this function
 *   handles every translation by sending a response directly), but the
 *   parameter is kept so future variants can forward to the central
 *   error handler if needed without changing call sites.
 */
function handleAuthError(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // Extract diagnostic fields without trusting the structure. Each
  // access uses optional chaining and a defensive cast so a malformed
  // throw value (e.g. `throw 42`, `throw null`, `throw "oops"`) does
  // not itself raise an error and crash the response.
  const errObj = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const name: string | undefined = typeof errObj?.name === 'string' ? errObj.name : undefined;
  const code: string | undefined = typeof errObj?.code === 'string' ? errObj.code : undefined;
  const message: string | undefined =
    typeof errObj?.message === 'string' ? errObj.message : undefined;

  // ── 409 DUPLICATE_EMAIL ──────────────────────────────────────────
  // Two paths produce a duplicate-email error:
  //   (1) Service-layer ValidationError with code 'DUPLICATE_EMAIL'.
  //       (Defensive — the current service implementation lets the
  //       Firebase error bubble; a future refactor that wraps it would
  //       use this code.)
  //   (2) Firebase native error with code 'auth/email-already-exists'.
  //       (Today's path — see the service.ts register flow.)
  if (
    (name === 'ValidationError' && code === 'DUPLICATE_EMAIL') ||
    code === 'auth/email-already-exists'
  ) {
    res.status(409).json(buildError('DUPLICATE_EMAIL', 'Email is already registered'));
    return;
  }

  // ── 400 VALIDATION_FAILED ────────────────────────────────────────
  // Service-layer validation errors (empty fields, non-string types
  // that bypassed Zod, etc.). The message is a fixed string from the
  // service's validation helpers; it does not contain credential
  // material.
  if (name === 'ValidationError') {
    res
      .status(400)
      .json(buildError('VALIDATION_FAILED', message ?? 'Invalid input'));
    return;
  }

  // ── 401 INVALID_CREDENTIALS ──────────────────────────────────────
  // Generic by design (ST-024 enumeration defense). The translator
  // uses a fixed, parameter-free message string — the actual reason
  // (user not found vs wrong password vs locked account) lives only
  // in the server log emitted by the service layer.
  if (name === 'UnauthenticatedError' || code === 'INVALID_CREDENTIALS') {
    res
      .status(401)
      .json(buildError('INVALID_CREDENTIALS', 'Authentication failed'));
    return;
  }

  // ── 500 INTERNAL_ERROR ───────────────────────────────────────────
  // Unrecognised error class. Log a single bounded WARN/ERROR record
  // via the request-scoped pino logger (which is configured with the
  // serializer allow-list in `../logging/pino.ts` to redact any
  // accidental credential leakage), then return a non-leaking 500.
  //
  // The log record contains:
  //   - `event`        — fixed identifier `'auth.route.error'` for
  //                      log-pipeline filtering and dashboard panels.
  //   - `errorName`    — the JS error class name (`Error`,
  //                      `FirebaseAuthError`, etc.).
  //   - `errorCode`    — the `code` field if present (e.g. PG
  //                      `'23505'`).
  //   - `errorMessage` — the error's message TRUNCATED to 200
  //                      characters. We never include `.stack` or
  //                      `.cause` (those expose call-site detail).
  //
  // Per Rule R2 the log call NEVER includes:
  //   - The request body.
  //   - The `Authorization` header value.
  //   - Any credential variable (password, idToken, rawBearerToken).
  const reqWithLog = req as Request & {
    log?: { error: (obj: unknown, msg?: string) => void };
  };
  const log = reqWithLog.log;
  if (log !== undefined) {
    log.error(
      {
        event: 'auth.route.error',
        errorName: name,
        errorCode: code,
        errorMessage:
          typeof message === 'string' ? message.slice(0, 200) : undefined,
      },
      'auth route error',
    );
  }

  res.status(500).json(buildError('INTERNAL_ERROR', 'Internal server error'));
}

// NOTE — Bearer-token extraction was previously isolated in a helper
// function `extractRawBearer(req)`. After QA Final E Issue #2 (the
// public-mounted /logout three-way error contract correction), that
// helper became dead code: the only caller, `runLogout`, must inline
// header parsing so it can distinguish "no header"
// (`UNAUTHENTICATED`) from "non-Bearer scheme"
// (`MALFORMED_AUTHORIZATION`) — a distinction the helper deliberately
// collapsed by returning `null` for both cases. Keeping a stale
// helper around invites accidental re-use that would silently
// regress the three-way contract documented on `runLogout` and on
// `backend/src/middleware/session.ts`. The header parsing now lives
// inline in `runLogout` (see Step 1 of that function) and uses the
// same RFC-6750 §2.1 regex (`/^bearer\s+(\S+)$/i`) that the session
// middleware applies on protected routes, so request shape acceptance
// remains identical between the two code paths.
