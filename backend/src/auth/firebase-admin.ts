/**
 * Firebase Admin SDK initialization — the SOLE module that initializes
 * the Firebase Admin SDK for the StrikeForge backend.
 *
 * Per Rule R3 / Constraint C2 (AAP §0.8.1):
 *   - Token validation MUST call `admin.auth().verifyIdToken()` exclusively.
 *   - NO custom JWT parsing, signature verification, expiry checking, or
 *     JWKS fetching anywhere in this file.
 *   - NO imports from `jsonwebtoken`, `jose`, `jwt-decode`, or any other
 *     JWT library. The Firebase Admin SDK is the single auth primitive.
 *
 * Per the LocalGCP Verification Rule (AAP §0.8.2):
 *   - When the env var `FIREBASE_AUTH_EMULATOR_HOST` is set (e.g.
 *     `firebase-auth-emulator:9099` inside Docker Compose, `localhost:9099`
 *     for host-networking profiles), the Firebase Admin SDK auto-detects
 *     the emulator and routes EVERY `verifyIdToken()` call there.
 *     No explicit emulator configuration is needed in this file — the
 *     same code path runs in local dev, CI, and production.
 *   - In production, the env var is unset; the SDK uses real Firebase Auth
 *     via the workload identity of the Cloud Run service account
 *     (resolved by `admin.credential.applicationDefault()`).
 *
 * Per AAP §0.3.3 / §0.6.4: this file's responsibility is INITIALIZATION
 * ONLY. Token verification lives in `services/session.service.ts`, which
 * receives the `Auth` instance via dependency injection and calls
 * `verifyIdToken()` directly. Keeping this file thin makes Rule R3
 * verifiable by direct inspection — the only Firebase SDK methods this
 * file references are `admin.initializeApp()`, `admin.auth()`, and
 * `admin.credential.applicationDefault()`.
 *
 * Composition root ordering (from `backend/src/index.ts`):
 *   1. `import './tracing'`               (Rule R6 / C4 — auto-instrumentations)
 *   2. `validateEnv()`                     (Rule R4 — fail-fast env vars)
 *   3. `initializePool()`                  (database first; no auth dep)
 *   4. `initializeFirebaseAdmin()`         <-- THIS FILE
 *   5. services/* and routes/*             (consume the Auth instance)
 *
 * Forbidden patterns (per AAP Phase 9):
 *   - DO NOT export `verifyIdToken` as a wrapper here. Verification lives
 *     exactly once in `services/session.service.ts`; introducing a wrapper
 *     would duplicate Rule R3's enforcement surface.
 *   - DO NOT export the `admin` namespace. Doing so leaks the SDK
 *     surface into every consumer; the `FirebaseAuth` and `DecodedIdToken`
 *     re-exports are the public type contract.
 *   - DO NOT hard-code `admin.credential.cert(serviceAccount)` or any
 *     other credential helper. `applicationDefault()` is the canonical
 *     production-and-emulator-safe credential.
 *   - DO NOT add `pino` or `@opentelemetry/api` imports. This module
 *     sits below the correlation-ID middleware (any logging here would
 *     emit records without a correlation ID, violating C5) and OTel
 *     auto-instrumentation already covers the SDK's outbound HTTP calls
 *     (manual instrumentation would produce duplicate spans, violating
 *     C4).
 *
 * @see backend/src/config/env.ts — supplies `requireEnv('FIREBASE_PROJECT_ID')`
 * @see backend/src/services/session.service.ts — sole consumer; calls `verifyIdToken`
 * @see tickets/stories/ST-023-user-registration-endpoint.md — registration AC
 * @see tickets/stories/ST-024-login-endpoint-session-token.md — login AC
 * @see tickets/stories/ST-025-logout-endpoint-session-revocation.md — revocation AC
 * @see tickets/stories/ST-026-session-validation-middleware-contract.md — middleware AC
 */

import admin from 'firebase-admin';
import type { DecodedIdToken as FirebaseDecodedIdToken } from 'firebase-admin/auth';

import { requireEnv } from '../config/env';

