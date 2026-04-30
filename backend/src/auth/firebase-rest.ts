/**
 * Firebase Auth REST adapter — `accounts:signInWithPassword` adapter for
 * the StrikeForge backend's email+password login path.
 *
 * Why this module exists:
 *   The Firebase Admin SDK does NOT verify passwords — it provides only
 *   `createUser`, `verifyIdToken`, `getUser`, and a handful of other
 *   administrative methods. To complete the email+password login flow
 *   required by ST-024 (POST /api/auth/login), the backend MUST exchange
 *   the credential pair for an idToken via the Firebase Auth REST API
 *   endpoint `accounts:signInWithPassword`. This module is the SOLE
 *   implementation of that exchange.
 *
 *   Per `services/session.service.ts:SignInWithPasswordFn` (the adapter
 *   contract this module satisfies), the function is injected as a
 *   dependency rather than called directly so the service layer stays
 *   transport-agnostic and trivially testable. Tests pass `jest.fn()`
 *   stubs; production wires the implementation below.
 *
 * Why `accounts:signInWithPassword` instead of any custom JWT flow:
 *   Per Rule R3 / Constraint C2 (AAP §0.8.1) the StrikeForge backend
 *   MUST validate session credentials EXCLUSIVELY via Firebase Admin
 *   SDK primitives. The `accounts:signInWithPassword` REST endpoint is
 *   the canonical Firebase-issued password-verification path: it
 *   returns a Firebase-signed idToken that `firebaseAuth.verifyIdToken`
 *   then validates cryptographically. There is NO custom JWT parsing,
 *   NO local password hashing comparison, NO `jsonwebtoken` / `jose` /
 *   `jwt-decode` dependency. This module's only privilege is to exchange
 *   credentials for the idToken; everything downstream is the Admin SDK.
 *
 * Why a separate module (rather than expanding `firebase-admin.ts`):
 *   `auth/firebase-admin.ts` keeps the module-level surface intentionally
 *   thin — its only public functions are `initializeFirebaseAdmin()` and
 *   the type re-exports `FirebaseAuth` / `DecodedIdToken`. Mixing a REST
 *   client into that file would (a) add a `node:fetch`/`undici` dependency
 *   to the canonical Admin-SDK initializer, and (b) muddy the Rule R3
 *   verification posture — auditors expect to see the SDK initializer
 *   alone, with REST-based password exchange isolated to its own file.
 *   The session-service docblock at `services/session.service.ts:485`
 *   explicitly anticipates this separation: "Implementations of this
 *   adapter live alongside `auth/firebase-admin.ts` (typically in a
 *   sibling `auth/firebase-rest.ts` module) — NOT in this service."
 *
 * Per the LocalGCP Verification Rule (AAP §0.8.2):
 *   When the env var `FIREBASE_AUTH_EMULATOR_HOST` is set (e.g.
 *   `firebase-auth-emulator:9099` inside Docker Compose, `localhost:9099`
 *   for host-networking profiles), this module routes the REST call to
 *   the local emulator at
 *     `http://${FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
 *   and uses the well-known emulator API key constant `'fake-api-key'`.
 *   When the env var is unset (production), the call goes to the public
 *   Firebase Auth REST endpoint at
 *     `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
 *   using a real Web API Key supplied via `FIREBASE_API_KEY`.
 *
 *   The emulator's `'fake-api-key'` is well-known: it is the value the
 *   Firebase Auth Emulator accepts in lieu of a real Web API Key, and
 *   it is also the value used by `tests/integration/fixtures/firebase-user.ts`
 *   for the same emulator-targeted REST calls. Hard-coding it for the
 *   emulator path is safe because (a) the value is documented public
 *   API, and (b) the value carries no production privileges — it works
 *   only against the emulator.
 *
 * Per Rule R2 (no credentials in logs):
 *   The `password` field is NEVER logged. This module:
 *     - Does NOT import a logger.
 *     - Throws errors whose `.message` strings contain ONLY the email
 *       (which is not a credential per the AAP) and the upstream HTTP
 *       status code; the password is excluded from every error path.
 *     - Logs no `console.*` calls (the project lint config forbids
 *       `console.*` repository-wide via `no-console: error`).
 *
 * Per Rule R4 (no env defaults in source):
 *   Production paths require `FIREBASE_API_KEY` to be set. The factory
 *   reads it via {@link requireEnv} which throws a descriptive
 *   `MissingEnvVarError` when the variable is unset or empty. The
 *   emulator path does NOT require `FIREBASE_API_KEY` because the
 *   emulator accepts the well-known constant — but the read of
 *   `FIREBASE_AUTH_EMULATOR_HOST` is guarded so a missing env var here
 *   is never a runtime crash. The decision tree is:
 *     - FIREBASE_AUTH_EMULATOR_HOST set        → emulator path,
 *                                                 'fake-api-key' constant.
 *     - FIREBASE_AUTH_EMULATOR_HOST unset      → production path,
 *                                                 require FIREBASE_API_KEY.
 *
 * Per Rule R6 / Constraint C4 (OTel registration order):
 *   This module makes outbound HTTP calls via the Node.js `fetch` global
 *   (Node 20 LTS includes the WHATWG `fetch` API natively). Outbound
 *   fetch calls are auto-instrumented by `@opentelemetry/auto-
 *   instrumentations-node` because the SDK was registered FIRST in
 *   `backend/src/index.ts`. No manual instrumentation needed; manual
 *   instrumentation would produce duplicate spans (violating C4).
 *
 * Per Constraint C5 (correlation ID propagation):
 *   The adapter does NOT manually attach the `x-correlation-id` header
 *   to outbound REST calls. Two independent telemetry layers attach
 *   identifying headers transparently:
 *     1. OTel undici instrumentation
 *        (`@opentelemetry/instrumentation-undici`, bundled in
 *        `@opentelemetry/auto-instrumentations-node`) attaches the
 *        W3C `traceparent` header at undici's request-dispatch
 *        boundary.
 *     2. The correlation-ID middleware's `globalThis.fetch` wrapper
 *        (`backend/src/middleware/correlation.ts`) attaches
 *        `x-correlation-id` at the public fetch surface using the
 *        request's ALS-bound correlation context. Because Node 20
 *        LTS's global `fetch` is built on undici and bypasses
 *        `node:http` entirely, the http/https monkey-patches in
 *        `correlation.ts` would NOT cover this call path on their
 *        own — the dedicated fetch wrapper is what closes the gap
 *        documented in QA Final F Issue #1.
 *   This module's HTTP-side concerns are therefore confined to the
 *   request body and response decoding.
 *
 * Composition root usage (excerpt from backend/src/index.ts):
 *
 *   ```ts
 *   import { initializeFirebaseAdmin } from './auth/firebase-admin';
 *   import { createSignInWithPassword } from './auth/firebase-rest';
 *   import { createSessionService } from './services/session.service';
 *
 *   const firebaseAuth = initializeFirebaseAdmin();
 *   const signInWithPassword = createSignInWithPassword();
 *   const sessionService = createSessionService({
 *     sessionRepository,
 *     userRepository,
 *     firebaseAuth,
 *     signInWithPassword,
 *   });
 *   ```
 *
 * @see backend/src/services/session.service.ts — the SOLE consumer; declares
 *      the {@link SignInWithPasswordFn} adapter contract this module satisfies.
 * @see backend/src/auth/firebase-admin.ts — sibling module owning Admin-SDK
 *      initialization. The two files together compose the auth layer.
 * @see backend/tests/integration/fixtures/firebase-user.ts — uses the same
 *      `'fake-api-key'` constant for emulator-targeted accounts:signUp /
 *      accounts:delete REST calls.
 * @see tickets/stories/ST-024-login-endpoint-session-token.md — login AC
 *      whose ST-024-AC2 ("session token issuance") this module enables.
 */

