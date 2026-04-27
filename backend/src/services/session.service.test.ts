/**
 * Unit tests for `backend/src/services/session.service.ts`.
 *
 * Verifies the five exported methods on the `SessionService` contract
 * (`register`, `login`, `logout`, `verifyToken`, `isRevoked`) plus the
 * factory's compose-time validation, against the security and behavioral
 * invariants documented in the source file:
 *
 *   1. **Registration (ST-023)**: Creates a Firebase user via
 *      `firebaseAuth.createUser`, then mirrors identity-only fields into
 *      the local `users` table via `userRepository.insert`. The local
 *      INSERT call MUST NOT carry `credentialDigest` (Rule R3 / AAP §0.2.1)
 *      and the password value MUST NOT appear in any log record (Rule R2).
 *
 *   2. **Login (ST-024)**: Orchestrates `signInWithPassword` →
 *      `firebaseAuth.verifyIdToken` → `sessionRepository.insert` in that
 *      strict order. The session row is keyed by `SHA-256(idToken)`, NOT
 *      the raw idToken; the repository never sees raw tokens. Failed
 *      sign-ins are translated to `UnauthenticatedError` regardless of
 *      the underlying Firebase error code (information-disclosure
 *      control).
 *
 *   3. **Logout (ST-025)**: Computes `tokenRef = SHA-256(rawBearerToken)`
 *      and calls `sessionRepository.markRevoked(tokenRef)` (NOT
 *      `markRevoked({ tokenRef })` — the repository signature accepts
 *      a string positional argument). Idempotent: a second logout
 *      against an already-revoked session resolves silently.
 *
 *   4. **verifyToken (ST-026 / Rule R3)**: Pure delegation to
 *      `firebaseAuth.verifyIdToken(rawBearerToken)`. No custom JWT
 *      parsing, signature verification, expiry checking, or JWKS
 *      fetching — verified by asserting exactly one Admin SDK call with
 *      the raw token and no intermediate mutations.
 *
 *   5. **isRevoked (ST-026)**: Default-allow semantics:
 *      - Returns `false` when no session row exists (default-allow for
 *        tokens minted directly via the Firebase client SDK).
 *      - Returns `false` when the session exists with `revokedAt === null`.
 *      - Returns `true` only when the session exists AND `revokedAt`
 *        is non-null.
 *      - Lookup uses the SHA-256 tokenRef, NEVER the raw token.
 *
 *   6. **Cross-cut Rule R2 sweep**: After exercising every method, the
 *      logger never received an argument that contains the password
 *      sentinel (`SENTINEL_CRED_99`), the raw bearer token
 *      (`fake-id-token-for-test`), or any other credential material.
 *      Pino's serializer allow-list is the production redaction layer,
 *      but the FIRST line of defense is "do not pass credentials to
 *      `logger.*` in the first place" — which is what these tests
 *      verify.
 *
 *   7. **Validation error contract**: Each method rejects empty/non-string
 *      inputs with `ValidationError`. Login wraps Firebase failures with
 *      `UnauthenticatedError` (HTTP 401 semantics), distinct from
 *      `ValidationError` (HTTP 400 semantics).
 *
 *   8. **Rule R8 fail-closed**: Errors from Firebase Admin SDK calls,
 *      from `signInWithPassword`, and from repository methods propagate
 *      to the caller — never silently swallowed.
 *
 * Authority:
 *   - Story ST-023 acceptance criteria (registration MUST mirror Firebase
 *     identity to local `users` table without storing credential
 *     material).
 *   - Story ST-024 acceptance criteria (login MUST authenticate against
 *     Firebase and create a session row keyed by an opaque tokenRef).
 *   - Story ST-025 acceptance criteria (logout MUST mark the session row
 *     revoked; idempotent on repeat calls).
 *   - Story ST-026 acceptance criteria (`SessionService` exposes
 *     `verifyToken` and `isRevoked` methods; validation contract is the
 *     single source consumed by the session middleware).
 *   - Story ST-043 acceptance criteria (deterministic, local-only,
 *     no-network unit suite with co-located `*.test.ts`).
 *   - AAP §0.2.1 Firebase user-mirroring resolution (`credential_digest`
 *     column EXISTS but is NEVER populated; the local users.id IS the
 *     Firebase uid).
 *   - AAP §0.8.1 Rule R2 (no credential material in logs).
 *   - AAP §0.8.1 Rule R3 (Firebase Admin SDK only — no JWT libraries).
 *   - AAP §0.8.1 Rule R8 (gates fail closed).
 *
 * Determinism (ST-043-AC3):
 *   - All collaborators (`SessionRepository`, `UserRepository`,
 *     `FirebaseAuth`, `signInWithPassword`) are replaced with `jest.fn()`
 *     mocks; no asynchronous boundary depends on external state.
 *   - `jest.useFakeTimers({ now: FIXED_NOW })` pins `Date.now()` so the
 *     `issuedAt` field passed to `sessionRepository.insert` matches a
 *     known fixture value.
 *   - The Jest config (`backend/jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, and `restoreMocks` to `true` so mock state is wiped
 *     between tests — this file therefore needs no manual
 *     `jest.clearAllMocks()` calls.
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and depends on
 *   ZERO services. Firebase Admin SDK, the email+password sign-in
 *   adapter, and both repositories are fully mocked; pino is
 *   `jest.mock`'d module-globally so no log output is produced and no
 *   pino transport is initialized.
 *
 * @see backend/src/services/session.service.ts — module under test
 * @see tickets/stories/ST-023-user-registration-endpoint.md
 * @see tickets/stories/ST-024-login-endpoint-session-token-issuance.md
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md
 * @see tickets/stories/ST-043-unit-test-suite.md
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

// ---------------------------------------------------------------------------
// Type-only imports.
//
// The `consistent-type-imports` ESLint rule requires that imports used
// only in type positions are declared with `import type`. None of these
// types contribute runtime values — they only constrain the shape of
// jest.Mocked<...> generics and fixture builders.
// ---------------------------------------------------------------------------
import type { DecodedIdToken, FirebaseAuth } from '../auth/firebase-admin';
import type { Session, SessionRepository } from '../repositories/session.repository';
import type { User, UserRepository } from '../repositories/user.repository';

// ---------------------------------------------------------------------------
// Module mock — pino logger.
//
// `jest.mock` is hoisted to the top of the module body by the Jest
// transformer, BEFORE any `import` statement. We therefore declare it
// before the `import` of the module under test so that
// `session.service.ts` resolves the mocked `logger` rather than the real
// pino instance. The mock exposes the four log levels the production
// code calls; each is a `jest.fn()` so the cross-cut Rule R2 sweep can
// inspect `logger.<level>.mock.calls`.
//
// We also stub `child(): logger` because some downstream collaborators
// may invoke it; the production session.service.ts does not, but the
// stub makes the mock robust to future refactors.
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
// Runtime imports — must come AFTER the `jest.mock` block above so that
// the mocked module replaces the real one in the module registry.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';

import {
  createSessionService,
  ValidationError,
  UnauthenticatedError,
  type SignInWithPasswordFn,
  type SignInResult,
} from './session.service';
import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Test fixtures — deterministic constants used throughout the suite.
// ---------------------------------------------------------------------------

/**
 * Stable wall-clock pin for the suite. All `issuedAt` assertions compare
 * against this fixed date so the suite remains deterministic across
 * machines and across second-boundaries (ST-043-AC3).
 */
