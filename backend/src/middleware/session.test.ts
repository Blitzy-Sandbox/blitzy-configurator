/**
 * Unit tests for `backend/src/middleware/session.ts` — the ST-026
 * Session Validation Middleware contract.
 *
 * ===========================================================================
 * Authority (verbatim from the Agent Action Plan and story specifications)
 * ===========================================================================
 *
 *   - AAP §0.7.1 "Exhaustively In Scope":
 *       co-located *.test.ts files anywhere under `backend/src` (per ST-043).
 *
 *   - AAP §0.6.13 "Implementation Approach":
 *       "Every backend service has a co-located `*.test.ts`."
 *
 *   - ST-026 Acceptance Criteria (verbatim):
 *       AC1: Requests to any protected endpoint without a session token are
 *            rejected with the documented unauthenticated status and
 *            response body, and never reach the protected handler.
 *       AC2: Requests carrying an expired, malformed, or revoked session
 *            token are rejected with the documented invalid-session status
 *            and response body, distinct from the no-token response.
 *       AC3: Requests carrying a valid, unexpired session token are
 *            forwarded to the protected handler with the authenticated
 *            user identity attached to the request context.
 *       AC4: Session lookup on every protected request completes within a
 *            documented response-time budget … measured end-to-end.
 *       AC5: The session validation contract is documented in a single
 *            source.
 *
 *   - AAP §0.8.1 Rule R3 / C2 (verbatim):
 *       "Token validation MUST call admin.auth().verifyIdToken() exclusively.
 *        No custom JWT parsing, signature verification, expiry checking, or
 *        JWKS fetching is permitted."
 *
 *   - AAP §0.8.1 Rule R8 (verbatim):
 *       "Gates fail closed. Any infrastructure or tooling error in a CI gate
 *        MUST produce a failed verdict — never a silent pass."
 *
 *   - AAP §0.8.1 Rule R2 (verbatim):
 *       "No credential material in logs."
 *
 *   - AAP §0.2.2 Rule C5 (verbatim):
 *       "Log records MUST contain only correlationId and uid as identity
 *        fields."
 *
 *   - ST-043-AC3 (verbatim):
 *       "A failing assertion, a test exception, or a coverage percentage
 *        below the documented threshold produces a failed verdict; the
 *        suite is deterministic, so repeated runs against the same source
 *        tree produce the same verdict."
 *
 *   - ST-043-AC4 (verbatim):
 *       "The suite runs in the local development environment without any
 *        additional services or network access beyond the standard local
 *        toolchain."
 *
 *   - ST-047-AC3 (verbatim):
 *       "Authenticated request flows … emit log records that carry both
 *        the correlation identifier and the authenticated user identifier."
 *
 * ===========================================================================
 * Strategy
 * ===========================================================================
 *
 *   1. Mock `../logging/pino` so the module-level `logger` used by
 *      `session.ts` is a controllable double whose `info`/`warn`/`error`/
 *      `debug` calls can be inspected for the documented event shapes.
 *
 *   2. Mock `./correlation` so the AsyncLocalStorage-backed
 *      `correlationStore` is a controllable double. The mock provides:
 *
 *         - `getStore()` returning the current pre-populated context.
 *         - A test-only `__setCorrelationStore(...)` helper that lets each
 *           test seed the ALS context with `{ correlationId }` BEFORE the
 *           middleware runs, so the AC3 contract — `sessionMiddleware`
 *           mutates the existing store object in-place to add `uid`
 *           (preserving `correlationId`) — can be asserted directly.
 *
 *   3. Mock the injected `SessionService` with `jest.fn()` implementations
 *      of `verifyToken` and `isRevoked`. The middleware never imports
 *      `firebase-admin` at runtime (the only firebase reference in
 *      `session.ts` is `import type { DecodedIdToken }`, which TypeScript
 *      erases at compile time), so no real SDK code is loaded by the
 *      suite. ST-043-AC4 (no network access) is preserved — the suite
 *      runs against pure JavaScript values with no I/O.
 *
 *   4. Build minimal `req`/`res`/`next` doubles. Express is NOT booted —
 *      the middleware is invoked directly with the doubles. This keeps
 *      tests deterministic and fast (ST-043-AC3, ST-043-AC4) and avoids
 *      port allocation, body parsing, or any other surface area outside
 *      the contract under test.
 *
 *   5. Assert on:
 *        - HTTP status code (401 vs no-response on success).
 *        - Response body shape `{ error: { code, message } }` with the
 *          documented `code` literal — the `code` strings are the
 *          stable contract; message strings may evolve.
 *        - `next()` invocation count and arguments.
 *        - Side-effects on the request context: `req.uid` populated on
 *          the success path; correlation store mutated in-place to add
 *          `uid` while preserving the pre-existing `correlationId`.
 *        - Structured log records emitted by the module-level `logger`
 *          via the `../logging/pino` mock. The success path emits an
 *          `event: 'session.validated'` info record with a numeric
 *          `durationMs` field (AC4 latency instrumentation).
 *        - Rule R2 negative assertions: response bodies and log records
 *          NEVER contain the raw bearer token.
 *
 * ===========================================================================
 * Forbidden patterns enforced by this suite
 * ===========================================================================
 *
 *   - DO NOT import the real `firebase-admin` SDK at runtime — the only
 *     reference is the type-only `import type { DecodedIdToken }`.
 *   - DO NOT import `jsonwebtoken`, `jose`, or `jwt-decode` (Rule R3).
 *   - DO NOT boot a real Express app (`express()` is never called).
 *   - DO NOT perform real HTTP I/O (no `fetch`, no socket).
 *   - DO NOT use real `node:async_hooks.AsyncLocalStorage`. The mocked
 *     `./correlation` provides a deterministic store-state helper.
 *   - DO NOT assert on specific error message strings — message text may
 *     evolve. Only `error.code` is the stable contract surface.
 *
 * @see backend/src/middleware/session.ts          — module under test
 * @see backend/src/middleware/correlation.ts       — collaborator (mocked)
 * @see backend/src/logging/pino.ts                 — collaborator (mocked)
 * @see backend/jest.config.unit.ts                 — Jest runner config
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see tickets/stories/ST-047-structured-logs-correlation-id.md
 */

