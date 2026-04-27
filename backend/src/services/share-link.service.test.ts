/**
 * Unit tests for `backend/src/services/share-link.service.ts`.
 *
 * Verifies the three exported methods on the `ShareLinkService` contract
 * (`issue`, `getByToken`, `revoke`) plus the factory's compose-time
 * validation, against the security and behavioural invariants documented
 * in the source file:
 *
 *   1. **Factory (compose-time validation)** — The factory eagerly
 *      rejects missing `shareLinkRepository` or `designRepository`
 *      dependencies so a misconfigured composition root fails LOUDLY
 *      at module-load time rather than subtly at first request.
 *
 *   2. **issue (ST-029-AC1 + ST-029-AC2)** — Validates input shape,
 *      verifies design ownership BEFORE any persist (per `findById`
 *      with `userId` filter), generates a cryptographically-strong
 *      256-bit token via `randomBytes(32)`, base64url-encodes the
 *      token (43 chars, `[A-Za-z0-9_-]+`, no padding), computes
 *      `expiresAt` server-side as `now() + 14 days` (NEVER from
 *      caller), and persists via `shareLinkRepository.insert` with
 *      a four-field record. Failure paths:
 *        - Empty `ownerUid` / `designId` → `ValidationError` (HTTP 400),
 *          repositories untouched (ST-029 input contract).
 *        - `findById` returns `null` (design absent or not owned) →
 *          `NotFoundError` (HTTP 404), `insert` NEVER called
 *          (ST-029-AC1 ownership gate).
 *        - Repository errors propagate (Rule R8 fail-closed).
 *
 *   3. **getByToken (ST-029-AC3 + ST-029-AC4)** — Validates input
 *      shape, looks up via `shareLinkRepository.findByToken`, then
 *      applies three validity gates (revoked, expired, orphan-design)
 *      that ALL return `null` so the route layer can map to HTTP
 *      404/410. Returns the read-side `SharedDesignView` projection
 *      ({ design: payload, designId, title, lastModifiedAt }) ONLY
 *      when the link is unknown=no, revoked=no, expired=no, AND the
 *      JOIN found the underlying design. Inclusive expiration
 *      boundary: `expiresAt <= now()` is treated as expired.
 *
 *   4. **revoke (ST-029-AC4)** — Validates input shape, delegates to
 *      `shareLinkRepository.revoke({ designId, ownerUid })` (the
 *      repository's atomic UPDATE provides the ownership check via
 *      its WHERE clause). Idempotent — a `revokedCount` of 0 is a
 *      successful no-op. Repository errors propagate.
 *
 *   5. **Cross-cut Rule R2 sweep** — After exercising every method,
 *      no logger argument contains the raw share-link token value.
 *      Pino's serializer allow-list is the production-time defense,
 *      but the FIRST line of defense is "the service never logs the
 *      token in the first place" — which is what the JSON.stringify
 *      sweep verifies for both `issue` and `getByToken`.
 *
 *   6. **Validation error contract** — Each method rejects empty
 *      inputs with `ValidationError`. Lookup failures (ownership /
 *      non-existence) bubble up as `NotFoundError` (HTTP 404) —
 *      distinct from `ValidationError` (HTTP 400).
 *
 *   7. **Token generation invariants (ST-029 Key Insight)** — The
 *      service MUST call `randomBytes(32)` (256 bits of entropy) and
 *      base64url-encode the result. The test file partially mocks
 *      `node:crypto` (preserving real entropy via `requireActual`)
 *      so the generated token has production shape AND we can assert
 *      `randomBytes.mock.calls` recorded a 32-byte invocation.
 *      Forbidden token shapes the suite explicitly rules out:
 *        - `design.id` as the token (enumerable).
 *        - Sequential counters (consecutive tokens share prefixes).
 *        - Standard base64 ('+'/'/'/'=') instead of base64url.
 *
 * Authority:
 *   - Story ST-029 acceptance criteria (share-link issuance with
 *     server-computed expiration, ownership gate, expiration/
 *     revocation read-side rejection, time-limited inoperability).
 *   - Story ST-043 acceptance criteria (deterministic, local-only,
 *     no-network unit suite with co-located `*.test.ts`).
 *   - AAP §0.7.1 (co-located unit tests per ST-043).
 *   - AAP §0.8.1 R2 (no credential material in logs — the share-link
 *     token is credential-like material because it grants read access
 *     to a design).
 *   - AAP §0.8.1 R3 (no JWT libraries in backend — token generation
 *     is via `randomBytes`, not a signed JWT).
 *   - AAP §0.8.1 R8 (gates fail closed — repository errors propagate).
 *
 * Determinism (ST-043-AC3):
 *   - Both repositories (`ShareLinkRepository`, `DesignRepository`)
 *     are replaced with `jest.fn()` mocks; no asynchronous boundary
 *     depends on external state.
 *   - `node:crypto` is partially mocked: `randomBytes` is wrapped by
 *     `jest.fn(actual.randomBytes)` so we keep REAL cryptographic
 *     entropy AND can inspect `mock.calls` to assert `randomBytes(32)`
 *     was called.
 *   - `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now()` so
 *     `new Date()` inside `issue()` matches a known wall clock.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and depends
 *   on ZERO services. Both repositories and pino are fully mocked;
 *   `node:crypto` is partially mocked but uses REAL `randomBytes` for
 *   entropy. No `pg.Pool`, no log transport, no external HTTP, no DB.
 *
 * @see backend/src/services/share-link.service.ts — module under test
 * @see backend/src/repositories/share-link.repository.ts — interface mocked
 * @see backend/src/repositories/design.repository.ts — interface mocked
 * @see backend/src/logging/pino.ts — module-mocked logger
 * @see tickets/stories/ST-029-share-link-issuance-endpoint.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// ---------------------------------------------------------------------------
// Type-only imports.
//
// The `consistent-type-imports` ESLint rule (declared at the
// repository root in `.eslintrc.json` with severity `error`) requires
// that imports used only in type positions are declared with
// `import type`. None of these symbols contribute runtime values —
// they only constrain the shape of `jest.Mocked<...>` generics and
// fixture builder return types.
// ---------------------------------------------------------------------------
import type * as NodeCrypto from 'node:crypto';
import type {
  ShareLinkRepository,
  ShareLink,
  ShareLinkWithDesign,
} from '../repositories/share-link.repository';
import type { DesignRepository, Design } from '../repositories/design.repository';

// ---------------------------------------------------------------------------
// Module mock — `node:crypto` (PARTIAL mock).
//
// `jest.mock` is HOISTED to the top of the module body by the Jest
// transformer, BEFORE any `import` statement. The factory below uses
// `jest.requireActual` so REAL cryptographic primitives remain
// available — only `randomBytes` is wrapped with `jest.fn(...)` to
// give the test suite an inspection handle on its call history.
// Wrapping the actual implementation (rather than returning fixed
// bytes) means the service emits a TRUE 256-bit entropy token in
// every test, which is exactly what the production code path
// produces. We can therefore assert on the token's structural shape
// (43-char base64url, no padding, /^[A-Za-z0-9_-]+$/) with full
// confidence that the assertion mirrors production behaviour.
// ---------------------------------------------------------------------------
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof NodeCrypto>('node:crypto');
  return {
    ...actual,
    randomBytes: jest.fn(actual.randomBytes),
  };
});

// ---------------------------------------------------------------------------
// Module mock — pino logger.
//
// `jest.mock` is hoisted to the top of the module body BEFORE any
// `import` statement. The mock exposes the four log levels the
// production code calls (`info`, `warn`, `error`, `debug`); each is
// a `jest.fn()` so the cross-cut Rule R2 sweep can inspect
// `logger.<level>.mock.calls`. We also stub `fatal`, `trace`, and
// `child(): logger` for robustness — the production share-link
// service does not invoke these, but stubbing makes the mock
// resilient to a future refactor that adds fatal-level logging or a
// child-logger pattern.
// ---------------------------------------------------------------------------
jest.mock('../logging/pino', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
}));

// ---------------------------------------------------------------------------
// Runtime imports — must come AFTER the `jest.mock` blocks above so
// that the mocked modules replace the real ones in the module
// registry. Each runtime symbol below is exercised by at least one
// test in this file.
// ---------------------------------------------------------------------------
import { randomBytes } from 'node:crypto';

import {
  createShareLinkService,
  NotFoundError,
  ValidationError,
} from './share-link.service';
import { logger } from '../logging/pino';

// ===========================================================================
// Test fixtures — deterministic constants used throughout the suite.
// ===========================================================================

/**
 * Stable wall-clock pin for the suite. All `issuedAt` / `expiresAt`
 * assertions compare against this fixed date (or a deterministic
 * offset thereof) so the suite remains deterministic across machines
 * and across second-boundaries (ST-043-AC3).
 *
 * The value is intentionally in the future (2026) so it cannot be
 * confused with any real-world timestamp by an operator skimming
 * test output during incident response.
 */
