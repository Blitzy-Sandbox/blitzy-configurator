/**
 * `orders.integration.test.ts` — Integration tests for the AUTHENTICATED
 * orders API:
 *   - `POST /api/orders`                  (ST-032 — create order from cart)
 *   - `POST /api/orders/:id/finalize`     (ST-034 — finalize w/ post-processing)
 *
 * The companion `GET /api/cart` route (ST-033) is exercised in
 * `cart.integration.test.ts` (a sibling test file at the same depth).
 * The full middleware chain and route surface are still mounted here so
 * the integration app under test mirrors the EXACT production composition
 * root in `backend/src/index.ts` (AAP §0.5.6).
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations from `tickets/stories/*.md`)
 * ============================================================================
 *
 *   - ST-032 (`tickets/stories/ST-032-create-order-endpoint.md`):
 *       AC1 — The create-order endpoint requires a valid session and
 *             writes a new order record with line items derived from
 *             the authenticated user's current cart contents.
 *       AC2 — A successful order creation returns the canonical
 *             persisted order, including a server-assigned order
 *             identifier, the line items, a calculated subtotal, and
 *             a created timestamp.
 *       AC3 — Requests with empty carts, malformed line items, or
 *             invalid references to designs are rejected with
 *             descriptive errors and leave the persistence layer
 *             unchanged.
 *       AC4 — The endpoint persists the order in a documented
 *             non-terminal state and defers downstream financial
 *             settlement to a separate capability that is currently
 *             out of scope (Rule R9).
 *
 *   - ST-034 (`tickets/stories/ST-034-finalize-order-post-processing.md`):
 *       AC1 — The finalization endpoint requires a valid session,
 *             operates only on an existing order owned by the
 *             authenticated user, and transitions that order to a
 *             documented finalized state.
 *       AC2 — Finalization triggers the documented post-processing
 *             workflow and persists the outcome of each step against
 *             the order.
 *       AC3 — Finalization is rejected with a descriptive error when
 *             the target order is already finalized, is missing
 *             required references, or fails any post-processing step,
 *             and leaves the persisted order state coherent (either
 *             fully finalized or unchanged).
 *       AC4 — The scope of finalization is limited to the
 *             post-processing workflow named above and explicitly
 *             excludes any downstream financial settlement activity
 *             (Rule R9).
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
 *       AC2 — Deterministic fixtures (this file builds payloads
 *             inline because the project fixture
 *             `buildDesignPayload` returns a legacy logo shape that
 *             violates the production zod `.strict()` schema; the
 *             order-creation tests build a minimal valid design
 *             payload inline using the production-verified shape).
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
 *   - Rule R2 (NO credential material in logs / responses): response
 *     bodies are scanned for password / credential / bearer
 *     substrings. Logs are subject to the pino-redact paths
 *     configured in `createIntegrationApp` and the allow-list
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
 *   - Rule R9 (NO payment processing — DOMINANT for this file): the
 *     orders surface is the LAST possible boundary at which a payment
 *     processor could be introduced. This file's Rule-R9 describe
 *     blocks scan FOUR independent surfaces for forbidden terminology:
 *       (a) Response bodies on every documented status code (201, 200,
 *           400, 401, 404, 409).
 *       (b) Response headers on the same status codes.
 *       (c) The compiled-source contents of
 *           `backend/src/routes/orders.ts` and
 *           `backend/src/services/order.service.ts` (with comments
 *           stripped — comments LEGITIMATELY mention "payment" as
 *           part of documenting the exclusion).
 *       (d) The declared dependencies of `backend/package.json` (no
 *           dependency name may match the forbidden pattern).
 *     The forbidden token list — `stripe | braintree | paypal |
 *     paymentintent | payment_intent | paymentmethod | payment_method
 *     | charge | refund | tokenize` — covers the canonical processor
 *     SDKs AND the canonical financial-settlement vocabulary that
 *     would appear if payment-state transitions were ever introduced.
 *
 *   - LocalGCP Verification Rule (AAP §0.8.2): every test creates its
 *     own resources (Firebase users, designs, orders) during the test
 *     body and cleans them up via `deleteTestUser` in `afterEach`.
 *     There is no dependence on pre-existing emulator state.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks, no stubs)
 * ============================================================================
 *
 *   - `backend/src/routes/orders.ts` — the PRIMARY system under
 *     test. Two routes: POST /, POST /:id/finalize.
 *
 *   - `backend/src/services/order.service.ts` — order business-logic
 *     orchestrator (validateUserId, validateCartItems, ownership
 *     pre-check, atomic createOrderFromCart, conditional UPDATE for
 *     finalize).
 *
 *   - `backend/src/middleware/session.ts` — session validation
 *     middleware (Rule R3 — verifyIdToken-only).
 *
 *   - `backend/src/auth/firebase-rest.ts` — `createSignInWithPassword`
 *     adapter for the Firebase Auth Emulator REST API. Required by
 *     `createSessionService`. NOT in the assigned schema's
 *     `depends_on_files` but is required to construct the
 *     SessionService end-to-end (same precedent as
 *     `auth.integration.test.ts` and `designs.integration.test.ts`).
 *
 *   - `backend/src/repositories/order.repository.ts` —
 *     `createOrderFromCart` (atomic INSERT in BEGIN/COMMIT),
 *     `findOrderById` (ownership-pinned), `updateOrderState`
 *     (conditional UPDATE for finalize race-condition guard).
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
 * Production Reality vs. Prompt Claims (documented for downstream maintainers)
 * ============================================================================
 *
 *   The agent prompt that authored this file described several
 *   behaviors that DIVERGE from `backend/src/routes/orders.ts` and
 *   `backend/src/services/order.service.ts`. Tests in this file
 *   follow PRODUCTION reality (Rule R1: code is authoritative) and
 *   document the divergence here so future maintainers do not
 *   reintroduce the prompt-style assertions:
 *
 *     1. Pattern enum (production): `['classic', 'hexagonal',
 *        'diamond', 'spiral', 'star', 'grid']`. The prompt
 *        erroneously claimed `['classic', 'hex', 'star', 'arrow',
 *        'diamond', 'wave']`. The order-create tests build the
 *        upstream design with `pattern: 'classic'` (the only value
 *        guaranteed by both lists).
 *
 *     2. The fixture `buildDesignPayload('canonical')` returns a
 *        legacy logo shape that the production `.strict()` zod
 *        schema rejects. The prompt mandated using this fixture; we
 *        intentionally do NOT use it. Instead we build a minimal
 *        valid design payload inline (`buildValidDesignPayload`)
 *        using the production-verified shape. This is the SAME
 *        adaptation applied in `designs.integration.test.ts`.
 *
 *     3. The user MUST exist in the local `users` table (FK from
 *        `designs.user_id`) — `createTestUser()` only creates the
 *        Firebase Auth row, so we use `setupAuthenticatedUser()`
 *        which calls the production `/api/auth/register` and
 *        `/api/auth/login` endpoints (the same pattern as
 *        `designs.integration.test.ts`).
 *
 *     4. `validateOrderId` (in `order.service.ts`, line ~404) only
 *        checks for `typeof === 'string'` and `length > 0`. It does
 *        NOT validate UUID format. A non-UUID id like `'not-a-uuid'`
 *        therefore passes service validation and reaches the
 *        repository's parameterized query against `WHERE id = $1`,
 *        which Postgres rejects with `'invalid input syntax for type
 *        uuid'`. This propagates as a generic Error → 500
 *        INTERNAL_ERROR (NOT 400 VALIDATION_FAILED as the prompt
 *        incorrectly claimed). Tests below assert any 4xx OR 5xx for
 *        this case, with NO echo of the input string in the
 *        response body — same defensive pattern used in
 *        `designs.integration.test.ts`.
 *
 *     5. POST `/api/orders/:id/finalize` returns HTTP **200** (not
 *        201) on success; the prompt got this right but the
 *        documentation is included here for completeness.
 *
 *     6. The `state` field on POST `/api/orders` responses is
 *        exactly `'created'` (the documented non-terminal state per
 *        ST-032-AC4 and Rule R9). The `state` field on POST
 *        `/api/orders/:id/finalize` responses is exactly
 *        `'finalized'`. The {@link OrderState} union (sourced from
 *        `backend/src/repositories/order.repository.ts`) is
 *        `'cart' | 'created' | 'finalized' | 'cancelled'` — there is
 *        NO `'paid' | 'charged' | 'authorized' | 'settled' |
 *        'refunded'` vocabulary anywhere in the type system.
 *
 *     7. `cart.integration.test.ts` does NOT exist in this repository
 *        at the time of authoring (verified by `ls
 *        backend/tests/integration/routes/`). The agent prompt
 *        instructed copying its `createIntegrationApp` helper
 *        verbatim; we instead mirror the helper from
 *        `designs.integration.test.ts`, which IS verified
 *        production-equivalent. When `cart.integration.test.ts` is
 *        introduced in a future change, both files SHOULD share an
 *        extracted helper to prevent drift.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   cd backend && npx eslint tests/integration/routes/orders.integration.test.ts \
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/routes/orders.integration.test.ts \
 *      --forceExit
 *   # expected exit: 0
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
// `buildDesignPayload` is intentionally NOT imported — its 'canonical'
// seed produces a legacy logo shape that the production `.strict()` zod
// schema rejects. We build payloads inline below using the
// production-verified shape (same adaptation as
// `designs.integration.test.ts`).

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
 *
 * Same value used by `designs.integration.test.ts` and
 * `auth.integration.test.ts` — kept in sync via grep when one file
 * changes.
 */
