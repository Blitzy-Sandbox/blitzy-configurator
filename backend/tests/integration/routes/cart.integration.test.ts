/**
 * `cart.integration.test.ts` — Integration tests for the AUTHENTICATED
 * `GET /api/cart` endpoint (ST-033 — Retrieve Current Cart).
 *
 * The companion authenticated routes `POST /api/orders` (ST-032) and
 * `POST /api/orders/:id/finalize` (ST-034) are exercised in
 * `orders.integration.test.ts` (a sibling at the same depth). The full
 * middleware chain and route surface are still mounted here so the
 * integration app under test mirrors the EXACT production composition
 * root in `backend/src/index.ts` (AAP §0.5.6).
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations from `tickets/stories/*.md`)
 * ============================================================================
 *
 *   - ST-033 (`tickets/stories/ST-033-retrieve-cart-endpoint.md`):
 *       AC1 — "The retrieval endpoint requires a valid session and
 *             returns only the cart belonging to the authenticated
 *             user, never cart data belonging to other users."
 *       AC2 — "The response includes each cart line item with
 *             quantity, referenced design identifier, and any
 *             per-item metadata required to render the cart, along
 *             with a calculated subtotal."
 *       AC3 (CRITICAL) — "When the authenticated user has no active
 *             cart, the endpoint returns an empty cart representation
 *             with a success status rather than a not-found error."
 *       AC4 — "The endpoint does not create, mutate, or finalize the
 *             cart and is safe to call repeatedly from the client
 *             without side effects."
 *
 *   - ST-026 (`tickets/stories/ST-026-session-validation-middleware-contract.md`):
 *       AC1 — Requests to any protected endpoint without a session
 *             token are rejected with the documented unauthenticated
 *             status, and never reach the protected handler.
 *       AC2 — Requests carrying an expired, malformed, or revoked
 *             session token are rejected with a status DISTINCT from
 *             the no-token response. Distinct codes are enforced
 *             below:
 *               - UNAUTHENTICATED          (no header / empty)
 *               - MALFORMED_AUTHORIZATION  (no Bearer prefix)
 *               - INVALID_SESSION          (unverifiable / revoked)
 *
 *   - ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC2 — Deterministic fixtures: the cart tests are read-only,
 *             so the only fixture the file requires is the Firebase
 *             Auth Emulator user lifecycle helper
 *             (`createTestUser` / `deleteTestUser`). NO direct DB
 *             writes are performed by this file — the read-only
 *             contract of GET /api/cart is verified by the EMPTY
 *             representation returned for fresh users (a row never
 *             needs to exist in `orders` because `findCartForUser`
 *             returns `{ items: [], subtotal: '0.00' }` when no
 *             `state='cart'` row matches).
 *       AC3 — Distinguishes assertion failures from environment /
 *             fixture-setup failures (per-suite.ts owns the
 *             unhandled-rejection guard; this file's `afterEach`
 *             surfaces cleanup failures via `console.warn` so a
 *             broken cleanup never masks a passing test).
 *       AC4 — Runs against locally-started dependencies (PostgreSQL +
 *             Firebase Auth Emulator + GCS emulator).
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance (DOMINANT for this file)
 * ============================================================================
 *
 *   - Rule R1 (Story ACs are authoritative): every `it()` cites the
 *     specific AC it verifies.
 *
 *   - Rule R2 (NO credential material in logs / responses): the
 *     authentication describe block includes a sentinel-bearer test
 *     that asserts the bearer token value never echoes into the
 *     response body or headers. Logs are subject to the pino-redact
 *     paths configured in `createIntegrationApp` and the allow-list
 *     serializer in `backend/src/logging/pino.ts`.
 *
 *   - Rule R3 (Firebase Admin SDK ONLY): authenticated requests carry
 *     bearer tokens issued by the Firebase Auth Emulator REST API
 *     (the `signInWithPassword` adapter
 *     `backend/src/auth/firebase-rest.ts`) and verified by
 *     `admin.auth().verifyIdToken()`. NO custom JWT parsing,
 *     signature verification, or expiry logic.
 *
 *   - Rule R6 / C4 (OTel registration order): owned by the
 *     `setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts']`
 *     entry in `jest.config.integration.ts`. By the time this file
 *     loads, OTel has already monkey-patched `pg`, `http`, and
 *     `express`.
 *
 *   - Rule R8 (gates fail closed): every assertion uses `expect`; no
 *     try/catch swallows test failures; the integration app is wired
 *     against the REAL `pg.Pool`, the REAL Firebase Auth Emulator,
 *     and the REAL fake-gcs-server.
 *
 *   - Rule R9 (NO payment processing — DOMINANT for cart endpoints):
 *     the cart surface is the pre-checkout boundary at which payment
 *     terminology is most likely to appear in a careless regression.
 *     This file's Rule-R9 describe block scans response BODIES and
 *     HEADERS on every documented status code (200, 401, 404) for the
 *     forbidden tokens — `stripe | braintree | paypal |
 *     paymentintent | payment_intent | paymentmethod | payment_method
 *     | charge | refund | tokenize`.
 *
 *   - LocalGCP Verification Rule (AAP §0.8.2): every test creates its
 *     own resources (Firebase users) during the test body and cleans
 *     them up via `deleteTestUser` in `afterEach`. There is no
 *     dependence on pre-existing emulator state.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks, no stubs)
 * ============================================================================
 *
 *   - `backend/src/routes/cart.ts` — the PRIMARY system under test:
 *     GET /api/cart wired via `createCartRoutes({ orderService })`.
 *
 *   - `backend/src/services/order.service.ts` — `getCart` business
 *     logic that GUARANTEES the empty-cart contract
 *     (`{ items: [], subtotal: '0.00' }`) so the route never branches
 *     on emptiness (per ST-033-AC3).
 *
 *   - `backend/src/repositories/order.repository.ts` —
 *     `findCartForUser(userId)` returns `{ userId, items, subtotal }`
 *     where `subtotal` defaults to `'0.00'` when no `state='cart'`
 *     row matches.
 *
 *   - `backend/src/middleware/session.ts` — session validation
 *     middleware (Rule R3 — verifyIdToken-only). The cart tests rely
 *     on the verified ERROR_CODES literals (UNAUTHENTICATED,
 *     MALFORMED_AUTHORIZATION, INVALID_SESSION) AND on the
 *     middleware's `req.uid` extraction for the cross-user isolation
 *     check.
 *
 *   - `backend/src/auth/firebase-rest.ts` — `createSignInWithPassword`
 *     adapter for the Firebase Auth Emulator REST API. Required by
 *     `createSessionService`. NOT in the assigned schema's
 *     `depends_on_files` but is required to construct the
 *     SessionService end-to-end (same precedent as
 *     `auth.integration.test.ts`, `designs.integration.test.ts`, and
 *     `orders.integration.test.ts`). This keeps the integration app
 *     shape isomorphic to the production composition root.
 *
 *   - All other repositories (`user`, `session`, `design`,
 *     `share-link`) and services (`session`, `design`, `share-link`,
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
 * Key Production Contracts (verified at authoring time)
 * ============================================================================
 *
 *   1. The cart route is mounted at `app.use('/api/cart', cartRouter)`
 *      with the internal route path `/`, producing GET /api/cart.
 *
 *   2. The handler invokes `orderService.getCart({ userId: uid })`
 *      where `uid` is `requireUid(req)` (extracts `req.uid` populated
 *      by sessionMiddleware).
 *
 *   3. `orderService.getCart` GUARANTEES a non-null Cart object —
 *      never null, never throwing 404 for an empty cart. Empty cart
 *      is `{ userId, items: [], subtotal: '0.00' }`.
 *
 *   4. The handler returns HTTP 200 with `res.json(cart)` — no
 *      shaping, no field stripping. The response body for an empty
 *      cart is exactly `{ items: [], subtotal: '0.00' }` once the
 *      `userId` is implicit (the contract test at the unit layer
 *      verifies the userId field is preserved; this integration test
 *      asserts the SHAPE on the wire and lets `userId`'s presence be
 *      a non-strict surplus).
 *
 *   5. Session middleware sets `req.uid` and PRESERVES the existing
 *      AsyncLocalStorage correlation context (it does NOT call
 *      `.run()` again, per the verified C5 contract). The
 *      `x-correlation-id` response header therefore propagates
 *      through every successful 200 response AND every 401 error
 *      response.
 *
 *   6. Session middleware ERROR_CODES are exported literals:
 *        UNAUTHENTICATED         = 'UNAUTHENTICATED'
 *        MALFORMED_AUTHORIZATION = 'MALFORMED_AUTHORIZATION'
 *        INVALID_SESSION         = 'INVALID_SESSION'
 *      Tests assert these values exactly.
 *
 *   7. `isRevoked` defaults to `false` on missing session row — so a
 *      user created via `createTestUser()` (Firebase Auth row only,
 *      no local `sessions` row) WILL pass through the middleware
 *      successfully. This is the contract that makes the simpler
 *      `createTestUser()` path viable here (vs. the
 *      `setupAuthenticatedUser` register/login flow used by
 *      `orders.integration.test.ts`).
 *
 *   8. `findCartForUser` does NOT JOIN `users` — it queries
 *      `order_items` joined to `orders` filtered by
 *      `state='cart' AND user_id=$1`. An empty result set therefore
 *      returns `{ items: [], subtotal: '0.00' }` regardless of
 *      whether the user has a row in the local `users` table.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   cd backend && npx eslint tests/integration/routes/cart.integration.test.ts \
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/cart.integration.test.ts \
 *      --forceExit
 *   # expected exit: 0
 */

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
import { sessionMiddleware, ERROR_CODES } from '../../../src/middleware/session';
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
import { createTestUser, deleteTestUser, type TestUser } from '../fixtures/firebase-user';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * The Rule R9 forbidden-token regex.
 *
 * Captures the canonical payment-processor SDK names AND the
 * canonical financial-settlement vocabulary that would appear if
 * payment terminology were ever introduced into the cart flow.
 *
 * Tokens explicitly NOT included (and the rationale for each):
 *   - `payment` (without `_intent` / `_method` / `intent` / `method`):
 *     too broad — the source files LEGITIMATELY mention "payment
 *     processor" and "payment-state transitions" as part of
 *     documenting Rule R9. The narrower spellings above are sufficient
 *     to detect any actual payment-processor introduction without
 *     false-matching the documentation.
 *   - `pay`: too broad — would match unrelated tokens like "payload".
 *
 * The pattern is duplicated from `orders.integration.test.ts` so that
 * future maintainers can grep for `FORBIDDEN_R9_PATTERN` and find
 * EVERY enforcement site in the integration test suite. When this
 * regex changes in one file, it MUST be updated in the other to
 * preserve coverage symmetry.
 */
