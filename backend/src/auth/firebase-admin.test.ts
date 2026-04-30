/**
 * Unit tests for `backend/src/auth/firebase-admin.ts` — Firebase Admin SDK
 * initialization wrapper.
 *
 * Authority:
 *   - AAP §0.8.1 Rule R3 — Firebase Admin SDK ONLY; no custom JWT parsing,
 *     signature verification, expiry checking, or JWKS fetching anywhere in
 *     the backend. Token validation calls `admin.auth().verifyIdToken()` and
 *     nothing else. This test file MUST NOT import `jsonwebtoken`, `jose`,
 *     or `jwt-decode`.
 *   - AAP §0.8.1 Rule R4 — The six required env vars throw at startup when
 *     unset. `FIREBASE_PROJECT_ID` is one of those six. The initializer's
 *     fail-fast behaviour is verified below.
 *   - AAP §0.6.13 — Every backend service has a co-located `*.test.ts`.
 *   - Story ST-043 (acceptance criteria):
 *       * The suite is deterministic — repeated runs produce the same
 *         pass/fail verdict (ST-043-AC3).
 *       * The suite runs in the local development environment WITHOUT any
 *         additional services or network access beyond the standard local
 *         toolchain (ST-043-AC4). No emulator, no database, no real
 *         Firebase Auth service.
 *
 * Strategy:
 *   The `firebase-admin` package is replaced wholesale via `jest.mock(...)`
 *   so the unit suite never invokes the real SDK. The mock provides
 *   spy-able `initializeApp`, `auth`, and `credential.applicationDefault`
 *   functions whose call counts and arguments are asserted directly. Each
 *   test forces a fresh load of `./firebase-admin` via
 *   `jest.resetModules()` + `await import('./firebase-admin')` so the
 *   module's singleton state (`initialized`, `authInstance`) starts clean
 *   on every test. `process.env` is snapshotted in `beforeEach` and
 *   restored in `afterEach` so env mutations cannot leak across tests.
 *
 *   This combination satisfies ST-043-AC3 (determinism) and ST-043-AC4
 *   (no network) — both directly verifiable by running this file with no
 *   docker-compose stack and no Firebase emulator running.
 *
 * Module-identity caveat:
 *   `jest.resetModules()` invalidates the require cache so a subsequent
 *   `await import('./firebase-admin')` evaluates the source module
 *   afresh, which transitively re-loads `../config/env.ts`. The
 *   `MissingEnvVarError` class thrown by `requireEnv` therefore has a
 *   different JavaScript identity from any reference imported at the
 *   top of this test file. Tests use STRUCTURAL property matching
 *   (`err.name`, `err.message`) instead of `instanceof MissingEnvVarError`
 *   to side-step this well-known Jest behaviour. This is safe because
 *   `MissingEnvVarError` sets a stable `name` field of
 *   `'MissingEnvVarError'` and a typed `variableName` property — both
 *   observable without reference equality.
 *
 * What this suite does NOT cover:
 *   - Firebase Auth Emulator routing via `FIREBASE_AUTH_EMULATOR_HOST`.
 *     That is an SDK-internal behaviour observable only when the real
 *     SDK is initialised, and verifying it requires a live emulator —
 *     which would violate ST-043-AC4. Emulator routing is covered by
 *     `backend/tests/integration/auth/` instead.
 *   - Actual `verifyIdToken` calls. Token verification lives in
 *     `services/session.service.ts` and is verified there; this file
 *     only exercises the initializer that returns the `Auth` handle.
 *   - The Rule R3 dependency allow-list (no `jsonwebtoken` etc.). That
 *     is a CI-pipeline grep gate documented in the lint step, not a
 *     unit test concern; a placeholder structural assertion below
 *     records the intent without duplicating the gate.
 *
 * @see backend/src/auth/firebase-admin.ts — module under test
 * @see backend/src/config/env.ts — supplies `requireEnv` and `MissingEnvVarError`
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-043-unit-test-suite.md — story specification
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md — middleware contract this initializer powers
 */

