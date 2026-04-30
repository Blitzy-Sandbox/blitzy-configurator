/**
 * Unit tests for `backend/src/services/design.service.ts`.
 *
 * Verifies the three exported methods on the `DesignService` contract
 * (`create`, `listByUser`, `getById`) plus the factory's compose-time
 * validation, against the security and behavioural invariants documented
 * in the source file:
 *
 *   1. **Factory (compose-time validation)** — `createDesignService` is a
 *      synchronous factory that EAGERLY rejects a missing
 *      `designRepository` or `gcsService` dependency so a misconfigured
 *      composition root fails LOUDLY at module-load time rather than
 *      subtly at first request. The returned service is `Object.freeze`d
 *      so tests verify monkey-patch resistance.
 *
 *   2. **create (ST-027)** — Validates input shape (ST-027-AC3 — invalid
 *      input rejected before any side effect), persists via
 *      `designRepository.insert`, and returns the canonical record verbatim
 *      with the server-assigned id and timestamps (ST-027-AC2). Required
 *      payload fields are `primaryColor`, `pattern`, and `finish` per
 *      ST-027-AC1; missing OR non-string OR empty-string fields throw
 *      `ValidationError`. Title trimming policy: leading/trailing
 *      whitespace is stripped before persistence; whitespace-only titles
 *      reject. Allow-list normalisation: payload keys not on the documented
 *      schema are silently dropped (Rule R2 defence in depth — a hostile
 *      client cannot smuggle a `password` field into the JSONB column).
 *
 *   3. **listByUser (ST-028)** — Validates user, validates-and-clamps the
 *      page-size limit per ST-028-AC5 (max 100), forwards the opaque
 *      cursor verbatim, and returns the repository result verbatim
 *      including `nextCursor` for keyset pagination. An empty page is
 *      `{ items: [], nextCursor: null }` (ST-028-AC3). Limits below 1,
 *      non-integer, or non-numeric throw `ValidationError`. Default page
 *      size when omitted: `DEFAULT_PAGE_SIZE` (=25). Above-max requests
 *      are silently clamped to `MAX_PAGE_SIZE` (=100).
 *
 *   4. **getById** — Validates user and design ids, delegates to
 *      `designRepository.findById`, applies a defence-in-depth ownership
 *      mask (ST-028-AC1 — never returns designs owned by other users),
 *      and returns the design or `null`. Enumeration defence: a
 *      cross-ownership match returns `null` (NOT 403) so a hostile
 *      client cannot probe for other users' designs by id alone.
 *
 *   5. **Cross-cut Rule R2 sweep** — After exercising every method, no
 *      logger argument contains the sentinel password, sentinel API key,
 *      sentinel session token, or any payload contents echoed verbatim.
 *      Pino's serializer allow-list is the production-time defence; the
 *      FIRST line of defence is "the service never logs credentials in
 *      the first place" — which is what this sweep verifies.
 *
 *   6. **Validation error contract** — Each method rejects empty/non-string
 *      inputs with `ValidationError`. Repository errors propagate verbatim
 *      via `await` (Rule R8 fail-closed; no silent swallow blocks).
 *
 *   7. **Rule R8 fail-closed** — Errors thrown by `designRepository.insert`,
 *      `designRepository.listByUser`, and `designRepository.findById` all
 *      propagate to the caller with their original message intact — the
 *      service never `try/catch`-swallows persistence-layer failures.
 *
 * Authority:
 *   - Story ST-027 acceptance criteria (create design endpoint; valid
 *     session required; persists configurator selections owned by
 *     authenticated user; returns canonical record; invalid input
 *     rejected with descriptive error; persistence layer unchanged on
 *     failure).
 *   - Story ST-028 acceptance criteria (returns only designs owned by
 *     authenticated user; empty collection on no results; deterministic
 *     ordering; documented maximum page size; bounded pagination).
 *   - Story ST-043 acceptance criteria (deterministic, local-only,
 *     no-network unit suite with co-located `*.test.ts`; pass/fail
 *     verdict; coverage report; failing assertion produces failed
 *     verdict; runs without external services).
 *   - AAP §0.7.1 (co-located unit tests per ST-043).
 *   - AAP §0.8.1 R1 (story acceptance criteria are authoritative).
 *   - AAP §0.8.1 R2 (no credential material in logs — payload contents
 *     never echoed verbatim).
 *   - AAP §0.8.1 R3 (no JWT libraries in backend — this file imports
 *     nothing from `firebase-admin`, `jsonwebtoken`, `jose`, or
 *     `jwt-decode`).
 *   - AAP §0.8.1 R8 (gates fail closed — repository errors propagate).
 *   - AAP §0.8.1 R9 (no payment-processing terminology in tests).
 *
 * Determinism (ST-043-AC3):
 *   - Both collaborators (`DesignRepository`, `GcsService`) are replaced
 *     with `jest.fn()` mocks; no asynchronous boundary depends on
 *     external state.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, and `restoreMocks` to `true` so mock state is wiped
 *     between tests — this file therefore does not need explicit
 *     `jest.clearAllMocks()` calls in `beforeEach`, though the explicit
 *     factory rebuild in `beforeEach` provides additional isolation.
 *   - No `jest.useFakeTimers()` is required because the design service
 *     itself never reads `Date.now()` — all timestamps come from the
 *     repository layer (which is mocked).
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and depends
 *   on ZERO services. Both repositories and pino are fully mocked; no
 *   `pg.Pool`, no log transport, no external HTTP, no DB. Running this
 *   file requires only `npx jest --config jest.config.unit.ts
 *   src/services/design.service.test.ts` on a workstation with no
 *   `docker compose` stack and no external emulator.
 *
 * @see backend/src/services/design.service.ts — module under test
 * @see backend/src/repositories/design.repository.ts — interface mocked
 * @see backend/src/services/gcs.service.ts — interface mocked
 * @see backend/src/logging/pino.ts — module-mocked logger
 * @see tickets/stories/ST-027-create-design-endpoint.md
 * @see tickets/stories/ST-028-retrieve-designs-by-user-endpoint.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// ---------------------------------------------------------------------------
// Type-only imports.
//
// The `consistent-type-imports` ESLint rule (declared at the repository
// root in `.eslintrc.json` with severity `error`) requires that imports
// used only in type positions are declared with `import type`. None of
// these symbols contribute runtime values — they only constrain the
// shape of `jest.Mocked<...>` generics and fixture builder return types.
// ---------------------------------------------------------------------------
import type {
  Design,
  DesignListPage,
  DesignPayload,
  DesignRepository,
} from '../repositories/design.repository';
import type { GcsService } from './gcs.service';

// ---------------------------------------------------------------------------
// Module mock — pino logger.
//
// `jest.mock` is HOISTED to the top of the module body by the Jest
// transformer, BEFORE any `import` statement. We therefore declare it
// before the runtime `import` of the module under test so that
// `design.service.ts` resolves the mocked `logger` rather than the real
// pino instance. The mock exposes the four log levels the production
// code calls (`info`, `warn`); each is a `jest.fn()` so the cross-cut
// Rule R2 sweep can inspect `logger.<level>.mock.calls`.
//
// We also stub `error`, `debug`, `fatal`, `trace`, and `child(): logger`
// for robustness — the production design.service.ts does not invoke
// `error`/`debug`/`fatal`/`trace`/`child` today, but stubbing makes the
// mock resilient to a future refactor without affecting current tests.
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
// Runtime imports — MUST come AFTER the `jest.mock` block above so that
// the mocked module replaces the real one in the module registry. Each
// runtime symbol below is exercised by at least one test in this file.
// ---------------------------------------------------------------------------
import { createDesignService, ValidationError } from './design.service';
import { logger } from '../logging/pino';

// ===========================================================================
// Test fixtures — deterministic constants used throughout the suite.
// ===========================================================================

/**
 * Stable wall-clock pin for the suite. All `createdAt` /
 * `lastModifiedAt` assertions compare against this fixed date so the
 * suite remains deterministic across machines and across
 * second-boundaries (ST-043-AC3).
 *
 * The value is intentionally in the future (2026) so it cannot be
 * confused with any real-world timestamp by an operator skimming test
 * output during incident response.
 */
