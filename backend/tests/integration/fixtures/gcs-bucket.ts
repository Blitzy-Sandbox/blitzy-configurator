/**
 * `gcs-bucket.ts` — fake-gcs-server object factory.
 *
 * SOLE abstraction for integration tests that need pre-seeded objects in
 * the test GCS bucket. Talks to fake-gcs-server (the LocalGCP emulator
 * for Google Cloud Storage) via the same @google-cloud/storage v7 client
 * the production backend uses, redirected via the `apiEndpoint` option
 * to `GCS_EMULATOR_HOST`.
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - LocalGCP Verification Rule (AAP §0.8.2): every GCP service interaction
 *     MUST be verifiable against LocalGCP with zero live GCP dependencies;
 *     integration tests MUST create their own resources during setup and
 *     clean up after teardown — no dependence on pre-existing emulator state.
 *   - AAP §0.4.1: @google-cloud/storage ^7.12.0 is the pinned SDK version,
 *     identical to the production `backend/src/services/gcs.service.ts`.
 *   - AAP §0.5.4: fake-gcs-server is the LocalGCP service for GCS,
 *     addressed by the `GCS_EMULATOR_HOST` environment variable.
 *   - Story ST-044 (AAP §0.6.12): integration test suite — deterministic
 *     fixtures, self-cleaning resources, run-anywhere semantics.
 *   - Folder requirement (`backend/tests/integration/fixtures/`):
 *     "gcs-bucket.ts — fake-gcs-server object factory (LocalGCP Rule
 *      compliance)". This factory does NOT issue signed URLs — that
 *     responsibility lives in `backend/src/services/gcs.service.ts`,
 *     verified by `../gcs/signed-url.integration.test.ts`.
 *
 * ============================================================================
 * Process Boundaries
 * ============================================================================
 *   - `backend/tests/integration/setup/global-setup.ts` (separate process)
 *     creates a unique test bucket `strikeforge-logos-test-<uuid>` in
 *     fake-gcs-server and writes its name to
 *     `/tmp/strikeforge-test-bucket.json` with the shape
 *     `{"bucket": "<name>"}`.
 *   - This factory (loaded inside Jest test workers) reads that file on
 *     every call to discover the bucket name. NO module-level caching:
 *     the file read is <1 ms and avoids race conditions if global-setup.ts
 *     ever writes the file late, or if multiple workers ever run.
 *   - `backend/tests/integration/setup/global-teardown.ts` (separate
 *     process) reads the file, drops the bucket via `deleteFiles({ force:
 *     true })` then `bucket.delete()`, and unlinks the file. This is the
 *     safety-net cleanup; per-test `deleteTestObject(key)` is the
 *     fast-path optimization for long runs.
 *
 * ============================================================================
 * Core Invariants
 * ============================================================================
 *   1. Bucket name discovered per-run — never hard-coded; never read from
 *      `process.env.GCS_BUCKET_NAME` (that variable lives in production
 *      code and may NOT propagate from `global-setup.ts` to test workers
 *      reliably).
 *   2. Returns DIRECT retrieval URLs on the fake-gcs-server admin endpoint
 *      (`{host}/storage/v1/b/{bucket}/o/{key}?alt=media`), NOT signed URLs.
 *      Direct URLs carry no credentials and are suitable only for test
 *      read-back.
 *   3. Same `@google-cloud/storage` v7 SDK as production, redirected via
 *      `apiEndpoint`. Exercises the same network/serialization code paths.
 *   4. Fail-closed (Rule R8): every error path throws with a descriptive
 *      message naming the affected resource — no silent fallback or
 *      default bucket name.
 *
 * ============================================================================
 * Rule Compliance
 * ============================================================================
 *   - Rule R2 (no credential material in logs): Returned URLs are direct
 *     retrieval URLs on fake-gcs-server, NOT signed URLs with embedded
 *     credentials. Error messages name resource identifiers (file path,
 *     bucket name, object key, emulator endpoint) — never env-var values.
 *   - Rule R3 (Firebase Admin SDK only): N/A — this file does not touch auth.
 *   - Rule R4 (no env defaults in source): `GCS_EMULATOR_HOST` and
 *     `FIREBASE_PROJECT_ID` are validated per-call with descriptive errors
 *     when unset. By the time this fixture is invoked, `global-setup.ts`
 *     has already enforced these; the per-call check is defense in depth.
 *   - Rule R5 / C1 (GCS v7 signed URL syntax): This factory does NOT call
 *     `getSignedUrl()`. The v4-version mandate applies ONLY to the
 *     production code path (`backend/src/services/gcs.service.ts`).
 *     Verification: `grep "getSignedUrl" this-file` MUST return zero matches.
 *   - Rule R6 / C4 (OTel registration order): No OTel imports. OpenTelemetry
 *     is registered by the integration suite's `setupFiles` shim
 *     (`tests/integration/setup/register-tracing.ts`) BEFORE this file
 *     loads. The `@google-cloud/storage` HTTP calls made here are
 *     transparently auto-instrumented.
 *   - Rule R8 (fail closed): Every failure mode throws with a descriptive
 *     message. Missing tracking file → throws naming the file path. Missing
 *     env var → throws naming the variable. Network error → throws naming
 *     the emulator endpoint and remediation hint.
 *   - Rule R9 (no payment processing): N/A — no payment surface touched.
 *
 * ============================================================================
 * Cross-File Coordination
 * ============================================================================
 *   - `tests/integration/setup/global-setup.ts` writes
 *     `/tmp/strikeforge-test-bucket.json`. This file's
 *     `resolveTestBucketName()` reads it.
 *   - `tests/integration/setup/global-teardown.ts` reads the same file
 *     and drops the bucket. Per-object `deleteTestObject` is an
 *     optimization, not a correctness requirement.
 *   - `src/services/gcs.service.ts` (production) is the v4 signed-URL
 *     code path; this fixture is intentionally decoupled from it.
 *   - `tests/integration/gcs/signed-url.integration.test.ts` (separate)
 *     uses this fixture's `createTestObject` to seed an object, then
 *     calls the production service's `getSignedUrl` for verification.
 */

