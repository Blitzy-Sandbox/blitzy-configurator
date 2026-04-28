/**
 * Unit tests for `backend/src/routes/auth.ts` — ST-023, ST-024, ST-025.
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-023 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "The registration endpoint accepts a request with the
 *             documented required fields and persists a canonical user
 *             record when the input is valid."
 *
 *       AC2: "A successful registration returns the canonical user
 *             record (without any credential material) and a success
 *             status, and does not issue a session token by itself."
 *
 *       AC3: "Registration attempts that fail validation (missing
 *             fields, malformed input, duplicate identifier) return a
 *             descriptive, non-leaking error response and do not create
 *             any partial record."
 *
 *       AC4: "Credential material submitted at registration is never
 *             stored in cleartext and is never returned in any
 *             response."
 *
 *   - Story ST-024 acceptance criteria (verbatim):
 *
 *       AC1: "The login endpoint accepts valid credentials and returns
 *             an opaque session token with a documented lifetime and
 *             expiration timestamp."
 *
 *       AC2: "Invalid credentials return a generic failure response
 *             that does not disclose whether the user identifier
 *             exists, and the response carries no session token."
 *
 *       AC3: "Each successful login creates a new session record
 *             associated with the authenticated user, and repeated
 *             logins do not invalidate active sessions from other
 *             devices unless policy requires it."
 *
 *       AC4: "Login responses and the subsequent use of the returned
 *             token are exchanged only over a confidential transport
 *             and do not echo credential material in any form."
 *
 *       AC5: "Successful and failed login attempts emit a structured
 *             log record containing at minimum a correlation
 *             identifier, an event name that distinguishes success from
 *             failure, the outcome, and the authenticated user
 *             identifier when the attempt succeeded (never credential
 *             material)."
 *
 *   - Story ST-025 acceptance criteria (verbatim):
 *
 *       AC1: "The logout endpoint accepts a valid session token and
 *             marks the associated session as revoked in the
 *             persistence layer."
 *
 *       AC3: "Logout is idempotent: submitting the same revoked token
 *             again returns a documented non-error response and does
 *             not alter state."
 *
 *       AC4: "Logout is rejected with a documented error when called
 *             without a valid, non-expired session token, and leaves no
 *             partial state behind."
 *
 *   - Story ST-043 acceptance criteria (Rule R1):
 *       AC3: "A failing assertion, a test exception, or a coverage
 *             percentage below the documented threshold produces a
 *             failed verdict; the suite is deterministic."
 *       AC4: "The suite runs in the local development environment
 *             without any additional services or network access beyond
 *             the standard local toolchain."
 *
 *   - AAP §0.7.1: backend co-located *.test.ts files are in scope.
 *   - AAP §0.8.1 R2: "No credential material in logs." Verification via
 *     sentinel-string absence scans on response bodies and headers.
 *   - AAP §0.8.1 R3: "Firebase Admin SDK only." Verification via grep
 *     against `jsonwebtoken|jose|jwt-decode` — none appear in this file.
 *   - AAP §0.8.1 R8: "Gates fail closed." Every documented failure
 *     produces a non-2xx response with structured body.
 *   - AAP §0.8.1 R9: "Payment processing excluded." Verification via
 *     grep against `stripe|braintree|paypal|payment_intent|charge` on
 *     the auth.ts source file.
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * Factory wiring:
 *   1. `createAuthRoutes` returns the documented `{ publicAuthRouter,
 *      authenticatedAuthRouter }` pair — both Express Routers.
 *   2. The factory throws when `deps` is null/undefined or non-object.
 *   3. The factory throws when `deps.sessionService` is missing or
 *      non-object.
 *   4. The factory throws when any of `register`, `login`, `logout` is
 *      not a function.
 *   5. Successive calls produce independent Router instances (no
 *      module-level singleton).
 *
 * POST /api/auth/register (ST-023):
 *   6. Returns 201 with `{ uid, loginIdentifier }` on a valid request
 *      body, forwarding `{ email, password }` to `sessionService.register`
 *      verbatim (AC1, AC2).
 *   7. Response body excludes every credential field and every token
 *      field (AC2, AC4) — `password`, `credential`, `credentialDigest`,
 *      `idToken`, `sessionToken`, `token` are all absent; sentinel
 *      string scan confirms the password value never appears.
 *   8. Returns 400 VALIDATION_FAILED with a `details` array when the
 *      body is missing `email` (AC3).
 *   9. Returns 400 VALIDATION_FAILED when the body is missing `password`
 *      (AC3).
 *  10. Returns 400 VALIDATION_FAILED when `email` is malformed (AC3 —
 *      Zod's `.email()` validator rejects).
 *  11. Returns 400 VALIDATION_FAILED when `password` is shorter than
 *      8 characters (AC3 — Zod's `.min(8)` rejects).
 *  12. Returns 400 VALIDATION_FAILED when an unknown top-level key is
 *      submitted (AC3 — Zod `.strict()` rejects).
 *  13. Returns 400 VALIDATION_FAILED when the body is empty (AC3).
 *  14. Translates a service-layer ValidationError to 400 with code
 *      `VALIDATION_FAILED` (the route collapses all generic
 *      ValidationError codes to the stable external code) and
 *      preserves the service's `message`.
 *  15. Translates a service-layer ValidationError carrying
 *      `code: 'DUPLICATE_EMAIL'` to 409 with code `DUPLICATE_EMAIL`
 *      (AC3 duplicate-identifier path; first branch of handleAuthError).
 *  16. Translates a Firebase native error
 *      (`code: 'auth/email-already-exists'`) to 409 with code
 *      `DUPLICATE_EMAIL` (AC3 duplicate-identifier path; second branch).
 *  17. Returns 500 INTERNAL_ERROR with a non-leaking body on an
 *      unrecognised error (Rule R8 fail-closed).
 *  18. Successful registration response excludes `idToken`,
 *      `sessionToken`, `token` keys verifying AC2 ("does not issue a
 *      session token by itself").
 *
 * POST /api/auth/login (ST-024):
 *  19. Returns 200 with `{ idToken, uid, expiresAt }` on valid
 *      credentials. The `expiresAt` Date is serialised to an ISO-8601
 *      string by `res.json` (AC1).
 *  20. Translates a service-layer UnauthenticatedError to 401 with the
 *      GENERIC `INVALID_CREDENTIALS` code AND the GENERIC fixed message
 *      `Authentication failed` regardless of the underlying cause —
 *      enumeration defense (AC2).
 *  21. Translates an error carrying `code: 'INVALID_CREDENTIALS'` (no
 *      `name === 'UnauthenticatedError'`) to 401 INVALID_CREDENTIALS —
 *      coverage of the second OR-branch of the translator.
 *  22. Login error body NEVER discloses "user does not exist", "not
 *      found", or "wrong password" — enumeration defense regression
 *      protection.
 *  23. Returns 400 VALIDATION_FAILED when login body is malformed
 *      (missing password).
 *  24. Returns 400 VALIDATION_FAILED when login body is missing email.
 *  25. Returns 400 VALIDATION_FAILED on an unknown top-level key (Zod
 *      `.strict()` rejection).
 *  26. The password value submitted in a login request NEVER appears in
 *      the response body or response headers — sentinel string absence
 *      scan (Rule R2).
 *  27. Two consecutive successful logins produce two distinct
 *      `idToken` values from the service and the route returns each
 *      verbatim — confirms ST-024-AC3 behaviour at the route layer
 *      (each login is a fresh service call; the route does NOT
 *      memoise).
 *  28. Returns 500 INTERNAL_ERROR with a non-leaking body on an
 *      unrecognised error from the service.
 *
 * POST /api/auth/logout (ST-025):
 *  29. Returns 204 with empty body on a valid authenticated request,
 *      and forwards `{ uid: req.uid, rawBearerToken: <stripped> }` to
 *      `sessionService.logout` (AC1).
 *  30. Strips the `Bearer ` prefix (case-insensitive) when forwarding
 *      the raw token to the service.
 *  31. Repeated logout calls against the same authenticated request
 *      shape both return 204 — service-layer idempotency surfaces as
 *      stable 204 at the route layer (AC3).
 *  32. Returns 401 UNAUTHENTICATED when `req.uid` is missing (defensive
 *      secondary check; the session middleware should have already
 *      rejected, but the route fails closed if the middleware was
 *      misconfigured) (AC4).
 *  33. Returns 401 UNAUTHENTICATED when `req.uid` is empty string.
 *  34. Returns 401 UNAUTHENTICATED when the Authorization header is
 *      missing (AC4).
 *  35. Returns 401 UNAUTHENTICATED when the Authorization header
 *      contains a non-Bearer scheme (e.g. "Basic ...").
 *  36. Returns 401 UNAUTHENTICATED when the Authorization header is
 *      "Bearer " with no token portion.
 *  37. The raw bearer token NEVER appears in the response body or
 *      response headers — sentinel string absence scan (Rule R2).
 *  38. Translates an unrecognised error from the service to 500
 *      INTERNAL_ERROR with a non-leaking body (Rule R8 fail-closed).
 *  39. The 500 response message NEVER discloses internal infrastructure
 *      detail (`db`, `postgres`, `unreachable`).
 *  40. Logs unrecognised errors via the request-scoped pino logger
 *      with bounded structural metadata only (event name, error name,
 *      error code, truncated error message) — Rule R2 enforcement
 *      surface.
 *  41. Does not throw when `req.log` is absent (graceful degradation —
 *      e.g., when pino-http is not wired in early bootstrap).
 *
 * Rule R2 verification:
 *  42. Per-route password sentinel scans on register, login, logout
 *      response bodies confirm no credential material appears.
 *
 * Rule R9 verification:
 *  43. The `auth.ts` source file contains zero matches for the AAP
 *      §0.8.1 forbidden-vocabulary grep (stripe|braintree|paypal|
 *      payment_intent|charge).
 *
 * ============================================================================
 * Determinism (ST-043-AC3) and Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` drives Express via an
 *     in-memory ephemeral-port loopback that supertest manages; no
 *     external host, no DNS resolution.
 *   - Zero file-system access at test time except for the Rule R9
 *     grep which reads the sibling `auth.ts` source for verification.
 *   - Zero environment-variable reads. `auth.ts` consumes no env vars
 *     directly — it reads ONLY its injected service.
 *   - The `SessionService` dependency is replaced by a `jest.fn()`-
 *     backed shim built per test; no real database, no Firebase Admin
 *     SDK, no `pg` pool.
 *   - The Jest config (`jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, `restoreMocks` to `true`, so `jest.fn` state is
 *     wiped between tests.
 *
 * @see backend/src/routes/auth.ts — module under test
 * @see backend/src/routes/cart.test.ts — sibling pattern reference
 * @see backend/src/routes/designs.test.ts — sibling pattern reference
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-023-user-registration-endpoint.md
 * @see tickets/stories/ST-024-login-endpoint-session-token.md
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see tickets/stories/ST-047-structured-logs-correlation-id.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// `express` is imported as a runtime default — the test invokes
// `express()` to construct an in-memory app that mounts the routers
// under test. `supertest` is also a runtime default.
//
// Both packages declare these defaults via CommonJS `module.exports = ...`
// and the project's `esModuleInterop: true` compiler option (see
// `backend/tsconfig.json`) makes the `import x from 'y'` form resolve
// to `module.exports` under the hood.
//
// `createAuthRoutes` is imported as a runtime/named import from the
// sibling `./auth` module — the surface under test.
//
// Rule R3 firewall (verifiable by static grep against this file):
//   - NO `jsonwebtoken` import
//   - NO `jose` import
//   - NO `jwt-decode` import
//   - NO `firebase-admin` import (the route's session dependency is
//     replaced by a jest.fn-backed shim).
//
// Rule R4 firewall: NO `process.env.*` reads anywhere in this file.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { createAuthRoutes } from './auth';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Local shim for the SessionService's `ValidationError` class.
 *
 * The route under test recognises a service-layer ValidationError by
 * the structural duck-type check `name === 'ValidationError'` (see
 * `auth.ts` `handleAuthError`). We construct a concrete `Error`
 * subclass with that `name` override so test rejections trigger the
 * correct translator branch without requiring an import from
 * `session.service.ts` (which is NOT in this test's
 * `depends_on_files`; only `auth.ts` is permitted).
 *
 * The constructor mirrors the actual `session.service.ts`
 * `ValidationError` shape `(field, message, code = 'VALIDATION_FAILED')`
 * — field FIRST, message SECOND, code THIRD.
 */