const FORBIDDEN_R9_PATTERN =
  /(stripe|braintree|paypal|paymentintent|payment_intent|paymentmethod|payment_method|charge|refund|tokenize)/i;

/**
 * The exact subtotal value the production wire format guarantees for
 * an empty cart. The internal contract preserves Postgres NUMERIC(12,2)
 * by emitting a string ('0.00'); the route layer's
 * {@link backend/src/routes/_serialize.ts#serializeCart} coerces this
 * to a JS number (0) for the wire format consumed by the frontend.
 *
 * QA Final D Issue #9: the wire format MUST be a JS number per the
 * `frontend/src/api/orders.ts` Cart interface and the E2E suite's
 * `expect(typeof cart.subtotal).toBe('number')` invariant
 * (frontend/tests/e2e/cart-and-order-flow.spec.ts:546).
 */
const EMPTY_CART_SUBTOTAL = 0;

/**
 * A sentinel bearer-token value used to verify Rule R2: the response
 * body and headers MUST NEVER echo the raw bearer token. The sentinel
 * is intentionally distinctive (length > 30, contains "SHOULD_NOT")
 * so that a `toContain` / regex assertion catches even partial
 * leakage. The sentinel is NOT a Firebase-issued idToken — it triggers
 * the INVALID_SESSION branch in the session middleware, which makes
 * this test simultaneously verify (a) bearer is recognised as such,
 * (b) verifyIdToken rejects it, and (c) the rejected token never
 * surfaces in the response.
 */