// Top-level type-only imports so `consistent-type-imports` is satisfied
// and the type aliases re-exported by `./firebase-admin` are available
// inside the type-level assertions in the "type re-exports" describe
// block below. Type-only imports are erased by the TypeScript compiler
// and therefore do NOT bypass `jest.resetModules()` — they have no
// runtime presence to bypass.
import type { DecodedIdToken, FirebaseAuth } from './firebase-admin';

// ---------------------------------------------------------------------------
// `jest.mock('firebase-admin', factory)` — the cornerstone of unit isolation.
// ---------------------------------------------------------------------------
//
// The factory below builds a complete double of the firebase-admin v12
// surface this module touches: `initializeApp`, `auth`, and
// `credential.applicationDefault`. The double is intentionally minimal —
// it includes ONLY the methods the source file calls, so any future drift
// (e.g. the source starts calling `admin.firestore`) immediately surfaces
// as an undefined-property error at test time rather than silently
// passing on a stale mock.
//
// Both the `default` property AND the named exports are populated. The
// source file uses `import admin from 'firebase-admin'` (default import
// under `esModuleInterop: true`), so the `default.*` path is the active
// surface. The named exports are belt-and-suspenders coverage in case a
// future refactor switches to named imports — the mock will keep working
// without modification.
//
// Why hoist the factory: `jest.mock(...)` is automatically hoisted by
// the Jest preprocessor to the top of the file (above every `import`),
// so the mock is registered BEFORE any module under test loads
// `firebase-admin`. This ordering is essential — a mock registered after
// the source module's `require('firebase-admin')` would be ignored.
//
// Why a factory rather than a manual `__mocks__/firebase-admin.ts`:
// keeping the mock factory inline next to the assertions means the
// reader sees the entire test contract (mock shape + assertions) in one
// file. The `__mocks__` folder pattern is reserved for mocks shared
// across many test files; this mock is unique to this single suite.
// ---------------------------------------------------------------------------

jest.mock('firebase-admin', () => {
  // The auth instance shape — it MUST expose at least `verifyIdToken`
  // because that is the C2/R3 contract surface every consumer relies
  // on. We add the three other methods the source file's JSDoc
  // documents (`getUser`, `createUser`, `revokeRefreshTokens`) so the
  // returned shape closely matches the real `admin.auth.Auth` surface
  // and so future tests of session.service / auth-routes that exercise
  // those methods on the same mock continue to pass.
  const mockAuthInstance = {
    verifyIdToken: jest.fn(),
    getUser: jest.fn(),
    createUser: jest.fn(),
    revokeRefreshTokens: jest.fn(),
  };

  // The credential object — `applicationDefault` returns a marker
  // object so assertions can verify the source file passed
  // `admin.credential.applicationDefault()` to `initializeApp` rather
  // than some other credential (e.g. `admin.credential.cert(...)`,
  // which would break Cloud Run / emulator parity).
  const mockCredential = {
    applicationDefault: jest.fn(() => ({ kind: 'mock-application-default-credential' })),
  };

  // Both the default-import shape and the named-import shape are
  // populated. `__esModule: true` flags the module to TypeScript's
  // `esModuleInterop` machinery so `import admin from 'firebase-admin'`
  // resolves to the `default` property — the same behaviour as the
  // real package's published types.
  return {
    __esModule: true,
    default: {
      initializeApp: jest.fn(),
      auth: jest.fn(() => mockAuthInstance),
      credential: mockCredential,
    },
    initializeApp: jest.fn(),
    auth: jest.fn(() => mockAuthInstance),
    credential: mockCredential,
  };
});

// ---------------------------------------------------------------------------
// Process-env snapshot helpers.
// ---------------------------------------------------------------------------
//
// `process.env` is a global object shared across every test in the
// worker. Mutating it directly without restoration leaks state into
// adjacent tests and makes failures depend on test ordering. The
// pattern below is the canonical Jest-friendly isolation:
//
//   1. Snapshot the original `process.env` reference at module load.
//   2. In `beforeEach`, replace `process.env` with a FRESH CLONE of
//      the original. Tests then mutate the clone freely.
//   3. In `afterEach`, reassign the original reference back. The
//      clone is GC'd; the original is unmodified.
//
// We pre-populate the clone with all six required env vars (per
// AAP §0.1.3 / Rule R4) so any transitive `requireEnv` call from the
// module graph (e.g. `db/pool.ts` if it were ever loaded) finds a
// non-empty value. Individual tests further mutate
// `process.env['FIREBASE_PROJECT_ID']` to drive the failure / success
// matrix.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV: NodeJS.ProcessEnv = process.env;