import fs from 'node:fs/promises';
import { Storage, type Bucket } from '@google-cloud/storage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path of the cross-process state file holding the unique GCS bucket name
 * for the current integration test run.
 *
 * Write contract (governed by `global-setup.ts`):
 *   - Written ONCE per run, immediately after `storage.createBucket()`
 *     succeeds in fake-gcs-server.
 *   - Shape: `{"bucket": "strikeforge-logos-test-<uuid>"}`.
 *   - The JSON envelope leaves room for future fields (e.g. created-at
 *     timestamp, run id) without breaking existing readers.
 *
 * Read contract (this file):
 *   - Read on EVERY factory invocation; no module-level caching.
 *
 * Cleanup contract (governed by `global-teardown.ts`):
 *   - The file is `unlink`ed AFTER the bucket is deleted. If the
 *     teardown process crashes, the next run's `global-setup.ts`
 *     overwrites the file (idempotent).
 */
const TMP_BUCKET_FILE = '/tmp/strikeforge-test-bucket.json';

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * A test object pre-seeded in the test GCS bucket via fake-gcs-server.
 *
 * `url` is a DIRECT retrieval URL on the fake-gcs-server HTTP surface
 * (`{apiEndpoint}/storage/v1/b/{bucket}/o/{key}?alt=media`), NOT a
 * signed URL. It is suitable for read-back assertions in tests but
 * MUST NOT be used in production code. Signed-URL generation is the
 * production `gcs.service.ts`'s exclusive responsibility (Rule R5 / C1).
 *
 * @property bucket - the test bucket name (varies per run; matches the
 *                    value persisted in `/tmp/strikeforge-test-bucket.json`).
 * @property key    - the object key (filename within the bucket; equals
 *                    the `key` argument passed to `createTestObject`).
 * @property url    - direct retrieval URL on fake-gcs-server. Sending an
 *                    HTTP GET to this URL returns the raw object bytes;
 *                    omitting `?alt=media` (which this implementation
 *                    always includes) would return JSON metadata instead.
 */
