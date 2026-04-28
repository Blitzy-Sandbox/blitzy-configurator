/**
 * Unit tests for `backend/src/routes/share.ts` — ST-029 consumer side
 * (Share Link Read-Side Endpoint, GET /api/share/:token).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - Story ST-029 acceptance criteria (verbatim per Rule R1, AAP §0.8.1):
 *
 *       AC1: "The share-link issuance endpoint requires a valid session
 *             and issues a share link only for designs owned by the
 *             authenticated user." (covered by `routes/designs.ts`,
 *             not this file.)
 *
 *       AC2: "Each issued share link carries a documented expiration
 *             window after which the link is rejected by the read side
 *             with a documented error." (this file's 404 path covers
 *             the read-side rejection.)
 *
 *       AC3: "Visiting a valid, unexpired share link returns enough
 *             information for the configurator to render the target
 *             design read-only WITHOUT requiring the visitor to sign
 *             in." (this file's 200 success path.)
 *
 *       AC4: "Revoking a share link renders the link inoperable on
 *             subsequent requests and does not affect the underlying
 *             design record." (this file's 404 path collapses the
 *             revoked case into the same 404 as expired/unknown.)
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
 * Factory wiring (createShareRoutes):
 *   1. Returns a usable Express Router that mounts a single
 *      `GET /api/share/:token` handler.
 *   2. Throws when `deps` is null/undefined/non-object.
 *   3. Throws when `deps.shareLinkService` is missing.
 *   4. Throws when `deps.shareLinkService.getByToken` is not a
 *      function.
 *   5. Produces independent routers across calls (no module-level
 *      singleton that would leak state between mounts).
 *
 * Unauthenticated GET /api/share/:token (ST-029-AC3 success path):
 *   6. Returns 200 with the SharedDesignView projection from the
 *      service when the token resolves.
 *   7. Forwards the URL :token path parameter VERBATIM into
 *      `shareLinkService.getByToken({ token })`.
 *   8. Does NOT require a session/uid — the route works without
 *      `req.uid` being set, mirroring the production composition root
 *      that mounts this router at the APP ROOT, BEFORE the session
 *      middleware (AAP §0.5.2).
 *   9. Response body excludes the credential-shaped fields the service
 *      already projects out: `ownerUid`, `userId`, `token`, `expiresAt`,
 *      `revokedAt`, `createdAt`. (Belt-and-braces: the SharedDesignView
 *      type forbids these statically, but the test pins the runtime
 *      contract.)
 *
 * Enumeration defense — null collapses to single 404 (ST-029-AC2/AC4):
 *  10. Returns 404 SHARE_LINK_NOT_FOUND when the service returns null.
 *      All four service-layer null causes (unknown token, revoked,
 *      expired, orphan) collapse to the same 404 response so an
 *      unauthenticated visitor cannot enumerate which condition fired.
 *  11. The 404 response body is the EXACT envelope
 *      `{ error: { code: 'SHARE_LINK_NOT_FOUND', message: 'Share link
 *      not found or expired' } }` — no token echo, no internal state.
 *
 * Pre-validation of :token path parameter:
 *  12. Returns 400 VALIDATION_TOKEN_MISSING when the path matches
 *      `/api/share/%20` (URL-encoded whitespace) — Express WILL bind
 *      to `:token` for whitespace-only segments; the route's pre-check
 *      catches this BEFORE the service is reached.
 *  13. The 400 response message is the laconic 'Token required' — does
 *      NOT echo the input or hint at the token's expected format.
 *  14. The service is NOT called when the pre-validation rejects the
 *      input.
 *
 * Error translation (Rule R8 fail-closed):
 *  15. Translates a service-layer ValidationError to 400 with the
 *      service's `code` and `message`.
 *  16. Translates a service-layer ValidationError WITHOUT code/message
 *      to 400 with the documented `??` fallbacks.
 *  17. Translates a service-layer NotFoundError to 404 with the
 *      service's `code` and `message`.
 *  18. Translates a service-layer NotFoundError WITHOUT code/message
 *      to 404 with the documented `??` fallbacks.
 *  19. Translates an unrecognised error to 500 INTERNAL_ERROR with the
 *      generic non-leaking envelope (no stack, no cause, no echoed
 *      body).
 *  20. Logs the unrecognised error via the request-scoped pino logger
 *      with bounded structural metadata only — message truncated to
 *      200 characters; no echoed body, no token, no credential
 *      material.
 *  21. Does NOT throw when `req.log` is absent (graceful degradation;
 *      Rule R8 fail-closed is preserved without pino-http wired in).
 *  22. Translates a malformed thrown value (e.g. `throw {}`) to 500
 *      INTERNAL_ERROR — the structural narrowing handles non-Error
 *      throws without re-throwing.
 *  23. Forwards an unhandled rejection in `runGetShare` (caused by a
 *      defective `req.log.error` spy that throws synchronously inside
 *      `handleRouteError`) through the sync handler's `.catch(next)`
 *      into Express's central error chain — Rule R8 fail-closed at
 *      the outer layer.
 *
 * Rule R2 verification (no token in logs / no credential material):
 *  24. The 500-INTERNAL_ERROR log call NEVER includes the path token,
 *      even when the rest of the request URL is reachable via
 *      `req.url`. The logged record's structural fields are limited
 *      to `event`, `errorName`, `errorCode`, `errorMessage`.
 *  25. The 400 / 404 response bodies NEVER echo the input token.
 *
 * Rule R9 verification (no settlement vocabulary in share.ts):
 *  26. The route source file contains zero matches for the AAP §0.8.1
 *      forbidden-vocabulary grep — defense-in-depth even though this
 *      route file is order-flow-adjacent and cannot legitimately need
 *      payment terminology.
 *
 * R6 verification (this file does NOT read req.uid in code):
 *  27. The route source file references `req.uid` ONLY in
 *      documentation comment lines — never in executable code. This
 *      pins the AAP requirement that `share.ts` is unauthenticated and
 *      cannot read the session-stamped uid.
 *
 * ============================================================================
 * Determinism (ST-043-AC3) and Locality (ST-043-AC4)
 * ============================================================================
 *
 *   - Zero network calls. `supertest(app)` drives Express via an
 *     in-memory ephemeral-port loopback that supertest manages; no
 *     external host, no DNS resolution.
 *   - Zero file-system access at test time except for the Rule R9 / R6
 *     greps which read this file's sibling `share.ts` source. Both
 *     reads are deterministic and pinned to the workspace tree.
 *   - Zero environment-variable reads. `share.ts` consumes no env
 *     vars directly.
 *   - The `ShareLinkService` dependency is replaced by a `jest.fn()`-
 *     backed shim built per test; no real database, repository, or
 *     pg pool.
 *   - The Jest config (`jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, `restoreMocks` to `true`, so jest.fn state is
 *     wiped between tests.
 *
 * @see backend/src/routes/share.ts — module under test
 * @see backend/src/routes/cart.test.ts — sibling pattern reference
 * @see backend/jest.config.unit.ts — Jest runner configuration
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
// `ShareLinkService` and `SharedDesignView` are type-only — the test
// substitutes a `jest.fn()`-backed shim and never instantiates the
// real service. The `import type` form satisfies the workspace's
// `@typescript-eslint/consistent-type-imports` rule.
//
// `createShareRoutes` and `CreateShareRoutesDeps` are runtime/named
// imports from the sibling `./share` module — the surface under test.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import type { ShareLinkService, SharedDesignView } from '../services/share-link.service';

import { createShareRoutes } from './share';
import type { CreateShareRoutesDeps } from './share';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * Minimal jest-mock-backed `ShareLinkService` shim.
 *
 * Only the `getByToken` method is consumed by `share.ts`; the other
 * methods are present as `jest.fn()` placeholders so the shim
 * satisfies the structural type contract. Each test overrides
 * `getByToken` with `mockResolvedValueOnce` / `mockRejectedValueOnce`
 * to produce the scenario under test.
 */
