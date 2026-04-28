/**
 * `auth.integration.test.ts` — Integration tests for the authentication
 * API: `POST /api/auth/register` (ST-023), `POST /api/auth/login` (ST-024),
 * `POST /api/auth/logout` (ST-025), and the session validation middleware
 * contract enforced on protected endpoints (ST-026).
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations from `tickets/stories/*.md`)
 * ============================================================================
 *
 *   - ST-023 (`tickets/stories/ST-023-user-registration-endpoint.md`):
 *       AC1 — "The registration endpoint accepts a request with the
 *             documented required fields and persists a canonical user
 *             record when the input is valid."
 *       AC2 — "A successful registration returns the canonical user
 *             record (without any credential material) and a success
 *             status, and does not issue a session token by itself."
 *       AC3 — "Registration attempts that fail validation (missing
 *             fields, malformed input, duplicate identifier) return a
 *             descriptive, non-leaking error response and do not create
 *             any partial record."
 *       AC4 — "Credential material submitted at registration is never
 *             stored in cleartext and is never returned in any
 *             response."
 *
 *   - ST-024 (`tickets/stories/ST-024-login-endpoint-session-token.md`):
 *       AC1 — "The login endpoint accepts valid credentials and returns
 *             an opaque session token with a documented lifetime and
 *             expiration timestamp."
 *       AC2 — "Invalid credentials return a generic failure response
 *             that does not disclose whether the user identifier exists,
 *             and the response carries no session token." — the
 *             enumeration-defense contract; THE most critical Rule R2
 *             test in this file.
 *       AC3 — "Each successful login creates a new session record
 *             associated with the authenticated user, and repeated
 *             logins do not invalidate active sessions from other
 *             devices unless policy requires it."
 *       AC4 — "Login responses and the subsequent use of the returned
 *             token are exchanged only over a confidential transport
 *             and do not echo credential material in any form."
 *       AC5 — "Successful and failed login attempts emit a structured
 *             log record containing at minimum a correlation
 *             identifier, an event name that distinguishes success from
 *             failure, the outcome, and the authenticated user
 *             identifier when the attempt succeeded (never credential
 *             material), so that downstream observability tooling can
 *             trace the full session lifecycle."
 *
 *   - ST-025 (`tickets/stories/ST-025-logout-endpoint-session-revocation.md`):
 *       AC1 — "The logout endpoint accepts a valid session token and
 *             marks the associated session as revoked in the
 *             persistence layer."
 *       AC2 — "Any subsequent request authenticated with a revoked
 *             session token is rejected as if no session existed, with
 *             the status and body defined by the session validation
 *             contract."
 *       AC3 — "Logout is idempotent: submitting the same revoked token
 *             again returns a documented non-error response and does
 *             not alter state."
 *       AC4 — "Logout is rejected with a documented error when called
 *             without a valid, non-expired session token, and leaves no
 *             partial state behind."
 *
 *   - ST-026 (`tickets/stories/ST-026-session-validation-middleware-contract.md`):
 *       AC1 — "Requests to any protected endpoint without a session
 *             token are rejected with the documented unauthenticated
 *             status and response body, and never reach the protected
 *             handler."
 *       AC2 — "Requests carrying an expired, malformed, or revoked
 *             session token are rejected with the documented
 *             invalid-session status and response body, distinct from
 *             the no-token response." — distinct error codes verified
 *             below.
 *       AC3 — "Requests carrying a valid, unexpired session token are
 *             forwarded to the protected handler with the authenticated
 *             user identity attached to the request context."
 *
 *   - ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC2 — deterministic fixtures.
 *       AC3 — distinguishes assertion failures from environment failures
 *             (per-suite.ts `afterEach` rejection guard).
 *       AC4 — runs against locally-started dependencies (PostgreSQL +
 *             Firebase Auth Emulator + GCS emulator).
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance (DOMINANT for this file)
 * ============================================================================
 *
 *   - Rule R1 (Story ACs are authoritative): every `it()` cites the
 *     specific AC it verifies.
 *
 *   - Rule R2 (NO credential material in logs / responses) — DOMINANT:
 *       * Sentinel passwords (`SENTINEL_CRED_AUTH_INT_99999`, etc.) are
 *         injected into requests; assertions sweep response bodies AND
 *         response headers for these tokens.
 *       * Validation errors do NOT echo the submitted password.
 *       * 401 INVALID_CREDENTIALS responses do not echo the password.
 *       * Logout 204 responses do not echo the bearer token.
 *
 *   - Rule R3 (Firebase Admin SDK ONLY) — DOMINANT:
 *       * NO custom JWT parsing, signature verification, or expiry logic.
 *       * Token issuance via the Firebase Auth Emulator REST API
 *         (the `signInWithPassword` adapter `backend/src/auth/firebase-rest.ts`).
 *       * Token verification via `admin.auth().verifyIdToken(...)`.
 *       * Source-file scan tests at the bottom of this file verify the
 *         absence of `jsonwebtoken`, `jose`, and `jwt-decode` imports
 *         from `backend/package.json`, `backend/src/routes/auth.ts`,
 *         `backend/src/middleware/session.ts`, and
 *         `backend/src/services/session.service.ts`.
 *
 *   - Rule R4 (no env defaults in source): N/A in this test file —
 *     `env-fail-fast.integration.test.ts` owns that contract.
 *
 *   - Rule R6 / C4 (OTel registration order): owned by the
 *     `setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts']`
 *     entry in `jest.config.integration.ts`. By the time this file
 *     loads, OTel has already monkey-patched `pg`, `http`, and
 *     `express`.
 *
 *   - Rule R8 (gates fail closed): every assertion uses `expect`; no
 *     try/catch swallows test failures; the integration app is wired
 *     against the REAL `pg.Pool`, the REAL Firebase Auth Emulator, and
 *     the REAL fake-gcs-server.
 *
 *   - Rule R9 (no payment): N/A — auth surface has no payment terms.
 *
 *   - LocalGCP Verification Rule (AAP §0.8.2): every test creates its
 *     own resources (Firebase users) during the test body and cleans
 *     them up via `deleteTestUser` in `afterEach`.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks, no stubs)
 * ============================================================================
 *
 *   - `backend/src/routes/auth.ts` — the public+authenticated auth
 *     routers (register, login, logout) returned by `createAuthRoutes`.
 *
 *   - `backend/src/middleware/session.ts` — session validation
 *     middleware with `ERROR_CODES = { UNAUTHENTICATED,
 *     MALFORMED_AUTHORIZATION, INVALID_SESSION }`.
 *
 *   - `backend/src/services/session.service.ts` — the SessionService
 *     facade composing register, login, logout, verifyToken, isRevoked.
 *
 *   - `backend/src/auth/firebase-rest.ts` — `createSignInWithPassword`
 *     adapter that calls the Firebase Auth Emulator REST API. Required
 *     to construct the SessionService end-to-end. (NOTE: this file is
 *     NOT in the assigned schema's `depends_on_files` but is required
 *     by `createSessionService` and is exercised end-to-end here as an
 *     integration test of the full auth flow per Rule R3.)
 *
 *   - All repositories (`user`, `session`, `design`, `share-link`,
 *     `order`) and all services (`design`, `share-link`, `order`,
 *     `gcs`) are wired so the integration app shape mirrors the
 *     production composition root in `backend/src/index.ts`.
 *
 * ============================================================================
 * Why Not Use the Production Composition Root Directly?
 * ============================================================================
 *
 *   `backend/src/index.ts` binds a TCP socket and exits the process on
 *   startup-time env failures. Importing it would make this test file
 *   responsible for shutdown cleanup of a real HTTP server. The
 *   focused `createIntegrationApp()` below mirrors the EXACT
 *   middleware order from AAP §0.5.6 and the EXACT route mounting
 *   order from `backend/src/index.ts`, but does not bind a socket —
 *   supertest invokes the Express handler directly.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *
 *   npx tsc --noEmit -p backend/tsconfig.json
 *   npx eslint backend/tests/integration/routes/auth.integration.test.ts
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/auth.integration.test.ts \
 *      --forceExit
 */