const FIXED_NOW: Date = new Date('2026-01-15T10:00:00.000Z');

/**
 * 14 days in milliseconds. Mirrors `SHARE_LINK_TTL_MS` in the source
 * file — duplicated here (rather than imported) because the test
 * suite verifies that the source file's policy is what we EXPECT,
 * so importing the same constant would tautologically pass even if
 * the source value changed. Test 8 asserts the service's
 * server-computed `expiresAt` equals `FIXED_NOW + FOURTEEN_DAYS_MS`,
 * giving us a true policy-pin assertion.
 */
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The wall-clock instant 14 days after `FIXED_NOW`. Test 8 and
 * Test 9 use this value to assert the `expiresAt` field passed to
 * `shareLinkRepository.insert` is the exact server-computed timestamp.
 */
const FIXED_EXPIRES_AT: Date = new Date(FIXED_NOW.getTime() + FOURTEEN_DAYS_MS);

/**
 * The canonical Firebase uid used as the "authenticated owner"
 * fixture across every happy-path test. Per AAP §0.2.1, the local
 * `users.id` IS the Firebase uid.
 */
const OWNER_UID = 'owner-uid';

/**
 * The canonical design UUID used in fixtures. Tests that need a
 * different id supply an override in `makeDesignFixture`.
 */
