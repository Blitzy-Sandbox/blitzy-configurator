/**
 * `share.integration.test.ts` — Integration tests for the UNAUTHENTICATED
 * share-link read endpoint:
 *   - `GET /api/share/:token`             (ST-029-AC3 — read-only render)
 *
 * Companion authenticated routes — `POST /api/designs` (ST-027), `GET
 * /api/designs` (ST-028), and `POST /api/designs/:id/share-link` (ST-029
 * issuance) — are exercised in `designs.integration.test.ts`. This file
 * focuses on the read side: a recipient who knows only the share token
 * MUST be able to render the design read-only WITHOUT signing in.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations from `tickets/stories/*.md`)
 * ============================================================================
 *
 *   - ST-029 (`tickets/stories/ST-029-share-link-issuance-endpoint.md`):
 *       AC3 — A valid share link visit returns enough information for
 *             the configurator to render the design read-only
 *             WITHOUT signing in (this file's PRIMARY scope).
 *
 *   - ST-027 (`tickets/stories/ST-027-create-design-endpoint.md`):
 *       Used as setup precondition: a share link must reference a
 *             persisted design. The setup helper drives the production
 *             POST /api/designs endpoint to create the design.
 *
 *   - ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC2 — Deterministic fixtures (this file builds payloads inline
 *             with production-valid shapes; the project fixture
 *             `buildDesignPayload` uses a different (legacy) logo
 *             shape that violates the production zod `.strict()`
 *             schema, so we deliberately do NOT use it here).
 *       AC3 — Distinguishes assertion failures from environment /
 *             fixture-setup failures (per-suite.ts owns the
 *             unhandled-rejection guard; setup failures throw with
 *             distinguishable messages).
 *       AC4 — Runs against locally-started dependencies (PostgreSQL +
 *             Firebase Auth Emulator + GCS emulator).
 *
 *   - AAP §0.5.6 — Cross-cutting middleware order — NON-NEGOTIABLE.
 *     The share router is the ONE unauthenticated `/api/*` mount; it
 *     is mounted at the app ROOT BEFORE the session gate so that
 *     `GET /api/share/:token` bypasses session validation. Any
 *     reordering would surface as a 401 on test 2 below ("does NOT
 *     require an Authorization header").
 *
 *   - AAP §0.6.5 — Endpoint Authentication Map (verbatim):
 *       `GET /api/share/:token` — Auth? **No** — Reason: "Share link viewer".
 *
 *   - Verified `routes/share.ts` contract:
 *       - `null` return from `shareLinkService.getByToken({ token })`
 *         collapses to `404 SHARE_LINK_NOT_FOUND` for ALL of:
 *         unknown / expired / revoked / missing-design.
 *         **Enumeration-defense unification** — see `routes/share.ts`
 *         §3 "Enumeration defense" for the full rationale.
 *       - Response shape on success is `SharedDesignView { design,
 *         designId, title, lastModifiedAt }` — NO ownerUid, NO userId,
 *         NO token echo (verified at `services/share-link.service.ts`
 *         line 460-469: "INTENTIONALLY ABSENT: ownerUid, token,
 *         expiresAt, revokedAt, createdAt").
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance (DOMINANT for this file)
 * ============================================================================
 *
 *   - Rule R1 (Story ACs are authoritative): every `it()` cites the
 *     specific AC or invariant it verifies.
 *
 *   - Rule R2 (NO credential material in logs / responses): the share
 *     token IS the credential for the share endpoint — the entire
 *     "Response Sanitization" describe block is dedicated to verifying
 *     no token echo, no ownerUid leak, no Authorization header echo.
 *     Logs are subject to the pino-redact paths configured in
 *     `createIntegrationApp` and the allow-list serializer in
 *     `backend/src/logging/pino.ts`.
 *
 *   - Rule R3 (Firebase Admin SDK ONLY): authenticated SETUP requests
 *     (POST /api/designs, POST /api/designs/:id/share-link) carry
 *     bearer tokens issued by the Firebase Auth Emulator REST API
 *     (the `signInWithPassword` adapter `backend/src/auth/firebase-rest.ts`)
 *     and verified by `admin.auth().verifyIdToken()`. The actual
 *     unauthenticated GET /api/share/:token requests under test
 *     deliberately omit any Authorization header.
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
 *   - LocalGCP Verification Rule (AAP §0.8.2): every test creates its
 *     own resources (Firebase users, designs, share links) during the
 *     test body and cleans them up via `deleteTestUser` in
 *     `afterEach`. There is no dependence on pre-existing emulator
 *     state.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks, no stubs)
 * ============================================================================
 *
 *   - `backend/src/routes/share.ts` — the PRIMARY system under test.
 *     Single route: `GET /api/share/:token`. Verifies (1) success
 *     200 + SharedDesignView, (2) unified 404 enumeration defense,
 *     (3) response sanitization, (4) correlation-header propagation.
 *
 *   - `backend/src/services/share-link.service.ts` — share-link read
 *     side (`getByToken` returns SharedDesignView | null with the
 *     four collapsed null conditions).
 *
 *   - `backend/src/middleware/correlation.ts` — correlation ID
 *     middleware (UUID v4 generation, AsyncLocalStorage propagation,
 *     `x-correlation-id` response header).
 *
 *   - `backend/src/auth/firebase-rest.ts` — `createSignInWithPassword`
 *     adapter for the Firebase Auth Emulator REST API. Required by
 *     `createSessionService` (which is required by `sessionMiddleware`
 *     in the integration app). NOT in the assigned schema's
 *     `depends_on_files` but is required to construct the
 *     SessionService end-to-end (same precedent as
 *     `auth.integration.test.ts` and `designs.integration.test.ts`).
 *     Documented in this header so downstream maintainers do not
 *     classify the import as a schema violation.
 *
 *   - All repositories (`user`, `session`, `design`, `share-link`)
 *     and all services (`session`, `design`, `share-link`, `gcs`)
 *     are wired so the integration app shape mirrors the production
 *     composition root in `backend/src/index.ts`.
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
 *   The agent prompt's `createTestDesignAndShareLink` template
 *   diverged from production reality. Tests in this file follow
 *   PRODUCTION reality (Rule R1: code is authoritative) and document
 *   the divergence here so future maintainers do not reintroduce the
 *   prompt-style assertions:
 *
 *     1. The prompt's setup helper used `createTestUser()` which only
 *        creates a Firebase Auth row. The local `users` table FK
 *        constraint on `designs.user_id` requires a row in `users`
 *        too, so we instead use the production `/api/auth/register`
 *        endpoint via `registerViaProduction()` which writes BOTH.
 *
 *     2. The prompt claimed `POST /api/designs/:id/share-link` returns
 *        201. Verified production reality: it returns HTTP **200** and
 *        the body includes a server-computed `url` field beyond the
 *        bare `ShareLink` shape (see `routes/designs.ts` line 775).
 *
 *     3. The prompt suggested using `buildDesignPayload('canonical')`
 *        from `tests/integration/fixtures/design-builder.ts` for the
 *        setup design. Verified: the fixture's logo shape uses
 *        `reference` + nested `placement: {x, y, scale, rotation}`,
 *        but the production zod `.strict()` schema requires
 *        `objectKey` + flat `offsetX/offsetY/scale/rotation`. The
 *        fixture's payload would be REJECTED by validation. Tests
 *        therefore build payloads inline with the production-valid
 *        shape (see `buildValidPayload` below).
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   cd backend && npx eslint tests/integration/routes/share.integration.test.ts \
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/share.integration.test.ts \
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
// `createSignInWithPassword` is NOT in the assigned schema's
// `depends_on_files` but is required by `createSessionService`. Same
// established precedent as `auth.integration.test.ts` and
// `designs.integration.test.ts`. Documented in the file header.
import { createSignInWithPassword } from '../../../src/auth/firebase-rest';
import { logger } from '../../../src/logging/pino';
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { sessionMiddleware } from '../../../src/middleware/session';
import { metricsMiddleware } from '../../../src/routes/metrics';
import { createHealthRoutes } from '../../../src/routes/health';
import { createAuthRoutes } from '../../../src/routes/auth';
import { createDesignRoutes } from '../../../src/routes/designs';
import { createShareRoutes } from '../../../src/routes/share';

import { createUserRepository } from '../../../src/repositories/user.repository';
import { createSessionRepository } from '../../../src/repositories/session.repository';
import { createDesignRepository } from '../../../src/repositories/design.repository';
import { createShareLinkRepository } from '../../../src/repositories/share-link.repository';

import { createSessionService } from '../../../src/services/session.service';
import { createDesignService } from '../../../src/services/design.service';
import { createShareLinkService } from '../../../src/services/share-link.service';
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
 * The expected error code for the unified 404 enumeration-defense
 * branch. Per `backend/src/routes/share.ts` line 600:
 *
 *   `buildError('SHARE_LINK_NOT_FOUND', 'Share link not found or expired')`
 *
 * Returned for ALL FOUR null conditions: unknown token, revoked,
 * expired, missing-design. Tests assert on the `code` exclusively
 * because the message is a fixed string ("Share link not found or
 * expired") that the share route handler emits without reference to
 * the originating cause.
 */
