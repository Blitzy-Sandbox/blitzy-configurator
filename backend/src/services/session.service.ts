/**
 * Session Service — Register + Login + Logout + Middleware Hooks
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       "backend/src/services/session.service.ts | Session issuance + revocation
 *        (ST-024, ST-025)"
 *   - AAP §0.6.4 Track 1 Backend (T1-C): implement session orchestration in
 *     dependency order — auth middleware contract (ST-026) → registration
 *     (ST-023) → login (ST-024) → logout (ST-025).
 *   - AAP §0.2.1 "Firebase user mirroring in PostgreSQL": the local `users`
 *     table stores the Firebase `uid` and login identifier; the
 *     `credential_digest` column is retained for ST-031-AC4 schema conformance
 *     but is NEVER populated because credentials live exclusively in Firebase
 *     (Rule R3).
 *   - AAP §0.2.1 "Session persistence semantics": the `sessions` table is a
 *     revocation-list and issuance-audit log. A session row is created on
 *     login with the `uid`, issued/expires timestamps, and a revocation
 *     marker; logout marks the row revoked; session validation cross-
 *     references `verifyIdToken` against the revocation marker.
 *   - tickets/stories/ST-023-user-registration-endpoint.md
 *   - tickets/stories/ST-025-logout-endpoint-session-revocation.md
 *   - tickets/stories/ST-026-session-validation-middleware-contract.md
 *
 * Responsibilities:
 *   - `register({ email, password })` — creates the Firebase user (Firebase
 *     becomes the credential source of truth) and mirrors identity-only
 *     fields (uid, loginIdentifier) into the local `users` table. The
 *     `credential_digest` column is NEVER populated (Rule R3, AAP §0.2.1).
 *   - `login({ email, password })` — delegates password verification to
 *     Firebase via an injected `SignInWithPasswordFn` adapter, then calls
 *     `firebaseAuth.verifyIdToken` on the resulting idToken (Rule R3
 *     defense-in-depth), then writes a `sessions` row with a SHA-256
 *     base64url hash of the token as the stable, opaque `tokenRef`.
 *   - `logout({ uid, rawBearerToken })` — computes the SHA-256 tokenRef and
 *     calls `sessionRepository.markRevoked` which is idempotent via the
 *     repository's `COALESCE(revoked_at, now())` SQL.
 *   - `verifyToken(rawBearerToken)` — called by the session middleware
 *     (ST-026). Delegates exclusively to `firebaseAuth.verifyIdToken`
 *     (Rule R3). NO custom JWT parsing, NO signature verification, NO
 *     expiry checking — Firebase Admin SDK handles it all.
 *   - `isRevoked(uid, rawBearerToken)` — called by the session middleware
 *     (ST-026) after `verifyToken`. Looks up the session row by SHA-256
 *     tokenRef and returns `true` iff `revokedAt !== null`. Missing
 *     session rows return `false` (default-allow) because the sessions
 *     table is documented as a REVOCATION list, not an active-session
 *     registry — a valid Firebase idToken without a corresponding local
 *     session row (e.g. user signed in via the Firebase client SDK but
 *     never called `/api/auth/login`) is accepted.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): log records here emit ONLY
 *     `event`, `uid`, `errorName`, and structural metadata such as
 *     `emailPresent: true`. The values of `password`, `idToken`,
 *     `rawBearerToken`, and `tokenRef` NEVER appear in any logger call —
 *     not as a string, not as a substring, not concatenated, not
 *     destructured. The pino serializer allow-list in `../logging/pino.ts`
 *     provides a second line of defense; the per-call discipline below is
 *     the first line.
 *   - R3 (Firebase Admin SDK only): the `verifyToken` method delegates
 *     EXCLUSIVELY to `firebaseAuth.verifyIdToken`. There are no imports of
 *     `jsonwebtoken`, `jose`, or `jwt-decode` anywhere in this file. There
 *     is no custom JWT parsing, no signature verification, no expiry
 *     checking, no JWKS fetching. The `login` flow ALSO calls
 *     `firebaseAuth.verifyIdToken` on the issued token as defense-in-depth
 *     against a compromised sign-in adapter.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. Configuration is dependency-injected via
 *     {@link SessionServiceDeps}.
 *   - R8 (fail-closed): repository and Firebase verification errors
 *     propagate to the caller. Sign-in adapter failures are translated to
 *     {@link UnauthenticatedError} (HTTP 401) with an intentionally
 *     generic "invalid credentials" message that does NOT leak the
 *     specific Firebase error code (preventing user-enumeration oracles).
 *     Validation errors are thrown early via {@link ValidationError}
 *     before any side effect.
 *
 * Key design decisions (full rationale lives in `docs/decisions/README.md`
 * per the user-provided Explainability Rule):
 *
 *   - SHA-256 base64url tokenRef. The repository's `tokenRef` column is an
 *     opaque, stable, URL-safe, collision-resistant string. SHA-256 is the
 *     pragmatic default — cryptographically strong, widely available,
 *     fixed-length output (43 chars in base64url without padding). The raw
 *     Firebase idToken is NEVER stored in the database (Rule R2).
 *
 *   - `signInWithPassword` injected as an adapter. Firebase Admin SDK does
 *     NOT verify passwords — it only provides `createUser`/`verifyIdToken`.
 *     Password authentication must therefore go through the Firebase Auth
 *     REST API endpoint `accounts:signInWithPassword` (or the emulator
 *     equivalent). Injecting the adapter keeps the service transport-
 *     agnostic and trivially testable (a unit test passes a `jest.fn()`
 *     adapter; a production wire-up provides the REST-based implementation).
 *
 *   - Double-verify on login. After the adapter returns an idToken, the
 *     service immediately calls `firebaseAuth.verifyIdToken(idToken)`. This
 *     defends against a compromised or misconfigured adapter that could
 *     otherwise smuggle forged tokens — the service trusts ONLY the Admin
 *     SDK's `verifyIdToken` result (Rule R3 defense-in-depth).
 *
 *   - {@link UnauthenticatedError} for ALL login failures. The adapter may
 *     surface specific Firebase error codes (`auth/invalid-password`,
 *     `auth/user-not-found`, etc.) but the service deliberately collapses
 *     ALL sign-in failures to a single, generic "invalid credentials"
 *     error. This prevents user-enumeration oracles where an attacker
 *     could differentiate "user does not exist" from "wrong password" by
 *     observing distinct error responses. The route layer translates this
 *     to an HTTP 401 with a generic body.
 *
 *   - `credential_digest` column NEVER populated. ST-031 retains the column
 *     in the schema for AC4 conformance ("sized to prevent cleartext
 *     storage"), but Rule R3 forbids any credential material in our
 *     database. The service NEVER passes `credentialDigest` to
 *     `userRepository.insert`; the repository's INSERT statement omits the
 *     column entirely so it defaults to NULL. This is enforced
 *     structurally — {@link UserRepository.insert}'s parameter type does
 *     not even accept a `credentialDigest` field.
 *
 *   - Default-allow on missing session row. A valid Firebase idToken
 *     without a corresponding local session row is accepted. The sessions
 *     table is a REVOCATION list — the absence of a row means "never
 *     revoked", not "never authenticated". This matters for users who
 *     authenticate via the Firebase client SDK on the frontend without
 *     calling `/api/auth/login` (a legitimate flow when the frontend has
 *     its own session-management layer).
 *
 *   - Idempotent logout. The repository's `markRevoked` uses
 *     `COALESCE(revoked_at, now())` so calling it twice preserves the
 *     ORIGINAL revocation timestamp. This satisfies ST-025-AC3 ("logout is
 *     idempotent: submitting the same revoked token again returns a
 *     documented non-error response and does not alter state") at the
 *     database tier — the service does not need to check state first.
 *
 *   - PII reduction in logs. While Rule R2 strictly forbids only
 *     credential material, email addresses are PII that the service
 *     intentionally avoids emitting at value level. Login/registration
 *     events log `emailPresent: true` rather than the email itself,
 *     keeping log records inside a lower sensitivity class.
 *
 * Composition (factory pattern, AAP §0.5.2):
 *   The service is constructed via `createSessionService(deps)` rather
 *   than as a class, matching the pattern used by `*.repository.ts` and
 *   the middleware factories. Factories make dependency injection
 *   explicit at the call site, support `Object.freeze` of the returned
 *   record (preventing accidental method monkey-patching downstream),
 *   and play well with tree-shaking. The composition root in
 *   `backend/src/index.ts` calls:
 *
 *     const sessionService = createSessionService({
 *       sessionRepository,
 *       userRepository,
 *       firebaseAuth,
 *       signInWithPassword,
 *     });
 *
 * Forbidden patterns (per AAP Phase 9):
 *   - DO NOT import `jsonwebtoken`, `jose`, or `jwt-decode` (Rule R3).
 *   - DO NOT perform custom JWT parsing — `verifyToken` delegates only.
 *   - DO NOT log `password`, `idToken`, `rawBearerToken`, or `tokenRef`
 *     values — even hashed tokenRefs could leak via correlation analysis.
 *   - DO NOT emit string concatenation containing credential variables.
 *   - DO NOT pass `credentialDigest` to `userRepository.insert`.
 *   - DO NOT store the raw idToken as the `tokenRef` — always SHA-256 it.
 *   - DO NOT read `process.env.*` here — env validation lives in
 *     `config/env.ts` and Firebase Auth init lives in `auth/firebase-admin.ts`.
 *   - DO NOT export the SDK surface — all Firebase Admin types are
 *     re-exported via `auth/firebase-admin.ts` already.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/auth/firebase-admin.ts` — supplies {@link FirebaseAuth}
 *     and {@link DecodedIdToken} type aliases; the production SDK instance
 *     is dependency-injected here.
 *   - `backend/src/repositories/session.repository.ts` — supplies the
 *     {@link SessionRepository} contract this service consumes (`insert`,
 *     `findByTokenRef`, `markRevoked`).
 *   - `backend/src/repositories/user.repository.ts` — supplies the
 *     {@link UserRepository} contract this service consumes (`insert`).
 *   - `backend/src/logging/pino.ts` — structured logger; serializer allow-
 *     list defends against accidental credential leakage.
 *   - `backend/src/middleware/session.ts` — consumes {@link SessionService}
 *     methods `verifyToken` and `isRevoked` for ST-026.
 *   - `backend/src/routes/auth.ts` — consumes `register`, `login`, `logout`
 *     for ST-023, ST-024, ST-025.
 *   - `backend/src/index.ts` — composition root assembles the service.
 *
 * @see backend/src/auth/firebase-admin.ts
 * @see backend/src/repositories/session.repository.ts
 * @see backend/src/repositories/user.repository.ts
 * @see backend/src/logging/pino.ts
 * @see backend/src/middleware/session.ts
 * @see tickets/stories/ST-023-user-registration-endpoint.md
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
//
// Convention: Node built-ins → third-party (type-only first) → relative.
// Within each block, alphabetical ordering.
//
// `import type` syntax produces ZERO runtime emit per TypeScript spec —
// type-only imports are erased entirely by the compiler. The Firebase
// Admin SDK type aliases below therefore have no runtime presence in this
// file's compiled output, keeping the Rule R3 verification surface narrow:
// `grep "firebase-admin" backend/src/services/session.service.ts` finds
// only this `import type` line, which is fully erased after compilation.

import { createHash } from 'node:crypto';

import type { DecodedIdToken, FirebaseAuth } from '../auth/firebase-admin';
import type { SessionRepository } from '../repositories/session.repository';
import type { UserRepository } from '../repositories/user.repository';

import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Section 1: Public error classes
// ---------------------------------------------------------------------------
//
// Two named error classes the service throws:
//   - {@link ValidationError} — input failed validation (e.g. empty email,
//     missing rawBearerToken). The route layer translates to HTTP 400.
//   - {@link UnauthenticatedError} — login credentials were rejected by
//     the sign-in adapter. The route layer translates to HTTP 401. The
//     `code` field is intentionally generic ('INVALID_CREDENTIALS') and
//     the same for ALL sign-in failures (auth/user-not-found,
//     auth/invalid-password, auth/too-many-requests, etc.) to prevent
//     user-enumeration oracles.
//
// Both classes set their own `name` so `JSON.stringify(err)` and pino's
// `stdSerializers.err` produce a stable, machine-readable type tag. Both
// inherit `message` from `Error` so any tooling that reads `err.message`
// continues to work without modification.
// ---------------------------------------------------------------------------

/**
 * Thrown when an input parameter fails structural validation (empty,
 * non-string, etc.). Distinct from {@link UnauthenticatedError} because
 * validation failures are 400-class (caller bug) and authentication
 * failures are 401-class (credential rejection).
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'ValidationError'`
 *   - `field`    — the parameter name that failed validation
 *   - `code`     — machine-readable error code (default `'VALIDATION_FAILED'`)
 *   - `message`  — inherited from `Error`
 *
 * Usage:
 *   throw new ValidationError('email', 'email must be a non-empty string');
 *   throw new ValidationError('field', 'reason', 'CUSTOM_CODE');
 */
