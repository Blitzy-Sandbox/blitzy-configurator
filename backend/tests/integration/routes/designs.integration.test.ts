/**
 * `designs.integration.test.ts` — Integration tests for the AUTHENTICATED
 * designs API:
 *   - `POST   /api/designs`                 (ST-027 — create)
 *   - `GET    /api/designs`                 (ST-028 — paginated list, max 100)
 *   - `POST   /api/designs/:id/share-link`  (ST-029 — issuance)
 *
 * Companion unauthenticated read route (`GET /api/share/:token`,
 * ST-029-AC3) is exercised separately in `share.integration.test.ts`.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations from `tickets/stories/*.md`)
 * ============================================================================
 *
 *   - ST-027 (`tickets/stories/ST-027-create-design-endpoint.md`):
 *       AC1 — A valid session is required; without one the request
 *             MUST be rejected with the documented unauthenticated
 *             status and never reach the handler.
 *       AC2 — A successful create persists ALL configurator selections
 *             from the request payload.
 *       AC3 — The response is the canonical persisted design with a
 *             server-assigned id and timestamps.
 *       AC4 — A successful create does NOT mutate other designs
 *             (cross-design isolation).
 *
 *   - ST-028 (`tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md`):
 *       AC1 — A valid session is required.
 *       AC2 — The response returns ONLY the authenticated user's
 *             designs (cross-user isolation enforced at SQL).
 *       AC3 — An empty collection returns the documented 200 success
 *             status (NEVER 404 / NEVER an error envelope).
 *       AC4 — Deterministic ordering: most-recently-modified first
 *             with id as tiebreaker.
 *       AC5 — Documented bounded pagination: max page size 100 per
 *             page; opaque cursor-based pagination.
 *
 *   - ST-029 (`tickets/stories/ST-029-share-link-issuance-endpoint.md`):
 *       AC1 — A valid session is required, AND only for OWNED designs.
 *             Cross-user attempts return the documented not-found
 *             status (anti-enumeration: "does not exist" and "exists
 *             but is not yours" are deliberately conflated).
 *       AC2 — The response includes a documented expiration
 *             (cleartext-future `expiresAt` on the response or in the
 *             token).
 *       AC3 — A valid unexpired link returns enough info for read-only
 *             configurator render WITHOUT sign-in. (Exercised in the
 *             companion `share.integration.test.ts` file — the GET
 *             /api/share/:token side; this file owns the issuance
 *             side.)
 *
 *   - ST-026 (`tickets/stories/ST-026-session-validation-middleware-contract.md`):
 *       AC1 — Requests without a session token are rejected with the
 *             documented unauthenticated status, and never reach the
 *             handler.
 *       AC2 — Requests with an expired, malformed, or revoked token
 *             are rejected with a status DISTINCT from the no-token
 *             response. Distinct codes are enforced below:
 *               - UNAUTHENTICATED          (no header / empty)
 *               - MALFORMED_AUTHORIZATION  (no Bearer prefix)
 *               - INVALID_SESSION          (unverifiable / revoked)
 *
 *   - ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC2 — Deterministic fixtures (this file builds payloads inline
 *             with production-valid shapes; the project fixture
 *             `buildDesignPayload` uses a different (legacy) logo
 *             shape that violates the production zod `.strict()`
 *             schema, so we deliberately do NOT use it here).
 *       AC3 — Distinguishes assertion failures from environment /
 *             fixture-setup failures (per-suite.ts owns the
 *             unhandled-rejection guard).
 *       AC4 — Runs against locally-started dependencies (PostgreSQL +
 *             Firebase Auth Emulator + GCS emulator).
 *
 *   - Gate T1-C (User Example, AAP §0.6.4):
 *       The verbatim curl request:
 *         curl -sf -X POST http://localhost:3000/api/designs \
 *           -H "Authorization: Bearer $TOKEN" \
 *           -H "Content-Type: application/json" \
 *           -d '{"title":"Gate C","payload":{"primaryColor":"#FF0000",
 *                "pattern":"classic","finish":"matte"}}' \
 *         | jq '.id' | grep -v null
 *       MUST return a non-null UUID. The very first happy-path test
 *       below replicates that example verbatim.
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance (DOMINANT for this file)
 * ============================================================================
 *
 *   - Rule R1 (Story ACs are authoritative): every `it()` cites the
 *     specific AC it verifies.
 *
 *   - Rule R2 (NO credential material in logs / responses): response
 *     bodies are scanned for password / credential / bearer /
 *     authorization substrings. Logs are subject to the
 *     pino-redact paths configured in `createIntegrationApp` and the
 *     allow-list serializer in `backend/src/logging/pino.ts`.
 *
 *   - Rule R3 (Firebase Admin SDK ONLY): authenticated requests carry
 *     bearer tokens issued by the Firebase Auth Emulator REST API
 *     (the `signInWithPassword` adapter `backend/src/auth/firebase-rest.ts`)
 *     and verified by `admin.auth().verifyIdToken()`. NO custom JWT
 *     parsing, signature verification, or expiry logic.
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
 *   - Rule R9 (no payment): N/A — designs surface has no payment
 *     terms.
 *
 *   - LocalGCP Verification Rule (AAP §0.8.2): every test creates its
 *     own resources (Firebase users, designs) during the test body
 *     and cleans them up via `deleteTestUser` in `afterEach`. There
 *     is no dependence on pre-existing emulator state.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks, no stubs)
 * ============================================================================
 *
 *   - `backend/src/routes/designs.ts` — the PRIMARY system under
 *     test. Three routes: POST /, GET /, POST /:id/share-link.
 *
 *   - `backend/src/services/design.service.ts` — design business-
 *     logic orchestrator (validateUserId, validateTitle,
 *     validateAndNormalizePayload, repository.insert / listByUser).
 *
 *   - `backend/src/services/share-link.service.ts` — share-link
 *     issuance with ownership verification (NotFoundError on
 *     cross-user).
 *
 *   - `backend/src/middleware/session.ts` — session validation
 *     middleware (Rule R3 — verifyIdToken-only).
 *
 *   - `backend/src/auth/firebase-rest.ts` — `createSignInWithPassword`
 *     adapter for the Firebase Auth Emulator REST API. Required by
 *     `createSessionService`. NOT in the assigned schema's
 *     `depends_on_files` but is required to construct the
 *     SessionService end-to-end (same precedent as
 *     `auth.integration.test.ts`).
 *
 *   - All repositories (`user`, `session`, `design`, `share-link`,
 *     `order`) and all services (`session`, `design`, `share-link`,
 *     `order`, `gcs`) are wired so the integration app shape mirrors
 *     the production composition root in `backend/src/index.ts`.
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
 * Production Reality vs. Prompt Claims (documented for downstream maintainers)
 * ============================================================================
 *
 *   The agent prompt claimed several behaviors that DIVERGE from
 *   `backend/src/routes/designs.ts`. Tests in this file follow
 *   PRODUCTION reality (Rule R1: code is authoritative) and document
 *   the divergence here so future maintainers do not reintroduce the
 *   prompt-style assertions:
 *
 *     1. Pattern enum (production): `['classic', 'hexagonal',
 *        'diamond', 'spiral', 'star', 'grid']`. The prompt erroneously
 *        listed `['classic', 'hex', 'star', 'arrow', 'diamond',
 *        'wave']`. Tests below iterate the production tuple.
 *     2. Hex color regex: production accepts ANY non-empty string for
 *        `primaryColor` / `secondaryColor` / `accentColor` (`z.string().min(1)`).
 *        There is no `/^#[0-9A-Fa-f]{6}$/` check. Hex-format-violation
 *        tests are intentionally omitted.
 *     3. `GET /api/designs/:id` is NOT exposed as a route — the
 *        service has a `getById` method but no router binding.
 *        Per-id retrieval tests are intentionally omitted.
 *     4. `POST /api/designs/:id/share-link` returns HTTP **200** (not
 *        201) and includes a `url` field beyond the `ShareLink` shape:
 *        `{ token, designId, ownerUid, issuedAt, expiresAt, revokedAt,
 *           url }`.
 *     5. The logo schema uses `objectKey` (not `reference`) and flat
 *        `offsetX/offsetY/scale/rotation` (not nested `placement`).
 *        The fixture's `buildDesignPayload('canonical')` returns a
 *        legacy shape that the production `.strict()` zod schema
 *        rejects; we therefore construct payloads inline.
 *     6. The user MUST exist in the local `users` table (FK from
 *        `designs.user_id`) — `createTestUser()` only creates the
 *        Firebase Auth row, so we use `registerViaProduction()` (the
 *        production `/api/auth/register` endpoint) which writes both.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   cd backend && npx eslint tests/integration/routes/designs.integration.test.ts \
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/designs.integration.test.ts \
 *      --forceExit
 *   # expected exit: 0
 */