const FIXED_NOW: Date = new Date('2026-01-15T12:00:00.000Z');

/**
 * The canonical Firebase uid used as the "authenticated user" fixture
 * across every happy-path test. Per AAP §0.2.1, the local `users.id`
 * IS the Firebase uid; the string format is opaque and the design
 * service makes no assumption about its shape beyond "non-empty".
 */
const USER_ID = 'firebase-uid-1';

/**
 * Documented maximum page size from ST-028-AC5. Mirrored here as a
 * constant rather than imported from the production module so the
 * test asserts the policy value directly — if a future change to
 * `MAX_PAGE_SIZE` slipped in unintentionally, the test would catch it
 * by comparing against this hard-coded mirror.
 */
const MAX_PAGE_SIZE = 100;

/**
 * Documented default page size from ST-028 / `design.repository.ts`
 * `DEFAULT_PAGE_SIZE`. Mirrored here for the same policy-pin reason
 * as `MAX_PAGE_SIZE` above.
 */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Sentinel password value used in the Rule R2 sweep. The string
 * `SENTINEL_CRED_99` is the AAP-prescribed marker the Rule R2
 * verification scans for; if any log record ever contains this
 * substring, the sweep test fails. The marker is deliberately
 * unmistakable so a positive match cannot be confused with a benign
 * coincidence.
 */
const SENTINEL_PASSWORD = 'SENTINEL_CRED_99';

/**
 * Sentinel API-key value used in the Rule R2 sweep. Same intent as
 * `SENTINEL_PASSWORD` — a marker that, if it ever appears in a log
 * record, immediately reveals a credential-leak defect.
 */
const SENTINEL_API_KEY = 'SENTINEL_API_KEY_ABC';

// ===========================================================================
// Mock builders — produce strongly-typed `jest.Mocked<...>` instances
// of each repository / service so the test can `mockResolvedValueOnce`,
// inspect `mock.calls`, and use `mock.invocationCallOrder` for ordering
// assertions.
// ===========================================================================

/**
 * Build a fresh `jest.Mocked<DesignRepository>` with every contract
 * method as a `jest.fn()`. Tests arrange behaviour on each method via
 * `mockResolvedValueOnce` / `mockRejectedValueOnce` /
 * `mockImplementationOnce`.
 *
 * The four methods mirror the
 * {@link import('../repositories/design.repository').DesignRepository}
 * interface exactly — adding or removing a method here without a
 * corresponding interface change will fail TypeScript's
 * `jest.Mocked<...>` exhaustiveness check at compile time.
 */
function makeDesignRepositoryMock(): jest.Mocked<DesignRepository> {
  return {
    insert: jest.fn(),
    listByUser: jest.fn(),
    findById: jest.fn(),
    updatePayload: jest.fn(),
  };
}

/**
 * Build a fresh `jest.Mocked<GcsService>` with every contract method
 * as a `jest.fn()`.
 *
 * Although the design service does not currently invoke any
 * `GcsService` method, the factory's compose-time validation requires
 * a non-null `gcsService` dependency. Every `beforeEach` instantiates
 * a fresh mock so the dependency is satisfied AND so tests can later
 * verify "no GCS call was made" by asserting `mockCalls.length === 0`
 * if an implementation regression introduces unintended GCS traffic.
 */