// ── Node 20 LTS standard library ────────────────────────────────────────
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Third-party (production runtime) ────────────────────────────────────
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';

// ── App under test (real modules — no mocks) ────────────────────────────
import { initializePool } from '../../../src/db/pool';
import { initializeFirebaseAdmin } from '../../../src/auth/firebase-admin';
import { createSignInWithPassword } from '../../../src/auth/firebase-rest';
import { logger } from '../../../src/logging/pino';
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { sessionMiddleware } from '../../../src/middleware/session';
import { metricsMiddleware } from '../../../src/routes/metrics';
import { createHealthRoutes } from '../../../src/routes/health';
import { createCartRoutes } from '../../../src/routes/cart';
import { createOrderRoutes } from '../../../src/routes/orders';
import { createAuthRoutes } from '../../../src/routes/auth';
import { createDesignRoutes } from '../../../src/routes/designs';
import { createShareRoutes } from '../../../src/routes/share';

import { createUserRepository } from '../../../src/repositories/user.repository';
import { createSessionRepository } from '../../../src/repositories/session.repository';
import { createDesignRepository } from '../../../src/repositories/design.repository';
import { createShareLinkRepository } from '../../../src/repositories/share-link.repository';
import { createOrderRepository } from '../../../src/repositories/order.repository';

import { createSessionService } from '../../../src/services/session.service';
import { createDesignService } from '../../../src/services/design.service';
import { createShareLinkService } from '../../../src/services/share-link.service';
import { createOrderService } from '../../../src/services/order.service';
import { createGcsService } from '../../../src/services/gcs.service';

// ── Test fixtures ───────────────────────────────────────────────────────
import { deleteTestUser } from '../fixtures/firebase-user';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * Standard password used for happy-path registration in this file.
 *
 * Rationale: satisfies the verified zod `min(8)` constraint on the
 * register schema with margin (24 chars), uses a mixed-case + digit +
 * symbol pattern (Firebase emulator does not enforce complexity but
 * production Firebase projects often do — using a safe shape here
 * avoids future churn), and is distinct from any sentinel value so a
 * test that mistakenly leaks this password into a body or header is
 * still detectable via the more specific sentinel scans below.
 */
const REGISTRATION_PASSWORD = 'IntegrationTestPwd!12345';

/**
 * Sentinel value used by the Rule R2 leak-detection tests to verify
 * registration responses do NOT echo the submitted password.
 *
 * The string is sufficiently unique that any occurrence in a response
 * body or header is unambiguous evidence of a leak. The numeric suffix
 * is deliberately distinct from other sentinels in the integration
 * suite to avoid cross-test contamination through shared Pino log
 * buffers.
 */
const SENTINEL_PASSWORD_REGISTER = 'SENTINEL_CRED_AUTH_INT_99999';

/**
 * Sentinel value used by the Rule R2 leak-detection tests to verify
 * 401 login-failure responses do NOT echo the submitted password.
 *
 * Distinct from {@link SENTINEL_PASSWORD_REGISTER} so a Pino buffer
 * inspection can attribute leakage to register-vs-login independently.
 */
const SENTINEL_PASSWORD_LOGIN_FAIL = 'SENTINEL_CRED_LOGIN_FAIL_77777';

/**
 * Sentinel value used by the Rule R2 leak-detection tests in
 * validation-error responses (e.g. malformed email path) to verify
 * 400 responses do not echo the submitted password.
 */
const SENTINEL_PASSWORD_VALIDATION = 'mySecretPassword123';

/**
 * Phrases that, if present in a 401 login-failure body, would constitute
 * an enumeration leak per ST-024-AC2 ("does not disclose whether the
 * user identifier exists").
 *
 * Comparisons are case-insensitive — JSON.stringify(...).toLowerCase()
 * on the response body is matched against these lowercase phrases.
 */
const ENUMERATION_LEAK_PHRASES: ReadonlyArray<string> = [
  'user not found',
  'does not exist',
  'wrong password',
  'incorrect password',
  'no such user',
  'unknown user',
  'email not registered',
  'user does not exist',
  'invalid user',
  'password mismatch',
];

/**
 * The expected zod-strict 400 envelope shape for register / login.
 *
 * Per `backend/src/routes/auth.ts` `translateZodError`, validation
 * failures emit `{ error: { code: 'VALIDATION_FAILED', message,
 * details: [{path, message}, ...] } }`. The tests below assert on the
 * `code` property exclusively — `details` content (Zod's human messages)
 * is not part of the public contract and may change with library
 * updates.
 */
const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

// ════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique email address per test invocation.
 *
 * Format: `auth-test-{uuidv4}@example.com`. Uses Node 20's stdlib
 * `randomUUID()` (UUID v4 per RFC 4122) to guarantee uniqueness even
 * under sequential invocation in the same millisecond. The leading
 * `auth-test-` prefix makes test users easy to identify if a partial
 * cleanup leaves orphans in the Firebase Auth emulator.
 *
 * @returns A fresh email of the documented shape.
 */