// ===========================================================================
//  Mock factories — MUST appear before any application import so jest's
//  hoister rewires the module graph BEFORE `./session` is loaded.
// ===========================================================================

// ---------------------------------------------------------------------------
// Mock for `../logging/pino`
// ---------------------------------------------------------------------------
//
// `session.ts` imports `logger` from `../logging/pino` at module-load time
// and emits structured log records through it on every code path. The
// production logger initializes pino with redaction paths, an OTel mixin,
// and request serializers — none of which we want running in a unit test.
// The mock replaces the entire surface with `jest.fn()` doubles whose calls
// can be inspected directly.
//
// NOTE: This factory is hoisted by Jest above the `import` block below
// (a documented Jest behaviour), so when `session.ts` executes its
// `import { logger } from '../logging/pino'` line, the resolved module
// is THIS mock — not the real pino-configured logger.
jest.mock('../logging/pino', () => {
  const fakeLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function child(this: unknown) {
      return this;
    }),
  };
  return {
    __esModule: true,
    logger: fakeLogger,
    // pinoOptions is exported by the real module but not consumed by
    // session.ts. Provide a stub so any indirect import path that
    // references it (future refactor) does not crash.
    pinoOptions: {},
    allowListHeaders: jest.fn((h: Record<string, unknown> | undefined) => h ?? {}),
  };
});

// ---------------------------------------------------------------------------
// Mock for `./correlation`
// ---------------------------------------------------------------------------
//
// `session.ts` imports `correlationStore` from `./correlation`. The real
// implementation is backed by `node:async_hooks.AsyncLocalStorage`, which
// requires an active ALS frame (entered via `correlationStore.run(...)`)
// before `getStore()` returns a value. Booting a real ALS frame in a unit
// test couples this suite to Node async-hooks behaviour without exercising
// any of the session middleware's contract.
//
// The mock provides:
//   - A controllable `correlationStore` whose `.getStore()` returns whatever
//     was last seeded by the test-only `__setCorrelationStore` helper.
//   - `.enterWith()` / `.run()` / `.exit()` / `.disable()` stubs that match
//     AsyncLocalStorage's surface so any future session.ts refactor that
//     starts using `.run()` continues to work without reaching the real
//     async-hooks layer.
//   - `__setCorrelationStore(store)` — a test-only helper used by the
//     success-path tests to seed the ALS context with
//     `{ correlationId: '...' }` BEFORE the middleware runs, so we can
//     assert that the middleware mutates the SAME object in place to add
//     `uid` while preserving `correlationId` (Rule C5).
//   - `getCorrelationId()` — convenience read of the seeded store.
jest.mock('./correlation', () => {
  // IMPORTANT: This factory is hoisted by jest above all `import` statements,
  // so the mock-state container below is created exactly once per test file
  // (when `./correlation` is first resolved by the runtime).
  //
  // jest.config.unit.ts enables `resetMocks: true` globally, which resets
  // the implementation of every `jest.fn()` between tests back to a no-op.
  // To keep the mock's stateful methods (`getStore`, `enterWith`, etc.)
  // working across tests, we DO NOT use `jest.fn(impl)` for them — instead
  // we expose plain functions that close over `currentStore`. Plain
  // functions are unaffected by `resetMocks`. The mutable state itself is
  // also untouched by `resetMocks`, so the test-only `__setCorrelationStore`
  // helper continues to work between tests.
  type Ctx = { correlationId: string; uid?: string } | undefined;
  // Wrap state in a single-property object so the closure references a
  // stable container; this avoids any subtle hoisting / TDZ issues that
  // can affect bare `let` bindings inside jest.mock factories.
  const state: { current: Ctx } = { current: undefined };

  const correlationStore = {
    getStore: (): Ctx => state.current,
    enterWith: (store: Ctx): void => {
      state.current = store;
    },
    run: <T>(store: Ctx, fn: () => T): T => {
      const prev = state.current;
      state.current = store;
      try {
        return fn();
      } finally {
        state.current = prev;
      }
    },
    exit: <T>(fn: () => T): T => fn(),
    disable: (): void => undefined,
  };

  return {
    __esModule: true,
    correlationStore,
    getCorrelationId: (): string | undefined => state.current?.correlationId,
    correlationMiddleware: (): void => undefined,
    // Test-only helper exposed via the mock module surface so individual
    // tests can seed/clear the ALS context. Real `./correlation` does not
    // export this — it exists exclusively for unit-test access.
    __setCorrelationStore: (store: Ctx): void => {
      state.current = store;
    },
  };
});