const DESIGN_ID = 'design-id-1';

// ===========================================================================
// Mock factories — produce strongly-typed `jest.Mocked<...>` instances
// of each repository so the test can `mockResolvedValueOnce`, inspect
// `mock.calls`, and use `mock.invocationCallOrder` for ordering
// assertions.
// ===========================================================================

/**
 * Build a fresh `jest.Mocked<ShareLinkRepository>`. Every method on
 * the `ShareLinkRepository` contract is replaced with `jest.fn()` so
 * the test can stub return values per-test via
 * `mockResolvedValueOnce`. Calling the factory inside each test
 * ensures call-history isolation.
 */
function makeShareLinkRepository(): jest.Mocked<ShareLinkRepository> {
  return {
    insert: jest.fn(),
    findByToken: jest.fn(),
    revoke: jest.fn(),
  } as unknown as jest.Mocked<ShareLinkRepository>;
}

/**
 * Build a fresh `jest.Mocked<DesignRepository>`. The share-link
 * service only uses `findById` (for the ownership gate in `issue`)
 * but we mock the entire surface so the type system cannot complain
 * that the mock object is structurally narrower than the contract.
 */
function makeDesignRepository(): jest.Mocked<DesignRepository> {
  return {
    insert: jest.fn(),
    listByUser: jest.fn(),
    findById: jest.fn(),
    updatePayload: jest.fn(),
  } as unknown as jest.Mocked<DesignRepository>;
}

// ===========================================================================
// Fixture builders — produce canonical, well-typed records.
// ===========================================================================

/**
 * Build a canonical `Design` record for use as the return value of
 * `designRepository.findById` in happy-path tests. Override fields
 * via the `overrides` argument when a specific test needs a non-
 * default shape.
 *
 * The `payload` shape mirrors the realistic shape stored in the
 * `designs.payload` JSONB column in production — three top-level
 * fields (`primaryColor`, `pattern`, `finish`) keep the test signal
 * focused without implying a richer contract. Test 13 reads exactly
 * these three fields when asserting the read-side `getByToken`
 * result.
 */