export class ValidationError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so that
   * `err instanceof Error` is true while `err.name === 'ValidationError'`
   * lets a generic error handler distinguish validation failures without
   * an instanceof check (which is sometimes unreliable across module-
   * boundary realms in TypeScript).
   */
  public override readonly name: string = 'ValidationError';

  /**
   * The parameter name that failed validation (e.g. `'email'`,
   * `'password'`, `'uid'`, `'rawBearerToken'`). Operators and callers
   * use this to identify the invalid input without scraping the
   * error message.
   */
  public readonly field: string;

  /**
   * Machine-readable error code. Defaults to `'VALIDATION_FAILED'` but
   * may be overridden for more specific failure classes (e.g.
   * `'EMAIL_FORMAT_INVALID'`). The route layer maps this to a stable
   * external error code in the HTTP 400 response body.
   */
  public readonly code: string;

  /**
   * @param field The parameter name that failed validation.
   * @param message Human-readable failure reason. Per Rule R2, this
   *   message MUST NOT contain credential material — callers are
   *   responsible for ensuring messages stay credential-clean.
   * @param code Machine-readable error code. Defaults to
   *   `'VALIDATION_FAILED'`.
   */
  public constructor(field: string, message: string, code: string = 'VALIDATION_FAILED') {
    super(message);
    this.field = field;
    this.code = code;
  }
}

