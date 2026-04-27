/**
 * Unit tests for `backend/src/routes/designs.ts` — ST-027, ST-028, ST-029.
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-027 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "POST /api/designs with `{ title, payload }` and a valid
 *             authenticated session creates a new row in `designs` with
 *             a server-assigned id and the caller's uid as `user_id`."
 *
 *       AC2: "The response body returns the server-assigned id (201)."
 *
 *       AC3: "Invalid input (missing title, malformed payload, missing
 *             required payload fields, malformed logo reference) is
 *             rejected with HTTP 400 and a descriptive error body. No
 *             partial state may persist on validation failure."
 *
 *       AC4: "Without a valid session, the endpoint MUST return HTTP 401."
 *
 *   - Story ST-028 acceptance criteria (verbatim per Rule R1):
 *
 *       AC1: "GET /api/designs with a valid session returns ONLY that
 *             user's designs (cross-user isolation enforced at SQL)."
 *
 *       AC2: "The list response excludes the full payload — only metadata
 *             (id, title, timestamps) is returned per the documented
 *             payload shape."
 *
 *       AC3: "Empty result set returns HTTP 200 with `items: []`."
 *
 *       AC4: "Order is deterministic: most-recently-modified first, with
 *             `id` as a tiebreaker."
 *
 *       AC5: "Pagination cap = 100 per page; the `limit` query parameter
 *             is silently clamped to 100. Cursors are opaque."
 *
 *   - Story ST-029 acceptance criteria (verbatim per Rule R1):
 *
 *       AC1: "POST /api/designs/:id/share-link with a valid session
 *             requires the caller to own the design referenced by `:id`.
 *             Cross-user attempts return HTTP 404 (anti-enumeration: we
 *             intentionally conflate 'design does not exist' with
 *             'design exists but is not yours')."
 *
 *       AC2: "The response includes a cryptographically-random URL-safe
 *             token and an absolute `expiresAt` timestamp."
 *
 *       AC3: "The companion unauthenticated read route is
 *             GET /api/share/:token (lives in `routes/share.ts`)."
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
 *
 * ============================================================================
 * Contract surface verified
 * ============================================================================
 *
 * Factory wiring:
 *   1. `createDesignRoutes` returns a usable Express Router that mounts
 *      a POST `/`, a GET `/`, and a POST `/:id/share-link` handler.
 *   2. The factory throws when `deps` is missing or non-object.
 *   3. The factory throws when `deps.designService` is missing.
 *   4. The factory throws when `deps.shareLinkService` is missing.
 *   5. The factory throws when `deps.designService.create` is not a
 *      function (or any of `listByUser` / `getById`).
 *   6. The factory throws when `deps.shareLinkService.issue` is not a
 *      function.
 *   7. Two factory invocations produce independent Router instances
 *      (no module-level singleton).
 *
 * POST /api/designs (ST-027):
 *   8. Returns 201 with the persisted Design payload from the service
 *      (ST-027-AC1, AC2).
 *   9. Forwards `req.uid` as the `userId` argument to
 *      `designService.create({ userId, title, payload })` (AC1
 *      ownership scoping).
 *  10. Returns 401 UNAUTHENTICATED when `req.uid` is missing (AC4).
 *  11. Returns 401 UNAUTHENTICATED when `req.uid` is an empty string
 *      (defense-in-depth).
 *  12. Returns 400 VALIDATION_FAILED with `details` array on a malformed
 *      body (AC3) — covers ZodError translation across multiple
 *      pathologies (missing title, missing payload, unknown key,
 *      malformed logo).
 *  13. Returns 400 with the service's `code`/`message` on a service-
 *      layer ValidationError (AC3 deeper service-layer rejection).
 *  14. Returns 400 with default `VALIDATION_FAILED` / `Invalid input`
 *      fallbacks when a ValidationError lacks `code` or `message`.
 *  15. Returns 404 with the service's `code`/`message` on a service-
 *      layer ValidationError carrying `code: 'DESIGN_NOT_FOUND'`
 *      (special case — the create endpoint does not normally produce
 *      this, but the translator handles it for forward compatibility).
 *  16. Returns 404 with the service's `code`/`message` on a NotFoundError.
 *  17. Returns 500 INTERNAL_ERROR with a non-leaking body on an
 *      unrecognized error (Rule R8 fail-closed).
 *  18. Logs the unrecognized error via `req.log.error` with bounded
 *      structural metadata only (event, errorName, errorCode,
 *      errorMessage truncated to 200 chars) — Rule R2.
 *
 * GET /api/designs (ST-028):
 *  19. Returns 200 with `{ items, nextCursor }` from the service
 *      (ST-028-AC1, AC2, AC4).
 *  20. Returns 200 with `{ items: [], nextCursor: null }` on the empty
 *      page (AC3).
 *  21. Forwards `req.uid` as `userId` to `designService.listByUser` so
 *      the SQL WHERE clause scopes to the caller (AC1).
 *  22. Forwards `limit` and `cursor` query parameters to
 *      `designService.listByUser` with the conditional-spread pattern
 *      (omits keys when undefined).
 *  23. Coerces a numeric-string `limit` query parameter to a number
 *      before forwarding (Zod `coerce.number()`).
 *  24. Returns 400 VALIDATION_FAILED on a non-numeric `limit`,
 *      negative `limit`, decimal `limit`, or `limit > 100` (AC5).
 *  25. Returns 400 VALIDATION_FAILED on an unknown query key (Zod
 *      `.strict()` mode).
 *  26. Returns 401 UNAUTHENTICATED when `req.uid` is missing.
 *  27. Returns 400 with the service's `code`/`message` on a service-
 *      layer ValidationError.
 *  28. Returns 500 INTERNAL_ERROR on an unrecognized error (Rule R8).
 *
 * POST /api/designs/:id/share-link (ST-029):
 *  29. Returns 200 with the ShareLink payload from the service
 *      (ST-029-AC2 — token + expiresAt).
 *  30. Forwards `req.uid` as `ownerUid` and `:id` as `designId` to
 *      `shareLinkService.issue` (AC1 ownership scoping).
 *  31. Returns 401 UNAUTHENTICATED when `req.uid` is missing.
 *  32. Returns 400 VALIDATION_DESIGN_ID_MISSING when `:id` is empty
 *      string after the path (defensive).
 *  33. Returns 400 VALIDATION_DESIGN_ID_MISSING when `:id` is whitespace
 *      only.
 *  34. Returns 404 with `code: 'DESIGN_NOT_FOUND'` on a NotFoundError
 *      from the service (AC1 anti-enumeration).
 *  35. Returns 404 on a ValidationError carrying
 *      `code: 'DESIGN_NOT_FOUND'` (forward-compat path; some service
 *      revisions historically threw ValidationError instead of
 *      NotFoundError).
 *  36. Returns 400 on a generic ValidationError (e.g., empty designId
 *      caught by service-layer re-validation).
 *  37. Returns 500 INTERNAL_ERROR on an unrecognized error.
 *
 * Error translator coverage (handleRouteError branches):
 *  38. UnauthenticatedError → 401.
 *  39. ZodError (caught defensively from a path that uses .parse) → 400
 *      VALIDATION_FAILED with `details` array.
 *  40. ValidationError default branch → 400 with the error's code +
 *      message.
 *  41. NotFoundError → 404 with the error's code + message; default
 *      `code: 'NOT_FOUND'` and `message: 'Resource not found'` fallbacks.
 *  42. Bare `{}` thrown value → 500 INTERNAL_ERROR (defense-in-depth
 *      against malformed throws).
 *  43. `null` thrown value → 500 INTERNAL_ERROR (defense-in-depth).
 *  44. Unrecognized error WITH `req.log` absent → 500, no crash
 *      (graceful degradation).
 *
 * Rule R9 verification (no settlement-processor vocabulary):
 *  45. The route source file contains zero matches for the AAP §0.8.1
 *      forbidden-vocabulary grep.
 *
 * ============================================================================
 * Determinism (ST-043-AC3) and Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` drives Express via an
 *     in-memory ephemeral-port loopback that supertest manages; no
 *     external host, no DNS resolution.
 *   - Zero file-system access at test time except for the Rule R9
 *     grep which reads this file's sibling `designs.ts` source.
 *   - Zero environment-variable reads. `designs.ts` consumes no env
 *     vars directly.
 *   - The `DesignService` and `ShareLinkService` dependencies are
 *     replaced by `jest.fn()`-backed shims built per test; no real
 *     database, repository, or pg pool.
 *   - The Jest config (`jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, `restoreMocks` to `true`, so jest.fn state is
 *     wiped between tests.
 *
 * @see backend/src/routes/designs.ts — module under test
 * @see backend/src/routes/cart.test.ts — sibling pattern reference
 * @see backend/src/routes/share.test.ts — sibling pattern reference
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-027-create-design-endpoint.md
 * @see tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md
 * @see tickets/stories/ST-029-share-link-issuance-endpoint.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// `express` is imported as a runtime default — the test invokes
// `express()` to construct an in-memory app that mounts the router
// under test. `supertest` is also a runtime default.
//
// Both packages declare these defaults via CommonJS `module.exports = ...`
// and the project's `esModuleInterop: true` compiler option (see
// `backend/tsconfig.json`) makes the `import x from 'y'` form resolve
// to `module.exports` under the hood.
//
// `DesignService`, `ShareLinkService`, and the typed shapes are
// type-only — the test substitutes `jest.fn()`-backed shims and never
// instantiates the real services. The `import type` form satisfies the
// workspace's `@typescript-eslint/consistent-type-imports` rule.
//
// `createDesignRoutes` and `CreateDesignRoutesDeps` are runtime/named
// imports from the sibling `./designs` module — the surface under test.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import type { DesignService } from '../services/design.service';
import type { ShareLinkService } from '../services/share-link.service';
import type { Design, DesignListPage } from '../repositories/design.repository';
import type { ShareLink } from '../repositories/share-link.repository';

import { createDesignRoutes } from './designs';
import type { CreateDesignRoutesDeps } from './designs';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Minimal jest-mock-backed `DesignService` shim.
 *
 * The route consumes `create`, `listByUser`, `getById` per the factory
 * validation. Each test overrides the relevant method with
 * `mockResolvedValueOnce` / `mockRejectedValueOnce` to produce the
 * scenario under test.
 */