type ShareLinkServiceMock = {
  issue: jest.Mock;
  getByToken: jest.Mock;
  revoke: jest.Mock;
};

/**
 * Construct a fresh `ShareLinkServiceMock` for each test. Centralising
 * construction in a helper guarantees every test starts from the
 * same baseline — a `jest.fn()` with no implementation, no recorded
 * calls.
 */
function buildShareLinkService(): ShareLinkServiceMock {
  return {
    issue: jest.fn(),
    getByToken: jest.fn(),
    revoke: jest.fn(),
  };
}

/**
 * Optional logger spy injected as `req.log` to observe error
 * translator's structured log calls. Mirrors what pino-http does in
 * production but with a `jest.Mock` so the test can inspect the
 * args.
 */
type LogSpy = {
  error: jest.Mock;
};

/**
 * Construct an Express app with the share router mounted at the APP
 * ROOT (mirroring the production composition root in
 * `backend/src/index.ts`).
 *
 * CRUCIAL: this router is NOT mounted under `/api`. The route's
 * INTERNAL path string is the FULL `/api/share/:token`, so mounting
 * at the ROOT yields the production URL exactly. Mounting under
 * `/api` would produce `/api/api/share/:token` and break ST-029-AC3.
 *
 * The optional `attachLogger` flag installs a `req.log.error` spy at
 * the top of the chain so the error-translator's structured log
 * call can be observed. By design this app does NOT install any
 * session middleware — share is an UNAUTHENTICATED endpoint and
 * `req.uid` MUST NOT be required.
 */