/**
 * Thrown when a credential check (sign-in via Firebase) is rejected.
 * Mapped to HTTP 401 by the route layer.
 *
 * Public members exposed (per the file's export schema):
 *   - `name`     — fixed string `'UnauthenticatedError'`
 *   - `code`     — machine-readable error code (default `'UNAUTHENTICATED'`)
 *   - `message`  — inherited from `Error`
 *
 * Information-disclosure posture:
 *   The `message` MUST be intentionally generic ("invalid credentials")
 *   regardless of the specific underlying cause (`auth/user-not-found`,
 *   `auth/invalid-password`, `auth/too-many-requests`, etc.). This
 *   collapses the distinction between "no such user" and "wrong
 *   password" into a single 401 outcome, neutralising user-enumeration
 *   oracles. The internal cause is logged at `warn` level for operator
 *   visibility but never surfaced to the client.
 */
export class UnauthenticatedError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so a generic error
   * handler can distinguish authentication failures without an
   * instanceof check.
   */
  public override readonly name: string = 'UnauthenticatedError';

  /**
   * Machine-readable error code. Defaults to `'UNAUTHENTICATED'` but
   * may be overridden for more specific failure classes (e.g.
   * `'INVALID_CREDENTIALS'`). The route layer maps this to a stable
   * external error code in the HTTP 401 response body.
   */
  public readonly code: string;

  /**
   * @param message Human-readable failure reason. SHOULD be generic
   *   (e.g. "invalid credentials") to prevent user enumeration.
   * @param code Machine-readable error code. Defaults to
   *   `'UNAUTHENTICATED'`.
   */
  public constructor(message: string, code: string = 'UNAUTHENTICATED') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Section 2: Module-private validation helpers
// ---------------------------------------------------------------------------
//
// Each helper guards against null, undefined, non-string, and empty inputs.
// Format-specific validation (e.g. RFC 5322 email syntax, password
// complexity policy) is intentionally NOT performed here: Firebase Auth
// owns those checks and surfaces them via its own error codes, which
// the service translates uniformly to {@link UnauthenticatedError} on
// login or to a Firebase-thrown error during register.
//
// Why these are module-private (not exported):
//   The validation contract is an implementation detail of the service.
//   Exposing the helpers would invite callers to short-circuit the
//   service's contract (e.g. validate-then-call-without-validating-again),
//   which would be a regression of the defense-in-depth posture. The
//   service's PUBLIC contract is the four entry points (register, login,
//   logout, verifyToken, isRevoked); validation is just a hidden
//   precondition each one enforces internally.
// ---------------------------------------------------------------------------

/**
 * Reject null, undefined, non-string, and empty-string emails.
 *
 * Format-specific RFC 5322 validation is delegated to Firebase Auth on the
 * register/login flow — Firebase returns `auth/invalid-email` for malformed
 * addresses, which the service translates to a generic
 * {@link UnauthenticatedError} on login or surfaces directly on register.
 *
 * @throws {ValidationError} when `email` is not a non-empty string.
 */
function validateEmail(email: unknown): asserts email is string {
  if (typeof email !== 'string' || email.length === 0) {
    throw new ValidationError('email', 'email must be a non-empty string');
  }
}

/**
 * Reject null, undefined, non-string, and empty-string passwords.
 *
 * Password complexity policy is delegated to Firebase Auth — Firebase
 * enforces the project-configured minimum length and surfaces
 * `auth/weak-password` for non-conforming values, which the service
 * translates uniformly.
 *
 * Per Rule R2: this function MUST NOT log the password value, nor include
 * any prefix/suffix of it in any error message, nor leak its length via
 * a sized error message. The error message is constant so a credential
 * cannot be inferred from response timing or content shape.
 *
 * @throws {ValidationError} when `password` is not a non-empty string.
 */
function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new ValidationError('password', 'password must be a non-empty string');
  }
}

/**
 * Reject null, undefined, non-string, and empty-string uids.
 *
 * @throws {ValidationError} when `uid` is not a non-empty string.
 */
function validateUid(uid: unknown): asserts uid is string {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new ValidationError('uid', 'uid must be a non-empty string');
  }
}

/**
 * Reject null, undefined, non-string, and empty-string raw bearer tokens.
 *
 * Per Rule R2: this function MUST NOT log the token value. The error
 * message is constant so a token cannot be inferred from response timing
 * or content shape.
 *
 * @throws {ValidationError} when `rawBearerToken` is not a non-empty
 *   string.
 */