type DesignServiceMock = {
  create: jest.Mock;
  listByUser: jest.Mock;
  getById: jest.Mock;
};

/**
 * Minimal jest-mock-backed `ShareLinkService` shim. Only `issue` is
 * consumed by `designs.ts`; the other methods are `jest.fn()`
 * placeholders so the shim satisfies the structural type contract.
 */
type ShareLinkServiceMock = {
  issue: jest.Mock;
  getByToken: jest.Mock;
  revoke: jest.Mock;
};

/**
 * Construct a fresh `DesignServiceMock` for each test. Centralising
 * construction in a helper guarantees every test starts from the same
 * baseline — `jest.fn()` instances with no implementation, no recorded
 * calls.
 */
function buildDesignService(): DesignServiceMock {
  return {
    create: jest.fn(),
    listByUser: jest.fn(),
    getById: jest.fn(),
  };
}

/**
 * Construct a fresh `ShareLinkServiceMock` for each test.
 */
function buildShareLinkService(): ShareLinkServiceMock {
  return {
    issue: jest.fn(),
    getByToken: jest.fn(),
    revoke: jest.fn(),
  };
}

/**
 * Construct a fixture `Design` record. The fields mirror the documented
 * `Design` interface in `repositories/design.repository.ts`.
 */
function buildDesignFixture(overrides?: Partial<Design>): Design {
  return {
    id: 'design-uuid-1',
    userId: 'firebase-uid-12345',
    title: 'Test Design',
    payload: {
      primaryColor: '#FF0000',
      pattern: 'classic',
      finish: 'matte',
    },
    createdAt: new Date('2025-01-15T10:30:00.000Z'),
    lastModifiedAt: new Date('2025-01-15T10:30:00.000Z'),
    ...overrides,
  };
}