// ---------------------------------------------------------------------------
// Module-level singleton state.
// ---------------------------------------------------------------------------
//
// The Firebase Admin SDK can only be initialized ONCE per Node.js process.
// A second `admin.initializeApp()` call with no `name` argument throws:
//   FirebaseAppError: Firebase app named '[DEFAULT]' already exists.
// The two flags below make `initializeFirebaseAdmin()` idempotent so that
// (a) tests can call the initializer multiple times without manually
// resetting module state, and (b) any accidental double-call from the
// composition root is silently safe rather than fatal.
//
// Scope: per Node.js process, governed by the CommonJS require cache.
// Under `jest.resetModules()` in unit tests, each test re-loads this
// module with FRESH state — that is the documented mechanism by which
// the idempotency assertions in `firebase-admin.test.ts` pass.
//
// `authInstance` retains a non-null reference once initialization has
// completed. The two-flag approach (`initialized` + `authInstance !==
// null`) is intentional: it gives TypeScript an explicit narrowing path
// for the `admin.auth.Auth | null` return type and matches the
// belt-and-suspenders pattern used throughout the StrikeForge backend.
// ---------------------------------------------------------------------------

let initialized = false;
let authInstance: admin.auth.Auth | null = null;

/**
 * Initializes the Firebase Admin SDK once per Node.js process and returns
 * the `Auth` instance. Subsequent calls return the cached instance without
 * re-initializing the SDK.
 *
 * The function is the SOLE entry point through which the rest of the
 * backend obtains a handle to `admin.auth().verifyIdToken()`. Per Rule R3
 * (AAP §0.8.1) this is the only token-validation primitive permitted in
 * the codebase; per Constraint C2 (AAP §0.8.1) every authenticated route
 * MUST go through `admin.auth().verifyIdToken(rawBearerToken)` and
 * nothing else.
 *
 * Behaviour contract:
 *
 *   - On the FIRST call:
 *       * Reads `FIREBASE_PROJECT_ID` via {@link requireEnv} (Rule R4).
 *       * Calls `admin.initializeApp({ projectId, credential })` exactly
 *         once, with credentials resolved from
 *         `admin.credential.applicationDefault()`.
 *       * Captures and caches the result of `admin.auth()`.
 *       * Returns the cached `Auth` instance.
 *
 *   - On EVERY SUBSEQUENT call:
 *       * Returns the cached `Auth` instance without reading the env or
 *         touching the SDK. This is the idempotency contract that makes
 *         the function safe to invoke from tests, from the bootstrap
 *         module, and from any future composition root.
 *
 *   - On FAILURE (env var missing or empty):
 *       * `requireEnv('FIREBASE_PROJECT_ID')` throws
 *         {@link import('../config/env').MissingEnvVarError}. The
 *         module-level `initialized` flag remains `false` so a
 *         subsequent call (e.g. after the operator sets the env var)
 *         can complete successfully. This is meaningful in test
 *         scenarios where `process.env` is mutated between assertions.
 *
 * Local/CI emulator routing:
 *   When `FIREBASE_AUTH_EMULATOR_HOST` is set, the Firebase Admin SDK
 *   AUTOMATICALLY routes every `verifyIdToken()` call to the named
 *   emulator. No `if (isEmulator) { ... } else { ... }` branching is
 *   necessary — the SDK reads the env var lazily on each token-
 *   verification call. This is the LocalGCP Rule's primary delivery
 *   surface for the auth subsystem: zero live GCP credentials required.
 *
 * Production credentials:
 *   `admin.credential.applicationDefault()` resolves, in order, to:
 *     1. `GOOGLE_APPLICATION_CREDENTIALS` (a service-account JSON file
 *         path) when set;
 *     2. The workload identity of the Cloud Run service account when
 *         the process runs on Cloud Run;
 *     3. A benign no-op when `FIREBASE_AUTH_EMULATOR_HOST` is set,
 *         because the emulator ignores credentials entirely.
 *   This three-tier resolution is why we DO NOT hard-code a service
 *   account JSON path in source code — doing so would break two of the
 *   three deployment targets and would also embed credentials in the
 *   repository, violating both production-deployment conventions and
 *   the LocalGCP Verification Rule.
 *
 * @returns The `admin.auth.Auth` instance, exposing `verifyIdToken()`,
 *   `getUser()`, `createUser()`, `revokeRefreshTokens()`, etc. The
 *   instance is shared across the process; do NOT mutate it.
 *
 * @throws {import('../config/env').MissingEnvVarError} When
 *   `FIREBASE_PROJECT_ID` is undefined or an empty string. The
 *   thrown error's `variableName` field equals `'FIREBASE_PROJECT_ID'`
 *   so the bootstrap error handler can identify the offending var.
 *
 * @example
 * ```ts
 * // backend/src/index.ts — composition root (excerpt)
 * import { initializeFirebaseAdmin } from './auth/firebase-admin';
 * const firebaseAuth = initializeFirebaseAdmin();
 * const sessionService = createSessionService({ firebaseAuth, ... });
 * ```
 */