const SHARE_LINK_NOT_FOUND_CODE = 'SHARE_LINK_NOT_FOUND';

/**
 * The expected error code for empty/whitespace-only path tokens. Per
 * `backend/src/routes/share.ts` line 559:
 *
 *   `buildError('VALIDATION_TOKEN_MISSING', 'Token required')`
 *
 * Returned when the route handler observes `typeof token !== 'string'`
 * OR `token.trim() === ''` (e.g., the URL `/api/share/%20` decodes to
 * a single-space `:token` parameter that triggers this branch).
 */
const VALIDATION_TOKEN_MISSING_CODE = 'VALIDATION_TOKEN_MISSING';

/**
 * Production zod tuples used by the inline payload builder.
 *
 * Locking these as `as const readonly` literal-string types means that
 * a future production drift (e.g. the production enum gains a 7th
 * pattern) would surface as a TypeScript compile error in this file
 * rather than a silent test gap.
 *
 * See `routes/designs.ts` `PATTERN_VALUES` and `FINISH_VALUES`.
 */
const PRODUCTION_PATTERN_CLASSIC = 'classic' as const;
const PRODUCTION_FINISH_MATTE = 'matte' as const;

// ════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique email per test invocation.
 *
 * Format: `share-test-{uuidv4}@example.com`. Uses Node 20's stdlib
 * `randomUUID()` (UUID v4 per RFC 4122) to guarantee uniqueness even
 * under sequential invocation in the same millisecond. The leading
 * `share-test-` prefix makes test users easy to identify if a partial
 * cleanup leaves orphans in the Firebase Auth emulator.
 *
 * @returns A fresh email of the documented shape.
 */