class TestValidationError extends Error {
  public override readonly name: string = 'ValidationError';
  public readonly code: string;
  public readonly field: string;
  public constructor(field: string, message: string, code: string = 'VALIDATION_FAILED') {
    super(message);
    this.field = field;
    this.code = code;
  }
}

/**
 * Local shim for the SessionService's `UnauthenticatedError` class.
 *
 * The route under test recognises an UnauthenticatedError by either
 * `name === 'UnauthenticatedError'` OR `code === 'INVALID_CREDENTIALS'`
 * (see `auth.ts` `handleAuthError`). The constructor mirrors the
 * actual `session.service.ts` `UnauthenticatedError` shape
 * `(message, code = 'UNAUTHENTICATED')` — message FIRST, code SECOND.
 */
class TestUnauthenticatedError extends Error {
  public override readonly name: string = 'UnauthenticatedError';
  public readonly code: string;
  public constructor(message: string, code: string = 'UNAUTHENTICATED') {
    super(message);
    this.code = code;
  }
}

/**
 * Minimal jest-mock-backed `SessionService` shim.
 *
 * The route consumes `register`, `login`, `logout` per the factory's
 * runtime validation. `verifyToken` and `isRevoked` are present as
 * `jest.fn()` placeholders so the shim satisfies the structural type
 * contract declared in `services/session.service.ts`'s public
 * `SessionService` interface (which the factory checks via
 * `typeof === 'function'`).
 */