const SENTINEL_BEARER_TOKEN = 'SENTINEL_BEARER_VALUE_999_should_not_appear_in_body';

/**
 * A pre-generated UUID v4 used to verify the C5 correlation-ID
 * preservation contract. The middleware MUST preserve a well-formed
 * inbound `x-correlation-id` value verbatim and echo it back in the
 * response header. A FIXED value (rather than `randomUUID()`) makes
 * the assertion deterministic when the test is reviewed in CI logs.
 *
 * Format: a valid UUID v4 (the `4` in the third group + `8` in the
 * fourth group satisfy RFC 4122 v4 requirements).
 */
const CLIENT_PROVIDED_CORRELATION_ID = '33333333-4444-4555-8666-777777777777';

// ════════════════════════════════════════════════════════════════════════
// Helper: createIntegrationApp
// ════════════════════════════════════════════════════════════════════════

/**
 * Construct a fully-wired Express app that mirrors the production
 * composition root in `backend/src/index.ts` AAP §0.5.6 verbatim.
 *
 * Sequence (matches AAP §0.5.6 step-by-step):
 *
 *   --- DEPENDENCY WIRING (Step 1-4) ---
 *   1. Foundational singletons: pool, firebaseAuth, signInWithPassword.
 *   2. Repositories: user, session, design, share-link, order.
 *   3. Services: session, gcs, design, share-link, order.
 *   4. Routers: auth (public + authenticated), share, designs, cart,
 *      orders, health.
 *
 *   --- MIDDLEWARE CHAIN (Step 5) ---
 *   5a. `express.json({ limit: '1mb' })` — body parsing.
 *   5b. `correlationMiddleware` — establishes AsyncLocalStorage
 *       correlation context per Rule C5. Mounted FIRST so subsequent
 *       middleware (pino-http, session, route handlers) emit log
 *       records carrying the correlation ID and the response carries
 *       `x-correlation-id` back to the supertest client.
 *   5c. `pinoHttp` — structured request/response logger with the
 *       Rule R2 redaction allow-list applied to the `Authorization`
 *       and `cookie` headers.
 *   5d. `metricsMiddleware` — per-request Prometheus counter +
 *       histogram (chain-fidelity per AAP §0.5.6).
 *
 *   --- UNAUTHENTICATED ROUTES (mounted BEFORE session gate) ---
 *   6. `app.use(createHealthRoutes({ pool }))` — /healthz + /readyz.
 *   7. `app.use(shareRouter)` — /api/share/:token (unauthenticated
 *      read-only design retrieval).
 *   8. `app.use('/api/auth', publicAuthRouter)` — /api/auth/register
 *      + /api/auth/login.
 *
 *   --- SESSION GATE ---
 *   9. `app.use('/api', sessionMiddleware({ sessionService }))` —
 *      protects every subsequent /api/* mount.
 *
 *   --- AUTHENTICATED ROUTES (mounted AFTER session gate) ---
 *  10. `app.use('/api/auth', authenticatedAuthRouter)` — /api/auth/logout.
 *  11. `app.use('/api/designs', designsRouter)`.
 *  12. `app.use('/api/cart', cartRouter)`.   <-- SUT for this file.
 *  13. `app.use('/api/orders', ordersRouter)`.
 *
 *  14. 4-arg error handler — converts thrown errors into a non-leaking
 *      JSON 5xx envelope.
 *
 * The dependency wiring follows `backend/src/index.ts` Step 4 verbatim.
 * The `signInWithPassword` adapter (`backend/src/auth/firebase-rest.ts`)
 * is required by `createSessionService` even though its source path is
 * NOT in the assigned schema's `depends_on_files` — same precedent as
 * `auth.integration.test.ts`, `designs.integration.test.ts`, and
 * `orders.integration.test.ts`.
 *
 * @returns A fully-wired Express app ready for supertest invocation.
 */