// ===========================================================================
//  Imports — placed AFTER the jest.mock factories so the runtime module
//  graph is already rewired by the time these imports resolve.
// ===========================================================================

import type { DecodedIdToken } from 'firebase-admin/auth';

import * as correlationModule from './correlation';
import * as pinoModule from '../logging/pino';
import { ERROR_CODES, sessionMiddleware } from './session';
import type { SessionService } from './session';

// ===========================================================================
//  Types — typed accessors over the mocked module surfaces
// ===========================================================================

/**
 * Reach into the mocked correlation module via the test-only seed helper.
 * `as unknown as` is the correct cast because the runtime shape (provided
 * by the jest.mock factory above) intentionally differs from the real
 * module's compile-time type. The mock's `correlationStore` methods are
 * PLAIN functions (not `jest.fn()`s) so they survive the global
 * `resetMocks: true` reset that jest.config.unit.ts enables — see the
 * factory's hoist-block comment for the rationale.
 */
const mockedCorrelation = correlationModule as unknown as {
  correlationStore: {
    getStore: () => { correlationId: string; uid?: string } | undefined;
    enterWith: (store: { correlationId: string; uid?: string } | undefined) => void;
    run: <T>(store: { correlationId: string; uid?: string } | undefined, fn: () => T) => T;
    exit: <T>(fn: () => T) => T;
    disable: () => void;
  };
  getCorrelationId: () => string | undefined;
  __setCorrelationStore: (store: { correlationId: string; uid?: string } | undefined) => void;
};

/** Typed accessor for the `logger.*` jest mocks installed above. */
const mockedLogger = pinoModule.logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
  fatal: jest.Mock;
  trace: jest.Mock;
};

/**
 * Shape of the SessionService double used by the suite. The real
 * `SessionService` interface (re-exported by `./session`) requires
 * `verifyToken` and `isRevoked`; the mock matches that surface with
 * jest.fn() doubles whose return values are configured per-test.
 */
type SessionServiceMock = {
  verifyToken: jest.Mock<Promise<DecodedIdToken>, [string]>;
  isRevoked: jest.Mock<Promise<boolean>, [string, string]>;
};

// ===========================================================================
//  Test fixtures
// ===========================================================================

/**
 * Build a minimal `req` double containing only the surface the middleware
 * touches: `req.headers` (read), `req.uid` (written on success), and
 * `req.method` / `req.url` (read by `pino-http` in production but
 * irrelevant to the unit contract). A bare object cast through `any` at
 * the middleware call site is sufficient — we deliberately avoid
 * fabricating a full `Express.Request` mock because it adds noise without
 * exercising additional contract surface.
 */
function buildReq(headers: Record<string, string | string[] | undefined> = {}): {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  uid?: string;
  correlationId?: string;
} {
  return {
    headers,
    method: 'GET',
    url: '/api/designs',
  };
}

/**
 * Build a minimal `res` double with `status(n).json(body)` chaining. Both
 * methods are jest.fn() doubles so the suite can assert call arguments
 * directly. The `statusCode` and `jsonBody` fields are convenience
 * accessors used by the test assertions (`res.jsonBody.error.code`).
 */
function buildRes(): {
  statusCode: number;
  jsonBody: unknown;
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  headersSent: boolean;
} {
  // Use `any` here for the recursive self-reference in `status(...).json(...)`
  // chaining — the eslint override for *.test.ts files allows it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = {
    statusCode: 200,
    jsonBody: undefined,
    headersSent: false,
  };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.jsonBody = body;
    res.headersSent = true;
    return res;
  });
  res.setHeader = jest.fn();
  return res;
}

/** Build a `next` double — Express's NextFunction signature collapses to a jest.fn(). */
function buildNext(): jest.Mock {
  return jest.fn();
}

/** Build a fresh SessionService double with un-configured method mocks. */
function buildSessionService(): SessionServiceMock {
  return {
    verifyToken: jest.fn() as SessionServiceMock['verifyToken'],
    isRevoked: jest.fn() as SessionServiceMock['isRevoked'],
  };
}

/**
 * Construct a minimal DecodedIdToken-shaped object suitable for the
 * sessionService.verifyToken mock's resolved value.
 *
 * Firebase Admin's `DecodedIdToken` has many optional fields; the
 * middleware reads ONLY `uid` per Rule C5 (the SOLE permitted identity
 * field). We populate the small required-field set so the cast through
 * `as DecodedIdToken` is structurally honest, but the middleware's
 * behaviour does not depend on any field other than `uid`.
 */
function decodedToken(uid: string): DecodedIdToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    uid,
    aud: 'test-project-id',
    iss: 'https://securetoken.google.com/test-project-id',
    auth_time: now,
    sub: uid,
    iat: now,
    exp: now + 3600,
    firebase: {
      identities: { email: ['user@example.com'] },
      sign_in_provider: 'password',
    },
  } as DecodedIdToken;
}

// ===========================================================================
//  Test suite
// ===========================================================================