type SessionServiceMock = {
  register: jest.Mock;
  login: jest.Mock;
  logout: jest.Mock;
  verifyToken: jest.Mock;
  isRevoked: jest.Mock;
};

/**
 * Construct a fresh `SessionServiceMock` for each test. Centralising
 * construction in a helper guarantees every test starts from the same
 * baseline — `jest.fn()` instances with no implementation, no recorded
 * calls. The Jest config's `clearMocks`/`resetMocks`/`restoreMocks`
 * triple guarantees per-test isolation as a defense-in-depth layer.
 */
function buildSessionService(): SessionServiceMock {
  return {
    register: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    verifyToken: jest.fn(),
    isRevoked: jest.fn(),
  };
}

/**
 * Optional pino-http log spy shape — mirrors the surface used by the
 * error translator's structured log call. The `error` method is the
 * only one consumed by `auth.ts handleAuthError`.
 */
type LogSpy = {
  error: jest.Mock;
};

/**
 * Construct an Express app exposing the `publicAuthRouter` (register +
 * login). No session-middleware simulator is installed because the
 * public router runs UPSTREAM of session middleware in production.
 *
 * The optional `logSpy` installs a `req.log.error` spy at the top of
 * the chain so the error-translator's structured log call can be
 * observed.
 *
 * The factory's two-router split is documented in
 * `auth.ts AuthRouters`: `publicAuthRouter` mounts /register and
 * /login; the authenticated /logout sits on the OTHER router and
 * is exercised by `buildAuthenticatedApp` below.
 */
function buildPublicApp(opts: {
  sessionService: SessionServiceMock;
  logSpy?: LogSpy;
}): express.Express {
  const app = express();
  // Production wires `express.json()` upstream of every route in
  // `backend/src/index.ts`; we wire it locally per app to match.
  app.use(express.json());

  if (opts.logSpy !== undefined) {
    const spy = opts.logSpy;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const reqWithLog = req as Request & { log?: { error: jest.Mock } };
      reqWithLog.log = spy;
      next();
    });
  }

  // Cast to the actual SessionService interface. The route under test
  // consumes only `register`, `login`, `logout`, and validates them
  // via `typeof === 'function'`; the cast is the canonical pattern
  // for substituting minimal mocks for richer interfaces (see
  // `health.test.ts`, `cart.test.ts`).
  const { publicAuthRouter } = createAuthRoutes({
    sessionService: opts.sessionService as unknown as Parameters<
      typeof createAuthRoutes
    >[0]['sessionService'],
  });
  app.use('/api/auth', publicAuthRouter);
  return app;
}

/**
 * Construct an Express app exposing the `authenticatedAuthRouter`
 * (logout). A session-middleware simulator stamps `req.uid` and
 * (optionally) the `Authorization` header BEFORE the router runs,
 * mirroring the production composition root in `backend/src/index.ts`.
 *
 * Behavior:
 *   - When `uid !== undefined`, `req.uid` is set to that value
 *     (including the empty-string case so we can exercise the
 *     defensive 401 path).
 *   - When `authorization !== ''`, the Authorization header is set on
 *     the request. An empty-string `authorization` indicates "do not
 *     attach the header at all" (exercising the 401 UNAUTHENTICATED
 *     path inside `extractRawBearer`).
 *
 * The optional `logSpy` mirrors `buildPublicApp`'s log injection.
 */
function buildAuthenticatedApp(opts: {
  sessionService: SessionServiceMock;
  uid?: string;
  authorization?: string;
  logSpy?: LogSpy;
}): express.Express {
  const app = express();
  app.use(express.json());

  if (opts.logSpy !== undefined) {
    const spy = opts.logSpy;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const reqWithLog = req as Request & { log?: { error: jest.Mock } };
      reqWithLog.log = spy;
      next();
    });
  }

  // Session-middleware simulator: stamp req.uid and (optionally) the
  // Authorization header. The conditional-set on uid lets us exercise
  // both the missing-uid path (uid === undefined) and the empty-uid
  // edge case (uid === '').
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.uid !== undefined) {
      req.uid = opts.uid;
    }
    if (opts.authorization !== undefined && opts.authorization !== '') {
      req.headers.authorization = opts.authorization;
    }
    next();
  });

  const { authenticatedAuthRouter } = createAuthRoutes({
    sessionService: opts.sessionService as unknown as Parameters<
      typeof createAuthRoutes
    >[0]['sessionService'],
  });
  app.use('/api/auth', authenticatedAuthRouter);
  return app;
}

/**
 * The shared canonical valid register/login body. Tests that exercise
 * negative scenarios start from this shape and modify it (drop a
 * field, add an unknown key, mutate a value).
 */
const VALID_REGISTER_BODY = {
  email: 'user@example.com',
  password: 'correct-horse-battery-staple',
};

const VALID_LOGIN_BODY = {
  email: 'user@example.com',
  password: 'correct-horse-battery-staple',
};

const TEST_UID = 'firebase-uid-12345';
const TEST_LOGIN_IDENTIFIER = 'user@example.com';

// ===========================================================================
// Section A: Factory wiring
// ===========================================================================

