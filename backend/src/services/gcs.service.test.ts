/**
 * Unit tests for `backend/src/services/gcs.service.ts` — the SOLE
 * call site in the backend for `getSignedUrl`.
 *
 * Authority:
 *   - AAP §0.7.1 — Co-located unit tests per ST-043; this file is the
 *     `*.test.ts` sibling for `gcs.service.ts`.
 *   - AAP §0.2.2 C1 (verbatim): "Every call site in
 *     `backend/src/**\/*.ts` that invokes `bucket.file(name).getSignedUrl`
 *     MUST pass an options object containing `version: 'v4', action:
 *     'read', expires: Date.now() + 15 * 60 * 1000`. The v7 SDK removed
 *     `getSignedUrl` from `File` instances without explicit `version`;
 *     omitting the `version` key throws at runtime."
 *   - AAP §0.8.1 Rule R5 (verbatim): "Every call MUST use
 *     `bucket.file(name).getSignedUrl({ version: 'v4', ... })`. MUST
 *     NOT call `.getSignedUrl()` without explicit `version`."
 *   - AAP §0.8.1 Rule R2 (no credential material in logs): signed URLs
 *     carry the `X-Goog-Signature` query parameter and are effectively
 *     bearer tokens — they MUST NEVER appear in any log record.
 *   - AAP §0.8.1 Rule R8 (gates fail closed): SDK errors propagate; only
 *     the SDK's `ignoreNotFound: true` option translates 404 into a
 *     resolved promise on `delete`.
 *   - Story ST-014 (logo upload backend contract): the frontend obtains
 *     a v4 PUT signed URL from the backend to upload directly to GCS;
 *     the preview later fetches via a v4 GET signed URL with ≤15 min
 *     TTL.
 *   - Story ST-043 (unit suite): deterministic, local-only,
 *     no-network suite with co-located `*.test.ts`.
 *
 * What this file verifies:
 *   1. `createGcsService()` returns an object exposing the documented
 *      method surface (`getReadUrl`, `getUploadUrl`, `delete`).
 *   2. The Storage constructor receives `apiEndpoint: GCS_EMULATOR_HOST`
 *      WHEN `GCS_EMULATOR_HOST` is non-empty (LocalGCP path).
 *   3. The Storage constructor does NOT receive `apiEndpoint` when
 *      `GCS_EMULATOR_HOST` is empty (production path).
 *   4. EVERY `getSignedUrl` invocation passes `version: 'v4'` exactly
 *      — the architectural invariant of Rule R5 / C1. Read and upload
 *      URLs are both verified individually AND a final sweep test
 *      (`Test 21`) asserts the invariant across BOTH methods in a
 *      single arrange/act/assert.
 *   5. Read URLs use `action: 'read'` AND `expires = Date.now() +
 *      15 * 60 * 1000` (deterministic equality, not range, because
 *      `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now`).
 *   6. Upload URLs use `action: 'write'` AND a finite positive
 *      expiration in the future (the service author chooses the TTL;
 *      the test asserts only "finite positive future", not equality,
 *      so the implementation can adjust without breaking the suite).
 *   7. The `delete` method calls `file.delete({ ignoreNotFound: true })`
 *      and tolerates already-missing objects idempotently. Non-404
 *      SDK errors propagate (Rule R8).
 *   8. All three methods reject empty `objectKey` with a
 *      `ValidationError` whose message includes the field name.
 *   9. Rule R2 sweep: across all three methods, no log record ever
 *      contains a signed-URL substring (`X-Goog-Signature` or any
 *      portion of the secret query string).
 *
 * What this file does NOT verify:
 *   - Real GCS network behaviour (covered by integration tests).
 *   - The Storage SDK's `apiEndpoint` routing semantics (covered by
 *     the live LocalGCP integration suite).
 *   - The `prom-client` metrics emitted by other layers (out of scope
 *     for the GCS service).
 *
 * Determinism (ST-043-AC3):
 *   - `@google-cloud/storage` is replaced wholesale via `jest.mock`
 *     so no SDK call escapes the process.
 *   - `../config/env` is replaced with an in-memory mock whose values
 *     can be mutated per-test via `__setEnv`. This keeps the env
 *     contract testable WITHOUT polluting `process.env` (which would
 *     leak across worker boundaries under Jest's parallel runner).
 *   - `../logging/pino` is replaced with a no-op logger whose `info`
 *     etc. are `jest.fn()` so the Rule R2 sweep can inspect call
 *     arguments.
 *   - `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now()` so
 *     `expires = Date.now() + 15 * 60 * 1000` resolves to a known
 *     value the test asserts by exact equality.
 *
 * Locality (ST-043-AC4):
 *   ZERO network calls, ZERO file-system calls, ZERO services
 *   required to run this file. `npx jest --config jest.config.unit.ts
 *   src/services/gcs.service.test.ts` works on a workstation with no
 *   `docker compose` stack and no Firebase / GCS emulator running.
 *
 * @see backend/src/services/gcs.service.ts — module under test
 * @see backend/src/config/env.ts — supplies the typed `env` accessor
 *   that's mocked here
 * @see backend/src/logging/pino.ts — supplies the `logger` that's
 *   mocked here
 * @see backend/jest.config.unit.ts — Jest runner configuration
 *   (`clearMocks/resetMocks/restoreMocks` all `true`)
 * @see tickets/stories/ST-014-logo-upload-ui.md — frontend story whose
 *   backend contract requires v4 signed URLs
 * @see tickets/stories/ST-043-unit-test-suite.md — story specification
 */