function validateRawToken(rawBearerToken: unknown): asserts rawBearerToken is string {
  if (typeof rawBearerToken !== 'string' || rawBearerToken.length === 0) {
    throw new ValidationError('rawBearerToken', 'rawBearerToken must be a non-empty string');
  }
}

/**
 * Derive the stable, opaque, URL-safe `tokenRef` stored in the `sessions`
 * table from the raw Firebase idToken.
 *
 * Algorithm: SHA-256 → base64url. Cryptographically strong, fixed-length
 * (43 chars after base64url-without-padding encoding of 32 bytes),
 * deterministic (same input produces same output across calls and across
 * processes), and URL-safe (no `/`, `+`, or `=` characters that would
 * require quoting in a URL or filesystem path).
 *
 * Why hash and not store the raw token:
 *   - Rule R2 — the raw token is credential material; storing it in the
 *     database would mirror it into every backup, every read replica,
 *     and every operator's psql session.
 *   - Defence-in-depth — even a database read-only compromise should not
 *     yield reusable credentials. The hash is one-way: an attacker with
 *     the hash cannot reconstruct the original token without breaking
 *     SHA-256's pre-image resistance.
 *   - Stability — the hash output is fixed-length and URL-safe, ideal as
 *     a primary-key / lookup key in the `sessions` table.
 *
 * Why SHA-256 specifically:
 *   - Pragmatic default: cryptographically strong (collision-resistant in
 *     practice), widely available in Node's standard library, fixed
 *     output length, no salt required (the input space — Firebase
 *     idTokens — is a high-entropy random JWT, so a per-record salt
 *     would not measurably improve the security posture).
 *   - Decision rationale documented in `docs/decisions/README.md` per the
 *     Explainability Rule.
 *
 * @param rawBearerToken The raw Firebase idToken from the
 *   `Authorization: Bearer <token>` header.
 * @returns A 43-character base64url-encoded SHA-256 digest.
 */
function hashTokenRef(rawBearerToken: string): string {
  return createHash('sha256').update(rawBearerToken).digest('base64url');
}

// ---------------------------------------------------------------------------
// Section 3: Public types
// ---------------------------------------------------------------------------

/**
 * Adapter contract for Firebase email+password sign-in.
 *
 * Why this is an adapter and not a direct call:
 *   The Firebase Admin SDK does NOT verify passwords directly — it
 *   provides only `createUser`, `verifyIdToken`, `getUser`, and a handful
 *   of administrative methods. Password authentication must therefore go
 *   through the public Firebase Auth REST API endpoint
 *   `accounts:signInWithPassword` or, when running against the Firebase
 *   Auth Emulator, the equivalent emulator endpoint at
 *   `${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`.
 *   Injecting the adapter as a dependency keeps the service transport-
 *   agnostic and trivially testable: a unit test can pass `jest.fn()`
 *   that returns a mocked {@link SignInResult}; the production wire-up
 *   provides the REST-based implementation.
 *
 * Implementations of this adapter live alongside `auth/firebase-admin.ts`
 * (typically in a sibling `auth/firebase-rest.ts` module) — NOT in this
 * service. Implementations MUST:
 *   - Read the Firebase Auth REST endpoint URL from environment-driven
 *     configuration (the `FIREBASE_AUTH_EMULATOR_HOST` env var auto-
 *     redirects calls to the local emulator when set).
 *   - Read the Firebase Web API Key from configuration as required by the
 *     REST API.
 *   - Translate transport-layer errors into a thrown error; the service
 *     catches every thrown error and translates to
 *     {@link UnauthenticatedError} regardless of the underlying cause.
 *   - Per Rule R2, never log the password value.
 *
 * @param params - Object containing the user's email and password.
 *   Both are non-empty strings; the service validates this before
 *   invoking the adapter, so the adapter does NOT need to re-validate.
 * @returns A {@link SignInResult} containing the issued idToken, the
 *   user's uid, and the absolute expiration timestamp.
 * @throws Any error if the credentials are rejected, the network is
 *   unreachable, or the Firebase Auth REST API returns a non-2xx
 *   response. The service catches every thrown error and translates to
 *   {@link UnauthenticatedError}.
 */
export type SignInWithPasswordFn = (params: {
  email: string;
  password: string;
}) => Promise<SignInResult>;

/**
 * Result returned by a successful {@link SignInWithPasswordFn} call.
 *
 * Fields:
 *   - `idToken`   — the Firebase JWT idToken. The service treats this as
 *     opaque credential material and forwards it to
 *     `firebaseAuth.verifyIdToken` for cryptographic validation. The
 *     value is NEVER logged (Rule R2).
 *   - `uid`       — the user's Firebase user ID. Equals the `users.id`
 *     primary key in the local mirror per AAP §0.2.1.
 *   - `expiresAt` — the absolute timestamp at which the idToken expires.
 *     Persisted into the `sessions.expires_at` column.
 */
export interface SignInResult {
  /** Firebase-issued JWT idToken (treated as opaque credential material). */
  idToken: string;
  /** Firebase user ID; equals `users.id` per AAP §0.2.1. */
  uid: string;
  /** Absolute expiration timestamp of the idToken. */
  expiresAt: Date;
}

/**
 * Parameters for {@link SessionService.register}.
 */
export interface RegisterParams {
  /** End-user email; non-empty string. */
  email: string;
  /** End-user password; non-empty string. NEVER logged (Rule R2). */
  password: string;
}

/**
 * Result returned by a successful {@link SessionService.register} call.
 *
 * Per ST-023-AC2: registration MUST return the canonical user record
 * WITHOUT any credential material AND MUST NOT issue a session token by
 * itself (the caller flows through `/api/auth/login` for that).
 */
export interface RegisterResult {
  /** Firebase user ID (equals the `users.id` primary key). */
  uid: string;
  /** The login identifier (email) the user provided. */
  loginIdentifier: string;
}

/**
 * Parameters for {@link SessionService.login}.
 */
export interface LoginParams {
  /** End-user email; non-empty string. */
  email: string;
  /** End-user password; non-empty string. NEVER logged (Rule R2). */
  password: string;
}

