/**
 * GCS Service — the SOLE call site in the backend for `getSignedUrl`.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/services/gcs.service.ts | `@google-cloud/storage` v7
 *        wrapper; ALL `getSignedUrl` calls pass `version: 'v4'` per C1/R5."
 *   - §0.6.4 Track 1 Backend (T1-C):
 *       "CREATE | backend/src/services/gcs.service.ts |
 *        `@google-cloud/storage` v7; all `getSignedUrl` calls pass
 *        `version: 'v4'` per C1/R5."
 *   - §0.2.2 C1 (verbatim):
 *       "Every call site in `backend/src/**\/*.ts` that invokes
 *        `bucket.file(name).getSignedUrl` MUST pass an options object
 *        containing `version: 'v4', action: 'read', expires: Date.now() +
 *        15 * 60 * 1000`. The v7 SDK removed `getSignedUrl` from `File`
 *        instances without explicit `version`; omitting the `version` key
 *        throws at runtime."
 *   - §0.8.1 Rule R5 (verbatim):
 *       "Every call MUST use `bucket.file(name).getSignedUrl({ version:
 *        'v4', ... })`. MUST NOT call `.getSignedUrl()` without explicit
 *        `version`."
 *   - tickets/stories/ST-014-logo-upload-ui.md — frontend logo upload UI
 *     story whose backend contract requires signed-URL issuance for
 *     uploaded logo objects.
 *
 * Architectural invariant (Rule R5 / C1):
 *   Every invocation of `bucket.file(name).getSignedUrl` MUST pass
 *   `{ version: 'v4', action: <action>, expires: <ms epoch> }`.
 *   The v7 `@google-cloud/storage` SDK throws at runtime when `version`
 *   is omitted. Consolidating all signed-URL issuance here makes the
 *   rule trivially verifiable:
 *     `grep -rn "getSignedUrl" backend/src | grep -v gcs.service.ts | wc -l`
 *     MUST return 0.
 *
 * LocalGCP (user-provided LocalGCP Verification Rule):
 *   When `GCS_EMULATOR_HOST` is set, the Storage constructor is configured
 *   with `apiEndpoint: GCS_EMULATOR_HOST` so all requests route to the
 *   `fsouza/fake-gcs-server` instance declared in `docker-compose.yml`.
 *   Because `GCS_EMULATOR_HOST` is one of the six required env vars (Rule
 *   R4 — AAP §0.1.3), accessing `env.GCS_EMULATOR_HOST` always returns a
 *   non-empty string OR throws `MissingEnvVarError` at startup. The
 *   `length > 0` guard below is defensive: it ensures we never pass an
 *   empty `apiEndpoint` to the SDK even if a future refactor weakens the
 *   `env` accessor.
 *
 * Rule R2 (no credential material in logs):
 *   Signed URLs carry the `X-Goog-Signature` query parameter and are
 *   effectively bearer tokens for the underlying GCS object until they
 *   expire. Logging the URL is functionally equivalent to logging an
 *   API key. Logs in this module emit ONLY structural metadata
 *   (`event`, `bucket`, `objectKey`, `action`, `expiresAt`,
 *   `emulator` boolean) — NEVER the URL string itself, NEVER a slice
 *   of the URL, NEVER a hash of the URL. The structural fields are
 *   sufficient for incident-response correlation; the bearer material
 *   is suppressed entirely.
 *
 * Rule R8 (gates fail closed):
 *   SDK errors propagate to the caller. The Express error handler
 *   (`backend/src/index.ts`) translates them to HTTP responses. The
 *   `delete` operation tolerates 404 (object already absent) via the
 *   v7 SDK option `ignoreNotFound: true`, which expresses idempotent-
 *   delete intent at the SDK layer rather than via try/catch swallowing.
 *
 * Forbidden patterns (per AAP §0.2.2 C1, Rule R5, and Phase 9 of the
 * agent prompt):
 *   - `bucket.file(name).getSignedUrl({ action: 'read', expires: ... })`
 *     — missing `version: 'v4'` throws at runtime in v7.
 *   - `bucket.file(name).getSignedUrl({ version: 'v2', ... })` — v2 is
 *     deprecated by GCS; v4 is the only allowed value.
 *   - `logger.info({ url })` — `url` carries the `X-Goog-Signature`
 *     bearer credential (Rule R2 violation).
 *   - `logger.info({ urlPreview: url.slice(0, 100) })` — even a slice
 *     can leak signature material (Rule R2 violation).
 *   - Importing `@google-cloud/storage` from any other backend module —
 *     this file is the architectural funnel for GCS calls; ad-hoc
 *     imports defeat the Rule R5 grep verification.
 */