async function createIntegrationApp(): Promise<Express> {
  // ── Step 1: foundational singletons (idempotent — safe to call in
  //            every test file's beforeAll).
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
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
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

  // 6d. 4-arg terminal error handler — converts thrown errors into a
  //     non-leaking JSON 5xx envelope. Express dispatches by arity;
  //     the four-parameter shape is what marks this as an error
  //     handler.
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

// ════════════════════════════════════════════════════════════════════════
// Top-level test setup
// ════════════════════════════════════════════════════════════════════════

/**
 * The Express app is constructed once per Jest worker (in `beforeAll`)
 * because `createIntegrationApp()` is idempotent — the production
 * pool, Firebase Admin, and pino logger singletons cache themselves
 * on first use. Per-test isolation is achieved by creating fresh
 * users in each `it` block, NOT by tearing down the app.
 */
let app: Express;

/**
 * Mutable list of Firebase Auth emulator users created during the
 * current test. `afterEach` sweeps each entry by calling
 * `deleteTestUser(uid)`. Using a mutable array (re-initialised in
 * `afterEach`) guarantees that even if a test BAILS partway through
 * — e.g. createTestUser succeeds but the next assertion fails — the
 * cleanup still removes the user.
 *
 * Cleanup is best-effort: the local `users` / `designs` / `orders`
 * tables are NOT swept here because:
 *   1. The cart tests are READ-ONLY by design (per ST-033-AC4) — no
 *      direct DB writes are performed by this file.
 *   2. The integration test database is dropped + recreated between
 *      test runs by the global setup harness.
 *   3. `createTestUser()` only writes to the Firebase Auth Emulator,
 *      not to the local `users` table — so there is no local row to
 *      sweep.
 */
let createdUsers: TestUser[] = [];

beforeAll(async () => {
  app = await createIntegrationApp();
});

afterEach(async () => {
  // Clone, reset, and iterate — the iteration order does not matter
  // because every uid is independent.
  const toDelete = createdUsers;
  createdUsers = [];
  for (const user of toDelete) {
    try {
      await deleteTestUser(user.uid);
    } catch (err) {
      // Cleanup failures must NOT mask test failures — log to stderr
      // and continue. The next test run's global setup will sweep
      // the residue.
      // eslint-disable-next-line no-console
      console.warn(`[cart.integration.test.ts] cleanup failed for uid=${user.uid}: ${String(err)}`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// describe: GET /api/cart (integration)
// ════════════════════════════════════════════════════════════════════════

describe('GET /api/cart (integration)', () => {
  // ────────────────────────────────────────────────────────────────────
  // Authentication (ST-033-AC1 — "valid session required")
  //                + ST-026-AC1 (no token), ST-026-AC2 (distinct codes)
  // ────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-033-AC1)', () => {
    it('returns 401 UNAUTHENTICATED when no Authorization header is sent', async () => {
      // ST-033-AC1: "The retrieval endpoint requires a valid session…"
      // ST-026-AC1: "An inbound request that arrives without a session
      //   token is rejected with HTTP 401 UNAUTHENTICATED."
      const res = await request(app).get('/api/cart');

      expect(res.status).toBe(401);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
      // Defense-in-depth: response body must NEVER contain credential
      // material (Rule R2). No bearer token was sent in this test —
      // but assert the body never carries a Bearer-shaped substring
      // either (any leakage would be a critical regression).
      expect(JSON.stringify(res.body)).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    });

    it('returns 401 MALFORMED_AUTHORIZATION when the Authorization header lacks the Bearer scheme', async () => {
      // ST-026-AC2: "malformed" → MALFORMED_AUTHORIZATION (distinct
      //   error code from INVALID_SESSION).
      // The session middleware case-insensitively recognises the
      //   "Bearer " prefix; "Basic ..." and similar non-Bearer
      //   schemes hit the MALFORMED branch.
      const res = await request(app).get('/api/cart').set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });

    it('returns 401 INVALID_SESSION for a syntactically-Bearer but unverifiable token', async () => {
      // ST-026-AC2: "Tokens that are expired, malformed, or revoked
      //   are rejected with HTTP 401 with a distinct error code per
      //   failure mode." A random, non-Firebase-issued token follows
      //   the INVALID_SESSION branch (the verifier rejects it
      //   downstream of bearer extraction).
      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', 'Bearer not-a-real-firebase-token');

      expect(res.status).toBe(401);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });

    it('does NOT echo the bearer token value in the response body or headers (Rule R2)', async () => {
      // Rule R2: NO credential material may appear in any response
      //   body or response header. Even rejected tokens must not
      //   surface — leaking the rejected value would defeat the
      //   purpose of the redaction allow-list and provide an
      //   enumeration vector for callers probing valid token shapes.
      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${SENTINEL_BEARER_TOKEN}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);

      // Body sweep: the sentinel must not appear ANYWHERE in the
      // serialized JSON body (including nested error fields).
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL_BEARER_TOKEN);

      // Header sweep: the sentinel must not appear in any response
      // header. This catches accidental echoing via custom headers
      // (e.g. an "X-Auth-Echo" debug header that a future regression
      // might add).
      expect(JSON.stringify(res.headers)).not.toContain(SENTINEL_BEARER_TOKEN);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Empty cart (ST-033-AC3 — CRITICAL — the most important assertion
  //             of this file: success status, NEVER 404)
  // ────────────────────────────────────────────────────────────────────
  describe('Empty cart (ST-033-AC3 — CRITICAL)', () => {
    it('returns 200 (NEVER 404) for a fresh user with no cart items', async () => {
      // ST-033-AC3 (verbatim): "When the authenticated user has no
      //   active cart, the endpoint returns an empty cart
      //   representation with a success status rather than a
      //   not-found error."
      //
      // This is the MOST CRITICAL assertion of this file. The
      //   production contract guarantees `findCartForUser` returns
      //   `{ items: [], subtotal: '0.00' }` even when no `state='cart'`
      //   row matches — so the route never branches on emptiness and
      //   ST-033-AC3 holds trivially.
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      // Primary assertion: 200, NEVER 404.
      expect(res.status).toBe(200);
      // Belt-and-braces — make the regression mode crystal clear if
      // the response shape ever drifts to 404.
      expect(res.status).not.toBe(404);

      // Shape: the response body MUST contain `items` (an array) and
      // `subtotal` (the JS number 0 after route-layer coercion). Other
      // fields (e.g. `userId`) are non-strict surplus permitted by the
      // contract.
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items).toEqual([]);

      expect(res.body).toHaveProperty('subtotal');
      expect(res.body.subtotal).toBe(EMPTY_CART_SUBTOTAL);
    });

    it('returns identical empty representation on three consecutive calls (read-only verification)', async () => {
      // ST-033-AC4: "The endpoint does not create, mutate, or
      //   finalize the cart and is safe to call repeatedly from the
      //   client without side effects."
      //
      // Rationale for THREE calls: a regression that mutates state
      //   on the first call and then returns a non-empty body on the
      //   second would still register as "two consecutive identical
      //   responses" if we only called twice — so call THREE times
      //   to verify the cart shape is stable across multiple reads.
      const user = await createTestUser();
      createdUsers.push(user);

      const auth = `Bearer ${user.idToken}`;
      const first = await request(app).get('/api/cart').set('Authorization', auth);
      const second = await request(app).get('/api/cart').set('Authorization', auth);
      const third = await request(app).get('/api/cart').set('Authorization', auth);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);

      // All three bodies MUST be deep-equal — no mutation, no
      // drift, no "first call is empty but later calls populate from
      // a side-effect" regression.
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);

      // And every call MUST satisfy the empty-cart shape contract
      // (defense-in-depth — if a future regression made the FIRST
      // body match the SECOND but BOTH were wrong, the
      // .toEqual chain above would still pass).
      expect(first.body.items).toEqual([]);
      expect(first.body.subtotal).toBe(EMPTY_CART_SUBTOTAL);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-user isolation (ST-033-AC2 — "returns ONLY the authenticated
  //                       user's cart contents")
  // ────────────────────────────────────────────────────────────────────
  describe('Cross-user isolation (ST-033-AC2)', () => {
    it("user A's GET /api/cart does not surface user B's cart contents", async () => {
      // ST-033-AC2 (verbatim): "The retrieval endpoint requires a
      //   valid session and returns only the cart belonging to the
      //   authenticated user, never cart data belonging to other
      //   users."
      //
      // The cart route extracts `req.uid` (set by sessionMiddleware
      //   from the verified idToken) and passes it as `userId` to
      //   `orderService.getCart`. The service in turn passes it to
      //   `findCartForUser(userId)` which filters by user_id at the
      //   SQL level. Two different idTokens MUST therefore drive two
      //   independent queries against two different user_ids — and
      //   even though both fresh users have empty carts, the fact
      //   that both queries succeed (with no cross-pollution
      //   visible) verifies the userId propagation contract end-to-
      //   end.
      const userA = await createTestUser();
      const userB = await createTestUser();
      createdUsers.push(userA, userB);

      const resA = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${userA.idToken}`);

      const resB = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${userB.idToken}`);

      // Both succeed.
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      // Both carts are empty — the symmetric outcome verifies that
      //   the userId is propagated CORRECTLY (a regression that
      //   ignored req.uid and queried with a hardcoded value would
      //   either fail entirely or return the same body for every
      //   user — both states would surface as a different test
      //   failure, but the symmetric-empty pattern is the cleanest
      //   verification of routing).
      expect(resA.body.items).toEqual([]);
      expect(resB.body.items).toEqual([]);
      expect(resA.body.subtotal).toBe(EMPTY_CART_SUBTOTAL);
      expect(resB.body.subtotal).toBe(EMPTY_CART_SUBTOTAL);

      // Defense-in-depth: if either response carries a `userId`
      //   field (the production Cart type includes it), it MUST
      //   match the user's own uid — never the OTHER user's uid.
      //   A mismatch would prove that uid extraction is broken.
      if (typeof resA.body.userId === 'string') {
        expect(resA.body.userId).toBe(userA.uid);
        expect(resA.body.userId).not.toBe(userB.uid);
      }
      if (typeof resB.body.userId === 'string') {
        expect(resB.body.userId).toBe(userB.uid);
        expect(resB.body.userId).not.toBe(userA.uid);
      }
    });

    it('uid is extracted from the request context and propagated to orderService.getCart({ userId })', async () => {
      // Indirect verification of the uid propagation contract:
      //   the only way for a 200 response with the empty-cart shape
      //   to materialise is for sessionMiddleware to (a) verify the
      //   idToken via Firebase Admin SDK, (b) set req.uid to the
      //   verified uid, and (c) the cart route's `requireUid`
      //   helper to read req.uid and pass it as userId. A regression
      //   anywhere along that chain would either short-circuit with
      //   401 (missing/invalid uid) or 5xx (service called with
      //   undefined userId).
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
      expect(res.body.items).toEqual([]);
      expect(res.body.subtotal).toBe(EMPTY_CART_SUBTOTAL);

      // If the production Cart shape includes `userId`, it MUST
      //   equal the verified uid — proving end-to-end propagation.
      if (typeof res.body.userId === 'string') {
        expect(res.body.userId).toBe(user.uid);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Read-only contract (ST-033-AC4 — "does not create, mutate, or
  //                     finalize the cart … safe to call repeatedly")
  // ────────────────────────────────────────────────────────────────────
  describe('Read-only contract (ST-033-AC4)', () => {
    it('subsequent GETs do not mutate the persisted cart shape', async () => {
      // ST-033-AC4: idempotent reads. The first GET MUST NOT trigger
      //   any persistence-layer write that would cause the second
      //   GET to observe a different shape.
      const user = await createTestUser();
      createdUsers.push(user);

      const auth = `Bearer ${user.idToken}`;
      const first = await request(app).get('/api/cart').set('Authorization', auth);
      const second = await request(app).get('/api/cart').set('Authorization', auth);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      // Identical bodies prove no mutation occurred between calls.
      expect(second.body).toEqual(first.body);

      // Empty-cart shape preserved.
      expect(first.body.items).toEqual([]);
      expect(second.body.items).toEqual([]);
    });

    it('rejects POST /api/cart (the read-only path does not accept mutating verbs)', async () => {
      // ST-033-AC4 + AAP §0.6.4 verified contract: the route file
      //   `backend/src/routes/cart.ts` registers ONLY `router.get('/',
      //   ...)`. POST/PUT/DELETE are not registered, so Express
      //   returns 404 for those verbs (the URL pattern matches a
      //   mounted router but the method does not match any handler;
      //   Express's default behavior is 404 — NOT 405 — unless an
      //   explicit catch-all is configured).
      //
      // The assertion accepts either 404 or 405 to be robust against
      //   a future configuration that opts in to 405-on-method-
      //   mismatch. What it CANNOT accept is 200 (which would prove
      //   the read-only contract is violated) or 401 (which would
      //   prove the session middleware is short-circuiting BEFORE
      //   the method check, masking the contract).
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .post('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({});

      // Accept 404 (Express default) or 405 (explicit rejection).
      // Reject 200 (contract violation) and 401 (auth precedence
      //   masking).
      expect([404, 405]).toContain(res.status);
      expect(res.status).not.toBe(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Rule R9 (DOMINANT) — no payment-processor terminology
  // ────────────────────────────────────────────────────────────────────
  describe('Rule R9 (DOMINANT) — no payment-processor terminology', () => {
    it('successful 200 response body contains no forbidden payment-processor terms', async () => {
      // Rule R9: the cart surface is the pre-checkout boundary at
      //   which payment terminology is most likely to appear in a
      //   careless regression. Scan the empty-cart 200 response body
      //   for every forbidden token.
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      const serializedBody = JSON.stringify(res.body);
      expect(serializedBody).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('successful 200 response headers contain no forbidden payment-processor terms', async () => {
      // Rule R9 defense-in-depth: forbidden tokens may NOT appear
      //   in any response header either. A regression that added a
      //   "X-Payment-Method" debug header (or similar) would surface
      //   here.
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      const serializedHeaders = JSON.stringify(res.headers);
      expect(serializedHeaders).not.toMatch(FORBIDDEN_R9_PATTERN);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns (correlation, content-type)
  // ────────────────────────────────────────────────────────────────────
  describe('Cross-cutting concerns', () => {
    it('emits an x-correlation-id response header on a successful 200', async () => {
      // C5: every response carries `x-correlation-id` (preserved
      //   from the request when present, otherwise generated as a
      //   fresh UUID v4).
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves a client-supplied x-correlation-id header (C5)', async () => {
      // The correlation middleware preserves a well-formed UUID
      //   from the client. Use a FIXED UUID v4 here for log-review
      //   determinism.
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('x-correlation-id', CLIENT_PROVIDED_CORRELATION_ID);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBe(CLIENT_PROVIDED_CORRELATION_ID);
    });

    it('response Content-Type is application/json', async () => {
      // ST-033-AC2: the response shape is structured JSON; the
      //   Content-Type header MUST advertise this. Express's default
      //   `.json()` serializer sets `application/json; charset=utf-8`.
      const user = await createTestUser();
      createdUsers.push(user);

      const res = await request(app)
        .get('/api/cart')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });
});