// ===========================================================================
// Module-level mock primitives.
//
// These `jest.fn()` instances are referenced both by the hoisted
// `jest.mock('@google-cloud/storage', ...)` factory below AND by the
// `beforeEach` lifecycle hook. Declaring them at module scope lets the
// factory close over them so it returns a stable, assert-able mock
// surface.
//
// Important caveat about `resetMocks: true` (set in jest.config.unit.ts):
//   Jest resets every `jest.fn()` (clears implementations AND call
//   lists) before each test. Module-level mocks are NOT exempt. The
//   `beforeEach` below therefore re-establishes the Storage→bucket→file
//   chain on every test. Without this, `MockStorage()` would return
//   `undefined` and the gcs.service factory would fail to construct.
// ===========================================================================

const mockGetSignedUrl = jest.fn();
const mockDelete = jest.fn();
const mockFile = jest.fn();
const mockBucket = jest.fn();
const MockStorage = jest.fn();

// ---------------------------------------------------------------------------
// `jest.mock('@google-cloud/storage', factory)` — replace the GCS SDK.
//
// The factory below is hoisted by ts-jest to the top of the compiled
// module body, BEFORE every `import` statement. The hoisting is
// essential: the source module under test (`./gcs.service`) imports
// `Storage` from `@google-cloud/storage`, and that import must resolve
// to `MockStorage` rather than the real SDK. If the factory ran AFTER
// the static import, the module would have already captured the real
// SDK reference.
//
// `MockStorage` is declared at module scope above so the factory can
// close over it. The factory returns `{ Storage: MockStorage }` —
// the same shape the real package exports — so `import { Storage }
// from '@google-cloud/storage'` resolves to `MockStorage` directly.
// ---------------------------------------------------------------------------
jest.mock('@google-cloud/storage', () => ({
  Storage: MockStorage,
}));

// ---------------------------------------------------------------------------
// `jest.mock('../config/env', factory)` — replace the env accessor.
//
// The real `env` is a frozen object whose getters call `requireEnv()`
// which throws on unset variables. Tests need to vary
// `GCS_BUCKET_NAME` and `GCS_EMULATOR_HOST` per-test WITHOUT
// mutating `process.env` (which would leak across Jest worker
// boundaries and cross-contaminate other test files).
//
// The mock instead exposes a plain object `envMock` whose properties
// can be reassigned via `__setEnv()`. The gcs.service reads
// `env.GCS_BUCKET_NAME` / `env.GCS_EMULATOR_HOST` AT FACTORY CALL TIME
// (not at module load time — see `gcs.service.ts` lines 374-375), so
// mutating `envMock` between tests is sufficient for `createGcsService`
// to observe the new values.
//
// `requireEnv` is also exposed as a stub (it throws on absent values)
// for parity with the real module — gcs.service does not currently
// call `requireEnv` directly, but a future refactor might, and the
// stub keeps such a refactor from silently breaking the suite.
// ---------------------------------------------------------------------------
jest.mock('../config/env', () => {
  const envMock: { GCS_BUCKET_NAME: string; GCS_EMULATOR_HOST: string } = {
    GCS_BUCKET_NAME: 'test-bucket',
    GCS_EMULATOR_HOST: '',
  };
  return {
    env: envMock,
    requireEnv: jest.fn((name: string) => {
      const value = envMock[name as keyof typeof envMock];
      if (value === undefined || value === '') {
        throw new Error(`Required environment variable "${name}" is not set.`);
      }
      return value;
    }),
    /**
     * Test-only helper: mutate the in-memory env mock between tests.
     * Not part of the production env module's surface; exposed here so
     * tests can drive the emulator-vs-production code paths without
     * touching `process.env`.
     */
    __setEnv: (patch: Partial<typeof envMock>): void => {
      Object.assign(envMock, patch);
    },
  };
});