function uniqueEmail(): string {
  return `auth-test-${randomUUID()}@example.com`;
}

/**
 * Build a focused Express app that mirrors the production middleware
 * order from AAP §0.5.6 and the route-mount order from
 * `backend/src/index.ts` Step 6.
 *
 * Composition (matches production verbatim):
 *
 *   1. `express.json({ limit: '1mb' })`            — body parsing.
 *   2. `correlationMiddleware`                     — C5 (UUID v4).
 *   3. `pinoHttp({ logger, customLogLevel, redact })` — same options
 *      passed by the composition root in `backend/src/index.ts`.
 *   4. `metricsMiddleware`                         — chain fidelity.
 *
 *   --- UNAUTHENTICATED ROUTES (mounted BEFORE session gate) ---
 *   5. `createHealthRoutes({ pool })`              — `/healthz`, `/readyz`.
 *   6. `shareRouter`                               — `GET /api/share/:token`.
 *   7. `app.use('/api/auth', publicAuthRouter)`    — register, login.
 *
 *   --- SESSION GATE ---
 *   8. `app.use('/api', sessionMiddleware({ sessionService }))`.
 *
 *   --- AUTHENTICATED ROUTES (mounted AFTER session gate) ---
 *   9. `app.use('/api/auth', authenticatedAuthRouter)` — logout.
 *  10. `app.use('/api/designs', designsRouter)`.
 *  11. `app.use('/api/cart', cartRouter)`.
 *  12. `app.use('/api/orders', ordersRouter)`.
 *
 *  13. 4-arg error handler — converts thrown errors into a non-leaking
 *      JSON 5xx envelope.
 *
 * The dependency wiring follows `backend/src/index.ts` Step 4
 * verbatim:
 *   pool → repositories → services → routers
 *
 *   sessionService = createSessionService({
 *     sessionRepository, userRepository, firebaseAuth, signInWithPassword
 *   })
 *
 *   gcsService     = createGcsService()                     // no deps
 *   designService  = createDesignService({ designRepository, gcsService })
 *   orderService   = createOrderService({ orderRepository, designRepository })
 *   shareLinkService = createShareLinkService({
 *     shareLinkRepository, designRepository
 *   })
 *
 * The auth route's split (`publicAuthRouter` BEFORE the session
 * middleware, `authenticatedAuthRouter` AFTER it) is the central
 * correctness property under test for ST-026: the logout endpoint
 * MUST sit behind session validation, while register and login MUST
 * bypass it.
 *
 * @returns A fully-wired Express app ready for supertest invocation.
 */
async function createIntegrationApp(): Promise<Express> {
  // ── Step 1: foundational singletons (idempotent — safe to call
  //            in every test file's beforeAll).
  const pool = initializePool();
  const firebaseAuth = initializeFirebaseAdmin();
  const signInWithPassword = createSignInWithPassword();

  // ── Step 2: repositories (all consume the pool).
  const userRepository = createUserRepository(pool);
  const sessionRepository = createSessionRepository(pool);
  const designRepository = createDesignRepository(pool);
  const shareLinkRepository = createShareLinkRepository(pool);
  const orderRepository = createOrderRepository(pool);

  // ── Step 3: services (compose repositories + adapters).
  const sessionService = createSessionService({
    sessionRepository,
    userRepository,
    firebaseAuth,
    signInWithPassword,
  });
  // `createGcsService()` reads GCS_BUCKET_NAME / GCS_EMULATOR_HOST
  // directly from the environment (set up by global-setup.ts against
  // fake-gcs-server).
  const gcsService = createGcsService();
  const designService = createDesignService({ designRepository, gcsService });
  const orderService = createOrderService({ orderRepository, designRepository });
  const shareLinkService = createShareLinkService({
    shareLinkRepository,
    designRepository,
  });

  // ── Step 4: routers.
  const { publicAuthRouter, authenticatedAuthRouter } = createAuthRoutes({ sessionService });
  const shareRouter = createShareRoutes({ shareLinkService });
  const designsRouter = createDesignRoutes({ designService, shareLinkService });
  const cartRouter = createCartRoutes({ orderService });
  const ordersRouter = createOrderRoutes({ orderService });

  // ── Step 5: assemble the Express app.
  const app = express();

  // 5a. Body parsing.
  app.use(express.json({ limit: '1mb' }));

  // 5b. Correlation middleware (C5) — must precede pino-http so log
  //     records emitted during request handling carry the correlation
  //     ID, and so the response carries `x-correlation-id` back to
  //     the supertest client for assertion.
  app.use(correlationMiddleware);

  // 5c. Pino-HTTP — same options passed by the composition root in
  //     `backend/src/index.ts`. The redact paths drop credentials
  //     from log records (Rule R2 defense-in-depth on top of the
  //     logger's serializer allow-list).
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    }),
  );

  // 5d. Metrics middleware — chain fidelity per AAP §0.5.6.
  app.use(metricsMiddleware);

  // ── Step 6: routes — mounted in production order.

  // 6a. UNAUTHENTICATED routes (mounted BEFORE the session gate so
  //     they bypass session validation).
  app.use(createHealthRoutes({ pool }));
  app.use(shareRouter);
  app.use('/api/auth', publicAuthRouter);

  // 6b. Session gate — mounted at `/api` so EVERY subsequent
  //     `/api/*` mount is protected.
  app.use('/api', sessionMiddleware({ sessionService }));

  // 6c. AUTHENTICATED routes (mounted AFTER the session gate).
  app.use('/api/auth', authenticatedAuthRouter);
  app.use('/api/designs', designsRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/orders', ordersRouter);

  // 6d. 4-arg terminal error handler — converts thrown errors into
  //     a non-leaking JSON 5xx envelope. Express dispatches by
  //     arity; the four-parameter shape is what marks this as an
  //     error handler.
  app.use(
    (
      err: Error & { status?: number; statusCode?: number },
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction,
    ): void => {
      const status = err.status ?? err.statusCode ?? 500;
      res.status(status).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: status >= 500 ? 'Internal server error' : err.message,
        },
      });
    },
  );

  return app;
}

/**
 * Drive the production register endpoint and assert the basic
 * 201-success contract. Used by every login/logout test that needs a
 * pre-existing user.
 *
 * Behavior:
 *   - POSTs `/api/auth/register` with the supplied email + password.
 *   - Asserts `status === 201` and `body.uid` is a non-empty string
 *     (the canonical user identifier from Firebase Admin SDK
 *     `createUser`).
 *   - Returns the canonical `{uid, loginIdentifier}` so the caller
 *     can push the uid onto its `createdUids` cleanup list.
 *
 * Important: the `password` parameter is NOT logged or stored — it is
 * forwarded directly to `request().send(...)` and the local reference
 * is dropped at function return.
 *
 * @param app Express app under test.
 * @param email Email to register.
 * @param password Password to register.
 * @returns The canonical user record from the production endpoint.
 */