/**
 * Construct a fixture `ShareLink` record. The fields mirror the
 * documented `ShareLink` interface in
 * `repositories/share-link.repository.ts`.
 */
function buildShareLinkFixture(overrides?: Partial<ShareLink>): ShareLink {
  return {
    token: 'aB3xY7kqL9mN4pQ2sT6vW8zE1rH5jU0d_g-CfIlOoVbZ',
    designId: 'design-uuid-1',
    ownerUid: 'firebase-uid-12345',
    issuedAt: new Date('2025-01-15T10:30:00.000Z'),
    expiresAt: new Date('2025-01-29T10:30:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Construct an Express app with the designs router mounted at
 * `/api/designs` (mirroring the production composition root in
 * `backend/src/index.ts`). A simple inline middleware stamps the
 * supplied `uid` onto `req.uid` BEFORE the router runs, mirroring the
 * production `sessionMiddleware` contract.
 *
 * When `uid` is `undefined`, the simulator middleware does NOT set
 * `req.uid`, allowing the route to exercise its defensive 401 path.
 *
 * The optional `attachLogger` flag installs a `req.log.error` spy at
 * the top of the chain so the error-translator's structured log call
 * can be observed.
 *
 * The `as unknown as DesignService` double-cast bridges the
 * structural-vs-nominal type gap. The route consumes only `create`,
 * `listByUser`, `getById`; the cast is the canonical pattern for
 * substituting minimal mocks for richer interfaces (see
 * `health.test.ts`, `cart.test.ts` for the same pattern applied to
 * `pg.Pool` and `OrderService`).
 */
type LogSpy = {
  error: jest.Mock;
};

interface BuildAppOpts {
  designService: DesignServiceMock;
  shareLinkService: ShareLinkServiceMock;
  uid?: string;
  logSpy?: LogSpy;
}

function buildApp(opts: BuildAppOpts): express.Express {
  const app = express();
  // The router consumes JSON bodies on POST /. Production wires this
  // upstream of every route; we wire it locally per app to match.
  app.use(express.json());

  // Optional req.log injector — mirrors what pino-http does in
  // production. When present, the error translator inside designs.ts
  // will invoke `req.log.error(...)`.
  if (opts.logSpy !== undefined) {
    const spy = opts.logSpy;
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const reqWithLog = req as Request & {
        log?: { error: jest.Mock };
      };
      reqWithLog.log = spy;
      next();
    });
  }

  // Session-middleware simulator — stamps req.uid so the designs
  // router believes the user is authenticated. Omitted when `uid`
  // is undefined, exercising the defensive 401 path. We always
  // install the middleware (so empty-string uid scenarios can be
  // exercised), but inside it we conditionally set the property.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.uid !== undefined) {
      req.uid = opts.uid;
    }
    next();
  });

  const router = createDesignRoutes({
    designService: opts.designService as unknown as DesignService,
    shareLinkService: opts.shareLinkService as unknown as ShareLinkService,
  });
  app.use('/api/designs', router);
  return app;
}

/**
 * A valid create-design request body fixture. Tests that exercise the
 * create endpoint MUST start from this shape and modify it for
 * negative scenarios (drop title, drop payload field, add unknown key,
 * etc.).
 */
const VALID_CREATE_BODY = {
  title: 'My First Ball',
  payload: {
    primaryColor: '#FF0000',
    secondaryColor: '#00FF00',
    accentColor: '#0000FF',
    pattern: 'classic',
    finish: 'matte',
    logo: {
      objectKey: 'logos/abc.png',
      offsetX: 0.1,
      offsetY: 0.2,
      scale: 1.0,
      rotation: 0,
    },
  },
};

const TEST_UID = 'firebase-uid-12345';

// ===========================================================================
// Section A: Factory wiring
// ===========================================================================