export interface TestObject {
  bucket: string;
  key: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Read the current test bucket name from `/tmp/strikeforge-test-bucket.json`.
 *
 * Cached? NO — re-read on every call. The cost is trivial (one small
 * file read, well under 1 ms on local disk) and caching would introduce
 * subtle bugs:
 *   - If `global-setup.ts` ever writes the file late, a cached "missing"
 *     result would persist for the entire run.
 *   - If multiple Jest workers ever run (not currently the case but
 *     possible), caching at module level would not be shared between
 *     workers anyway — defeating the purpose.
 *
 * Per Rule R8 (fail-closed), any anomaly throws a descriptive error
 * rather than falling back to a default bucket name:
 *   - File missing (ENOENT) → descriptive error pointing at the
 *     `globalSetup` Jest config setting.
 *   - File unreadable for any other reason → wrap-and-rethrow.
 *   - File not valid JSON → descriptive error.
 *   - JSON does not contain a non-empty `bucket` string → descriptive
 *     error pointing at the schema.
 *
 * The error messages name the file PATH (a public artifact location)
 * but never the bucket NAME from a successful read (no leakage in error
 * paths because successful reads don't go through the error branches).
 *
 * @returns the bucket name written by `global-setup.ts`.
 * @throws Error if the file is missing, unreadable, malformed, or
 *               missing the required field.
 */
async function resolveTestBucketName(): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(TMP_BUCKET_FILE, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `[gcs-bucket] Test bucket tracking file ${TMP_BUCKET_FILE} is missing. ` +
          'global-setup.ts must run before integration tests use this factory. ' +
          'Verify jest.config.integration.ts has `globalSetup: ' +
          "'<rootDir>/tests/integration/setup/global-setup.ts'`.",
      );
    }
    throw new Error(`[gcs-bucket] Failed to read ${TMP_BUCKET_FILE}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[gcs-bucket] ${TMP_BUCKET_FILE} does not contain valid JSON: ${(err as Error).message}`,
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { bucket?: unknown }).bucket !== 'string' ||
    (parsed as { bucket: string }).bucket.length === 0
  ) {
    throw new Error(
      `[gcs-bucket] ${TMP_BUCKET_FILE} is missing the "bucket" field ` +
        'or the field is not a non-empty string. Expected shape: ' +
        '{"bucket": "strikeforge-logos-test-<uuid>"}.',
    );
  }

  return (parsed as { bucket: string }).bucket;
}

/**
 * Read `GCS_EMULATOR_HOST` and `FIREBASE_PROJECT_ID` from the
 * environment. Both are required for the `Storage` client:
 *   - `apiEndpoint` (= `GCS_EMULATOR_HOST`) redirects all SDK HTTP
 *     calls at fake-gcs-server instead of real GCS.
 *   - `projectId` (= `FIREBASE_PROJECT_ID`) is used internally by the
 *     SDK; fake-gcs-server doesn't validate it but the SDK requires
 *     a non-empty string for some code paths.
 *
 * Per Rule R4, missing env vars throw at call time. By the time this
 * fixture runs, `global-setup.ts` has already enforced this — the
 * per-call check is defense in depth (and useful when tests are
 * accidentally run without `globalSetup`).
 *
 * Error messages name the variable by name only — NEVER the value
 * (Rule R2 defense in depth).
 *
 * @returns the resolved API endpoint and project ID.
 * @throws Error if either variable is unset or the empty string.
 */
function resolveGcsConfig(): { apiEndpoint: string; projectId: string } {
  const apiEndpoint = process.env['GCS_EMULATOR_HOST'];
  const projectId = process.env['FIREBASE_PROJECT_ID'];

  if (apiEndpoint === undefined || apiEndpoint === '') {
    throw new Error(
      '[gcs-bucket] GCS_EMULATOR_HOST is not set. Per Rule R4, the six ' +
        'required env vars must be populated before integration tests run.',
    );
  }
  if (projectId === undefined || projectId === '') {
    throw new Error(
      '[gcs-bucket] FIREBASE_PROJECT_ID is not set. Per Rule R4, the six ' +
        'required env vars must be populated before integration tests run.',
    );
  }

  return { apiEndpoint, projectId };
}