const FIXED_NOW: Date = new Date('2026-01-15T10:00:00.000Z');

/**
 * The canonical Firebase uid used as the "successful registration"
 * fixture. Per AAP §0.2.1, the local `users.id` IS the Firebase uid.
 */
const USER_ID = 'firebase-uid-1';

/**
 * The canonical login identifier (an email) used in happy-path fixtures.
 */
const EMAIL = 'user@example.com';

/**
 * Sentinel password value. The string `SENTINEL_CRED_99` is the
 * AAP-prescribed marker the Rule R2 verification scans for; if any log
 * record ever contains this substring, the suite fails. The marker is
 * deliberately unmistakable so a positive match cannot be confused
 * with a benign coincidence.
 */
const PASSWORD = 'SENTINEL_CRED_99';

/**
 * Mock Firebase idToken used as the "raw bearer" fixture. The string is
 * intentionally non-JWT-shaped so that any test that scans for
 * "JWT-like" patterns (`xxx.yyy.zzz`) will not produce false positives;
 * we only care about exact-substring matches in Rule R2 sweeps.
 */
const RAW_TOKEN = 'fake-id-token-for-test';

/**
 * Standard expiration timestamp used by login fixtures — one hour after
 * `FIXED_NOW`. Mirrors the Firebase id-token lifetime (typically 1 hour).
 */
const EXPIRES_AT: Date = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);

/**
 * The SHA-256 hash of `RAW_TOKEN` encoded as URL-safe base64, computed
 * exactly the way `session.service.ts`'s internal `hashTokenRef` helper
 * computes it. Tests use this constant to assert that the service hashes
 * the raw token before passing it to repository methods — proving the
 * repository never sees raw bearer material (Rule R2 + ST-024/ST-025/
 * ST-026 contract).
 */
const EXPECTED_TOKEN_REF: string = createHash('sha256').update(RAW_TOKEN).digest('base64url');

// ---------------------------------------------------------------------------
// Mock builders.
//
// Each builder returns a fresh mock object — `jest.Mocked<...>` for
// repositories, an auth surface for `FirebaseAuth`, and a single-
// signature mock function for `SignInWithPasswordFn`. Returning fresh
// objects per `buildDeps()` call (rather than module-level singletons)
// guarantees test isolation even if the Jest config's `resetMocks`
// behavior were ever weakened.
// ---------------------------------------------------------------------------

/**
 * Surface of `FirebaseAuth` actually consumed by `session.service.ts`:
 * `verifyIdToken` (Rule R3 token validation), `createUser` (registration),
 * and `getUser` (currently unused but reserved for future ST-026
 * extensions). Building a `Pick`-typed mock keeps TypeScript inference
 * tight without forcing us to stub the 30+ unrelated `admin.auth.Auth`
 * members.
 */