import type { SignInResult, SignInWithPasswordFn } from '../services/session.service';
import { requireEnv } from '../config/env';

// ---------------------------------------------------------------------------
// Section 1: Module-private constants
// ---------------------------------------------------------------------------

/**
 * The well-known Firebase Auth Emulator API key constant.
 *
 * The Firebase Auth Emulator accepts this value in lieu of a real Web API
 * Key. It carries NO production privileges and works ONLY against the
 * emulator. Hard-coding it here for the emulator path is safe because:
 *
 *   1. The value is documented public API of the Firebase Auth Emulator.
 *   2. The same string is used by `tests/integration/fixtures/firebase-user.ts`
 *      for matched emulator-targeted accounts:signUp / accounts:delete calls.
 *   3. Treating it as an env var would force every developer and CI run
 *      to set an effectively-public string, defeating the LocalGCP Rule's
 *      "zero live GCP credentials in tests or local dev" promise.
 *
 * If a future change ever made the emulator reject this constant (it
 * has not since the emulator was introduced), the FIX is in this single
 * module — the dozens of other call sites stay unchanged.
 */
const EMULATOR_API_KEY = 'fake-api-key';

/**
 * The production Firebase Auth REST API base URL.
 *
 * Path components are appended at call time. This constant exists so that
 * the host portion is set in ONE place — testability and audit clarity
 * both benefit. The trailing path-component layout `/v1/accounts:<verb>`
 * is the documented Firebase Auth REST API surface.
 */