// ---------------------------------------------------------------------------
// `jest.mock('../logging/pino', factory)` — replace the structured logger.
//
// gcs.service emits exactly three log events (`gcs.configured`,
// `gcs.signed-url.issued`, `gcs.object.deleted`). The Rule R2 sweep
// test below scans every log call argument for any signed-URL
// substring; the mock therefore needs `info` / `warn` / `error` /
// `debug` as `jest.fn()` so `mock.calls` is inspectable.
//
// `child` is stubbed because pino-http (in production) sometimes
// invokes `logger.child()` for request-scoped loggers; the stub
// makes the mock robust to a future refactor without affecting
// current tests.
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

// ===========================================================================
// Runtime imports — MUST follow the `jest.mock` registrations above so the
// imports resolve to the mocked modules.
// ===========================================================================

import { createGcsService, ValidationError } from './gcs.service';
import { logger } from '../logging/pino';

// ===========================================================================
// Test-only helper: the env mock module surface.
//
// `require('../config/env')` resolves to the mocked module, which
// exposes the in-memory `env` object PLUS the `__setEnv` mutator
// helper. We type it explicitly because `require()` returns `any` and
// the `noImplicitAny` compiler option would otherwise reject the
// downstream property accesses.
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-var-requires
const envModule = require('../config/env') as {
  env: { GCS_BUCKET_NAME: string; GCS_EMULATOR_HOST: string };
  __setEnv: (
    patch: Partial<{ GCS_BUCKET_NAME: string; GCS_EMULATOR_HOST: string }>,
  ) => void;
};

// ===========================================================================
// Test fixtures.
// ===========================================================================

/**
 * Pinned wall-clock value used by `jest.useFakeTimers({ now: FIXED_NOW })`.
 * Every test that asserts an exact `expires` or `expiresAt` value
 * compares against this constant rather than `Date.now()`, which
 * makes the assertions deterministic across machines and time zones
 * (ST-043-AC3).
 */
const FIXED_NOW: Date = new Date('2026-01-15T10:00:00.000Z');

/**
 * The 15-minute read-URL TTL mandated by AAP §0.2.2 C1: "expires:
 * Date.now() + 15 * 60 * 1000". Mirroring the literal expression here
 * (rather than importing the source's `READ_URL_TTL_MS` constant) is
 * intentional: the test must independently encode the rule so that a
 * regression in the source constant is detected by THIS file rather
 * than self-validated through the source's own constant.
 */
const FIFTEEN_MIN_MS: number = 15 * 60 * 1000;

/**
 * A signed URL containing the `X-Goog-Signature` query parameter and
 * a deliberately recognisable secret payload. The Rule R2 sweep
 * scans log call arguments for these substrings; if any test
 * accidentally adds code that logs the URL, the substring match will
 * fire.
 */
const SENTINEL_SIGNED_URL: string =
  'https://storage.googleapis.com/bucket/obj?X-Goog-Algorithm=GOOG4-RSA-SHA256' +
  '&X-Goog-Signature=abc123XYZsecretmaterial';

// ===========================================================================
// Lifecycle hooks.
// ===========================================================================

beforeEach(() => {
  // Pin `Date.now()` to `FIXED_NOW`. The modern fake-timers backend
  // (Jest 27+) uses @sinonjs/fake-timers, which freezes both timer
  // functions AND `Date` to the supplied `now`. Tests that read
  // `Date.now()` therefore always receive `FIXED_NOW.getTime()`.
  jest.useFakeTimers({ now: FIXED_NOW });

  // Reset env defaults BEFORE each test so prior `__setEnv` calls
  // don't leak across tests. The Jest config's `resetMocks: true`
  // does NOT clear our `envMock` object's shape — only `jest.fn()`
  // instances — so we must reset the shape explicitly here.
  envModule.__setEnv({ GCS_BUCKET_NAME: 'test-bucket', GCS_EMULATOR_HOST: '' });

  // Re-establish the Storage → bucket → file → getSignedUrl/delete
  // chain. `resetMocks: true` (jest.config.unit.ts) cleared every
  // module-level `jest.fn()`'s implementation between tests; without
  // re-establishment, `MockStorage()` would return `undefined` and
  // the factory under test would fail to construct.
  mockGetSignedUrl.mockResolvedValue([SENTINEL_SIGNED_URL]);
  mockDelete.mockResolvedValue(undefined);
  mockFile.mockImplementation((_objectKey: string) => ({
    getSignedUrl: mockGetSignedUrl,
    delete: mockDelete,
  }));
  mockBucket.mockImplementation((_bucketName: string) => ({
    file: mockFile,
  }));
  MockStorage.mockImplementation((_opts?: unknown) => ({
    bucket: mockBucket,
  }));
});

