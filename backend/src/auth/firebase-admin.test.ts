/**
 * Unit tests for `backend/src/auth/firebase-admin.ts`.
 *
 * Verifies the three exports (`initializeFirebaseAdmin`, `FirebaseAuth`,
 * `DecodedIdToken`) against the contract documented in the source file:
 *
 *   1. Calling `initializeFirebaseAdmin()` with `FIREBASE_PROJECT_ID`
 *      unset throws `MissingEnvVarError` (Rule R4).
 *   2. Calling `initializeFirebaseAdmin()` with `FIREBASE_PROJECT_ID`
 *      set returns an object with a `verifyIdToken` method (the C2
 *      contract surface).
 *   3. `initializeFirebaseAdmin()` is idempotent within a single
 *      module instance — repeated calls return the SAME reference
 *      without re-initializing the SDK.
 *   4. The exported `FirebaseAuth` and `DecodedIdToken` type aliases
 *      are usable at the type level (verified by import + structural
 *      assignment compiling cleanly).
 *
 * Authority:
 *   - Story ST-043 acceptance criteria (deterministic, local-only, no
 *     network access).
 *   - Rule R3 / Constraint C2 (AAP §0.8.1): the function returns the
 *     SOLE handle to `verifyIdToken()` in the codebase; callers must
 *     not need any other SDK primitive.
 *   - Rule R4 (AAP §0.8.1): `FIREBASE_PROJECT_ID` is one of the six
 *     required env vars; missing → throw at startup.
 *
 * Determinism (ST-043-AC3):
 *   Each test re-loads the module under test inside a
 *   `jest.isolateModules` callback so that the module's singleton
 *   flags (`initialized`, `authInstance`) start fresh on every test.
 *   `process.env` is cloned in `beforeEach` and restored in
 *   `afterEach` so env mutations do not leak across tests.
 *
 *   Module-identity caveat: When `jest.isolateModules` re-loads
 *   `firebase-admin.ts`, it transitively re-loads `../config/env.ts`
 *   inside the isolated graph. The `MissingEnvVarError` class thrown
 *   by `requireEnv` therefore has a DIFFERENT JavaScript identity
 *   from the class imported at the test file's top level. Tests use
 *   STRUCTURAL property matching (`err.name`, `err.variableName`)
 *   instead of `instanceof MissingEnvVarError` to side-step this
 *   well-known Jest behaviour. This is safe because the source
 *   contract specifies a stable `name` field of `'MissingEnvVarError'`
 *   and a typed `variableName` property — both observable without
 *   reference equality.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls. The Firebase Admin SDK's
 *   `admin.initializeApp(...)` does NOT contact Firebase — it just
 *   stores the configuration; the first network call would happen on
 *   `verifyIdToken(...)`, which this suite does NOT exercise. The
 *   suite therefore runs on any developer workstation with no
 *   external services or network access.
 *
 * @see backend/src/auth/firebase-admin.ts — module under test
 * @see backend/jest.config.unit.ts — Jest runner configuration
 * @see tickets/stories/ST-043-unit-test-suite.md — story specification
 */

// Top-level type-only import so the `consistent-type-imports` rule is
// satisfied. The actual runtime module is loaded inside each test via
// `jest.isolateModules` to reset the singleton state between tests.
import type * as FirebaseAdminModule from './firebase-admin';

// ---------------------------------------------------------------------------
// Module-loading helper.
// ---------------------------------------------------------------------------
//
// `jest.isolateModules(fn)` evaluates `fn` with a fresh require cache,
// so the module under test re-initializes its top-level `let` bindings
// (`initialized = false`, `authInstance = null`) on every invocation.
// This is the documented mechanism by which the idempotency assertions
// below pass without manual module reset.
//
// We capture the freshly loaded module into an outer variable via a
// closure. Using a closure rather than returning the value from
// `isolateModules` is necessary because `isolateModules` is synchronous
// and returns `void` — the closure assignment is the canonical pattern.
//
// The `// eslint-disable-next-line` directive disables the
// `@typescript-eslint/no-var-requires` rule for the single line where
// the dynamic require is unavoidable. The `as typeof
// FirebaseAdminModule` cast preserves type safety: the returned object
// is statically typed as the module's export shape, so any drift
// between the test's expectations and the source file's exports
// surfaces at compile time.
// ---------------------------------------------------------------------------