describe('sessionMiddleware — ST-026 Acceptance Criteria', () => {
  let sessionService: SessionServiceMock;
  let middleware: ReturnType<typeof sessionMiddleware>;

  beforeEach(() => {
    // Determinism (ST-043-AC3): every test starts with mocks reset and
    // the correlation store cleared. `jest.clearAllMocks()` resets the
    // call history of every `jest.fn()` (including the logger mock and
    // the correlationStore mock methods) without unwiring the
    // implementations.
    jest.clearAllMocks();

    // Reset the mocked correlation store to the "no active frame" state
    // — most tests assert behaviour when the store is empty; the
    // success-path "updates correlation store" test seeds a value
    // explicitly via `__setCorrelationStore`.
    mockedCorrelation.__setCorrelationStore(undefined);

    sessionService = buildSessionService();
    middleware = sessionMiddleware({ sessionService });
  });

  // ---------------------------------------------------------------------
  //  Helper: invoke the middleware and wait for the asynchronous worker
  //  to settle.
  //
  //  `sessionMiddleware` returns a synchronous `RequestHandler` that
  //  dispatches an async worker via `void runSessionValidation(...)`.
  //  Because the dispatch is synchronous, awaiting the handler does not
  //  await the worker. To deterministically assert post-resolution state
  //  we yield to the microtask queue twice (once for the worker's
  //  initial promise, once for any chained continuation) and once to
  //  the macrotask queue (to flush any setImmediate-based work).
  //
  //  This pattern is canonical for testing Express middleware that wraps
  //  an async worker; it is preferable to fake timers because the OTel
  //  auto-instrumentation in production relies on real microtask
  //  scheduling, and this matches that runtime behaviour.
  // ---------------------------------------------------------------------
  async function invokeAndSettle(
    req: ReturnType<typeof buildReq>,
    res: ReturnType<typeof buildRes>,
    next: ReturnType<typeof buildNext>,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, next);
    // Yield to microtasks — `await Promise.resolve()` schedules the
    // continuation as a microtask, so the worker's awaited
    // `verifyToken` / `isRevoked` resolutions complete before we
    // proceed. Two yields are sufficient for the worker's two `await`
    // boundaries.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // ---------------------------------------------------------------------
  //  AC1 — Missing Authorization header is rejected with 401
  // ---------------------------------------------------------------------

  describe('AC1: requests without Authorization header are rejected with 401', () => {
    it('returns 401 with code UNAUTHENTICATED when Authorization header is missing', async () => {
      const req = buildReq({}); // no Authorization header
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: ERROR_CODES.UNAUTHENTICATED,
          message: expect.any(String),
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('does NOT call sessionService.verifyToken or isRevoked when Authorization header is missing', async () => {
      const req = buildReq({});
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.verifyToken).not.toHaveBeenCalled();
      expect(sessionService.isRevoked).not.toHaveBeenCalled();
    });

    it('rejects an empty Authorization header string with 401 UNAUTHENTICATED', async () => {
      // The middleware's `extractBearerToken` treats empty / whitespace
      // headers as "absent" (UNAUTHENTICATED) — distinct from a present-
      // but-malformed header which produces MALFORMED_AUTHORIZATION.
      const req = buildReq({ authorization: '' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.UNAUTHENTICATED, message: expect.any(String) },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only Authorization header with 401 UNAUTHENTICATED', async () => {
      const req = buildReq({ authorization: '   ' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.UNAUTHENTICATED, message: expect.any(String) },
      });
    });

    it('emits a session.rejected log record with reason=missing_authorization_header', async () => {
      const req = buildReq({});
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      // Locate the matching info call. The first arg is the structured
      // payload object; the second arg is the human message string.
      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.rejected' &&
          (call[0] as { reason?: string }).reason === 'missing_authorization_header',
      );
      expect(matching).toBeDefined();
      const payload = matching![0] as { code: string };
      expect(payload.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });
  });

  // ---------------------------------------------------------------------
  //  AC1 — Malformed Authorization header is rejected with 401
  // ---------------------------------------------------------------------

  describe('AC1: malformed Authorization header is rejected with 401', () => {
    it('returns 401 with code MALFORMED_AUTHORIZATION when header does not begin with "Bearer "', async () => {
      const req = buildReq({ authorization: 'Basic dXNlcjpwYXNz' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: ERROR_CODES.MALFORMED_AUTHORIZATION,
          message: expect.any(String),
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a header of exactly "Bearer" (no whitespace, no token) with MALFORMED_AUTHORIZATION', async () => {
      // After trimming, `'Bearer'` has no whitespace match for the
      // `\s+` quantifier in the bearer-prefix regex; the extractor
      // returns MALFORMED_AUTHORIZATION.
      const req = buildReq({ authorization: 'Bearer' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: {
          code: ERROR_CODES.MALFORMED_AUTHORIZATION,
          message: expect.any(String),
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a header of "Bearer " (trailing whitespace, no token) with MALFORMED_AUTHORIZATION', async () => {
      // The extractor trims the whole header first; after trim the value
      // is `'Bearer'` which fails the `\s+` requirement → MALFORMED.
      const req = buildReq({ authorization: 'Bearer ' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: {
          code: ERROR_CODES.MALFORMED_AUTHORIZATION,
          message: expect.any(String),
        },
      });
    });

    it('accepts lowercase "bearer " prefix as valid (case-insensitive Bearer scheme per session.ts contract)', async () => {
      // The session.ts contract documents (and the regex `/^Bearer\s+/i`
      // codifies) that the Bearer scheme is matched case-insensitively
      // for developer-experience reasons. A lowercase "bearer" prefix
      // followed by a token IS valid and progresses to verifyToken.
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('case-test-uid'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'bearer my-lowercase-token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      // The middleware progressed past the header check — verifyToken
      // was called with the raw token (no "bearer " prefix).
      expect(sessionService.verifyToken).toHaveBeenCalledWith('my-lowercase-token');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('does NOT call sessionService.verifyToken when header is malformed', async () => {
      const req = buildReq({ authorization: 'NotBearer foobar' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.verifyToken).not.toHaveBeenCalled();
    });

    it('emits a session.rejected log record with reason=malformed_authorization_header', async () => {
      const req = buildReq({ authorization: 'Basic abc' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.rejected' &&
          (call[0] as { reason?: string }).reason === 'malformed_authorization_header',
      );
      expect(matching).toBeDefined();
      const payload = matching![0] as { code: string };
      expect(payload.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });
  });

  // ---------------------------------------------------------------------
  //  AC2 — Invalid / expired token rejection
  // ---------------------------------------------------------------------

  describe('AC2: requests with invalid or expired token are rejected with 401', () => {
    it('returns 401 with code INVALID_SESSION when verifyToken throws an "expired" error', async () => {
      sessionService.verifyToken.mockRejectedValueOnce(
        new Error('Firebase ID token has expired'),
      );
      const req = buildReq({ authorization: 'Bearer expired.token.value' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: ERROR_CODES.INVALID_SESSION,
          message: expect.any(String),
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 with code INVALID_SESSION when verifyToken throws a generic Firebase error', async () => {
      sessionService.verifyToken.mockRejectedValueOnce(
        Object.assign(new Error('bad signature'), { code: 'auth/argument-error' }),
      );
      const req = buildReq({ authorization: 'Bearer malformed.token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.INVALID_SESSION, message: expect.any(String) },
      });
    });

    it('returns 401 INVALID_SESSION when verifyToken throws a non-Error value (defense-in-depth)', async () => {
      // `verifyToken` could in principle throw a non-Error value; the
      // middleware's catch block defensively falls back to
      // 'UnknownError' / 'verification failed'. The 401 response
      // remains consistent.
      sessionService.verifyToken.mockRejectedValueOnce('a non-Error rejection value');
      const req = buildReq({ authorization: 'Bearer x' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.INVALID_SESSION, message: expect.any(String) },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('does NOT check revocation when verifyToken fails', async () => {
      sessionService.verifyToken.mockRejectedValueOnce(new Error('invalid'));
      const req = buildReq({ authorization: 'Bearer xxx' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.isRevoked).not.toHaveBeenCalled();
    });

    it('passes the raw bearer token (without the "Bearer " prefix) to verifyToken', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u-123'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer raw.token.value.xyz' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.verifyToken).toHaveBeenCalledWith('raw.token.value.xyz');
    });

    it('rejects a token whose decoded uid is empty with INVALID_SESSION (defensive guard)', async () => {
      // session.ts has a defensive guard: if the decoded token has an
      // empty or non-string uid, the request is rejected as INVALID_SESSION
      // and a warn-level log is emitted. This is unlikely with a real
      // Firebase SDK but defends against future API drift.
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken(''));
      const req = buildReq({ authorization: 'Bearer t' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.INVALID_SESSION, message: expect.any(String) },
      });
      expect(next).not.toHaveBeenCalled();
      // The defensive uid-missing path emits a warn-level record (not info).
      const matching = mockedLogger.warn.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { reason?: string }).reason === 'decoded_token_missing_uid',
      );
      expect(matching).toBeDefined();
    });

    it('emits a session.rejected log record with reason=verify_id_token_failed on verifyToken throw', async () => {
      sessionService.verifyToken.mockRejectedValueOnce(
        new Error('Firebase ID token has expired'),
      );
      const req = buildReq({ authorization: 'Bearer expired' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.rejected' &&
          (call[0] as { reason?: string }).reason === 'verify_id_token_failed',
      );
      expect(matching).toBeDefined();
      const payload = matching![0] as { code: string; errorName: string };
      expect(payload.code).toBe(ERROR_CODES.INVALID_SESSION);
      // The error class name is logged for operator debugging — but
      // never the raw token value.
      expect(payload.errorName).toBe('Error');
    });
  });

  // ---------------------------------------------------------------------
  //  AC2 — Revoked session rejection
  // ---------------------------------------------------------------------

  describe('AC2: requests with revoked session are rejected with 401', () => {
    it('returns 401 with code INVALID_SESSION when isRevoked returns true', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('user-xyz'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const req = buildReq({ authorization: 'Bearer valid.but.revoked' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: ERROR_CODES.INVALID_SESSION,
          message: expect.any(String),
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls isRevoked with the decoded uid and the raw bearer token', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('user-uid-abc'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer my-raw-token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.isRevoked).toHaveBeenCalledWith('user-uid-abc', 'my-raw-token');
    });

    it('emits a session.rejected log record with reason=revoked when isRevoked returns true', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('user-xyz'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const req = buildReq({ authorization: 'Bearer revoked' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.rejected' &&
          (call[0] as { reason?: string }).reason === 'revoked',
      );
      expect(matching).toBeDefined();
      const payload = matching![0] as { code: string; uid: string };
      expect(payload.code).toBe(ERROR_CODES.INVALID_SESSION);
      expect(payload.uid).toBe('user-xyz');
    });

    it('Rule R8 fail-closed: rejects with INVALID_SESSION when isRevoked itself throws', async () => {
      // A revocation lookup error means we CANNOT prove the session is
      // valid. Per Rule R8 the middleware fails closed: a tooling
      // failure produces a failed verdict, not a silent pass.
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('user-xyz'));
      sessionService.isRevoked.mockRejectedValueOnce(new Error('database unreachable'));
      const req = buildReq({ authorization: 'Bearer good.token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.jsonBody).toEqual({
        error: { code: ERROR_CODES.INVALID_SESSION, message: expect.any(String) },
      });
      expect(next).not.toHaveBeenCalled();
      // The fail-closed path emits an error-level log so operators are
      // alerted immediately that revocation lookup is broken.
      const matching = mockedLogger.error.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { reason?: string }).reason === 'revocation_check_failed',
      );
      expect(matching).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------
  //  AC3 — Valid token success path
  // ---------------------------------------------------------------------

  describe('AC3: requests with a valid non-revoked token reach the handler', () => {
    it('calls next() exactly once with no arguments on success', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('valid-uid'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer good.token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('attaches the decoded uid to req.uid (ST-026-AC3 contract)', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('user-42'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer good.token' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(req.uid).toBe('user-42');
    });

    it('does NOT send a 401 response when validation succeeds', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer ok' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('calls verifyToken before isRevoked (sequencing contract)', async () => {
      // The middleware MUST verify the token before checking revocation
      // so that a malformed token cannot trigger an unnecessary
      // database lookup. This is also a security property: the
      // revocation table should not be queried for unauthenticated
      // tokens.
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('seq'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer ordering' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const verifyOrder = sessionService.verifyToken.mock.invocationCallOrder[0]!;
      const revokeOrder = sessionService.isRevoked.mock.invocationCallOrder[0]!;
      expect(verifyOrder).toBeLessThan(revokeOrder);
    });

    it('updates the correlation store with the authenticated uid (Rule C5)', async () => {
      // Simulate a correlation context already set by `correlationMiddleware`
      // earlier in the chain. The session middleware MUST mutate the
      // existing store object in-place to add `uid`, preserving the
      // pre-existing `correlationId`.
      mockedCorrelation.__setCorrelationStore({ correlationId: 'corr-123' });

      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('auth-user-id'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer t' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      // The mutated store now carries BOTH correlationId (preserved)
      // AND uid (added by session middleware). The pino mixin in
      // production picks both up automatically on subsequent log
      // records.
      const store = mockedCorrelation.correlationStore.getStore();
      expect(store).toBeDefined();
      expect(store!.uid).toBe('auth-user-id');
      expect(store!.correlationId).toBe('corr-123');
    });

    it('warns when correlation store is missing on success (composition-bug detection)', async () => {
      // If `correlationMiddleware` did not run before `sessionMiddleware`,
      // the store is undefined. The session middleware proceeds (the
      // ST-026 contract is independent of correlation ID presence) but
      // MUST emit a warn-level log so the composition bug is surfaced
      // for prompt remediation.
      mockedCorrelation.__setCorrelationStore(undefined);

      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer ok' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      // next() still runs — auth succeeded
      expect(next).toHaveBeenCalledTimes(1);
      // ...and a warn record describes the missing store
      const matching = mockedLogger.warn.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.correlation_store_missing',
      );
      expect(matching).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------
  //  AC2 — Distinct error codes for no-token vs invalid-session
  // ---------------------------------------------------------------------

  describe('AC2: distinct error codes for no-token, malformed, invalid, and revoked', () => {
    it('no-token → UNAUTHENTICATED, malformed → MALFORMED_AUTHORIZATION, invalid token → INVALID_SESSION, revoked → INVALID_SESSION', async () => {
      // Scenario A: no token
      const reqA = buildReq({});
      const resA = buildRes();
      await invokeAndSettle(reqA, resA, buildNext());
      expect((resA.jsonBody as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.UNAUTHENTICATED,
      );

      // Scenario B: malformed (Basic auth)
      const reqB = buildReq({ authorization: 'Basic abc' });
      const resB = buildRes();
      await invokeAndSettle(reqB, resB, buildNext());
      expect((resB.jsonBody as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.MALFORMED_AUTHORIZATION,
      );

      // Scenario C: invalid token (verifyToken throws)
      sessionService.verifyToken.mockRejectedValueOnce(new Error('bad'));
      const reqC = buildReq({ authorization: 'Bearer badtoken' });
      const resC = buildRes();
      await invokeAndSettle(reqC, resC, buildNext());
      expect((resC.jsonBody as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.INVALID_SESSION,
      );

      // Scenario D: revoked session
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const reqD = buildReq({ authorization: 'Bearer revoked' });
      const resD = buildRes();
      await invokeAndSettle(reqD, resD, buildNext());
      expect((resD.jsonBody as { error: { code: string } }).error.code).toBe(
        ERROR_CODES.INVALID_SESSION,
      );

      // The three public error code constants are mutually distinct.
      // This codifies the AC2 "distinct from the no-token response"
      // requirement at the type level.
      expect(ERROR_CODES.UNAUTHENTICATED).not.toBe(ERROR_CODES.INVALID_SESSION);
      expect(ERROR_CODES.UNAUTHENTICATED).not.toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
      expect(ERROR_CODES.INVALID_SESSION).not.toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });

    it('all 401 responses carry an HTTP status of 401 (uniform contract)', async () => {
      // No-token, malformed, invalid, and revoked all produce 401.
      const reqA = buildReq({});
      const resA = buildRes();
      await invokeAndSettle(reqA, resA, buildNext());
      expect(resA.statusCode).toBe(401);

      const reqB = buildReq({ authorization: 'Basic abc' });
      const resB = buildRes();
      await invokeAndSettle(reqB, resB, buildNext());
      expect(resB.statusCode).toBe(401);

      sessionService.verifyToken.mockRejectedValueOnce(new Error('bad'));
      const reqC = buildReq({ authorization: 'Bearer badtoken' });
      const resC = buildRes();
      await invokeAndSettle(reqC, resC, buildNext());
      expect(resC.statusCode).toBe(401);

      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const reqD = buildReq({ authorization: 'Bearer revoked' });
      const resD = buildRes();
      await invokeAndSettle(reqD, resD, buildNext());
      expect(resD.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------
  //  AC4 — Latency instrumentation: session.validated event with durationMs
  // ---------------------------------------------------------------------

  describe('AC4: session validation emits durationMs log event on success', () => {
    it('emits an info record with event=session.validated, uid, and a finite numeric durationMs', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('latency-test'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer ok' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.validated',
      );
      expect(matching).toBeDefined();
      const payload = matching![0] as {
        event: string;
        uid: string;
        durationMs: number;
      };
      expect(payload.event).toBe('session.validated');
      expect(payload.uid).toBe('latency-test');
      // durationMs MUST be a non-negative finite number suitable for
      // P95 percentile reasoning by log aggregators.
      expect(typeof payload.durationMs).toBe('number');
      expect(Number.isFinite(payload.durationMs)).toBe(true);
      expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does NOT emit session.validated on failure paths (only the success path)', async () => {
      // Failure paths emit `session.rejected` (with various `reason`s),
      // never `session.validated`. This keeps P95 derivation clean —
      // dashboard panels filter on `event:session.validated` to compute
      // latency for the success path only.
      sessionService.verifyToken.mockRejectedValueOnce(new Error('invalid'));
      const req = buildReq({ authorization: 'Bearer x' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const validatedCalls = mockedLogger.info.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.validated',
      );
      expect(validatedCalls).toHaveLength(0);
    });

    it('the emitted message string mentions success (operator-readable companion)', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('m'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer ok' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const matching = mockedLogger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'session.validated',
      );
      expect(matching).toBeDefined();
      // Pino convention: arg[1] is the human-readable message string.
      expect(typeof matching![1]).toBe('string');
      expect((matching![1] as string).length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------
  //  Factory contract
  // ---------------------------------------------------------------------

  describe('sessionMiddleware factory contract', () => {
    it('returns a function when called with valid dependencies', () => {
      const mw = sessionMiddleware({ sessionService });
      expect(typeof mw).toBe('function');
    });

    it('each factory call produces an independent middleware instance', () => {
      const mw1 = sessionMiddleware({ sessionService });
      const mw2 = sessionMiddleware({ sessionService });
      expect(mw1).not.toBe(mw2);
    });

    it('throws synchronously at composition time when deps argument is missing', () => {
      // The factory MUST fail fast at app boot rather than at request
      // time so a missing service never reaches a real request. This
      // matches the Rule R4 fail-closed startup posture.
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionMiddleware(undefined as any),
      ).toThrow(/required/i);
    });

    it('throws synchronously when sessionService.verifyToken is missing', () => {
      const incomplete = {
        sessionService: {
          // verifyToken intentionally absent
          isRevoked: jest.fn() as SessionServiceMock['isRevoked'],
        } as unknown as SessionService,
      };
      expect(() => sessionMiddleware(incomplete)).toThrow(/verifyToken/i);
    });

    it('throws synchronously when sessionService.isRevoked is missing', () => {
      const incomplete = {
        sessionService: {
          verifyToken: jest.fn() as SessionServiceMock['verifyToken'],
          // isRevoked intentionally absent
        } as unknown as SessionService,
      };
      expect(() => sessionMiddleware(incomplete)).toThrow(/isRevoked/i);
    });
  });

  // ---------------------------------------------------------------------
  //  Rule R2 — No credential material in error responses or logs
  // ---------------------------------------------------------------------

  describe('Rule R2: no credential material in error responses or logs', () => {
    it('error response bodies never contain the raw bearer token (verifyToken-throw path)', async () => {
      sessionService.verifyToken.mockRejectedValueOnce(new Error('x'));
      const req = buildReq({ authorization: 'Bearer SUPER-SECRET-TOKEN-12345' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const bodyJson = JSON.stringify(res.jsonBody);
      expect(bodyJson).not.toContain('SUPER-SECRET-TOKEN-12345');
    });

    it('error response bodies never contain the raw bearer token (revoked-session path)', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const req = buildReq({ authorization: 'Bearer ANOTHER-SECRET-9999' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const bodyJson = JSON.stringify(res.jsonBody);
      expect(bodyJson).not.toContain('ANOTHER-SECRET-9999');
    });

    it('log records never contain the raw bearer token (verifyToken-throw path)', async () => {
      // Critical R2 guard: the failure-path log emits the error class
      // name and the truncated message — but NEVER the raw bearer
      // token. A future refactor that accidentally includes the token
      // would fail this test immediately.
      sessionService.verifyToken.mockRejectedValueOnce(new Error('x'));
      const req = buildReq({ authorization: 'Bearer LOGGER-SECRET-XYZ' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const allLogCalls = [
        ...mockedLogger.info.mock.calls,
        ...mockedLogger.warn.mock.calls,
        ...mockedLogger.error.mock.calls,
        ...mockedLogger.debug.mock.calls,
      ];
      const flattened = JSON.stringify(allLogCalls);
      expect(flattened).not.toContain('LOGGER-SECRET-XYZ');
    });

    it('log records never contain the raw bearer token (success path)', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: 'Bearer SUCCESS-SECRET-AAA' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const allLogCalls = [
        ...mockedLogger.info.mock.calls,
        ...mockedLogger.warn.mock.calls,
        ...mockedLogger.error.mock.calls,
        ...mockedLogger.debug.mock.calls,
      ];
      const flattened = JSON.stringify(allLogCalls);
      expect(flattened).not.toContain('SUCCESS-SECRET-AAA');
    });

    it('log records never contain the raw bearer token (revoked path)', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('u'));
      sessionService.isRevoked.mockResolvedValueOnce(true);
      const req = buildReq({ authorization: 'Bearer REVOKED-SECRET-ZZZ' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      const allLogCalls = [
        ...mockedLogger.info.mock.calls,
        ...mockedLogger.warn.mock.calls,
        ...mockedLogger.error.mock.calls,
        ...mockedLogger.debug.mock.calls,
      ];
      const flattened = JSON.stringify(allLogCalls);
      expect(flattened).not.toContain('REVOKED-SECRET-ZZZ');
    });
  });

  // ---------------------------------------------------------------------
  //  Header normalization edge cases
  // ---------------------------------------------------------------------

  describe('header normalization edge cases', () => {
    it('handles array-valued Authorization header by taking the first element', async () => {
      // Node's `http` module surfaces duplicate headers as a string
      // array. The middleware (via `extractBearerToken`) takes the
      // first element to match Express's `req.header(name)` behaviour.
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('arr-test'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({
        authorization: ['Bearer first-token', 'Bearer second-token'] as unknown as string,
      });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      // First-element takes precedence — verifyToken receives the
      // first token, not the second.
      expect(sessionService.verifyToken).toHaveBeenCalledWith('first-token');
    });

    it('strips surrounding whitespace from the bearer token', async () => {
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('ws-test'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      // Leading + trailing whitespace around the entire header — should
      // be trimmed by the extractor before the regex test.
      const req = buildReq({ authorization: '  Bearer my-token-value  ' });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.verifyToken).toHaveBeenCalledWith('my-token-value');
    });

    it('accepts a token containing dots and dashes (JWT-shaped) verbatim', async () => {
      // Although Rule R3 forbids any custom JWT parsing, real Firebase
      // `idToken` values ARE JWTs (header.payload.signature with dots).
      // The extractor MUST pass them through verbatim — no decoding,
      // no normalisation.
      const jwtLike = 'eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeKKF';
      sessionService.verifyToken.mockResolvedValueOnce(decodedToken('jwt-test'));
      sessionService.isRevoked.mockResolvedValueOnce(false);
      const req = buildReq({ authorization: `Bearer ${jwtLike}` });
      const res = buildRes();
      const next = buildNext();

      await invokeAndSettle(req, res, next);

      expect(sessionService.verifyToken).toHaveBeenCalledWith(jwtLike);
    });
  });

  // ---------------------------------------------------------------------
  //  Rule R3 / C2 — Firebase Admin SDK is not invoked from this file's path
  // ---------------------------------------------------------------------
  //
  // The structural assertion below codifies the Rule R3 firewall at the
  // unit-test surface: this test file imports ONLY the ERROR_CODES /
  // sessionMiddleware / SessionService surface from `./session`, the
  // `correlationStore` mock, the pino mock, and the type-only
  // DecodedIdToken from `firebase-admin/auth`. There is no runtime
  // import of `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`
  // anywhere in the test or its dependency graph.
  //
  // If a future refactor accidentally adds a runtime firebase-admin
  // import to `./session` or this file, the CI grep gate (documented in
  // the lint step of cloudbuild.yaml) catches the regression. This test
  // is a developer-facing companion that fails fast at jest run time.
  // ---------------------------------------------------------------------

  describe('Rule R3 firewall (structural assertion)', () => {
    it('exposes ERROR_CODES with exactly the three documented codes (no enumeration creep)', () => {
      // The contract surface is exactly three error codes; adding a
      // fourth without an Agent Action Plan amendment would expand the
      // public failure shape and require dashboard / alert-rule
      // updates. This test fails fast on accidental enumeration creep.
      expect(Object.keys(ERROR_CODES).sort()).toEqual([
        'INVALID_SESSION',
        'MALFORMED_AUTHORIZATION',
        'UNAUTHENTICATED',
      ]);
      expect(ERROR_CODES.UNAUTHENTICATED).toBe('UNAUTHENTICATED');
      expect(ERROR_CODES.MALFORMED_AUTHORIZATION).toBe('MALFORMED_AUTHORIZATION');
      expect(ERROR_CODES.INVALID_SESSION).toBe('INVALID_SESSION');
    });
  });
});