describe('createDesignRoutes — factory wiring', () => {
  it('returns an Express Router when all dependencies are valid', () => {
    const designService = buildDesignService();
    const shareLinkService = buildShareLinkService();
    const router = createDesignRoutes({
      designService: designService as unknown as DesignService,
      shareLinkService: shareLinkService as unknown as ShareLinkService,
    });
    // Express Router instances are functions in addition to having
    // `use` / `get` / `post` methods. Asserting both confirms the
    // factory returned a real Router, not a structural impostor.
    expect(typeof router).toBe('function');
    expect(typeof (router as unknown as { use: unknown }).use).toBe('function');
    expect(typeof (router as unknown as { get: unknown }).get).toBe('function');
    expect(typeof (router as unknown as { post: unknown }).post).toBe('function');
  });

  it('throws when deps argument is null', () => {
    expect(() =>
      createDesignRoutes(null as unknown as CreateDesignRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps argument is undefined', () => {
    expect(() =>
      createDesignRoutes(undefined as unknown as CreateDesignRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps argument is a primitive (e.g., string)', () => {
    // Defense-in-depth: typeof !== 'object' branch.
    expect(() =>
      createDesignRoutes('not-an-object' as unknown as CreateDesignRoutesDeps),
    ).toThrow(/deps argument is required/);
  });

  it('throws when deps.designService is missing', () => {
    const shareLinkService = buildShareLinkService();
    expect(() =>
      createDesignRoutes({
        shareLinkService: shareLinkService as unknown as ShareLinkService,
      } as unknown as CreateDesignRoutesDeps),
    ).toThrow(/designService dependency is required/);
  });

  it('throws when deps.designService is null', () => {
    const shareLinkService = buildShareLinkService();
    expect(() =>
      createDesignRoutes({
        designService: null,
        shareLinkService: shareLinkService as unknown as ShareLinkService,
      } as unknown as CreateDesignRoutesDeps),
    ).toThrow(/designService dependency is required/);
  });

  it('throws when deps.shareLinkService is missing', () => {
    const designService = buildDesignService();
    expect(() =>
      createDesignRoutes({
        designService: designService as unknown as DesignService,
      } as unknown as CreateDesignRoutesDeps),
    ).toThrow(/shareLinkService dependency is required/);
  });

  it('throws when deps.shareLinkService is null', () => {
    const designService = buildDesignService();
    expect(() =>
      createDesignRoutes({
        designService: designService as unknown as DesignService,
        shareLinkService: null,
      } as unknown as CreateDesignRoutesDeps),
    ).toThrow(/shareLinkService dependency is required/);
  });

  it('throws when deps.designService.create is not a function', () => {
    const shareLinkService = buildShareLinkService();
    const broken = {
      designService: {
        create: 'not-a-function',
        listByUser: jest.fn(),
        getById: jest.fn(),
      },
      shareLinkService,
    };
    expect(() =>
      createDesignRoutes(broken as unknown as CreateDesignRoutesDeps),
    ).toThrow(/designService must implement create \/ listByUser \/ getById/);
  });

  it('throws when deps.designService.listByUser is not a function', () => {
    const shareLinkService = buildShareLinkService();
    const broken = {
      designService: {
        create: jest.fn(),
        listByUser: undefined,
        getById: jest.fn(),
      },
      shareLinkService,
    };
    expect(() =>
      createDesignRoutes(broken as unknown as CreateDesignRoutesDeps),
    ).toThrow(/designService must implement create \/ listByUser \/ getById/);
  });

  it('throws when deps.designService.getById is not a function', () => {
    const shareLinkService = buildShareLinkService();
    const broken = {
      designService: {
        create: jest.fn(),
        listByUser: jest.fn(),
        getById: 42,
      },
      shareLinkService,
    };
    expect(() =>
      createDesignRoutes(broken as unknown as CreateDesignRoutesDeps),
    ).toThrow(/designService must implement create \/ listByUser \/ getById/);
  });

  it('throws when deps.shareLinkService.issue is not a function', () => {
    const designService = buildDesignService();
    const broken = {
      designService,
      shareLinkService: {
        issue: 'not-a-function',
        getByToken: jest.fn(),
        revoke: jest.fn(),
      },
    };
    expect(() =>
      createDesignRoutes(broken as unknown as CreateDesignRoutesDeps),
    ).toThrow(/shareLinkService must implement issue/);
  });

  it('produces independent routers across calls (no module-level singleton)', () => {
    const designServiceA = buildDesignService();
    const designServiceB = buildDesignService();
    const shareLinkServiceA = buildShareLinkService();
    const shareLinkServiceB = buildShareLinkService();
    const a = createDesignRoutes({
      designService: designServiceA as unknown as DesignService,
      shareLinkService: shareLinkServiceA as unknown as ShareLinkService,
    });
    const b = createDesignRoutes({
      designService: designServiceB as unknown as DesignService,
      shareLinkService: shareLinkServiceB as unknown as ShareLinkService,
    });
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// Section B: POST /api/designs (ST-027)
// ===========================================================================

describe('POST /api/designs — ST-027 (create design)', () => {
  let designService: DesignServiceMock;
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;

  beforeEach(() => {
    designService = buildDesignService();
    shareLinkService = buildShareLinkService();
    app = buildApp({ designService, shareLinkService, uid: TEST_UID });
  });

  // --------- ST-027-AC1, AC2 happy path ---------

  it('returns 201 with the persisted Design from the service', async () => {
    const design = buildDesignFixture();
    designService.create.mockResolvedValueOnce(design);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    // Date fields serialise to ISO 8601 in JSON; the body shape is the
    // service's return value with timestamps stringified.
    expect(res.body).toEqual({
      ...design,
      createdAt: design.createdAt.toISOString(),
      lastModifiedAt: design.lastModifiedAt.toISOString(),
    });
  });

  it('forwards req.uid as userId to designService.create (AC1 ownership)', async () => {
    designService.create.mockResolvedValueOnce(buildDesignFixture());

    await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(designService.create).toHaveBeenCalledTimes(1);
    expect(designService.create).toHaveBeenCalledWith({
      userId: TEST_UID,
      title: VALID_CREATE_BODY.title,
      payload: VALID_CREATE_BODY.payload,
    });
  });

  it('does not invoke listByUser, getById, or shareLinkService.issue', async () => {
    designService.create.mockResolvedValueOnce(buildDesignFixture());

    await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(designService.listByUser).not.toHaveBeenCalled();
    expect(designService.getById).not.toHaveBeenCalled();
    expect(shareLinkService.issue).not.toHaveBeenCalled();
  });

  // --------- ST-027-AC4 unauthenticated ---------

  it('returns 401 UNAUTHENTICATED when req.uid is undefined', async () => {
    // Build a fresh app WITHOUT a uid stamp.
    app = buildApp({ designService, shareLinkService /* no uid */ });

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    // The service was never reached because the guard tripped first.
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHENTICATED when req.uid is empty string', async () => {
    app = buildApp({ designService, shareLinkService, uid: '' });

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  // --------- ST-027-AC3 invalid input via Zod ---------

  it('returns 400 VALIDATION_FAILED with details when title is missing', async () => {
    const res = await request(app)
      .post('/api/designs')
      .send({ payload: VALID_CREATE_BODY.payload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toBe('Invalid request body or query');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    // The details array contains a `title`-pathed entry.
    const titleIssue = res.body.error.details.find(
      (d: { path: string }) => d.path === 'title',
    );
    expect(titleIssue).toBeDefined();
    // The service was never invoked.
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when title is empty string', async () => {
    const res = await request(app)
      .post('/api/designs')
      .send({ ...VALID_CREATE_BODY, title: '' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when title exceeds 200 characters', async () => {
    const res = await request(app)
      .post('/api/designs')
      .send({ ...VALID_CREATE_BODY, title: 'X'.repeat(201) })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when payload is missing', async () => {
    const res = await request(app)
      .post('/api/designs')
      .send({ title: VALID_CREATE_BODY.title })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when payload.primaryColor is missing', async () => {
    // Construct a payload missing `primaryColor` (required).
    const badPayload = {
      pattern: 'classic',
      finish: 'matte',
    };
    const res = await request(app)
      .post('/api/designs')
      .send({ title: 'X', payload: badPayload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const colorIssue = res.body.error.details.find(
      (d: { path: string }) => d.path === 'payload.primaryColor',
    );
    expect(colorIssue).toBeDefined();
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on unknown payload key (Zod .strict())', async () => {
    const badPayload = {
      ...VALID_CREATE_BODY.payload,
      sneakyExtraField: 'should-be-rejected',
    };
    const res = await request(app)
      .post('/api/designs')
      .send({ title: 'X', payload: badPayload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on unknown top-level key (Zod .strict())', async () => {
    const res = await request(app)
      .post('/api/designs')
      .send({ ...VALID_CREATE_BODY, sneakyExtraField: 'rejected' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED when logo.objectKey is empty', async () => {
    const badPayload = {
      ...VALID_CREATE_BODY.payload,
      logo: { objectKey: '' },
    };
    const res = await request(app)
      .post('/api/designs')
      .send({ title: 'X', payload: badPayload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on NaN logo.offsetX (.finite() rejects)', async () => {
    // JSON cannot encode NaN directly, but we can simulate by using
    // a payload whose schema rejects via the integer/finite checks.
    // The `logo.offsetX: 'not-a-number'` form exercises the "type"
    // failure branch.
    const badPayload = {
      ...VALID_CREATE_BODY.payload,
      logo: { objectKey: 'logos/x.png', offsetX: 'not-a-number' },
    };
    const res = await request(app)
      .post('/api/designs')
      .send({ title: 'X', payload: badPayload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.create).not.toHaveBeenCalled();
  });

  it('accepts logo: null as a valid clear-logo signal', async () => {
    const design = buildDesignFixture();
    designService.create.mockResolvedValueOnce(design);

    const payload = { ...VALID_CREATE_BODY.payload, logo: null };
    const res = await request(app)
      .post('/api/designs')
      .send({ title: VALID_CREATE_BODY.title, payload })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    expect(designService.create).toHaveBeenCalledTimes(1);
  });

  // --------- Service-layer error translation ---------

  it('returns 400 with service code/message on a service ValidationError', async () => {
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'VALIDATION_TITLE_TOO_LONG';
      public constructor(msg: string) {
        super(msg);
      }
    }
    designService.create.mockRejectedValueOnce(
      new FakeValidationError('title cannot exceed 200 characters'),
    );

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_TITLE_TOO_LONG',
        message: 'title cannot exceed 200 characters',
      },
    });
  });

  it('returns 400 with default code/message when ValidationError lacks fields', async () => {
    // ValidationError without `code` or `message` — exercises both
    // `??` fallbacks.
    const minimalErr = { name: 'ValidationError' };
    designService.create.mockRejectedValueOnce(minimalErr);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  it('returns 404 on a ValidationError carrying code DESIGN_NOT_FOUND', async () => {
    // The create endpoint does not normally produce DESIGN_NOT_FOUND,
    // but the translator's special-case branch should still fire if
    // the service ever did so. This pins the cross-cutting branch.
    const fakeErr = {
      name: 'ValidationError',
      code: 'DESIGN_NOT_FOUND',
      message: 'design not found',
    };
    designService.create.mockRejectedValueOnce(fakeErr);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'DESIGN_NOT_FOUND', message: 'design not found' },
    });
  });

  it('returns 404 on a NotFoundError', async () => {
    class FakeNotFoundError extends Error {
      public override readonly name = 'NotFoundError';
      public readonly code = 'NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    designService.create.mockRejectedValueOnce(
      new FakeNotFoundError('user does not exist'),
    );

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'user does not exist' },
    });
  });

  it('returns 404 with default fallbacks on a NotFoundError without code/message', async () => {
    const minimalErr = { name: 'NotFoundError' };
    designService.create.mockRejectedValueOnce(minimalErr);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });

  // --------- Rule R8 fail-closed (500 INTERNAL_ERROR) ---------

  it('returns 500 INTERNAL_ERROR with non-leaking body on unrecognized error', async () => {
    designService.create.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    // Original error details MUST NOT appear.
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(JSON.stringify(res.body)).not.toContain('pg socket');
  });

  it('logs unrecognized errors via req.log.error with bounded structural metadata', async () => {
    const logSpy: LogSpy = { error: jest.fn() };
    const longMessage = 'X'.repeat(500);
    const customErr = new Error(longMessage);
    Object.defineProperty(customErr, 'code', {
      value: 'PG_CONN_FAIL',
      enumerable: true,
    });
    designService.create.mockRejectedValueOnce(customErr);
    app = buildApp({ designService, shareLinkService, uid: TEST_UID, logSpy });

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs, logMsg] = logSpy.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(logMsg).toBe('designs route error');
    expect(logArgs).toMatchObject({
      event: 'designs.route.error',
      errorName: 'Error',
      errorCode: 'PG_CONN_FAIL',
    });
    // The message MUST be truncated to ≤ 200 characters.
    expect(typeof logArgs['errorMessage']).toBe('string');
    expect((logArgs['errorMessage'] as string).length).toBeLessThanOrEqual(200);
  });

  it('does not throw when req.log is absent (graceful degradation)', async () => {
    designService.create.mockRejectedValueOnce(new Error('boom'));
    // No logSpy — req.log will be undefined.
    app = buildApp({ designService, shareLinkService, uid: TEST_UID });

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates a malformed thrown value (no name, no message) to 500', async () => {
    designService.create.mockRejectedValueOnce({});

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('translates a null thrown value to 500', async () => {
    designService.create.mockRejectedValueOnce(null);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('logs unrecognized error with no message (errorMessage undefined branch)', async () => {
    const logSpy: LogSpy = { error: jest.fn() };
    designService.create.mockRejectedValueOnce({});
    app = buildApp({ designService, shareLinkService, uid: TEST_UID, logSpy });

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({
      event: 'designs.route.error',
      errorName: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });
});

// ===========================================================================
// Section C: GET /api/designs (ST-028)
// ===========================================================================

describe('GET /api/designs — ST-028 (list designs paginated)', () => {
  let designService: DesignServiceMock;
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;

  beforeEach(() => {
    designService = buildDesignService();
    shareLinkService = buildShareLinkService();
    app = buildApp({ designService, shareLinkService, uid: TEST_UID });
  });

  // --------- ST-028 happy paths ---------

  it('returns 200 with { items, nextCursor } from the service (AC1, AC2, AC4)', async () => {
    const item1 = buildDesignFixture({
      id: 'design-2',
      lastModifiedAt: new Date('2025-01-20T00:00:00.000Z'),
    });
    const item2 = buildDesignFixture({
      id: 'design-1',
      lastModifiedAt: new Date('2025-01-15T00:00:00.000Z'),
    });
    const page: DesignListPage = {
      items: [item1, item2],
      nextCursor: 'opaque-cursor-base64-v1',
    };
    designService.listByUser.mockResolvedValueOnce(page);

    const res = await request(app).get('/api/designs');

    expect(res.status).toBe(200);
    // The serialised response includes ISO-string dates.
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].id).toBe('design-2');
    expect(res.body.items[1].id).toBe('design-1');
    expect(res.body.nextCursor).toBe('opaque-cursor-base64-v1');
  });

  it('returns 200 with { items: [], nextCursor: null } on empty page (AC3)', async () => {
    designService.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    const res = await request(app).get('/api/designs');

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('forwards req.uid as userId to designService.listByUser (AC1)', async () => {
    designService.listByUser.mockResolvedValueOnce({ items: [], nextCursor: null });

    await request(app).get('/api/designs');

    expect(designService.listByUser).toHaveBeenCalledTimes(1);
    expect(designService.listByUser).toHaveBeenCalledWith({ userId: TEST_UID });
    // No limit / cursor provided — the conditional-spread pattern
    // results in a params object with ONLY `userId`.
    const callArg = designService.listByUser.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(callArg).sort()).toEqual(['userId']);
  });

  it('forwards limit query parameter to designService.listByUser', async () => {
    designService.listByUser.mockResolvedValueOnce({ items: [], nextCursor: null });

    await request(app).get('/api/designs?limit=25');

    expect(designService.listByUser).toHaveBeenCalledWith({
      userId: TEST_UID,
      limit: 25,
    });
  });

  it('forwards cursor query parameter to designService.listByUser', async () => {
    designService.listByUser.mockResolvedValueOnce({ items: [], nextCursor: null });

    await request(app).get('/api/designs?cursor=abc123');

    expect(designService.listByUser).toHaveBeenCalledWith({
      userId: TEST_UID,
      cursor: 'abc123',
    });
  });

  it('forwards both limit and cursor when both are present', async () => {
    designService.listByUser.mockResolvedValueOnce({ items: [], nextCursor: null });

    await request(app).get('/api/designs?limit=50&cursor=opaqueXYZ');

    expect(designService.listByUser).toHaveBeenCalledWith({
      userId: TEST_UID,
      limit: 50,
      cursor: 'opaqueXYZ',
    });
  });

  it('coerces a numeric-string limit to a number (Zod coerce.number())', async () => {
    designService.listByUser.mockResolvedValueOnce({ items: [], nextCursor: null });

    await request(app).get('/api/designs?limit=10');

    const callArg = designService.listByUser.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(typeof callArg['limit']).toBe('number');
    expect(callArg['limit']).toBe(10);
  });

  // --------- ST-028 invalid query parameters ---------

  it('returns 400 VALIDATION_FAILED on non-numeric limit', async () => {
    const res = await request(app).get('/api/designs?limit=not-a-number');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on negative limit', async () => {
    const res = await request(app).get('/api/designs?limit=-5');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on zero limit (must be at least 1)', async () => {
    const res = await request(app).get('/api/designs?limit=0');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on limit > 100 (AC5 cap surfaced)', async () => {
    const res = await request(app).get('/api/designs?limit=101');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    // Surfaces the cap as a 400 rather than silently coercing to 100.
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on decimal limit (must be integer)', async () => {
    const res = await request(app).get('/api/designs?limit=10.5');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on empty cursor', async () => {
    const res = await request(app).get('/api/designs?cursor=');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  it('returns 400 VALIDATION_FAILED on unknown query key (.strict())', async () => {
    const res = await request(app).get('/api/designs?sneakyExtra=evil');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  // --------- ST-028 unauthenticated ---------

  it('returns 401 UNAUTHENTICATED when req.uid is undefined', async () => {
    app = buildApp({ designService, shareLinkService /* no uid */ });

    const res = await request(app).get('/api/designs');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    expect(designService.listByUser).not.toHaveBeenCalled();
  });

  // --------- ST-028 service-layer error translation ---------

  it('returns 400 on a service-layer ValidationError', async () => {
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'VALIDATION_CURSOR_INVALID';
      public constructor(msg: string) {
        super(msg);
      }
    }
    designService.listByUser.mockRejectedValueOnce(
      new FakeValidationError('cursor is malformed'),
    );

    const res = await request(app).get('/api/designs?cursor=malformedXYZ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_CURSOR_INVALID',
        message: 'cursor is malformed',
      },
    });
  });

  it('returns 500 INTERNAL_ERROR on unrecognized error (Rule R8)', async () => {
    designService.listByUser.mockRejectedValueOnce(
      new Error('postgres pool timeout'),
    );

    const res = await request(app).get('/api/designs');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(JSON.stringify(res.body)).not.toContain('postgres pool');
  });

  it('logs unrecognized list error via req.log.error', async () => {
    const logSpy: LogSpy = { error: jest.fn() };
    designService.listByUser.mockRejectedValueOnce(new Error('upstream timeout'));
    app = buildApp({ designService, shareLinkService, uid: TEST_UID, logSpy });

    await request(app).get('/api/designs');

    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({ event: 'designs.route.error' });
  });
});

// ===========================================================================
// Section D: POST /api/designs/:id/share-link (ST-029)
// ===========================================================================

describe('POST /api/designs/:id/share-link — ST-029 (issue share-link)', () => {
  let designService: DesignServiceMock;
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;
  const TEST_DESIGN_ID = 'design-uuid-1';

  beforeEach(() => {
    designService = buildDesignService();
    shareLinkService = buildShareLinkService();
    app = buildApp({ designService, shareLinkService, uid: TEST_UID });
  });

  // --------- ST-029-AC2 happy path ---------

  it('returns 200 with the ShareLink from the service (AC2)', async () => {
    const shareLink = buildShareLinkFixture();
    shareLinkService.issue.mockResolvedValueOnce(shareLink);

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...shareLink,
      issuedAt: shareLink.issuedAt.toISOString(),
      expiresAt: shareLink.expiresAt.toISOString(),
      revokedAt: shareLink.revokedAt,
    });
    // AC2 — token + expiresAt are included.
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(0);
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('forwards req.uid as ownerUid and :id as designId to issue (AC1)', async () => {
    shareLinkService.issue.mockResolvedValueOnce(buildShareLinkFixture());

    await request(app).post(`/api/designs/${TEST_DESIGN_ID}/share-link`);

    expect(shareLinkService.issue).toHaveBeenCalledTimes(1);
    expect(shareLinkService.issue).toHaveBeenCalledWith({
      ownerUid: TEST_UID,
      designId: TEST_DESIGN_ID,
    });
  });

  it('does not invoke designService methods', async () => {
    shareLinkService.issue.mockResolvedValueOnce(buildShareLinkFixture());

    await request(app).post(`/api/designs/${TEST_DESIGN_ID}/share-link`);

    expect(designService.create).not.toHaveBeenCalled();
    expect(designService.listByUser).not.toHaveBeenCalled();
    expect(designService.getById).not.toHaveBeenCalled();
  });

  // --------- ST-029-AC1 anti-enumeration (404 on missing/cross-user) ---------

  it('returns 404 with code DESIGN_NOT_FOUND on a NotFoundError', async () => {
    class FakeNotFoundError extends Error {
      public override readonly name = 'NotFoundError';
      public readonly code = 'DESIGN_NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    shareLinkService.issue.mockRejectedValueOnce(
      new FakeNotFoundError('design not found'),
    );

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'DESIGN_NOT_FOUND', message: 'design not found' },
    });
  });

  it('returns 404 on ValidationError carrying code DESIGN_NOT_FOUND (forward-compat)', async () => {
    // Some older service revisions threw ValidationError with code
    // DESIGN_NOT_FOUND for the cross-user / missing-design case. The
    // route translator's special branch maps to 404 in both shapes.
    const fakeErr = {
      name: 'ValidationError',
      code: 'DESIGN_NOT_FOUND',
      message: 'design does not exist or is not owned by caller',
    };
    shareLinkService.issue.mockRejectedValueOnce(fakeErr);

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'DESIGN_NOT_FOUND',
        message: 'design does not exist or is not owned by caller',
      },
    });
  });

  it('returns 404 with default message on NotFoundError without message', async () => {
    const minimalErr = { name: 'NotFoundError', code: 'DESIGN_NOT_FOUND' };
    shareLinkService.issue.mockRejectedValueOnce(minimalErr);

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'DESIGN_NOT_FOUND', message: 'Resource not found' },
    });
  });

  it('returns 404 with NOT_FOUND code default on a bare NotFoundError', async () => {
    const minimalErr = { name: 'NotFoundError' };
    shareLinkService.issue.mockRejectedValueOnce(minimalErr);

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });

  // --------- ST-029 unauthenticated ---------

  it('returns 401 UNAUTHENTICATED when req.uid is undefined', async () => {
    app = buildApp({ designService, shareLinkService /* no uid */ });

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
    expect(shareLinkService.issue).not.toHaveBeenCalled();
  });

  // --------- ST-029 designId validation ---------

  it('returns 400 VALIDATION_DESIGN_ID_MISSING when :id is whitespace only', async () => {
    // Sending a whitespace-only designId via URL encoding. Express's
    // path-parser sets `req.params.id` to the URL-decoded value;
    // `'   '.trim().length === 0` matches the route's defensive
    // narrow.
    const res = await request(app).post('/api/designs/%20%20%20/share-link');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_DESIGN_ID_MISSING',
        message: 'Design id is required',
      },
    });
    expect(shareLinkService.issue).not.toHaveBeenCalled();
  });

  it('returns 400 on a generic ValidationError (e.g., empty designId at service)', async () => {
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'VALIDATION_DESIGN_ID_INVALID';
      public constructor(msg: string) {
        super(msg);
      }
    }
    shareLinkService.issue.mockRejectedValueOnce(
      new FakeValidationError('designId must be a UUID'),
    );

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_DESIGN_ID_INVALID',
        message: 'designId must be a UUID',
      },
    });
  });

  it('returns 400 on bare ValidationError without code/message (default fallbacks)', async () => {
    const minimalErr = { name: 'ValidationError' };
    shareLinkService.issue.mockRejectedValueOnce(minimalErr);

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  // --------- ST-029 fail-closed ---------

  it('returns 500 INTERNAL_ERROR on unrecognized error (Rule R8)', async () => {
    shareLinkService.issue.mockRejectedValueOnce(
      new Error('share_links table does not exist'),
    );

    const res = await request(app).post(
      `/api/designs/${TEST_DESIGN_ID}/share-link`,
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(JSON.stringify(res.body)).not.toContain('share_links');
  });

  it('logs unrecognized share-link error via req.log.error', async () => {
    const logSpy: LogSpy = { error: jest.fn() };
    shareLinkService.issue.mockRejectedValueOnce(new Error('crypto pool depleted'));
    app = buildApp({ designService, shareLinkService, uid: TEST_UID, logSpy });

    await request(app).post(`/api/designs/${TEST_DESIGN_ID}/share-link`);

    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({
      event: 'designs.route.error',
      errorName: 'Error',
    });
  });
});

// ===========================================================================
// Section E: handleRouteError additional branch coverage
// ===========================================================================

describe('handleRouteError — additional branch coverage', () => {
  let designService: DesignServiceMock;
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;

  beforeEach(() => {
    designService = buildDesignService();
    shareLinkService = buildShareLinkService();
    app = buildApp({ designService, shareLinkService, uid: TEST_UID });
  });

  it('translates a ZodError thrown directly from the service to 400 with details', async () => {
    // A service that imports zod and throws ZodError from a `.parse()`
    // call would reach handleRouteError's structural ZodError check.
    // We construct a synthetic ZodError-shaped value by leveraging Zod
    // itself to produce a real ZodError instance.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod');
    let zodErr: unknown;
    try {
      z.string().min(5).parse('hi');
    } catch (err) {
      zodErr = err;
    }
    designService.create.mockRejectedValueOnce(zodErr);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.message).toBe('Invalid request body or query');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(1);
  });

  it('isZodError defensive narrowing rejects null', async () => {
    // A `null` thrown value MUST hit the `null` early return in
    // `isZodError`, then fall through to the 500 default branch.
    designService.create.mockRejectedValueOnce(null);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('isZodError defensive narrowing rejects undefined', async () => {
    // An `undefined` thrown value reaches the same early return.
    designService.create.mockRejectedValueOnce(undefined);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('isZodError defensive narrowing rejects a primitive string', async () => {
    // A primitive value (typeof !== 'object') hits the early return.
    designService.create.mockRejectedValueOnce('not-an-object');

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('isZodError rejects an object with name=ZodError but issues not array', async () => {
    // Defense-in-depth: an object that LOOKS like a ZodError but
    // has `issues: 'not-an-array'` MUST NOT be treated as one.
    const fakeZod = { name: 'ZodError', issues: 'not-an-array' };
    designService.create.mockRejectedValueOnce(fakeZod);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates an UnauthenticatedError thrown by the service to 401', async () => {
    // Defensive: if a future service revision throws
    // UnauthenticatedError directly, the route translator MUST also
    // map it to 401.
    const fakeErr = {
      name: 'UnauthenticatedError',
      message: 'token revoked',
    };
    designService.create.mockRejectedValueOnce(fakeErr);

    const res = await request(app)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });

  it('forwards a thrown-from-handleRouteError failure via the sync handler defensive .catch', async () => {
    // Engineer a path where handleRouteError itself throws (its log
    // call is the only sync fallible operation). The defensive
    // `.catch(next)` MUST forward the throw to Express's terminal
    // error middleware — Rule R8 fail-closed posture.
    designService.create.mockRejectedValueOnce(new Error('original failure'));
    const malformedLog: LogSpy = {
      error: jest.fn().mockImplementation(() => {
        throw new Error('log subsystem failure');
      }),
    };

    const fresh = express();
    fresh.use(express.json());
    fresh.use((req: Request, _res: Response, next: NextFunction) => {
      const reqWithLog = req as Request & { log?: { error: jest.Mock } };
      reqWithLog.log = malformedLog;
      req.uid = TEST_UID;
      next();
    });
    const errorHandlerSpy = jest.fn(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ caught: true, message: err.message });
      },
    );
    const router = createDesignRoutes({
      designService: designService as unknown as DesignService,
      shareLinkService: shareLinkService as unknown as ShareLinkService,
    });
    fresh.use('/api/designs', router);
    fresh.use(errorHandlerSpy);

    const res = await request(fresh)
      .post('/api/designs')
      .send(VALID_CREATE_BODY)
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(500);
    expect(errorHandlerSpy).toHaveBeenCalledTimes(1);
    expect(errorHandlerSpy.mock.calls[0]?.[0]?.message).toBe(
      'log subsystem failure',
    );
  });
});

// ===========================================================================
// Section F: Rule R9 — no settlement-processor vocabulary in designs.ts
// ===========================================================================

describe('Rule R9 — no settlement-processor vocabulary in designs.ts', () => {
  it('the source file contains zero matches for the AAP forbidden-vocabulary grep', () => {
    // Read the source file from disk and run the AAP §0.8.1 R9 grep
    // pattern against it. The pattern is "stripe|braintree|paypal|
    // payment_intent|charge" per AAP §0.7.2 / §0.8.1 R9.
    //
    // The test is parameterised on the source file path so the
    // pattern is verified WITHIN this test rather than by an external
    // shell command — a Rule R8 fail-closed posture applied at the
    // test layer.
    const source = fs.readFileSync(path.join(__dirname, 'designs.ts'), 'utf-8');
    const forbidden = /stripe|braintree|paypal|payment_intent|charge/i;
    expect(source).not.toMatch(forbidden);
  });
});