const PRODUCTION_REST_BASE = 'https://identitytoolkit.googleapis.com';

/**
 * The Firebase Auth REST API path for the password-verification endpoint.
 *
 * Per the Firebase Auth REST API documentation, the canonical path is
 * `/v1/accounts:signInWithPassword?key=<API_KEY>`. The `?key=` query
 * parameter is appended at call time (not concatenated into this constant)
 * because the API-key string differs between emulator (`'fake-api-key'`)
 * and production (`FIREBASE_API_KEY`).
 */
const SIGN_IN_PATH = '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/**
 * Production version of {@link SIGN_IN_PATH} — the production REST API
 * mounts the resource directly at `/v1/...` (without the
 * `/identitytoolkit.googleapis.com` prefix that the emulator's
 * URL-path-namespacing requires).
 *
 * The emulator's URL layout is:
 *   `http://<host>/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
 * The production layout is:
 *   `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
 *
 * Same logical resource; different URL path layouts. Each constant is
 * named so the call site can pick the right one without conditional
 * surgery on the URL string.
 */
const PRODUCTION_SIGN_IN_PATH = '/v1/accounts:signInWithPassword';

// ---------------------------------------------------------------------------
// Section 2: Internal types — the wire-protocol shapes for the
// `accounts:signInWithPassword` REST call.
// ---------------------------------------------------------------------------

/**
 * Wire-protocol request body for `accounts:signInWithPassword`.
 *
 * `returnSecureToken: true` instructs Firebase to embed the idToken,
 * refreshToken, and `expiresIn` in the response. The default
 * (`returnSecureToken: false`) returns only the localId and is
 * unsuitable for session issuance.
 *
 * The shape follows Firebase's documented API verbatim — every field
 * is required and lowercase.
 */
interface SignInWithPasswordRequestBody {
  email: string;
  password: string;
  returnSecureToken: true;
}

/**
 * Wire-protocol response body for a SUCCESSFUL
 * `accounts:signInWithPassword` call.
 *
 * Fields used by this adapter:
 *   - `localId`     — the Firebase user ID (uid). Maps to {@link SignInResult.uid}.
 *   - `idToken`     — the Firebase JWT idToken. Maps to {@link SignInResult.idToken}.
 *   - `expiresIn`   — token lifetime as a numeric STRING (e.g. `"3600"`).
 *                     Maps to {@link SignInResult.expiresAt} via
 *                     `new Date(Date.now() + parseInt(expiresIn, 10) * 1000)`.
 *
 * Fields IGNORED by this adapter (present in Firebase's response but
 * deliberately not consumed):
 *   - `refreshToken` — the StrikeForge backend does NOT use refresh
 *                       tokens. Sessions are short-lived idToken
 *                       references with revocation managed via
 *                       `sessions.revoked_at`. Per AAP §0.2.1, the
 *                       sessions table is the single source of
 *                       revocation truth.
 *   - `email`        — already known to the caller; redundant here.
 *   - `kind`         — Firebase REST type discriminator; not used.
 *   - `displayName`  — present only when the user has set one;
 *                       irrelevant to login flow.
 *   - `registered`   — boolean indicating whether the email is
 *                       registered; not used (always true in a
 *                       successful response).
 *
 * The interface is `Partial<...>` only for the fields this adapter
 * IGNORES; the three fields the adapter consumes (`localId`, `idToken`,
 * `expiresIn`) are typed strictly so a TypeScript regression in
 * Firebase's response shape would surface at compile time.
 */
interface SignInWithPasswordResponseBody {
  localId: string;
  idToken: string;
  expiresIn: string;
  // Fields below are present but unused; documented for clarity.
  refreshToken?: string;
  email?: string;
  kind?: string;
  displayName?: string;
  registered?: boolean;
}