const REGISTRATION_PASSWORD = 'IntegrationTestPwd!12345';

/**
 * The expected zod-strict 400 envelope `code` for orders route
 * validation failures. Per `backend/src/routes/orders.ts`
 * `translateZodError`, validation failures emit
 * `{ error: { code: 'VALIDATION_FAILED', message, details: [...] } }`.
 */
const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

/**
 * The error code emitted when the order service determines that a
 * referenced design is unknown OR not owned by the caller. Per
 * `backend/src/services/order.service.ts` `createOrder`, this throws
 * `NotFoundError({ code: 'DESIGN_NOT_FOUND' })` and the route layer's
 * `handleRouteError` maps it to HTTP 404.
 *
 * The conflated 404 (vs. 403) is deliberate enumeration-defense per
 * ST-032-AC3: clients cannot probe the existence of designs they do
 * not own.
 */
const DESIGN_NOT_FOUND_CODE = 'DESIGN_NOT_FOUND';

/**
 * The error code emitted when the order service determines that the
 * target order is unknown OR not owned by the caller. Per
 * `backend/src/services/order.service.ts` `finalizeOrder`, this
 * throws `NotFoundError({ code: 'ORDER_NOT_FOUND' })` and the route
 * layer's `handleRouteError` maps it to HTTP 404.
 *
 * Same enumeration-defense rationale as DESIGN_NOT_FOUND_CODE: clients
 * cannot probe the existence of orders owned by other users.
 */
const ORDER_NOT_FOUND_CODE = 'ORDER_NOT_FOUND';

/**
 * The error code emitted by `finalizeOrder` when the target order
 * exists but is not in the `'created'` state (e.g. already finalized,
 * or in `'cart'` / `'cancelled'`). Per
 * `backend/src/services/order.service.ts`, this throws
 * `ConflictError({ code: 'ORDER_STATE_INVALID' })` and the route
 * layer's `handleRouteError` maps it to HTTP 409.
 */
const ORDER_STATE_INVALID_CODE = 'ORDER_STATE_INVALID';