afterEach(() => {
  // Restore real timers so any unrelated test in this worker is not
  // affected by lingering fake-timer state. `useRealTimers` also
  // detaches @sinonjs/fake-timers from `Date.now`.
  jest.useRealTimers();
});

// ===========================================================================
// Test suites.
// ===========================================================================

describe('createGcsService', () => {
  // -------------------------------------------------------------------------
  // factory — Storage construction, method surface, configuration log.
  // -------------------------------------------------------------------------
  describe('factory', () => {
    it('returns an object with getReadUrl, getUploadUrl, delete methods', () => {
      // Arrange & Act: invoke the factory under default env state
      // (`GCS_BUCKET_NAME='test-bucket'`, `GCS_EMULATOR_HOST=''`).
      const service = createGcsService();

      // Assert: the returned object exposes the documented surface.
      // `typeof === 'function'` is the right check rather than
      // `instanceof Function` — methods on object literals are
      // `function` for `typeof` but their prototype chain depends on
      // how the literal is constructed.
      expect(typeof service.getReadUrl).toBe('function');
      expect(typeof service.getUploadUrl).toBe('function');
      expect(typeof service.delete).toBe('function');
    });

    it('wires Storage with apiEndpoint = GCS_EMULATOR_HOST when the variable is set', () => {
      // Arrange: configure the emulator host to a recognisable value.
      // The factory reads env on every call, so we can mutate the env
      // mock and then call createGcsService without `jest.resetModules`.
      envModule.__setEnv({ GCS_EMULATOR_HOST: 'http://localhost:4443' });

      // Act: instantiate the service.
      createGcsService();

      // Assert: the Storage constructor received `apiEndpoint:
      // 'http://localhost:4443'`. We use `expect.objectContaining`
      // because the production code also sets `projectId` from
      // `process.env.FIREBASE_PROJECT_ID` in this branch, and we do
      // not want to be brittle against that auxiliary field.
      expect(MockStorage).toHaveBeenCalledTimes(1);
      expect(MockStorage).toHaveBeenCalledWith(
        expect.objectContaining({ apiEndpoint: 'http://localhost:4443' }),
      );
    });

    it('wires Storage WITHOUT apiEndpoint when GCS_EMULATOR_HOST is empty (production path)', () => {
      // Arrange: emulator host is empty (the default from beforeEach).
      // No __setEnv call needed — beforeEach already reset to ''.

      // Act: instantiate the service.
      createGcsService();

      // Assert: Storage was constructed exactly once. The options
      // argument either is `undefined` (no args), or is an object
      // that does NOT contain `apiEndpoint`. Both shapes satisfy
      // the production-path contract: never route through an
      // emulator when the environment doesn't enable one.
      expect(MockStorage).toHaveBeenCalledTimes(1);
      const callArgs: unknown = MockStorage.mock.calls[0]?.[0];
      if (callArgs !== undefined && callArgs !== null) {
        expect(callArgs).not.toHaveProperty('apiEndpoint');
      }
    });

    it('logs a single `gcs.configured` event on construction with bucket and emulator boolean', () => {
      // Arrange: enable the emulator path so the boolean flips to
      // `true` and we can assert both states are reachable. The
      // structural metadata (bucket name, emulator boolean) MUST be
      // logged; the host string itself MUST NOT (Rule R2 — the host
      // can carry credentials in pathological deploy configs).
      envModule.__setEnv({
        GCS_BUCKET_NAME: 'production-bucket',
        GCS_EMULATOR_HOST: 'http://localhost:4443',
      });

      // Act: instantiate and inspect the configuration log.
      createGcsService();

      // Assert: exactly one `info` call carrying the documented
      // structural fields. The host string itself is forbidden in
      // any log argument (Rule R2 sweep).
      const infoMock = logger.info as jest.Mock;
      const configCalls = infoMock.mock.calls.filter((call: unknown[]) => {
        const obj = call[0];
        return (
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { event?: string }).event === 'gcs.configured'
        );
      });
      expect(configCalls).toHaveLength(1);

      const configRecord = configCalls[0][0] as {
        event: string;
        bucket: string;
        emulator: boolean;
      };
      expect(configRecord.bucket).toBe('production-bucket');
      expect(configRecord.emulator).toBe(true);

      // Critical Rule R2 check: the emulator host string is NOT in
      // the log record (only the boolean). Serialising the entire
      // config record and substring-checking is the simplest
      // assertion that covers both the documented field set and any
      // future field that might accidentally include the host.
      expect(JSON.stringify(configRecord)).not.toContain('localhost:4443');
    });
  });

  // -------------------------------------------------------------------------
  // getReadUrl — Rule R5 / C1 verification, action='read', 15 min TTL.
  // -------------------------------------------------------------------------
  describe('getReadUrl', () => {
    it('passes version: "v4" to getSignedUrl (Rule R5 / C1)', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: exactly one signed-URL call, and the options object
      // contains the literal `version: 'v4'`. This is the
      // architectural invariant — every reviewer should grep for
      // this assertion and trust that gcs.service is the ONLY
      // place in `backend/src/` issuing signed URLs.
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(optionsArg).toEqual(expect.objectContaining({ version: 'v4' }));
    });

    it('passes action: "read" to getSignedUrl', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: read URLs use the SDK's `read` action verbatim. This
      // is what causes GCS to grant GET semantics on the signed URL;
      // a typo here would silently grant the wrong HTTP verb's
      // permissions.
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(optionsArg.action).toBe('read');
    });

    it('expires exactly 15 minutes from Date.now() for read URLs (C1)', async () => {
      // Arrange & Act under fake timers pinned to FIXED_NOW.
      const service = createGcsService();
      await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: deterministic equality because `Date.now()` is
      // pinned by `jest.useFakeTimers({ now: FIXED_NOW })`. Asserting
      // a range here would mask off-by-second regressions; equality
      // forces the source to use exactly `Date.now() + 15 * 60 *
      // 1000`, which is the verbatim AAP §0.2.2 C1 expression.
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(optionsArg.expires).toBe(FIXED_NOW.getTime() + FIFTEEN_MIN_MS);
    });

    it('targets bucket = GCS_BUCKET_NAME and the provided object key', async () => {
      // Arrange: switch to a recognisable bucket name and call
      // `getReadUrl` with a structured key. The factory reads env at
      // call time so a single `__setEnv` is sufficient.
      envModule.__setEnv({ GCS_BUCKET_NAME: 'strikeforge-logos' });

      // Act.
      const service = createGcsService();
      await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: the bucket name flows from env into the SDK call,
      // and the object key passes through untouched. Two assertions
      // because both flow paths are independent — a bug that
      // forgets to thread the bucket would still pass the object-key
      // assertion and vice versa.
      expect(mockBucket).toHaveBeenCalledWith('strikeforge-logos');
      expect(mockFile).toHaveBeenCalledWith('logos/user-1/my-logo.png');
    });

    it('returns the signed URL string and expiresAt as a Date', async () => {
      // Arrange & Act.
      const service = createGcsService();
      const result = await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: the return shape matches the `SignedUrlResult`
      // interface declared in the source.
      expect(typeof result.url).toBe('string');
      expect(result.url.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + FIFTEEN_MIN_MS);
    });

    it('rejects empty objectKey with ValidationError before calling the SDK', async () => {
      // Arrange.
      const service = createGcsService();

      // Act & Assert: rejection is a ValidationError whose message
      // mentions `objectKey`. Critically, `mockFile` is NOT called
      // — validation runs BEFORE any SDK call, so a malformed key
      // never reaches GCS even in a non-emulator environment.
      await expect(service.getReadUrl('')).rejects.toThrow(/objectKey/);
      await expect(service.getReadUrl('')).rejects.toBeInstanceOf(ValidationError);
      expect(mockFile).not.toHaveBeenCalled();
    });

    it('rejects objectKey containing ASCII control characters', async () => {
      // Arrange: a key with an embedded NUL (U+0000) is a classic
      // injection vector that breaks URL construction in proxies
      // and CLIs. The source's `validateObjectKey` rejects ANY
      // U+0000–U+001F char.
      const service = createGcsService();
      const maliciousKey = 'logos/user-1/\u0000injection.png';

      // Act & Assert: validation throws ValidationError with the
      // documented `code === 'OBJECT_KEY_INVALID_CHARS'` (a stable
      // machine-readable code so the route layer can map it to a
      // specific HTTP error body).
      let captured: unknown;
      try {
        await service.getReadUrl(maliciousKey);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(ValidationError);
      expect((captured as ValidationError).field).toBe('objectKey');
      expect((captured as ValidationError).code).toBe('OBJECT_KEY_INVALID_CHARS');
      // SDK is NEVER called for an invalid key — defence in depth.
      expect(mockFile).not.toHaveBeenCalled();
    });

    it('propagates SDK errors (Rule R8)', async () => {
      // Arrange: arrange the SDK to fail on the next call.
      mockGetSignedUrl.mockRejectedValueOnce(new Error('GCS unreachable'));

      // Act & Assert: the error propagates verbatim to the caller.
      // Rule R8 is "gates fail closed" — silently swallowing this
      // error would let the calling route return a stale or empty
      // URL to the user, which is worse than a 500.
      const service = createGcsService();
      await expect(service.getReadUrl('logos/user-1/my-logo.png')).rejects.toThrow(
        /GCS unreachable/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getUploadUrl — Rule R5 / C1 verification, action='write', finite TTL.
  // -------------------------------------------------------------------------
  describe('getUploadUrl', () => {
    it('passes version: "v4" to getSignedUrl (Rule R5 / C1)', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.getUploadUrl('logos/user-1/new.png');

      // Assert: same architectural invariant as `getReadUrl` — every
      // signed URL invocation MUST carry `version: 'v4'`.
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(optionsArg.version).toBe('v4');
    });

    it('passes action: "write" to getSignedUrl', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.getUploadUrl('logos/user-1/new.png');

      // Assert: upload URLs use `'write'` not `'read'`. ST-014 backend
      // contract: the frontend uses the URL with HTTP PUT. The SDK
      // grants PUT semantics specifically for `'write'`; any other
      // string would silently produce a URL the frontend cannot use.
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(optionsArg.action).toBe('write');
    });

    it('expires at a finite, positive, future time for upload URLs', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.getUploadUrl('logos/user-1/new.png');

      // Assert: the upload TTL is service-configurable (the source
      // currently uses 15 min, matching read URLs, but the test
      // asserts only "finite positive future" so a future TTL
      // adjustment doesn't break the suite). Unboundedly long
      // upload TTLs would extend the leaked-credential exposure
      // window (Rule R2 / R5) — `Number.isFinite` and `> Date.now()`
      // catch that class of regression.
      const optionsArg = mockGetSignedUrl.mock.calls[0][0];
      expect(typeof optionsArg.expires).toBe('number');
      expect(Number.isFinite(optionsArg.expires)).toBe(true);
      expect(optionsArg.expires).toBeGreaterThan(FIXED_NOW.getTime());
    });

    it('targets bucket = GCS_BUCKET_NAME and the provided object key', async () => {
      // Arrange: distinct bucket name to verify independence from
      // the read-URL test fixtures.
      envModule.__setEnv({ GCS_BUCKET_NAME: 'strikeforge-uploads' });

      // Act.
      const service = createGcsService();
      await service.getUploadUrl('logos/user-1/new.png');

      // Assert.
      expect(mockBucket).toHaveBeenCalledWith('strikeforge-uploads');
      expect(mockFile).toHaveBeenCalledWith('logos/user-1/new.png');
    });

    it('returns the signed URL string and expiresAt as a Date', async () => {
      // Arrange & Act.
      const service = createGcsService();
      const result = await service.getUploadUrl('logos/user-1/new.png');

      // Assert.
      expect(typeof result.url).toBe('string');
      expect(result.url.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('rejects empty objectKey with ValidationError before calling the SDK', async () => {
      // Arrange.
      const service = createGcsService();

      // Act & Assert.
      await expect(service.getUploadUrl('')).rejects.toThrow(/objectKey/);
      await expect(service.getUploadUrl('')).rejects.toBeInstanceOf(ValidationError);
      expect(mockFile).not.toHaveBeenCalled();
    });

    it('propagates SDK errors (Rule R8)', async () => {
      // Arrange: arrange the SDK to fail on the next call.
      mockGetSignedUrl.mockRejectedValueOnce(new Error('GCS quota exceeded'));

      // Act & Assert.
      const service = createGcsService();
      await expect(service.getUploadUrl('logos/user-1/new.png')).rejects.toThrow(
        /GCS quota exceeded/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // delete — idempotent on 404 via { ignoreNotFound: true }, propagates
  //          other SDK errors per Rule R8, validates input before SDK call.
  // -------------------------------------------------------------------------
  describe('delete', () => {
    it('invokes file.delete with { ignoreNotFound: true } for idempotency', async () => {
      // Arrange & Act.
      const service = createGcsService();
      await service.delete('logos/user-1/old.png');

      // Assert: the file is targeted by name AND the SDK option that
      // suppresses 404 is set. Using the SDK's own option (rather
      // than try/catch swallowing) expresses idempotent-delete
      // intent at the integration boundary, which is more
      // discoverable to reviewers.
      expect(mockFile).toHaveBeenCalledWith('logos/user-1/old.png');
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({ ignoreNotFound: true }),
      );
    });

    it('resolves without throwing when the object is already absent', async () => {
      // Arrange: the SDK resolves cleanly because `ignoreNotFound:
      // true` was set; in production the GCS server returns 200
      // (or 404 silently swallowed by the SDK).
      mockDelete.mockResolvedValueOnce(undefined);

      // Act & Assert: the method resolves to `undefined` (its
      // documented return) without throwing.
      const service = createGcsService();
      await expect(service.delete('logos/user-1/missing.png')).resolves.toBeUndefined();
    });

    it('propagates non-404 SDK errors (Rule R8)', async () => {
      // Arrange: simulate a permission error (a non-404 failure that
      // `ignoreNotFound` does NOT suppress).
      mockDelete.mockRejectedValueOnce(new Error('GCS permission denied'));

      // Act & Assert.
      const service = createGcsService();
      await expect(service.delete('logos/user-1/protected.png')).rejects.toThrow(
        /permission denied/,
      );
    });

    it('rejects empty objectKey with ValidationError before calling the SDK', async () => {
      // Arrange.
      const service = createGcsService();

      // Act & Assert.
      await expect(service.delete('')).rejects.toThrow(/objectKey/);
      await expect(service.delete('')).rejects.toBeInstanceOf(ValidationError);
      // Validation runs before any SDK call — `mockFile` is never
      // invoked in this test, proving the early return.
      expect(mockFile).not.toHaveBeenCalled();
    });

    it('targets bucket = GCS_BUCKET_NAME on every delete call', async () => {
      // Arrange.
      envModule.__setEnv({ GCS_BUCKET_NAME: 'strikeforge-cleanup' });

      // Act.
      const service = createGcsService();
      await service.delete('logos/user-1/old.png');

      // Assert: the env-supplied bucket name flows into the SDK call.
      expect(mockBucket).toHaveBeenCalledWith('strikeforge-cleanup');
    });
  });

  // -------------------------------------------------------------------------
  // Rule R2 / R5 cross-cutting sweeps — invariants across all methods.
  // -------------------------------------------------------------------------
  describe('Rule R2 / R5 architectural sweeps', () => {
    it('Rule R2: never logs the signed URL string in any log call', async () => {
      // Arrange: arrange the SDK to return a URL containing a
      // recognisable secret payload. If gcs.service ever (now or
      // in a future regression) logs the URL or any slice of it,
      // the substring check below will fire.
      const sentinelUrl =
        'https://storage.googleapis.com/bucket/obj?X-Goog-Signature=abc123XYZsecretmaterial';
      mockGetSignedUrl.mockResolvedValueOnce([sentinelUrl]);

      // Act.
      const service = createGcsService();
      await service.getReadUrl('logos/user-1/my-logo.png');

      // Assert: serialise every log call's argument list and assert
      // that NEITHER the unique signature substring NOR the marker
      // payload appears anywhere. Splitting into two substrings
      // (`X-Goog-Signature` and `abc123XYZsecretmaterial`) catches
      // both partial slicing (e.g. "logging the first 100 chars
      // for debugging") and full-URL leakage.
      const allLogArgs = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
        ...(logger.debug as jest.Mock).mock.calls,
      ];
      const serialized = JSON.stringify(allLogArgs);
      expect(serialized).not.toContain('X-Goog-Signature');
      expect(serialized).not.toContain('abc123XYZsecretmaterial');
    });

    it('Rule R2: never logs the signed URL across getUploadUrl either', async () => {
      // Arrange: same recognisable payload as the previous test, but
      // exercised via the upload path so a regression that affects
      // ONLY the upload code path is caught.
      const sentinelUrl =
        'https://storage.googleapis.com/bucket/obj?X-Goog-Signature=upload789XYZsecretmaterial';
      mockGetSignedUrl.mockResolvedValueOnce([sentinelUrl]);

      // Act.
      const service = createGcsService();
      await service.getUploadUrl('logos/user-1/new.png');

      // Assert.
      const allLogArgs = [
        ...(logger.info as jest.Mock).mock.calls,
        ...(logger.warn as jest.Mock).mock.calls,
        ...(logger.error as jest.Mock).mock.calls,
        ...(logger.debug as jest.Mock).mock.calls,
      ];
      const serialized = JSON.stringify(allLogArgs);
      expect(serialized).not.toContain('X-Goog-Signature');
      expect(serialized).not.toContain('upload789XYZsecretmaterial');
    });

    it('Rule R5 architectural invariant: every getSignedUrl call passes version: "v4"', async () => {
      // Arrange & Act: exercise BOTH signed-URL methods so the
      // sweep covers every call site simultaneously. If a future
      // method is added (e.g. `getResumableUploadUrl`) and it
      // forgets `version: 'v4'`, this loop will catch it as long
      // as the new method is exercised here.
      const service = createGcsService();
      await service.getReadUrl('k1');
      await service.getUploadUrl('k2');

      // Assert: every call's options argument includes version='v4'.
      // Looping is the right shape rather than two separate
      // assertions because the invariant is "for all calls", not
      // "for these specific calls".
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
      for (const call of mockGetSignedUrl.mock.calls) {
        const options = call[0];
        expect(options).toEqual(expect.objectContaining({ version: 'v4' }));
      }
    });

    it('Rule R2: structured log records carry the bucket and objectKey but not the URL', async () => {
      // Arrange: pin a recognisable bucket + key so we can assert
      // they appear in the log structure (positive assertion) while
      // the URL stays absent (negative assertion).
      envModule.__setEnv({ GCS_BUCKET_NAME: 'audit-bucket' });
      const sentinelUrl =
        'https://storage.googleapis.com/audit-bucket/key?X-Goog-Signature=audit-secret-xyz';
      mockGetSignedUrl.mockResolvedValueOnce([sentinelUrl]);

      // Act: issue a read URL.
      const service = createGcsService();
      await service.getReadUrl('audit-key');

      // Assert: the issuance log carries the structural fields
      // documented in gcs.service.ts (event, action, bucket,
      // objectKey, expiresAt) and ONLY those fields. The URL
      // itself is absent.
      const infoMock = logger.info as jest.Mock;
      const issuanceCalls = infoMock.mock.calls.filter((call: unknown[]) => {
        const obj = call[0];
        return (
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { event?: string }).event === 'gcs.signed-url.issued'
        );
      });
      expect(issuanceCalls.length).toBeGreaterThanOrEqual(1);

      const issuanceRecord = issuanceCalls[0][0] as {
        event: string;
        action: string;
        bucket: string;
        objectKey: string;
        expiresAt: string;
      };

      // Positive assertions: structural metadata is present and
      // matches the inputs / fixed clock.
      expect(issuanceRecord.event).toBe('gcs.signed-url.issued');
      expect(issuanceRecord.action).toBe('read');
      expect(issuanceRecord.bucket).toBe('audit-bucket');
      expect(issuanceRecord.objectKey).toBe('audit-key');
      expect(issuanceRecord.expiresAt).toBe(
        new Date(FIXED_NOW.getTime() + FIFTEEN_MIN_MS).toISOString(),
      );

      // Negative assertion: the secret URL substring does NOT
      // appear anywhere in the serialised record.
      expect(JSON.stringify(issuanceRecord)).not.toContain('X-Goog-Signature');
      expect(JSON.stringify(issuanceRecord)).not.toContain('audit-secret-xyz');
    });

    it('Rule R8: a single ValidationError instance has `name === "ValidationError"`', async () => {
      // Arrange.
      const service = createGcsService();

      // Act: capture the rejection rather than relying on
      // `rejects.toThrow` so we can inspect the error object's own
      // properties (the `name` field is what generic error
      // handlers use to discriminate; `instanceof` is sometimes
      // unreliable across module-realm boundaries).
      let captured: unknown;
      try {
        await service.getReadUrl('');
      } catch (err) {
        captured = err;
      }

      // Assert.
      expect(captured).toBeInstanceOf(ValidationError);
      expect((captured as ValidationError).name).toBe('ValidationError');
      expect((captured as ValidationError).field).toBe('objectKey');
    });
  });
});