beforeEach(() => {
  // `jest.resetModules()` invalidates the require cache so every
  // `await import('./firebase-admin')` below evaluates the source
  // module afresh — the singleton state (`initialized`, `authInstance`)
  // starts at the documented initial values.
  jest.resetModules();

  // `jest.clearAllMocks()` clears `.mock.calls` / `.mock.results` /
  // `.mock.instances` arrays on every `jest.fn()`. This is what makes
  // `expect(admin.initializeApp).toHaveBeenCalledTimes(1)` actually
  // assertable per-test rather than across the whole file.
  jest.clearAllMocks();

  // Fresh clone of the original env. Tests mutate this clone freely.
  // The six required env vars are seeded so the env contract is
  // satisfied even when a test mutates only one of them.
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL: 'postgres://localhost:5432/strikeforge_unit_test',
    FIREBASE_PROJECT_ID: 'strikeforge-unit-test',
    GCS_BUCKET_NAME: 'strikeforge-unit-test-bucket',
    GCS_EMULATOR_HOST: 'http://localhost:4443',
    COVERAGE_THRESHOLD: '80',
    GCP_REGION: 'us-central1',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------
// Initialisation — happy-path contract.
// ---------------------------------------------------------------------------
//
// These tests assert that on the FIRST call after a fresh module load:
//   1. `admin.initializeApp` is invoked exactly once.
//   2. The argument object includes `projectId` from FIREBASE_PROJECT_ID.
//   3. The argument object includes a `credential` produced by
//      `admin.credential.applicationDefault()`.
//   4. The function returns the value of `admin.auth()`.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — happy-path initialisation', () => {
  it('calls admin.initializeApp once with projectId from FIREBASE_PROJECT_ID', async () => {
    // Arrange — set a unique project id so the assertion is meaningful.
    process.env['FIREBASE_PROJECT_ID'] = 'my-test-project';

    // Dynamically import AFTER `jest.resetModules()` so both the test
    // and the source module observe the same mocked firebase-admin
    // instance (the mock factory is re-evaluated on first import after
    // `resetModules()` and the resulting object is cached for both
    // imports below).
    const admin = (await import('firebase-admin')).default;
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    // Act
    initializeFirebaseAdmin();

    // Assert — exactly one initializeApp call, with the env-derived
    // projectId. We use `objectContaining` so future additions to the
    // options object (e.g. `databaseURL` if the project ever needs
    // Firestore) do not break this assertion.
    expect(admin.initializeApp).toHaveBeenCalledTimes(1);
    expect(admin.initializeApp).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'my-test-project' }),
    );
  });

  it('uses admin.credential.applicationDefault() to resolve credentials', async () => {
    // The `applicationDefault()` resolver is the canonical
    // production-and-emulator-safe credential path (AAP §0.6.13 /
    // firebase-admin.ts JSDoc). Asserting this call site explicitly
    // guards against accidental regressions to `admin.credential.cert(...)`
    // or some other helper that would break local dev OR Cloud Run.
    const admin = (await import('firebase-admin')).default;
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    initializeFirebaseAdmin();

    expect(admin.credential.applicationDefault).toHaveBeenCalledTimes(1);
    // The credential argument passed to initializeApp MUST be the
    // marker object the mock factory's `applicationDefault` returns —
    // proving the source plumbed the value through to initializeApp
    // without intermediate substitution.
    expect(admin.initializeApp).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          kind: 'mock-application-default-credential',
        }),
      }),
    );
  });

  it('returns the admin.auth() instance', async () => {
    // The C2 contract surface: every authenticated route ultimately
    // calls `verifyIdToken` on the value returned here. Asserting the
    // shape of the return value guarantees the wiring is correct.
    const admin = (await import('firebase-admin')).default;
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    const authInstance = initializeFirebaseAdmin();

    expect(admin.auth).toHaveBeenCalled();
    expect(authInstance).toBeDefined();
    // The mock auth instance is shaped to match firebase-admin v12's
    // real `Auth` interface for the methods this codebase touches.
    expect(authInstance).toHaveProperty('verifyIdToken');
    expect(typeof (authInstance as { verifyIdToken: unknown }).verifyIdToken).toBe('function');
  });

  it('returns an object with the canonical Auth shape (verifyIdToken + getUser + createUser)', async () => {
    // A second smoke shape check that asserts a wider footprint of
    // the Auth surface. This catches mock-factory drift early — if
    // a future refactor accidentally narrows the mock's `auth()`
    // return value, this assertion fails before any consumer test
    // breaks subtly.
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    const authInstance = initializeFirebaseAdmin() as {
      verifyIdToken: unknown;
      getUser: unknown;
      createUser: unknown;
    };

    expect(typeof authInstance.verifyIdToken).toBe('function');
    expect(typeof authInstance.getUser).toBe('function');
    expect(typeof authInstance.createUser).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — repeated calls return the cached instance.
// ---------------------------------------------------------------------------
//
// A second `admin.initializeApp(...)` call with no `name` argument
// throws `FirebaseAppError: Firebase app named '[DEFAULT]' already
// exists`. The source file's singleton guard MUST prevent that. These
// tests assert the guard works and the cached `Auth` instance is
// returned by reference.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — idempotency', () => {
  it('does NOT call initializeApp a second time on the second invocation', async () => {
    const admin = (await import('firebase-admin')).default;
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    const firstResult = initializeFirebaseAdmin();
    const secondResult = initializeFirebaseAdmin();

    // The SDK is initialised exactly once across the two calls.
    expect(admin.initializeApp).toHaveBeenCalledTimes(1);
    // Both invocations return the same cached Auth reference.
    expect(secondResult).toBe(firstResult);
  });

  it('returns the same auth instance on three or more subsequent calls (singleton stability)', async () => {
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    const a = initializeFirebaseAdmin();
    const b = initializeFirebaseAdmin();
    const c = initializeFirebaseAdmin();

    // Strict reference equality — the singleton cache must persist.
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('does NOT throw FirebaseAppError on repeated invocations', async () => {
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    // Two consecutive calls must not throw. Without the singleton
    // guard, the second `admin.initializeApp(...)` call would throw
    // `FirebaseAppError: Firebase app named '[DEFAULT]' already
    // exists`. The guard prevents this.
    expect(() => initializeFirebaseAdmin()).not.toThrow();
    expect(() => initializeFirebaseAdmin()).not.toThrow();
  });

  it('returns cached instance on second call even after FIREBASE_PROJECT_ID is cleared', async () => {
    // Rule R4 is checked at the FIRST call; subsequent calls return
    // the cached instance without re-reading the env. This confirms
    // the singleton survives transient env mutations and matches the
    // documented "first call reads env, all later calls return cache"
    // contract.
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    const first = initializeFirebaseAdmin();

    // Now clear the env — the second call should still succeed and
    // return the cached reference.
    delete process.env['FIREBASE_PROJECT_ID'];

    const second = initializeFirebaseAdmin();
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Rule R4 — fail-fast on missing FIREBASE_PROJECT_ID.
// ---------------------------------------------------------------------------
//
// `FIREBASE_PROJECT_ID` is one of the six required env vars enumerated
// in AAP §0.1.3. Per Rule R4, `initializeFirebaseAdmin()` MUST throw
// a descriptive error when the var is undefined or empty.
//
// These tests assert STRUCTURAL properties of the thrown error
// (`name`, `message`) rather than `instanceof MissingEnvVarError`
// because `jest.resetModules()` causes the env module to be re-loaded
// inside the isolated test graph. The re-loaded `MissingEnvVarError`
// class has a different JS identity from any reference imported at
// the top of this test file — `instanceof` would falsely report
// mismatch. Operators / handlers that consume this error in
// production check `err.name` and `err.message`, never identity, so
// matching against those is more robust.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — Rule R4 fail-fast', () => {
  it('throws when FIREBASE_PROJECT_ID is undefined', async () => {
    delete process.env['FIREBASE_PROJECT_ID'];

    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    // The thrown error's message contains the offending variable
    // name, satisfying Rule R4's "descriptive error" requirement.
    expect(() => initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('throws when FIREBASE_PROJECT_ID is the empty string (empty-string policy)', async () => {
    // Per `requireEnv`, empty strings are treated as unset — a
    // `FIREBASE_PROJECT_ID=` line in `.env` with no value is a
    // misconfiguration that MUST fail per Rule R4.
    process.env['FIREBASE_PROJECT_ID'] = '';

    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    expect(() => initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('thrown error is an Error subclass with a descriptive message naming the var and the word "fatal"', async () => {
    delete process.env['FIREBASE_PROJECT_ID'];

    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    let captured: unknown;
    try {
      initializeFirebaseAdmin();
      // If the call did not throw, fail explicitly. Reaching this
      // line indicates a Rule R4 regression — the guard is missing.
      throw new Error('initializeFirebaseAdmin did not throw when FIREBASE_PROJECT_ID was unset');
    } catch (err) {
      captured = err;
    }

    // The captured value MUST be an Error subclass — `Error` is a
    // built-in global shared across module graphs (unlike user-
    // defined subclasses), so this `instanceof` check is identity-
    // safe even after `jest.resetModules()`.
    expect(captured).toBeInstanceOf(Error);

    // Structural shape per the `MissingEnvVarError` contract in
    // `backend/src/config/env.ts`:
    //   - name === 'MissingEnvVarError' (set explicitly in constructor)
    //   - message names the offending variable
    //   - message uses the word "fatal" so log scrapers / alerts can
    //     distinguish it from non-fatal validation errors.
    expect(captured).toMatchObject({
      name: 'MissingEnvVarError',
      variableName: 'FIREBASE_PROJECT_ID',
    });
    const message = (captured as Error).message;
    expect(message).toContain('FIREBASE_PROJECT_ID');
    expect(message).toMatch(/fatal/i);
  });

  it('a failed first call (missing env) does NOT poison subsequent calls (recovery contract)', async () => {
    // First attempt: env unset → throws.
    delete process.env['FIREBASE_PROJECT_ID'];

    const admin = (await import('firebase-admin')).default;
    const { initializeFirebaseAdmin } = await import('./firebase-admin');

    expect(() => initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);

    // The module-level `initialized` flag must still be `false`, so
    // the operator can fix the env var and retry without manually
    // resetting the module. This is the documented recovery contract.
    process.env['FIREBASE_PROJECT_ID'] = 'recovered-project-id';
    const auth = initializeFirebaseAdmin();

    expect(auth).toBeDefined();
    expect(typeof (auth as { verifyIdToken: unknown }).verifyIdToken).toBe('function');
    // `initializeApp` is finally called exactly once — the failed
    // first attempt did NOT invoke it (because the throw happened
    // before any SDK side effect), so the second call is the first
    // and only successful initialization.
    expect(admin.initializeApp).toHaveBeenCalledTimes(1);
    expect(admin.initializeApp).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'recovered-project-id' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Type re-exports — compile-level usability assertion.
// ---------------------------------------------------------------------------
//
// `FirebaseAuth` and `DecodedIdToken` are type-only re-exports from
// `firebase-admin.ts`. They erase to nothing at runtime, so we cannot
// assert their existence as runtime properties. Instead, we rely on
// the TypeScript compiler: if these aliases drifted from the upstream
// definition, this test file would fail to compile under
// `tsc --noEmit` and the unit-test gate would block the merge.
// ---------------------------------------------------------------------------

describe('firebase-admin type re-exports', () => {
  it('exposes initializeFirebaseAdmin as the sole runtime export of the module', async () => {
    // This guard catches accidental runtime exports (e.g. someone
    // accidentally writing `export const admin = ...` would surface
    // here). At runtime, only `initializeFirebaseAdmin` is a value;
    // `FirebaseAuth` and `DecodedIdToken` are erased TypeScript types.
    const mod = await import('./firebase-admin');
    expect(mod).toHaveProperty('initializeFirebaseAdmin');
    expect(typeof mod.initializeFirebaseAdmin).toBe('function');
  });

  it('runtime export surface contains exactly initializeFirebaseAdmin (Rule R3 / AAP forbidden-pattern check)', async () => {
    const mod = await import('./firebase-admin');

    // Sort the runtime keys for a deterministic comparison.
    const runtimeKeys = Object.keys(mod).sort();
    expect(runtimeKeys).toEqual(['initializeFirebaseAdmin']);

    // Specifically, `verifyIdToken` MUST NOT be re-exported as a
    // wrapper from this module. Per AAP Phase 9 forbidden patterns,
    // verification lives exactly once in `services/session.service.ts`.
    expect((mod as Record<string, unknown>)['verifyIdToken']).toBeUndefined();

    // The `admin` namespace MUST NOT leak through this module either.
    // Re-exporting it would multiply the Rule R3 verification surface
    // because every consumer would gain access to JWT-adjacent SDK
    // methods.
    expect((mod as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('FirebaseAuth and DecodedIdToken are usable at the type level (compile-time check)', async () => {
    // The body below compiles only if both type aliases are valid
    // and structurally compatible with their upstream definitions.
    // The runtime assertions are token — the value of this test is
    // the compile-time coupling it creates between the source's type
    // re-exports and downstream consumers.
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const firebaseAdminModule = await import('./firebase-admin');
    const auth: typeof firebaseAdminModule extends { initializeFirebaseAdmin: () => infer R }
      ? R
      : never = firebaseAdminModule.initializeFirebaseAdmin();

    // `FirebaseAuth` must be a usable annotation for the
    // initializer's return value. If the alias drifted, this line
    // would fail to compile.
    const annotated: FirebaseAuth = auth;
    expect(annotated).toBeDefined();

    // `DecodedIdToken` must be assignable from a structurally
    // compatible literal. If the alias drifted, this line would
    // fail to compile under `strict: true`.
    const decoded: DecodedIdToken = {
      aud: 'strikeforge-unit-test',
      auth_time: 0,
      exp: 0,
      iat: 0,
      iss: 'https://securetoken.google.com/strikeforge-unit-test',
      sub: 'unit-test-uid',
      uid: 'unit-test-uid',
      firebase: {
        identities: {},
        sign_in_provider: 'password',
      },
    };
    expect(decoded.uid).toBe('unit-test-uid');
    expect(decoded.aud).toBe('strikeforge-unit-test');
  });
});

// ---------------------------------------------------------------------------
// Rule R3 — verification-by-import-allow-list.
// ---------------------------------------------------------------------------
//
// Rule R3 forbids `jsonwebtoken`, `jose`, and `jwt-decode` anywhere in
// the backend dependency graph. The actual enforcement is a CI grep
// gate (per AAP §0.8.1 R3 verification: "no jsonwebtoken, jose, or
// jwt-decode packages in backend/package.json") plus the lint step in
// `cloudbuild.yaml`. This test records the structural intent in unit
// form so the requirement is discoverable from the test suite and so
// the file under test stays loadable end-to-end (proving its imports
// all resolve under the strict `firebase-admin`-only allow-list).
// ---------------------------------------------------------------------------

describe('Rule R3 — Firebase Admin SDK is the SOLE auth primitive', () => {
  it('module loads cleanly under the firebase-admin-only allow-list', async () => {
    // If this file imported `jsonwebtoken`, `jose`, or `jwt-decode`
    // at any depth, the dynamic import below would fail because
    // those packages are NOT listed in `backend/package.json`. A
    // clean load proves the source's import graph is allow-list
    // compliant.
    const mod = await import('./firebase-admin');
    expect(mod).toBeDefined();
    expect(mod.initializeFirebaseAdmin).toBeDefined();
  });
});