describe('createAuthRoutes — factory wiring', () => {
  it('returns the documented { publicAuthRouter, authenticatedAuthRouter } pair', () => {
    const sessionService = buildSessionService();
    const routers = createAuthRoutes({
      sessionService: sessionService as unknown as Parameters<
        typeof createAuthRoutes
      >[0]['sessionService'],
    });

    // The factory's documented contract is a destructurable object.
    // Both keys MUST be present; both MUST be Express Router
    // instances (which are functions in addition to objects with
    // `use`/`get`/`post` members).
    expect(routers).toHaveProperty('publicAuthRouter');
    expect(routers).toHaveProperty('authenticatedAuthRouter');
    expect(typeof routers.publicAuthRouter).toBe('function');
    expect(typeof routers.authenticatedAuthRouter).toBe('function');
    expect(typeof (routers.publicAuthRouter as unknown as { use: unknown }).use).toBe(
      'function',
    );
    expect(typeof (routers.publicAuthRouter as unknown as { post: unknown }).post).toBe(
      'function',
    );
    expect(
      typeof (routers.authenticatedAuthRouter as unknown as { use: unknown }).use,
    ).toBe('function');
    expect(
      typeof (routers.authenticatedAuthRouter as unknown as { post: unknown }).post,
    ).toBe('function');
  });

  it('throws when deps argument is null', () => {
    expect(() =>
      createAuthRoutes(null as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps argument is undefined', () => {
    expect(() =>
      createAuthRoutes(undefined as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps argument is a non-object primitive', () => {
    expect(() =>
      createAuthRoutes(42 as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/deps argument is required/);
    expect(() =>
      createAuthRoutes('foo' as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps.sessionService is missing', () => {
    expect(() =>
      createAuthRoutes({} as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/sessionService dependency is required/);
  });

  it('throws when deps.sessionService is null', () => {
    expect(() =>
      createAuthRoutes({ sessionService: null } as unknown as Parameters<
        typeof createAuthRoutes
      >[0]),
    ).toThrow(/sessionService dependency is required/);
  });

  it('throws when deps.sessionService is a non-object primitive', () => {
    expect(() =>
      createAuthRoutes({ sessionService: 'not an object' } as unknown as Parameters<
        typeof createAuthRoutes
      >[0]),
    ).toThrow(/sessionService dependency is required/);
  });

  it('throws when deps.sessionService.register is not a function', () => {
    const broken = {
      sessionService: {
        register: 'not a function',
        login: jest.fn(),
        logout: jest.fn(),
      },
    };
    expect(() =>
      createAuthRoutes(broken as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/sessionService must implement register\/login\/logout/);
  });

  it('throws when deps.sessionService.login is not a function', () => {
    const broken = {
      sessionService: {
        register: jest.fn(),
        login: undefined,
        logout: jest.fn(),
      },
    };
    expect(() =>
      createAuthRoutes(broken as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/sessionService must implement register\/login\/logout/);
  });

  it('throws when deps.sessionService.logout is not a function', () => {
    const broken = {
      sessionService: {
        register: jest.fn(),
        login: jest.fn(),
        logout: 42,
      },
    };
    expect(() =>
      createAuthRoutes(broken as unknown as Parameters<typeof createAuthRoutes>[0]),
    ).toThrow(/sessionService must implement register\/login\/logout/);
  });

  it('produces independent router pairs across calls (no module-level singleton)', () => {
    const sessionServiceA = buildSessionService();
    const sessionServiceB = buildSessionService();
    const a = createAuthRoutes({
      sessionService: sessionServiceA as unknown as Parameters<
        typeof createAuthRoutes
      >[0]['sessionService'],
    });
    const b = createAuthRoutes({
      sessionService: sessionServiceB as unknown as Parameters<
        typeof createAuthRoutes
      >[0]['sessionService'],
    });
    expect(a).not.toBe(b);
    expect(a.publicAuthRouter).not.toBe(b.publicAuthRouter);
    expect(a.authenticatedAuthRouter).not.toBe(b.authenticatedAuthRouter);
  });
});

// ===========================================================================
// Section B: POST /api/auth/register — ST-023
// ===========================================================================

describe('POST /api/auth/register — ST-023-AC1/AC2 (success path)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('returns 201 with { uid, loginIdentifier } on a valid request body (AC1, AC2)', async () => {
    sessionService.register.mockResolvedValueOnce({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY)
      .expect('Content-Type', /json/);

    // ST-023-AC2: a successful registration returns the canonical
    // user record and a success status.
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });
  });

  it('forwards { email, password } verbatim to sessionService.register (AC1)', async () => {
    sessionService.register.mockResolvedValueOnce({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });

    await request(app).post('/api/auth/register').send(VALID_REGISTER_BODY);

    // Per ST-023-AC1 the route delegates persistence to the service.
    // The service is called exactly once with the validated body.
    expect(sessionService.register).toHaveBeenCalledTimes(1);
    expect(sessionService.register).toHaveBeenCalledWith({
      email: VALID_REGISTER_BODY.email,
      password: VALID_REGISTER_BODY.password,
    });
  });

  it('does NOT issue a session token in the success response (AC2)', async () => {
    // ST-023-AC2: "does not issue a session token by itself."
    // Verified by structural assertion: the response body contains
    // ONLY `uid` and `loginIdentifier` — no token of any kind.
    sessionService.register.mockResolvedValueOnce({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.body).not.toHaveProperty('idToken');
    expect(res.body).not.toHaveProperty('sessionToken');
    expect(res.body).not.toHaveProperty('token');
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('refreshToken');
    expect(res.body).not.toHaveProperty('expiresAt');
  });

  it('does NOT echo any credential material in the success response (AC4, Rule R2)', async () => {
    // ST-023-AC4: "Credential material submitted at registration is
    // never returned in any response." Use a unique sentinel string
    // as the password value so we can scan the response body for
    // accidental echo via JSON.stringify (covers nested fields too).
    const SENTINEL_PASSWORD = 'SENTINEL_REGISTER_PASSWORD_ABC123';
    sessionService.register.mockResolvedValueOnce({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: SENTINEL_PASSWORD });

    const responseSerialised = JSON.stringify({
      body: res.body,
      headers: res.headers,
      text: res.text,
    });

    // The sentinel MUST NOT appear anywhere — body, headers, or raw
    // text — covering the AC4 information-disclosure posture.
    expect(responseSerialised).not.toContain(SENTINEL_PASSWORD);

    // Field-level assertions: no key whose name suggests credential
    // material appears in the response body.
    expect(res.body).not.toHaveProperty('password');
    expect(res.body).not.toHaveProperty('credential');
    expect(res.body).not.toHaveProperty('credentialDigest');
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('hash');
  });
});

describe('POST /api/auth/register — ST-023-AC3 (validation failures)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('returns 400 VALIDATION_FAILED when body is missing email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ password: 'has-eight-characters' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toBe('Request validation failed');
    // The `details` array carries the Zod issue list — pruned to
    // path + message only (NEVER the rejected value itself).
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    const emailIssue = res.body.error.details.find(
      (d: { path: string }) => d.path === 'email',
    );
    expect(emailIssue).toBeDefined();

    // ST-023-AC3 "do not create any partial record" — the service
    // is NEVER called when validation fails at the route layer.
    expect(sessionService.register).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when body is missing password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_LOGIN_IDENTIFIER });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();

    // The details array MUST identify password as the failing field.
    const passwordIssue = res.body.error.details.find(
      (d: { path: string }) => d.path === 'password',
    );
    expect(passwordIssue).toBeDefined();
  });

  it('returns 400 VALIDATION_FAILED when email is malformed (Zod .email())', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'eight-or-more' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when password is shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();

    // The Zod min(8) constraint on register surfaces a password issue.
    const passwordIssue = res.body.error.details.find(
      (d: { path: string }) => d.path === 'password',
    );
    expect(passwordIssue).toBeDefined();
  });

  it('returns 400 VALIDATION_FAILED when an unknown top-level key is submitted (Zod .strict())', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: TEST_LOGIN_IDENTIFIER,
        password: 'eight-or-more',
        unknownField: 'malicious-mass-assignment',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when body is empty', async () => {
    const res = await request(app).post('/api/auth/register').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when body is a JSON array (not an object)', async () => {
    // Defensive: a JSON array is not the object shape `registerBodySchema`
    // expects — Zod's `.object()` rejects it at parse time. The route
    // MUST surface a 400, never crash.
    //
    // (`express.json()` runs in default `strict: true` mode and rejects
    // literal `null`/`true`/`false`/number/string bodies BEFORE the route
    // handler — those are an Express-layer concern, not a route concern.
    // Arrays ARE accepted by `express.json()` and reach the route, so an
    // array is the canonical "wrong shape" payload for a route-layer
    // assertion.)
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('[]');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.register).not.toHaveBeenCalled();
  });

  it('does NOT echo the rejected password value into the validation details (AC4, Rule R2)', async () => {
    // ST-023-AC4 + AAP §0.5.6 information-disclosure posture:
    // validation errors MUST NOT echo the rejected value (which
    // could BE a credential).
    const SENTINEL_PASSWORD = 'SENTINEL_REJECTED_VALUE_99';
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: SENTINEL_PASSWORD });

    expect(res.status).toBe(400);
    const responseSerialised = JSON.stringify({
      body: res.body,
      headers: res.headers,
      text: res.text,
    });
    expect(responseSerialised).not.toContain(SENTINEL_PASSWORD);
  });
});