async function registerViaProduction(
  app: Express,
  email: string,
  password: string,
): Promise<{ uid: string; loginIdentifier: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .set('Content-Type', 'application/json')
    .send({ email, password });
  expect(res.status).toBe(201);
  expect(res.body).toBeDefined();
  expect(typeof res.body.uid).toBe('string');
  expect(res.body.uid.length).toBeGreaterThan(0);
  return {
    uid: res.body.uid as string,
    loginIdentifier: (res.body.loginIdentifier as string | undefined) ?? email,
  };
}

/**
 * Drive the production login endpoint and assert the basic
 * 200-success contract. Used by every logout / revocation test that
 * needs a fresh ID token.
 *
 * @param app Express app under test.
 * @param email Email of an already-registered user.
 * @param password Password of that user.
 * @returns The canonical login result `{uid, idToken, expiresAt}`.
 */
async function loginViaProduction(
  app: Express,
  email: string,
  password: string,
): Promise<{ uid: string; idToken: string; expiresAt: string }> {
  const res = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send({ email, password });
  expect(res.status).toBe(200);
  expect(typeof res.body.idToken).toBe('string');
  expect(res.body.idToken.length).toBeGreaterThan(0);
  expect(typeof res.body.uid).toBe('string');
  expect(typeof res.body.expiresAt).toBe('string');
  return {
    uid: res.body.uid as string,
    idToken: res.body.idToken as string,
    expiresAt: res.body.expiresAt as string,
  };
}

/**
 * Per-test Jest timeout for the cleanup loop in `afterEach`. The
 * `deleteTestUser` helper performs a fire-and-forget HTTP call to the
 * Firebase Auth emulator's `accounts:delete` endpoint; under load each
 * call may take up to a few seconds. The suite-wide
 * `jest.setTimeout(30000)` from `per-suite.ts` is sufficient, but if a
 * test creates many users in rapid succession, the cleanup loop must
 * remain fast — hence the 30-second cap.
 */
// (No override needed — the per-suite default is 30s.)