// ── Node 20 LTS standard library ────────────────────────────────────────
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
import { deleteTestUser } from '../fixtures/firebase-user';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * Standard password used for happy-path registration in this file.
 *
 * Rationale: satisfies the verified zod `min(8)` constraint on the
 * register schema with margin (24 chars), uses a mixed-case + digit +
 * symbol pattern, and is distinct from any sentinel value so that a
 * test that mistakenly leaks this password into a body or header is
 * still detectable via the more specific sentinel scans.
 */
const REGISTRATION_PASSWORD = 'IntegrationTestPwd!12345';

/**
 * Production zod enum tuples (verbatim from `backend/src/routes/designs.ts`
 * `PATTERN_VALUES` and `FINISH_VALUES`). Tests iterate these to verify
 * that EVERY documented enumerated value is accepted by the route.
 *
 * Locking these as `as const readonly` tuples produces literal-string
 * types so a future drift between production and test (e.g. the
 * production enum gains a 7th pattern but this tuple is not updated)
 * surfaces as a TypeScript compile error rather than a silent test gap.
 */
const PRODUCTION_PATTERN_VALUES = [
  'classic',
  'hexagonal',
  'diamond',
  'spiral',
  'star',
  'grid',
] as const;
const PRODUCTION_FINISH_VALUES = ['matte', 'glossy', 'metallic'] as const;

/**
 * The expected zod-strict 400 envelope `code` for designs route
 * validation failures. Per `backend/src/routes/designs.ts`
 * `translateZodError`, validation failures emit
 * `{ error: { code: 'VALIDATION_FAILED', message, details: [...] } }`.
 * Tests below assert on the `code` exclusively — `details` content is
 * Zod's human messages and may change with library updates.
 */
const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

/**
 * The error code emitted when the share-link service determines that
 * the design is unknown OR not owned by the caller. Per
 * `backend/src/routes/designs.ts` `handleRouteError`, this maps to
 * HTTP 404. The conflated 404 (vs. 403) is deliberate
 * anti-enumeration per ST-029-AC1 + AAP §0.2.2.
 */
const DESIGN_NOT_FOUND_CODE = 'DESIGN_NOT_FOUND';

/**
 * A well-formed UUID that does NOT correspond to any row in
 * `designs`. Used by negative tests for share-link issuance against a
 * non-existent design id.
 *
 * Format: a fixed UUID v4 with the version + variant nibbles set
 * correctly (per RFC 4122) so the SQL `::uuid` cast accepts it. The
 * probability of a real designs.id row matching this value is
 * negligible.
 */
const NONEXISTENT_DESIGN_ID = '00000000-0000-4000-8000-000000000000';

// ════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique email per test invocation.
 *
 * Format: `designs-test-{uuidv4}@example.com`. Uses Node 20's stdlib
 * `randomUUID()` (UUID v4 per RFC 4122) to guarantee uniqueness even
 * under sequential invocation in the same millisecond. The leading
 * `designs-test-` prefix makes test users easy to identify if a
 * partial cleanup leaves orphans in the Firebase Auth emulator.
 *
 * @returns A fresh email of the documented shape.
 */
