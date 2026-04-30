/**
 * `firebase-user.ts` — Firebase Auth Emulator user factory.
 *
 * SOLE abstraction for integration tests that need an authenticated user
 * with a real Firebase Auth Emulator-issued idToken. The returned idToken
 * is a real emulator-issued JWT accepted by the backend's
 * `admin.auth().verifyIdToken()` middleware (Rule R3 compliance).
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - AAP §0.5.4: Firebase Auth Emulator at `localhost:9099` reached via
 *     `FIREBASE_AUTH_EMULATOR_HOST`.
 *   - Story ST-023: Register a New User via Registration Endpoint — protected
 *     endpoints downstream of registration require an authenticated idToken.
 *   - Story ST-024: Issue Session Token on Successful Login — login responses
 *     and the subsequent use of the returned token MUST NOT echo credential
 *     material in any form (consumed by Rule R2 below).
 *   - Story ST-026: Enforce Session Validation Contract on Protected
 *     Endpoints — integration tests of protected endpoints obtain idTokens
 *     via this factory.
 *   - Story ST-044: Define and Maintain Integration Test Suite for Service
 *     Interactions — deterministic fixtures, run-anywhere semantics, and
 *     self-cleaning resources (LocalGCP Rule below).
 *   - Folder requirement (`backend/tests/integration/fixtures/`):
 *     "firebase-user.ts — Firebase Emulator user factory (Rule R3 compliance)".
 *
 * ============================================================================
 * Rule Compliance
 * ============================================================================
 *   - Rule R2 (no credential material in logs): The `TestUser` interface has
 *     NO `password` field. The fixed emulator-only password is a module-private
 *     constant — it is NEVER returned, NEVER logged, and NEVER serialized.
 *     Error messages emitted from non-2xx responses redact any
 *     `"password":"..."` substring defensively. The returned idToken is
 *     intentionally part of the public contract (callers must include it in
 *     `Authorization: Bearer <idToken>` headers); the rule prohibits LOGGING
 *     credentials, not RETURNING them.
 *   - Rule R3 (Firebase Admin SDK only): This file uses NO `jsonwebtoken`,
 *     NO `jose`, NO `jwt-decode`, and NO `firebase-admin`. Token minting is
 *     delegated entirely to the emulator's public Identity Toolkit REST API
 *     (the same surface the Admin SDK calls under the hood). Token validation
 *     happens elsewhere (`backend/src/auth/firebase-admin.ts`) via
 *     `admin.auth().verifyIdToken()`.
 *   - Rule R4 (no env defaults in source): `FIREBASE_PROJECT_ID` is required
 *     and the helper throws if unset. `FIREBASE_AUTH_EMULATOR_HOST` is
 *     intentionally NOT one of the six required env vars (Rule R4 governs
 *     only those six); when unset it defaults to `localhost:9099` with a
 *     one-time warning so operators notice the missing emulator config.
 *   - Rule R6 / C4 (OTel registration order): No OTel imports. OpenTelemetry
 *     is initialized by `tests/integration/setup/register-tracing.ts` BEFORE
 *     this file is ever loaded by any test worker — outbound `fetch` calls
 *     made here are transparently auto-instrumented.
 *   - Rule R8 (fail closed): Every error path (network failure, non-2xx
 *     response, malformed JSON, missing required fields) throws a descriptive
 *     `Error`. There is NO silent fallback. The lone exception is the
 *     best-effort tracking-file append in `createTestUser` — failure to
 *     record the user for teardown emits a `console.warn` but does not
 *     abort the user creation, because the user has already been created
 *     successfully and the test should proceed.
 *   - Rule R9 (no payment processing): N/A — no payment surface touched.
 *   - LocalGCP Verification Rule (AAP §0.8.2): integration tests create
 *     their own resources and clean up. This factory writes a JSONL record
 *     for every created user to `/tmp/strikeforge-test-users.json` so
 *     `global-teardown.ts` can sweep them all at run end. Per-test
 *     `afterEach(() => deleteTestUser(user.uid))` is the fast-path
 *     optimization; teardown is the safety net.
 *
 * ============================================================================
 * Cross-Process State Sharing
 * ============================================================================
 *   - `tests/integration/setup/global-setup.ts` (separate process)
 *     initializes `/tmp/strikeforge-test-users.json` as an empty file so
 *     this fixture's first append does not fail with `ENOENT`.
 *   - This factory (running in test workers) APPENDS JSONL records of the
 *     shape `{"uid":"<localId>","email":"<email>","localId":"<localId>"}\n`
 *     to that file. The duplicate `localId` field exists for symmetry with
 *     the emulator's response payload and historic teardown parsers.
 *   - `tests/integration/setup/global-teardown.ts` (separate process)
 *     reads each line, parses the JSON, and POSTs against the emulator's
 *     Identity Toolkit `accounts:delete` admin endpoint. The teardown's
 *     parser keys off the `uid` field — every record this fixture writes
 *     MUST contain a non-empty `uid` string, which is enforced by the
 *     response-shape validation below (typeof check on `localId`).
 *
 * ============================================================================
 * Endpoint Choices (Empirical, Not AAP-Literal)
 * ============================================================================
 *   - SIGN-UP (used by `createTestUser`):
 *       POST `{HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=<key>`
 *       Headers: `Content-Type: application/json`
 *       Body:    `{"email":"...","password":"...","returnSecureToken":true}`
 *     This is the canonical Identity Toolkit signup endpoint exposed by
 *     real Firebase Auth and identically by the emulator. The `key`
 *     query parameter is required by the SDK contract; the emulator
 *     accepts any non-empty value (we use `fake-api-key` by convention).
 *
 *   - DELETE (used by `deleteTestUser`):
 *       POST `{HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT_ID}/accounts:delete`
 *       Headers: `Authorization: Bearer owner`, `Content-Type: application/json`
 *       Body:    `{"localId":"<uid>"}`
 *     This deviates from the AAP-prompted `DELETE /emulator/v1/projects/{p}/accounts/{uid}`
 *     URL because the AAP-prompted URL does NOT exist in the emulator and
 *     returns HTTP 404 for every call regardless of UID. The
 *     `accounts:delete` admin endpoint is the canonical mechanism — it is
 *     the same surface that `firebase-admin`'s `auth().deleteUser(uid)`
 *     calls under the hood. The literal string `Bearer owner` is the
 *     documented emulator-only short-circuit token; it is NOT a real
 *     credential and never reaches a live GCP API. The deviation rationale
 *     is recorded canonically in `docs/decisions/README.md` ("global-teardown.ts
 *     deletes Firebase Auth emulator users via the Identity Toolkit
 *     projects.accounts.delete admin endpoint…"), and the same reasoning
 *     applies here.
 *     Idempotency mapping under the working endpoint:
 *       - HTTP 200 OK                          → success (deleted).
 *       - HTTP 400 with body "USER_NOT_FOUND"  → success (already gone).
 *       - HTTP 404 (defensive)                 → success (treated idempotently).
 *       - Any other status                     → throw with descriptive error.
 *
 * ============================================================================
 * Forbidden Patterns (Documented for Reviewers)
 * ============================================================================
 *   - DO NOT import `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`.
 *     Token issuance is delegated to the emulator REST API; token validation
 *     lives in the production auth middleware.
 *   - DO NOT add a `password` field to the `TestUser` interface.
 *     Callers never need it; exposing it risks accidental logging.
 *   - DO NOT log the `idToken` or any `Authorization` header value.
 *     Bearer tokens are credential material under Rule R2.
 *   - DO NOT use synchronous file I/O (`fs.appendFileSync`).
 *     Async I/O composes cleanly with Jest's async lifecycle.
 *   - DO NOT swallow errors from `createTestUser`'s signup POST.
 *     Tests that depend on auth MUST fail hard when the emulator is
 *     unreachable so the failure is actionable, not silent.
 *   - DO NOT cache the emulator base URL at module load time. Read env
 *     vars per-call so a future test that mutates them (e.g. to test
 *     wiring) sees the change.
 *   - DO NOT share the same email across calls. Each `createTestUser`
 *     MUST produce a unique email to prevent cross-test collision under
 *     any future increase of `maxWorkers` beyond 1.
 *   - DO NOT replace the `Bearer owner` literal with a real token or any
 *     env var. It is the emulator's documented short-circuit value and is
 *     stable across firebase-tools releases (verified empirically against
 *     the running emulator per `docs/decisions/README.md`).
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path of the cross-process JSONL tracking file appended to by this factory.
 *
 * Write contract:
 *   - `tests/integration/setup/global-setup.ts` initializes the file empty.
 *   - This factory APPENDS one JSON record per line, terminated by `\n`,
 *     of the shape `{"uid":"<localId>","email":"<email>","localId":"<localId>"}`.
 *   - `tests/integration/setup/global-teardown.ts` splits on `\n`, parses
 *     each non-empty line, and POSTs the corresponding `accounts:delete`.
 *
 * Why JSONL rather than a single JSON array:
 *   `fs.appendFile` is atomic for small writes on POSIX filesystems and
 *   crash-safe in the presence of mid-write failures (the worst case is
 *   losing the in-progress line, which the teardown parser tolerates by
 *   skipping malformed lines). A single JSON array would require
 *   read-modify-write on every appended user — fragile under crash and
 *   race-prone under any future parallelism.
 */