/**
 * Result returned by a successful {@link SessionService.login} call.
 *
 * Mirrors the {@link SignInResult} shape but is a distinct type so the
 * service's PUBLIC contract is decoupled from the internal adapter
 * surface — a future change to the adapter (e.g. additional metadata
 * fields) does not bleed into the route response shape.
 */
export interface LoginResult {
  /**
   * The Firebase-issued JWT idToken. The route layer returns this to the
   * client, who attaches it as `Authorization: Bearer <idToken>` on
   * subsequent authenticated requests. The value is NEVER logged
   * (Rule R2).
   */
  idToken: string;
  /** Firebase user ID (equals `users.id`). */
  uid: string;
  /** Absolute expiration timestamp of the idToken. */
  expiresAt: Date;
}

/**
 * Parameters for {@link SessionService.logout}.
 *
 * Both fields are required:
 *   - `uid` — the authenticated user's Firebase user ID. Sourced from
 *     `req.uid` after the session middleware (ST-026) has populated it.
 *     Used in the audit log; not used as a query key (the lookup key is
 *     the SHA-256 of `rawBearerToken`).
 *   - `rawBearerToken` — the raw bearer token from the
 *     `Authorization: Bearer <token>` header. Hashed via SHA-256 to
 *     derive the `tokenRef` used to mark the matching session row
 *     revoked. NEVER logged (Rule R2).
 */
export interface LogoutParams {
  /** Authenticated user's Firebase user ID (from `req.uid`). */
  uid: string;
  /**
   * Raw bearer token from the inbound request's Authorization header.
   * NEVER logged (Rule R2). Hashed via SHA-256 to derive the tokenRef.
   */
  rawBearerToken: string;
}

/**
 * Public service contract.
 *
 * Five methods, sized to the requirements of stories ST-023, ST-024,
 * ST-025, and ST-026:
 *
 *   - `register(params)` — ST-023. Creates the Firebase user (Firebase
 *     becomes the credential source of truth) and mirrors identity-only
 *     fields into the local `users` table. Returns the canonical user
 *     record WITHOUT any credential material.
 *
 *   - `login(params)` — ST-024. Verifies credentials via the injected
 *     {@link SignInWithPasswordFn}, double-verifies the issued idToken
 *     via `firebaseAuth.verifyIdToken` (Rule R3 defense-in-depth), and
 *     persists a `sessions` row. Returns the idToken to the caller.
 *
 *   - `logout(params)` — ST-025. Marks the session row revoked in the
 *     `sessions` table. Idempotent via the repository's `COALESCE`
 *     clause. ST-025-AC3: a second call against the same revoked token
 *     is a non-error.
 *
 *   - `verifyToken(rawBearerToken)` — ST-026. Delegates EXCLUSIVELY to
 *     `firebaseAuth.verifyIdToken` (Rule R3). NO custom JWT parsing.
 *
 *   - `isRevoked(uid, rawBearerToken)` — ST-026. Looks up the session
 *     row by SHA-256 tokenRef and returns `true` iff `revokedAt !== null`.
 *     Default-allow on missing session row — see service-class JSDoc.
 *
 * Structural compatibility with the middleware's `SessionService`
 * interface (declared in `backend/src/middleware/session.ts`): the
 * middleware declares a NARROWER interface containing only `verifyToken`
 * and `isRevoked`. TypeScript's structural typing accepts a wider
 * implementation (this one) for a narrower contract, so the same factory
 * result satisfies both the middleware and the route consumers.
 */
export interface SessionService {
  /**
   * Register a new end user via Firebase Auth and mirror identity-only
   * fields into the local `users` table.
   *
   * Per ST-023-AC4: credential material submitted at registration is
   * NEVER stored in cleartext and is NEVER returned in any response.
   * Per Rule R3 / AAP §0.2.1: the password is forwarded to Firebase only;
   * `users.credential_digest` is NEVER populated.
   *
   * @throws {ValidationError} when email/password fail structural
   *   validation (empty, non-string).
   * @throws Any error from `firebaseAuth.createUser` (e.g. duplicate email
   *   surfaces as `auth/email-already-exists`). The route layer translates
   *   these to appropriate HTTP statuses (typically 409 Conflict for
   *   duplicates per ST-023-AC3).
   * @throws Any error from `userRepository.insert` (e.g. PG `23505`
   *   unique-violation if the local mirror already has a row for this
   *   uid — vanishingly rare but defended by the FK).
   */
  register(params: RegisterParams): Promise<RegisterResult>;

  /**
   * Sign in an existing user and issue a session record.
   *
   * Steps:
   *   1. Validate inputs.
   *   2. Delegate password verification to the injected
   *      {@link SignInWithPasswordFn} adapter.
   *   3. Double-verify the issued idToken via `firebaseAuth.verifyIdToken`
   *      (Rule R3 defense-in-depth).
   *   4. Persist a `sessions` row keyed by SHA-256 of the idToken.
   *
   * @throws {ValidationError} when email/password fail structural
   *   validation.
   * @throws {UnauthenticatedError} (code `'INVALID_CREDENTIALS'`) when
   *   the sign-in adapter rejects the credentials. Generic message
   *   regardless of the underlying Firebase error code (prevents user
   *   enumeration).
   * @throws Any error from `firebaseAuth.verifyIdToken` if the
   *   double-verify step fails (this should never happen with a
   *   well-behaved adapter; treated as 500-class).
   * @throws Any error from `sessionRepository.insert` (PG errors).
   */
  login(params: LoginParams): Promise<LoginResult>;

  /**
   * Mark the session associated with `rawBearerToken` revoked.
   *
   * Idempotent via the repository's `COALESCE(revoked_at, now())`. A
   * second call against the same revoked token preserves the original
   * revocation timestamp and does not raise an error (ST-025-AC3).
   *
   * If no session row matches the supplied `rawBearerToken` (e.g. the
   * user authenticated via the Firebase client SDK without ever calling
   * `/api/auth/login`), the call is a no-op — the audit log records the
   * intended revocation but the database is unchanged.
   *
   * @throws {ValidationError} when uid/rawBearerToken fail structural
   *   validation.
   * @throws Any error from `sessionRepository.markRevoked` (PG errors).
   */
  logout(params: LogoutParams): Promise<void>;