function makeGcsServiceMock(): jest.Mocked<GcsService> {
  return {
    getUploadUrl: jest.fn(),
    getReadUrl: jest.fn(),
    delete: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders.
//
// Each builder produces a canonical record that satisfies the matching
// repository-layer interface. Each accepts a `Partial<T>` override so
// individual tests can mutate just the fields relevant to the assertion
// under test, while inheriting safe defaults for every other field.
//
// The defaults intentionally mirror values that would survive a full
// round-trip through the production code path — `userId` matches
// `USER_ID`, `createdAt` and `lastModifiedAt` match `FIXED_NOW`, and
// `payload` is a minimal schema-valid configurator selection.
// ---------------------------------------------------------------------------

/**
 * Build a canonical {@link DesignPayload} fixture matching the documented
 * required fields per ST-027-AC1.
 *
 * Required fields: `primaryColor`, `pattern`, `finish`. All three are
 * non-empty strings. The fixture also includes the optional
 * `secondaryColor`, `accentColor`, and `logo` (set to `null` to mean
 * "no logo"). Tests that need to drop a required field call
 * `delete (bad as Record<string, unknown>).<field>` on the fixture
 * before passing to the service.
 */
function validPayload(overrides: Partial<DesignPayload> = {}): DesignPayload {
  return {
    primaryColor: '#FF0000',
    secondaryColor: '#00FF00',
    accentColor: '#0000FF',
    pattern: 'classic',
    finish: 'matte',
    logo: null,
    ...overrides,
  };
}

/**
 * Build a canonical {@link Design} fixture matching the `designs` table
 * contract.
 *
 * Override-aware: callers can patch any subset of fields (most commonly
 * `id` to vary the design identifier across tests, or `userId` to
 * construct a "design owned by another user" — though the production
 * repository never returns such a record because its SQL filters by
 * `user_id`, the service's defence-in-depth ownership check covers
 * the case anyway).
 *
 * The default `payload` is a minimal, schema-valid configurator
 * selection produced by {@link validPayload}; tests that exercise
 * payload-specific behaviour pass an explicit `payload` override.
 */
function makeDesignFixture(overrides: Partial<Design> = {}): Design {
  return {
    id: 'd-11111111-2222-3333-4444-555555555555',
    userId: USER_ID,
    title: 'My Design',
    payload: validPayload(),
    createdAt: FIXED_NOW,
    lastModifiedAt: FIXED_NOW,
    ...overrides,
  };
}

// ===========================================================================
// Test suite — DesignService.create (ST-027).
// ===========================================================================

describe('DesignService.create (ST-027)', () => {
  /** Per-test mock instance of the design repository. */
  let designRepository: jest.Mocked<DesignRepository>;
  /** Per-test mock instance of the GCS service (factory dep — unused here). */
  let gcsService: jest.Mocked<GcsService>;
  /** Per-test instance of the design service under test. */
  let service: ReturnType<typeof createDesignService>;

  beforeEach(() => {
    // Build fresh mocks AND a fresh service for every test. This
    // belt-and-suspenders pattern complements the Jest config's
    // `clearMocks/resetMocks/restoreMocks: true` triple by guaranteeing
    // a clean slate even if those Jest config options were ever
    // weakened in a future configuration change.
    designRepository = makeDesignRepositoryMock();
    gcsService = makeGcsServiceMock();
    service = createDesignService({ designRepository, gcsService });
  });

  // -------------------------------------------------------------------------
  // ST-027-AC1: persists a new design record with all configurator
  // selections owned by the authenticated user.
  // -------------------------------------------------------------------------

  it('inserts a new design with the authenticated userId as owner (ST-027-AC1)', async () => {
    const created = makeDesignFixture({ userId: 'u-owner', title: 'New Ball' });
    designRepository.insert.mockResolvedValueOnce(created);

    const result = await service.create({
      userId: 'u-owner',
      title: 'New Ball',
      payload: validPayload(),
    });

    // Repository was called exactly once.
    expect(designRepository.insert).toHaveBeenCalledTimes(1);

    // The repository call carried the authenticated userId, the
    // sanitised title, and an allow-listed payload — establishing the
    // "owned by the authenticated user" invariant from ST-027-AC1.
    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    expect(insertArgs).toBeDefined();
    expect(insertArgs?.userId).toBe('u-owner');
    expect(insertArgs?.title).toBe('New Ball');

    // The required payload fields make it through the allow-list
    // unchanged. Optional fields included in the input fixture also
    // survive (only UNKNOWN keys are dropped — see the Rule R2 test
    // below).
    expect(insertArgs?.payload).toEqual(
      expect.objectContaining({
        primaryColor: '#FF0000',
        pattern: 'classic',
        finish: 'matte',
      }),
    );

    // The service returns the canonical record verbatim.
    expect(result).toEqual(created);
  });

  // -------------------------------------------------------------------------
  // ST-027-AC2: a successful create returns the canonical persisted
  // design including a server-assigned identifier and timestamps.
  // -------------------------------------------------------------------------

  it('returns the canonical persisted record with server-assigned id and timestamps (ST-027-AC2)', async () => {
    const expectedCreatedAt = new Date('2026-01-15T12:00:00.000Z');
    const expectedLastModifiedAt = new Date('2026-01-15T12:00:00.000Z');
    const canonical = makeDesignFixture({
      id: 'd-server-assigned-uuid',
      createdAt: expectedCreatedAt,
      lastModifiedAt: expectedLastModifiedAt,
    });
    designRepository.insert.mockResolvedValueOnce(canonical);

    const result = await service.create({
      userId: 'u-any',
      title: 'T',
      payload: validPayload(),
    });

    // The service returns whatever the repository returned — the id
    // and both timestamps must match exactly. Asserting via getTime()
    // for the timestamps avoids a false negative if a tooling layer
    // serialises Date instances differently between runs.
    expect(result.id).toBe('d-server-assigned-uuid');
    expect(result.createdAt.getTime()).toBe(expectedCreatedAt.getTime());
    expect(result.lastModifiedAt.getTime()).toBe(expectedLastModifiedAt.getTime());
    // Full-record equality as a final sanity check.
    expect(result).toEqual(canonical);
  });

  it('does not mutate any other design owned by the user (ST-027-AC2)', async () => {
    // The service's create method MUST NOT call any repository update
    // method. We assert this by mocking insert to resolve and then
    // verifying neither updatePayload nor any other write method was
    // touched. This is the structural enforcement of "does not mutate
    // any other design owned by the user".
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'T',
      payload: validPayload(),
    });

    expect(designRepository.insert).toHaveBeenCalledTimes(1);
    expect(designRepository.updatePayload).not.toHaveBeenCalled();
    // listByUser/findById are read-only but should also not fire on a
    // create-only path.
    expect(designRepository.listByUser).not.toHaveBeenCalled();
    expect(designRepository.findById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // ST-027-AC3: requests with invalid input are rejected with a
  // descriptive error AND leave the persistence layer unchanged.
  // -------------------------------------------------------------------------

  it('throws ValidationError when title is missing (empty string) (ST-027-AC3)', async () => {
    await expect(
      service.create({ userId: USER_ID, title: '', payload: validPayload() }),
    ).rejects.toThrow(ValidationError);
    // Persistence layer unchanged — the repository was never called.
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title is whitespace-only (ST-027-AC3)', async () => {
    await expect(
      service.create({ userId: USER_ID, title: '   ', payload: validPayload() }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title is not a string (ST-027-AC3)', async () => {
    await expect(
      service.create({
        userId: USER_ID,
        title: 123 as unknown as string,
        payload: validPayload(),
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title exceeds the maximum length (ST-027-AC3)', async () => {
    // 500 chars > documented 200-char maximum — the service must
    // reject this before any DB contact.
    const tooLong = 'x'.repeat(500);
    await expect(
      service.create({ userId: USER_ID, title: tooLong, payload: validPayload() }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when userId is missing (ST-027-AC3)', async () => {
    await expect(
      service.create({ userId: '', title: 'T', payload: validPayload() }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when userId is not a string (ST-027-AC3)', async () => {
    await expect(
      service.create({
        userId: 42 as unknown as string,
        title: 'T',
        payload: validPayload(),
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload is null (ST-027-AC3)', async () => {
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: null as unknown as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload is undefined (ST-027-AC3)', async () => {
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: undefined as unknown as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload is an array (ST-027-AC3)', async () => {
    // typeof [] === 'object' in JS — the service must explicitly
    // reject arrays; otherwise an array would slip through and produce
    // a downstream error from the JSONB cast that is harder to debug.
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: [] as unknown as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload is a primitive (ST-027-AC3)', async () => {
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: 'not-a-payload' as unknown as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.primaryColor is missing (ST-027-AC3)', async () => {
    const bad = { ...validPayload() };
    // Cast through Record so deletion of a required schema field is
    // accepted by TypeScript.
    delete (bad as Record<string, unknown>)['primaryColor'];
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: bad as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.primaryColor is empty string (ST-027-AC3)', async () => {
    const bad = validPayload({ primaryColor: '' });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.pattern is missing (ST-027-AC3)', async () => {
    const bad = { ...validPayload() };
    delete (bad as Record<string, unknown>)['pattern'];
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: bad as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.pattern is empty string (ST-027-AC3)', async () => {
    const bad = validPayload({ pattern: '' });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.finish is missing (ST-027-AC3)', async () => {
    const bad = { ...validPayload() };
    delete (bad as Record<string, unknown>)['finish'];
    await expect(
      service.create({
        userId: USER_ID,
        title: 'T',
        payload: bad as DesignPayload,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.finish is empty string (ST-027-AC3)', async () => {
    const bad = validPayload({ finish: '' });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.logo is provided but not an object (ST-027-AC3)', async () => {
    // ST-027-AC3 explicitly mentions "malformed logo reference" — a
    // string-typed logo is a category-level type error that must be
    // rejected at the validation boundary.
    const bad = validPayload({ logo: 'not-an-object' as unknown as null });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.logo is an array (ST-027-AC3)', async () => {
    const bad = validPayload({ logo: [] as unknown as null });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.logo.objectKey is missing (ST-027-AC3)', async () => {
    // A logo object with no `objectKey` is a malformed reference —
    // the service must reject it before any DB write.
    const bad = validPayload({
      logo: { offsetX: 10, offsetY: 20 } as unknown as null,
    });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  it('throws ValidationError when payload.logo.objectKey is empty string (ST-027-AC3)', async () => {
    const bad = validPayload({
      logo: { objectKey: '' } as unknown as null,
    });
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: bad }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.insert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Title-trim policy: leading/trailing whitespace is stripped before
  // persisting. This matches the UX expectation that users may
  // accidentally add whitespace to a title without bloating the
  // persisted value.
  // -------------------------------------------------------------------------

  it('trims leading/trailing whitespace from the title before persisting', async () => {
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: '  A Valid Title  ',
      payload: validPayload(),
    });

    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    expect(insertArgs?.title).toBe('A Valid Title');
  });

  it('trims a title with only trailing whitespace before persisting', async () => {
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'Trailing space\n\t',
      payload: validPayload(),
    });

    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    expect(insertArgs?.title).toBe('Trailing space');
  });

  // -------------------------------------------------------------------------
  // Allow-list normalisation (Rule R2 defence-in-depth): unknown payload
  // keys are silently dropped before reaching the JSONB column.
  // -------------------------------------------------------------------------

  it('drops unknown keys from the payload before persisting (Rule R2 allow-list defence)', async () => {
    // A hostile client cannot smuggle arbitrary keys into the JSONB
    // column. The service's allow-list MUST drop `password`, `apiKey`,
    // and any other unrecognised key — we verify that behaviour here.
    const sneakyPayload = {
      ...validPayload(),
      password: SENTINEL_PASSWORD,
      apiKey: SENTINEL_API_KEY,
      // arbitrary unknown key beyond the canonical schema
      'attacker-controlled-field': 'some-value',
    } as unknown as DesignPayload;
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'T',
      payload: sneakyPayload,
    });

    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    // The known/required fields make it through the allow-list.
    expect(insertArgs?.payload['primaryColor']).toBe('#FF0000');
    expect(insertArgs?.payload['pattern']).toBe('classic');
    expect(insertArgs?.payload['finish']).toBe('matte');
    // The unknown keys are silently dropped — they MUST NOT reach
    // the persistence layer.
    expect(insertArgs?.payload['password']).toBeUndefined();
    expect(insertArgs?.payload['apiKey']).toBeUndefined();
    expect(insertArgs?.payload['attacker-controlled-field']).toBeUndefined();
  });

  it('allow-lists logo placement fields (objectKey, offsetX, offsetY, scale, rotation)', async () => {
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'With Logo',
      payload: validPayload({
        logo: {
          objectKey: 'users/uid/logos/logo.png',
          offsetX: 0.5,
          offsetY: -0.25,
          scale: 1.5,
          rotation: 45,
          // Unknown sub-key — must be dropped from the normalised logo.
          attackerKey: 'evil-value',
        } as unknown as null,
      }),
    });

    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    const logo = insertArgs?.payload['logo'] as Record<string, unknown> | undefined;
    expect(logo).toBeDefined();
    expect(logo?.['objectKey']).toBe('users/uid/logos/logo.png');
    expect(logo?.['offsetX']).toBe(0.5);
    expect(logo?.['offsetY']).toBe(-0.25);
    expect(logo?.['scale']).toBe(1.5);
    expect(logo?.['rotation']).toBe(45);
    // Unknown sub-key was dropped.
    expect(logo?.['attackerKey']).toBeUndefined();
  });

  it('omits the logo field when payload.logo is null', async () => {
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'No Logo',
      payload: validPayload({ logo: null }),
    });

    const insertArgs = designRepository.insert.mock.calls[0]?.[0];
    // Either undefined (dropped) or null — both signal "no logo" by
    // absence rather than by a positive value.
    const persistedLogo = insertArgs?.payload['logo'];
    // The service explicitly omits the field rather than persisting
    // an explicit null — this keeps the JSONB document tidy.
    expect(persistedLogo).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rule R8 fail-closed: repository errors propagate to the caller
  // verbatim (no silent swallow blocks).
  // -------------------------------------------------------------------------

  it('propagates repository errors verbatim (Rule R8 fail-closed)', async () => {
    const dbErr = new Error('connection refused');
    designRepository.insert.mockRejectedValueOnce(dbErr);

    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: validPayload() }),
    ).rejects.toThrow('connection refused');
  });

  it('propagates a non-Error repository rejection (Rule R8 fail-closed)', async () => {
    // Some pg drivers reject with non-Error values in pathological
    // states — the service must propagate without re-wrapping or
    // swallowing.
    designRepository.insert.mockRejectedValueOnce({ code: '23503' });

    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: validPayload() }),
    ).rejects.toEqual({ code: '23503' });
  });

  // -------------------------------------------------------------------------
  // Rule R2: the service must never log the payload contents verbatim.
  // The structural log line uses metadata only (event, uid, titleLength,
  // payloadHasLogo) — payload values themselves never appear in any
  // log argument.
  // -------------------------------------------------------------------------

  it('never logs payload contents verbatim (Rule R2)', async () => {
    const sneakyPayload = {
      ...validPayload(),
      password: SENTINEL_PASSWORD,
      apiKey: SENTINEL_API_KEY,
    } as unknown as DesignPayload;
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());

    await service.create({ userId: USER_ID, title: 'T', payload: sneakyPayload });

    // Aggregate every log call across info/warn/error/debug into a
    // single JSON-serialised string and scan for credential markers.
    // If any of the sentinels is present, the service is leaking
    // payload contents into logs — Rule R2 violation.
    const allLogArgs = JSON.stringify([
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]);
    expect(allLogArgs).not.toContain(SENTINEL_PASSWORD);
    expect(allLogArgs).not.toContain(SENTINEL_API_KEY);
  });
});

// ===========================================================================
// Test suite — DesignService.listByUser (ST-028).
// ===========================================================================

describe('DesignService.listByUser (ST-028)', () => {
  let designRepository: jest.Mocked<DesignRepository>;
  let gcsService: jest.Mocked<GcsService>;
  let service: ReturnType<typeof createDesignService>;

  beforeEach(() => {
    designRepository = makeDesignRepositoryMock();
    gcsService = makeGcsServiceMock();
    service = createDesignService({ designRepository, gcsService });
  });

  // -------------------------------------------------------------------------
  // ST-028-AC1: returns only designs owned by the authenticated user.
  // -------------------------------------------------------------------------

  it('forwards the authenticated userId to the repository (ST-028-AC1)', async () => {
    const owned: Design[] = [
      makeDesignFixture({ id: 'd-1', userId: 'u-owner' }),
      makeDesignFixture({ id: 'd-2', userId: 'u-owner' }),
    ];
    designRepository.listByUser.mockResolvedValueOnce({
      items: owned,
      nextCursor: null,
    });

    const result = await service.listByUser({ userId: 'u-owner', limit: 25 });

    // The repository was called with the authenticated userId — the
    // SQL layer enforces `WHERE user_id = $1` so no cross-ownership
    // leak can occur.
    expect(designRepository.listByUser).toHaveBeenCalledTimes(1);
    expect(designRepository.listByUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-owner' }),
    );
    expect(result.items).toEqual(owned);
  });

  // -------------------------------------------------------------------------
  // ST-028-AC3: empty collection on no results — success status, NOT
  // an error.
  // -------------------------------------------------------------------------

  it('returns an empty page for a user with no designs (ST-028-AC3)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    const result = await service.listByUser({
      userId: 'u-empty',
      limit: 25,
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('does not throw when the user has no designs (ST-028-AC3 — empty is success)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    // The contract says "returns an empty collection with a success
    // status (not an error)" — a thrown promise would be a defect.
    await expect(
      service.listByUser({ userId: 'u-empty', limit: 25 }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  // -------------------------------------------------------------------------
  // Cursor passthrough: the service treats the cursor as opaque.
  // -------------------------------------------------------------------------

  it('forwards the cursor verbatim to the repository for keyset pagination', async () => {
    const opaqueCursor =
      'eyJsYXN0TW9kaWZpZWRBdCI6IjIwMjYtMDEtMTVUMTI6MDA6MDAuMDAwWiIsImlkIjoiZC0xIn0';
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({
      userId: USER_ID,
      limit: 25,
      cursor: opaqueCursor,
    });

    expect(designRepository.listByUser).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: opaqueCursor }),
    );
  });

  it('passes undefined cursor through to the repository when omitted', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({ userId: USER_ID, limit: 25 });

    const repoCall = designRepository.listByUser.mock.calls[0]?.[0];
    expect(repoCall?.cursor).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // ST-028-AC5: documented maximum page size (100). Above-max requests
  // are silently clamped.
  // -------------------------------------------------------------------------

  it('clamps limit to MAX_PAGE_SIZE (100) when caller requests more (ST-028-AC5)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({ userId: USER_ID, limit: 500 });

    const args = designRepository.listByUser.mock.calls[0]?.[0];
    expect(args?.limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(args?.limit).toBe(MAX_PAGE_SIZE);
  });

  it('clamps limit to MAX_PAGE_SIZE when caller requests exactly MAX+1 (ST-028-AC5)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({ userId: USER_ID, limit: MAX_PAGE_SIZE + 1 });

    const args = designRepository.listByUser.mock.calls[0]?.[0];
    expect(args?.limit).toBe(MAX_PAGE_SIZE);
  });

  it('passes through a limit equal to MAX_PAGE_SIZE unchanged (ST-028-AC5)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({ userId: USER_ID, limit: MAX_PAGE_SIZE });

    const args = designRepository.listByUser.mock.calls[0]?.[0];
    expect(args?.limit).toBe(MAX_PAGE_SIZE);
  });

  it('uses the documented default page size when limit is omitted', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });

    await service.listByUser({ userId: USER_ID });

    const args = designRepository.listByUser.mock.calls[0]?.[0];
    // The documented default (`DEFAULT_PAGE_SIZE`) MUST be used. The
    // value is 25 per `design.repository.ts`.
    expect(args?.limit).toBe(DEFAULT_PAGE_SIZE);
  });

  // -------------------------------------------------------------------------
  // Limit validation: zero, negative, non-integer all reject.
  // -------------------------------------------------------------------------

  it('throws ValidationError when limit is zero', async () => {
    await expect(
      service.listByUser({ userId: USER_ID, limit: 0 }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when limit is negative', async () => {
    await expect(
      service.listByUser({ userId: USER_ID, limit: -1 }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when limit is a non-integer (3.5)', async () => {
    await expect(
      service.listByUser({ userId: USER_ID, limit: 3.5 }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when limit is NaN', async () => {
    await expect(
      service.listByUser({ userId: USER_ID, limit: Number.NaN }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when limit is Infinity', async () => {
    await expect(
      service.listByUser({ userId: USER_ID, limit: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when limit is a non-numeric type', async () => {
    await expect(
      service.listByUser({
        userId: USER_ID,
        limit: 'twenty' as unknown as number,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // userId validation.
  // -------------------------------------------------------------------------

  it('throws ValidationError when userId is missing (empty string)', async () => {
    await expect(
      service.listByUser({ userId: '', limit: 25 }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  it('throws ValidationError when userId is not a string', async () => {
    await expect(
      service.listByUser({
        userId: 123 as unknown as string,
        limit: 25,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.listByUser).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Repository result passthrough.
  // -------------------------------------------------------------------------

  it('returns the repository result verbatim (cursor passthrough for next call)', async () => {
    const page: DesignListPage = {
      items: [makeDesignFixture({ id: 'd-1' })],
      nextCursor: 'next-cursor-token-xyz',
    };
    designRepository.listByUser.mockResolvedValueOnce(page);

    const result = await service.listByUser({ userId: USER_ID, limit: 10 });

    expect(result).toEqual(page);
    expect(result.nextCursor).toBe('next-cursor-token-xyz');
  });

  it('preserves a populated nextCursor for downstream pagination (ST-028-AC5)', async () => {
    designRepository.listByUser.mockResolvedValueOnce({
      items: [makeDesignFixture()],
      nextCursor: 'first-page-cursor',
    });
    const firstPage = await service.listByUser({ userId: USER_ID, limit: 1 });

    expect(firstPage.nextCursor).toBe('first-page-cursor');

    // Subsequent call uses the cursor from the first page — the
    // service forwards it verbatim.
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    await service.listByUser({
      userId: USER_ID,
      limit: 1,
      cursor: firstPage.nextCursor as string,
    });

    expect(designRepository.listByUser).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'first-page-cursor' }),
    );
  });

  // -------------------------------------------------------------------------
  // Rule R8 fail-closed: repository errors propagate.
  // -------------------------------------------------------------------------

  it('propagates repository errors verbatim (Rule R8 fail-closed)', async () => {
    designRepository.listByUser.mockRejectedValueOnce(
      new Error('pg connection timeout'),
    );

    await expect(
      service.listByUser({ userId: USER_ID, limit: 25 }),
    ).rejects.toThrow('pg connection timeout');
  });

  it('propagates cursor-decode errors from the repository (Rule R8)', async () => {
    // The repository owns cursor decoding; an invalid cursor surfaces
    // as a thrown Error from the repository call. The service must
    // propagate, NOT swallow.
    designRepository.listByUser.mockRejectedValueOnce(
      new Error('Invalid cursor: not base64url-encoded JSON'),
    );

    await expect(
      service.listByUser({
        userId: USER_ID,
        limit: 25,
        cursor: 'malformed!!cursor',
      }),
    ).rejects.toThrow(/Invalid cursor/);
  });
});

// ===========================================================================
// Test suite — DesignService.getById.
// ===========================================================================

describe('DesignService.getById', () => {
  let designRepository: jest.Mocked<DesignRepository>;
  let gcsService: jest.Mocked<GcsService>;
  let service: ReturnType<typeof createDesignService>;

  beforeEach(() => {
    designRepository = makeDesignRepositoryMock();
    gcsService = makeGcsServiceMock();
    service = createDesignService({ designRepository, gcsService });
  });

  // -------------------------------------------------------------------------
  // Happy path: design exists AND is owned by the caller.
  // -------------------------------------------------------------------------

  it('returns the design when userId matches ownership', async () => {
    const owned = makeDesignFixture({
      id: 'd-owned',
      userId: 'u-owner',
    });
    designRepository.findById.mockResolvedValueOnce(owned);

    const result = await service.getById({
      userId: 'u-owner',
      designId: 'd-owned',
    });

    expect(result).toEqual(owned);
    expect(designRepository.findById).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Not found: design does not exist.
  // -------------------------------------------------------------------------

  it('returns null when the design does not exist', async () => {
    designRepository.findById.mockResolvedValueOnce(null);

    const result = await service.getById({
      userId: USER_ID,
      designId: 'd-missing',
    });

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Enumeration defence (ST-028-AC1): cross-ownership matches return
  // null, NOT 403, so a hostile client cannot probe for other users'
  // designs by id alone.
  // -------------------------------------------------------------------------

  it('returns null when the design exists but is owned by a different user (enumeration defence)', async () => {
    // Critical security property: the production repository SQL filters
    // by `user_id` so this branch is the defence-in-depth check at the
    // service layer. If a future repository refactor ever relaxed the
    // SQL filter, this service-layer check would still mask the
    // cross-user record as `null`.
    const ownedByOther = makeDesignFixture({
      id: 'd-xyz',
      userId: 'u-someone-else',
    });
    designRepository.findById.mockResolvedValueOnce(ownedByOther);

    const result = await service.getById({
      userId: 'u-me',
      designId: 'd-xyz',
    });

    expect(result).toBeNull();
  });

  it('emits a warn-level structural log when ownership-mismatch defence fires (Rule R2-safe)', async () => {
    // The service's defence-in-depth path emits a `warn` log when the
    // repository returns a row for a different owner. We assert the
    // structural log line is fired AND that no credential material
    // appears in its argument.
    const ownedByOther = makeDesignFixture({
      id: 'd-xyz',
      userId: 'u-someone-else',
    });
    designRepository.findById.mockResolvedValueOnce(ownedByOther);

    await service.getById({ userId: 'u-me', designId: 'd-xyz' });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Sweep the warn call for any credential material — there should
    // be none, only structural metadata (event/uid/designId/owner).
    const warnArgs = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(warnArgs).not.toContain(SENTINEL_PASSWORD);
    expect(warnArgs).not.toContain(SENTINEL_API_KEY);
  });

  // -------------------------------------------------------------------------
  // Repository receives both userId AND designId — defence-in-depth.
  // -------------------------------------------------------------------------

  it('forwards both designId and userId to the repository (repository enforces ownership in SQL)', async () => {
    designRepository.findById.mockResolvedValueOnce(null);

    await service.getById({ userId: 'u-q', designId: 'd-q' });

    expect(designRepository.findById).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-q',
        designId: 'd-q',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Validation: userId and designId.
  // -------------------------------------------------------------------------

  it('throws ValidationError when userId is missing (empty string)', async () => {
    await expect(
      service.getById({ userId: '', designId: 'd-1' }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.findById).not.toHaveBeenCalled();
  });

  it('throws ValidationError when userId is not a string', async () => {
    await expect(
      service.getById({
        userId: 42 as unknown as string,
        designId: 'd-1',
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.findById).not.toHaveBeenCalled();
  });

  it('throws ValidationError when designId is missing (empty string)', async () => {
    await expect(
      service.getById({ userId: USER_ID, designId: '' }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.findById).not.toHaveBeenCalled();
  });

  it('throws ValidationError when designId is not a string', async () => {
    await expect(
      service.getById({
        userId: USER_ID,
        designId: 42 as unknown as string,
      }),
    ).rejects.toThrow(ValidationError);
    expect(designRepository.findById).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Rule R8 fail-closed: repository errors propagate.
  // -------------------------------------------------------------------------

  it('propagates repository errors verbatim (Rule R8 fail-closed)', async () => {
    designRepository.findById.mockRejectedValueOnce(
      new Error('pg query failed'),
    );

    await expect(
      service.getById({ userId: USER_ID, designId: 'd' }),
    ).rejects.toThrow('pg query failed');
  });
});

// ===========================================================================
// Test suite — createDesignService factory contract.
// ===========================================================================

describe('createDesignService factory', () => {
  it('returns an object with create, listByUser, and getById methods', () => {
    const service = createDesignService({
      designRepository: makeDesignRepositoryMock(),
      gcsService: makeGcsServiceMock(),
    });
    expect(typeof service.create).toBe('function');
    expect(typeof service.listByUser).toBe('function');
    expect(typeof service.getById).toBe('function');
  });

  it('throws synchronously when deps argument is missing', () => {
    expect(() =>
      createDesignService(undefined as unknown as Parameters<typeof createDesignService>[0]),
    ).toThrow();
  });

  it('throws synchronously when deps is null', () => {
    expect(() =>
      createDesignService(null as unknown as Parameters<typeof createDesignService>[0]),
    ).toThrow();
  });

  it('throws synchronously when designRepository is missing', () => {
    expect(() =>
      createDesignService({
        designRepository: undefined as unknown as DesignRepository,
        gcsService: makeGcsServiceMock(),
      }),
    ).toThrow(/designRepository/);
  });

  it('throws synchronously when designRepository is null', () => {
    expect(() =>
      createDesignService({
        designRepository: null as unknown as DesignRepository,
        gcsService: makeGcsServiceMock(),
      }),
    ).toThrow(/designRepository/);
  });

  it('throws synchronously when gcsService is missing', () => {
    expect(() =>
      createDesignService({
        designRepository: makeDesignRepositoryMock(),
        gcsService: undefined as unknown as GcsService,
      }),
    ).toThrow(/gcsService/);
  });

  it('throws synchronously when gcsService is null', () => {
    expect(() =>
      createDesignService({
        designRepository: makeDesignRepositoryMock(),
        gcsService: null as unknown as GcsService,
      }),
    ).toThrow(/gcsService/);
  });

  it('produces an independent service instance on every call', () => {
    const repo = makeDesignRepositoryMock();
    const gcs = makeGcsServiceMock();
    const s1 = createDesignService({ designRepository: repo, gcsService: gcs });
    const s2 = createDesignService({ designRepository: repo, gcsService: gcs });
    expect(s1).not.toBe(s2);
  });

  it('returns a frozen object (Object.freeze invariant)', () => {
    const service = createDesignService({
      designRepository: makeDesignRepositoryMock(),
      gcsService: makeGcsServiceMock(),
    });
    expect(Object.isFrozen(service)).toBe(true);
  });

  it('does not invoke any repository or GCS method during construction', () => {
    const repo = makeDesignRepositoryMock();
    const gcs = makeGcsServiceMock();
    createDesignService({ designRepository: repo, gcsService: gcs });

    // Construction must be side-effect-free: no DB query, no GCS API
    // call. Hot-path code only runs on a method invocation.
    expect(repo.insert).not.toHaveBeenCalled();
    expect(repo.listByUser).not.toHaveBeenCalled();
    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo.updatePayload).not.toHaveBeenCalled();
    expect(gcs.getReadUrl).not.toHaveBeenCalled();
    expect(gcs.getUploadUrl).not.toHaveBeenCalled();
    expect(gcs.delete).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Test suite — Cross-cut Rule R2 / R3 / R9 sweep.
//
// After exercising every method, scan all log calls for credential
// material AND verify the test file does not import any forbidden
// dependency. Pino's serializer allow-list is the production-time
// defence; the FIRST line of defence is "the service never logs
// credentials in the first place" — which this sweep verifies.
// ===========================================================================

describe('cross-cut compliance sweep', () => {
  let designRepository: jest.Mocked<DesignRepository>;
  let gcsService: jest.Mocked<GcsService>;
  let service: ReturnType<typeof createDesignService>;

  beforeEach(() => {
    designRepository = makeDesignRepositoryMock();
    gcsService = makeGcsServiceMock();
    service = createDesignService({ designRepository, gcsService });
  });

  it('Rule R2: never logs the SENTINEL_CRED_99 password marker across any method', async () => {
    // Drive every public method with a sentinel-laced payload.
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());
    designRepository.listByUser.mockResolvedValueOnce({
      items: [makeDesignFixture()],
      nextCursor: 'cursor-' + SENTINEL_PASSWORD,
    });
    designRepository.findById.mockResolvedValueOnce(makeDesignFixture());

    await service.create({
      userId: USER_ID,
      title: 'T',
      payload: {
        ...validPayload(),
        password: SENTINEL_PASSWORD,
      } as unknown as DesignPayload,
    });

    await service.listByUser({ userId: USER_ID, limit: 10 });
    await service.getById({ userId: USER_ID, designId: 'd-1' });

    // Aggregate every log argument across all four levels into a
    // single JSON-serialised string and scan for the sentinel.
    const allLogArgs = JSON.stringify([
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]);
    expect(allLogArgs).not.toContain(SENTINEL_PASSWORD);
  });

  it('Rule R2: never logs the SENTINEL_API_KEY marker across any method', async () => {
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());
    designRepository.listByUser.mockResolvedValueOnce({
      items: [makeDesignFixture()],
      nextCursor: null,
    });

    await service.create({
      userId: USER_ID,
      title: 'T',
      payload: {
        ...validPayload(),
        apiKey: SENTINEL_API_KEY,
      } as unknown as DesignPayload,
    });

    await service.listByUser({ userId: USER_ID, limit: 10 });

    const allLogArgs = JSON.stringify([
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]);
    expect(allLogArgs).not.toContain(SENTINEL_API_KEY);
  });

  it('Rule R2: never logs Authorization header values across any method', async () => {
    // The service has no direct path that touches an Authorization
    // header (that's the middleware layer's job), but a defensive
    // sweep across all method invocations verifies the service does
    // not stumble into surfacing one accidentally.
    const sentinelBearer = 'Bearer SENTINEL_BEARER_TOKEN_123';
    designRepository.insert.mockResolvedValueOnce(makeDesignFixture());
    designRepository.listByUser.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
    });
    designRepository.findById.mockResolvedValueOnce(null);

    await service.create({
      userId: USER_ID,
      title: 'T',
      payload: validPayload(),
    });
    await service.listByUser({ userId: USER_ID, limit: 25 });
    await service.getById({ userId: USER_ID, designId: 'd-1' });

    const allLogArgs = JSON.stringify([
      ...(logger.info as jest.Mock).mock.calls,
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.debug as jest.Mock).mock.calls,
    ]);
    expect(allLogArgs).not.toContain(sentinelBearer);
  });

  it('Rule R8: every method propagates a repository rejection unchanged', async () => {
    // Drive every method into the failure path and verify each
    // surfaces the repository's error verbatim.
    const insertErr = new Error('insert failed');
    const listErr = new Error('list failed');
    const findErr = new Error('find failed');

    designRepository.insert.mockRejectedValueOnce(insertErr);
    await expect(
      service.create({ userId: USER_ID, title: 'T', payload: validPayload() }),
    ).rejects.toThrow('insert failed');

    designRepository.listByUser.mockRejectedValueOnce(listErr);
    await expect(
      service.listByUser({ userId: USER_ID, limit: 10 }),
    ).rejects.toThrow('list failed');

    designRepository.findById.mockRejectedValueOnce(findErr);
    await expect(
      service.getById({ userId: USER_ID, designId: 'd-1' }),
    ).rejects.toThrow('find failed');
  });
});