function makeDesignFixture(overrides: Partial<Design> = {}): Design {
  return {
    id: DESIGN_ID,
    userId: OWNER_UID,
    title: 'Red Ball',
    payload: { primaryColor: '#FF0000', pattern: 'classic', finish: 'matte' },
    createdAt: FIXED_NOW,
    lastModifiedAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * Build a canonical `ShareLink` record for use as the return value
 * of `shareLinkRepository.insert` in happy-path tests. The default
 * `expiresAt` matches `FIXED_NOW + 14 days` so a test can chain the
 * fixture without overriding when only the issuance path matters.
 */
function makeShareLinkFixture(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    token: 'fixture-token',
    designId: DESIGN_ID,
    ownerUid: OWNER_UID,
    issuedAt: FIXED_NOW,
    expiresAt: FIXED_EXPIRES_AT,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Build a canonical `ShareLinkWithDesign` (the JOIN-result row
 * returned by `shareLinkRepository.findByToken`). Combines a
 * `makeShareLinkFixture()` base with a `makeDesignFixture()` design
 * payload. Test 17 (orphan-design defensive case) supplies the row
 * directly with `design: null` rather than calling this builder
 * because that test specifically inverts the canonical invariant.
 */
function makeShareLinkWithDesignFixture(
  overrides: Partial<ShareLinkWithDesign> = {},
): ShareLinkWithDesign {
  const baseLink = makeShareLinkFixture(overrides);
  return {
    ...baseLink,
    design: overrides.design === undefined ? makeDesignFixture() : overrides.design,
  };
}

// ===========================================================================
// Lifecycle hooks.
//
// `useFakeTimers({ now: FIXED_NOW })` — pins `Date.now()` and
// `new Date()` to FIXED_NOW for every test in this file. This is the
// foundation of ST-043-AC3 determinism for `expiresAt` assertions.
//
// `clearAllMocks()` is redundant given `jest.config.unit.ts` sets
// `clearMocks: true`, but the AAP plan explicitly calls for the
// invocation as a belt-and-suspenders measure.
//
// **Critical** — `jest.config.unit.ts` also sets `resetMocks: true`,
// which wipes mock IMPLEMENTATIONS (not just call history) before
// every test. The `jest.fn(actual.randomBytes)` defined in the
// module mock factory above is therefore stripped of its
// implementation between tests, leaving a bare `jest.fn()` that
// returns `undefined` and crashes the service's
// `randomBytes(32).toString('base64url')` line. We re-apply the real
// implementation in `beforeEach` so every test observes a working
// `randomBytes` that returns true 256-bit entropy. The
// `jest.requireActual` call resolves to Node's built-in crypto and
// is cheap (Jest caches the actual module).
// ===========================================================================

beforeEach(() => {
  jest.useFakeTimers({ now: FIXED_NOW });
  jest.clearAllMocks();

  // Restore the real `randomBytes` implementation that
  // `jest.config.unit.ts`'s `resetMocks: true` strips between
  // tests. Without this restoration, the service's call to
  // `randomBytes(32)` returns `undefined` and throws
  // `Cannot read properties of undefined (reading 'toString')`.
  const actualCrypto = jest.requireActual<typeof NodeCrypto>('node:crypto');
  (randomBytes as jest.MockedFunction<typeof randomBytes>).mockImplementation(
    actualCrypto.randomBytes,
  );
});

afterEach(() => {
  jest.useRealTimers();
});

// ===========================================================================
// Test cases.
// ===========================================================================

describe('createShareLinkService', () => {
  // -------------------------------------------------------------------------
  // describe('factory') — Tests 1-2.
  //
  // The factory is the composition-root constructor. Compose-time
  // validation is non-negotiable: the service is wired exactly once
  // at process start, so any misconfiguration MUST fail loudly with
  // a descriptive error rather than letting a `Cannot read
  // properties of undefined (reading 'insert')` surface at first
  // request.
  // -------------------------------------------------------------------------
  describe('factory', () => {
    it('returns an object with issue, getByToken, and revoke methods', () => {
      // Arrange — both deps are required and present.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act — construct the service.
      const service = createShareLinkService({ shareLinkRepository, designRepository });

      // Assert — the returned shape exposes exactly the three
      // contract methods, each as a callable function.
      expect(typeof service.issue).toBe('function');
      expect(typeof service.getByToken).toBe('function');
      expect(typeof service.revoke).toBe('function');
    });

    it('throws when shareLinkRepository is missing', () => {
      // Arrange — only one of two required deps is present.
      const designRepository = makeDesignRepository();

      // Act + Assert — passing `undefined` (cast through the dep
      // type so TS doesn't reject the literal) MUST trigger an
      // error mentioning the missing dep by name.
      expect(() =>
        createShareLinkService({
          shareLinkRepository: undefined as unknown as ShareLinkRepository,
          designRepository,
        }),
      ).toThrow(/shareLinkRepository/);
    });

    it('throws when designRepository is missing', () => {
      // Arrange — only the share-link repo is present.
      const shareLinkRepository = makeShareLinkRepository();

      // Act + Assert — same pattern as the previous test, this
      // time for the design repo. Both deps are mandatory.
      expect(() =>
        createShareLinkService({
          shareLinkRepository,
          designRepository: undefined as unknown as DesignRepository,
        }),
      ).toThrow(/designRepository/);
    });
  });

  // -------------------------------------------------------------------------
  // describe('issue') — Tests 3-12.
  //
  // Issuance is the security-critical path: it produces a token
  // that grants ANY holder read-only access to the design's
  // contents. The eleven tests below cover ownership gating
  // (ST-029-AC1), token entropy & shape (ST-029 Key Insight),
  // server-computed expiration (ST-029-AC2), repository contract,
  // input validation, error propagation (Rule R8), and credential-
  // hygiene (Rule R2).
  // -------------------------------------------------------------------------
  describe('issue', () => {
    it('ST-029-AC1: verifies design is owned by the user before issuing', async () => {
      // Arrange — design is owned by the caller; insert succeeds.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      shareLinkRepository.insert.mockResolvedValueOnce(makeShareLinkFixture());

      // Act — issue a share link.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — `findById` was called with the SAME ownerUid
      // (mapped to the `userId` parameter on DesignRepository) so
      // the SQL filter `WHERE id=$1 AND user_id=$2` is enforced.
      // A naive implementation that fetched by id alone would
      // let an attacker share another user's design.
      expect(designRepository.findById).toHaveBeenCalledWith({
        userId: OWNER_UID,
        designId: DESIGN_ID,
      });

      // Assert — `findById` was called BEFORE `insert`. Jest's
      // `mock.invocationCallOrder` array captures a strictly-
      // increasing global call counter for each mock invocation;
      // comparing the two values verifies the ownership check
      // strictly precedes the persist. (No built-in
      // `toHaveBeenCalledBefore` matcher exists in Jest 29.)
      const findByIdOrder = designRepository.findById.mock.invocationCallOrder[0];
      const insertOrder = shareLinkRepository.insert.mock.invocationCallOrder[0];
      expect(findByIdOrder).toBeDefined();
      expect(insertOrder).toBeDefined();
      expect(findByIdOrder).toBeLessThan(insertOrder!);
    });

    it('ST-029-AC1: throws NotFoundError when design does not exist or is not owned by user', async () => {
      // Arrange — `findById` returns null. The two failure modes
      // (design absent / design owned by someone else) are
      // indistinguishable at the SQL filter level — both produce
      // `null` from `findById({ userId, designId })` because the
      // WHERE clause requires both predicates. The service
      // treats them identically, returning HTTP 404 from the
      // route layer so an attacker cannot discriminate "exists
      // but not yours" from "doesn't exist".
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(null);

      // Act — attempt to issue a share link as an unrelated uid.
      const service = createShareLinkService({ shareLinkRepository, designRepository });

      // Assert — the rejection is `NotFoundError`, NOT a generic
      // `Error` and NOT `ValidationError`. The route layer
      // discriminates between these classes to produce the right
      // HTTP status (404 vs 400 vs 500).
      await expect(
        service.issue({ ownerUid: 'attacker-uid', designId: 'stranger-design' }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Assert — `insert` was NEVER called. This is the most
      // important security invariant on this code path: a
      // failed ownership check must not produce a database side
      // effect. If a future refactor reordered the calls, this
      // assertion catches it.
      expect(shareLinkRepository.insert).not.toHaveBeenCalled();
    });

    it('ST-029 Key Insight: generates cryptographically-strong random token (crypto.randomBytes(32) base64url)', async () => {
      // Arrange — happy path; capture whatever token the service
      // generated by reading `params.token` inside the insert
      // mock implementation.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());

      let capturedToken: string | undefined;
      shareLinkRepository.insert.mockImplementationOnce(async (params) => {
        capturedToken = params.token;
        return makeShareLinkFixture({ token: params.token });
      });

      // Act — issue once.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — token is non-empty.
      expect(capturedToken).toBeDefined();

      // Assert — base64url(32 bytes) yields exactly 43 chars.
      // The lower bound (42) tolerates an off-by-one in
      // base64url's no-padding length math; the upper bound (44)
      // tolerates a future implementation that uses 33-byte
      // input. Both bounds are tight enough to reject any
      // "short" token (e.g. an 8-byte counter encoded base64url
      // is 11 chars).
      expect(capturedToken!.length).toBeGreaterThanOrEqual(42);
      expect(capturedToken!.length).toBeLessThanOrEqual(44);

      // Assert — base64url alphabet is exclusively `[A-Za-z0-9_-]`.
      // Any '+' or '/' would indicate standard base64 (which
      // breaks URL safety); any '=' would indicate base64
      // padding (which the URL-safe variant omits).
      expect(capturedToken).toMatch(/^[A-Za-z0-9_-]+$/);

      // Assert — explicit no-padding check (defense-in-depth on
      // top of the alphabet regex above).
      expect(capturedToken).not.toContain('=');
    });

    it('calls randomBytes(32) for 256-bit token entropy', async () => {
      // Arrange — happy path. We don't care about the resulting
      // token here; we care about the `randomBytes` mock's
      // call history.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      shareLinkRepository.insert.mockResolvedValueOnce(makeShareLinkFixture());

      // Cast the imported `randomBytes` (which Jest replaced with
      // `jest.fn(actual.randomBytes)` per the module mock at the
      // top of this file) to its `MockedFunction` form so
      // `mock.calls` is type-correct.
      const randomBytesMock = randomBytes as unknown as jest.MockedFunction<
        (size: number) => Buffer
      >;

      // Act — issue once.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — at least one call to `randomBytes` used 32 as
      // its size argument. We use `.some` rather than `.every`
      // because a future refactor might add additional crypto
      // calls (e.g. an HMAC) but the 32-byte token call must
      // ALWAYS be present.
      const called32 = randomBytesMock.mock.calls.some(
        (args) => (args[0] as number) === 32,
      );
      expect(called32).toBe(true);
    });

    it('does NOT use design.id as the token (enumerable)', async () => {
      // Arrange — design with a known id. We capture the token
      // and assert it's structurally distinct from the id. A
      // common mistake (treating the design id as a "share
      // token") would let an attacker enumerate every design by
      // guessing UUIDs.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      const design = makeDesignFixture({ id: DESIGN_ID });
      designRepository.findById.mockResolvedValueOnce(design);

      let capturedToken: string | undefined;
      shareLinkRepository.insert.mockImplementationOnce(async (params) => {
        capturedToken = params.token;
        return makeShareLinkFixture({ token: params.token });
      });

      // Act — issue once.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — token is neither equal to nor a substring
      // containing the design id.
      expect(capturedToken).not.toBe(DESIGN_ID);
      expect(capturedToken).not.toContain(DESIGN_ID);
    });

    it('does NOT use a sequential counter as the token (enumerable)', async () => {
      // Arrange — three back-to-back issuances of the same
      // design. A sequential implementation would produce
      // tokens like `share_001`, `share_002`, `share_003` —
      // all sharing the same prefix. base64url(randomBytes(32))
      // yields uniformly random tokens with negligible (1 in
      // 2^24+) probability of any 4-char prefix collision.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValue(makeDesignFixture());

      const tokens: string[] = [];
      shareLinkRepository.insert.mockImplementation(async (params) => {
        tokens.push(params.token);
        return makeShareLinkFixture({ token: params.token });
      });

      // Act — issue three times.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — all three tokens are pairwise distinct (a Set
      // of three identical values would have size 1).
      expect(new Set(tokens).size).toBe(3);

      // Assert — no two tokens share a 4-char prefix. With a
      // 64-symbol alphabet this collision rate is < 1 in
      // 64^4 = ~1.6e7, so a flake from this assertion would
      // signal a real bug in the entropy source.
      expect(tokens[0]!.substring(0, 4)).not.toBe(tokens[1]!.substring(0, 4));
      expect(tokens[1]!.substring(0, 4)).not.toBe(tokens[2]!.substring(0, 4));
      expect(tokens[0]!.substring(0, 4)).not.toBe(tokens[2]!.substring(0, 4));
    });

    it('ST-029-AC2: sets expiresAt = now() + 14 days (server-computed)', async () => {
      // Arrange — happy path; capture `expiresAt` from the
      // insert mock.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());

      let capturedExpiresAt: Date | undefined;
      shareLinkRepository.insert.mockImplementationOnce(async (params) => {
        capturedExpiresAt = params.expiresAt;
        return makeShareLinkFixture({ expiresAt: params.expiresAt });
      });

      // Act — issue.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — captured `expiresAt` is exactly 14 days after
      // `FIXED_NOW`. The Date instance equality check via
      // `toEqual` works because both sides are Date objects and
      // Jest deep-compares by `.getTime()`.
      expect(capturedExpiresAt).toEqual(FIXED_EXPIRES_AT);

      // Assert — within 1ms of FIXED_NOW + 14 days. (A timing
      // skew this small would only occur if the service
      // re-derived the timestamp from the wall clock between
      // measurements, which fake timers prevent.)
      const diff = Math.abs(capturedExpiresAt!.getTime() - FIXED_EXPIRES_AT.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('calls shareLinkRepository.insert with { token, designId, ownerUid, expiresAt }', async () => {
      // Arrange — happy path with a deterministic insert return
      // value so the service produces a verifiable result.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      shareLinkRepository.insert.mockResolvedValueOnce(makeShareLinkFixture());

      // Act — issue.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — insert was called exactly once.
      expect(shareLinkRepository.insert).toHaveBeenCalledTimes(1);

      // Assert — the call's first argument is an object whose
      // shape matches the contract: { token, designId,
      // ownerUid, expiresAt }. We use `toMatchObject` for the
      // three deterministic fields and check `token` shape
      // separately (since it's random).
      const insertArgs = shareLinkRepository.insert.mock.calls[0]![0];
      expect(insertArgs).toMatchObject({
        designId: DESIGN_ID,
        ownerUid: OWNER_UID,
        expiresAt: FIXED_EXPIRES_AT,
      });
      expect(typeof insertArgs.token).toBe('string');
      expect(insertArgs.token.length).toBeGreaterThanOrEqual(42);

      // Assert — the service returned the exact record from
      // the repository (it does not transform or strip
      // fields). The route layer is responsible for projecting
      // a public shape if needed.
      expect(result.designId).toBe(DESIGN_ID);
      expect(result.ownerUid).toBe(OWNER_UID);
      expect(result.expiresAt).toEqual(FIXED_EXPIRES_AT);
    });

    it('rejects empty ownerUid', async () => {
      // Arrange — neither repo should be touched.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act + Assert — `ValidationError` (HTTP 400 semantics).
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.issue({ ownerUid: '', designId: 'd' }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Assert — input validation MUST short-circuit BEFORE
      // any I/O. A naive implementation that called
      // `findById` first would produce a confusing 500 error
      // when the empty uid hits the SQL UUID parser.
      expect(designRepository.findById).not.toHaveBeenCalled();
      expect(shareLinkRepository.insert).not.toHaveBeenCalled();
    });

    it('rejects empty designId', async () => {
      // Arrange — symmetric to the previous test, this time
      // for the designId parameter.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act + Assert — `ValidationError`.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.issue({ ownerUid: 'o', designId: '' }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Assert — short-circuited.
      expect(designRepository.findById).not.toHaveBeenCalled();
      expect(shareLinkRepository.insert).not.toHaveBeenCalled();
    });

    it('Rule R8: propagates errors from shareLinkRepository.insert (no silent swallow)', async () => {
      // Arrange — design exists; insert fails with a Postgres
      // unique-constraint violation. The service must let the
      // error bubble — silently catching DB errors and
      // returning a fake success would be a Rule R8 violation
      // and would corrupt the audit trail.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());
      const dbErr = Object.assign(new Error('unique constraint violation'), {
        code: '23505',
      });
      shareLinkRepository.insert.mockRejectedValueOnce(dbErr);

      // Act + Assert — error message bubbles unchanged.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID }),
      ).rejects.toThrow(/unique constraint/);
    });

    it('Rule R8: propagates errors from designRepository.findById', async () => {
      // Arrange — `findById` rejects with a transport-level
      // error (e.g. the connection pool's connection was
      // terminated). The service must NOT swallow this error
      // because the route layer needs to know to return 5xx
      // (vs the 404 it would otherwise return for a `null`
      // result).
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockRejectedValueOnce(new Error('connection terminated'));

      // Act + Assert — error message bubbles unchanged.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID }),
      ).rejects.toThrow(/connection terminated/);
    });

    it('Rule R2: the raw token value is never logged', async () => {
      // Arrange — happy path; capture the actual token the
      // service generated.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      designRepository.findById.mockResolvedValueOnce(makeDesignFixture());

      let capturedToken: string | undefined;
      shareLinkRepository.insert.mockImplementationOnce(async (params) => {
        capturedToken = params.token;
        return makeShareLinkFixture({ token: params.token });
      });

      // Act — issue. This is the operation that produces the
      // token, so any leak would happen on this code path.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.issue({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — sweep every call across every log level and
      // confirm the raw token does not appear in any
      // serialized form. This catches accidental leaks even
      // if the developer logs the token under a non-standard
      // key (`{shared: <token>}`) that the pino serializer
      // allow-list wouldn't redact.
      const allLogArgs = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
        ...(logger.debug as jest.Mock).mock.calls,
      ];
      const serialized = JSON.stringify(allLogArgs);
      expect(capturedToken).toBeDefined();
      expect(serialized).not.toContain(capturedToken!);
    });
  });


  // -------------------------------------------------------------------------
  // describe('getByToken') — Tests 13-20.
  //
  // Read-side validation. The service applies three rejection
  // gates (revoked, expired, orphan-design) that ALL return null
  // so the route layer can map to HTTP 404/410 without a stack
  // trace. The "design" field of the success result is the
  // payload (DesignPayload), NOT a Design object — the read-side
  // projection is `SharedDesignView = { design: payload,
  // designId, title, lastModifiedAt }`.
  // -------------------------------------------------------------------------
  describe('getByToken', () => {
    it('ST-029-AC3: returns { design } for a valid, unexpired, not-revoked token', async () => {
      // Arrange — link is valid, unexpired (1 minute in the
      // future), and not revoked. The JOIN found the underlying
      // design.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(
        makeShareLinkWithDesignFixture({
          expiresAt: new Date(FIXED_NOW.getTime() + 60 * 1000),
          revokedAt: null,
        }),
      );

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'valid-token' });

      // Assert — non-null result with the read-side projection
      // shape. The `design` field is the PAYLOAD (DesignPayload),
      // NOT a `Design` object — production projects only the
      // payload to the unauthenticated client because the user-id
      // and timestamps are not the unauthenticated viewer's
      // business.
      expect(result).not.toBeNull();
      expect(result!.design).toEqual(
        expect.objectContaining({
          primaryColor: '#FF0000',
          pattern: 'classic',
          finish: 'matte',
        }),
      );
    });

    it('ST-029-AC2: returns null when token is expired', async () => {
      // Arrange — link is unrevoked but expired (1 minute in
      // the past). The route layer translates this null into a
      // 410 Gone (or 404 Not Found, per its own contract).
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(
        makeShareLinkWithDesignFixture({
          expiresAt: new Date(FIXED_NOW.getTime() - 60 * 1000),
          revokedAt: null,
        }),
      );

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'expired-token' });

      // Assert — null. The service does NOT throw an error here
      // because "link expired" is a legitimate end-user signal,
      // not a bug.
      expect(result).toBeNull();
    });

    it('ST-029-AC4: returns null when token is revoked', async () => {
      // Arrange — link is unexpired but revoked (revokedAt set
      // 30 seconds ago, before `FIXED_NOW`). Per ST-029-AC4,
      // revoking a link renders it inoperable.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(
        makeShareLinkWithDesignFixture({
          expiresAt: new Date(FIXED_NOW.getTime() + 60 * 1000),
          revokedAt: new Date(FIXED_NOW.getTime() - 30 * 1000),
        }),
      );

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'revoked-token' });

      // Assert — null. The route maps to 410 Gone.
      expect(result).toBeNull();
    });

    it('returns null when token does not exist', async () => {
      // Arrange — `findByToken` returns null because no row
      // matched. This is the "you typed the URL wrong" case.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(null);

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'nonexistent-token' });

      // Assert — null. The service forwards the repository's
      // null verbatim; no exception, no logging warmth.
      expect(result).toBeNull();
    });

    it('returns null when the share link row exists but the design has been deleted', async () => {
      // Arrange — defensive case. If referential integrity is
      // loose (e.g. design was deleted but the share-link row
      // wasn't cleaned up), the JOIN returns design=null. The
      // service treats this as "not found" rather than crashing
      // on a null dereference.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce({
        token: 'token',
        designId: 'orphan-design',
        ownerUid: OWNER_UID,
        issuedAt: FIXED_NOW,
        expiresAt: new Date(FIXED_NOW.getTime() + 60 * 1000),
        revokedAt: null,
        design: null,
      });

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'token' });

      // Assert — null. Defense in depth at the service layer.
      expect(result).toBeNull();
    });

    it('rejects empty token', async () => {
      // Arrange — neither repo should be touched.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act + Assert — `ValidationError` (HTTP 400 semantics).
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(service.getByToken({ token: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );

      // Assert — short-circuited before any I/O.
      expect(shareLinkRepository.findByToken).not.toHaveBeenCalled();
    });

    it('treats expiresAt === now() as expired (inclusive boundary)', async () => {
      // Arrange — `expiresAt` is exactly `FIXED_NOW`. Per the
      // source's `row.expiresAt.getTime() <= now.getTime()`
      // check, the boundary is INCLUSIVE: the link is treated
      // as expired the very moment the clock ticks past the
      // pinned instant. (An exclusive boundary would let
      // someone race-condition a one-millisecond extension by
      // making the request at the same wall-clock moment as
      // expiration.)
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(
        makeShareLinkWithDesignFixture({
          expiresAt: FIXED_NOW,
          revokedAt: null,
        }),
      );

      // Act — read.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const result = await service.getByToken({ token: 'boundary-token' });

      // Assert — null (expired, inclusive boundary).
      expect(result).toBeNull();
    });

    it('Rule R2: getByToken never logs the raw token value', async () => {
      // Arrange — valid happy-path link.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.findByToken.mockResolvedValueOnce(
        makeShareLinkWithDesignFixture({
          expiresAt: new Date(FIXED_NOW.getTime() + 60 * 1000),
          revokedAt: null,
        }),
      );

      // Act — read with a known-distinct token value.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      const rawToken = 'secret-token-abc123';
      await service.getByToken({ token: rawToken });

      // Assert — the raw token does not appear in any log
      // call across any level. The token in this test is
      // synthetically distinctive so a bare `logger.info(token)`
      // by a future maintainer would absolutely fail this
      // assertion.
      const allLogArgs = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
        ...(logger.debug as jest.Mock).mock.calls,
      ];
      const serialized = JSON.stringify(allLogArgs);
      expect(serialized).not.toContain(rawToken);
    });
  });


  // -------------------------------------------------------------------------
  // describe('revoke') — Tests 21-24.
  //
  // Revocation marks every active share link for a design as
  // revoked. The repository's atomic UPDATE provides ownership
  // safety via a WHERE clause that requires both `designId` AND
  // `ownerUid`, so the service does NOT need to pre-check via
  // `designRepository.findById`. Idempotent — revoking when
  // there's nothing to revoke (zero rows affected) is a
  // successful no-op.
  // -------------------------------------------------------------------------
  describe('revoke', () => {
    it('delegates revocation to the repository', async () => {
      // Arrange — repository reports it revoked 2 rows. The
      // service ignores the count (its return type is
      // `Promise<void>`) but the repo always returns it for
      // potential audit/debug use.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.revoke.mockResolvedValueOnce({ revokedCount: 2 });

      // Act — revoke.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await service.revoke({ ownerUid: OWNER_UID, designId: DESIGN_ID });

      // Assert — repository was invoked with EXACTLY the
      // service-level params. Note the parameter shape uses
      // `ownerUid` (NOT `userId`) — this is the
      // RevokeShareLinkParams contract on
      // ShareLinkRepository.
      expect(shareLinkRepository.revoke).toHaveBeenCalledWith({
        ownerUid: OWNER_UID,
        designId: DESIGN_ID,
      });
    });

    it('rejects empty ownerUid', async () => {
      // Arrange — repo should not be touched.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act + Assert — `ValidationError` (HTTP 400).
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.revoke({ ownerUid: '', designId: 'd' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(shareLinkRepository.revoke).not.toHaveBeenCalled();
    });

    it('rejects empty designId', async () => {
      // Arrange — repo should not be touched.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();

      // Act + Assert — `ValidationError` (HTTP 400).
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.revoke({ ownerUid: 'o', designId: '' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(shareLinkRepository.revoke).not.toHaveBeenCalled();
    });

    it('is idempotent — revoking zero matching links returns without error', async () => {
      // Arrange — no active links exist for this owner+design
      // pair (e.g. they were already revoked in a prior call,
      // or none ever existed). The repository UPDATE matched 0
      // rows.
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.revoke.mockResolvedValueOnce({ revokedCount: 0 });

      // Act — revoke.
      const service = createShareLinkService({ shareLinkRepository, designRepository });

      // Assert — the call resolves without throwing. The
      // service treats "0 rows affected" as a successful no-op
      // because the desired post-condition ("no active links
      // remain for this design") is already satisfied. This is
      // the correct shape for an idempotent revocation API.
      await expect(
        service.revoke({ ownerUid: OWNER_UID, designId: 'design-without-links' }),
      ).resolves.toBeUndefined();
    });

    it('Rule R8: propagates errors from shareLinkRepository.revoke', async () => {
      // Arrange — repository fails with a transport-level
      // error. The service must NOT swallow this error
      // because the caller needs to know the revocation did
      // not actually happen (so it can retry, alert, or
      // surface a 5xx to the user).
      const shareLinkRepository = makeShareLinkRepository();
      const designRepository = makeDesignRepository();
      shareLinkRepository.revoke.mockRejectedValueOnce(new Error('DB connection lost'));

      // Act + Assert — error message bubbles unchanged.
      const service = createShareLinkService({ shareLinkRepository, designRepository });
      await expect(
        service.revoke({ ownerUid: OWNER_UID, designId: DESIGN_ID }),
      ).rejects.toThrow(/DB connection lost/);
    });
  });
});