const TMP_USERS_FILE = '/tmp/strikeforge-test-users.json';

/**
 * Fixed emulator-only password used to drive the signup REST call.
 *
 * This password is NEVER real (the emulator does not validate password
 * strength against any production policy and does not persist between
 * runs), NEVER returned by `createTestUser` (Rule R2), and NEVER logged.
 * It is treated as an opaque internal constant: the only place it appears
 * is the body of the signUp POST, and the redaction regex in the error
 * branch defensively strips any `"password":"..."` substring should the
 * emulator ever echo the request body in an error response.
 *
 * Why a fixed value rather than `randomUUID()`:
 *   The emulator accepts the same password for every user in a run, and
 *   randomization adds no security benefit in emulator-land — only
 *   complications for debugging and a slight increase in factory call
 *   latency. The fixed string also satisfies the emulator's rudimentary
 *   "minimum 6 characters" check that some firebase-tools releases enforce.
 */
const EMULATOR_ONLY_PASSWORD = 'TestPassword123!';

/**
 * Conventional API key value. The Firebase Auth emulator does NOT validate
 * API keys — any non-empty value works — so we use the documented
 * `fake-api-key` placeholder that signals to readers that this is
 * emulator-only configuration. Production code paths would use a real
 * Firebase Web API key obtained from the Firebase console.
 */