/**
 * Wire-protocol response body for a FAILED `accounts:signInWithPassword`
 * call. Firebase returns a non-2xx response with a JSON body of this
 * shape; the adapter parses it (best-effort) to surface a
 * non-credential-leaking error message.
 *
 * Common error codes (from Firebase docs):
 *   - `EMAIL_NOT_FOUND`            — no user with this email.
 *   - `INVALID_PASSWORD`           — wrong password.
 *   - `INVALID_LOGIN_CREDENTIALS`  — Firebase's combined error code (newer
 *                                     APIs collapse the two above).
 *   - `USER_DISABLED`              — account exists but is disabled.
 *   - `TOO_MANY_ATTEMPTS_TRY_LATER`— rate-limited.
 *
 * The `error.message` value is opaque to this adapter. The session
 * service catches every error this adapter throws and translates to
 * `UnauthenticatedError` regardless of the underlying cause, so the
 * HTTP-level response to the client never reveals which specific
 * failure mode produced the rejection (anti-enumeration posture from
 * AAP §0.2.1 / ST-024-AC4).
 */
interface SignInWithPasswordErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{
      message?: string;
      domain?: string;
      reason?: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Section 3: Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the emulator base URL given a non-empty
 * `FIREBASE_AUTH_EMULATOR_HOST` env var value.
 *
 * Behaviour:
 *   - If the input already starts with `http://` or `https://`, it is
 *     used verbatim.
 *   - Otherwise the function prepends `http://` (the emulator does NOT
 *     serve HTTPS, so plain HTTP is the correct scheme).
 *
 * Trailing slashes are stripped so that the path components appended by
 * the call site never produce double-slashes (`//v1/accounts:...`).
 *
 * Examples (input → output):
 *   - `"firebase-auth-emulator:9099"` → `"http://firebase-auth-emulator:9099"`
 *   - `"localhost:9099"`              → `"http://localhost:9099"`
 *   - `"http://localhost:9099"`       → `"http://localhost:9099"`
 *   - `"http://localhost:9099/"`      → `"http://localhost:9099"`
 *
 * The function is exported only for unit-test surface; production code
 * paths invoke it transitively via {@link createSignInWithPassword}.
 *
 * @param hostValue The non-empty `FIREBASE_AUTH_EMULATOR_HOST` value.
 * @returns A normalised, scheme-prefixed, trailing-slash-stripped base URL.
 */
function normaliseEmulatorBaseUrl(hostValue: string): string {
  // Strip surrounding whitespace; an env var like
  // ` firebase-auth-emulator:9099 ` (sometimes left after copy-paste)
  // would otherwise produce malformed URLs.
  const trimmed = hostValue.trim();

  // Compose with scheme. The Firebase Auth Emulator does NOT serve
  // HTTPS — plain HTTP is the only scheme it supports — so the
  // unconditional `http://` prefix is correct for the emulator path.
  // The startsWith() check is so an operator who DID set
  // `FIREBASE_AUTH_EMULATOR_HOST=http://localhost:9099` (full URL,
  // not just host:port) still gets a working configuration without a
  // doubled scheme.
  let withScheme: string;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    withScheme = trimmed;
  } else {
    withScheme = `http://${trimmed}`;
  }

  // Strip any trailing slash. The path constants are concatenated
  // raw (`baseUrl + path`), so a trailing slash here would produce
  // `http://host//identitytoolkit.googleapis.com/v1/...`.
  return withScheme.endsWith('/') ? withScheme.slice(0, -1) : withScheme;
}

/**
 * Reads the `FIREBASE_AUTH_EMULATOR_HOST` env var and returns the
 * trimmed value, or `null` if the env var is unset or empty.
 *
 * Why a helper rather than `process.env.FIREBASE_AUTH_EMULATOR_HOST`
 * inline: the empty-string-vs-undefined distinction matters here. An
 * empty `FIREBASE_AUTH_EMULATOR_HOST=""` means "no emulator" (the
 * standard convention in shell scripts), but `process.env.X === ''` is
 * truthy in TypeScript's `string | undefined` narrowing — without this
 * helper, an inline check would route to the emulator path with an
 * empty host string and produce a broken URL.
 *
 * @returns The non-empty trimmed host value, or null when unset/empty.
 */