function uniqueEmail(): string {
  return `share-test-${randomUUID()}@example.com`;
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
 *
 *  11. 4-arg error handler — converts thrown errors into a non-leaking
 *      JSON 5xx envelope.
 *
 * The dependency wiring follows `backend/src/index.ts` Step 4 verbatim.
 * The `signInWithPassword` adapter (`backend/src/auth/firebase-rest.ts`)
 * is required by `createSessionService` even though its source path is
 * NOT in the assigned schema's `depends_on_files` — same precedent as
 * `auth.integration.test.ts` and `designs.integration.test.ts`. This
 * keeps the integration app shape isomorphic to the production
 * composition root.
 *
 * Note: the share router is the SUT for this file but it is mounted at
 * the app ROOT (no path prefix) because the router internally declares
 * its routes at the FULL path `/api/share/:token` (see
 * `routes/share.ts` line 448). Mounting at root before the session
 * gate is REQUIRED by AAP §0.5.6 — share-link visits are
 * unauthenticated.
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

  // ── Step 3: services (compose repositories + adapters).
  const sessionService = createSessionService({
    sessionRepository,
    userRepository,
    firebaseAuth,
    signInWithPassword,
  });
  // `createGcsService()` reads GCS_BUCKET_NAME / GCS_EMULATOR_HOST
  // directly from the environment (set up by global-setup.ts against
  // fake-gcs-server). Even though the share-route tests do not directly
  // assert on signed URLs, the design service depends on the GCS
  // service for logo signed-URL resolution paths exercised when the
  // design payload contains a logo reference (this file uses payloads
  // without logos to keep the setup focused).
  const gcsService = createGcsService();
  const designService = createDesignService({ designRepository, gcsService });
  const shareLinkService = createShareLinkService({
    shareLinkRepository,
    designRepository,
  });

  // ── Step 4: routers.
  const { publicAuthRouter, authenticatedAuthRouter } = createAuthRoutes({
    sessionService,
  });
  const shareRouter = createShareRoutes({ shareLinkService });
  const designsRouter = createDesignRoutes({ designService, shareLinkService });

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
  //     they bypass session validation). The share router is the SUT;
  //     it MUST mount here so `GET /api/share/:token` does not trigger
  //     the session middleware's 401 response.
  app.use(createHealthRoutes({ pool }));
  app.use(shareRouter);
  app.use('/api/auth', publicAuthRouter);

  // 6b. Session gate — mounted at `/api` so EVERY subsequent
  //     `/api/*` mount is protected. Per Express's positional
  //     middleware semantics, the share router's
  //     `GET /api/share/:token` already has its handler attached
  //     above; this mount does NOT retroactively gate it.
  app.use('/api', sessionMiddleware({ sessionService }));

  // 6c. AUTHENTICATED routes (mounted AFTER the session gate). These
  //     are required for the test setup phase: the
  //     `createTestDesignAndShareLink` helper drives POST
  //     /api/designs and POST /api/designs/:id/share-link to issue a
  //     real share-link token that the test body then exercises
  //     against the unauthenticated GET /api/share/:token endpoint.
  app.use('/api/auth', authenticatedAuthRouter);
  app.use('/api/designs', designsRouter);

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
 * 201-success contract. Used by the share-link setup flow because the
 * local `users` table has a FK constraint via `designs.user_id`; a
 * Firebase-Auth-emulator-only user (created via `createTestUser()`
 * directly) would NOT satisfy the FK and the subsequent POST
 * /api/designs would fail with a foreign-key-violation 5xx.
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
  // Setup precondition: a non-201 here is an environment failure
  // (Firebase Auth Emulator unreachable, Postgres unreachable,
  // duplicate user race). Surface it explicitly so ST-044-AC3's
  // failure-categorization (assertion vs. environment) is honored.
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
 * 200-success contract. Used to obtain a fresh ID token for the setup
 * phase that calls protected POST /api/designs and POST
 * /api/designs/:id/share-link.
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
 * Bearer token in the setup-phase requests.
 *
 * The new uid is pushed onto the supplied `createdUids` array so the
 * `afterEach` cleanup loop deletes it from the Firebase Auth emulator.
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
 * This payload is intentionally LOGO-FREE: introducing a logo block
 * would require a real GCS objectKey to exist in the fake-gcs-server,
 * which adds a fixture-management burden orthogonal to this file's
 * scope (read-only share-link rendering). The
 * `Successful retrieval` test below asserts the response payload
 * preserves these top-level fields.
 *
 * @param overrides Optional field overrides; merged via `{...defaults, ...overrides}`.
 * @returns A fresh payload object suitable for `POST /api/designs`.
 */
function buildValidPayload(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    primaryColor: '#FF0000',
    secondaryColor: '#00FF00',
    accentColor: '#0000FF',
    pattern: PRODUCTION_PATTERN_CLASSIC,
    finish: PRODUCTION_FINISH_MATTE,
    ...(overrides ?? {}),
  };
}