import { Storage, type StorageOptions } from '@google-cloud/storage';

import { env } from '../config/env';
import { logger } from '../logging/pino';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Read URL TTL in milliseconds.
 *
 * Per AAP §0.2.2 C1 (verbatim): "expires: Date.now() + 15 * 60 * 1000".
 * 15 minutes is the canonical window mandated by the rule. Reviewers
 * grep for `15 * 60 * 1000` to verify compliance; keeping the literal
 * expression intact below preserves that grep-ability.
 *
 * Exported so the routes layer can compute precise expiration timestamps
 * and so unit tests can assert that signed URLs have the documented TTL.
 */
export const READ_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Upload URL TTL in milliseconds.
 *
 * ST-014 (logo upload) does not constrain upload TTL specifically. We
 * match `READ_URL_TTL_MS` (15 minutes) to keep the bearer-credential
 * exposure window minimal and consistent across read and write
 * operations. A short window also constrains abuse: if an issued upload
 * URL leaks (e.g., via a misconfigured client log), the attacker has at
 * most 15 minutes to exercise it before it expires server-side.
 */
export const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

/**
 * Thrown by service methods when an input parameter fails validation.
 *
 * The route layer maps this to HTTP 400 ("Bad Request"). Carrying the
 * offending `field` and a stable machine-readable `code` lets callers
 * react programmatically (e.g., highlight a specific form field) without
 * resorting to substring matching on `message`.
 *
 * Pattern parity:
 *   This class is structurally identical to the `ValidationError`
 *   defined in `backend/src/services/session.service.ts`. Two parallel
 *   definitions are intentional — each service owns its own typed error
 *   class so that consumers can catch precisely the error variant from
 *   the service they invoked. A shared base class would couple unrelated
 *   services through a single error hierarchy and complicate future
 *   refactoring.
 *
 * Members (per the file's export schema):
 *   - `field`   parameter name that failed validation
 *   - `code`    machine-readable error code (default `'VALIDATION_FAILED'`)
 *   - `name`    discriminator string `'ValidationError'`
 *   - `message` human-readable description (inherited from `Error`)
 */
export class ValidationError extends Error {
  /**
   * Discriminator field. Override of `Error.name` so that
   * `err instanceof Error` is true while `err.name === 'ValidationError'`
   * lets a generic error handler distinguish validation failures
   * without an `instanceof` check (which is sometimes unreliable across
   * module-boundary realms in TypeScript).
   *
   * `override` is required because `Error.name` is declared on the
   * superclass; eliding it under `noImplicitOverride` (if ever enabled)
   * would surface as a compile error.
   */
  public override readonly name: string = 'ValidationError';

  /**
   * The parameter name that failed validation. For this service the
   * only validated parameter is `objectKey`, but the field is kept
   * configurable so future helpers (e.g., metadata validation) can
   * report on their own parameter names without defining new error
   * classes.
   */
  public readonly field: string;

  /**
   * Machine-readable error code. Defaults to `'VALIDATION_FAILED'`.
   * The route layer maps this to a stable HTTP error code body
   * field so frontends can render localized messages without parsing
   * server-side strings.
   */
  public readonly code: string;