function readEmulatorHost(): string | null {
  // Direct `process.env` read because `FIREBASE_AUTH_EMULATOR_HOST` is
  // INTENTIONALLY not in the REQUIRED_ENV_VARS list of `config/env.ts`
  // — it's optional (the production path leaves it unset). Calling
  // `requireEnv('FIREBASE_AUTH_EMULATOR_HOST')` would throw when the
  // env var is unset, defeating the whole point of the optional
  // production path.
  const raw = process.env['FIREBASE_AUTH_EMULATOR_HOST'];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Constructs the full sign-in URL, given an emulator-host value or null.
 *
 * Emulator path: `http://<host>/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`
 * Production:    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>`
 *
 * The API-key query parameter is non-credential metadata in the
 * emulator path (`fake-api-key`); in the production path it is the
 * caller's Firebase Web API Key (a public client-side key, not a
 * service-account secret). Both are URL-safe by construction (the
 * production key is a Google-issued alphanumeric string; the emulator
 * key is the literal `fake-api-key`), so no escaping is needed.
 *
 * @param emulatorHost The trimmed emulator host (e.g. "localhost:9099")
 *   or null if production.
 * @returns The fully-qualified sign-in URL with embedded API key.
 */
function buildSignInUrl(emulatorHost: string | null): string {
  if (emulatorHost !== null) {
    const baseUrl = normaliseEmulatorBaseUrl(emulatorHost);
    // Emulator path: `<baseUrl>/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`.
    // The double "identitytoolkit.googleapis.com" segment is
    // intentional — it's the emulator's URL-path namespacing, NOT a
    // bug. See `tests/integration/fixtures/firebase-user.ts` line 201
    // for the matching pattern in the test fixture.
    return `${baseUrl}${SIGN_IN_PATH}?key=${EMULATOR_API_KEY}`;
  }
  // Production path. `requireEnv` throws if FIREBASE_API_KEY is unset
  // (Rule R4 fail-fast).
  const apiKey = requireEnv('FIREBASE_API_KEY');
  return `${PRODUCTION_REST_BASE}${PRODUCTION_SIGN_IN_PATH}?key=${apiKey}`;
}

/**
 * Best-effort decoder for an error response body. Returns null if the
 * body cannot be JSON-parsed or does not match the documented shape.
 *
 * The function NEVER throws — error-handling code paths in the main
 * factory rely on this returning a sentinel rather than a thrown
 * exception, so the OUTER throw is the single error-emission point for
 * the adapter.
 *
 * @param raw The raw response text from a non-2xx Firebase REST response.
 * @returns The parsed error body, or null if parsing failed.
 */
function tryParseErrorBody(raw: string): SignInWithPasswordErrorBody | null {
  if (raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    return parsed as SignInWithPasswordErrorBody;
  } catch {
    // Invalid JSON — Firebase has been observed to return raw HTML in
    // some edge cases (e.g., gateway errors before the request reaches
    // Firebase). Returning null lets the caller emit a useful "non-
    // credential-bearing" error message without a parse-error chain.
    return null;
  }
}

/**
 * Extracts a non-credential-bearing summary string from a parsed
 * Firebase error body. Used to compose the thrown `Error.message`.
 *
 * If `body` is null or has no `error.message`, returns an empty string
 * (the caller composes a default fallback message in that case).
 *
 * Per Rule R2, this function NEVER inspects the original request body.
 * It uses ONLY the Firebase response message — which Firebase generates
 * from the auth-failure code (e.g. `INVALID_LOGIN_CREDENTIALS`) and
 * does not contain the password.
 *
 * @param body Parsed error body, possibly null.
 * @returns A short error summary, or empty string when none is available.
 */
function extractErrorMessage(body: SignInWithPasswordErrorBody | null): string {
  if (body === null) {
    return '';
  }
  const errorObj = body.error;
  if (errorObj === undefined || errorObj === null) {
    return '';
  }
  const message = errorObj.message;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  return '';
}

/**
 * Validates that a parsed success response has the three fields the
 * adapter consumes (`localId`, `idToken`, `expiresIn`) and that each is
 * a non-empty string. Throws a generic Error if validation fails — the
 * service layer will translate to `UnauthenticatedError` regardless.
 *
 * The function is named for the contract it enforces, NOT the data
 * format: even if Firebase changed the field names in a future API
 * version, this function would (correctly) reject the new response and
 * surface it as an upstream error rather than crashing inside the
 * service.
 *
 * @param raw Parsed JSON object from the success response.
 * @returns The validated body, narrowed for downstream use.
 * @throws Error if any required field is missing or malformed.
 */
function assertSuccessBody(raw: unknown): SignInWithPasswordResponseBody {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('firebase signInWithPassword: success response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const localId = obj['localId'];
  const idToken = obj['idToken'];
  const expiresIn = obj['expiresIn'];
  if (typeof localId !== 'string' || localId.length === 0) {
    throw new Error('firebase signInWithPassword: response missing localId');
  }
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new Error('firebase signInWithPassword: response missing idToken');
  }
  if (typeof expiresIn !== 'string' || expiresIn.length === 0) {
    throw new Error('firebase signInWithPassword: response missing expiresIn');
  }
  return {
    localId,
    idToken,
    expiresIn,
  };
}

/**
 * Computes the absolute expiration timestamp from Firebase's `expiresIn`
 * (a numeric STRING in seconds, e.g. `"3600"`).
 *
 * Why parseInt rather than parseFloat: Firebase always returns whole
 * seconds; parseInt with radix 10 is the strictest accepted parse that
 * also tolerates a trailing-whitespace edge case some Firebase APIs
 * have exhibited.
 *
 * If the value cannot be parsed as a positive integer, the function
 * throws — callers translate that to a transport-layer failure.
 *
 * @param expiresIn Firebase's `expiresIn` field — a numeric string in seconds.
 * @returns A Date instance representing the absolute expiration moment.
 * @throws Error if expiresIn cannot be parsed as a positive integer.
 */
function computeExpiresAt(expiresIn: string): Date {
  const seconds = parseInt(expiresIn, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `firebase signInWithPassword: invalid expiresIn "${expiresIn}"`,
    );
  }
  return new Date(Date.now() + seconds * 1000);
}

// ---------------------------------------------------------------------------
// Section 4: Public factory
// ---------------------------------------------------------------------------

/**
 * Creates the {@link SignInWithPasswordFn} implementation for production
 * composition. The returned function exchanges email+password
 * credentials for a Firebase idToken via the
 * `accounts:signInWithPassword` REST endpoint, auto-detecting the
 * Firebase Auth Emulator when `FIREBASE_AUTH_EMULATOR_HOST` is set.
 *
 * The factory does NOT eagerly resolve the URL or read
 * `FIREBASE_API_KEY` — both are read on every invocation of the
 * returned function. The reason is operational: an operator MAY toggle
 * `FIREBASE_AUTH_EMULATOR_HOST` between tests in the same process
 * without restarting the backend, and the adapter MUST honour the
 * latest env-var state. This matches the Firebase Admin SDK's lazy
 * env-var reading behaviour, keeping the two halves of the auth layer
 * (Admin SDK + REST adapter) consistent.
 *
 * Construction-time behaviour:
 *   - Performs NO env-var reads. The factory is safe to call before
 *     env-var validation completes (although the composition root
 *     does call `validateEnv()` first as belt-and-suspenders).
 *   - Performs NO HTTP calls. The factory is purely synchronous.
 *   - Returns a function whose closure captures NO mutable state. Each
 *     invocation reads env vars freshly.
 *
 * Returned-function behaviour:
 *   - Reads `FIREBASE_AUTH_EMULATOR_HOST` to decide emulator vs
 *     production routing.
 *   - In production mode, reads `FIREBASE_API_KEY` (or throws if
 *     absent — Rule R4 fail-fast).
 *   - Issues a POST to the resolved URL with body
 *     `{ email, password, returnSecureToken: true }`.
 *   - Decodes the response. On success, returns the
 *     {@link SignInResult}. On failure (non-2xx, network error, malformed
 *     response), throws a non-credential-bearing Error.
 *   - NEVER logs the password. NEVER includes the password in any
 *     thrown error message. The thrown Error's `.message` summarises
 *     what failed (HTTP status, Firebase error code if known) without
 *     mentioning the credential value.
 *
 * The session service translates EVERY error this adapter throws to
 * {@link import('../services/session.service').UnauthenticatedError},
 * so the eventual HTTP response to the client never reveals which
 * specific failure mode caused the rejection (anti-enumeration posture
 * from AAP §0.2.1 / ST-024-AC4).
 *
 * @returns A {@link SignInWithPasswordFn} implementation.
 *
 * @example
 * ```ts
 * // backend/src/index.ts (excerpt)
 * import { createSignInWithPassword } from './auth/firebase-rest';
 * const signInWithPassword = createSignInWithPassword();
 * // ... later ...
 * const result = await signInWithPassword({ email, password });
 * // result: { idToken: '...', uid: '...', expiresAt: Date }
 * ```
 */
export function createSignInWithPassword(): SignInWithPasswordFn {
  return async function signInWithPassword(params: {
    email: string;
    password: string;
  }): Promise<SignInResult> {
    // Defensive structural check. The session service's `login` flow
    // already validates non-empty email and password before invoking
    // the adapter, so reaching this branch indicates a programming
    // error in a future caller. The check is cheap and cannot leak
    // credentials (the thrown Error is consumed by the service-layer
    // try/catch and translated to UnauthenticatedError).
    if (typeof params.email !== 'string' || params.email.length === 0) {
      throw new Error('firebase signInWithPassword: email must be a non-empty string');
    }
    if (typeof params.password !== 'string' || params.password.length === 0) {
      throw new Error('firebase signInWithPassword: password must be a non-empty string');
    }

    // Resolve the URL on every call (intentional — see factory
    // docblock). `buildSignInUrl` reads the env vars internally.
    const emulatorHost = readEmulatorHost();
    const url = buildSignInUrl(emulatorHost);

    // Compose the request body. We use a strongly-typed local
    // declaration so a future schema change is caught at compile
    // time. The trailing `returnSecureToken: true` is required
    // (Firebase's default `false` returns only `localId`, which is
    // useless for session issuance).
    const requestBody: SignInWithPasswordRequestBody = {
      email: params.email,
      password: params.password,
      returnSecureToken: true,
    };

    // Issue the REST call via Node 20 LTS's native global `fetch`.
    //
    // Telemetry attaches transparently:
    //   - OTel undici instrumentation produces an outbound HTTP span
    //     and attaches `traceparent` (Rule R6 / C4).
    //   - The correlation-ID middleware's `globalThis.fetch` wrapper
    //     attaches `x-correlation-id` from the active ALS context
    //     (Rule C5). The wrapper is installed at module load time in
    //     `backend/src/middleware/correlation.ts` and is what closes
    //     the QA Final F Issue #1 gap (a prior version relied on the
    //     http/https patches alone, which do NOT cover fetch because
    //     Node 20 LTS's global fetch is built on undici and bypasses
    //     `node:http` / `node:https` entirely).
    //
    // The try/catch wrapper covers ONLY transport-layer failures
    // (DNS, TCP reset, TLS error, etc.). HTTP-status failures (non-
    // 2xx) are NOT thrown by `fetch` — they are inspected via
    // `response.ok` below.
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      // Translate transport-layer failures to a generic, non-
      // credential-bearing Error. We deliberately do NOT include
      // the err.cause chain or stack here — the session service
      // logs error metadata via its own pino-redacted logger; this
      // adapter's only job is to surface a thrown Error.
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new Error(
        `firebase signInWithPassword: transport error (${reason})`,
      );
    }

    // Read the response body as text first; we will parse it as JSON
    // ourselves (rather than `response.json()`) so that a non-JSON
    // body — which Firebase has been observed to return on rare
    // gateway-layer errors — does not produce a confusing
    // "SyntaxError" rather than the more useful "non-2xx response"
    // diagnosis.
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new Error(
        `firebase signInWithPassword: failed to read response body (${reason})`,
      );
    }

    // Non-2xx — failure path. We extract a Firebase error code/
    // message if the body is parseable JSON, otherwise we surface the
    // HTTP status only.
    if (!response.ok) {
      const parsed = tryParseErrorBody(responseText);
      const upstreamMsg = extractErrorMessage(parsed);
      const statusSegment = `HTTP ${response.status}`;
      const messageSegment = upstreamMsg.length > 0 ? `: ${upstreamMsg}` : '';
      throw new Error(
        `firebase signInWithPassword: ${statusSegment}${messageSegment}`,
      );
    }

    // 2xx — success path. Parse the body, validate the three
    // required fields, and compose the SignInResult.
    let parsedSuccess: unknown;
    try {
      parsedSuccess = JSON.parse(responseText);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new Error(
        `firebase signInWithPassword: response body is not valid JSON (${reason})`,
      );
    }

    const validated = assertSuccessBody(parsedSuccess);

    return {
      idToken: validated.idToken,
      uid: validated.localId,
      expiresAt: computeExpiresAt(validated.expiresIn),
    };
  };
}