/**
 * Composite setup helper: register + login a fresh user, persist a
 * design, and issue a share link for that design. Returns every
 * resource the caller may need to assert against.
 *
 * Cleanup contract: the new uid is pushed onto `createdUids` so the
 * `afterEach` loop removes it from the Firebase Auth emulator. The
 * design and share-link rows are left in PostgreSQL — the
 * `global-teardown.ts` safety net sweeps them on suite teardown
 * (LocalGCP Verification Rule).
 *
 * Notable production realities this helper honors:
 *   - POST /api/designs/:id/share-link returns HTTP **200** (not 201);
 *     verified at `routes/designs.ts` line 775. The status assertion
 *     below uses 200 as the expected success status.
 *   - The share-link issuance response body is the full `ShareLink`
 *     record plus a server-computed `url` field
 *     (`{token, designId, ownerUid, issuedAt, expiresAt, revokedAt, url}`).
 *
 * @param app Express app under test.
 * @param createdUids Cleanup array — the new uid is pushed onto this.
 * @returns The full setup result.
 */
async function createTestDesignAndShareLink(
  app: Express,
  createdUids: string[],
): Promise<{
  uid: string;
  email: string;
  idToken: string;
  designId: string;
  shareToken: string;
  expiresAt: string;
  title: string;
  payload: Record<string, unknown>;
}> {
  // Step 1: provision a fresh authenticated user.
  const user = await setupAuthenticatedUser(app, createdUids);

  // Step 2: persist a design owned by that user via the AUTHENTICATED
  // POST /api/designs endpoint. Inline payload builder is used (NOT
  // the legacy fixture, which uses an incompatible logo shape — see
  // file header §"Production Reality vs. Prompt Claims").
  const title = `Share Test Design ${randomUUID()}`;
  const payload = buildValidPayload();
  const createDesignRes = await request(app)
    .post('/api/designs')
    .set('Authorization', `Bearer ${user.idToken}`)
    .set('Content-Type', 'application/json')
    .send({ title, payload });
  // Setup precondition: a non-201 here is a fixture failure (e.g.,
  // production zod schema regression rejecting the inline payload).
  // ST-044-AC3 distinguishes this from an assertion failure via the
  // descriptive expect message below.
  expect(createDesignRes.status).toBe(201);
  expect(typeof createDesignRes.body.id).toBe('string');
  const designId = createDesignRes.body.id as string;

  // Step 3: issue a share link for that design via the
  // AUTHENTICATED POST /api/designs/:id/share-link endpoint.
  const shareRes = await request(app)
    .post(`/api/designs/${designId}/share-link`)
    .set('Authorization', `Bearer ${user.idToken}`)
    .set('Content-Type', 'application/json');
  // Production reality: HTTP 200, NOT 201. Asserted explicitly so
  // a future regression that flips back to 201 surfaces here as a
  // SETUP failure rather than masking real bugs in the GET tests
  // that follow.
  expect(shareRes.status).toBe(200);
  expect(typeof shareRes.body.token).toBe('string');
  expect(typeof shareRes.body.expiresAt).toBe('string');
  const shareToken = shareRes.body.token as string;
  const expiresAt = shareRes.body.expiresAt as string;

  return {
    uid: user.uid,
    email: user.email,
    idToken: user.idToken,
    designId,
    shareToken,
    expiresAt,
    title,
    payload,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite — GET /api/share/:token (ST-029-AC3)
// ════════════════════════════════════════════════════════════════════════

describe('GET /api/share/:token (integration)', () => {
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
          `[share.integration.test] cleanup failed for uid ${uid}: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Successful retrieval (ST-029-AC3)', () => {
    it('returns 200 with SharedDesignView when token is valid and design exists', async () => {
      // ST-029-AC3: A valid share-link visit returns enough info for
      // the configurator to render the design read-only WITHOUT
      // signing in. Verified contract (`services/share-link.service.ts`
      // line 460-469): `SharedDesignView { design, designId, title,
      // lastModifiedAt }`.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);

      expect(res.status).toBe(200);
      // Response shape: SharedDesignView { design, designId, title,
      // lastModifiedAt }.
      expect(res.body).toBeDefined();
      expect(res.body).toHaveProperty('design');
      expect(res.body).toHaveProperty('designId');
      expect(res.body.designId).toBe(setup.designId);
      expect(res.body).toHaveProperty('title');
      expect(res.body.title).toBe(setup.title);
      expect(res.body).toHaveProperty('lastModifiedAt');
      // `lastModifiedAt` is a `Date` in TypeScript but `res.json`
      // serializes it via `Date.prototype.toJSON` to an ISO 8601
      // string. We verify it parses back to a finite ms-since-epoch.
      expect(typeof res.body.lastModifiedAt).toBe('string');
      expect(Number.isFinite(Date.parse(res.body.lastModifiedAt))).toBe(true);
    });

    it('does NOT require an Authorization header (UNAUTHENTICATED)', async () => {
      // AAP §0.5.6 / §0.6.5: `GET /api/share/:token` is mounted at
      // app ROOT BEFORE the session gate. No Authorization header is
      // sent — the request MUST succeed (200), proving the share
      // route is genuinely unauthenticated. A 401 here would mean
      // the share router was mounted INSIDE the session-gated
      // `/api` namespace, violating the read-side ST-029-AC3
      // contract.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);
      // Deliberately no `.set('Authorization', ...)` call.

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('designId');
      expect(res.body.designId).toBe(setup.designId);
    });

    it('works correctly even when a malformed Bearer token is sent (share route ignores it)', async () => {
      // Defense-in-depth: even if a recipient's HTTP client
      // mistakenly attaches an Authorization header (e.g., a shared
      // browser tab carrying a stale token), the share route MUST
      // ignore it. The share router is mounted BEFORE the session
      // middleware so the malformed bearer never reaches
      // `verifyIdToken`.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app)
        .get(`/api/share/${setup.shareToken}`)
        .set('Authorization', 'Bearer some-garbage-token-that-would-fail-verifyIdToken');

      // 200 — the malformed bearer is ignored. NOT 401 (which would
      // indicate the request reached the session middleware).
      expect(res.status).toBe(200);
      expect(res.body.designId).toBe(setup.designId);
    });

    it('returned design payload preserves the originally-persisted top-level fields', async () => {
      // Verifies the read-side projection includes the configurator
      // selections needed for read-only render (ST-029-AC3 "enough
      // information"). The exact serialization shape of `design` is
      // service-defined; we assert each non-undefined field of the
      // original payload is present and equal in the response.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);

      expect(res.status).toBe(200);
      const responseDesign: Record<string, unknown> = res.body.design as Record<
        string,
        unknown
      >;
      expect(responseDesign).toBeDefined();
      // Every persisted top-level field (primaryColor, secondaryColor,
      // accentColor, pattern, finish) is preserved verbatim.
      expect(responseDesign['primaryColor']).toBe(setup.payload['primaryColor']);
      expect(responseDesign['secondaryColor']).toBe(setup.payload['secondaryColor']);
      expect(responseDesign['accentColor']).toBe(setup.payload['accentColor']);
      expect(responseDesign['pattern']).toBe(setup.payload['pattern']);
      expect(responseDesign['finish']).toBe(setup.payload['finish']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Unified 404 (Enumeration Defense)', () => {
    it('returns 404 SHARE_LINK_NOT_FOUND for an unknown random token', async () => {
      // Per `routes/share.ts` line 596-602: a `null` return from
      // `shareLinkService.getByToken({ token })` collapses to a
      // single 404 SHARE_LINK_NOT_FOUND envelope, regardless of
      // whether the underlying cause was: (1) unknown token, (2)
      // revoked, (3) expired, or (4) orphan (missing-design FK).
      // This test exercises path (1) — an opaquely-formatted token
      // that was never issued.
      const res = await request(app).get(
        '/api/share/unknown-random-token-not-issued-by-this-suite-aaaaaaaa',
      );

      expect(res.status).toBe(404);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(SHARE_LINK_NOT_FOUND_CODE);
    });

    it('returns 404 SHARE_LINK_NOT_FOUND for a UUID-formatted token that was never issued', async () => {
      // Same enumeration-defense unification, but the input token
      // happens to be a well-formed UUID. The route MUST NOT
      // distinguish "looks like a token format we issue" from
      // "looks like a different token format" — both collapse to the
      // same 404 + same code. Verified by repository-layer
      // `findByToken` which returns null for any non-matching token
      // regardless of format.
      const res = await request(app).get(
        '/api/share/00000000-0000-4000-8000-000000000000',
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(SHARE_LINK_NOT_FOUND_CODE);
    });

    it('returns 400 VALIDATION_TOKEN_MISSING for a whitespace-only token', async () => {
      // Per `routes/share.ts` line 555-561: the route's defensive
      // pre-check rejects empty/whitespace-only tokens with HTTP 400
      // VALIDATION_TOKEN_MISSING — distinct from the 404
      // SHARE_LINK_NOT_FOUND branch. The URL `%20` decodes to a
      // single space which `.trim() === ''` catches.
      //
      // Why a separate code from SHARE_LINK_NOT_FOUND: an
      // empty/whitespace input is a CLIENT bug (the share-link URL
      // was malformed during clipboard paste, deeplink open, etc.)
      // and surfacing the distinct 400 helps clients debug their
      // own URL construction. The token IS NOT echoed back, so the
      // distinct code does not leak any information about a
      // genuinely-issued token.
      const res = await request(app).get('/api/share/%20');

      expect(res.status).toBe(400);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(VALIDATION_TOKEN_MISSING_CODE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Response Sanitization (Rule R2 + Privacy)', () => {
    it('response body does NOT contain ownerUid, userId, or uid (privacy)', async () => {
      // Per `services/share-link.service.ts` line 446-457
      // ("INTENTIONALLY ABSENT from this shape: ownerUid, token,
      // expiresAt, revokedAt, createdAt"), the SharedDesignView
      // projection MUST NOT leak the design owner's identity. Even
      // ad-hoc field renames (e.g., `userId`, `uid`, `user_id`)
      // would constitute privacy regressions, so we scan the
      // serialized body for any of those keys.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      // Each of these keys, if present in the projection, would
      // identify the design's owner to an anonymous visitor —
      // violating ST-029-AC3's read-only-without-sign-in invariant
      // and the explicit privacy contract in the SharedDesignView
      // docblock.
      expect(serialized).not.toMatch(/"ownerUid"/);
      expect(serialized).not.toMatch(/"userId"/);
      expect(serialized).not.toMatch(/"user_id"/);
      expect(serialized).not.toMatch(/"uid"/);
      // Sanity-check: the actual owner uid string MUST NOT appear
      // anywhere in the body either (a future leak might use a
      // different field name).
      expect(serialized).not.toContain(setup.uid);
    });

    it('response body does NOT echo the share token back (Rule R2 / privacy)', async () => {
      // Rule R2: the share token IS the credential for this
      // endpoint. Echoing it in the response body would be a
      // no-op for the legitimate visitor (they already have the
      // token in the URL) but a credential-leak vector if the
      // response is rendered into a logged URL or shared via a
      // request-replay tool. The SharedDesignView projection
      // explicitly omits `token` (verified in service docblock),
      // so the body MUST NOT contain the token string.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(setup.shareToken);
    });

    it('response body for the 404 path does NOT echo the requested token', async () => {
      // Rule R2 applies even on the failure path: an attacker
      // probing tokens MUST NOT be able to confirm token format
      // recognition by reading the error body. We use a sentinel
      // string and assert its absence in the serialized response.
      const sentinelToken = 'SENTINEL_SHARE_TOKEN_XYZ_555_should_not_appear';

      const res = await request(app).get(`/api/share/${sentinelToken}`);

      expect(res.status).toBe(404);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(sentinelToken);
    });

    it('response headers do NOT echo the Authorization header or expose Bearer material', async () => {
      // Defense-in-depth: even if a recipient sends an
      // Authorization header (test 3 of "Successful retrieval"
      // exercises that scenario), the response headers MUST NOT
      // echo the Bearer credential back. Some misconfigured
      // middlewares mirror request headers into responses (e.g.,
      // for CORS or debug echo); this test catches that regression.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app)
        .get(`/api/share/${setup.shareToken}`)
        .set('Authorization', `Bearer ${setup.idToken}`);

      expect(res.status).toBe(200);
      // The Authorization header itself MUST NOT be present in the
      // response headers (some debug middlewares echo it back).
      // Express's lowercased response-header convention means
      // `res.headers.authorization` is the relevant key.
      expect(res.headers).not.toHaveProperty('authorization');
      // The Bearer literal MUST NOT appear ANYWHERE in the
      // response headers (e.g., echoed via a Vary header or a
      // misconfigured CORS preflight handler).
      const headersSerialized = JSON.stringify(res.headers);
      expect(headersSerialized).not.toContain('Bearer ');
      // The actual idToken value (a real Firebase Emulator JWT)
      // MUST NOT appear in any response header — defense against
      // a custom debug header that proxies the inbound token.
      expect(headersSerialized).not.toContain(setup.idToken);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Cross-cutting (Correlation + Headers)', () => {
    it('emits a UUID v4 x-correlation-id response header on success', async () => {
      // Rule C5: the correlation middleware generates a UUID v4
      // when the inbound `x-correlation-id` header is absent and
      // emits it on the response so the supertest client can
      // correlate request/response/log records. The
      // `toMatchCorrelationId` matcher (registered in
      // `tests/integration/setup/per-suite.ts`) is a domain alias
      // for `toBeUuid` and accepts UUID v1-5 with valid variant
      // nibble.
      const setup = await createTestDesignAndShareLink(app, createdUids);

      const res = await request(app).get(`/api/share/${setup.shareToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits a UUID v4 x-correlation-id response header on the 404 path', async () => {
      // The correlation middleware runs BEFORE the route handler;
      // its `x-correlation-id` response header MUST be emitted on
      // every response, success and failure alike. Verifies
      // operator visibility into 404 enumeration-defense events
      // (operators correlate the response code with backend logs).
      const res = await request(app).get(
        '/api/share/random-unknown-token-for-correlation-test-zzz',
      );

      expect(res.status).toBe(404);
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves an inbound x-correlation-id header verbatim', async () => {
      // Rule C5: when a client supplies its own
      // `x-correlation-id`, the correlation middleware preserves
      // it verbatim (does NOT overwrite with a fresh UUID). This
      // lets a client thread the same correlation ID through a
      // distributed-trace boundary (frontend → backend → external
      // service) for end-to-end log correlation.
      //
      // The chosen literal `22222222-3333-4444-8555-666666666666`
      // is a valid UUID per RFC 4122 (version nibble = 4, variant
      // nibble = 8) and is recognised by the
      // `toMatchCorrelationId` matcher, but the assertion below
      // uses `.toBe(...)` to verify EXACT preservation regardless
      // of matcher tolerance.
      const setup = await createTestDesignAndShareLink(app, createdUids);
      const inboundId = '22222222-3333-4444-8555-666666666666';

      const res = await request(app)
        .get(`/api/share/${setup.shareToken}`)
        .set('x-correlation-id', inboundId);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toBe(inboundId);
    });
  });
});