type FirebaseAuthMock = jest.Mocked<Pick<FirebaseAuth, 'verifyIdToken' | 'createUser' | 'getUser'>>;

/**
 * Build a fresh `jest.Mocked<SessionRepository>` with every contract
 * method as a `jest.fn()`. Tests arrange behavior on each method via
 * `mockResolvedValueOnce` / `mockRejectedValueOnce`.
 */
function makeSessionRepository(): jest.Mocked<SessionRepository> {
  return {
    insert: jest.fn(),
    findByTokenRef: jest.fn(),
    markRevoked: jest.fn(),
    isActive: jest.fn(),
  };
}

/**
 * Build a fresh `jest.Mocked<UserRepository>` with every contract method
 * as a `jest.fn()`.
 */
function makeUserRepository(): jest.Mocked<UserRepository> {
  return {
    insert: jest.fn(),
    findByLoginIdentifier: jest.fn(),
    findByFirebaseUid: jest.fn(),
  };
}

/**
 * Build a partial `FirebaseAuth` mock that stubs the three methods the
 * session service actually invokes. The cast asserts the shape; the
 * caller of `buildDeps()` widens this further to `FirebaseAuth` for
 * passing to the production factory.
 */
function makeFirebaseAuth(): FirebaseAuthMock {
  return {
    verifyIdToken: jest.fn(),
    createUser: jest.fn(),
    getUser: jest.fn(),
  } as FirebaseAuthMock;
}

/**
 * Build a fresh `jest.MockedFunction<SignInWithPasswordFn>` with no
 * arrangement. The single-signature shape lets `mockResolvedValueOnce`
 * infer the resolved type as `SignInResult` correctly.
 */
function makeSignInFn(): jest.MockedFunction<SignInWithPasswordFn> {
  return jest.fn() as jest.MockedFunction<SignInWithPasswordFn>;
}

/**
 * Build a canonical `User` fixture matching the `users` table contract.
 * `credentialDigest` is the literal `null` per the source-file's type
 * assertion (Rule R3 / AAP §0.2.1) — the field is a structural marker
 * that the column exists but is never populated.
 */