  /**
   * Verify a bearer token via Firebase Admin SDK.
   *
   * Per Rule R3 / Constraint C2: this method delegates EXCLUSIVELY to
   * `firebaseAuth.verifyIdToken(rawBearerToken)`. No custom JWT parsing,
   * no signature verification, no expiry checking, no JWKS fetching.
   * Firebase Admin SDK handles cryptographic validation and expiry
   * enforcement; this service does not.
   *
   * Consumed by the session middleware (`backend/src/middleware/session.ts`)
   * on every protected request.
   *
   * @param rawBearerToken The raw token from the `Authorization: Bearer
   *   <token>` header (with the "Bearer " prefix already stripped).
   * @returns The decoded id token. At minimum contains `uid`.
   * @throws {ValidationError} when `rawBearerToken` fails structural
   *   validation.
   * @throws Any error from `firebaseAuth.verifyIdToken` — the middleware
   *   treats every thrown error as `INVALID_SESSION` per ST-026-AC2 and
   *   Rule R8 (fail-closed).
   */
  verifyToken(rawBearerToken: string): Promise<DecodedIdToken>;

  /**
   * Check whether a session has been revoked.
   *
   * Looks up the session row by SHA-256 tokenRef. Returns `true` iff a
   * row exists AND its `revokedAt` is non-null.
   *
   * Default-allow on missing session row: a valid Firebase idToken
   * without a corresponding local session row (e.g. the user signed in
   * via the Firebase client SDK and never called `/api/auth/login`) is
   * accepted. The sessions table is documented as a REVOCATION list, not
   * an active-session registry.
   *
   * Consumed by the session middleware on every protected request after
   * `verifyToken` succeeds.
   *
   * @param uid The Firebase user ID (from `decodedToken.uid`). Used for
   *   audit logging; not used as a query key.
   * @param rawBearerToken The raw bearer token. Hashed via SHA-256 to
   *   derive the tokenRef used for the database lookup.
   * @returns `true` if the session is revoked (caller should reject the
   *   request); `false` otherwise (including when no row exists).
   * @throws {ValidationError} when uid/rawBearerToken fail structural
   *   validation.
   * @throws Any error from `sessionRepository.findByTokenRef` — the
   *   middleware fails closed per Rule R8 and rejects the request.
   */
  isRevoked(uid: string, rawBearerToken: string): Promise<boolean>;
}

/**
 * Dependencies required by {@link createSessionService}.
 *
 * The factory pattern is mandated by the composition root snippet in
 * `backend/src/index.ts`:
 *
 *   const sessionService = createSessionService({
 *     sessionRepository,
 *     userRepository,
 *     firebaseAuth,
 *     signInWithPassword,
 *   });
 *
 * Using a destructuring-object shape (rather than positional arguments)
 * makes the factory extensible: future dependencies can be added without
 * breaking existing call sites. It also documents each dependency by
 * name at the call site, which is operationally useful.
 */
export interface SessionServiceDeps {
  /** Sessions repository (revocation list + issuance audit log). */
  sessionRepository: SessionRepository;
  /** Users repository (local mirror of Firebase identity). */
  userRepository: UserRepository;
  /**
   * Firebase Admin SDK `Auth` instance. Source of truth for
   * `verifyIdToken` (Rule R3) and `createUser` (registration). Obtain
   * via `initializeFirebaseAdmin()` from `auth/firebase-admin.ts`.
   */
  firebaseAuth: FirebaseAuth;
  /**
   * Email+password sign-in adapter. Wraps the Firebase Auth REST API
   * `accounts:signInWithPassword` endpoint (or its emulator equivalent).
   * Injected as a dependency so the service is transport-agnostic and
   * trivially testable.
   */
  signInWithPassword: SignInWithPasswordFn;
}

// ---------------------------------------------------------------------------
// Section 4: Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link SessionService} bound to the supplied dependencies.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createSessionService({ ... })`) — easier to mock in unit tests
 *     than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *   - Matches the pattern established by `*.repository.ts` and the
 *     middleware factories.
 *
 * The returned record is `Object.freeze`d so calling code cannot
 * substitute one of the methods at runtime — this prevents a class of
 * bugs where a test or middleware accidentally mutates the shared
 * service instance.
 *
 * Compose-time fail-fast:
 *   The factory throws synchronously if any required dependency is
 *   missing or null. This is consistent with the Rule R4 fail-closed
 *   startup posture: a developer error surfaces at app boot, not at
 *   request time.
 *
 * @param deps See {@link SessionServiceDeps}.
 * @returns A frozen {@link SessionService} ready for use.
 * @throws Error if any required dependency is missing.
 */