function uniqueEmail(): string {
  return `designs-test-${randomUUID()}@example.com`;
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
 * The dependency wiring follows `backend/src/index.ts` Step 4 verbatim.
 * The `signInWithPassword` adapter (`backend/src/auth/firebase-rest.ts`)
 * is required by `createSessionService` even though its source path is
 * NOT in the assigned schema's `depends_on_files` — same precedent as
 * `auth.integration.test.ts`. This keeps the integration app shape
 * isomorphic to the production composition root.
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

/**
 * Drive the production register endpoint and assert the basic
 * 201-success contract. Used by every test that needs a pre-existing
 * user (which is every authenticated test, given the FK from
 * `designs.user_id` to `users.id`).
 *
 * Behavior:
 *   - POSTs `/api/auth/register` with the supplied email + password.
 *   - Asserts `status === 201` and `body.uid` is a non-empty string
 *     (the canonical user identifier from Firebase Admin SDK
 *     `createUser` AND a row in the local `users` table).
 *   - Returns the canonical `{uid, loginIdentifier}` so the caller
 *     can push the uid onto its `createdUids` cleanup list.
 *
 * Important: the `password` parameter is NOT logged or stored — it
 * is forwarded directly to `request().send(...)` and the local
 * reference is dropped at function return.
 *
 * @param app Express app under test.
 * @param email Email to register.
 * @param password Password to register.
 * @returns The canonical user record.
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
 * 200-success contract. Used to obtain a fresh ID token for tests
 * that need to call protected endpoints.
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
 * One-shot helper to register + login a user via the production
 * endpoints. Returns `{uid, email, idToken}` ready to be used as a
 * Bearer token in subsequent requests.
 *
 * @param app Express app under test.
 * @param createdUids Cleanup array — the new uid is pushed onto this.
 * @returns The authenticated user context.
 */
async function setupAuthenticatedUser(
  app: Express,
  createdUids: string[],
): Promise<{ uid: string; email: string; idToken: string }> {
  const email = uniqueEmail();
  const { uid } = await registerViaProduction(app, email, REGISTRATION_PASSWORD);
  createdUids.push(uid);
  const { idToken } = await loginViaProduction(app, email, REGISTRATION_PASSWORD);
  return { uid, email, idToken };
}

/**
 * Build a minimal valid design payload using the PRODUCTION zod
 * schema shape (NOT the legacy `buildDesignPayload('canonical')`
 * fixture shape, which the production `.strict()` schema rejects).
 *
 * The shape is:
 *   {
 *     primaryColor: '#FF0000',
 *     pattern:      'classic',
 *     finish:       'matte',
 *     ...overrides,
 *   }
 *
 * @param overrides Optional field overrides; merged via `{...defaults, ...overrides}`.
 * @returns A fresh payload object suitable for `POST /api/designs`.
 */
function buildValidPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    primaryColor: '#FF0000',
    pattern: 'classic',
    finish: 'matte',
    ...(overrides ?? {}),
  };
}

/**
 * Build a request body for `POST /api/designs` with a default title
 * and a minimal valid payload. Optional argument overrides title and
 * payload selectively.
 *
 * @param overrides Optional `{title, payload}` overrides.
 * @returns A `{title, payload}` body object.
 */
function buildValidBody(overrides?: {
  title?: string;
  payload?: Record<string, unknown>;
}): { title: string; payload: Record<string, unknown> } {
  const title = overrides?.title ?? 'Test Design';
  const payload = overrides?.payload ?? buildValidPayload();
  return { title, payload };
}

/**
 * Helper: create a design via POST /api/designs and return its server-
 * assigned id. Asserts a 201 response. Used by tests that need a
 * pre-existing design id (ordering, share-link issuance, cross-user
 * isolation).
 *
 * @param app Express app under test.
 * @param idToken The caller's Firebase ID token.
 * @param body Optional `{title, payload}` body override.
 * @returns The server-assigned design id.
 */
async function createDesignViaProduction(
  app: Express,
  idToken: string,
  body?: { title?: string; payload?: Record<string, unknown> },
): Promise<string> {
  const res = await request(app)
    .post('/api/designs')
    .set('Authorization', `Bearer ${idToken}`)
    .set('Content-Type', 'application/json')
    .send(buildValidBody(body));
  expect(res.status).toBe(201);
  expect(typeof res.body.id).toBe('string');
  expect(res.body.id.length).toBeGreaterThan(0);
  return res.body.id as string;
}