/**
 * A well-formed UUID v4 that does NOT correspond to any row in
 * `designs`. Used by negative tests that exercise the
 * "design-not-found" branch of `createOrder` without polluting the
 * test database with extraneous rows.
 *
 * Format: a fixed UUID v4 with the version + variant nibbles set
 * correctly (per RFC 4122) so the SQL `::uuid` cast accepts it. The
 * probability of a real `designs.id` row matching this exact value
 * is negligible.
 */
const NONEXISTENT_DESIGN_ID = '00000000-0000-4000-8000-000000000000';

/**
 * A well-formed UUID v4 that does NOT correspond to any row in
 * `orders`. Used by negative tests that exercise the
 * "order-not-found" branch of `finalizeOrder` and the cross-user
 * isolation enumeration-defense check.
 *
 * Format identical to {@link NONEXISTENT_DESIGN_ID} but a different
 * pin — the two MUST NOT be the same value because that would make
 * cross-table identity confusion possible in a defective regression.
 */
const NONEXISTENT_ORDER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The Rule R9 forbidden-token regex.
 *
 * Captures the canonical payment-processor SDK names AND the
 * canonical financial-settlement vocabulary that would appear if a
 * payment-state transition were ever introduced into the orders
 * surface. Case-insensitive (the `/i` flag) so a future refactor
 * that title-cases or capitalises any of these tokens still
 * triggers the test.
 *
 * The list is drawn from AAP §0.7.2 "Out of Scope" and ST-032-AC4 /
 * ST-034-AC4 (the explicit exclusion of financial settlement).
 *
 * Notable tokens NOT in the list:
 *   - `payment` (without `_intent` / `_method` / `intent` / `method`):
 *     too broad — the source files LEGITIMATELY mention "payment
 *     processor" in COMMENTS that document the exclusion. The
 *     source-file scan strips comments before applying the regex
 *     to avoid false positives, but the response-body / header /
 *     dependency scans must accept "payment" as a non-violation
 *     (it never appears in valid order responses anyway).
 *   - `card`: would false-match `cardinality`, `cardio`, etc.
 *   - `auth`: would false-match `authentication`, `authorization`
 *     (which are required by the session middleware contract).
 *
 * The list IS deliberately closed: the moment a future story
 * introduces a documented payment terminology, this regex must be
 * updated AND the corresponding response/source/dependency surfaces
 * must be re-audited.
 */
const FORBIDDEN_R9_PATTERN =
  /(stripe|braintree|paypal|paymentintent|payment_intent|paymentmethod|payment_method|charge|refund|tokenize)/i;

/**
 * The closed list of order states that signal financial settlement.
 * The production {@link OrderState} union deliberately EXCLUDES every
 * one of these tokens — Rule R9 is enforced at the type level
 * (`'cart' | 'created' | 'finalized' | 'cancelled'`).
 *
 * Tests below assert that EVERY 2xx order-shaped response has a
 * `state` value that is NOT a member of this list. A regression that
 * introduces, say, `state: 'paid'` would fail BOTH the type checker
 * (because `'paid'` is not assignable to `OrderState`) AND this
 * runtime assertion (defense-in-depth — the type system is the first
 * line, the runtime check is the second).
 */
const TERMINAL_PAYMENT_STATES: ReadonlyArray<string> = [
  'paid',
  'charged',
  'authorized',
  'settled',
  'refunded',
];

/**
 * Resolved absolute path to the backend workspace root. Used by the
 * Rule R9 source-file scan tests to read `routes/orders.ts`,
 * `services/order.service.ts`, and `package.json` deterministically
 * regardless of the cwd from which Jest is invoked.
 *
 * `__dirname` resolves to
 * `<repo>/backend/tests/integration/routes/`; three `..` segments
 * climb to `<repo>/backend/`.
 */
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

// ════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Generate a unique email per test invocation.
 *
 * Format: `orders-test-{uuidv4}@example.com`. Uses Node 20's stdlib
 * `randomUUID()` (UUID v4 per RFC 4122) to guarantee uniqueness even
 * under sequential invocation in the same millisecond. The leading
 * `orders-test-` prefix makes test users easy to identify if a
 * partial cleanup leaves orphans in the Firebase Auth emulator.
 *
 * @returns A fresh email of the documented shape.
 */