const EMULATOR_API_KEY = 'fake-api-key';

/**
 * Default emulator base URL when `FIREBASE_AUTH_EMULATOR_HOST` is unset.
 * Matches the canonical port emitted by `firebase emulators:start` and
 * the value used by `docker-compose.yml`'s `firebase-auth-emulator`
 * service. Defaulting here is safe because `FIREBASE_AUTH_EMULATOR_HOST`
 * is intentionally NOT one of the six required env vars (Rule R4 governs
 * only those six).
 */
const DEFAULT_EMULATOR_BASE_URL = 'http://localhost:9099';

/**
 * Documented emulator-only short-circuit token accepted by the Firebase
 * Auth emulator's privileged admin endpoints (e.g. `accounts:delete`).
 * It is NOT a real credential — never reaches a live GCP API and would
 * fail authentication if it ever did. See `docs/decisions/README.md`
 * for the canonical "why" record.
 */
const EMULATOR_ADMIN_BEARER = 'Bearer owner';

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * A test user created in the Firebase Auth emulator.
 *
 * The `idToken` is a real emulator-issued JWT accepted by the backend's
 * `admin.auth().verifyIdToken()` middleware (Rule R3 compliance). The
 * interface intentionally has NO `password` field — Rule R2.
 *
 * Callers SHOULD pair `createTestUser` with `deleteTestUser` in
 * `beforeEach`/`afterEach` lifecycle hooks for fast cleanup feedback;
 * `global-teardown.ts` runs as a safety net at run end.
 */