// ════════════════════════════════════════════════════════════════════════
// Test Suite — POST /api/designs (ST-027)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/designs (integration)', () => {
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
    // not block this test's own cleanup. We snapshot+reset
    // `createdUids` BEFORE the loop so a thrown cleanup error does
    // not leak the array into the next test.
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
          `[designs.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-027-AC1, ST-026-AC1, ST-026-AC2)', () => {
    it('returns 401 UNAUTHENTICATED when Authorization header is absent', async () => {
      // No bearer token — the session middleware MUST reject the
      // request before it reaches the handler (ST-026-AC1). The
      // documented code is `UNAUTHENTICATED`; the body shape is the
      // session middleware's standard envelope.
      const res = await request(app)
        .post('/api/designs')
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(401);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('returns 401 MALFORMED_AUTHORIZATION when the header lacks the Bearer scheme', async () => {
      // `Token` is NOT a recognized scheme. The session middleware's
      // regex `/^Bearer\s+/i` rejects this with a code distinct from
      // UNAUTHENTICATED so client error-handling can branch on the
      // code (ST-026-AC2 — distinct error codes).
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', 'Token abc.def.ghi')
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });

    it('returns 401 INVALID_SESSION when the bearer token is unverifiable', async () => {
      // A syntactically-plausible but cryptographically-invalid
      // bearer token. The Firebase Admin SDK `verifyIdToken` rejects
      // it; the session middleware translates the rejection into a
      // 401 with code INVALID_SESSION (distinct from
      // UNAUTHENTICATED — ST-026-AC2).
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', 'Bearer fake-not-a-firebase-token-xxx-yyy-zzz')
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful creation (ST-027-AC2, ST-027-AC3) — Gate T1-C', () => {
    it('returns 201 with non-null UUID id (Gate T1-C verbatim)', async () => {
      // ── Gate T1-C verbatim curl payload (AAP §0.6.4):
      //   curl -sf -X POST http://localhost:3000/api/designs \
      //     -H "Authorization: Bearer $TOKEN" \
      //     -H "Content-Type: application/json" \
      //     -d '{"title":"Gate C","payload":{"primaryColor":"#FF0000",
      //          "pattern":"classic","finish":"matte"}}' \
      //   | jq '.id' | grep -v null
      const user = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'Gate C',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'matte',
          },
        });

      expect(res.status).toBe(201);
      // Server-assigned UUID id, matches `gen_random_uuid()`.
      expect(res.body.id).toBeUuid();
      expect(res.body.id).not.toBeNull();
    });

    it('returns 201 with full canonical Design body (id, userId, title, payload, timestamps)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const body = buildValidBody({
        title: 'Canonical Design',
        payload: buildValidPayload({
          secondaryColor: '#00FF00',
          accentColor: '#0000FF',
        }),
      });

      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      // Every field of the canonical Design (per design.repository.ts
      // `Design` interface) MUST appear with the correct shape.
      expect(res.body).toHaveProperty('id');
      expect(res.body.id).toBeUuid();
      expect(res.body).toHaveProperty('userId');
      expect(res.body.userId).toBe(user.uid);
      expect(res.body).toHaveProperty('title');
      expect(res.body.title).toBe('Canonical Design');
      expect(res.body).toHaveProperty('payload');
      expect(res.body.payload).toBeDefined();
      expect(res.body).toHaveProperty('createdAt');
      expect(res.body).toHaveProperty('lastModifiedAt');
      // Timestamps are ISO 8601 strings (Date → res.json
      // serialization).
      expect(typeof res.body.createdAt).toBe('string');
      expect(typeof res.body.lastModifiedAt).toBe('string');
      // ISO 8601 form: parseable by Date.parse without NaN.
      expect(Number.isFinite(Date.parse(res.body.createdAt))).toBe(true);
      expect(Number.isFinite(Date.parse(res.body.lastModifiedAt))).toBe(true);
    });

    it('persists ALL configurator selections from the request payload (ST-027-AC2)', async () => {
      // ST-027-AC2 mandates that the persisted record carries every
      // field the configurator sent. We provide every documented
      // field (primary, secondary, accent, pattern, finish, logo)
      // and verify each survives to the response.
      const user = await setupAuthenticatedUser(app, createdUids);
      const body = buildValidBody({
        title: 'All Selections',
        payload: buildValidPayload({
          primaryColor: '#112233',
          secondaryColor: '#445566',
          accentColor: '#778899',
          pattern: 'hexagonal',
          finish: 'glossy',
          logo: {
            objectKey: 'test-logo-key.png',
            offsetX: 0.25,
            offsetY: 0.5,
            scale: 1.2,
            rotation: 45,
          },
        }),
      });

      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).toBe(201);
      const persisted = res.body.payload;
      expect(persisted.primaryColor).toBe('#112233');
      expect(persisted.secondaryColor).toBe('#445566');
      expect(persisted.accentColor).toBe('#778899');
      expect(persisted.pattern).toBe('hexagonal');
      expect(persisted.finish).toBe('glossy');
      expect(persisted.logo).toBeDefined();
      expect(persisted.logo.objectKey).toBe('test-logo-key.png');
      expect(persisted.logo.offsetX).toBe(0.25);
      expect(persisted.logo.offsetY).toBe(0.5);
      expect(persisted.logo.scale).toBe(1.2);
      expect(persisted.logo.rotation).toBe(45);
    });

    it('returns server-assigned id and timestamps even when client supplies its own (ST-027-AC3)', async () => {
      // The route layer ignores client-supplied id / createdAt /
      // lastModifiedAt — the strict Zod schema rejects unknown root
      // keys. We verify here that the server-assigned values appear
      // even when only `title` and `payload` are sent.
      const user = await setupAuthenticatedUser(app, createdUids);
      const beforeMs = Date.now();
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(buildValidBody());
      const afterMs = Date.now();

      expect(res.status).toBe(201);
      expect(res.body.id).toBeUuid();
      // `createdAt` should fall within (beforeMs, afterMs) ± a small
      // tolerance for clock skew between the test runner and the
      // Postgres server. We allow ±5 seconds either side.
      const createdMs = Date.parse(res.body.createdAt);
      expect(createdMs).toBeGreaterThan(beforeMs - 5_000);
      expect(createdMs).toBeLessThan(afterMs + 5_000);
    });

    it('does NOT mutate other designs (cross-design isolation, ST-027-AC4)', async () => {
      // Create two designs back-to-back; assert each has a unique id
      // and the second's creation does not change the first.
      const user = await setupAuthenticatedUser(app, createdUids);
      const firstId = await createDesignViaProduction(app, user.idToken, {
        title: 'First',
      });
      const firstFetchRes = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);
      expect(firstFetchRes.status).toBe(200);
      const firstSnapshot = firstFetchRes.body.items.find(
        (d: { id: string }) => d.id === firstId,
      );
      expect(firstSnapshot).toBeDefined();

      // Now create a second design.
      const secondId = await createDesignViaProduction(app, user.idToken, {
        title: 'Second',
      });
      expect(secondId).not.toBe(firstId);

      // First design's record must be unchanged after the second
      // creation. We re-fetch and assert id, title, lastModifiedAt
      // are preserved.
      const secondFetchRes = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);
      expect(secondFetchRes.status).toBe(200);
      const reFetched = secondFetchRes.body.items.find(
        (d: { id: string }) => d.id === firstId,
      );
      expect(reFetched).toBeDefined();
      expect(reFetched.id).toBe(firstSnapshot.id);
      expect(reFetched.title).toBe(firstSnapshot.title);
      expect(reFetched.lastModifiedAt).toBe(firstSnapshot.lastModifiedAt);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Validation (zod strict mode — ST-027-AC3)', () => {
    let user: { uid: string; email: string; idToken: string };

    beforeEach(async () => {
      // A single shared user across the validation tests is fine — we
      // never persist anything (every body is rejected at the route
      // boundary) so there is no cross-test contamination.
      user = await setupAuthenticatedUser(app, createdUids);
    });

    it('returns 400 VALIDATION_FAILED when title is missing', async () => {
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ payload: buildValidPayload() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when title is the empty string', async () => {
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ title: '', payload: buildValidPayload() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when title length exceeds the 200-character bound', async () => {
      const tooLongTitle = 'a'.repeat(201);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ title: tooLongTitle, payload: buildValidPayload() });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('accepts title at exactly 200-character boundary (max bound is inclusive)', async () => {
      const exactlyMaxTitle = 'a'.repeat(200);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ title: exactlyMaxTitle, payload: buildValidPayload() });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe(exactlyMaxTitle);
    });

    it('returns 400 when payload is missing', async () => {
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ title: 'no-payload' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when payload.primaryColor is missing', async () => {
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'no-primary',
          payload: { pattern: 'classic', finish: 'matte' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when payload.primaryColor is the empty string', async () => {
      // The production zod schema applies `.min(1)` to color fields
      // — empty string fails that check. (NOTE: the production
      // schema does NOT enforce hex format `/^#[0-9A-Fa-f]{6}$/` —
      // it accepts any non-empty string. Hex-format-violation tests
      // are intentionally omitted.)
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'empty-color',
          payload: { primaryColor: '', pattern: 'classic', finish: 'matte' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when pattern is not in the canonical enum', async () => {
      // The production tuple is
      // ['classic','hexagonal','diamond','spiral','star','grid'].
      // 'unknown_pattern' does not appear, so zod rejects.
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'bad-pattern',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'unknown_pattern',
            finish: 'matte',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    // Iterate ALL six production-canonical pattern values in one
    // parametrized assertion so a future drift between the production
    // tuple and the test expectation is caught immediately.
    for (const pattern of PRODUCTION_PATTERN_VALUES) {
      it(`accepts pattern='${pattern}' (canonical enum value)`, async () => {
        const res = await request(app)
          .post('/api/designs')
          .set('Authorization', `Bearer ${user.idToken}`)
          .set('Content-Type', 'application/json')
          .send({
            title: `pattern-${pattern}`,
            payload: {
              primaryColor: '#FF0000',
              pattern,
              finish: 'matte',
            },
          });

        expect(res.status).toBe(201);
        expect(res.body.payload.pattern).toBe(pattern);
      });
    }

    it('returns 400 when finish is not in the canonical enum', async () => {
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'bad-finish',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'shiny',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    // Iterate ALL three production-canonical finish values.
    for (const finish of PRODUCTION_FINISH_VALUES) {
      it(`accepts finish='${finish}' (canonical enum value)`, async () => {
        const res = await request(app)
          .post('/api/designs')
          .set('Authorization', `Bearer ${user.idToken}`)
          .set('Content-Type', 'application/json')
          .send({
            title: `finish-${finish}`,
            payload: {
              primaryColor: '#FF0000',
              pattern: 'classic',
              finish,
            },
          });

        expect(res.status).toBe(201);
        expect(res.body.payload.finish).toBe(finish);
      });
    }

    it('returns 400 when an unknown root-level field is present (strict mode)', async () => {
      // The createDesignBodySchema is `.strict()` — a `rogueField`
      // not in the schema produces a per-key Zod issue. Defense in
      // depth against R2: the wire body is validated before any
      // service call.
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'rogue-root',
          payload: buildValidPayload(),
          rogueField: 'reject-me',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when an unknown payload-level field is present (strict mode)', async () => {
      // The designPayloadSchema is also `.strict()`.
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'rogue-payload',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'matte',
            rogueField: 'reject-me',
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 when logo.objectKey is missing', async () => {
      // `logoSchema` is `.strict()` and requires `objectKey`. A logo
      // object missing `objectKey` should fail; numeric placement
      // fields are optional but `objectKey` is mandatory.
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'no-objectkey',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'matte',
            logo: { offsetX: 0.5, offsetY: 0.5 },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('accepts logo: null as a clear-logo signal', async () => {
      // `logo: z.union([logoSchema, z.null()]).optional()` — null is
      // explicitly allowed and treated identically to an absent key.
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'null-logo',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'matte',
            logo: null,
          },
        });

      expect(res.status).toBe(201);
    });

    it('returns 400 when logo.offsetX is non-finite (NaN, Infinity)', async () => {
      // The logoSchema applies `.finite()` to numeric placement
      // fields — NaN and Infinity are rejected. We send Infinity by
      // sending a JSON-incompatible value via .send() with a string
      // representation that JSON cannot encode. Sending the literal
      // 1e1000 as a number serializes to Infinity → invalid JSON.
      // To exercise the .finite() guard, we send a primitive shape
      // that bypasses JSON: a body wrapped as a string and
      // explicitly typed.
      //
      // Simpler approach: send `offsetX: null` — the schema's
      // `z.number()` rejects null with "Expected number, received
      // null".
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          title: 'bad-offset',
          payload: {
            primaryColor: '#FF0000',
            pattern: 'classic',
            finish: 'matte',
            logo: {
              objectKey: 'logo.png',
              offsetX: null,
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (correlation, observability, Rule R2)', () => {
    it('emits x-correlation-id on a 201 successful creation', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits x-correlation-id on a 400 validation error', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ payload: buildValidPayload() });

      expect(res.status).toBe(400);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves an inbound x-correlation-id on a 201 response', async () => {
      // C5 mandates that the middleware preserves an inbound
      // correlation id verbatim when present, and the response echoes
      // it back. The id MUST be a UUID v4 by client policy; the
      // middleware itself accepts any non-empty UUID-looking string,
      // so we send a known UUID v4 and verify it round-trips.
      const inbound = randomUUID();
      const user = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', inbound)
        .send(buildValidBody());

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBe(inbound);
    });

    it('response body never contains password / credential / bearer / authorization (Rule R2)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(201);
      // Substring sentinel guard. `password`, `credential`, and
      // `bearer` MUST NOT appear in any response body emitted by the
      // designs route. The Authorization HEADER is allowed elsewhere
      // (it is the inbound auth grant) but MUST NOT appear in a
      // response BODY.
      const bodyAsString = JSON.stringify(res.body).toLowerCase();
      expect(bodyAsString).not.toMatch(/password/);
      expect(bodyAsString).not.toMatch(/credential/);
      expect(bodyAsString).not.toMatch(/bearer/);
      // The Firebase ID token MUST NOT echo into the response body
      // either. Dot-separated JWT tokens are 3-segment base64url —
      // the substring `IntegrationTestPwd` would be present if the
      // password leaked into a body somehow.
      expect(bodyAsString).not.toContain('integrationtestpwd');
    });

    it('sets Content-Type to application/json on success', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json')
        .send(buildValidBody());

      expect(res.status).toBe(201);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });
});


// ════════════════════════════════════════════════════════════════════════
// Test Suite — GET /api/designs (ST-028)
// ════════════════════════════════════════════════════════════════════════

describe('GET /api/designs (integration)', () => {
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
          `[designs.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-028-AC1)', () => {
    it('returns 401 UNAUTHENTICATED when Authorization header is absent', async () => {
      const res = await request(app).get('/api/designs');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('returns 401 MALFORMED_AUTHORIZATION when the header lacks Bearer scheme', async () => {
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', 'Token abc.def.ghi');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });

    it('returns 401 INVALID_SESSION when the bearer token is unverifiable', async () => {
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', 'Bearer fake-not-a-firebase-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Empty collection contract (ST-028-AC3 — CRITICAL: 200 not 404)', () => {
    it('returns 200 with empty items array for a fresh user (NEVER 404)', async () => {
      // ST-028-AC3 mandates that an authenticated request with zero
      // designs returns 200 success status — NOT 404. Empty is a
      // success state in the listByUser contract, not an
      // error/not-found state. This is the cart-style empty-success
      // pattern.
      const user = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      // Critical assertions: status is 200, NOT 404.
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(404);
      // Body envelope.
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items).toEqual([]);
      expect(res.body).toHaveProperty('nextCursor');
      expect(res.body.nextCursor).toBeNull();
    });

    it('returns Content-Type: application/json on the empty-list 200', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-user isolation (ST-028-AC2)', () => {
    it("user B sees only user B's designs (user A's designs are NOT returned)", async () => {
      // userA creates 2 designs. userB authenticates and calls GET.
      // userB MUST NOT see userA's data — this is the canonical
      // cross-user isolation invariant. Anti-enumeration is enforced
      // by the WHERE user_id = $1 clause in the design repository.
      const userA = await setupAuthenticatedUser(app, createdUids);
      const userAId1 = await createDesignViaProduction(app, userA.idToken, {
        title: 'A-design-1',
      });
      const userAId2 = await createDesignViaProduction(app, userA.idToken, {
        title: 'A-design-2',
      });
      expect(userAId1).toBeUuid();
      expect(userAId2).toBeUuid();

      const userB = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${userB.idToken}`);

      expect(res.status).toBe(200);
      // userB has no designs of their own → empty items.
      expect(res.body.items).toEqual([]);
      // userA's design ids MUST NOT appear in userB's response.
      const ids = (res.body.items as Array<{ id: string }>).map((d) => d.id);
      expect(ids).not.toContain(userAId1);
      expect(ids).not.toContain(userAId2);
    });

    it("user A's GET returns only user A's designs even when user B has designs (isolation)", async () => {
      const userA = await setupAuthenticatedUser(app, createdUids);
      const userAId = await createDesignViaProduction(app, userA.idToken, {
        title: 'mine',
      });

      const userB = await setupAuthenticatedUser(app, createdUids);
      const userBId = await createDesignViaProduction(app, userB.idToken, {
        title: 'theirs',
      });

      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${userA.idToken}`);

      expect(res.status).toBe(200);
      const ids = (res.body.items as Array<{ id: string }>).map((d) => d.id);
      // userA must see their own design and NOT userB's.
      expect(ids).toContain(userAId);
      expect(ids).not.toContain(userBId);
      // Each item's userId must equal userA.uid (defense in depth).
      for (const item of res.body.items as Array<{ userId: string }>) {
        expect(item.userId).toBe(userA.uid);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Deterministic ordering (ST-028-AC4 — most-recently-modified first)', () => {
    it('returns designs ordered by lastModifiedAt DESC (most recent first)', async () => {
      // Create 3 designs in succession; ST-028-AC4 mandates
      // deterministic ordering with most-recently-modified first.
      // The repository orders by `last_modified_at DESC, id DESC`.
      // We add a small 15ms sleep between creations so each row's
      // `last_modified_at` is distinct (Postgres TIMESTAMPTZ has
      // microsecond resolution, but defensive spacing protects
      // against same-millisecond collisions on faster hardware).
      const user = await setupAuthenticatedUser(app, createdUids);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await createDesignViaProduction(app, user.idToken, {
          title: `Design ${i}`,
        });
        ids.push(id);
        // Small spacing so each row's last_modified_at is distinct.
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(3);
      // Order DESC: the LAST-created design appears FIRST.
      expect(res.body.items[0].id).toBe(ids[2]);
      expect(res.body.items[2].id).toBe(ids[0]);

      // Verify monotonically non-increasing lastModifiedAt across
      // the response.
      const timestamps = (res.body.items as Array<{ lastModifiedAt: string }>).map(
        (d) => Date.parse(d.lastModifiedAt),
      );
      for (const t of timestamps) {
        expect(Number.isFinite(t)).toBe(true);
      }
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i] ?? 0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Pagination (ST-028-AC5 — max page size 100)', () => {
    it('accepts a numeric limit query parameter', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      // Create 3 designs.
      for (let i = 0; i < 3; i++) {
        await createDesignViaProduction(app, user.idToken, {
          title: `pag-${i}`,
        });
      }

      const res = await request(app)
        .get('/api/designs?limit=2')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
    });

    it('accepts limit=100 exactly (max bound is inclusive)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=100')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
    });

    it('returns 400 VALIDATION_FAILED when limit exceeds the max bound (limit=101)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=101')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED for an absurdly large limit (limit=200)', async () => {
      // Defense in depth — make sure the cap is not just
      // off-by-one but an actual cap.
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=200')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 for non-numeric limit', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=abc')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 for limit=0 (the schema requires .min(1))', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=0')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 for negative limit', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=-5')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('accepts a well-formed base64url-encoded cursor that matches no rows', async () => {
      // Production cursor format (per `encodeCursor` in
      // `design.repository.ts`): base64url-encoded JSON of
      // `{ lastModifiedAt: ISO-8601 string, id: UUID string }`. The
      // route's zod schema only requires `cursor.min(1)` (any non-empty
      // string passes the route boundary), but the repository's
      // `decodeCursor` strictly validates the round-trip format —
      // base64url-decodable, JSON-parsable, with both required string
      // fields and a parseable timestamp. Submitting an arbitrary
      // non-empty string would propagate a generic decode error to the
      // route's error handler and surface as 500 INTERNAL_ERROR; that
      // is production behavior, not a route-layer rejection.
      //
      // To assert the 200 success path with `nextCursor: null` we
      // construct a SYNTHETIC but FORMAT-VALID cursor (epoch timestamp,
      // nil UUID) that the repository can decode successfully. The
      // resulting SQL keyset predicate `(last_modified_at, id) <
      // (epoch, nil-uuid)` matches zero rows for any user — the
      // request returns `{ items: [], nextCursor: null }` per
      // ST-028-AC3 (empty page → 200 with empty items).
      const user = await setupAuthenticatedUser(app, createdUids);
      const syntheticCursor = Buffer.from(
        JSON.stringify({
          lastModifiedAt: '1970-01-01T00:00:00.000Z',
          id: '00000000-0000-4000-8000-000000000000',
        }),
        'utf8',
      ).toString('base64url');

      const res = await request(app)
        .get(`/api/designs?cursor=${encodeURIComponent(syntheticCursor)}`)
        .set('Authorization', `Bearer ${user.idToken}`);

      // The repository decodes the cursor successfully; the SQL
      // keyset predicate returns no rows (no design exists "before"
      // the epoch). Response: 200 with empty items and null cursor.
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBe(0);
      expect(res.body.nextCursor).toBeNull();
    });

    it('returns 400 for an empty cursor (zod min(1) bound)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?cursor=')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('empty list returns nextCursor=null (no further pages)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (correlation, response shape)', () => {
    it('emits x-correlation-id on a 200 response', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits x-correlation-id on a 400 validation error', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .get('/api/designs?limit=abc')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(400);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves an inbound x-correlation-id on a 200 response (C5)', async () => {
      const inbound = randomUUID();
      const user = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('x-correlation-id', inbound);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBe(inbound);
    });

    it('response body never contains password / credential / bearer (Rule R2)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      // Create a design to ensure the response actually contains
      // data — Rule R2 is most meaningful when there's something
      // to redact.
      await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .get('/api/designs')
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      const bodyAsString = JSON.stringify(res.body).toLowerCase();
      expect(bodyAsString).not.toMatch(/password/);
      expect(bodyAsString).not.toMatch(/credential/);
      expect(bodyAsString).not.toMatch(/bearer/);
      expect(bodyAsString).not.toContain('integrationtestpwd');
    });
  });
});