function buildApp(opts: {
  shareLinkService: ShareLinkServiceMock;
  logSpy?: LogSpy;
}): express.Express {
  const app = express();

  // Optional req.log injector — mirrors what pino-http does in
  // production. When present, the error translator inside share.ts
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

  // Note the absence of any session-middleware simulator — `share.ts`
  // is unauthenticated by design (mounted BEFORE sessionMiddleware in
  // production per AAP §0.5.2). `req.uid` will be undefined, and the
  // share handler MUST NOT depend on it.
  const router = createShareRoutes({
    shareLinkService: opts.shareLinkService as unknown as ShareLinkService,
  });
  app.use(router);
  return app;
}

/**
 * Construct a typed `SharedDesignView` fixture. The shape matches
 * the service's projection contract and is stable across tests so
 * that assertions on response shape can compare against a single
 * canonical object.
 *
 * Fields intentionally absent: `ownerUid`, `userId`, `token`,
 * `expiresAt`, `revokedAt`, `createdAt` — the projection's static
 * type forbids them, and the runtime tests verify the response body
 * also lacks them.
 */
function buildSharedDesignView(): SharedDesignView {
  return {
    designId: 'design-uuid-001',
    title: 'Shared Configurator Design',
    lastModifiedAt: new Date('2025-01-15T10:30:00.000Z'),
    design: {
      primaryColor: '#FF0000',
      secondaryColor: '#00FF00',
      accentColor: '#0000FF',
      stitchingPattern: 'classic',
      finish: 'matte',
      logo: null,
    } as unknown as SharedDesignView['design'], // DesignPayload structure
  };
}

// ---------------------------------------------------------------------------
// Factory wiring
// ---------------------------------------------------------------------------