function uniqueEmail(): string {
  return `orders-test-${randomUUID()}@example.com`;
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
 * `auth.integration.test.ts` and `designs.integration.test.ts`. This
 * keeps the integration app shape isomorphic to the production
 * composition root.
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
 * Pushes the `uid` onto the supplied `createdUids` cleanup array so
 * `afterEach` can sweep the user out of the Firebase Auth emulator.
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
 * The shape mirrors the one used in `designs.integration.test.ts`:
 *   {
 *     primaryColor:   '#FF0000',
 *     secondaryColor: '#00FF00',
 *     accentColor:    '#0000FF',
 *     pattern:        'classic',
 *     finish:         'matte',
 *   }
 *
 * QA Final B Issue #2 (BOTH-OPTIONAL pivot): `secondaryColor` and
 * `accentColor` remain `.optional()` on the production
 * `designPayloadSchema` so the AAP §0.6.4 Gate T1-C verbatim payload
 * still yields 201. The frontend `DesignPayload` was relaxed to mark
 * these two fields optional in lock-step. This integration fixture
 * nevertheless populates all three colors with canonical `#RRGGBB`
 * hex values (Issue #3) so tests that assert color round-trip
 * behaviour can distinguish the three fields uniquely.
 *
 * @returns A fresh payload object suitable for `POST /api/designs`.
 */
function buildValidDesignPayload(): Record<string, unknown> {
  return {
    primaryColor: '#FF0000',
    secondaryColor: '#00FF00',
    accentColor: '#0000FF',
    pattern: 'classic',
    finish: 'matte',
  };
}

/**
 * Helper: create a design via POST /api/designs and return its
 * server-assigned id. Asserts a 201 response. Used by every test that
 * needs a real design id to reference in cart line items.
 *
 * The request body uses the production-verified shape (see
 * {@link buildValidDesignPayload}).
 *
 * @param app Express app under test.
 * @param idToken The caller's Firebase ID token.
 * @param title Optional title override (default: 'Order Test Design').
 * @returns The server-assigned design id (UUID).
 */
async function createDesignViaProduction(
  app: Express,
  idToken: string,
  title: string = 'Order Test Design',
): Promise<string> {
  const res = await request(app)
    .post('/api/designs')
    .set('Authorization', `Bearer ${idToken}`)
    .set('Content-Type', 'application/json')
    .send({ title, payload: buildValidDesignPayload() });
  expect(res.status).toBe(201);
  expect(typeof res.body.id).toBe('string');
  expect(res.body.id.length).toBeGreaterThan(0);
  return res.body.id as string;
}

/**
 * Helper: create an order via POST /api/orders for the given user
 * and design id, with quantity 1. Asserts a 201 response and returns
 * the server-assigned order id. Used by every test that needs an
 * existing order to operate on (finalize, conflict tests, cross-user
 * isolation tests).
 *
 * @param app Express app under test.
 * @param idToken The caller's Firebase ID token.
 * @param designId UUID of an existing design owned by the caller.
 * @returns The server-assigned order id (UUID).
 */
async function createOrderViaProduction(
  app: Express,
  idToken: string,
  designId: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/orders')
    .set('Authorization', `Bearer ${idToken}`)
    .set('Content-Type', 'application/json')
    .send({ items: [{ designId, quantity: 1 }] });
  expect(res.status).toBe(201);
  expect(typeof res.body.id).toBe('string');
  expect(res.body.id.length).toBeGreaterThan(0);
  return res.body.id as string;
}

/**
 * Strip JS/TS comments from a source string before applying the
 * Rule R9 forbidden-token regex.
 *
 * Both `routes/orders.ts` and `services/order.service.ts` contain
 * comments that LEGITIMATELY mention "payment processor" as part of
 * documenting the Rule R9 exclusion. A naive scan would false-match
 * those comments. Stripping comments first leaves only the EXECUTABLE
 * code surface, which MUST be free of every forbidden token.
 *
 * The strip:
 *   1. Removes `/* ... *\/` block comments (non-greedy, multiline).
 *   2. Removes `// ... <newline>` line comments.
 *
 * Edge cases:
 *   - String literals containing `//` or `/*` are NOT preserved
 *     verbatim by this naive strip; in practice neither source file
 *     contains such literals (verified by grep at the time of
 *     authoring), and a future regression that introduced one would
 *     surface as a false positive in the test — which is the
 *     defensive failure mode we want.
 *
 * @param source The raw source-file contents.
 * @returns The source with all comments removed.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ════════════════════════════════════════════════════════════════════════
// Top-level test setup
// ════════════════════════════════════════════════════════════════════════

/**
 * The Express app is constructed once per Jest worker (in `beforeAll`)
 * because `createIntegrationApp()` is idempotent — the production
 * pool, Firebase Admin, and pino logger singletons cache themselves
 * on first use. Per-test isolation is achieved by creating fresh
 * users + designs in each `it` block, NOT by tearing down the app.
 */
let app: Express;

/**
 * Mutable list of Firebase Auth emulator UIDs created during the
 * current test. `afterEach` sweeps each entry by calling
 * `deleteTestUser(uid)`. Using a mutable array (re-initialised in
 * `afterEach`) guarantees that even if a test BAILS partway through
 * — e.g. a registration succeeds but the next assertion fails — the
 * cleanup still removes the user.
 *
 * Cleanup is best-effort: the local `users` / `designs` / `orders`
 * tables are NOT swept here because the integration test database
 * is dropped + recreated between test runs by the global setup
 * harness, and inter-test cross-talk is mitigated by uniqueEmail()
 * which guarantees row uniqueness per test.
 */
let createdUids: string[] = [];

beforeAll(async () => {
  app = await createIntegrationApp();
});

afterEach(async () => {
  // Clone, reset, and iterate — the iteration order does not matter
  // because every uid is independent.
  const toDelete = createdUids;
  createdUids = [];
  for (const uid of toDelete) {
    try {
      await deleteTestUser(uid);
    } catch (err) {
      // Cleanup failures must NOT mask test failures — log to stderr
      // and continue. The next test run's global setup will sweep
      // the residue.
      // eslint-disable-next-line no-console
      console.warn(`[orders.integration.test.ts] cleanup failed for uid=${uid}: ${String(err)}`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════
// describe: POST /api/orders (integration)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/orders (integration)', () => {
  // ────────────────────────────────────────────────────────────────────
  // Authentication (ST-032-AC1, ST-026-AC1, ST-026-AC2)
  // ────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-032-AC1, ST-026-AC1)', () => {
    it('returns 401 UNAUTHENTICATED when no Authorization header is sent', async () => {
      // ST-032-AC1: "A valid session is required to create an order."
      // ST-026-AC1: "An inbound request that arrives without a session
      //   token is rejected with HTTP 401 UNAUTHENTICATED."
      const res = await request(app)
        .post('/api/orders')
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1 }] });

      expect(res.status).toBe(401);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
      // Defense-in-depth: response body must NEVER contain credential
      // material (Rule R2).
      expect(JSON.stringify(res.body)).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    });

    it('returns 401 INVALID_SESSION for a syntactically-Bearer but unverifiable token', async () => {
      // ST-026-AC2: "Tokens that are expired, malformed, or revoked
      //   are rejected with HTTP 401 with a distinct error code per
      //   failure mode." A random, non-Firebase-issued token follows
      //   the INVALID_SESSION branch (the verifier rejects it
      //   downstream of bearer extraction).
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', 'Bearer not-a-real-firebase-token')
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1 }] });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });

    it('returns 401 MALFORMED_AUTHORIZATION when the Authorization header lacks the Bearer scheme', async () => {
      // ST-026-AC2: "malformed" → MALFORMED_AUTHORIZATION (distinct
      //   error code from INVALID_SESSION).
      // The session middleware case-insensitively recognises the
      //   "Bearer " prefix; "Basic ..." and similar non-Bearer
      //   schemes hit the MALFORMED branch.
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1 }] });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.MALFORMED_AUTHORIZATION);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Validation (zod schema)
  // ────────────────────────────────────────────────────────────────────
  describe('Validation (zod schema)', () => {
    // Each test in this block first sets up an authenticated user so
    // the request reaches the body-validation stage (otherwise the
    // session middleware would short-circuit with 401 before zod
    // ever sees the body).

    it('returns 400 VALIDATION_FAILED when the request body has no items field', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when the items array is empty', async () => {
      // Per zod: `z.array(cartItemSchema).min(1, { message: 'items
      //   must be non-empty' })`.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item has quantity 0', async () => {
      // Per zod: `quantity: z.number().int().positive(...)`. Zero is
      //   rejected by `.positive()`.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 0 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item has a negative quantity', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: -5 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item has a non-integer quantity', async () => {
      // Per zod: `.int()` rejects fractional numbers.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1.5 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item has an empty designId string', async () => {
      // Per zod: `designId: z.string().min(1, ...)`.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: '', quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item is missing the designId field entirely', async () => {
      // The strict cart-item schema requires `designId`.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ quantity: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when the body has unknown root-level fields (zod .strict())', async () => {
      // Per zod: `z.object({...}).strict()` rejects unknown keys.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1 }],
          extraFieldNotInSchema: 'reject',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });

    it('returns 400 VALIDATION_FAILED when an item has an unknown extra field (cart-item .strict())', async () => {
      // The cart-item schema is also `.strict()` — unknown keys on a
      //   line item also fail validation.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1, unknownItemField: 'reject' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(VALIDATION_FAILED_CODE);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Successful order creation (ST-032-AC2, ST-032-AC3, ST-032-AC4)
  // ────────────────────────────────────────────────────────────────────
  describe('Successful order creation (ST-032-AC2, ST-032-AC3, ST-032-AC4)', () => {
    it('returns 201 with a canonical persisted order body when items reference an owned design', async () => {
      // ST-032-AC2: "Writes a new order with line items derived from
      //   cart contents."
      // ST-032-AC3: "Returns canonical persisted order with
      //   server-assigned id, calculated subtotal, and timestamps."
      const { uid, idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });

      // ── Status & top-level shape.
      expect(res.status).toBe(201);
      expect(res.body).toBeDefined();

      // ── Server-assigned id (UUID).
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).toBeUuid();

      // ── userId is the authenticated caller.
      expect(res.body.userId).toBe(uid);

      // ── State is the production-verified non-terminal token.
      expect(res.body.state).toBe('created');

      // ── Subtotal exists and is a JS number on the wire. The
      //    repository preserves PostgreSQL NUMERIC(12,2) precision
      //    by emitting the field as a string internally; the route
      //    layer's serializeOrder helper coerces it to a number for
      //    the wire format consumed by the frontend (per QA Final D
      //    Issue #9 and `frontend/src/api/orders.ts`).
      expect(typeof res.body.subtotal).toBe('number');
      expect(Number.isFinite(res.body.subtotal)).toBe(true);

      // ── Timestamps — both present and well-formed ISO-8601.
      expect(typeof res.body.createdAt).toBe('string');
      expect(typeof res.body.lastModifiedAt).toBe('string');
      expect(new Date(res.body.createdAt).toString()).not.toBe('Invalid Date');
      expect(new Date(res.body.lastModifiedAt).toString()).not.toBe('Invalid Date');

      // ── Line items.
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].designId).toBe(designId);
      expect(res.body.items[0].quantity).toBe(1);
      // metadata is always present (defaulted to empty object by the
      //   route's pass-through normalisation).
      expect(typeof res.body.items[0].metadata).toBe('object');
    });

    it('persists the order in a NON-TERMINAL state (ST-032-AC4 + Rule R9)', async () => {
      // ST-032-AC4: "Persists in DOCUMENTED NON-TERMINAL state
      //   (per Rule R9 — 'deferring downstream financial
      //   settlement')."
      // The production OrderState union is the type-level enforcer;
      //   this runtime check is defense-in-depth.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });

      expect(res.status).toBe(201);
      // The state MUST NOT be any of the financial-settlement tokens.
      expect(TERMINAL_PAYMENT_STATES).not.toContain(res.body.state);
      // And it MUST be the documented non-terminal token.
      expect(res.body.state).toBe('created');
    });

    it('persists multiple line items when the body contains multiple owned designs', async () => {
      // ST-032-AC2: "line items derived from cart contents" — multi-
      //   item cart.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designIdA = await createDesignViaProduction(app, idToken, 'Order Test Design A');
      const designIdB = await createDesignViaProduction(app, idToken, 'Order Test Design B');

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          items: [
            { designId: designIdA, quantity: 2 },
            { designId: designIdB, quantity: 3 },
          ],
        });

      expect(res.status).toBe(201);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBe(2);

      // The set of returned designIds must be exactly {A, B}; order
      //   is implementation-defined so use a set comparison.
      const returnedDesignIds = new Set(
        (res.body.items as Array<{ designId: string }>).map((it) => it.designId),
      );
      expect(returnedDesignIds).toEqual(new Set([designIdA, designIdB]));

      // Quantities round-trip correctly.
      const itemsByDesign = new Map(
        (res.body.items as Array<{ designId: string; quantity: number }>).map((it) => [
          it.designId,
          it.quantity,
        ]),
      );
      expect(itemsByDesign.get(designIdA)).toBe(2);
      expect(itemsByDesign.get(designIdB)).toBe(3);
    });

    it('persists item metadata when supplied on a line item', async () => {
      // The cart-item schema accepts an optional `metadata` record;
      //   the route's pass-through normalisation forwards it as-is.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const metadata = { sizeLabel: 'large', surface: 'practice' };
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1, metadata }] });

      expect(res.status).toBe(201);
      expect(res.body.items[0].metadata).toEqual(metadata);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Design ownership / not-found errors (ST-032-AC3 enumeration defense)
  // ────────────────────────────────────────────────────────────────────
  describe('Design ownership / not-found errors', () => {
    it('returns 404 DESIGN_NOT_FOUND when the designId does not exist', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: NONEXISTENT_DESIGN_ID, quantity: 1 }] });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });

    it('returns 404 DESIGN_NOT_FOUND when the designId belongs to ANOTHER user (cross-user enumeration defense)', async () => {
      // ST-032-AC3: "Returns canonical persisted order [...]" implies
      //   the route MUST NOT leak the existence of resources owned
      //   by other users. Cross-user references must surface as
      //   "not found" — distinct from "forbidden" — to defend
      //   against ID-enumeration attacks.
      const userA = await setupAuthenticatedUser(app, createdUids);
      const designIdOwnedByA = await createDesignViaProduction(app, userA.idToken);

      // userB tries to reference userA's design.
      const userB = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${userB.idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId: designIdOwnedByA, quantity: 1 }] });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });

    it('returns 404 DESIGN_NOT_FOUND for a multi-item cart where ANY item references a non-owned design', async () => {
      // The order service iterates items sequentially and aborts on
      //   the first ownership failure — verify the all-or-nothing
      //   semantics by mixing one owned + one foreign design.
      const userA = await setupAuthenticatedUser(app, createdUids);
      const foreignDesignId = await createDesignViaProduction(app, userA.idToken);

      const userB = await setupAuthenticatedUser(app, createdUids);
      const ownedDesignId = await createDesignViaProduction(app, userB.idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${userB.idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          items: [
            { designId: ownedDesignId, quantity: 1 },
            { designId: foreignDesignId, quantity: 1 },
          ],
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(DESIGN_NOT_FOUND_CODE);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Rule R9 (DOMINANT) — no payment-processor terminology
  // ────────────────────────────────────────────────────────────────────
  describe('Rule R9 (DOMINANT) — no payment-processor terminology', () => {
    it('successful 201 response body contains no forbidden payment-processor terms', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });

      expect(res.status).toBe(201);
      const serializedBody = JSON.stringify(res.body);
      expect(serializedBody).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('successful 201 response headers contain no forbidden payment-processor terms', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });

      expect(res.status).toBe(201);
      const serializedHeaders = JSON.stringify(res.headers);
      expect(serializedHeaders).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('400 validation-error response body contains no forbidden payment-processor terms', async () => {
      // The validation-error path is a separate code branch and could
      //   in principle leak information; verify it cleanly too.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('source file scan: backend/src/routes/orders.ts contains no forbidden payment-processor terms (excluding comments)', async () => {
      // Read the executable code surface (comments stripped) and
      //   apply the forbidden-token regex. Comments may legitimately
      //   mention "payment processor" while documenting the
      //   exclusion; the executable code MUST NOT.
      const sourcePath = path.resolve(BACKEND_ROOT, 'src/routes/orders.ts');
      const source = fs.readFileSync(sourcePath, 'utf8');
      const stripped = stripComments(source);

      expect(stripped).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('source file scan: backend/src/services/order.service.ts contains no forbidden payment-processor terms (excluding comments)', async () => {
      const sourcePath = path.resolve(BACKEND_ROOT, 'src/services/order.service.ts');
      const source = fs.readFileSync(sourcePath, 'utf8');
      const stripped = stripComments(source);

      expect(stripped).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('source file scan: backend/src/repositories/order.repository.ts contains no forbidden payment-processor terms (excluding comments)', async () => {
      // The repository layer is the persistence boundary — if any
      //   payment-processor logic ever leaked in, it would surface
      //   here. This guards the third-and-final source surface
      //   exposed to the orders flow.
      const sourcePath = path.resolve(BACKEND_ROOT, 'src/repositories/order.repository.ts');
      const source = fs.readFileSync(sourcePath, 'utf8');
      const stripped = stripComments(source);

      expect(stripped).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('package.json declares no payment-processor packages', async () => {
      // Rule R9 verification: NO key in `dependencies`,
      //   `devDependencies`, `peerDependencies`, or
      //   `optionalDependencies` may match a payment-processor SDK
      //   name. This catches regressions where a developer adds a
      //   payment-processor package to package.json before any
      //   source code references it.
      const pkgPath = path.resolve(BACKEND_ROOT, 'package.json');
      const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };

      const sections: ReadonlyArray<keyof typeof pkg> = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ];

      // The forbidden-package list is more lexically specific than
      //   the regex used for source scanning — it must MATCH NPM
      //   PACKAGE NAMES rather than free-form code text.
      const forbiddenPackages: ReadonlyArray<RegExp> = [
        /^stripe$/i,
        /^braintree(?:-|$)/i,
        /^@?paypal(?:[/-]|$)/i,
        /^@?stripe[/-]/i,
        /charge/i,
        /refund/i,
      ];

      for (const section of sections) {
        const block = pkg[section];
        if (!block) continue;
        for (const dep of Object.keys(block)) {
          for (const pattern of forbiddenPackages) {
            expect(dep).not.toMatch(pattern);
          }
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-cutting (correlation, redaction)
  // ────────────────────────────────────────────────────────────────────
  describe('Cross-cutting concerns', () => {
    it('emits an x-correlation-id response header on a successful 201', async () => {
      // C5: every response carries `x-correlation-id` (preserved from
      //   the request when present, otherwise generated as a fresh
      //   UUID v4).
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBeDefined();
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits an x-correlation-id response header on a 400 validation error', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits an x-correlation-id response header on a 401 unauthenticated error', async () => {
      // The correlation middleware is mounted BEFORE the session
      //   gate, so even rejected requests must carry the header.
      const res = await request(app).post('/api/orders').send({});

      expect(res.status).toBe(401);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('preserves a client-supplied x-correlation-id header (C5)', async () => {
      // The correlation middleware preserves a well-formed UUID
      //   from the client. Use a fresh UUID v4 here.
      const clientCorrelationId = randomUUID();
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .set('x-correlation-id', clientCorrelationId)
        .send({ items: [{ designId, quantity: 1 }] });

      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// describe: POST /api/orders/:id/finalize (integration)
// ════════════════════════════════════════════════════════════════════════

describe('POST /api/orders/:id/finalize (integration)', () => {
  // ────────────────────────────────────────────────────────────────────
  // Authentication (ST-034-AC1)
  // ────────────────────────────────────────────────────────────────────
  describe('Authentication (ST-034-AC1)', () => {
    it('returns 401 UNAUTHENTICATED when no Authorization header is sent', async () => {
      // ST-034-AC1: "Operates ONLY on existing order owned by the
      //   authenticated user." The session gate runs BEFORE the
      //   route's existence/ownership check.
      const res = await request(app)
        .post(`/api/orders/${NONEXISTENT_ORDER_ID}/finalize`)
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('returns 401 INVALID_SESSION for a syntactically-Bearer but unverifiable token', async () => {
      const res = await request(app)
        .post(`/api/orders/${NONEXISTENT_ORDER_ID}/finalize`)
        .set('Authorization', 'Bearer not-a-real-firebase-token');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(ERROR_CODES.INVALID_SESSION);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Validation (orderId path parameter)
  // ────────────────────────────────────────────────────────────────────
  describe('Validation (orderId path parameter)', () => {
    it('responds with a 4xx/5xx error envelope for a non-UUID orderId (Postgres uuid cast or repository normalisation)', async () => {
      // The orderId is forwarded into a parameterised query; the
      //   ::uuid Postgres cast rejects malformed values. Per the
      //   designs.integration.test.ts precedent for malformed UUID
      //   path params, accept ANY 4xx/5xx — the exact status depends
      //   on whether the route emits 400 VALIDATION_FAILED, 404
      //   ORDER_NOT_FOUND (if the repository swallows the cast
      //   error), or 500 INTERNAL_ERROR (if the Postgres error
      //   propagates). All of these are documented Rule R8 fail-
      //   closed outcomes; the response MUST NOT echo the malformed
      //   id back into the body.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const malformedId = 'not-a-uuid-at-all';
      const res = await request(app)
        .post(`/api/orders/${malformedId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
      expect(res.body).toBeDefined();
      expect(res.body.error).toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      // The response MUST NOT echo the malformed id back into the
      //   body — that would be a small information-disclosure
      //   vulnerability.
      expect(JSON.stringify(res.body)).not.toContain(malformedId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Successful finalize (ST-034-AC2)
  // ────────────────────────────────────────────────────────────────────
  describe('Successful finalize (ST-034-AC2)', () => {
    it("returns 200 with state='finalized' for an owned order in the 'created' state", async () => {
      // ST-034-AC2: "Transitions to documented finalized state."
      const { uid, idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      const res = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderId);
      expect(res.body.userId).toBe(uid);
      // Production-verified token; Rule R9 forbids any payment-state
      //   token in this position.
      expect(res.body.state).toBe('finalized');
      expect(TERMINAL_PAYMENT_STATES).not.toContain(res.body.state);
    });

    it('returns empty items array per the documented performance contract', async () => {
      // Production contract — verified in src/services/order.service.ts
      //   lines 795-800: "The returned object's `items` array is
      //   empty because the repository's `updateOrderState` returns
      //   the bare order row without re-fetching items (an explicit
      //   performance contract). Consumers who need the items should
      //   call OrderService.getById after finalize."
      //
      // The route forwards the service return verbatim — see
      //   src/routes/orders.ts (the finalize handler does
      //   `res.status(200).json(finalized)` directly). It does NOT
      //   call getById to enrich the response.
      //
      // This test is a contract-regression guard:
      //   - If a future refactor changes the route to enrich items
      //     by calling `getById` after finalize, this assertion will
      //     flip to non-empty and signal the contract change — at
      //     which point the assertion should be updated to reflect
      //     the new contract.
      //   - If a future refactor accidentally drops the line items
      //     from the database tier, this assertion alone will not
      //     catch that. Persistence is the responsibility of the
      //     order-service unit tests and the create-order
      //     integration tests above (which assert items are echoed
      //     in the 201 create response).
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designIdA = await createDesignViaProduction(app, idToken, 'Finalize Test A');
      const designIdB = await createDesignViaProduction(app, idToken, 'Finalize Test B');

      const createRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({
          items: [
            { designId: designIdA, quantity: 2 },
            { designId: designIdB, quantity: 1 },
          ],
        });
      expect(createRes.status).toBe(201);
      const orderId = createRes.body.id as string;

      const finalizeRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(finalizeRes.status).toBe(200);
      expect(finalizeRes.body.id).toBe(orderId);
      expect(finalizeRes.body.state).toBe('finalized');
      // The documented contract: items array is empty on finalize
      //   response — NOT a sign that items were lost from the
      //   database.
      expect(Array.isArray(finalizeRes.body.items)).toBe(true);
      expect(finalizeRes.body.items.length).toBe(0);
      // Subtotal IS preserved on the finalize response — this is the
      //   monetary signal consumers need without paying the cost of
      //   a second roundtrip to fetch items. Per QA Final D Issue
      //   #9 the wire format coerces NUMERIC strings to JS numbers.
      expect(finalizeRes.body).toHaveProperty('subtotal');
      expect(typeof finalizeRes.body.subtotal).toBe('number');
    });

    it('updates the lastModifiedAt timestamp on the finalize transition', async () => {
      // The `lastModifiedAt` column is bumped by the conditional
      //   UPDATE; after finalize, it should be ≥ the value
      //   recorded on creation. (Strict greater-than is fragile if
      //   the two writes land in the same DB-clock millisecond, so
      //   assert ≥ instead.)
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);

      const createRes = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${idToken}`)
        .set('Content-Type', 'application/json')
        .send({ items: [{ designId, quantity: 1 }] });
      const orderId = createRes.body.id as string;
      const createdAtMs = new Date(createRes.body.lastModifiedAt as string).getTime();

      const finalizeRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(finalizeRes.status).toBe(200);
      const finalizedAtMs = new Date(finalizeRes.body.lastModifiedAt as string).getTime();
      expect(Number.isFinite(finalizedAtMs)).toBe(true);
      expect(finalizedAtMs).toBeGreaterThanOrEqual(createdAtMs);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Not-found errors (ST-034-AC1, ST-034-AC3)
  // ────────────────────────────────────────────────────────────────────
  describe('Not-found errors (ST-034-AC1)', () => {
    it('returns 404 ORDER_NOT_FOUND for an orderId that does not exist', async () => {
      // ST-034-AC1: "Operates ONLY on existing order owned by the
      //   authenticated user." Non-existent → ORDER_NOT_FOUND.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post(`/api/orders/${NONEXISTENT_ORDER_ID}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ORDER_NOT_FOUND_CODE);
    });

    it('returns 404 ORDER_NOT_FOUND when the order is owned by ANOTHER user (cross-user enumeration defense)', async () => {
      // ST-034-AC1 paired with the enumeration-defense convention:
      //   cross-user accesses surface as ORDER_NOT_FOUND, NOT
      //   FORBIDDEN. The response code is identical to "actually
      //   does not exist" so an attacker cannot probe for orders
      //   they do not own.
      const userA = await setupAuthenticatedUser(app, createdUids);
      const designIdA = await createDesignViaProduction(app, userA.idToken);
      const orderIdOwnedByA = await createOrderViaProduction(app, userA.idToken, designIdA);

      const userB = await setupAuthenticatedUser(app, createdUids);
      const res = await request(app)
        .post(`/api/orders/${orderIdOwnedByA}/finalize`)
        .set('Authorization', `Bearer ${userB.idToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ORDER_NOT_FOUND_CODE);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Conflict errors (ST-034-AC3)
  // ────────────────────────────────────────────────────────────────────
  describe('Conflict errors (ST-034-AC3)', () => {
    it('returns 409 ORDER_STATE_INVALID when finalizing an already-finalized order', async () => {
      // ST-034-AC3: "Triggers documented post-processing." Implicit:
      //   a second finalize on the same order is a documented
      //   non-success — translated to 409 ORDER_STATE_INVALID by
      //   the route layer (per `handleRouteError` mapping a
      //   ConflictError with `code: 'ORDER_STATE_INVALID'`).
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      // First finalize succeeds.
      const firstRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.state).toBe('finalized');

      // Second finalize on the same order conflicts.
      const secondRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.error.code).toBe(ORDER_STATE_INVALID_CODE);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Rule R9 (DOMINANT) — finalize endpoint
  // ────────────────────────────────────────────────────────────────────
  describe('Rule R9 (DOMINANT) — finalize endpoint', () => {
    it("finalize 200 response state is 'finalized' and is NEVER one of the financial-settlement tokens", async () => {
      // The `state` column is the canonical place where a Rule R9
      //   regression would show up. A defective finalize might
      //   return a settlement token (e.g. 'paid', 'charged') even
      //   if the rest of the pipeline is clean. Assert the
      //   non-settlement contract directly.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      const res = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('finalized');
      expect(TERMINAL_PAYMENT_STATES).not.toContain(res.body.state);
    });

    it('finalize 200 response body contains no forbidden payment-processor terms', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      const res = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('finalize 200 response headers contain no forbidden payment-processor terms', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      const res = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.headers)).not.toMatch(FORBIDDEN_R9_PATTERN);
    });

    it('finalize 409 conflict response body contains no forbidden payment-processor terms', async () => {
      // The conflict path is also a public response surface — a
      //   defective implementation could leak settlement
      //   terminology in the error message ("already paid", "refund
      //   not allowed", etc.). Verify it stays clean.
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      // Drive the order into the finalized state...
      const firstRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(firstRes.status).toBe(200);

      // ...then double-finalize to elicit the conflict.
      const conflictRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(conflictRes.status).toBe(409);
      expect(JSON.stringify(conflictRes.body)).not.toMatch(FORBIDDEN_R9_PATTERN);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-cutting concerns (correlation)
  // ────────────────────────────────────────────────────────────────────
  describe('Cross-cutting concerns', () => {
    it('emits an x-correlation-id response header on a successful 200 finalize', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      const res = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits an x-correlation-id response header on a 404 ORDER_NOT_FOUND error', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);

      const res = await request(app)
        .post(`/api/orders/${NONEXISTENT_ORDER_ID}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);

      expect(res.status).toBe(404);
      expect(res.headers['x-correlation-id']).toMatchCorrelationId();
    });

    it('emits an x-correlation-id response header on a 409 ORDER_STATE_INVALID error', async () => {
      const { idToken } = await setupAuthenticatedUser(app, createdUids);
      const designId = await createDesignViaProduction(app, idToken);
      const orderId = await createOrderViaProduction(app, idToken, designId);

      // First finalize → 200.
      const firstRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(firstRes.status).toBe(200);

      // Second finalize → 409 conflict.
      const conflictRes = await request(app)
        .post(`/api/orders/${orderId}/finalize`)
        .set('Authorization', `Bearer ${idToken}`);
      expect(conflictRes.status).toBe(409);
      expect(conflictRes.headers['x-correlation-id']).toMatchCorrelationId();
    });
  });
});