export interface TestUser {
  /** Firebase local ID, aka uid — the stable server-assigned identifier. */
  uid: string;
  /** The unique `test-<uuid>@example.com` email used during signup. */
  email: string;
  /** The emulator-issued idToken; pass as `Authorization: Bearer <idToken>`. */
  idToken: string;
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Module-level flag preventing the missing-emulator-host warning from
 * being emitted on every factory call. One warning per process is
 * sufficient — additional emissions only add noise to test output.
 *
 * Module-level `let` is used in preference to a function-property
 * trick (which would require a `declare namespace` block) for clarity.
 */
let _emulatorWarnEmitted = false;

/**
 * Resolve the Firebase Auth emulator base URL from
 * `FIREBASE_AUTH_EMULATOR_HOST`.
 *
 * Accepted values:
 *   - "localhost:9099"        → "http://localhost:9099"
 *   - "127.0.0.1:9099"        → "http://127.0.0.1:9099"
 *   - "http://localhost:9099" → "http://localhost:9099" (preserved)
 *   - "https://..."           → preserved
 *   - undefined / ""          → `DEFAULT_EMULATOR_BASE_URL` with a one-time warning
 *
 * Read per-call (no caching) so a future test that mutates the env var
 * to verify wiring sees the change. The cost is negligible (one
 * `process.env` lookup, no I/O).
 */
function resolveEmulatorBaseUrl(): string {
  const raw = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (raw === undefined || raw === '') {
    if (!_emulatorWarnEmitted) {
      // eslint-disable-next-line no-console
      console.warn(
        '[firebase-user] FIREBASE_AUTH_EMULATOR_HOST is unset; ' +
          `defaulting to ${DEFAULT_EMULATOR_BASE_URL}.`,
      );
      _emulatorWarnEmitted = true;
    }
    return DEFAULT_EMULATOR_BASE_URL;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return `http://${raw}`;
}

/**
 * Read `FIREBASE_PROJECT_ID` from the environment. Throws if unset —
 * this fixture cannot operate without it because the emulator's
 * Identity Toolkit `accounts:delete` admin endpoint requires the
 * project ID in the request path.
 *
 * By the time this fixture is called, `global-setup.ts` has already
 * validated all six required env vars (Rule R4) — the per-call check
 * here is defense in depth so that running an integration test in
 * isolation (without `globalSetup`) fails with a descriptive error
 * rather than a confusing emulator response.
 */
function requireProjectId(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (projectId === undefined || projectId === '') {
    throw new Error(
      '[firebase-user] FIREBASE_PROJECT_ID is not set. Per Rule R4, the six ' +
        'required env vars must be populated before integration tests run. ' +
        'Verify backend/.env.example, docker-compose.yml, and that ' +
        'jest.config.integration.ts wires the global-setup hook correctly.',
    );
  }
  return projectId;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Create a fresh test user in the Firebase Auth emulator and return a
 * real, emulator-issued idToken accepted by `admin.auth().verifyIdToken()`.
 *
 * Steps:
 *   1. Generate a unique `test-<uuidv4>@example.com` email.
 *   2. POST to the Identity Toolkit signUp endpoint:
 *      `{HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`
 *      with body `{ email, password, returnSecureToken: true }`.
 *   3. Validate the response shape and extract `localId` (uid) and `idToken`.
 *   4. APPEND a JSONL record to `/tmp/strikeforge-test-users.json` so
 *      `global-teardown.ts` can sweep this user at run end.
 *   5. Return `{ uid, email, idToken }`.
 *
 * Failure modes (Rule R8 fail-closed):
 *   - Network error reaching the emulator → throws naming the emulator URL.
 *   - Non-2xx HTTP response → throws including a redacted excerpt of the
 *     response body (no `"password":"..."` substrings, per Rule R2).
 *   - Response body is not JSON → throws naming the parse failure.
 *   - Response missing `localId` or `idToken` → throws naming the schema.
 *
 * Best-effort exception:
 *   - Failure to append the tracking record → `console.warn` and continue.
 *     The user has already been created successfully and the calling test
 *     can proceed; teardown will simply miss this one user, which is a
 *     tolerable cost for not failing the test for an orthogonal reason.
 *
 * @returns the created `TestUser`.
 */
export async function createTestUser(): Promise<TestUser> {
  const baseUrl = resolveEmulatorBaseUrl();
  const email = `test-${randomUUID()}@example.com`;

  const signUpUrl =
    `${baseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp` +
    `?key=${encodeURIComponent(EMULATOR_API_KEY)}`;

  let res: Response;
  try {
    res = await fetch(signUpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: EMULATOR_ONLY_PASSWORD,
        returnSecureToken: true,
      }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[firebase-user] Failed to reach Firebase Auth emulator at ${baseUrl}: ` +
        `${cause}. Verify the firebase-auth-emulator service is running ` +
        '(see `docker compose ps`).',
    );
  }

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '(unreadable body)';
    }
    // Rule R2: defensively strip any `"password":"..."` substring before
    // including the body in the error message. The emulator does NOT
    // normally echo request fields in error responses, but redacting here
    // is cheap and protects against future emulator versions that might.
    const redacted = bodyText.replace(
      /"password"\s*:\s*"[^"]*"/gi,
      '"password":"[redacted]"',
    );
    throw new Error(
      `[firebase-user] Signup failed: HTTP ${res.status} ${res.statusText}. ` +
        `Emulator response: ${redacted.slice(0, 500)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[firebase-user] Signup succeeded (HTTP ${res.status}) but response ` +
        `body was not JSON: ${cause}`,
    );
  }

  // Validate response shape. The emulator returns a payload containing
  // `localId`, `idToken`, `refreshToken`, `expiresIn`, `email`, `kind`.
  // We only consume `localId` and `idToken`; the rest is ignored.
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as { localId?: unknown }).localId !== 'string' ||
    (payload as { localId: string }).localId.length === 0 ||
    typeof (payload as { idToken?: unknown }).idToken !== 'string' ||
    (payload as { idToken: string }).idToken.length === 0
  ) {
    throw new Error(
      '[firebase-user] Signup response is missing required string fields ' +
        '`localId` and/or `idToken`. The emulator may be running an ' +
        'incompatible firebase-tools version.',
    );
  }

  const { localId, idToken } = payload as { localId: string; idToken: string };

  // Record the created user for teardown sweep. JSONL format — one JSON
  // object per line. The duplicated `localId` field exists for symmetry
  // with the emulator's response shape and historic teardown parsers
  // that may key off either name; the canonical teardown reads the `uid`
  // field per `tests/integration/setup/global-teardown.ts`.
  //
  // Best-effort: an append failure here does NOT fail the current test.
  // The user has been successfully created; the only consequence is
  // that teardown won't sweep this one user (manual cleanup is harmless
  // because the next run's `globalSetup` truncates the tracking file).
  const record = `${JSON.stringify({ uid: localId, email, localId })}\n`;
  try {
    await fs.appendFile(TMP_USERS_FILE, record, 'utf-8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[firebase-user] Created user ${localId} but failed to record it for ` +
        `teardown at ${TMP_USERS_FILE}: ${cause}. Manual cleanup may be needed ` +
        'if the test run is interrupted.',
    );
  }

  return { uid: localId, email, idToken };
}

/**
 * Delete a test user explicitly via the Firebase Auth emulator's Identity
 * Toolkit admin endpoint:
 *
 *   POST `{HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT_ID}/accounts:delete`
 *   Headers: `Authorization: Bearer owner`, `Content-Type: application/json`
 *   Body:    `{"localId":"<uid>"}`
 *
 * This deviates from the AAP-prompted `DELETE /emulator/v1/projects/{p}/accounts/{uid}`
 * URL because the AAP-prompted URL does not exist in the emulator and
 * returns HTTP 404 for every call regardless of UID. The decision log
 * (`docs/decisions/README.md`) records the empirical verification and
 * rationale; the same reasoning applies here as it does to
 * `tests/integration/setup/global-teardown.ts`.
 *
 * Idempotency mapping:
 *   - HTTP 200 OK                          → success (deleted).
 *   - HTTP 400 with body "USER_NOT_FOUND"  → success (already gone).
 *   - HTTP 404 (defensive)                 → success (treated idempotently).
 *   - Any other status                     → throw with descriptive error.
 *
 * Tests SHOULD call this in `afterEach` when the user was created in
 * `beforeEach` so transient state does not accumulate during long runs.
 * `global-teardown.ts` also sweeps all remaining users as a safety net.
 *
 * @param uid - the Firebase local ID returned by `createTestUser`.
 * @throws TypeError if `uid` is not a non-empty string.
 * @throws Error on network failure or unexpected HTTP status.
 */
export async function deleteTestUser(uid: string): Promise<void> {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new TypeError(
      '[firebase-user] deleteTestUser: uid must be a non-empty string.',
    );
  }

  const baseUrl = resolveEmulatorBaseUrl();
  const projectId = requireProjectId();

  const deleteUrl =
    `${baseUrl}/identitytoolkit.googleapis.com/v1/` +
    `projects/${encodeURIComponent(projectId)}/accounts:delete`;

  let res: Response;
  try {
    res = await fetch(deleteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: EMULATOR_ADMIN_BEARER,
      },
      body: JSON.stringify({ localId: uid }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[firebase-user] Failed to reach emulator for user deletion at ${baseUrl}: ` +
        `${cause}. Verify the firebase-auth-emulator service is running.`,
    );
  }

  // 2xx — canonical success. The user was deleted.
  if (res.ok) {
    // Drain the body to free the underlying socket; ignore any read error
    // since the verdict is already determined by the status code.
    await res.text().catch(() => '');
    return;
  }

  // 404 — defensive idempotent treatment. The configured admin endpoint
  // returns 400 USER_NOT_FOUND for missing users in firebase-tools 13.x,
  // but a future emulator release could plausibly switch to 404. Treating
  // 404 as success preserves idempotency without masking real failures.
  if (res.status === 404) {
    await res.text().catch(() => '');
    return;
  }

  // 400 — distinguish the idempotent USER_NOT_FOUND case from genuine
  // 400-class failures (e.g. MISSING_LOCAL_ID, INVALID_ID_TOKEN). Read
  // the body once and inspect it; defer the throw to a single call site.
  if (res.status === 400) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '(unreadable body)';
    }
    if (/USER_NOT_FOUND/.test(bodyText)) {
      // User was already gone — idempotent success.
      return;
    }
    throw new Error(
      `[firebase-user] Failed to delete test user ${uid}: ` +
        `HTTP 400 ${res.statusText}. Emulator response: ${bodyText.slice(0, 500)}`,
    );
  }

  // 401/403/5xx and any other unexpected status — surface a descriptive
  // error so operators can triage quickly. Per Rule R2 we do NOT log the
  // `Bearer owner` value (it is an emulator-only sentinel rather than
  // production credential material, but uniform redaction across envs
  // keeps logs simple to reason about).
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    bodyText = '(unreadable body)';
  }
  throw new Error(
    `[firebase-user] Failed to delete test user ${uid}: ` +
      `HTTP ${res.status} ${res.statusText}. ` +
      `Emulator response: ${bodyText.slice(0, 500)}`,
  );
}