describe('createShareRoutes — factory wiring', () => {
  it('returns an Express Router when dependencies are valid', () => {
    const shareLinkService = buildShareLinkService();
    const router = createShareRoutes({
      shareLinkService: shareLinkService as unknown as ShareLinkService,
    });
    // Express Router instances are functions in addition to having
    // `use` / `get` / `post` methods. Asserting both confirms the
    // factory returned a real Router, not a structural impostor.
    expect(typeof router).toBe('function');
    expect(typeof (router as unknown as { use: unknown }).use).toBe('function');
    expect(typeof (router as unknown as { get: unknown }).get).toBe('function');
  });

  it('throws when deps argument is null', () => {
    expect(() => createShareRoutes(null as unknown as CreateShareRoutesDeps)).toThrow(
      /deps argument is required/,
    );
  });

  it('throws when deps argument is undefined', () => {
    expect(() => createShareRoutes(undefined as unknown as CreateShareRoutesDeps)).toThrow(
      /deps argument is required/,
    );
  });

  it('throws when deps argument is a non-object primitive', () => {
    // Defensive — JS callers using `any` casts could pass a primitive.
    expect(() => createShareRoutes('not-an-object' as unknown as CreateShareRoutesDeps)).toThrow(
      /deps argument is required/,
    );
  });

  it('throws when deps.shareLinkService is missing', () => {
    expect(() => createShareRoutes({} as unknown as CreateShareRoutesDeps)).toThrow(
      /shareLinkService dependency is required/,
    );
  });

  it('throws when deps.shareLinkService is null', () => {
    expect(() =>
      createShareRoutes({
        shareLinkService: null,
      } as unknown as CreateShareRoutesDeps),
    ).toThrow(/shareLinkService dependency is required/);
  });

  it('throws when deps.shareLinkService.getByToken is not a function', () => {
    const broken = { shareLinkService: { getByToken: 'not a function' } };
    expect(() => createShareRoutes(broken as unknown as CreateShareRoutesDeps)).toThrow(
      /shareLinkService must implement getByToken/,
    );
  });

  it('throws when deps.shareLinkService.getByToken is undefined', () => {
    const broken = { shareLinkService: { issue: jest.fn(), revoke: jest.fn() } };
    expect(() => createShareRoutes(broken as unknown as CreateShareRoutesDeps)).toThrow(
      /shareLinkService must implement getByToken/,
    );
  });

  it('produces independent routers across calls (no module-level singleton)', () => {
    const shareLinkServiceA = buildShareLinkService();
    const shareLinkServiceB = buildShareLinkService();
    const a = createShareRoutes({
      shareLinkService: shareLinkServiceA as unknown as ShareLinkService,
    });
    const b = createShareRoutes({
      shareLinkService: shareLinkServiceB as unknown as ShareLinkService,
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// GET /api/share/:token — ST-029-AC3 (success path; unauthenticated)
// ---------------------------------------------------------------------------

describe('GET /api/share/:token — ST-029-AC3 (success path; unauthenticated)', () => {
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;
  // A 256-bit base64url-shaped token mimicking the service's
  // `randomBytes(32).toString('base64url')` output (43 chars).
  const TEST_TOKEN = 'AbCdEf0123456789AbCdEf0123456789AbCdEf012345';

  beforeEach(() => {
    shareLinkService = buildShareLinkService();
    app = buildApp({ shareLinkService });
  });

  it('returns 200 with the SharedDesignView projection from the service', async () => {
    // Arrange — the service returns a fully populated SharedDesignView
    // for a valid, unexpired, unrevoked token whose underlying design
    // exists. ST-029-AC3 guarantees the response carries enough
    // information for the configurator to render the design read-only.
    const view = buildSharedDesignView();
    shareLinkService.getByToken.mockResolvedValueOnce(view);

    // Act
    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    // Assert — status 200 and the body matches the service's
    // projection. `lastModifiedAt` is serialised by `res.json`
    // through `Date.prototype.toJSON` to its ISO-8601 form.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      designId: 'design-uuid-001',
      title: 'Shared Configurator Design',
      lastModifiedAt: '2025-01-15T10:30:00.000Z',
      design: {
        primaryColor: '#FF0000',
        secondaryColor: '#00FF00',
        accentColor: '#0000FF',
        stitchingPattern: 'classic',
        finish: 'matte',
        logo: null,
      },
    });
  });

  it('forwards req.params.token verbatim into shareLinkService.getByToken', async () => {
    // ST-029-AC3 implementation pin: the route is a thin adapter; it
    // MUST forward the URL :token segment to the service unchanged.
    shareLinkService.getByToken.mockResolvedValueOnce(buildSharedDesignView());

    await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(shareLinkService.getByToken).toHaveBeenCalledTimes(1);
    expect(shareLinkService.getByToken).toHaveBeenCalledWith({
      token: TEST_TOKEN,
    });
  });

  it('does NOT require a session/uid — works with no session middleware', async () => {
    // ST-029-AC3 verbatim: "WITHOUT requiring the visitor to sign
    // in". The buildApp helper installs no session middleware, so
    // `req.uid` is undefined when the handler runs. The handler MUST
    // succeed regardless.
    shareLinkService.getByToken.mockResolvedValueOnce(buildSharedDesignView());

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(200);
    // The service was reached — session middleware did NOT block the
    // request despite being absent.
    expect(shareLinkService.getByToken).toHaveBeenCalledTimes(1);
  });

  it('does not include credential-shaped fields in the response body', async () => {
    // The SharedDesignView projection STATICALLY forbids `ownerUid`,
    // `userId`, `token`, `expiresAt`, `revokedAt`, `createdAt`. This
    // test pins the runtime contract — even if a future bug
    // introduced one of these fields into the service return, the
    // response body MUST still lack them.
    //
    // We additionally verify the bare token never appears anywhere
    // in the response body (Rule R2 information-hiding).
    shareLinkService.getByToken.mockResolvedValueOnce(buildSharedDesignView());

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(200);
    const bodyKeys = Object.keys(res.body as Record<string, unknown>);
    expect(bodyKeys).not.toContain('ownerUid');
    expect(bodyKeys).not.toContain('userId');
    expect(bodyKeys).not.toContain('token');
    expect(bodyKeys).not.toContain('expiresAt');
    expect(bodyKeys).not.toContain('revokedAt');
    expect(bodyKeys).not.toContain('createdAt');
    // The bare token MUST NOT appear anywhere in the body.
    expect(JSON.stringify(res.body)).not.toContain(TEST_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// GET /api/share/:token — ST-029-AC2/AC4 (enumeration defense; null → 404)
// ---------------------------------------------------------------------------

describe('GET /api/share/:token — ST-029-AC2/AC4 (null → unified 404)', () => {
  // The service contract: `getByToken` returns null for FOUR distinct
  // conditions (unknown token, revoked, expired, orphan). The route
  // collapses ALL FOUR to the same 404 to maximise information hiding
  // for the unauthenticated audience.
  const NULL_CAUSES = [
    'unknown token (no row)',
    'revoked link',
    'expired link',
    'orphan (FK target missing)',
  ] as const;

  it.each(NULL_CAUSES)(
    'returns 404 SHARE_LINK_NOT_FOUND when the service returns null (cause: %s)',
    async (_cause) => {
      const shareLinkService = buildShareLinkService();
      shareLinkService.getByToken.mockResolvedValueOnce(null);
      const app = buildApp({ shareLinkService });

      const res = await request(app).get('/api/share/some-token-value');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          code: 'SHARE_LINK_NOT_FOUND',
          message: 'Share link not found or expired',
        },
      });
    },
  );

  it('returns the EXACT 404 envelope (no extra fields, no token echo)', async () => {
    // Belt-and-braces: the body has exactly two top-level keys
    // (under `error`) — `code` and `message`. No `details`, no
    // `requestId`, no echoed input.
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockResolvedValueOnce(null);
    const app = buildApp({ shareLinkService });

    const res = await request(app).get('/api/share/probe-token-XYZ-9999');

    expect(res.status).toBe(404);
    const body = res.body as { error: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
    // The probed token MUST NOT appear in the response.
    expect(JSON.stringify(res.body)).not.toContain('probe-token-XYZ-9999');
  });
});

// ---------------------------------------------------------------------------
// GET /api/share/:token — pre-validation of empty/whitespace token
// ---------------------------------------------------------------------------

describe('GET /api/share/:token — pre-validation', () => {
  it('returns 400 VALIDATION_TOKEN_MISSING when the path matches /api/share/%20', async () => {
    // `%20` decodes to a single space. Express WILL bind to `:token`
    // for whitespace-only path segments — the service-layer validator
    // would reject this, but the route's pre-check fires first to
    // produce a faster, more descriptive 400 without a service
    // round-trip.
    const shareLinkService = buildShareLinkService();
    const app = buildApp({ shareLinkService });

    const res = await request(app).get('/api/share/%20');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_TOKEN_MISSING',
        message: 'Token required',
      },
    });
    // The service was NEVER reached — the pre-check tripped first.
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
  });

  it('returns 400 when the path matches /api/share/%20%20%20 (multi-space)', async () => {
    // Multiple URL-encoded spaces also decode to a whitespace-only
    // segment. The route's `token.trim() === ''` check catches it.
    const shareLinkService = buildShareLinkService();
    const app = buildApp({ shareLinkService });

    const res = await request(app).get('/api/share/%20%20%20');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_TOKEN_MISSING');
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
  });

  it('treats a tab-only token (%09) as missing', async () => {
    // Defense-in-depth: any whitespace-only token is rejected. The
    // `\t` character is URL-encoded as `%09` and decodes to a tab,
    // which `String.prototype.trim()` strips entirely.
    const shareLinkService = buildShareLinkService();
    const app = buildApp({ shareLinkService });

    const res = await request(app).get('/api/share/%09');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_TOKEN_MISSING');
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/share/:token — error translation (Rule R8 fail-closed)
// ---------------------------------------------------------------------------

describe('GET /api/share/:token — error translation (Rule R8 fail-closed)', () => {
  const TEST_TOKEN = 'error-translation-token-abcdef';

  it('translates a service-layer ValidationError to 400 with code/message', async () => {
    // Service-layer ValidationError has `name: 'ValidationError'`,
    // `code: '<service code>'`, and a fixed `message`. The route
    // translator MUST forward both `code` and `message` verbatim.
    const shareLinkService = buildShareLinkService();
    class FakeValidationError extends Error {
      public override readonly name = 'ValidationError';
      public readonly code = 'VALIDATION_TOKEN_FORMAT';
      public constructor(msg: string) {
        super(msg);
      }
    }
    shareLinkService.getByToken.mockRejectedValueOnce(
      new FakeValidationError('token has invalid format'),
    );
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_TOKEN_FORMAT',
        message: 'token has invalid format',
      },
    });
  });

  it('translates a ValidationError without code/message to 400 with documented fallbacks', async () => {
    // Defense-in-depth: a ValidationError with only `name` set MUST
    // surface the `??` fallbacks. Pins the documented behaviour:
    // missing code → 'VALIDATION_FAILED', missing message →
    // 'Invalid input'.
    const shareLinkService = buildShareLinkService();
    const minimalErr = { name: 'ValidationError' };
    shareLinkService.getByToken.mockRejectedValueOnce(minimalErr);
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input' },
    });
  });

  it('translates a service-layer NotFoundError to 404 with code/message', async () => {
    // Although `getByToken` uses null returns rather than throwing
    // NotFoundError today, a future refactor could throw it. The
    // route translates it to 404 with the service's code/message.
    const shareLinkService = buildShareLinkService();
    class FakeNotFoundError extends Error {
      public override readonly name = 'NotFoundError';
      public readonly code = 'DESIGN_NOT_FOUND';
      public constructor(msg: string) {
        super(msg);
      }
    }
    shareLinkService.getByToken.mockRejectedValueOnce(
      new FakeNotFoundError('design vanished after share-link issuance'),
    );
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'DESIGN_NOT_FOUND',
        message: 'design vanished after share-link issuance',
      },
    });
  });

  it('translates a NotFoundError without code/message to 404 with documented fallbacks', async () => {
    // Pins: missing code → 'NOT_FOUND', missing message → 'Resource
    // not found'.
    const shareLinkService = buildShareLinkService();
    const minimalErr = { name: 'NotFoundError' };
    shareLinkService.getByToken.mockRejectedValueOnce(minimalErr);
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });

  it('translates an unrecognised error to 500 INTERNAL_ERROR with non-leaking body', async () => {
    // Per Rule R8 (fail-closed): an unrecognised error MUST produce
    // a non-2xx response. Per the route's information-disclosure
    // posture (stricter for unauthenticated visitors than for the
    // authenticated routes), the body MUST NOT include the original
    // message, stack, or cause — only the generic 'Internal server
    // error'.
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly: pg socket EOF'),
    );
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
    // Original error details MUST NOT appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain('connection terminated');
    expect(JSON.stringify(res.body)).not.toContain('pg socket');
    // The token MUST NOT appear in the response body either.
    expect(JSON.stringify(res.body)).not.toContain(TEST_TOKEN);
  });

  it('logs unrecognised errors with bounded structural metadata via req.log.error', async () => {
    // The error translator uses `req.log.error(...)` to emit a
    // single bounded ERROR record with `event`, `errorName`,
    // `errorCode`, `errorMessage` (truncated to 200 chars). Per
    // Rule R2 the log MUST NOT contain credential material.
    const shareLinkService = buildShareLinkService();
    const logSpy: LogSpy = { error: jest.fn() };
    const longMessage = 'X'.repeat(500); // exceeds the 200-char cap
    const customErr = new Error(longMessage);
    Object.defineProperty(customErr, 'code', {
      value: 'PG_CONN_FAIL',
      enumerable: true,
    });
    shareLinkService.getByToken.mockRejectedValueOnce(customErr);
    const app = buildApp({ shareLinkService, logSpy });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs, logMsg] = logSpy.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(logMsg).toBe('share route error');
    expect(logArgs).toMatchObject({
      event: 'share.route.error',
      errorName: 'Error',
      errorCode: 'PG_CONN_FAIL',
    });
    // The message MUST be truncated to ≤ 200 characters.
    expect(typeof logArgs['errorMessage']).toBe('string');
    expect((logArgs['errorMessage'] as string).length).toBeLessThanOrEqual(200);
    // The token MUST NOT appear in any logged structural field.
    const allLoggedValues = JSON.stringify(logArgs);
    expect(allLoggedValues).not.toContain(TEST_TOKEN);
  });

  it('does not throw when req.log is absent (graceful degradation)', async () => {
    // If pino-http is not wired (e.g. in unit tests, in CLI tools,
    // in early bootstrap before middleware mounts), the route MUST
    // still produce a 500 — silently skipping the log call rather
    // than crashing.
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp({ shareLinkService /* no logSpy */ });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('translates a malformed thrown value (no name, no message) to 500 INTERNAL_ERROR', async () => {
    // Defense-in-depth: a non-Error throw value (e.g. `throw 42`,
    // `throw null`, `throw {}`) MUST produce a structured 500
    // response rather than crash the worker. The error translator's
    // structural narrowing (typeof checks against err.name,
    // err.message) handles this without a re-throw.
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockRejectedValueOnce({});
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('logs an unrecognised error with no message via req.log.error (errorMessage undefined branch)', async () => {
    // Defense-in-depth: an unrecognised error throw with no
    // `message` (e.g. `throw {}`) MUST still produce a structured
    // log call with `errorMessage: undefined`. Covers the `:
    // undefined` branch of the message-truncation ternary.
    const shareLinkService = buildShareLinkService();
    const logSpy: LogSpy = { error: jest.fn() };
    // A bare object — no name, no message, no code.
    shareLinkService.getByToken.mockRejectedValueOnce({});
    const app = buildApp({ shareLinkService, logSpy });

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    expect(res.status).toBe(500);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const [logArgs] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
    expect(logArgs).toMatchObject({
      event: 'share.route.error',
      errorName: undefined,
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it('forwards an unhandled rejection in runGetShare to Express next() (defensive .catch)', async () => {
    // The route wraps `runGetShare` in a sync handler with a
    // defensive `.catch(next)`. Under documented operation,
    // `runGetShare` never rejects — it converts every error into a
    // structured response via `handleRouteError`. This test
    // engineers a path where `handleRouteError` itself throws (by
    // installing a `req.log.error` that throws synchronously when
    // invoked DURING handleRouteError's execution). The thrown
    // value escapes runGetShare's catch and propagates through the
    // sync handler's `.catch(next)`, which forwards it to Express's
    // central error middleware — a Rule R8 fail-closed posture.
    const shareLinkService = buildShareLinkService();
    // The originating error — handleRouteError will fall through to
    // its 500 INTERNAL_ERROR branch and try to call `req.log.error`.
    shareLinkService.getByToken.mockRejectedValueOnce(new Error('original failure'));
    // The malicious log spy throws when invoked. Because this is
    // inside handleRouteError's (synchronous) 500 branch, the throw
    // propagates out of runGetShare's catch.
    const malformedLog: LogSpy = {
      error: jest.fn().mockImplementation(() => {
        throw new Error('log subsystem failure');
      }),
    };

    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const reqWithLog = req as Request & { log?: { error: jest.Mock } };
      reqWithLog.log = malformedLog;
      next();
    });
    // Install Express's terminal error middleware so the thrown
    // value lands as a 500 (Express's default error handler does
    // this when no other middleware catches it).
    const errorHandlerSpy = jest.fn(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ caught: true, message: err.message });
      },
    );
    const router = createShareRoutes({
      shareLinkService: shareLinkService as unknown as ShareLinkService,
    });
    app.use(router);
    app.use(errorHandlerSpy);

    const res = await request(app).get(`/api/share/${TEST_TOKEN}`);

    // The defensive catch forwarded the error to Express's chain;
    // our terminal error handler caught it and responded 500.
    expect(res.status).toBe(500);
    expect(errorHandlerSpy).toHaveBeenCalledTimes(1);
    expect(errorHandlerSpy.mock.calls[0]?.[0]?.message).toBe('log subsystem failure');
  });
});

// ---------------------------------------------------------------------------
// Rule R2 verification — no token in error response bodies or logs
// ---------------------------------------------------------------------------

describe('Rule R2 — no token leakage in responses or logs', () => {
  // The :token path parameter IS the credential — it grants read
  // access to a design without authentication. Rule R2 forbids
  // logging credential material, and the route's
  // information-disclosure posture also forbids echoing it in
  // response bodies. These tests pin both invariants.
  const SENTINEL_TOKEN = 'SENTINEL_CRED_TOKEN_99';

  it('the 404 response body does not echo the input token', async () => {
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockResolvedValueOnce(null);
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${SENTINEL_TOKEN}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL_TOKEN);
  });

  it('the 500 response body does not echo the input token', async () => {
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${SENTINEL_TOKEN}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL_TOKEN);
  });

  it('the structured log record does not contain the input token', async () => {
    const shareLinkService = buildShareLinkService();
    const logSpy: LogSpy = { error: jest.fn() };
    shareLinkService.getByToken.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp({ shareLinkService, logSpy });

    await request(app).get(`/api/share/${SENTINEL_TOKEN}`);

    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const allLoggedArgs = JSON.stringify(logSpy.error.mock.calls[0]);
    expect(allLoggedArgs).not.toContain(SENTINEL_TOKEN);
  });

  it('the 200 response body does not contain the input token', async () => {
    // Even on success, the SharedDesignView projection MUST NOT
    // include the bare token. The service's projection forbids
    // this statically; this test pins the runtime contract.
    const shareLinkService = buildShareLinkService();
    shareLinkService.getByToken.mockResolvedValueOnce(buildSharedDesignView());
    const app = buildApp({ shareLinkService });

    const res = await request(app).get(`/api/share/${SENTINEL_TOKEN}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// HTTP method scoping — only GET is bound to /api/share/:token
// ---------------------------------------------------------------------------
//
// The route file declares EXACTLY ONE handler:
//
//     router.get('/api/share/:token', ...);
//
// No `router.post`, `router.put`, `router.delete`, or `router.patch` is
// registered. Express's default behaviour for a path that has at least
// one matching method but not the requested one is to fall through to
// the next middleware (here: the catch-all 404 since the test app has
// no other routes), so non-GET requests should produce 404 or 405. The
// `agent_prompt`'s Phase 4 test matrix names this scoping explicitly,
// and the test pins the invariant against accidental future expansions
// of the share router (e.g. an admin "revoke via share token" verb that
// would dangerously expand the unauthenticated surface).
//
// Per AAP §0.7.2 / §0.5.2: this router is the ONE unauthenticated route
// under `/api/*`. Adding a non-GET handler here would silently expand
// the unauthenticated attack surface — this test pins the verb whitelist.
// ---------------------------------------------------------------------------

describe('GET /api/share/:token — HTTP method scoping', () => {
  // The route MUST only respond to GET. Other verbs reaching the same
  // path MUST NOT invoke the service (a defense-in-depth pin against
  // accidental future verb expansion that would expose
  // `shareLinkService.revoke` or `shareLinkService.issue` over the
  // unauthenticated surface).
  let shareLinkService: ShareLinkServiceMock;
  let app: express.Express;
  const TEST_TOKEN = 'method-scoping-token-abcdef';

  beforeEach(() => {
    shareLinkService = buildShareLinkService();
    app = buildApp({ shareLinkService });
  });

  it('rejects POST /api/share/:token with 404 or 405', async () => {
    const res = await request(app).post(`/api/share/${TEST_TOKEN}`).send();
    expect([404, 405]).toContain(res.status);
    // The service was NEVER reached — no method dispatch fired.
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
    expect(shareLinkService.issue).not.toHaveBeenCalled();
    expect(shareLinkService.revoke).not.toHaveBeenCalled();
  });

  it('rejects PUT /api/share/:token with 404 or 405', async () => {
    const res = await request(app).put(`/api/share/${TEST_TOKEN}`).send();
    expect([404, 405]).toContain(res.status);
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
    expect(shareLinkService.issue).not.toHaveBeenCalled();
    expect(shareLinkService.revoke).not.toHaveBeenCalled();
  });

  it('rejects DELETE /api/share/:token with 404 or 405', async () => {
    const res = await request(app).delete(`/api/share/${TEST_TOKEN}`).send();
    expect([404, 405]).toContain(res.status);
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
    expect(shareLinkService.issue).not.toHaveBeenCalled();
    expect(shareLinkService.revoke).not.toHaveBeenCalled();
  });

  it('rejects PATCH /api/share/:token with 404 or 405', async () => {
    // Defense-in-depth — PATCH is also not a registered verb.
    const res = await request(app).patch(`/api/share/${TEST_TOKEN}`).send();
    expect([404, 405]).toContain(res.status);
    expect(shareLinkService.getByToken).not.toHaveBeenCalled();
    expect(shareLinkService.issue).not.toHaveBeenCalled();
    expect(shareLinkService.revoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-file invariants — verified by reading share.ts off disk
// ---------------------------------------------------------------------------

describe('share.ts source-file invariants', () => {
  // Centralise the file read so every test in this block reads the
  // same source content. `path.join(__dirname, 'share.ts')` is
  // deterministic regardless of where Jest is invoked from.
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(path.join(__dirname, 'share.ts'), 'utf-8');
  });

  it('contains zero matches for the AAP §0.8.1 R9 forbidden vocabulary (Rule R9)', () => {
    // Rule R9 forbids settlement-processor vocabulary in
    // backend/src. Even though this route file is not order-flow
    // adjacent, applying the grep here is defense-in-depth — any
    // future refactor that pulls payment-related code into this
    // file would surface as a test failure.
    const forbidden = /stripe|braintree|paypal|payment_intent|charge/i;
    expect(source).not.toMatch(forbidden);
  });

  it('does not reference req.uid in executable code (only in documentation)', () => {
    // AAP requirement: this route is UNAUTHENTICATED and runs
    // BEFORE sessionMiddleware. It MUST NOT read `req.uid` because
    // `req.uid` is undefined when this handler runs. Documentation
    // comments may explain this constraint, but executable code
    // cannot reference `req.uid`.
    //
    // Strategy: scan each line; flag any line that contains
    // `req.uid` UNLESS the line begins (after whitespace) with a
    // comment marker (`//`, `*`, or `/*`). This permits the
    // explanatory comments documenting the constraint while
    // forbidding any executable reference.
    const lines = source.split('\n');
    const offendingLines: { lineNumber: number; content: string }[] = [];
    for (const [idx, line] of lines.entries()) {
      if (/\breq\.uid\b/.test(line)) {
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        if (!isComment) {
          offendingLines.push({ lineNumber: idx + 1, content: line });
        }
      }
    }
    expect(offendingLines).toEqual([]);
  });

  it('imports only from the allowed dependencies (express + share-link.service)', () => {
    // The schema's depends_on_files list permits exactly two import
    // sources: `express` (external) and
    // `../services/share-link.service` (internal type-only).
    // Any other import would violate the dependency whitelist.
    //
    // Strategy: extract every line beginning with `import` and
    // confirm the source string matches the whitelist.
    const importLines = source.split('\n').filter((line) => /^import\s/.test(line.trim()));

    expect(importLines.length).toBeGreaterThan(0);

    const ALLOWED_SOURCES = new Set(['express', '../services/share-link.service']);

    for (const line of importLines) {
      // Extract the quoted source string from `import ... from '...';`
      const match = line.match(/from\s+['"]([^'"]+)['"]/);
      // Lines like `import './tracing';` would have no `from` clause
      // — they would fail this assertion intentionally.
      expect(match).not.toBeNull();
      const importSource = (match as RegExpMatchArray)[1];
      expect(ALLOWED_SOURCES.has(importSource as string)).toBe(true);
    }
  });

  it('exports both the createShareRoutes function and the CreateShareRoutesDeps interface', () => {
    // Pins the file's public surface to match the schema's
    // `exports` array. Any accidental rename or removal would
    // surface here.
    expect(source).toMatch(/export\s+function\s+createShareRoutes\s*\(/);
    expect(source).toMatch(/export\s+interface\s+CreateShareRoutesDeps\b/);
  });

  it('declares the route path as the FULL /api/share/:token (not /share/:token)', () => {
    // Composition-root contract: the router is mounted at the APP
    // ROOT (NOT under `/api`), so the route's INTERNAL path string
    // is the full public URL. Mounting under `/api` would yield
    // `/api/api/share/:token` per AAP §0.5.2.
    expect(source).toMatch(/router\.get\(\s*['"]\/api\/share\/:token['"]/);
  });
});