describe('POST /api/auth/register — ST-023-AC3 (service-layer error translation)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('translates a generic service-layer ValidationError to 400 VALIDATION_FAILED with the service message', async () => {
    // The route's translator collapses generic ValidationError codes
    // to the stable external code 'VALIDATION_FAILED' (the service's
    // internal codes are NOT exposed in the API contract). The
    // service's `message` is forwarded verbatim — the service is
    // responsible for ensuring messages are non-leaking.
    sessionService.register.mockRejectedValueOnce(
      new TestValidationError('email', 'email format invalid', 'EMAIL_FORMAT'),
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'email format invalid',
      },
    });
  });

  it('falls back to "Invalid input" when the ValidationError has no message', async () => {
    // Defense-in-depth: a malformed throw shape with `name === 'ValidationError'`
    // but no message MUST surface the documented `??` fallback.
    sessionService.register.mockRejectedValueOnce({ name: 'ValidationError' });

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  it('translates a ValidationError carrying code "DUPLICATE_EMAIL" to 409 DUPLICATE_EMAIL (AC3)', async () => {
    // The service-layer ValidationError path for duplicates: the
    // current implementation lets Firebase errors bubble (see next
    // test), but a future refactor that wraps them as a service
    // ValidationError with `code: 'DUPLICATE_EMAIL'` MUST also
    // produce 409 — translator's first branch covers it.
    sessionService.register.mockRejectedValueOnce(
      new TestValidationError('email', 'Email already in use', 'DUPLICATE_EMAIL'),
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'DUPLICATE_EMAIL',
        message: 'Email is already registered',
      },
    });
  });

  it('translates a Firebase native error (auth/email-already-exists) to 409 DUPLICATE_EMAIL (AC3)', async () => {
    // The current service implementation lets the Firebase error
    // bubble. The translator's second branch (`code ===
    // 'auth/email-already-exists'`) catches it. Production behavior
    // is verified end-to-end by the integration tests; this test
    // pins the route-layer translation surface.
    const fbError = new Error('The email address is already in use by another account.');
    Object.defineProperty(fbError, 'code', {
      value: 'auth/email-already-exists',
      enumerable: true,
    });
    sessionService.register.mockRejectedValueOnce(fbError);

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'DUPLICATE_EMAIL',
        message: 'Email is already registered',
      },
    });
  });

  it('returns 500 INTERNAL_ERROR with non-leaking body on an unrecognised service error (Rule R8)', async () => {
    // Rule R8 fail-closed: unrecognised error class produces a 500
    // with the generic envelope. The original error message is NOT
    // exposed — only the fixed `Internal server error` string.
    sessionService.register.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    // Original error details MUST NOT appear anywhere in the body.
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(JSON.stringify(res.body)).not.toContain('pg socket');
    expect(JSON.stringify(res.body)).not.toContain('EOF');
  });
});

// ===========================================================================
// Section C: POST /api/auth/login — ST-024
// ===========================================================================