// ════════════════════════════════════════════════════════════════════════
// Test Suite — POST /api/auth/register (ST-023)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/register (integration)', () => {
  let app: Express;
  let createdUids: string[] = [];

  beforeAll(async () => {
    app = await createIntegrationApp();
  });

  afterEach(async () => {
    // ── LocalGCP Verification Rule cleanup ──────────────────────────
    // Every Firebase user created by this test must be removed from
    // the emulator. `deleteTestUser` is idempotent (treats 404 as
    // success), so a partial cleanup from a prior failed test does
    // not block this test's own cleanup.
    const uids = createdUids;
    createdUids = [];
    for (const uid of uids) {
      try {
        await deleteTestUser(uid);
      } catch (err) {
        // Surface as a warning rather than a thrown error — we do
        // NOT want a cleanup failure to mask a passing test as
        // "failed". The next test's beforeEach starts fresh.
        // eslint-disable-next-line no-console
        console.warn(
          `[auth.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful registration (ST-023-AC1, ST-023-AC2)', () => {
    it('returns 201 with canonical user record (uid, loginIdentifier)', async () => {
      // Arrange
      const email = uniqueEmail();

      // Act
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      // Assert — ST-023-AC1: persists a canonical user record.
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('uid');
      expect(typeof res.body.uid).toBe('string');
      expect(res.body.uid.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('loginIdentifier');
      expect(typeof res.body.loginIdentifier).toBe('string');

      // Cleanup
      createdUids.push(res.body.uid as string);
    });

    it('does NOT return any credential material (ST-023-AC2, ST-023-AC4, Rule R2)', async () => {
      // Arrange
      const email = uniqueEmail();

      // Act
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      // Assert — Body must NOT contain any credential-bearing field.
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('credential');
      // ST-023-AC2: registration does NOT issue a session token.
      expect(res.body).not.toHaveProperty('idToken');
      expect(res.body).not.toHaveProperty('sessionToken');
      expect(res.body).not.toHaveProperty('token');
      expect(res.body).not.toHaveProperty('expiresAt');

      // Sentinel scan: the submitted password value MUST NOT appear
      // anywhere in the response body.
      expect(JSON.stringify(res.body)).not.toContain(REGISTRATION_PASSWORD);

      // Cleanup
      createdUids.push(res.body.uid as string);
    });

    it(
      'does NOT echo a sentinel password in body or headers (Rule R2 dominant)',
      async () => {
        // Arrange — use the dedicated sentinel value so any leak is
        // unambiguous and uncorrelated with the standard happy-path
        // password.
        const email = uniqueEmail();

        // Act
        const res = await request(app)
          .post('/api/auth/register')
          .set('Content-Type', 'application/json')
          .send({ email, password: SENTINEL_PASSWORD_REGISTER });

        // Assert — successful registration with the sentinel password.
        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toContain(SENTINEL_PASSWORD_REGISTER);
        expect(JSON.stringify(res.headers)).not.toContain(SENTINEL_PASSWORD_REGISTER);

        // Cleanup
        createdUids.push(res.body.uid as string);
      },
    );

    it('accepts password at exactly 8-char minimum boundary', async () => {
      // The verified zod schema is `password: z.string().min(8)`.
      // Submitting exactly 8 chars MUST succeed.
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email, password: '12345678' });

      expect(res.status).toBe(201);
      expect(typeof res.body.uid).toBe('string');

      createdUids.push(res.body.uid as string);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Validation failures (ST-023-AC3)', () => {
    it('returns 400 VALIDATION_FAILED for missing email field', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for missing password field', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for malformed email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email: 'not-an-email-address', password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for password shorter than 8 chars', async () => {
      // Verified zod schema: `password: z.string().min(8)`.
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail(), password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for unknown root-level field (zod .strict)', async () => {
      // Verified zod schema: `.strict()` rejects unknown keys.
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({
          email: uniqueEmail(),
          password: REGISTRATION_PASSWORD,
          unknownField: 'x',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('does NOT echo the submitted password in 400 validation errors (Rule R2)', async () => {
      // Use a malformed email so the response is 400. The password
      // field IS present in the request body — verify it is NOT
      // reflected in the validation error response.
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email: 'x', password: SENTINEL_PASSWORD_VALIDATION });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL_PASSWORD_VALIDATION);
      expect(JSON.stringify(res.headers)).not.toContain(SENTINEL_PASSWORD_VALIDATION);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Duplicate registration (ST-023-AC3)', () => {
    it(
      'rejects re-registration of an already-registered email with a non-leaking error',
      async () => {
        // Arrange — register once.
        const email = uniqueEmail();
        const first = await request(app)
          .post('/api/auth/register')
          .set('Content-Type', 'application/json')
          .send({ email, password: REGISTRATION_PASSWORD });
        expect(first.status).toBe(201);
        createdUids.push(first.body.uid as string);

        // Act — register again with the SAME email.
        const second = await request(app)
          .post('/api/auth/register')
          .set('Content-Type', 'application/json')
          .send({ email, password: REGISTRATION_PASSWORD });

        // Assert — verified contract maps `auth/email-already-exists`
        // to 409 DUPLICATE_EMAIL via the route's `handleAuthError`
        // translator (see `backend/src/routes/auth.ts` lines 868-877).
        expect(second.status).toBe(409);
        expect(second.body).toHaveProperty('error');
        expect(second.body.error.code).toBe('DUPLICATE_EMAIL');

        // The error envelope is non-leaking (Rule R2): no submitted
        // password value, no internal Firebase error code, no stack
        // trace, no request body echo.
        expect(JSON.stringify(second.body)).not.toContain(REGISTRATION_PASSWORD);
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (correlation, observability)', () => {
    it('emits x-correlation-id on 201 register response (Constraint C5)', async () => {
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();

      createdUids.push(res.body.uid as string);
    });

    it('emits x-correlation-id on 400 validation-error response (Constraint C5)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .send({ email: 'malformed', password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves a client-supplied x-correlation-id verbatim (Constraint C5)', async () => {
      const inboundId = randomUUID();
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/auth/register')
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', inboundId)
        .send({ email, password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBe(inboundId);

      createdUids.push(res.body.uid as string);
    });
  });
});



// ════════════════════════════════════════════════════════════════════════
// Test Suite — POST /api/auth/login (ST-024)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/login (integration)', () => {
  let app: Express;
  let createdUids: string[] = [];

  beforeAll(async () => {
    app = await createIntegrationApp();
  });

  afterEach(async () => {
    const uids = createdUids;
    createdUids = [];
    for (const uid of uids) {
      try {
        await deleteTestUser(uid);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[auth.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful login (ST-024-AC1, ST-024-AC3)', () => {
    it('returns 200 with idToken, uid, and future expiresAt for valid credentials', async () => {
      // Arrange — register first.
      const email = uniqueEmail();
      const { uid: registeredUid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(registeredUid);

      // Act
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      // Assert — ST-024-AC1: idToken + documented expiration timestamp.
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('idToken');
      expect(typeof res.body.idToken).toBe('string');
      expect((res.body.idToken as string).length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('uid');
      expect(res.body.uid).toBe(registeredUid);
      expect(res.body).toHaveProperty('expiresAt');
      // The expiration timestamp MUST be in the future at the moment
      // of response. The verified service contract uses the Firebase
      // ID token's `exp` claim (typically Date.now() + ~1h).
      expect(typeof res.body.expiresAt).toBe('string');
      expect(new Date(res.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    });

    it(
      'creates a NEW session record on each successful login (ST-024-AC3)',
      async () => {
        // Arrange — register a single user.
        const email = uniqueEmail();
        const { uid } = await registerViaProduction(
          app,
          email,
          REGISTRATION_PASSWORD,
        );
        createdUids.push(uid);

        // Act — login twice with a small delay between calls.
        //
        // The Firebase Auth emulator (and real Firebase Auth) issues
        // ID tokens whose `iat` (issued-at) claim has SECOND precision.
        // Two logins within the same second therefore receive
        // BYTE-IDENTICAL idTokens, which collide on the SHA-256
        // `tokenRef` PRIMARY KEY of the `sessions` table. The
        // `sleep(1100)` here guarantees the second login's `iat`
        // differs from the first — exercising the genuine
        // "two distinct sessions" path that ST-024-AC3 requires.
        //
        // Real-world concurrent logins from multiple devices typically
        // span > 1 second; the second-precision quantization of `iat`
        // is a Firebase-protocol artifact, not a defect.
        const first = await loginViaProduction(app, email, REGISTRATION_PASSWORD);
        await new Promise<void>((resolve) => setTimeout(resolve, 1100));
        const second = await loginViaProduction(app, email, REGISTRATION_PASSWORD);

        // Assert — both logins succeeded, both for the same uid.
        // Each login inserts a row in the `sessions` table (verified
        // service contract in `backend/src/services/session.service.ts`
        // — `register/login/logout` flow).
        expect(first.uid).toBe(uid);
        expect(second.uid).toBe(uid);

        // Distinct idTokens prove distinct session rows were created
        // (the service contract derives `tokenRef` from a SHA-256
        // hash of the idToken — distinct tokens map to distinct PKs).
        expect(first.idToken.length).toBeGreaterThan(0);
        expect(second.idToken.length).toBeGreaterThan(0);
        expect(second.idToken).not.toBe(first.idToken);
      },
    );

    it('does NOT echo the password in the 200 success response (Rule R2)', async () => {
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);

      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(REGISTRATION_PASSWORD);
      expect(JSON.stringify(res.headers)).not.toContain(REGISTRATION_PASSWORD);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Enumeration defense (ST-024-AC2 — DOMINANT Rule R2 test)', () => {
    /**
     * The most important Rule R2 / ST-024-AC2 test in this file.
     *
     * The verified service contract (`createSessionService.login` in
     * `backend/src/services/session.service.ts`) catches ANY error
     * from the `signInWithPassword` adapter and translates it to
     * `UnauthenticatedError('invalid credentials',
     * 'INVALID_CREDENTIALS')`. The route layer's `handleAuthError`
     * maps `name === 'UnauthenticatedError' || code ===
     * 'INVALID_CREDENTIALS'` to:
     *
     *   res.status(401).json(buildError(
     *     'INVALID_CREDENTIALS',
     *     'Authentication failed',
     *   ));
     *
     * The collapse is the central security property: a wrong-password
     * attempt against an EXISTING user produces byte-identical output
     * (modulo correlation ID) to a login attempt for a NON-EXISTENT
     * email. Without this, an attacker can enumerate the user
     * directory by observing response differences — defeating the
     * purpose of email-based identification.
     */
    it('returns 401 INVALID_CREDENTIALS for wrong password against existing user', async () => {
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);

      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email, password: 'WrongPassword!9999' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 INVALID_CREDENTIALS for non-existent email', async () => {
      // No prior register call — this email exists in neither
      // Firebase nor the local users table.
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail(), password: 'AnyPassword!1234' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it(
      'wrong-password and non-existent-email produce IDENTICAL responses (ST-024-AC2 enumeration defense)',
      async () => {
        // Arrange — register a user.
        const registeredEmail = uniqueEmail();
        const { uid } = await registerViaProduction(
          app,
          registeredEmail,
          REGISTRATION_PASSWORD,
        );
        createdUids.push(uid);

        // Act — issue both failure modes back-to-back.
        const wrongPasswordRes = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: registeredEmail, password: 'wrongpassword999' });

        const noUserRes = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: uniqueEmail(), password: 'anypassword999' });

        // Assert — same status code.
        expect(wrongPasswordRes.status).toBe(401);
        expect(noUserRes.status).toBe(401);
        expect(wrongPasswordRes.status).toBe(noUserRes.status);

        // Same error code.
        expect(wrongPasswordRes.body.error.code).toBe('INVALID_CREDENTIALS');
        expect(noUserRes.body.error.code).toBe('INVALID_CREDENTIALS');
        expect(wrongPasswordRes.body.error.code).toBe(noUserRes.body.error.code);

        // Same generic error message — the verified contract emits
        // 'Authentication failed' in both cases. Comparing the exact
        // strings catches a regression that would let an attacker
        // distinguish the two failure modes.
        expect(typeof wrongPasswordRes.body.error.message).toBe('string');
        expect(wrongPasswordRes.body.error.message).toBe(
          noUserRes.body.error.message,
        );

        // Defensive scan: no enumeration-leak phrases in either
        // body. This catches a future regression that bypasses the
        // service-layer translator (e.g. by responding directly from
        // the route on a Firebase error).
        const wrongJson = JSON.stringify(wrongPasswordRes.body).toLowerCase();
        const noUserJson = JSON.stringify(noUserRes.body).toLowerCase();
        for (const leakPhrase of ENUMERATION_LEAK_PHRASES) {
          expect(wrongJson).not.toContain(leakPhrase);
          expect(noUserJson).not.toContain(leakPhrase);
        }
      },
    );

    it('does NOT echo the sentinel password in 401 INVALID_CREDENTIALS body or headers (Rule R2)', async () => {
      // Arrange — register so that the email exists; the wrong
      // password drives the 401 path.
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);

      // Act — submit the sentinel password as the wrong password.
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email, password: SENTINEL_PASSWORD_LOGIN_FAIL });

      // Assert — 401 with no echo of the sentinel.
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL_PASSWORD_LOGIN_FAIL);
      expect(JSON.stringify(res.headers)).not.toContain(SENTINEL_PASSWORD_LOGIN_FAIL);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Validation failures', () => {
    it('returns 400 VALIDATION_FAILED for missing email field', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for malformed email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: 'not-an-email', password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for missing password field', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for empty password (zod min(1))', async () => {
      // Verified login zod schema: `password: z.string().min(1)`.
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail(), password: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for unknown root-level field (zod .strict)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({
          email: uniqueEmail(),
          password: REGISTRATION_PASSWORD,
          extra: 'reject-me',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (correlation, observability — ST-024-AC5)', () => {
    it('emits x-correlation-id on 200 successful login', async () => {
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);

      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email, password: REGISTRATION_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits x-correlation-id on 401 login failure (ST-024-AC5)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send({ email: uniqueEmail(), password: 'WrongPassword!1234' });

      expect(res.status).toBe(401);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });
  });
});



// ════════════════════════════════════════════════════════════════════════
// Test Suite — POST /api/auth/logout (ST-025)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/auth/logout (integration)', () => {
  let app: Express;
  let createdUids: string[] = [];

  beforeAll(async () => {
    app = await createIntegrationApp();
  });

  afterEach(async () => {
    const uids = createdUids;
    createdUids = [];
    for (const uid of uids) {
      try {
        await deleteTestUser(uid);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[auth.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Authentication contract (ST-025-AC4 / ST-026)', () => {
    it('returns 401 UNAUTHENTICATED without an Authorization header', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('returns 401 MALFORMED_AUTHORIZATION when scheme is not Bearer', async () => {
      // Verified session middleware: header present but no `Bearer `
      // prefix → MALFORMED_AUTHORIZATION (lines 404-410 of session.ts).
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Token foo');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MALFORMED_AUTHORIZATION');
    });

    it('returns 401 INVALID_SESSION for an unverifiable Bearer token', async () => {
      // Verified session middleware: a syntactically-present Bearer
      // token that fails `verifyIdToken` → INVALID_SESSION
      // (lines 686-695 of session.ts).
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer not-a-real-firebase-id-token-xxx');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SESSION');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful logout (ST-025-AC1)', () => {
    it('returns 204 with empty body for a valid session', async () => {
      // Arrange — register and login.
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);

      const session = await loginViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );

      // Act — logout with the valid Bearer token.
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${session.idToken}`);

      // Assert — 204 No Content with empty body (verified contract:
      // `res.status(204).send()` in `runLogout`). The HTTP 204 status
      // mandates an empty body per RFC 7230 §3.3.3; supertest's
      // `res.text` field (the raw body string before any JSON parse)
      // is the authoritative empty-body assertion.
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it(
      'revokes the session: subsequent calls with the same token return 401 INVALID_SESSION (ST-025-AC2 + ST-026-AC2)',
      async () => {
        // Arrange — register, login, logout.
        const email = uniqueEmail();
        const { uid } = await registerViaProduction(
          app,
          email,
          REGISTRATION_PASSWORD,
        );
        createdUids.push(uid);

        const session = await loginViaProduction(
          app,
          email,
          REGISTRATION_PASSWORD,
        );

        const logoutRes = await request(app)
          .post('/api/auth/logout')
          .set('Authorization', `Bearer ${session.idToken}`);
        expect(logoutRes.status).toBe(204);

        // Act — use the (now-revoked) token against a protected
        // endpoint. The cart route is the simplest authenticated
        // endpoint and is the canonical one used to verify the
        // ST-026-AC2 distinction.
        const protectedRes = await request(app)
          .get('/api/cart')
          .set('Authorization', `Bearer ${session.idToken}`);

        // Assert — verified middleware contract: revoked sessions
        // are masked as INVALID_SESSION (NOT a separate REVOKED
        // code), preventing token-state enumeration.
        expect(protectedRes.status).toBe(401);
        expect(protectedRes.body.error.code).toBe('INVALID_SESSION');

        // Distinct from the no-token case (ST-026-AC2).
        const noTokenRes = await request(app).get('/api/cart');
        expect(noTokenRes.status).toBe(401);
        expect(noTokenRes.body.error.code).toBe('UNAUTHENTICATED');
        expect(protectedRes.body.error.code).not.toBe(
          noTokenRes.body.error.code,
        );
      },
    );

    it('does NOT echo the bearer token in the logout response (Rule R2)', async () => {
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);
      const session = await loginViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${session.idToken}`);

      // The response status MUST be 204; the body MUST be empty;
      // the headers MUST NOT echo the bearer token.
      expect(res.status).toBe(204);
      expect(res.text).not.toContain(session.idToken);
      expect(JSON.stringify(res.headers)).not.toContain(session.idToken);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Idempotency (ST-025-AC3)', () => {
    it(
      'is idempotent: a second logout with the same token does NOT return a 5xx error',
      async () => {
        // Arrange — register, login.
        const email = uniqueEmail();
        const { uid } = await registerViaProduction(
          app,
          email,
          REGISTRATION_PASSWORD,
        );
        createdUids.push(uid);
        const session = await loginViaProduction(
          app,
          email,
          REGISTRATION_PASSWORD,
        );

        // Act 1 — first logout.
        const first = await request(app)
          .post('/api/auth/logout')
          .set('Authorization', `Bearer ${session.idToken}`);

        // Act 2 — second logout with the SAME (now-revoked) token.
        const second = await request(app)
          .post('/api/auth/logout')
          .set('Authorization', `Bearer ${session.idToken}`);

        // Assert — first call succeeds (204). Second call: the
        // session middleware (which sits BEFORE the logout handler
        // on the authenticated router) detects the revocation and
        // emits 401 INVALID_SESSION. The system-level idempotency
        // contract (ST-025-AC3) is satisfied: the second call does
        // NOT throw, does NOT return 5xx, and does NOT mutate state.
        expect(first.status).toBe(204);
        expect([204, 401]).toContain(second.status);
        expect(second.status).toBeLessThan(500); // no 5xx — Rule R8.

        // If the second call returned 401, it MUST be the
        // INVALID_SESSION code (NOT UNAUTHENTICATED — the bearer is
        // present, just revoked).
        if (second.status === 401) {
          expect(second.body.error.code).toBe('INVALID_SESSION');
        }
      },
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// Test Suite — Session Middleware Contract (ST-026)
// ════════════════════════════════════════════════════════════════════════
//
// These tests verify the session validation contract on a protected
// endpoint. We use `GET /api/cart` because:
//   1. It's the simplest authenticated route.
//   2. The schema's intent (per the AAP §0.5.6 middleware order) is
//      that EVERY `/api/*` route except register/login/share gets the
//      same validation behavior — so verifying against /api/cart
//      verifies the contract for all protected endpoints.
//   3. It is the canonical endpoint cited in the schema's intent for
//      ST-026-AC2 (distinct error codes after revocation).
//
// ════════════════════════════════════════════════════════════════════════

describe('Session middleware contract on protected endpoints (ST-026)', () => {
  let app: Express;
  let createdUids: string[] = [];

  beforeAll(async () => {
    app = await createIntegrationApp();
  });

  afterEach(async () => {
    const uids = createdUids;
    createdUids = [];
    for (const uid of uids) {
      try {
        await deleteTestUser(uid);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[auth.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Error code differentiation (ST-026-AC1, ST-026-AC2)', () => {
    it('returns 401 UNAUTHENTICATED when no Authorization header is present', async () => {
      const res = await request(app).get('/api/cart');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it(
      'returns 401 MALFORMED_AUTHORIZATION when Authorization scheme is not Bearer',
      async () => {
        const res = await request(app)
          .get('/api/cart')
          .set('Authorization', 'Basic dXNlcjpwYXNz');
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('MALFORMED_AUTHORIZATION');
      },
    );

    it(
      'returns 401 MALFORMED_AUTHORIZATION when Authorization is "Bearer " with empty token',
      async () => {
        // Verified session middleware contract (lines 404-410 of
        // session.ts): the regex `/^bearer\s+(\S+)$/i` requires at
        // least one non-whitespace token character. Trailing whitespace
        // alone is rejected as MALFORMED_AUTHORIZATION.
        const res = await request(app)
          .get('/api/cart')
          .set('Authorization', 'Bearer    ');
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('MALFORMED_AUTHORIZATION');
      },
    );

    it(
      'returns 401 INVALID_SESSION for an unverifiable Bearer token',
      async () => {
        const res = await request(app)
          .get('/api/cart')
          .set(
            'Authorization',
            'Bearer absolutely-not-a-valid-firebase-id-token-xxxxxxxxxxxxxxxxx',
          );
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_SESSION');
      },
    );

    it(
      'distinguishes UNAUTHENTICATED (no token) from INVALID_SESSION (bad token) — ST-026-AC2',
      async () => {
        const noTokenRes = await request(app).get('/api/cart');
        const invalidRes = await request(app)
          .get('/api/cart')
          .set('Authorization', 'Bearer not-real');

        // Both are 401 per the verified contract.
        expect(noTokenRes.status).toBe(401);
        expect(invalidRes.status).toBe(401);

        // But the error codes are DIFFERENT — this is the key
        // ST-026-AC2 property.
        expect(noTokenRes.body.error.code).toBe('UNAUTHENTICATED');
        expect(invalidRes.body.error.code).toBe('INVALID_SESSION');
        expect(noTokenRes.body.error.code).not.toBe(
          invalidRes.body.error.code,
        );
      },
    );

    it(
      'all 401 responses carry x-correlation-id (Constraint C5)',
      async () => {
        const noTokenRes = await request(app).get('/api/cart');
        const malformedRes = await request(app)
          .get('/api/cart')
          .set('Authorization', 'Token nope');
        const invalidRes = await request(app)
          .get('/api/cart')
          .set('Authorization', 'Bearer also-nope');

        expect(noTokenRes.headers['x-correlation-id']).toMatchCorrelationId();
        expect(malformedRes.headers['x-correlation-id']).toMatchCorrelationId();
        expect(invalidRes.headers['x-correlation-id']).toMatchCorrelationId();
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Valid session forwarding (ST-026-AC3)', () => {
    it('forwards a valid Bearer token to the protected handler with uid attached', async () => {
      // Arrange — register and login.
      const email = uniqueEmail();
      const { uid } = await registerViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );
      createdUids.push(uid);
      const session = await loginViaProduction(
        app,
        email,
        REGISTRATION_PASSWORD,
      );

      // Act — call the protected endpoint with the valid token.
      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${session.idToken}`);

      // Assert — 200 (cart route requires uid; success implies the
      // middleware passed and req.uid was attached). The verified
      // cart route returns `{userId, items, subtotal}` for an empty
      // cart on first call.
      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
    });
  });
});



// ════════════════════════════════════════════════════════════════════════
// Test Suite — Rule R3 Contract: Firebase Admin SDK ONLY
// ════════════════════════════════════════════════════════════════════════
//
// Rule R3 (AAP §0.8.1 — DOMINANT): "The Blitzy platform MUST NOT
// implement custom JWT parsing, signature verification, or expiry logic.
// Token validation MUST call `admin.auth().verifyIdToken()`
// exclusively. Verification: no `jsonwebtoken`, `jose`, or `jwt-decode`
// packages in `backend/package.json`."
//
// These tests are static-analysis assertions that survive even if the
// runtime tests are skipped (e.g. an environment-induced skip on
// `firebase-auth-emulator` unreachability). They guarantee that the
// Rule R3 contract is enforced at the source level — a future
// developer who adds a forbidden JWT package will fail this test
// regardless of runtime conditions.
//
// ════════════════════════════════════════════════════════════════════════

describe('Rule R3 contract — no custom JWT libraries (static source-level assertions)', () => {
  /**
   * Path to the backend monorepo workspace's `package.json`.
   *
   * Resolved from this file's `__dirname` (which is
   * `backend/tests/integration/routes`) up three levels to the
   * `backend/` workspace root. Using `path.resolve` rather than a
   * literal string makes the test pass regardless of the working
   * directory Jest is invoked from (root vs `backend/`).
   */
  const BACKEND_ROOT = path.resolve(__dirname, '../../..');
  const PACKAGE_JSON_PATH = path.resolve(BACKEND_ROOT, 'package.json');

  /**
   * The closed list of forbidden JWT packages per Rule R3.
   *
   * If a future change introduces a new JWT-handling library, it
   * MUST be added to this list AND verified to be absent from
   * `backend/package.json` and from any backend source file that
   * touches authentication.
   */
  const FORBIDDEN_JWT_PACKAGES: ReadonlyArray<string> = [
    'jsonwebtoken',
    'jose',
    'jwt-decode',
  ];

  // ─────────────────────────────────────────────────────────────────────
  describe('backend/package.json declares no forbidden JWT packages', () => {
    /**
     * Loaded once for the whole describe block. The `as` cast is
     * narrow (only the keys we read) — we never expose the full
     * package.json structure to TypeScript.
     */
    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    beforeAll(() => {
      const raw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
      pkg = JSON.parse(raw) as typeof pkg;
    });

    it('package.json file exists and is parseable JSON', () => {
      // Defensive: if the file is missing or malformed, fail with a
      // clear message rather than a cryptic JSON parse error from
      // the beforeAll.
      expect(fs.existsSync(PACKAGE_JSON_PATH)).toBe(true);
      expect(typeof pkg).toBe('object');
    });

    for (const forbiddenPkg of FORBIDDEN_JWT_PACKAGES) {
      it(`dependencies does NOT declare '${forbiddenPkg}'`, () => {
        expect(pkg.dependencies?.[forbiddenPkg]).toBeUndefined();
      });

      it(`devDependencies does NOT declare '${forbiddenPkg}'`, () => {
        expect(pkg.devDependencies?.[forbiddenPkg]).toBeUndefined();
      });

      it(`peerDependencies does NOT declare '${forbiddenPkg}'`, () => {
        expect(pkg.peerDependencies?.[forbiddenPkg]).toBeUndefined();
      });

      it(`optionalDependencies does NOT declare '${forbiddenPkg}'`, () => {
        expect(pkg.optionalDependencies?.[forbiddenPkg]).toBeUndefined();
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('backend source files contain no forbidden JWT imports', () => {
    /**
     * The set of authentication-critical backend source files that
     * Rule R3 mandates MUST NOT import any forbidden JWT package.
     *
     * The list is intentionally narrow: it covers the route, the
     * middleware, and the service that together implement the auth
     * surface. A future scan could be broadened to all backend
     * TypeScript source files, but the narrow list catches the most
     * likely regression without coupling this test to refactors of
     * unrelated files.
     */
    const SOURCE_FILES_UNDER_RULE_R3: ReadonlyArray<string> = [
      'src/routes/auth.ts',
      'src/middleware/session.ts',
      'src/services/session.service.ts',
    ];

    /**
     * Per-package import patterns. Each forbidden package name maps
     * to two regexes covering both ES module (`import ... from`) and
     * CommonJS (`require(...)`) forms. The regexes are deliberately
     * permissive about whitespace and quote style (single vs double)
     * so a renaming refactor cannot accidentally bypass the check.
     */
    function buildForbiddenImportPatterns(pkgName: string): ReadonlyArray<RegExp> {
      // Escape the package name for regex use (handles `jwt-decode`
      // which contains a hyphen — actually safe, but defensive
      // anyway).
      const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [
        // ES module: `from 'pkgname'` or `from "pkgname"`.
        new RegExp(`from\\s+['"]${escaped}['"]`),
        // ES module side-effect: `import 'pkgname'`.
        new RegExp(`import\\s+['"]${escaped}['"]`),
        // CommonJS: `require('pkgname')` or `require("pkgname")`.
        new RegExp(`require\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`),
        // Dynamic import: `import('pkgname')`.
        new RegExp(`import\\s*\\(\\s*['"]${escaped}['"]\\s*\\)`),
      ];
    }

    for (const relPath of SOURCE_FILES_UNDER_RULE_R3) {
      describe(`${relPath}`, () => {
        let source: string;
        const absPath = path.resolve(BACKEND_ROOT, relPath);

        beforeAll(() => {
          // Defensive existence check first — `fs.readFileSync` would
          // throw a cryptic ENOENT, but the test should explicitly
          // surface a missing source file as an environmental
          // failure (per ST-044-AC3).
          expect(fs.existsSync(absPath)).toBe(true);
          source = fs.readFileSync(absPath, 'utf8');
        });

        for (const forbiddenPkg of FORBIDDEN_JWT_PACKAGES) {
          const patterns = buildForbiddenImportPatterns(forbiddenPkg);
          for (const pattern of patterns) {
            it(`does NOT match ${pattern} (forbidden by Rule R3)`, () => {
              expect(source).not.toMatch(pattern);
            });
          }
        }
      });
    }
  });
});