export function initializeFirebaseAdmin(): admin.auth.Auth {
  // Idempotency guard. The double check (`initialized && authInstance
  // !== null`) is intentional: it gives TypeScript an explicit
  // narrowing path so the early `return authInstance` is type-safe
  // under `strictNullChecks: true`. In practice both flags should be
  // in lockstep, but checking both is the belt-and-suspenders pattern
  // applied throughout the StrikeForge backend.
  if (initialized && authInstance !== null) {
    return authInstance;
  }

  // Read FIREBASE_PROJECT_ID FIRST — before any SDK side effect. If
  // the env var is missing, `requireEnv` throws a `MissingEnvVarError`
  // (Rule R4) and the module-level state stays `initialized = false`,
  // so a subsequent call (e.g. after the operator sets the env var or
  // after a test sets `process.env.FIREBASE_PROJECT_ID = '...'`) can
  // succeed without manual module reset.
  const projectId = requireEnv('FIREBASE_PROJECT_ID');

  // Initialize the SDK exactly once. The two-property options object
  // is the minimum viable configuration:
  //
  //   - `projectId`: required so the SDK knows which Firebase project
  //     to authenticate against. The emulator also reads this value to
  //     scope users.
  //
  //   - `credential: admin.credential.applicationDefault()`: the
  //     canonical credential resolver that works in local/emulator
  //     mode (ignored), local-with-real-Firebase mode (reads
  //     `GOOGLE_APPLICATION_CREDENTIALS`), and Cloud Run production
  //     (workload identity). DO NOT replace with `admin.credential.cert(...)`
  //     or any other helper — that would break at least one of those
  //     three modes.
  //
  // Any other configuration field (databaseURL, storageBucket, etc.)
  // is intentionally omitted: this backend uses GCS via a separate
  // SDK (`@google-cloud/storage`) and does not use Firestore /
  // Realtime Database, so no additional Firebase services need to be
  // wired here.
  admin.initializeApp({
    projectId,
    credential: admin.credential.applicationDefault(),
  });

  // Capture the `Auth` instance ONCE. `admin.auth()` is documented to
  // return the same singleton across calls, but caching the reference
  // here saves a tiny amount of work on every subsequent
  // `initializeFirebaseAdmin()` invocation and — more importantly —
  // makes the module's behavioural contract self-evident: a single
  // `Auth` instance is created and returned, period.
  authInstance = admin.auth();
  initialized = true;
  return authInstance;
}

// ---------------------------------------------------------------------------
// Public type re-exports.
// ---------------------------------------------------------------------------
//
// These two type aliases form the public type contract of this module.
// Downstream consumers (`services/session.service.ts`,
// `middleware/session.ts`, etc.) should import them from THIS file —
// not from `firebase-admin` directly — so that the `admin.` namespace
// stays contained in this single module.
//
// If the Firebase Admin SDK's published types change in a future major
// version, the aliases below are the SINGLE update point: every
// downstream `firebaseAuth: FirebaseAuth` annotation continues to
// compile without modification.

/**
 * Stable type alias for the Firebase Admin SDK `Auth` instance.
 *
 * Use `FirebaseAuth` in dependency-injection signatures so that the
 * `admin.auth.Auth` namespace path stays contained to this module. For
 * example, `services/session.service.ts` declares:
 *
 * ```ts
 * import type { FirebaseAuth } from '../auth/firebase-admin';
 * export interface SessionServiceDeps {
 *   firebaseAuth: FirebaseAuth;
 *   // ...
 * }
 * ```
 *
 * Without this alias, every consumer would either need to import
 * `firebase-admin` themselves (multiplying the Rule R3 verification
 * surface) or use the awkward `admin.auth.Auth` namespace path.
 */
export type FirebaseAuth = admin.auth.Auth;

/**
 * Re-export of the Firebase Admin SDK's `DecodedIdToken` type — the
 * shape of the value returned by `firebaseAuth.verifyIdToken(...)`.
 *
 * Re-exporting here means `services/session.service.ts` can write:
 *
 * ```ts
 * import type { DecodedIdToken, FirebaseAuth } from '../auth/firebase-admin';
 * ```
 *
 * with a single import statement, instead of a second import from
 * `firebase-admin/auth`. This centralises the SDK type surface in this
 * module and reduces the number of files that reference the
 * `firebase-admin` package directly (which is also a Rule R3
 * verification convenience).
 */
export type DecodedIdToken = FirebaseDecodedIdToken;