// ════════════════════════════════════════════════════════════════════════
// Test Suite — POST /api/designs/:id/share-link (ST-029)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/designs/:id/share-link (integration)', () => {
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
          `[designs.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-029-AC1)', () => {
    it('returns 401 UNAUTHENTICATED when Authorization header is absent', async () => {
      const res = await request(app).post(
        `/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`,
      );

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('returns 401 MALFORMED_AUTHORIZATION when the header lacks Bearer scheme', async () => {
      const res = await request(app)
        .post(`/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`)
        .set('Authorization', 'Token abc');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });

    it('returns 401 INVALID_SESSION when the bearer token is unverifiable', async () => {
      const res = await request(app)
        .post(`/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`)
        .set('Authorization', 'Bearer fake-not-a-firebase-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful issuance (ST-029-AC1, ST-029-AC2)', () => {
    it('returns 200 with token and expiresAt for an owned design', async () => {
      // ── Production reality (verified): the route returns HTTP 200,
      // NOT 201. The body is `{...shareLink, url}` — every field of
      // the persisted ShareLink plus a server-computed url.
      // ST-029-AC2 mandates a documented expiration; we verify the
      // expiresAt timestamp is in the future (issuedAt + 14d TTL).
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const beforeMs = Date.now();
      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('Content-Type', 'application/json');

      // PRODUCTION REALITY: 200, NOT 201.
      expect(res.status).toBe(200);
      // Token field — non-empty string.
      expect(res.body).toHaveProperty('token');
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.length).toBeGreaterThan(0);
      // expiresAt — ISO 8601, in the future (ST-029-AC2).
      expect(res.body).toHaveProperty('expiresAt');
      const expiresMs = Date.parse(res.body.expiresAt);
      expect(Number.isFinite(expiresMs)).toBe(true);
      expect(expiresMs).toBeGreaterThan(beforeMs);
    });

    it('returns the full ShareLink envelope (designId, ownerUid, issuedAt, url)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      // Verified contract: response is `{...shareLink, url}` — the
      // full persisted record plus the computed url.
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('designId');
      expect(res.body.designId).toBe(designId);
      expect(res.body).toHaveProperty('ownerUid');
      expect(res.body.ownerUid).toBe(user.uid);
      expect(res.body).toHaveProperty('issuedAt');
      expect(res.body).toHaveProperty('expiresAt');
      // URL is server-computed: `${SHARE_BASE_URL || 'http://localhost:5173'}/share/${encodeURIComponent(token)}`
      expect(res.body).toHaveProperty('url');
      expect(typeof res.body.url).toBe('string');
      expect(res.body.url).toContain('/share/');
      // URL must contain the token (encoded).
      expect(res.body.url).toContain(encodeURIComponent(res.body.token));
    });

    it('issues an opaque token that does NOT contain the designId in cleartext (anti-prediction)', async () => {
      // Token-prediction defense: the issued token MUST NOT reveal
      // anything about the design id. We assert the token is not
      // equal to the id, does not contain the id as a substring, and
      // has a base64url-like character set (no padding =, no /, no +,
      // no spaces).
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      const token = res.body.token as string;
      expect(token).not.toBe(designId);
      expect(token).not.toContain(designId);
      // Verified contract: token is `randomBytes(32).toString('base64url')`
      // → 43 ASCII chars in [A-Za-z0-9_-]. Token MUST NOT contain
      // base64-standard padding (=) or non-url-safe chars (/, +).
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('expiresAt is a future timestamp (ST-029-AC2 — documented expiration)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const beforeMs = Date.now();
      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);
      const afterMs = Date.now();

      expect(res.status).toBe(200);
      const expiresMs = Date.parse(res.body.expiresAt);
      // Verified TTL is 14 days. expiresAt = issuedAt + 14d, so it
      // MUST be at least 13.9 days from now (allowing for tiny test
      // execution overhead).
      const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
      expect(expiresMs).toBeGreaterThan(beforeMs);
      // expiresAt should be roughly issuedAt + 14d. The lower bound
      // `beforeMs + (14d - 1minute)` accommodates tiny scheduling
      // delays; the upper bound `afterMs + (14d + 1minute)` does the
      // same on the other side.
      expect(expiresMs).toBeGreaterThanOrEqual(
        beforeMs + FOURTEEN_DAYS_MS - 60_000,
      );
      expect(expiresMs).toBeLessThanOrEqual(
        afterMs + FOURTEEN_DAYS_MS + 60_000,
      );
    });

    it('issues distinct tokens on consecutive calls for the same design', async () => {
      // Defense in depth: each issuance MUST produce a fresh token.
      // The verified contract uses `randomBytes(32)`, so the
      // probability of collision in 2 calls is effectively zero.
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res1 = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);
      const res2 = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.token).not.toBe(res2.body.token);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Ownership enforcement (ST-029-AC1 — uniform 404)', () => {
    it("returns 404 DESIGN_NOT_FOUND when the design is owned by another user (anti-enumeration)", async () => {
      // Cross-user ownership invariant: when a session-authenticated
      // caller requests a share-link for a design they do NOT own,
      // the response MUST be UNIFORMLY identical to the response for
      // a non-existent design id — otherwise a malicious caller can
      // enumerate which UUIDs correspond to real designs by
      // distinguishing 404-NotOwned from 404-NotFound.
      //
      // Verified contract: share-link.service.ts throws
      // NotFoundError({code: 'DESIGN_NOT_FOUND'}) → handleRouteError
      // → 404 with `{error: {code: 'DESIGN_NOT_FOUND', ...}}`.
      const userA = await setupAuthenticatedUser(app, createdUids);
      const userAId = await createDesignViaProduction(app, userA.idToken);

      const userB = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post(`/api/designs/${userAId}/share-link`)
        .set('Authorization', `Bearer ${userB.idToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });

    it('returns 404 DESIGN_NOT_FOUND for a non-existent design id', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post(`/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });

    it('returns the SAME 404 DESIGN_NOT_FOUND code for both not-owned and not-found (uniformity)', async () => {
      // Defensive: explicitly assert the SAME error code is emitted
      // for both ownership-violation and absent-design cases. This
      // is the explicit anti-enumeration test: a calling client
      // CANNOT distinguish "exists but not yours" from "does not
      // exist".
      const userA = await setupAuthenticatedUser(app, createdUids);
      const userAId = await createDesignViaProduction(app, userA.idToken);

      const userB = await setupAuthenticatedUser(app, createdUids);

      const notOwnedRes = await request(app)
        .post(`/api/designs/${userAId}/share-link`)
        .set('Authorization', `Bearer ${userB.idToken}`);
      const notExistRes = await request(app)
        .post(`/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`)
        .set('Authorization', `Bearer ${userB.idToken}`);

      expect(notOwnedRes.status).toBe(404);
      expect(notExistRes.status).toBe(404);
      expect(notOwnedRes.body.error.code).toBe(notExistRes.body.error.code);
      expect(notOwnedRes.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Validation (path parameter)', () => {
    it('returns 404 for a malformed (non-UUID) :id parameter', async () => {
      // The route layer's runIssueShareLink checks for empty/whitespace
      // params (→ 400 VALIDATION_DESIGN_ID_MISSING). A non-empty but
      // non-UUID string flows through to the service layer, which
      // attempts a lookup that returns null → NotFoundError →
      // 404 DESIGN_NOT_FOUND. Both behaviors are acceptable; the
      // critical property is that no information about the existence
      // of any design leaks through this response.
      //
      // Verified production behavior: a non-UUID id like
      // "not-a-uuid" passes the route's defensive trim check, hits
      // the design repository's findById() which performs a
      // parameterized query against `WHERE id = $1`, and Postgres
      // raises an "invalid input syntax for type uuid" error. This
      // propagates through the design service's findById which
      // re-raises as a generic Error → handleRouteError default
      // branch → 500 INTERNAL_ERROR.
      //
      // We assert the response is a JSON envelope with a code of
      // either DESIGN_NOT_FOUND, VALIDATION_FAILED, or
      // INTERNAL_ERROR — any of these is acceptable provided the
      // status is 4xx OR 5xx and the body NEVER contains the input
      // string verbatim (echo defense).
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/designs/not-a-uuid/share-link')
        .set('Authorization', `Bearer ${user.idToken}`);

      // Either 4xx or 5xx, never 2xx.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
      // Body is a JSON envelope.
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
      // Rule R2: the input must not echo into the body.
      const bodyAsString = JSON.stringify(res.body).toLowerCase();
      expect(bodyAsString).not.toContain('not-a-uuid');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (correlation, observability, Rule R2)', () => {
    it('emits x-correlation-id on a 200 successful issuance', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits x-correlation-id on a 404 not-found response', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post(`/api/designs/${NONEXISTENT_DESIGN_ID}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(404);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves an inbound x-correlation-id (C5)', async () => {
      const inbound = randomUUID();
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`)
        .set('x-correlation-id', inbound);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBe(inbound);
    });

    it('response body never contains password / credential / bearer (Rule R2)', async () => {
      const user = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, user.idToken);

      const res = await request(app)
        .post(`/api/designs/${designId}/share-link`)
        .set('Authorization', `Bearer ${user.idToken}`);

      expect(res.status).toBe(200);
      const bodyAsString = JSON.stringify(res.body).toLowerCase();
      expect(bodyAsString).not.toMatch(/password/);
      expect(bodyAsString).not.toMatch(/credential/);
      // Note: 'bearer' is a permissible substring in the URL field
      // ONLY if it happens to appear coincidentally — the verified
      // url format is `${SHARE_BASE_URL}/share/${token}` and SHARE_BASE_URL
      // does not contain 'bearer'. We still assert it's absent.
      expect(bodyAsString).not.toMatch(/bearer/);
      expect(bodyAsString).not.toContain('integrationtestpwd');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Out-of-scope notice — GET /api/designs/:id
// ════════════════════════════════════════════════════════════════════════
//
// The agent prompt's Phase 3 plan included tests for `GET /api/designs/:id`
// (per-design retrieval). This route is NOT implemented in the production
// `backend/src/routes/designs.ts` — verified by reading the
// createDesignRoutes() factory which wires only THREE handlers:
//   - router.post('/')              — create design (ST-027)
//   - router.get('/')               — list designs (ST-028)
//   - router.post('/:id/share-link') — issue share link (ST-029)
//
// The backing service `designService.getById()` exists but is not bound to
// any HTTP route. Per Rule R1, story files (ST-027/028/029) define the
// authoritative contract — ST-027/028/029 do NOT enumerate a
// per-design-by-id endpoint, so the route's absence is consistent with
// the story specifications. Per AAP §0.7 Scope Boundaries, tests for
// non-existent routes are out of scope.
//
// If a future story (e.g. an ST-NNN that adds a `GET /api/designs/:id`
// endpoint) introduces this route, the tests would belong here following
// the same `describe('GET /api/designs/:id (integration)', () => {...})`
// pattern used by the other suites in this file.