function makeUserFixture(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    loginIdentifier: EMAIL,
    credentialDigest: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * Build a canonical `Session` fixture. The `tokenRef` defaults to the
 * SHA-256 hash of `RAW_TOKEN` so happy-path login/logout/isRevoked tests
 * can assert that the service's hashing matches the repository's stored
 * key without explicit recomputation in each test.
 */
function makeSessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    tokenRef: EXPECTED_TOKEN_REF,
    userId: USER_ID,
    issuedAt: FIXED_NOW,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Build a canonical `DecodedIdToken` fixture. The shape mirrors the
 * Firebase Admin SDK's runtime shape — the cast is necessary because
 * `DecodedIdToken` carries a small number of additional optional fields
 * we do not need to populate for unit-test purposes.
 */
function makeDecodedToken(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  const issued = Math.floor(FIXED_NOW.getTime() / 1000);
  const expires = Math.floor(EXPIRES_AT.getTime() / 1000);
  return {
    uid: USER_ID,
    aud: 'test-project',
    auth_time: issued,
    exp: expires,
    iat: issued,
    iss: 'https://securetoken.google.com/test-project',
    sub: USER_ID,
    firebase: { identities: {}, sign_in_provider: 'password' },
    ...overrides,
  } as DecodedIdToken;
}

/**
 * Build a canonical `SignInResult` fixture mirroring the typical Firebase
 * Auth REST API response shape — an idToken, the matching uid, and an
 * absolute expiration timestamp.
 */
function makeSignInResult(overrides: Partial<SignInResult> = {}): SignInResult {
  return {
    idToken: RAW_TOKEN,
    uid: USER_ID,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/**
 * Container type for `buildDeps()`. The `firebaseAuth` field is the
 * narrowed full-`FirebaseAuth` type so it can be passed directly to the
 * production factory; tests that need to manipulate the Mock surface
 * cast individual methods via `as jest.Mock` at the call site.
 */
interface BuildDepsResult {
  sessionRepository: jest.Mocked<SessionRepository>;
  userRepository: jest.Mocked<UserRepository>;
  firebaseAuth: FirebaseAuth;
  signInWithPassword: jest.MockedFunction<SignInWithPasswordFn>;
}

/**
 * Build a full `SessionServiceDeps` object suitable for passing to
 * `createSessionService`. Every collaborator is a fresh mock; tests
 * arrange behavior post-construction.
 */
function buildDeps(): BuildDepsResult {
  return {
    sessionRepository: makeSessionRepository(),
    userRepository: makeUserRepository(),
    firebaseAuth: makeFirebaseAuth() as unknown as FirebaseAuth,
    signInWithPassword: makeSignInFn(),
  };
}

/**
 * Concatenate every `mock.calls` array across the four log levels into a
 * single 2D array. Tests stringify the result and assert that no
 * credential substring appears anywhere in the concatenated payload.
 */
function gatherLogArgs(): unknown[][] {
  return [
    ...(logger.info as jest.Mock).mock.calls,
    ...(logger.warn as jest.Mock).mock.calls,
    ...(logger.error as jest.Mock).mock.calls,
    ...(logger.debug as jest.Mock).mock.calls,
  ];
}

// ---------------------------------------------------------------------------
// Lifecycle hooks.
//
// `jest.useFakeTimers({ now: FIXED_NOW })` pins the wall clock so the
// `issuedAt: new Date()` call inside `login` produces a deterministic
// timestamp. Other test suites in this monorepo follow the same pattern
// (see `repositories/session.repository.test.ts`).
//
// We do NOT call `jest.clearAllMocks()` here because the Jest config
// (`clearMocks: true`, `resetMocks: true`, `restoreMocks: true`) handles
// it automatically before every test. Adding it manually would be a
// belt-and-suspenders measure with no behavioral effect.
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.useFakeTimers({ now: FIXED_NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

// ===========================================================================
// Test suites.
// ===========================================================================

describe('createSessionService', () => {
  // -------------------------------------------------------------------------
  // factory — compose-time validation (5 tests)
  // -------------------------------------------------------------------------
  describe('factory', () => {
    it('returns an object exposing register, login, logout, verifyToken, isRevoked methods', () => {
      const deps = buildDeps();
      const service = createSessionService(deps);
      expect(typeof service.register).toBe('function');
      expect(typeof service.login).toBe('function');
      expect(typeof service.logout).toBe('function');
      expect(typeof service.verifyToken).toBe('function');
      expect(typeof service.isRevoked).toBe('function');
    });

    it('throws a descriptive error when sessionRepository is missing', () => {
      const deps = buildDeps();
      expect(() =>
        createSessionService({
          ...deps,
          sessionRepository: undefined as unknown as SessionRepository,
        }),
      ).toThrow(/sessionRepository/);
    });

    it('throws a descriptive error when userRepository is missing', () => {
      const deps = buildDeps();
      expect(() =>
        createSessionService({
          ...deps,
          userRepository: undefined as unknown as UserRepository,
        }),
      ).toThrow(/userRepository/);
    });

    it('throws a descriptive error when firebaseAuth is missing', () => {
      const deps = buildDeps();
      expect(() =>
        createSessionService({
          ...deps,
          firebaseAuth: undefined as unknown as FirebaseAuth,
        }),
      ).toThrow(/firebaseAuth/);
    });

    it('throws a descriptive error when signInWithPassword is missing', () => {
      const deps = buildDeps();
      expect(() =>
        createSessionService({
          ...deps,
          signInWithPassword: undefined as unknown as SignInWithPasswordFn,
        }),
      ).toThrow(/signInWithPassword/);
    });
  });

  // -------------------------------------------------------------------------
  // register — ST-023 (7 tests)
  //
  // Verifies that:
  //   - Firebase createUser receives email+password (Rule R3 source of
  //     truth for credentials).
  //   - Local users.insert receives ONLY { firebaseUid, loginIdentifier }
  //     — no credentialDigest field, no password leakage (Rule R3 +
  //     ST-023-AC4).
  //   - The return shape is { uid, loginIdentifier } (ST-023-AC2).
  //   - Empty inputs reject with ValidationError (input contract).
  //   - The password sentinel never appears in any log argument (Rule R2).
  //   - Firebase errors propagate without local user being created
  //     (Rule R8 + ST-023-AC3).
  // -------------------------------------------------------------------------
  describe('register', () => {
    it('ST-023: creates a Firebase user via firebaseAuth.createUser with email+password', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.createUser as jest.Mock).mockResolvedValueOnce({
        uid: USER_ID,
        email: EMAIL,
      });
      deps.userRepository.insert.mockResolvedValueOnce(makeUserFixture());

      const service = createSessionService(deps);
      await service.register({ email: EMAIL, password: PASSWORD });

      expect(deps.firebaseAuth.createUser).toHaveBeenCalledTimes(1);
      expect(deps.firebaseAuth.createUser).toHaveBeenCalledWith({
        email: EMAIL,
        password: PASSWORD,
      });
    });

    it('ST-023 + Rule R3: inserts local users row with firebase uid and login identifier; never populates credentialDigest', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.createUser as jest.Mock).mockResolvedValueOnce({
        uid: USER_ID,
        email: EMAIL,
      });
      deps.userRepository.insert.mockResolvedValueOnce(makeUserFixture());

      const service = createSessionService(deps);
      await service.register({ email: EMAIL, password: PASSWORD });

      expect(deps.userRepository.insert).toHaveBeenCalledTimes(1);
      const insertArg = deps.userRepository.insert.mock.calls[0]?.[0];
      expect(insertArg).toBeDefined();
      expect(insertArg?.firebaseUid).toBe(USER_ID);
      expect(insertArg?.loginIdentifier).toBe(EMAIL);
      // Rule R3 + AAP §0.2.1: credentialDigest is NEVER passed by application
      // code. The repository's INSERT statement omits the column from the
      // column list so PG defaults it to NULL via the schema-level default.
      expect(
        (insertArg as unknown as { credentialDigest?: unknown })?.credentialDigest,
      ).toBeUndefined();
      // Rule R3: password never reaches the local DB layer. Stringify the
      // ENTIRE insert argument and assert the sentinel is absent.
      expect(JSON.stringify(insertArg)).not.toContain(PASSWORD);
    });

    it('ST-023-AC2: returns { uid, loginIdentifier } on successful registration (no credential material)', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.createUser as jest.Mock).mockResolvedValueOnce({
        uid: USER_ID,
        email: EMAIL,
      });
      deps.userRepository.insert.mockResolvedValueOnce(makeUserFixture());

      const service = createSessionService(deps);
      const result = await service.register({ email: EMAIL, password: PASSWORD });

      expect(result).toEqual({ uid: USER_ID, loginIdentifier: EMAIL });
      // Defensive: ensure no credential field accidentally leaked into
      // the result (e.g. via spread or accidental property propagation).
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(JSON.stringify(result)).not.toContain('credentialDigest');
      expect(JSON.stringify(result)).not.toContain('password');
    });

    it('rejects empty email with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.register({ email: '', password: PASSWORD })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects empty password with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.register({ email: EMAIL, password: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('Rule R2: password never appears in any log record', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.createUser as jest.Mock).mockResolvedValueOnce({
        uid: USER_ID,
        email: EMAIL,
      });
      deps.userRepository.insert.mockResolvedValueOnce(makeUserFixture());

      const service = createSessionService(deps);
      await service.register({ email: EMAIL, password: PASSWORD });

      const serialized = JSON.stringify(gatherLogArgs());
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain('SENTINEL_CRED_99');
    });

    it('Rule R8 + ST-023-AC3: propagates firebaseAuth.createUser errors and does NOT insert a local user row', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.createUser as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('email already in use'), { code: 'auth/email-already-exists' }),
      );

      const service = createSessionService(deps);
      await expect(service.register({ email: EMAIL, password: PASSWORD })).rejects.toThrow(
        /email already in use/,
      );
      expect(deps.userRepository.insert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // login — ST-024 (7 tests)
  //
  // Verifies that:
  //   - The orchestration runs in strict order:
  //     signInWithPassword → firebaseAuth.verifyIdToken → sessionRepository.insert.
  //   - The session row's tokenRef is SHA-256(idToken) (NOT the raw idToken).
  //   - The result returned to the caller mirrors SignInResult.
  //   - Empty inputs reject with ValidationError.
  //   - signIn failures are translated to UnauthenticatedError (HTTP 401
  //     semantics; no Firebase internals leak into the route layer).
  //   - Neither password nor idToken appears in any log record (Rule R2).
  // -------------------------------------------------------------------------
  describe('login', () => {
    it('ST-024: orchestrates signInWithPassword → verifyIdToken → sessionRepository.insert in strict order', async () => {
      const deps = buildDeps();
      deps.signInWithPassword.mockResolvedValueOnce(makeSignInResult());
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());
      deps.sessionRepository.insert.mockResolvedValueOnce(makeSessionFixture());

      const service = createSessionService(deps);
      await service.login({ email: EMAIL, password: PASSWORD });

      // Each method invoked exactly once.
      expect(deps.signInWithPassword).toHaveBeenCalledTimes(1);
      expect(deps.firebaseAuth.verifyIdToken).toHaveBeenCalledTimes(1);
      expect(deps.sessionRepository.insert).toHaveBeenCalledTimes(1);

      // Strict ordering — Jest assigns a monotonically increasing
      // `invocationCallOrder` to every mock invocation. We assert that
      // signIn precedes verify, and verify precedes insert.
      const signInOrder = deps.signInWithPassword.mock.invocationCallOrder[0];
      const verifyOrder = (deps.firebaseAuth.verifyIdToken as jest.Mock).mock
        .invocationCallOrder[0];
      const insertOrder = deps.sessionRepository.insert.mock.invocationCallOrder[0];
      expect(signInOrder).toBeDefined();
      expect(verifyOrder).toBeDefined();
      expect(insertOrder).toBeDefined();
      expect(signInOrder as number).toBeLessThan(verifyOrder as number);
      expect(verifyOrder as number).toBeLessThan(insertOrder as number);
    });

    it('ST-024: signInWithPassword is called with email + password only', async () => {
      const deps = buildDeps();
      deps.signInWithPassword.mockResolvedValueOnce(makeSignInResult());
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());
      deps.sessionRepository.insert.mockResolvedValueOnce(makeSessionFixture());

      const service = createSessionService(deps);
      await service.login({ email: EMAIL, password: PASSWORD });

      expect(deps.signInWithPassword).toHaveBeenCalledWith({
        email: EMAIL,
        password: PASSWORD,
      });
      // Rule R3: verifyIdToken receives the idToken returned by signIn,
      // NOT the raw password — the password is consumed by Firebase only.
      expect(deps.firebaseAuth.verifyIdToken).toHaveBeenCalledWith(RAW_TOKEN);
    });

    it('ST-024: persists session row with SHA-256 tokenRef (NEVER the raw idToken)', async () => {
      const deps = buildDeps();
      deps.signInWithPassword.mockResolvedValueOnce(makeSignInResult());
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());
      deps.sessionRepository.insert.mockResolvedValueOnce(makeSessionFixture());

      const service = createSessionService(deps);
      await service.login({ email: EMAIL, password: PASSWORD });

      const insertArg = deps.sessionRepository.insert.mock.calls[0]?.[0];
      expect(insertArg).toBeDefined();
      // The tokenRef is the SHA-256 hash of the idToken, NOT the raw
      // idToken. The repository never sees raw bearer material.
      expect(insertArg?.tokenRef).toBe(EXPECTED_TOKEN_REF);
      expect(insertArg?.tokenRef).not.toBe(RAW_TOKEN);
      expect(insertArg?.userId).toBe(USER_ID);
      // `issuedAt` is `new Date()` evaluated under fake timers pinned to
      // FIXED_NOW, so it must equal FIXED_NOW exactly.
      expect(insertArg?.issuedAt).toEqual(FIXED_NOW);
      expect(insertArg?.expiresAt).toEqual(EXPIRES_AT);
    });

    it('ST-024: returns { idToken, uid, expiresAt } for the client to store', async () => {
      const deps = buildDeps();
      deps.signInWithPassword.mockResolvedValueOnce(makeSignInResult());
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());
      deps.sessionRepository.insert.mockResolvedValueOnce(makeSessionFixture());

      const service = createSessionService(deps);
      const result = await service.login({ email: EMAIL, password: PASSWORD });

      expect(result).toEqual({
        idToken: RAW_TOKEN,
        uid: USER_ID,
        expiresAt: EXPIRES_AT,
      });
    });

    it('rejects empty email with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.login({ email: '', password: PASSWORD })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects empty password with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.login({ email: EMAIL, password: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('wraps signInWithPassword failures as UnauthenticatedError without exposing Firebase internals', async () => {
      const deps = buildDeps();
      // Simulate a Firebase-shaped error with a specific code; the
      // service must collapse this to a generic UnauthenticatedError so
      // the route layer cannot leak "user not found" vs "wrong password"
      // distinctions to the client (information-disclosure control).
      deps.signInWithPassword.mockRejectedValueOnce(
        Object.assign(new Error('INVALID_PASSWORD'), { code: 'auth/invalid-password' }),
      );

      const service = createSessionService(deps);
      const failure = service.login({ email: EMAIL, password: 'wrong-password' });
      await expect(failure).rejects.toBeInstanceOf(UnauthenticatedError);
      // The session row must NOT be created — registration of an
      // invalid-credential request must leave no audit-log artifact in
      // the sessions table.
      expect(deps.sessionRepository.insert).not.toHaveBeenCalled();
      // The verifyIdToken step must NOT run when signIn failed —
      // verifying a non-existent token would be a wasteful call to the
      // Admin SDK.
      expect(deps.firebaseAuth.verifyIdToken).not.toHaveBeenCalled();
    });

    it('Rule R2: neither password nor idToken appears in any log record', async () => {
      const deps = buildDeps();
      deps.signInWithPassword.mockResolvedValueOnce(makeSignInResult());
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());
      deps.sessionRepository.insert.mockResolvedValueOnce(makeSessionFixture());

      const service = createSessionService(deps);
      await service.login({ email: EMAIL, password: PASSWORD });

      const serialized = JSON.stringify(gatherLogArgs());
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain('SENTINEL_CRED_99');
      expect(serialized).not.toContain(RAW_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // logout — ST-025 (5 tests)
  //
  // Verifies that:
  //   - The service computes tokenRef = SHA-256(rawBearerToken) and calls
  //     `sessionRepository.markRevoked(tokenRef)` — with a STRING positional
  //     argument, NOT `markRevoked({ tokenRef })`. This matches the
  //     `SessionRepository.markRevoked(tokenRef: string)` interface signature.
  //   - The flow is idempotent: a second logout call (or a logout against
  //     a session that never existed in our DB) resolves silently
  //     because the repository's `markRevoked` returns `null` for
  //     non-existent rows.
  //   - Empty inputs reject with ValidationError.
  //   - The raw bearer token never appears in any log record (Rule R2).
  // -------------------------------------------------------------------------
  describe('logout', () => {
    it('ST-025: computes SHA-256 tokenRef and calls sessionRepository.markRevoked with the hashed string', async () => {
      const deps = buildDeps();
      deps.sessionRepository.markRevoked.mockResolvedValueOnce(
        makeSessionFixture({ revokedAt: FIXED_NOW }),
      );

      const service = createSessionService(deps);
      await service.logout({ uid: USER_ID, rawBearerToken: RAW_TOKEN });

      // CRITICAL: `markRevoked` is a STRING-argument method
      // (`markRevoked(tokenRef: string)`), NOT `markRevoked({ tokenRef })`.
      // The service passes the hashed reference directly as a positional
      // argument — verified by `toHaveBeenCalledWith(EXPECTED_TOKEN_REF)`.
      expect(deps.sessionRepository.markRevoked).toHaveBeenCalledTimes(1);
      expect(deps.sessionRepository.markRevoked).toHaveBeenCalledWith(EXPECTED_TOKEN_REF);

      // Defensive: the raw token must NEVER reach the repository.
      const callArg = deps.sessionRepository.markRevoked.mock.calls[0]?.[0];
      expect(callArg).toBe(EXPECTED_TOKEN_REF);
      expect(callArg).not.toBe(RAW_TOKEN);
    });

    it('ST-025: idempotent — resolves silently when no matching session row exists', async () => {
      const deps = buildDeps();
      // The repository returns `null` when no row matches — modeling a
      // logout against a session minted via the Firebase client SDK that
      // was never recorded in our local sessions table. The service must
      // treat this as a successful no-op (non-error) per ST-025-AC3.
      deps.sessionRepository.markRevoked.mockResolvedValueOnce(null);

      const service = createSessionService(deps);
      await expect(
        service.logout({ uid: USER_ID, rawBearerToken: RAW_TOKEN }),
      ).resolves.toBeUndefined();
    });

    it('rejects empty uid with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.logout({ uid: '', rawBearerToken: RAW_TOKEN })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects empty rawBearerToken with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.logout({ uid: USER_ID, rawBearerToken: '' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('Rule R2: rawBearerToken never appears in any log record', async () => {
      const deps = buildDeps();
      deps.sessionRepository.markRevoked.mockResolvedValueOnce(
        makeSessionFixture({ revokedAt: FIXED_NOW }),
      );

      const service = createSessionService(deps);
      await service.logout({ uid: USER_ID, rawBearerToken: RAW_TOKEN });

      const serialized = JSON.stringify(gatherLogArgs());
      expect(serialized).not.toContain(RAW_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // verifyToken — ST-026 / Rule R3 (4 tests)
  //
  // Verifies that:
  //   - verifyToken delegates ENTIRELY to firebaseAuth.verifyIdToken
  //     (Rule R3 / Constraint C2). No custom JWT parsing, no signature
  //     check, no expiry check, no JWKS fetching.
  //   - Exactly one Admin SDK call is made per verifyToken invocation.
  //   - Errors thrown by the Admin SDK (expired, invalid, revoked
  //     tokens) propagate unchanged (Rule R8 fail-closed).
  //   - Empty inputs reject with ValidationError.
  // -------------------------------------------------------------------------
  describe('verifyToken', () => {
    it('ST-026 / Rule R3: delegates to firebaseAuth.verifyIdToken with the raw bearer token and returns the decoded result', async () => {
      const deps = buildDeps();
      const decoded = makeDecodedToken();
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(decoded);

      const service = createSessionService(deps);
      const result = await service.verifyToken(RAW_TOKEN);

      expect(deps.firebaseAuth.verifyIdToken).toHaveBeenCalledWith(RAW_TOKEN);
      expect(result).toEqual(decoded);
    });

    it('Rule R3: makes exactly one Admin SDK call — no intermediate JWT parsing or pre-validation', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValueOnce(makeDecodedToken());

      const service = createSessionService(deps);
      await service.verifyToken(RAW_TOKEN);

      // A single Admin SDK call confirms the service does not "pre-decode"
      // the JWT to inspect headers/claims before verification — which is
      // exactly the kind of custom JWT handling Rule R3 forbids.
      expect(deps.firebaseAuth.verifyIdToken).toHaveBeenCalledTimes(1);
      // No repository or other Firebase calls happen in this path.
      expect(deps.sessionRepository.findByTokenRef).not.toHaveBeenCalled();
      expect(deps.sessionRepository.insert).not.toHaveBeenCalled();
      expect(deps.sessionRepository.markRevoked).not.toHaveBeenCalled();
      expect(deps.sessionRepository.isActive).not.toHaveBeenCalled();
      expect(deps.userRepository.findByFirebaseUid).not.toHaveBeenCalled();
    });

    it('Rule R8: propagates firebaseAuth.verifyIdToken errors unchanged (expired / invalid / revoked)', async () => {
      const deps = buildDeps();
      (deps.firebaseAuth.verifyIdToken as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('auth/id-token-expired'), { code: 'auth/id-token-expired' }),
      );

      const service = createSessionService(deps);
      await expect(service.verifyToken(RAW_TOKEN)).rejects.toThrow(/auth\/id-token-expired/);
    });

    it('rejects empty rawBearerToken with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.verifyToken('')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // isRevoked — ST-026 (7 tests)
  //
  // Verifies the default-allow contract:
  //   - findByTokenRef returns null  → isRevoked returns false (the
  //     session was never recorded in our DB; treat as not-revoked).
  //   - findByTokenRef returns Session with revokedAt === null → false.
  //   - findByTokenRef returns Session with revokedAt !== null → true.
  //   - The lookup uses SHA-256(rawBearerToken), NEVER the raw token.
  //   - Empty inputs reject with ValidationError.
  //   - Repository errors propagate (Rule R8).
  // -------------------------------------------------------------------------
  describe('isRevoked', () => {
    it('returns false when no session row exists (default-allow for tokens minted via Firebase client SDK)', async () => {
      const deps = buildDeps();
      deps.sessionRepository.findByTokenRef.mockResolvedValueOnce(null);

      const service = createSessionService(deps);
      const result = await service.isRevoked(USER_ID, RAW_TOKEN);

      expect(deps.sessionRepository.findByTokenRef).toHaveBeenCalledTimes(1);
      expect(deps.sessionRepository.findByTokenRef).toHaveBeenCalledWith(EXPECTED_TOKEN_REF);
      expect(result).toBe(false);
    });

    it('returns false when session exists and revokedAt is null', async () => {
      const deps = buildDeps();
      deps.sessionRepository.findByTokenRef.mockResolvedValueOnce(
        makeSessionFixture({ revokedAt: null }),
      );

      const service = createSessionService(deps);
      const result = await service.isRevoked(USER_ID, RAW_TOKEN);

      expect(result).toBe(false);
    });

    it('returns true when session exists and revokedAt is set', async () => {
      const deps = buildDeps();
      deps.sessionRepository.findByTokenRef.mockResolvedValueOnce(
        makeSessionFixture({ revokedAt: FIXED_NOW }),
      );

      const service = createSessionService(deps);
      const result = await service.isRevoked(USER_ID, RAW_TOKEN);

      expect(result).toBe(true);
    });

    it('looks up session by SHA-256 tokenRef (string), NEVER by raw bearer token', async () => {
      const deps = buildDeps();
      deps.sessionRepository.findByTokenRef.mockResolvedValueOnce(null);

      const service = createSessionService(deps);
      await service.isRevoked(USER_ID, RAW_TOKEN);

      const lookupArg = deps.sessionRepository.findByTokenRef.mock.calls[0]?.[0];
      expect(lookupArg).toBe(EXPECTED_TOKEN_REF);
      expect(lookupArg).not.toBe(RAW_TOKEN);
    });

    it('rejects empty uid with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.isRevoked('', RAW_TOKEN)).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects empty rawBearerToken with ValidationError', async () => {
      const service = createSessionService(buildDeps());
      await expect(service.isRevoked(USER_ID, '')).rejects.toBeInstanceOf(ValidationError);
    });

    it('Rule R8: propagates sessionRepository.findByTokenRef errors unchanged', async () => {
      const deps = buildDeps();
      deps.sessionRepository.findByTokenRef.mockRejectedValueOnce(new Error('pg connection lost'));

      const service = createSessionService(deps);
      await expect(service.isRevoked(USER_ID, RAW_TOKEN)).rejects.toThrow(/pg connection lost/);
    });
  });
});

// ===========================================================================
// Rule R2 cross-cut sweep — exercise EVERY method on the service surface
// and assert that no log record produced contains any credential
// substring. This is a defense-in-depth check that complements the
// per-method R2 assertions above: even if the per-method tests
// individually allow some credential to leak (they do not), the
// cross-cut sweep would catch it.
// ===========================================================================

describe('Rule R2 cross-cut sweep', () => {
  it('exercises register, login, verifyToken, isRevoked, logout — no credential material in any log record', async () => {
    const deps = buildDeps();

    // Arrange behaviours for the entire flow up-front so each method
    // can be invoked without re-arranging mocks between calls.
    (deps.firebaseAuth.createUser as jest.Mock).mockResolvedValue({
      uid: USER_ID,
      email: EMAIL,
    });
    deps.userRepository.insert.mockResolvedValue(makeUserFixture());
    deps.signInWithPassword.mockResolvedValue(makeSignInResult());
    (deps.firebaseAuth.verifyIdToken as jest.Mock).mockResolvedValue(makeDecodedToken());
    deps.sessionRepository.insert.mockResolvedValue(makeSessionFixture());
    deps.sessionRepository.markRevoked.mockResolvedValue(
      makeSessionFixture({ revokedAt: FIXED_NOW }),
    );
    deps.sessionRepository.findByTokenRef.mockResolvedValue(
      makeSessionFixture({ revokedAt: FIXED_NOW }),
    );

    const service = createSessionService(deps);

    // Exercise every public method.
    await service.register({ email: EMAIL, password: PASSWORD });
    await service.login({ email: EMAIL, password: PASSWORD });
    await service.verifyToken(RAW_TOKEN);
    await service.isRevoked(USER_ID, RAW_TOKEN);
    await service.logout({ uid: USER_ID, rawBearerToken: RAW_TOKEN });

    // Assert no credential substring appears in ANY log record.
    const serialized = JSON.stringify(gatherLogArgs());
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('SENTINEL_CRED_99');
    expect(serialized).not.toContain(RAW_TOKEN);
    // Belt-and-suspenders: the words `password` and `idToken` MAY
    // appear as keys in production logs (e.g. `passwordResetRequired`
    // metadata), but the literal token value must NEVER appear, which
    // is what the substring checks above guarantee.
  });
});