describe('POST /api/auth/login — ST-024-AC1 (success path)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('returns 200 with { idToken, uid, expiresAt } on valid credentials (AC1)', async () => {
    // ST-024-AC1: "returns an opaque session token with a documented
    // lifetime and expiration timestamp." The route forwards the
    // service's LoginResult verbatim; the Date is serialised by
    // res.json to ISO-8601.
    const expiresAt = new Date('2025-12-31T23:59:59.000Z');
    sessionService.login.mockResolvedValueOnce({
      idToken: 'fake.jwt.idToken.value',
      uid: TEST_UID,
      expiresAt,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send(VALID_LOGIN_BODY)
      .expect('Content-Type', /json/);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      idToken: 'fake.jwt.idToken.value',
      uid: TEST_UID,
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('forwards { email, password } verbatim to sessionService.login', async () => {
    const expiresAt = new Date('2025-12-31T23:59:59.000Z');
    sessionService.login.mockResolvedValueOnce({
      idToken: 'fake.jwt.idToken.value',
      uid: TEST_UID,
      expiresAt,
    });

    await request(app).post('/api/auth/login').send(VALID_LOGIN_BODY);

    expect(sessionService.login).toHaveBeenCalledTimes(1);
    expect(sessionService.login).toHaveBeenCalledWith({
      email: VALID_LOGIN_BODY.email,
      password: VALID_LOGIN_BODY.password,
    });
  });

  it('two consecutive successful logins surface two distinct idTokens (AC3)', async () => {
    // ST-024-AC3: "Each successful login creates a new session
    // record". At the route layer this surfaces as two distinct
    // service calls returning two distinct idTokens; the route does
    // NOT memoise. Service-layer DB persistence is verified at
    // session.service.test.ts and the integration tests.
    const expiresAt = new Date('2025-12-31T23:59:59.000Z');
    sessionService.login
      .mockResolvedValueOnce({
        idToken: 'token-1',
        uid: TEST_UID,
        expiresAt,
      })
      .mockResolvedValueOnce({
        idToken: 'token-2',
        uid: TEST_UID,
        expiresAt,
      });

    const res1 = await request(app).post('/api/auth/login').send(VALID_LOGIN_BODY);
    const res2 = await request(app).post('/api/auth/login').send(VALID_LOGIN_BODY);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.idToken).toBe('token-1');
    expect(res2.body.idToken).toBe('token-2');
    expect(sessionService.login).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/auth/login — ST-024-AC2 (enumeration defense)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('returns 401 with INVALID_CREDENTIALS on wrong password (AC2)', async () => {
    // ST-024-AC2: "Invalid credentials return a generic failure
    // response that does not disclose whether the user identifier
    // exists." The translator emits a fixed code/message pair.
    sessionService.login.mockRejectedValueOnce(
      new TestUnauthenticatedError('invalid credentials', 'INVALID_CREDENTIALS'),
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send(VALID_LOGIN_BODY);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Authentication failed',
      },
    });
  });

  it('returns 401 INVALID_CREDENTIALS regardless of underlying cause (enumeration defense)', async () => {
    // The translator collapses ALL UnauthenticatedError causes — the
    // service may have hit `auth/user-not-found`, `auth/invalid-password`,
    // `auth/too-many-requests`, `auth/wrong-password`, etc. — into
    // ONE generic 401 with a fixed message. This test pins that
    // posture by throwing an UnauthenticatedError carrying internal
    // detail and asserting NO internal detail leaks.
    sessionService.login.mockRejectedValueOnce(
      new TestUnauthenticatedError(
        'auth/user-not-found: user record does not exist',
        'INVALID_CREDENTIALS',
      ),
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'any-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Authentication failed');

    // Defense regression: the response message MUST NOT leak any of
    // the disambiguating phrases. The fixed `Authentication failed`
    // message satisfies this; the assertions below pin it.
    const msg = String(res.body.error.message ?? '').toLowerCase();
    expect(msg).not.toContain('does not exist');
    expect(msg).not.toContain('not found');
    expect(msg).not.toContain('wrong password');
    expect(msg).not.toContain('invalid password');
    expect(msg).not.toContain('user record');
  });

  it('translates an error carrying code "INVALID_CREDENTIALS" without UnauthenticatedError name to 401 (second OR-branch)', async () => {
    // The translator branches on `name === 'UnauthenticatedError' ||
    // code === 'INVALID_CREDENTIALS'`. This test pins the second
    // half of the OR — a plain Error subclass with the recognised
    // code MUST still surface as 401 INVALID_CREDENTIALS.
    const fbError = new Error('Firebase REST returned 400 INVALID_PASSWORD');
    Object.defineProperty(fbError, 'code', {
      value: 'INVALID_CREDENTIALS',
      enumerable: true,
    });
    sessionService.login.mockRejectedValueOnce(fbError);

    const res = await request(app)
      .post('/api/auth/login')
      .send(VALID_LOGIN_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('Authentication failed');
  });

  it('does NOT echo the submitted password value into the response (AC4, Rule R2)', async () => {
    // ST-024-AC4: "do not echo credential material in any form."
    // Use a unique sentinel password, force a 401, and scan the
    // entire response (body + headers + text) for the sentinel.
    const SENTINEL_PASSWORD = 'SENTINEL_LOGIN_PASSWORD_XYZ789';
    sessionService.login.mockRejectedValueOnce(
      new TestUnauthenticatedError('invalid credentials', 'INVALID_CREDENTIALS'),
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: SENTINEL_PASSWORD });

    const responseSerialised = JSON.stringify({
      body: res.body,
      headers: res.headers,
      text: res.text,
    });
    expect(responseSerialised).not.toContain(SENTINEL_PASSWORD);
  });
});