/**
 * Create a `Storage` client pointed at fake-gcs-server and return a
 * `Bucket` handle for the current test bucket.
 *
 * The `Storage` client is NOT cached at module level because:
 *   - Env vars MAY change between test files in pathological scenarios
 *     (a test that overrides `GCS_EMULATOR_HOST` to point at a
 *     misconfigured server, for example).
 *   - Creating a `Storage` client is cheap — no network I/O happens
 *     until the first request.
 *   - Caching would couple this fixture's lifetime to the module-load
 *     cycle of the Jest worker, which is an opaque internal concern.
 *
 * Rationale for NOT delegating to `backend/src/services/gcs.service.ts`:
 *   - That service wraps v4 signed-URL issuance (Rule R5 / C1) which
 *     this fixture deliberately bypasses.
 *   - That service may carry additional side effects (OpenTelemetry
 *     span annotations, pino log bindings) that don't belong in test
 *     setup — they would pollute the trace tree and the log stream
 *     with non-test signal.
 *   - Importing `backend/src/**` from a fixture would couple test
 *     scaffolding to production code's load order, which is a smell.
 *
 * @returns the storage client, bucket handle, bucket name, and api
 *          endpoint — the latter two returned for use in error
 *          messages and URL construction by callers.
 */
async function getTestBucket(): Promise<{
  storage: Storage;
  bucket: Bucket;
  bucketName: string;
  apiEndpoint: string;
}> {
  const bucketName = await resolveTestBucketName();
  const { apiEndpoint, projectId } = resolveGcsConfig();

  const storage = new Storage({ apiEndpoint, projectId });
  const bucket = storage.bucket(bucketName);

  return { storage, bucket, bucketName, apiEndpoint };
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Create a test object in the test GCS bucket via fake-gcs-server.
 *
 * The upload is performed in non-resumable mode (`resumable: false`)
 * because fake-gcs-server's resumable-upload path has historically been
 * less reliable than the direct upload path, and small test fixtures
 * don't benefit from resumability anyway.
 *
 * @param key - the object key (e.g., `"test-<uuid>-logo.png"`). Callers
 *              are responsible for ensuring uniqueness if multiple tests
 *              share the same bucket. Convention: prefix with `"test-"`
 *              + a UUID v4. Empty strings are rejected with a TypeError.
 * @param content - the object bytes. `Buffer` or `string`. Strings are
 *              treated as UTF-8 by the SDK.
 * @param contentType - optional MIME type. If omitted, fake-gcs-server
 *              defaults to `application/octet-stream`. Common values for
 *              this project: `image/png`, `image/jpeg`, `image/svg+xml`,
 *              `text/plain`.
 *
 * @returns a `TestObject` with the bucket, key, and direct retrieval
 *          URL. The URL is suitable for test read-back via `fetch()` but
 *          NOT for production use (it is not a signed URL).
 *
 * Per the LocalGCP Rule, callers SHOULD pair this with a
 * `deleteTestObject(key)` in `afterEach` to keep the bucket lean during
 * long runs. `global-teardown.ts` performs a bucket-level
 * `deleteFiles({ force: true })` as a safety net; per-object cleanup
 * is an optimization, not a correctness requirement.
 *
 * @throws TypeError when `key` is not a non-empty string.
 * @throws Error when `/tmp/strikeforge-test-bucket.json` is missing or
 *         malformed (delegated to `resolveTestBucketName`).
 * @throws Error when `GCS_EMULATOR_HOST` or `FIREBASE_PROJECT_ID` is
 *         unset (delegated to `resolveGcsConfig`).
 * @throws Error when the upload fails for any reason (network, non-2xx
 *         response, etc.). The error message names the bucket, key,
 *         and api endpoint and includes a remediation hint pointing
 *         at `docker compose ps`.
 */
export async function createTestObject(
  key: string,
  content: Buffer | string,
  contentType?: string,
): Promise<TestObject> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[gcs-bucket] createTestObject: key must be a non-empty string.');
  }

  const { bucket, bucketName, apiEndpoint } = await getTestBucket();

  // Build the SaveOptions object explicitly so TypeScript's exactOptional
  // semantics remain happy (don't pass `contentType: undefined` when the
  // caller omitted the argument — that would trigger a v7 SDK warning
  // under strict mode).
  const saveOptions: { contentType?: string; resumable: boolean } = {
    // fake-gcs-server's resumable-upload path is inconsistent across
    // versions; non-resumable is reliable for small test fixtures.
    resumable: false,
  };
  if (contentType !== undefined && contentType !== '') {
    saveOptions.contentType = contentType;
  }

  try {
    await bucket.file(key).save(content, saveOptions);
  } catch (err) {
    throw new Error(
      `[gcs-bucket] Failed to upload object "${key}" to bucket "${bucketName}" ` +
        `at ${apiEndpoint}: ${(err as Error).message}. Verify the gcs-emulator ` +
        '(fake-gcs-server) service is running (see `docker compose ps`).',
    );
  }

  // Compose a direct retrieval URL. fake-gcs-server exposes objects via:
  //   {apiEndpoint}/storage/v1/b/{bucket}/o/{key}?alt=media
  // The `?alt=media` query string is essential — without it, the
  // endpoint returns the object's METADATA (JSON), not its bytes.
  // `encodeURIComponent` is defensive: bucket names are always
  // GCS-compliant (lowercase alphanumeric + hyphens), but object keys
  // can contain slashes (e.g. `logos/foo.png`) which MUST be percent-
  // encoded for safe URL construction.
  const url =
    `${apiEndpoint}/storage/v1/b/${encodeURIComponent(bucketName)}` +
    `/o/${encodeURIComponent(key)}?alt=media`;

  return { bucket: bucketName, key, url };
}