export function createSessionService(deps: SessionServiceDeps): SessionService {
  // -------------------------------------------------------------------
  // Step 1: Compose-time fail-fast on missing dependencies.
  //
  // TypeScript's `strict` null checks already catch most of these at
  // compile time, but the runtime checks defend against `any`-cast call
  // sites and JS callers (e.g. ad-hoc test harnesses that bypass the
  // type system). The errors are intentionally descriptive so a
  // developer can identify the missing dep without consulting source.
  // -------------------------------------------------------------------
  if (deps === undefined || deps === null || typeof deps !== 'object') {
    throw new Error('createSessionService: deps argument is required and must be an object');
  }

  const { sessionRepository, userRepository, firebaseAuth, signInWithPassword } = deps;

  if (sessionRepository === undefined || sessionRepository === null) {
    throw new Error('createSessionService: sessionRepository is required');
  }
  if (userRepository === undefined || userRepository === null) {
    throw new Error('createSessionService: userRepository is required');
  }
  if (firebaseAuth === undefined || firebaseAuth === null) {
    throw new Error('createSessionService: firebaseAuth is required');
  }
  if (typeof signInWithPassword !== 'function') {
    throw new Error('createSessionService: signInWithPassword must be a function');
  }

  // -------------------------------------------------------------------
  // Step 2: Build the service record.
  //
  // Each method is defined on the literal directly so destructured
  // access (`const { register } = sessionService;`) behaves identically
  // to property access (`sessionService.register(...)`) — no
  // `this`-binding confusion. This is the same pattern used by the
  // *.repository.ts factories.
  // -------------------------------------------------------------------
  const service: SessionService = {
    /**
     * Register a new end user — ST-023.
     *
     * Implementation flow:
     *   1. Validate email and password (structural).
     *   2. Call `firebaseAuth.createUser({ email, password })` —
     *      Firebase becomes the credential source of truth.
     *   3. Mirror identity-only fields (uid, loginIdentifier) into the
     *      local `users` table via `userRepository.insert`. The
     *      `credential_digest` column is NEVER populated (Rule R3, AAP
     *      §0.2.1) — `userRepository.insert` does not even accept a
     *      parameter for it.
     *   4. Log a `user.registered` event with `uid` and `emailPresent`
     *      only (Rule R2).
     *   5. Return the canonical user record (uid + loginIdentifier).
     *      Per ST-023-AC2 the response contains NO credential material
     *      and NO session token — login is a separate flow.
     *
     * Error paths:
     *   - {@link ValidationError} on empty/non-string inputs.
     *   - Native Firebase error on duplicate email (`auth/email-already-
     *     exists`) — propagates to the route layer for translation to
     *     HTTP 409.
     *   - Native PG error on a (vanishingly rare) `users.id` PK
     *     collision — propagates to the route layer.
     *
     * Per ST-023-AC3: failed registration MUST NOT create any partial
     * record. The two-step "Firebase first, local second" ordering
     * means a failure at the Firebase step leaves no local row. A
     * failure at the local-insert step (after a successful Firebase
     * createUser) leaves an orphaned Firebase user — ACCEPTABLE
     * because the next registration attempt with the same email will
     * surface as `auth/email-already-exists` and the operator can
     * reconcile via the Firebase console (this trade-off is
     * documented in the decision log).
     */
    async register({ email, password }: RegisterParams): Promise<RegisterResult> {
      validateEmail(email);
      validatePassword(password);

      // Firebase is the source of truth for credentials. The password
      // flows ONLY into the Firebase SDK and never reaches the local
      // database, the local logger, or any other side effect (Rule R3).
      const userRecord = await firebaseAuth.createUser({ email, password });
      const uid = userRecord.uid;

      // Mirror identity-only fields. The repository's INSERT statement
      // omits `credential_digest` from the column list, so the column
      // defaults to NULL per the ST-031 schema — no application code
      // path can populate it.
      await userRepository.insert({
        firebaseUid: uid,
        loginIdentifier: email,
      });

      // Per Rule R2: emit only `event`, `uid`, and `emailPresent`. The
      // email VALUE is intentionally not logged because it is PII; the
      // `emailPresent: true` field captures the structural fact
      // without leaking the address. The pino serializer allow-list
      // would redact a top-level `email` field anyway, but keeping it
      // out of the log call entirely is the first line of defense.
      logger.info(
        {
          event: 'user.registered',
          uid,
          emailPresent: true,
        },
        'user registered',
      );

      return { uid, loginIdentifier: email };
    },

    /**
     * Sign in an existing user and issue a session record — ST-024.
     *
     * Implementation flow:
     *   1. Validate email and password (structural).
     *   2. Delegate password verification to the injected
     *      {@link SignInWithPasswordFn} adapter. Adapter failures of
     *      ANY kind are translated to {@link UnauthenticatedError}
     *      with a generic message — preventing user enumeration via
     *      differential error responses.
     *   3. Double-verify the issued idToken via
     *      `firebaseAuth.verifyIdToken` (Rule R3 defense-in-depth).
     *      This protects against a compromised or misconfigured
     *      adapter that could otherwise smuggle a forged token.
     *   4. Persist a `sessions` row keyed by SHA-256(idToken).
     *   5. Log a `session.issued` event with `uid` only (Rule R2).
     *   6. Return the idToken, uid, and expiresAt to the caller.
     *
     * Error paths:
     *   - {@link ValidationError} on empty/non-string inputs.
     *   - {@link UnauthenticatedError} (code `'INVALID_CREDENTIALS'`)
     *     on any sign-in failure (generic — see information-disclosure
     *     posture in the class JSDoc).
     *   - Any error from `firebaseAuth.verifyIdToken` (vanishingly rare;
     *     adapter returned a forged token? — treated as 500-class).
     *   - Any error from `sessionRepository.insert` (PG errors).
     */
    async login({ email, password }: LoginParams): Promise<LoginResult> {
      validateEmail(email);
      validatePassword(password);

      // Step 1: delegate password verification to Firebase via the
      // adapter. Any thrown error — network failure, invalid email
      // syntax, wrong password, locked account — is collapsed to a
      // single generic UnauthenticatedError to prevent enumeration.
      let signIn: SignInResult;
      try {
        signIn = await signInWithPassword({ email, password });
      } catch (err) {
        // Per Rule R2: log the error CLASS NAME only, not the message.
        // The error name (e.g. 'FirebaseAuthError', 'TypeError') is
        // useful for operator debugging but does not leak credential
        // material or specific Firebase error codes that could enable
        // enumeration.
        const errorName = err instanceof Error ? err.name : 'UnknownError';
        logger.warn(
          {
            event: 'login.sign-in.failed',
            emailPresent: true,
            errorName,
          },
          'sign-in failed',
        );
        // Generic message — does NOT distinguish "user not found" from
        // "wrong password" (information-disclosure control). The route
        // layer maps this to HTTP 401 with the same generic body.
        throw new UnauthenticatedError('invalid credentials', 'INVALID_CREDENTIALS');
      }

      // Step 2: double-verify the issued idToken via the Admin SDK
      // (Rule R3 defense-in-depth). Even if the adapter were
      // compromised, the Admin SDK's verifyIdToken would reject a
      // forged token because forging requires Firebase's signing key.
      // Any thrown error here propagates to the caller; the route
      // layer logs it and returns 500-class.
      const decoded = await firebaseAuth.verifyIdToken(signIn.idToken);

      // Step 3: persist the session row. The tokenRef is the SHA-256
      // hash of the idToken — opaque, stable, URL-safe, and one-way.
      // The raw idToken is NEVER stored.
      const tokenRef = hashTokenRef(signIn.idToken);
      await sessionRepository.insert({
        userId: decoded.uid,
        tokenRef,
        issuedAt: new Date(),
        expiresAt: signIn.expiresAt,
      });

      // Per Rule R2: emit only `event` and `uid`. Token material
      // (idToken, tokenRef) NEVER appears in the log call.
      logger.info(
        {
          event: 'session.issued',
          uid: decoded.uid,
        },
        'session issued',
      );

      return {
        idToken: signIn.idToken,
        uid: decoded.uid,
        expiresAt: signIn.expiresAt,
      };
    },

    /**
     * Revoke an active session — ST-025.
     *
     * Implementation flow:
     *   1. Validate uid and rawBearerToken (structural).
     *   2. Compute tokenRef = SHA-256(rawBearerToken).
     *   3. Call `sessionRepository.markRevoked(tokenRef)` —
     *      idempotent via the repository's
     *      `UPDATE ... SET revoked_at = COALESCE(revoked_at, now())`
     *      SQL. A second call against the same revoked token preserves
     *      the original revocation timestamp.
     *   4. Log a `session.revoked` event with `uid` only.
     *
     * Per ST-025-AC3: logout is idempotent; submitting the same
     * revoked token again returns a documented non-error response and
     * does not alter state. The repository's COALESCE clause achieves
     * this at the database tier — no application-side state check
     * required.
     *
     * If no session row matches the supplied `rawBearerToken` (e.g.
     * the user signed in via the Firebase client SDK without ever
     * calling `/api/auth/login`), `markRevoked` returns `null` and the
     * service simply continues — the audit log captures the intended
     * revocation; the database is unchanged. ST-025-AC3's "non-error
     * response" semantics are satisfied because no error is thrown.
     *
     * Error paths:
     *   - {@link ValidationError} on empty/non-string inputs.
     *   - Any error from `sessionRepository.markRevoked` (PG errors).
     */
    async logout({ uid, rawBearerToken }: LogoutParams): Promise<void> {
      validateUid(uid);
      validateRawToken(rawBearerToken);

      const tokenRef = hashTokenRef(rawBearerToken);
      // The repository signature is `markRevoked(tokenRef: string)`, NOT
      // `markRevoked({ tokenRef })`. We pass the string directly. The
      // return value (Session | null) is intentionally discarded —
      // ST-025 cares about the side effect (revocation marker set), not
      // about returning the row to the caller.
      await sessionRepository.markRevoked(tokenRef);

      // Per Rule R2: emit only `event` and `uid`. The tokenRef is NOT
      // logged — even a hashed reference could enable correlation
      // analysis in adversarial settings.
      logger.info(
        {
          event: 'session.revoked',
          uid,
        },
        'session revoked',
      );
    },

    /**
     * Verify a bearer token via Firebase Admin SDK — ST-026.
     *
     * Per Rule R3 / Constraint C2: this method delegates EXCLUSIVELY
     * to `firebaseAuth.verifyIdToken(rawBearerToken)`. There is NO
     * custom JWT parsing, NO signature verification, NO expiry
     * checking, NO JWKS fetching. Firebase Admin SDK handles every
     * cryptographic concern; this service does not.
     *
     * Consumed by `backend/src/middleware/session.ts` on every
     * protected request.
     *
     * Error paths:
     *   - {@link ValidationError} on empty/non-string `rawBearerToken`.
     *   - Any error from `firebaseAuth.verifyIdToken` — the middleware
     *     treats every thrown error as `INVALID_SESSION` per ST-026-AC2
     *     and Rule R8 (fail-closed).
     */
    async verifyToken(rawBearerToken: string): Promise<DecodedIdToken> {
      validateRawToken(rawBearerToken);
      // Rule R3: exclusively delegate to Firebase Admin. No additional
      // logic, no parsing, no caching — pure delegation. This is the
      // single line of code that owns Rule R3 compliance for the
      // application; auditors can verify by reading these two lines.
      return firebaseAuth.verifyIdToken(rawBearerToken);
    },

    /**
     * Check whether a session is revoked — ST-026.
     *
     * Implementation flow:
     *   1. Validate uid and rawBearerToken (structural).
     *   2. Compute tokenRef = SHA-256(rawBearerToken).
     *   3. Look up the session row via
     *      `sessionRepository.findByTokenRef(tokenRef)`.
     *   4. If no row exists, return `false` (default-allow).
     *   5. Otherwise, return `true` iff `revokedAt !== null`.
     *
     * Default-allow on missing session row:
     *   The sessions table is documented (AAP §0.2.1) as a REVOCATION
     *   LIST, not an active-session registry. The absence of a row
     *   means "this session was never explicitly revoked", which is
     *   the correct answer for `isRevoked`. A user who authenticated
     *   via the Firebase client SDK on the frontend without calling
     *   our `/api/auth/login` endpoint will not have a local session
     *   row, but their request is still legitimate — Firebase's own
     *   verifyIdToken (called by `verifyToken`) is what gates
     *   authentication.
     *
     * Per ST-026-AC4: this method is on the hot path of every
     * authenticated request. The repository's `findByTokenRef` query
     * is backed by the PRIMARY KEY index on `sessions.token_ref`, so
     * the lookup is O(log n) — comfortably inside the AC4 latency
     * budget.
     *
     * Error paths:
     *   - {@link ValidationError} on empty/non-string inputs.
     *   - Any error from `sessionRepository.findByTokenRef` — the
     *     middleware fails closed per Rule R8 and rejects the request.
     *
     * Note: the `uid` parameter is required by the
     * {@link SessionService.isRevoked} signature (the middleware
     * passes it from the decoded token) but is not used for the
     * database lookup — the lookup key is the SHA-256 of the bearer
     * token. We accept the `uid` so future audit logging or
     * cross-referencing can be added without changing the public
     * signature, and so the type matches the middleware's contract.
     */
    async isRevoked(uid: string, rawBearerToken: string): Promise<boolean> {
      validateUid(uid);
      validateRawToken(rawBearerToken);

      const tokenRef = hashTokenRef(rawBearerToken);
      // The repository signature is `findByTokenRef(tokenRef: string)`.
      // Returns Session | null.
      const session = await sessionRepository.findByTokenRef(tokenRef);

      // Default-allow on missing session row. The sessions table is a
      // revocation list — absence means "never revoked", not "never
      // authenticated".
      if (session === null) {
        return false;
      }

      // The repository's Session interface guarantees `revokedAt: Date | null`.
      // A non-null value means the row was revoked (logout endpoint set
      // `revoked_at = now()` via the COALESCE clause).
      return session.revokedAt !== null;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a method at runtime — a defensive measure against a
  // class of bugs that are typically very hard to diagnose.
  return Object.freeze(service);
}