describe('POST /api/auth/login — request validation', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('returns 400 VALIDATION_FAILED when login body is missing password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_LOGIN_IDENTIFIER });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.login).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when login body is missing email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'a-password' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.login).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when login email is malformed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'p' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.login).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when login password is empty string', async () => {
    // The login schema requires password.min(1) — empty rejected.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.login).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when an unknown top-level key is submitted (Zod .strict())', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: TEST_LOGIN_IDENTIFIER,
        password: 'a-password',
        rememberMe: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(sessionService.login).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — error translation (Rule R8 fail-closed)', () => {
  let sessionService: SessionServiceMock;
  let app: express.Express;

  beforeEach(() => {
    sessionService = buildSessionService();
    app = buildPublicApp({ sessionService });
  });

  it('translates a generic service-layer ValidationError to 400 with VALIDATION_FAILED', async () => {
    sessionService.login.mockRejectedValueOnce(
      new TestValidationError('email', 'email must be a non-empty string'),
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send(VALID_LOGIN_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'email must be a non-empty string',
      },
    });
  });

  it('returns 500 INTERNAL_ERROR with non-leaking body on an unrecognised service error (Rule R8)', async () => {
    sessionService.login.mockRejectedValueOnce(
      new Error('Firebase Auth REST adapter unreachable'),
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send(VALID_LOGIN_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    // Internal infrastructure detail MUST NOT appear in the body.
    expect(JSON.stringify(res.body)).not.toContain('Firebase');
    expect(JSON.stringify(res.body)).not.toContain('REST');
    expect(JSON.stringify(res.body)).not.toContain('unreachable');
  });
});

// ===========================================================================
// Section D: POST /api/auth/logout — ST-025
// ===========================================================================

describe('POST /api/auth/logout — ST-025-AC1/AC3 (success + idempotency)', () => {
  let sessionService: SessionServiceMock;

  beforeEach(() => {
    sessionService = buildSessionService();
  });

  it('returns 204 with empty body on a valid authenticated request (AC1)', async () => {
    sessionService.logout.mockResolvedValueOnce(undefined);
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer raw-token-value-xyz',
    });

    const res = await request(app).post('/api/auth/logout').send();

    // ST-025-AC1: the route returns the documented success status —
    // 204 No Content per REST conventions. No body.
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    // Empty body verification: 204 responses MUST NOT carry a JSON
    // payload per the HTTP/1.1 spec; `res.body` is `{}` from
    // supertest's superagent base for empty 204 responses.
    expect(res.body).toEqual({});
  });

  it('forwards { uid: req.uid, rawBearerToken: <stripped> } to sessionService.logout (AC1)', async () => {
    sessionService.logout.mockResolvedValueOnce(undefined);
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer raw-token-value-xyz',
    });

    await request(app).post('/api/auth/logout').send();

    // The "Bearer " prefix is stripped before forwarding — only the
    // raw token portion is passed to the service.
    expect(sessionService.logout).toHaveBeenCalledTimes(1);
    expect(sessionService.logout).toHaveBeenCalledWith({
      uid: TEST_UID,
      rawBearerToken: 'raw-token-value-xyz',
    });
  });

  it('strips the Bearer prefix case-insensitively (RFC 6750 deviation)', async () => {
    // The route's `extractRawBearer` uses `/^bearer\s+(\S+)$/i` —
    // accepts "Bearer", "bearer", "BEARER", etc. RFC 6750 specifies
    // case-sensitive, but the project documents the permissive
    // deviation in `auth.ts extractRawBearer` JSDoc.
    sessionService.logout.mockResolvedValue(undefined);
    const variants = ['bearer abc-lowercase', 'BEARER def-uppercase', 'BeArEr ghi-mixed'];

    for (const auth of variants) {
      sessionService.logout.mockClear();
      const app = buildAuthenticatedApp({
        sessionService,
        uid: TEST_UID,
        authorization: auth,
      });
      const res = await request(app).post('/api/auth/logout').send();
      expect(res.status).toBe(204);
      // The token portion (after the prefix) is forwarded verbatim.
      const expectedToken = auth.split(/\s+/)[1];
      expect(sessionService.logout).toHaveBeenCalledTimes(1);
      expect(sessionService.logout).toHaveBeenCalledWith({
        uid: TEST_UID,
        rawBearerToken: expectedToken,
      });
    }
  });

  it('repeated logout calls both return 204 (AC3 idempotency)', async () => {
    // ST-025-AC3: "Logout is idempotent: submitting the same revoked
    // token again returns a documented non-error response." The
    // service mock returns `undefined` on every call (mirroring the
    // repository's COALESCE-based idempotent SQL). The route layer
    // surfaces the documented 204 on each call.
    sessionService.logout.mockResolvedValue(undefined);
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer same-token',
    });

    const r1 = await request(app).post('/api/auth/logout').send();
    const r2 = await request(app).post('/api/auth/logout').send();
    const r3 = await request(app).post('/api/auth/logout').send();

    expect(r1.status).toBe(204);
    expect(r2.status).toBe(204);
    expect(r3.status).toBe(204);
    expect(sessionService.logout).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/auth/logout — ST-025-AC4 (defensive 401)', () => {
  let sessionService: SessionServiceMock;

  beforeEach(() => {
    sessionService = buildSessionService();
  });

  it('returns 401 UNAUTHENTICATED when req.uid is missing (AC4 defensive)', async () => {
    // ST-025-AC4: "Logout is rejected with a documented error when
    // called without a valid, non-expired session token." In
    // production this is enforced upstream by sessionMiddleware;
    // the route adds a defensive secondary check.
    const app = buildAuthenticatedApp({
      sessionService,
      // No uid — simulates the middleware being bypassed.
      authorization: 'Bearer some-token',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Session required' },
    });
    expect(sessionService.logout).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when req.uid is empty string', async () => {
    // Empty-string uid is treated as "missing" — the route's check
    // is `typeof uid !== 'string' || uid.length === 0`.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: '',
      authorization: 'Bearer some-token',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionService.logout).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when Authorization header is missing (AC4)', async () => {
    // Even with a valid uid, a missing Authorization header surfaces
    // 401 UNAUTHENTICATED — the route requires the raw token to
    // forward to the service for revocation lookup.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      // No authorization (`undefined` skips the conditional set).
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionService.logout).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when Authorization header has a non-Bearer scheme', async () => {
    // RFC 6750-compliant rejection: "Basic ..." MUST NOT be accepted.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Basic dXNlcjpwYXNz',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionService.logout).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when Authorization is "Bearer" with no token', async () => {
    // The regex requires `\s+(\S+)$` — empty token after the prefix
    // is a non-match and produces 401.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer ',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionService.logout).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when the Bearer token is whitespace-only', async () => {
    // Whitespace is stripped by the regex's `\S+` capture — a
    // whitespace-only "token" matches `\S+` against zero chars and
    // fails. This pins the regex's whitespace-rejection invariant.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer   \t  ',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionService.logout).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/logout — Rule R2 (no token leakage)', () => {
  it('does NOT echo the raw bearer token in the response body or headers', async () => {
    // Rule R2 sentinel scan: a unique token value MUST NOT appear in
    // any part of the response — body, headers, or raw text. The
    // 204 success response has no body at all, but the scan is
    // exhaustive to catch regressions.
    const sessionService = buildSessionService();
    sessionService.logout.mockResolvedValueOnce(undefined);
    const SENTINEL_TOKEN = 'SENTINEL_BEARER_TOKEN_VALUE_999';
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: `Bearer ${SENTINEL_TOKEN}`,
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(204);
    const responseSerialised = JSON.stringify({
      body: res.body,
      headers: res.headers,
      text: res.text,
    });
    expect(responseSerialised).not.toContain(SENTINEL_TOKEN);
  });

  it('does NOT echo the raw bearer token even on the 401 UNAUTHENTICATED defensive path', async () => {
    // Defense-in-depth: even when the route returns 401 (the bearer
    // token never reached the service), the token MUST NOT appear
    // in the response. This covers the path where `extractRawBearer`
    // returns null.
    const sessionService = buildSessionService();
    const SENTINEL_TOKEN = 'SENTINEL_INVALID_TOKEN_777';
    // Authorization scheme is invalid — extractRawBearer returns
    // null, the route emits 401. The token value is NOT in the
    // response by construction (the route never read it as a token),
    // but the assertion pins the invariant for future refactors.
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: `Basic ${SENTINEL_TOKEN}`,
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(401);
    const responseSerialised = JSON.stringify({
      body: res.body,
      headers: res.headers,
      text: res.text,
    });
    expect(responseSerialised).not.toContain(SENTINEL_TOKEN);
  });
});