/**
 * Delete a test object from the test bucket.
 *
 * Idempotent: if the object does not exist (already deleted, or never
 * created), this function returns normally. The first line of defense
 * is the v7 SDK's native `{ ignoreNotFound: true }` option; some
 * fake-gcs-server versions don't honor it fully, so a defensive
 * catch-and-check on `code === 404` (or the message containing
 * `not found` / `404`) treats the equivalent emulator response as
 * success too.
 *
 * Tests SHOULD call this in `afterEach` to keep the bucket lean during
 * long runs. `global-teardown.ts` performs `deleteFiles({ force: true })`
 * on the entire bucket at run end as a safety net, so missing per-test
 * cleanup will not leave residue across runs — only within a single
 * run.
 *
 * @param key - the object key passed to a prior `createTestObject` call.
 *              Empty strings are rejected with a TypeError.
 *
 * @throws TypeError when `key` is not a non-empty string.
 * @throws Error when `/tmp/strikeforge-test-bucket.json` is missing or
 *         malformed (delegated to `resolveTestBucketName`).
 * @throws Error when `GCS_EMULATOR_HOST` or `FIREBASE_PROJECT_ID` is
 *         unset (delegated to `resolveGcsConfig`).
 * @throws Error when the delete fails for any reason OTHER than 404.
 */
export async function deleteTestObject(key: string): Promise<void> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[gcs-bucket] deleteTestObject: key must be a non-empty string.');
  }

  const { bucket, bucketName, apiEndpoint } = await getTestBucket();

  try {
    await bucket.file(key).delete({ ignoreNotFound: true });
  } catch (err) {
    // Defensive 404 handling — see method docstring for rationale.
    const e = err as { code?: number; message?: string };
    if (e.code === 404 || /not.*found|404/i.test(e.message ?? '')) {
      return;
    }
    throw new Error(
      `[gcs-bucket] Failed to delete object "${key}" from bucket "${bucketName}" ` +
        `at ${apiEndpoint}: ${(err as Error).message}.`,
    );
  }
}