  constructor(field: string, message: string, code = 'VALIDATION_FAILED') {
    super(message);
    this.field = field;
    this.code = code;
    // Preserve the prototype chain. Targeting ES2022 handles this
    // automatically, but the explicit call is essentially free and
    // makes `instanceof ValidationError` work even when the class is
    // accidentally transpiled to an older target by downstream
    // tooling (e.g., a test harness configured for ES5).
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates a GCS object key. Throws {@link ValidationError} when the
 * input is unsuitable for use as a GCS object name.
 *
 * Constraints enforced:
 *   1. The value MUST be a non-empty string. GCS rejects empty object
 *      names with an opaque API error; throwing earlier with a
 *      descriptive `field` and `message` is more actionable.
 *   2. The value MUST NOT contain ASCII control characters (U+0000 –
 *      U+001F). Control characters are permitted by the GCS object name
 *      grammar in some forms, but they are rarely intentional in this
 *      application's logo-upload context and they routinely break URL
 *      construction in proxies and CLIs. Rejecting them eagerly avoids
 *      a class of integration defects that surface only at preview
 *      time.
 *
 * Constraints intentionally NOT enforced here:
 *   - Length cap: GCS allows object names up to 1024 bytes after UTF-8
 *     encoding. Enforcing a tighter cap is a route-layer concern (the
 *     logo-upload endpoint may apply its own per-feature limit) and
 *     belongs in the request schema rather than this generic service.
 *   - Prefix / namespace rules: per-tenant or per-design prefixes
 *     (e.g., `users/${uid}/logos/${designId}.png`) are constructed by
 *     the caller and verified by the caller's own schema. Encoding
 *     those rules here would couple the service to the caller's
 *     directory convention.
 *
 * @param objectKey - The proposed GCS object key.
 * @throws {ValidationError} When `objectKey` is empty or contains
 *   ASCII control characters.
 */
function validateObjectKey(objectKey: string): void {
  if (typeof objectKey !== 'string' || objectKey.length === 0) {
    throw new ValidationError(
      'objectKey',
      'objectKey must be a non-empty string',
      'OBJECT_KEY_EMPTY',
    );
  }
  // Reject ASCII control characters (U+0000 – U+001F). The
  // `eslint-disable` comment is required because the regex literally
  // tests for control characters; the lint rule that flags
  // `no-control-regex` exists precisely for cases like this where
  // control characters in regexes are sometimes accidental, and the
  // explicit disable documents the intent.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(objectKey)) {
    throw new ValidationError(
      'objectKey',
      'objectKey contains control characters',
      'OBJECT_KEY_INVALID_CHARS',
    );
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a signed-URL issuance.
 *
 * Members (per the file's export schema):
 *   - `url`       The signed URL bearer string. Carries the
 *                 `X-Goog-Signature` query parameter; treat as
 *                 sensitive (Rule R2 — never log).
 *   - `expiresAt` Server-side expiration timestamp as a `Date`. The
 *                 caller surfaces this to the frontend so the UI can
 *                 react gracefully when an upload widget remains open
 *                 across the TTL window.
 */
export interface SignedUrlResult {
  /**
   * The signed URL bearer string. Carries the `X-Goog-Signature` query
   * parameter; treat as sensitive (Rule R2 — never log).
   */
  url: string;

  /**
   * Server-side expiration timestamp. Equal to
   * `new Date(Date.now() + READ_URL_TTL_MS)` for read URLs and
   * `new Date(Date.now() + UPLOAD_URL_TTL_MS)` for upload URLs.
   */
  expiresAt: Date;
}

/**
 * Public service interface.
 *
 * Members (per the file's export schema):
 *   - `getReadUrl(objectKey)`   Issue a v4 signed URL granting GET
 *                               access to the object for
 *                               {@link READ_URL_TTL_MS} ms.
 *   - `getUploadUrl(objectKey)` Issue a v4 signed URL granting PUT
 *                               access to the object for
 *                               {@link UPLOAD_URL_TTL_MS} ms.
 *   - `delete(objectKey)`       Idempotently delete the object,
 *                               tolerating 404 via the SDK's
 *                               `ignoreNotFound` option.
 */
export interface GcsService {
  /**
   * Issue a v4 signed URL granting GET access to the named object for
   * {@link READ_URL_TTL_MS} milliseconds.
   *
   * @param objectKey GCS object name (validated by
   *   {@link validateObjectKey}).
   * @returns The signed URL and its expiration timestamp.
   * @throws {ValidationError} When `objectKey` is empty or contains
   *   control characters.
   * @throws {Error} When the SDK fails to issue the URL — for
   *   example, when the bucket does not exist or the credential lacks
   *   `storage.objects.get` permission. Errors propagate (Rule R8).
   */
  getReadUrl(objectKey: string): Promise<SignedUrlResult>;

  /**
   * Issue a v4 signed URL granting PUT access to the named object for
   * {@link UPLOAD_URL_TTL_MS} milliseconds.
   *
   * Intended for ST-014 (logo upload) — the frontend uploads bytes
   * directly to GCS via the returned URL, bypassing the backend's
   * payload size limits and reducing backend bandwidth costs.
   *
   * @param objectKey GCS object name (validated by
   *   {@link validateObjectKey}).
   * @returns The signed URL and its expiration timestamp.
   * @throws {ValidationError} When `objectKey` is empty or contains
   *   control characters.
   * @throws {Error} When the SDK fails to issue the URL. Errors
   *   propagate (Rule R8).
   */
  getUploadUrl(objectKey: string): Promise<SignedUrlResult>;

  /**
   * Idempotently delete the named object. Tolerates the case where
   * the object is already absent (404) via the v7 SDK's
   * `ignoreNotFound: true` option.
   *
   * @param objectKey GCS object name (validated by
   *   {@link validateObjectKey}).
   * @throws {ValidationError} When `objectKey` is empty or contains
   *   control characters.
   * @throws {Error} When the SDK fails for any reason OTHER than 404.
   *   Errors propagate (Rule R8).
   */
  delete(objectKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a {@link GcsService} bound to the bucket configured by the
 * `GCS_BUCKET_NAME` environment variable.
 *
 * Construction reads the env vars EAGERLY via the typed `env` accessor
 * (Rule R4 — `requireEnv` throws on unset). This means a misconfigured
 * environment surfaces during application bootstrap rather than at the
 * first request.
 *
 * Emulator selection (LocalGCP Verification Rule):
 *   - When `GCS_EMULATOR_HOST` is set to a non-empty value, the
 *     Storage constructor receives `apiEndpoint: <host>` so all SDK
 *     requests route to the local emulator. The `projectId` is
 *     populated from `FIREBASE_PROJECT_ID` (which serves as the GCP
 *     project identifier across the application) with a `local-emulator`
 *     fallback so that emulator-only test rigs need not configure
 *     a project ID.
 *   - In production, the emulator host points at a sentinel value
 *     supplied by the deployment environment (Rule R4 forbids defaults
 *     in source). The Storage SDK uses Application Default Credentials
 *     for authentication when no `apiEndpoint` is configured.
 *
 * Logging:
 *   Emits exactly one `gcs.configured` log line during construction.
 *   The line carries the bucket name, the emulator-active boolean, and
 *   nothing else. Per Rule R2 the emulator host string itself is NOT
 *   logged (it can carry credentials in pathological deploy
 *   configurations) — only the boolean flag.
 *
 * @returns A {@link GcsService} bound to the configured bucket.
 */
export function createGcsService(): GcsService {
  const bucketName = env.GCS_BUCKET_NAME;
  const emulatorHost = env.GCS_EMULATOR_HOST;

  const storageOptions: StorageOptions = {};
  // The `length > 0` guard is defensive: `env.GCS_EMULATOR_HOST` already
  // throws on empty (Rule R4), but if a future refactor relaxes the
  // accessor we still must never pass an empty `apiEndpoint` to the
  // SDK — empty strings produce confusing 404s rather than clean
  // configuration errors.
  if (emulatorHost.length > 0) {
    storageOptions.apiEndpoint = emulatorHost;
    // Emulators do not require Google-issued credentials; supplying a
    // project ID is sufficient for the SDK to construct request URLs.
    // We read `FIREBASE_PROJECT_ID` directly via `process.env` (rather
    // than via the typed `env` accessor) so that this code path remains
    // usable in fixture harnesses where only `GCS_*` is configured.
    // The `'local-emulator'` fallback is a hard-coded constant local to
    // the emulator path; it is NOT a Rule R4 violation because it does
    // not provide a default for any of the six REQUIRED env vars — it
    // is a safe default for the SDK's `projectId` parameter, which is
    // not on the required list.
    storageOptions.projectId = process.env['FIREBASE_PROJECT_ID'] ?? 'local-emulator';
  }

  const storage = new Storage(storageOptions);
  const bucket = storage.bucket(bucketName);

  // One-time configuration log. The `event` field is the stable filter
  // key used by dashboards and alert rules (ST-047-AC1).
  logger.info(
    {
      event: 'gcs.configured',
      bucket: bucketName,
      // Emit a boolean instead of the host string itself per Rule R2 —
      // the host can carry embedded credentials in some deployment
      // configurations and MUST NOT appear in logs.
      emulator: emulatorHost.length > 0,
    },
    'GCS client configured',
  );

  return {
    async getReadUrl(objectKey: string): Promise<SignedUrlResult> {
      validateObjectKey(objectKey);
      const expiresMs = Date.now() + READ_URL_TTL_MS;
      // CRITICAL (C1 / R5): `version: 'v4'` MUST be present on every
      // call to `getSignedUrl`. The v7 SDK throws at runtime when
      // `version` is omitted; this comment + the literal `'v4'`
      // string makes the rule visible to any reviewer or grep gate.
      const [url] = await bucket.file(objectKey).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: expiresMs,
      });
      const expiresAt = new Date(expiresMs);
      // Log structural metadata only. The `url` variable holds the
      // signed URL bearer credential and MUST NOT be logged (Rule R2).
      logger.info(
        {
          event: 'gcs.signed-url.issued',
          action: 'read',
          bucket: bucketName,
          objectKey,
          expiresAt: expiresAt.toISOString(),
        },
        'issued GCS read URL',
      );
      return { url, expiresAt };
    },

    async getUploadUrl(objectKey: string): Promise<SignedUrlResult> {
      validateObjectKey(objectKey);
      const expiresMs = Date.now() + UPLOAD_URL_TTL_MS;
      // CRITICAL (C1 / R5): `version: 'v4'` MUST be present on every
      // call to `getSignedUrl`. Identical rationale to `getReadUrl`.
      const [url] = await bucket.file(objectKey).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: expiresMs,
      });
      const expiresAt = new Date(expiresMs);
      // Log structural metadata only. The `url` variable holds the
      // signed URL bearer credential and MUST NOT be logged (Rule R2).
      logger.info(
        {
          event: 'gcs.signed-url.issued',
          action: 'write',
          bucket: bucketName,
          objectKey,
          expiresAt: expiresAt.toISOString(),
        },
        'issued GCS upload URL',
      );
      return { url, expiresAt };
    },

    async delete(objectKey: string): Promise<void> {
      validateObjectKey(objectKey);
      // Idempotent delete: the SDK's `ignoreNotFound: true` option
      // suppresses 404s, expressing "remove if present" semantics
      // without try/catch swallowing. Errors other than 404 (e.g.,
      // permission denied, bucket missing) still propagate to the
      // caller per Rule R8.
      await bucket.file(objectKey).delete({ ignoreNotFound: true });
      logger.info(
        {
          event: 'gcs.object.deleted',
          bucket: bucketName,
          objectKey,
        },
        'deleted GCS object',
      );
    },
  };
}