function loadModuleFresh(): typeof FirebaseAdminModule {
  let mod: typeof FirebaseAdminModule | undefined;
  jest.isolateModules(() => {
    // The `require` here is the only way to load a module inside an
    // `isolateModules` callback while keeping the call inside the
    // synchronous boundary that the singleton-flag reset relies on.
    // `await import(...)` would defer execution past the callback's
    // lifetime, defeating the isolation.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('./firebase-admin') as typeof FirebaseAdminModule;
  });
  // The type assertion below is safe because `jest.isolateModules`
  // either invokes the callback synchronously (assigning `mod`) or
  // throws — there is no path where `mod` remains undefined after
  // `isolateModules` returns normally. The assertion keeps the
  // function signature non-nullable for the call sites.
  if (mod === undefined) {
    throw new Error(
      'jest.isolateModules did not synchronously assign the firebase-admin module — ' +
        'this indicates a Jest configuration regression.',
    );
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Process-env snapshot helpers.
// ---------------------------------------------------------------------------
//
// `process.env` is a global object shared by every test in the worker.
// Mutating it directly without restoration leaks state into adjacent
// tests and makes failures depend on test ordering. The pattern below
// is the canonical Jest-friendly way to isolate env mutations:
//
//   1. Snapshot the original `process.env` reference at module load.
//   2. In `beforeEach`, replace `process.env` with a fresh clone of
//      the original. Tests then mutate the clone freely.
//   3. In `afterEach`, reassign the original reference back. The
//      clone is GC'd; the original is unmodified.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV: NodeJS.ProcessEnv = process.env;

beforeEach(() => {
  // Fresh clone of the original env. Tests mutate this clone freely.
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------
// Rule R4 — missing FIREBASE_PROJECT_ID throws MissingEnvVarError.
// ---------------------------------------------------------------------------
//
// These tests use STRUCTURAL property matching (`name`, `variableName`,
// message regex) instead of `instanceof MissingEnvVarError`. The
// `MissingEnvVarError` class loaded inside `jest.isolateModules` has a
// different JavaScript identity from the same class imported at the
// test file's top level (a well-known Jest module-graph behaviour), so
// `instanceof` would falsely report mismatch. The structural surface
// (`err.name === 'MissingEnvVarError'`, `err.variableName === '...'`)
// is the contract that operators / handlers actually rely on, so
// matching against it is more robust AND test-meaningful than identity.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — Rule R4 fail-fast', () => {
  it('throws an error with name "MissingEnvVarError" when FIREBASE_PROJECT_ID is undefined', () => {
    delete process.env['FIREBASE_PROJECT_ID'];

    const mod = loadModuleFresh();
    // toThrow with a regex matches against err.message; the message
    // is built by `MissingEnvVarError`'s constructor and includes
    // both the variable name and the word "fatal" by contract.
    expect(() => mod.initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('throws when FIREBASE_PROJECT_ID is the empty string', () => {
    // Per `requireEnv`, empty strings are treated as unset (a
    // `FIREBASE_PROJECT_ID=` line in `.env` with no value is a
    // misconfiguration that MUST fail).
    process.env['FIREBASE_PROJECT_ID'] = '';

    const mod = loadModuleFresh();
    expect(() => mod.initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('thrown error has structural shape { name, variableName, message } per the env contract', () => {
    delete process.env['FIREBASE_PROJECT_ID'];

    const mod = loadModuleFresh();
    let captured: unknown = undefined;
    try {
      mod.initializeFirebaseAdmin();
    } catch (err) {
      captured = err;
    }
    // The captured error MUST be an Error subclass — the base
    // `Error` instanceof check works because Error is a built-in
    // and shared across module graphs (unlike user-defined
    // subclasses, which Jest's module isolator duplicates).
    expect(captured).toBeInstanceOf(Error);

    // Structural shape per the `MissingEnvVarError` contract in
    // `backend/src/config/env.ts`:
    //   - name === 'MissingEnvVarError' (set explicitly in constructor)
    //   - variableName === 'FIREBASE_PROJECT_ID' (typed surface)
    //   - message contains the variable name and the word "fatal"
    expect(captured).toMatchObject({
      name: 'MissingEnvVarError',
      variableName: 'FIREBASE_PROJECT_ID',
    });

    // The error message is descriptive (Rule R4: "fatal
    // misconfiguration, the backend process cannot start").
    const message = (captured as Error).message;
    expect(message).toMatch(/FIREBASE_PROJECT_ID/);
    expect(message).toMatch(/fatal/i);
  });
});

// ---------------------------------------------------------------------------
// Constraint C2 — returns an Auth instance with verifyIdToken.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — happy-path shape contract', () => {
  it('returns an Auth instance exposing verifyIdToken when FIREBASE_PROJECT_ID is set', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();
    const auth = mod.initializeFirebaseAdmin();

    // The C2 contract: `verifyIdToken` MUST be a callable method on
    // the returned object. We do NOT actually call it here — that
    // would require a valid token and a live (or emulated) Firebase
    // backend. The shape assertion is sufficient to prove the
    // initializer wired the SDK correctly.
    expect(auth).toBeDefined();
    expect(typeof auth.verifyIdToken).toBe('function');
  });

  it('returns an object with the canonical Auth methods (smoke shape check)', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();
    const auth = mod.initializeFirebaseAdmin();

    // A few representative methods from the firebase-admin v12
    // `Auth` interface. Their presence proves we have a real Auth
    // instance (not a typo'd object literal). The list is small
    // and stable across firebase-admin v12.x patches.
    expect(typeof auth.verifyIdToken).toBe('function');
    expect(typeof auth.getUser).toBe('function');
    expect(typeof auth.createUser).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — repeated calls return the same Auth instance.
// ---------------------------------------------------------------------------

describe('initializeFirebaseAdmin — idempotency', () => {
  it('returns the same Auth reference on repeated calls within one module load', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();
    const first = mod.initializeFirebaseAdmin();
    const second = mod.initializeFirebaseAdmin();
    const third = mod.initializeFirebaseAdmin();

    // Same instance — strict reference equality. This is the
    // documented idempotency contract: the SDK is initialized once,
    // and the cached reference is returned thereafter.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does NOT throw FirebaseAppError on repeated invocations', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();
    // Two consecutive calls must not throw. Without the singleton
    // guard, the second `admin.initializeApp(...)` call would throw
    // `FirebaseAppError: Firebase app named '[DEFAULT]' already
    // exists`. The guard prevents this.
    expect(() => mod.initializeFirebaseAdmin()).not.toThrow();
    expect(() => mod.initializeFirebaseAdmin()).not.toThrow();
  });

  it('a failed first call (missing env) does NOT poison subsequent calls', () => {
    // First attempt: env unset → throws MissingEnvVarError.
    delete process.env['FIREBASE_PROJECT_ID'];

    const mod = loadModuleFresh();
    expect(() => mod.initializeFirebaseAdmin()).toThrow(/FIREBASE_PROJECT_ID/);

    // Operator fixes the env (e.g. exported the variable) and tries
    // again. The module-level `initialized` flag should still be
    // `false`, so this second attempt MUST succeed — the SDK was
    // never partially initialized by the failing call.
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test-recovered';
    const auth = mod.initializeFirebaseAdmin();
    expect(auth).toBeDefined();
    expect(typeof auth.verifyIdToken).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Type re-exports — compile-level usability assertion.
// ---------------------------------------------------------------------------

describe('FirebaseAuth and DecodedIdToken type re-exports', () => {
  it('FirebaseAuth is structurally usable as a type for the initializer return value', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();

    // Compile-level proof that `FirebaseAuth` is the correct type:
    // the variable annotation MUST accept the initializer's return
    // value. If `FirebaseAuth` were the wrong shape, `tsc --noEmit`
    // would fail at this line and the unit test gate would block
    // the merge.
    const auth: FirebaseAdminModule.FirebaseAuth = mod.initializeFirebaseAdmin();
    expect(typeof auth.verifyIdToken).toBe('function');
  });

  it('DecodedIdToken type re-export is structurally compatible with firebase-admin/auth', () => {
    // Compile-level proof that `DecodedIdToken` is structurally
    // identical to the upstream Firebase SDK type. We construct a
    // minimal object that satisfies the type's required fields and
    // assert it via the type alias re-export. If the alias drifted
    // from the upstream definition, this would fail at compile time.
    const decoded: FirebaseAdminModule.DecodedIdToken = {
      // Required base claims per the firebase-admin/auth
      // `DecodedIdToken` interface (subset chosen for stability;
      // the actual interface includes additional optional fields).
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
// Rule R3 — verification-by-import surface.
// ---------------------------------------------------------------------------

describe('Rule R3 — module exports allow-list', () => {
  it('exports exactly initializeFirebaseAdmin (function), FirebaseAuth (type), DecodedIdToken (type)', () => {
    process.env['FIREBASE_PROJECT_ID'] = 'strikeforge-unit-test';

    const mod = loadModuleFresh();

    // Runtime exports: only `initializeFirebaseAdmin` is a runtime
    // value. `FirebaseAuth` and `DecodedIdToken` are type-only
    // re-exports that erase to nothing at runtime — they MUST NOT
    // appear as runtime properties of the module object.
    const runtimeKeys = Object.keys(mod).sort();
    expect(runtimeKeys).toEqual(['initializeFirebaseAdmin']);

    // Specifically, `verifyIdToken` MUST NOT be exported as a
    // wrapper from this module (Rule R3 / AAP Phase 9 forbidden
    // pattern). Verification lives exactly once in
    // `services/session.service.ts`.
    expect((mod as Record<string, unknown>)['verifyIdToken']).toBeUndefined();

    // The `admin` namespace MUST NOT be re-exported (Rule R3 /
    // AAP Phase 9 forbidden pattern). Doing so would leak the
    // SDK surface into every consumer.
    expect((mod as Record<string, unknown>)['admin']).toBeUndefined();
  });
});