describe('POST /api/auth/logout — error translation (Rule R8 fail-closed)', () => {
  it('translates an unrecognised service error to 500 INTERNAL_ERROR with non-leaking body', async () => {
    // Rule R8 fail-closed: a service-layer DB outage during logout
    // MUST surface as 500, NEVER as 204. The route does NOT report
    // success when the service threw.
    const sessionService = buildSessionService();
    sessionService.logout.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer some-token',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    // The fixed `Internal server error` message MUST NOT contain
    // any internal infrastructure detail.
    const lowered = String(res.body.error.message ?? '').toLowerCase();
    expect(lowered).not.toContain('db');
    expect(lowered).not.toContain('pg');
    expect(lowered).not.toContain('postgres');
    expect(lowered).not.toContain('unreachable');
    expect(lowered).not.toContain('terminated');
    expect(lowered).not.toContain('eof');
  });

  it('translates a service-layer ValidationError to 400 VALIDATION_FAILED with the service message', async () => {
    // Although logout's params (uid, rawBearerToken) are validated
    // upstream by the route, a defensive service-layer
    // re-validation MAY throw ValidationError. The route translator
    // surfaces 400 with the service's message.
    const sessionService = buildSessionService();
    sessionService.logout.mockRejectedValueOnce(
      new TestValidationError('rawBearerToken', 'rawBearerToken must be a non-empty string'),
    );
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer some-token',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'rawBearerToken must be a non-empty string',
      },
    });
  });

  it('logs unrecognised errors via req.log.error with bounded structural metadata (Rule R2)', async () => {
    // The error translator emits ONE log record per unrecognised
    // error: `{ event, errorName, errorCode, errorMessage }` plus
    // the static message 'auth route error'. Rule R2: no credential
    // material, no echoed body. The errorMessage is truncated to
    // 200 characters to bound log volume.
    const sessionService = buildSessionService();
    const logSpy: LogSpy = { error: jest.fn() };
    const longMessage = 'X'.repeat(500); // exceeds the 200-char cap
    const customErr = new Error(longMessage);
    Object.defineProperty(customErr, 'code', {
      value: 'PG_CONN_FAIL',
      enumerable: true,
    });
    sessionService.logout.mockRejectedValueOnce(customErr);
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer some-token',
      logSpy,
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs, logMsg] = logSpy.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logMsg).toBe('auth route error');
    expect(logArgs).toMatchObject({
      event: 'auth.route.error',
      errorName: 'Error',
      errorCode: 'PG_CONN_FAIL',
    });
    // The errorMessage MUST be a string and at most 200 chars.
    expect(typeof logArgs['errorMessage']).toBe('string');
    expect((logArgs['errorMessage'] as string).length).toBeLessThanOrEqual(200);
  });

  it('does not throw when req.log is absent (graceful degradation)', async () => {
    // If pino-http is not wired (e.g. early bootstrap, CLI tools),
    // the route MUST still produce a 500 — silently skipping the
    // log call rather than crashing.
    const sessionService = buildSessionService();
    sessionService.logout.mockRejectedValueOnce(new Error('boom'));
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer some-token',
      // No logSpy.
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates a malformed thrown value (no name, no message, no code) to 500 INTERNAL_ERROR', async () => {
    // Defense-in-depth: a non-Error throw value (`throw {}`,
    // `throw null`, `throw "oops"`) MUST produce a structured 500
    // rather than crash the worker. The translator's typeof
    // narrowing handles each branch without re-throw.
    const sessionService = buildSessionService();
    sessionService.logout.mockRejectedValueOnce({});
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: 'Bearer some-token',
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
});

// ===========================================================================
// Section E: Rule R2 — credential material absence (cross-route sentinel scans)
// ===========================================================================

describe('Rule R2 — credential material absence in responses', () => {
  it('register success response excludes the password sentinel under JSON.stringify scan', async () => {
    const sessionService = buildSessionService();
    sessionService.register.mockResolvedValueOnce({
      uid: TEST_UID,
      loginIdentifier: TEST_LOGIN_IDENTIFIER,
    });
    const app = buildPublicApp({ sessionService });
    const SENTINEL = 'SENTINEL_R2_REGISTER_PASSWORD_PROBE';

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: SENTINEL });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });

  it('login error response excludes the password sentinel under JSON.stringify scan', async () => {
    const sessionService = buildSessionService();
    sessionService.login.mockRejectedValueOnce(
      new TestUnauthenticatedError('invalid credentials', 'INVALID_CREDENTIALS'),
    );
    const app = buildPublicApp({ sessionService });
    const SENTINEL = 'SENTINEL_R2_LOGIN_PASSWORD_PROBE';

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_LOGIN_IDENTIFIER, password: SENTINEL });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });

  it('logout success response excludes the bearer token sentinel under JSON.stringify scan', async () => {
    const sessionService = buildSessionService();
    sessionService.logout.mockResolvedValueOnce(undefined);
    const SENTINEL = 'SENTINEL_R2_LOGOUT_BEARER_PROBE';
    const app = buildAuthenticatedApp({
      sessionService,
      uid: TEST_UID,
      authorization: `Bearer ${SENTINEL}`,
    });

    const res = await request(app).post('/api/auth/logout').send();

    expect(res.status).toBe(204);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(res.text).not.toContain(SENTINEL);
  });
});

// ===========================================================================
// Section F: Rule R9 — no settlement-processor vocabulary in auth.ts
// ===========================================================================

describe('Rule R9 — no settlement-processor vocabulary in auth.ts', () => {
  it('the auth.ts source file contains zero matches for the AAP forbidden-vocabulary grep', () => {
    // Read the source file from disk and run the AAP §0.8.1 R9 grep
    // pattern against it. The pattern is:
    //   stripe|braintree|paypal|payment_intent|charge
    // per AAP §0.7.2 / §0.8.1 R9.
    //
    // Verifying within this Jest test (rather than via an external
    // shell command) gives a Rule R8 fail-closed posture at the
    // test-suite layer — the suite refuses to pass if a future
    // commit accidentally introduces forbidden vocabulary.
    const source = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8');
    const forbidden = /stripe|braintree|paypal|payment_intent|charge/i;
    expect(source).not.toMatch(forbidden);
  });

  it('the auth.ts source file contains zero matches for the Rule R3 JWT-library grep', () => {
    // Rule R3 firewall: no `jsonwebtoken`, `jose`, or `jwt-decode`
    // imports. Token handling is delegated EXCLUSIVELY to Firebase
    // Admin SDK via the injected SessionService.
    const source = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"]jsonwebtoken['"]/);
    expect(source).not.toMatch(/from\s+['"]jose['"]/);
    expect(source).not.toMatch(/from\s+['"]jwt-decode['"]/);
  });

  it('the auth.ts source file contains zero process.env reads in non-comment code (Rule R4 firewall)', () => {
    // Rule R4 / AAP §0.5.6: env-var reads are owned by config/env.ts,
    // dependency-injected through services. The route file has zero
    // direct env-var access in CODE (the JSDoc may mention
    // `process.env.*` for documentation purposes — that is expected
    // and benign; the firewall is about the runtime read, not the
    // documentation reference).
    //
    // Strategy: strip all block- and line-comments from the source
    // first, then assert no `process.env.<IDENTIFIER>` pattern remains.
    // Comment-stripping uses a tolerant regex that matches `/* ... */`
    // and `// ...` runs; nested comment-like content inside string
    // literals would produce a false negative, but the `auth.ts`
    // source contains no env-var references inside string literals.
    const source = fs.readFileSync(path.join(__dirname, 'auth.ts'), 'utf-8');
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip /* block comments */
      .replace(/^\s*\*.*$/gm, '') // strip JSDoc continuation lines (` * ...`)
      .replace(/\/\/.*$/gm, ''); // strip // line comments
    expect(codeOnly).not.toMatch(/process\.env\.[A-Z_][A-Z0-9_]*/);
  });
});
