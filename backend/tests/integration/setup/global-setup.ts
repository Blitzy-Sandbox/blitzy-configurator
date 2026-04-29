/**
 * `global-setup.ts` — Jest `globalSetup` hook for the backend integration
 * test suite.
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - AAP §0.6.4 / §0.6.10 / §0.6.12 (Track 1 Backend, MG1-E, MG2-H)
 *   - Story ST-039: Enforce Integration Test Gate After Unit Test Pass
 *   - Story ST-044: Define and Maintain Integration Test Suite for Service
 *                   Interactions
 *   - Story ST-030: Introduce Designs Schema with Ownership and Indexes
 *   - Story ST-031: Introduce Users and Sessions Schemas with Indexes
 *   - Story ST-035: Introduce Orders and Order Items Schema with Indexes
 *   - Rule R4 (AAP §0.8.1) — All six required environment variables MUST throw
 *                            at startup when unset; no fallback values.
 *   - Rule R8 (AAP §0.8.1) — Gates fail closed; any infrastructure or tooling
 *                            error MUST produce a failed verdict.
 *   - LocalGCP Verification Rule (AAP §0.8.2) — Integration tests MUST create
 *                                               their own resources during
 *                                               setup and clean up after
 *                                               teardown.
 *   - ST-044-AC3 (verbatim) — A failing integration test produces a failed
 *                             verdict that blocks merge; the suite distinguishes
 *                             assertion failures from environment or
 *                             fixture-setup failures in the report.
 *
 * ============================================================================
 * Hook Type and Runtime
 * ============================================================================
 *   This file is registered as Jest's `globalSetup` in
 *   `backend/jest.config.integration.ts`. Jest invokes it ONCE per integration
 *   test run, in a SEPARATE Node process from the test workers, BEFORE any
 *   test file is loaded. Its symmetric counterpart, `global-teardown.ts`,
 *   undoes the side effects produced here.
 *
 * ============================================================================
 * Responsibilities (Sequential, Fail-Closed)
 * ============================================================================
 *   1. Validate the six required env vars (Rule R4).
 *   2. Wait for PostgreSQL to be reachable, retrying up to 10 × 1s.
 *   3. Apply all migrations forward via `node-pg-migrate`'s JS API. After
 *      success the database has 5 user tables (users, sessions, designs,
 *      orders, order_items) plus the `pgmigrations` ledger table — matching
 *      the canonical Gate T1-B verification.
 *   4. Create a unique-per-run test GCS bucket via fake-gcs-server and
 *      persist its name to `/tmp/strikeforge-test-bucket.json` so fixtures
 *      and `global-teardown.ts` can discover it.
 *   5. Verify the Firebase Auth emulator is reachable so authenticated tests
 *      do not fail later with non-actionable network errors.
 *   6. Initialize `/tmp/strikeforge-test-users.json` as empty so fixtures'
 *      first appended user record does not fail with ENOENT.
 *
 * ============================================================================
 * Fail-Fast Semantics (Rule R8 + ST-044-AC3)
 * ============================================================================
 *   Any thrown error propagates uncaught to Jest, which aborts the run with a
 *   JUnit `<error>` element on the test-suite level (distinct from the
 *   `<failure>` elements produced by per-test assertion failures). This is
 *   precisely the distinction ST-044-AC3 requires: environment / fixture-setup
 *   problems are reported separately from assertion failures so operators can
 *   triage quickly. We therefore NEVER swallow errors at the top level and
 *   NEVER call `process.exit()` (which would short-circuit Jest's reporting).
 *
 * ============================================================================
 * Cross-Process State Sharing
 * ============================================================================
 *   `globalSetup` runs in a separate Node process from the test workers, so
 *   `process.env` mutations made here are not automatically visible to test
 *   workers under all Jest configurations. The canonical mechanism for sharing
 *   per-run state is files in `/tmp`:
 *
 *     /tmp/strikeforge-test-bucket.json
 *         The unique GCS bucket name for this run. Read by GCS fixture
 *         helpers and by `global-teardown.ts`.
 *     /tmp/strikeforge-test-users.json
 *         JSONL of test-user records appended by the firebase-user fixture.
 *         Read by `global-teardown.ts` to delete each user from the emulator.
 *
 * ============================================================================
 * Why We Duplicate Env Validation Inline
 * ============================================================================
 *   The folder requirement explicitly recommends inline duplication of env
 *   validation rather than importing `requireEnv` from
 *   `backend/src/config/env.ts`. Rationale: at the `globalSetup` phase the
 *   import-resolution path may not be configured the same as in test workers
 *   (different ts-jest cache, different module resolution under Jest's
 *   `globalSetup`). Inline validation is robust against those harness-level
 *   variations and keeps this file's dependencies entirely outside
 *   `backend/src/`.
 *
 * ============================================================================
 * Forbidden Patterns (Documented for Reviewers)
 * ============================================================================
 *   - DO NOT import from `backend/src/**`. (See "Why We Duplicate ...".)
 *   - DO NOT use `child_process.spawn` for the migration step — the JS API
 *     of `node-pg-migrate` keeps types and exit semantics intact.
 *   - DO NOT use a static test bucket name — parallel CI runs would collide.
 *   - DO NOT log credential VALUES in error messages — only env-var NAMES
 *     (Rule R2 spirit; avoids leaking DATABASE_URL contents).
 *   - DO NOT `process.exit()` — throw, so Jest can render the failure cleanly.
 *   - DO NOT swallow errors silently — Rule R8 / ST-044-AC3 require failures
 *     to surface.
 */

// ---------------------------------------------------------------------------
// External imports — Node stdlib + the same packages used by the production
// backend. Intentionally NO imports from `backend/src/**` (see header).
// ---------------------------------------------------------------------------

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import migrate from 'node-pg-migrate';
import { Storage } from '@google-cloud/storage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The six environment variables required by Rule R4 (AAP §0.1.3).
 *
 * This list mirrors the canonical declaration in
 * `backend/src/config/env.ts` (`REQUIRED_ENV_VARS`). The two declarations are
 * intentionally maintained independently — the folder requirement forbids
 * importing from `backend/src/**` here. Whenever the canonical list changes,
 * the corresponding update MUST land in this file in the same commit.
 *
 * The `as const` assertion turns this into a readonly tuple of literal
 * string types so adding/removing a member produces a TypeScript-visible
 * diff at every consumer.
 */
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'GCS_BUCKET_NAME',
  'GCS_EMULATOR_HOST',
  'COVERAGE_THRESHOLD',
  'GCP_REGION',
] as const;

/**
 * Path of the cross-process state file holding the unique GCS bucket name
 * for THIS test run. Written here in `createTestGcsBucket()`; read by GCS
 * fixture helpers in test workers and by `global-teardown.ts`.
 */
const TMP_BUCKET_FILE = '/tmp/strikeforge-test-bucket.json';

/**
 * Path of the cross-process state file holding the JSONL log of test users
 * created by the firebase-user fixture. Initialized empty here in
 * `initializeTestUserTrackingFile()`; appended by the fixture in workers;
 * read by `global-teardown.ts` to delete each user from the emulator.
 */
const TMP_USERS_FILE = '/tmp/strikeforge-test-users.json';

/**
 * Number of times to retry the PostgreSQL readiness probe before giving up.
 * Combined with {@link POSTGRES_CONNECT_RETRY_DELAY_MS} this yields a 10-second
 * worst-case wait, which comfortably absorbs the 1–5-second cold-start gap of
 * the postgres:15-alpine container in `docker-compose.yml`.
 */
const POSTGRES_CONNECT_RETRY_ATTEMPTS = 10;

/**
 * Delay between PostgreSQL readiness probe attempts, in milliseconds.
 * 1 second is the standard polling cadence used by docker-compose's own
 * `pg_isready` healthcheck (`interval: 5s` is too coarse for a fast-failing
 * test gate and would push the worst case to 50s).
 */
const POSTGRES_CONNECT_RETRY_DELAY_MS = 1000;

/**
 * Default Firebase Auth Emulator URL when the `FIREBASE_AUTH_EMULATOR_HOST`
 * env var is unset. This is the canonical port emitted by `firebase emulators:start`
 * and the value used by `docker-compose.yml`. Defaulting here is safe because
 * `FIREBASE_AUTH_EMULATOR_HOST` is intentionally NOT one of the six required
 * vars: in production it is unset (the Admin SDK uses real Firebase Auth via
 * workload identity); in local/CI test profiles docker-compose sets it.
 */
const DEFAULT_FIREBASE_EMULATOR_HOST = 'localhost:9099';

/**
 * Default path of the synthetic LocalGCP service-account JSON used by
 * `@google-cloud/storage` v4 signing when `GOOGLE_APPLICATION_CREDENTIALS`
 * is unset.
 *
 * Why this default is necessary (LocalGCP Verification Rule, AAP §0.8.2):
 *   The v4 signed-URL contract (Rule R5 / C1) requires `getSignedUrl` to
 *   receive `version: 'v4'`. The v7 `@google-cloud/storage` SDK delegates
 *   v4 signing to `google-auth-library`, which performs RSA-SHA256 signing
 *   in-process using a private key obtained from Application Default
 *   Credentials. Without `GOOGLE_APPLICATION_CREDENTIALS`, the auth library
 *   falls through to the GCE / GKE metadata service, which is unreachable
 *   from a host workstation or a Cloud Build step container — surfacing as
 *   an `Invalid form of account ID ... .svc.id.goog` runtime error rather
 *   than the actionable signed URL the test expects (the failure mode QA
 *   reproduced in Final-E Issue #4).
 *
 *   `backend/local-dev-sa.json` carries a synthetic 2048-bit RSA private
 *   key. fake-gcs-server does NOT validate the signature on v4 URLs in
 *   emulator mode, so the synthetic key is sufficient to satisfy the
 *   client-side cryptographic plumbing without any real GCP credential.
 *   The file is committed to source (with an explicit negation in
 *   `.gitignore`) precisely so that LocalGCP integration test runs are
 *   credential-free per the Rule.
 *
 * Why the default is computed inline rather than required:
 *   Production deployments (Cloud Run with workload identity, or any
 *   environment that injects ADC via the metadata service) MUST NOT have
 *   `GOOGLE_APPLICATION_CREDENTIALS` overridden by integration test
 *   defaults. Adding GOOGLE_APPLICATION_CREDENTIALS to {@link REQUIRED_ENV_VARS}
 *   would force production environments to set it explicitly even though
 *   workload identity is the canonical pattern there. Inline defaulting in
 *   the test harness — applied ONLY when the var is unset — is the
 *   conservative pattern; it mirrors how {@link DEFAULT_FIREBASE_EMULATOR_HOST}
 *   is handled.
 *
 * Path resolution:
 *   `path.resolve(__dirname, '../../../local-dev-sa.json')` walks
 *   `backend/tests/integration/setup/` ➜
 *   `backend/tests/integration/`         ➜
 *   `backend/tests/`                     ➜
 *   `backend/`                           +
 *   `local-dev-sa.json`                  ➜
 *   `backend/local-dev-sa.json`.
 *   The absolute resolution makes the default usable from both:
 *     - host workstations running `npm run test:integration` from
 *       `backend/`, and
 *     - the Cloud Build `test:integration` step which runs from
 *       `/workspace/backend`.
 *
 * This constant is referenced by {@link defaultGoogleApplicationCredentials}.
 */
const DEFAULT_GOOGLE_APPLICATION_CREDENTIALS_PATH = path.resolve(
  __dirname,
  '../../../local-dev-sa.json',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep helper used by {@link waitForPostgres} between retry
 * attempts. Implemented inline to avoid pulling in a `setTimeout/promises`
 * import.
 *
 * @param ms - Number of milliseconds to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Step 0 — Default GOOGLE_APPLICATION_CREDENTIALS (LocalGCP Verification Rule)
// ---------------------------------------------------------------------------

/**
 * Defaults `GOOGLE_APPLICATION_CREDENTIALS` to the synthetic LocalGCP JSON
 * file at {@link DEFAULT_GOOGLE_APPLICATION_CREDENTIALS_PATH} when the env
 * var is unset or empty.
 *
 * Story coverage:
 *   - LocalGCP Verification Rule (AAP §0.8.2): Every GCP service interaction
 *     MUST be verifiable against LocalGCP with zero live GCP dependencies.
 *     This step is the bridge between that rule and the v4-signed URL
 *     contract, which requires a real RSA private key for in-process
 *     RSA-SHA256 signing inside `google-auth-library`.
 *   - Story ST-014 (logo upload UI) and the integration tests at
 *     `backend/tests/integration/gcs/signed-url.integration.test.ts`
 *     exercise this code path and fail without a usable service-account
 *     JSON.
 *
 * Behaviour:
 *   - If `GOOGLE_APPLICATION_CREDENTIALS` is already set (and non-empty),
 *     the function does NOTHING. This preserves any explicit operator
 *     override (e.g. a CI step setting a different keyfile path) and
 *     ensures we never silently mask a misconfiguration.
 *   - If unset / empty, the function:
 *       1. Verifies the synthetic JSON file exists at the canonical
 *          default path (the file is committed to the repository).
 *       2. Sets `process.env.GOOGLE_APPLICATION_CREDENTIALS` to that
 *          absolute path. Jest 27+ propagates `process.env` mutations
 *          made in `globalSetup` to test workers, so the assignment is
 *          visible to every Storage client constructed in test code.
 *
 * Why this lives BEFORE {@link validateRequiredEnvVars}:
 *   `GOOGLE_APPLICATION_CREDENTIALS` is intentionally NOT in
 *   {@link REQUIRED_ENV_VARS} — it is OPTIONAL in production (workload
 *   identity satisfies ADC without it). Defaulting it inline at the test
 *   harness boundary keeps the production fail-closed semantics intact
 *   while ensuring local/CI integration tests have a usable credential.
 *
 * Failure mode:
 *   Throws a descriptive error if the synthetic JSON is missing — that
 *   would indicate an incomplete repository checkout (the file is checked
 *   in to source). The error names the expected path so operators can
 *   restore the file from `git`. Per Rule R8 the failure surfaces as a
 *   JUnit `<error>` (environment failure) and blocks the run.
 */
async function defaultGoogleApplicationCredentials(): Promise<void> {
  const existing = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (existing !== undefined && existing !== '') {
    // Operator-supplied override — leave it intact.
    return;
  }

  // Verify the synthetic JSON exists at the canonical default path. The
  // file is committed to the repository (`backend/local-dev-sa.json`)
  // with a `!` negation in `.gitignore` so a fresh clone has it
  // immediately. Missing here means an incomplete checkout — surface a
  // clear, actionable error rather than letting `@google-cloud/storage`
  // fail later with the opaque "Invalid form of account ID" message.
  try {
    await fs.access(DEFAULT_GOOGLE_APPLICATION_CREDENTIALS_PATH);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      '[global-setup] Synthetic LocalGCP service-account JSON not found at ' +
        `${DEFAULT_GOOGLE_APPLICATION_CREDENTIALS_PATH}: ${cause}. ` +
        'This file is committed to the repository (see `.gitignore` ' +
        'negation `!backend/local-dev-sa.json`). Restore it via ' +
        '`git checkout -- backend/local-dev-sa.json` or set ' +
        'GOOGLE_APPLICATION_CREDENTIALS to a real service-account JSON.',
    );
  }

  // Mutate process.env so that:
  //   - The Jest worker `process.env` snapshot taken after globalSetup
  //     completes carries the resolved path.
  //   - Any Storage client constructed downstream (in test workers, in
  //     this setup process for the bucket-creation step, or in the
  //     integration test under test) reads the credential without any
  //     additional plumbing.
  process.env.GOOGLE_APPLICATION_CREDENTIALS =
    DEFAULT_GOOGLE_APPLICATION_CREDENTIALS_PATH;
}

// ---------------------------------------------------------------------------
// Step 1 — Validate Required Env Vars (Rule R4)
// ---------------------------------------------------------------------------

/**
 * Throws if any of the six required env vars (Rule R4) is unset or empty.
 *
 * Empty strings are treated as unset — matches the canonical `requireEnv`
 * semantics in `backend/src/config/env.ts`. A `.env` line of the form
 * `DATABASE_URL=` (no value after equals) is indistinguishable from "forgot
 * to set it" and MUST fail.
 *
 * The error message names the offending VARIABLE NAME but never its VALUE,
 * preserving the spirit of Rule R2 ("no credential material in logs"): a
 * message like `Error: DATABASE_URL is not set` is correct; a message like
 * `Error: DATABASE_URL=postgres://user:pwd@host is not set` would leak.
 */
function validateRequiredEnvVars(): void {
  for (const name of REQUIRED_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `[global-setup] Required environment variable "${name}" is not set. ` +
          'Integration tests cannot proceed without all six required vars: ' +
          `${REQUIRED_ENV_VARS.join(', ')}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Wait for PostgreSQL (Rule R8 fail-closed)
// ---------------------------------------------------------------------------

/**
 * Probes PostgreSQL using `DATABASE_URL`, retrying up to
 * {@link POSTGRES_CONNECT_RETRY_ATTEMPTS} times with
 * {@link POSTGRES_CONNECT_RETRY_DELAY_MS} delays between attempts.
 *
 * Rationale:
 *   `docker compose up -d` returns when the postgres CONTAINER is up, NOT
 *   when postgres is ACCEPTING CONNECTIONS — there is typically a 1–5s gap.
 *   Without retry, ~5% of cold-start CI runs would race ahead and fail with
 *   a non-actionable `ECONNREFUSED` message. The retry loop makes the suite
 *   resilient to that startup delay while still enforcing fail-closed
 *   semantics: after the final attempt the function throws with a
 *   descriptive error including the attempt count and remediation hint.
 *
 * Implementation notes:
 *   - A new `Client` is constructed per attempt because `Client.connect()`
 *     fails terminally — a Client whose `connect()` rejected cannot be
 *     reused for a subsequent attempt (its internal state is poisoned).
 *   - `SELECT 1` is the trivial sanity-check query; even on a freshly
 *     started cluster it confirms the connection is fully usable for the
 *     migration step that immediately follows.
 *   - Cleanup `client.end()` calls are wrapped in inner try/catch because
 *     calling `.end()` on a never-connected Client throws — we explicitly
 *     ignore that secondary failure to avoid masking the primary cause
 *     captured in `lastErr`.
 */
async function waitForPostgres(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    // Defensive — `validateRequiredEnvVars` should have caught this.
    // We re-check here because each step is intended to be self-validating
    // at its boundary: a future refactor that reorders the orchestrator
    // must not be able to silently produce a worse failure mode.
    throw new Error(
      '[global-setup] DATABASE_URL is unexpectedly unset at waitForPostgres step.',
    );
  }

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= POSTGRES_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      // Sanity check: trivial query confirms the connection is usable.
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      try {
        await client.end();
      } catch {
        // Ignore cleanup errors on a failed connection — `lastErr` already
        // carries the actionable diagnostic.
      }
      if (attempt < POSTGRES_CONNECT_RETRY_ATTEMPTS) {
        await sleep(POSTGRES_CONNECT_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(
    `[global-setup] PostgreSQL unreachable after ${POSTGRES_CONNECT_RETRY_ATTEMPTS} attempts. ` +
      `Last error: ${lastErr?.message ?? 'unknown'}. ` +
      'Verify docker-compose services are running: `docker compose ps`.',
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Apply Migrations Forward (ST-030, ST-031, ST-035)
// ---------------------------------------------------------------------------

/**
 * Applies all pending migrations forward via the `node-pg-migrate` JS API.
 *
 * Migrations live at `backend/migrations/{timestamp}_ST-0NN_*.js` (Rule R10
 * — every filename embeds its story ID) and are applied in
 * filename-timestamp order:
 *
 *   1. `20250115000001_ST-031_users_sessions.js`     — users, sessions
 *   2. `20250115000002_ST-030_designs.js`            — designs
 *   3. `20250115000003_ST-035_orders_order_items.js` — orders, order_items
 *
 * After successful application the database has 5 user tables (users,
 * sessions, designs, orders, order_items) plus the `pgmigrations` ledger
 * table. This satisfies the canonical Gate T1-B user-prompt verification:
 *
 *   ```
 *   docker compose exec postgres psql -U postgres -d strikeforge -c '\dt' \
 *     | grep -cE "users|sessions|designs|orders|order_items"
 *   # expected: 5
 *   ```
 *
 * Path resolution:
 *   `path.resolve(__dirname, '../../../migrations')` walks
 *   `backend/tests/integration/setup/` ➜
 *   `backend/tests/integration/`         ➜
 *   `backend/tests/`                     ➜
 *   `backend/`                           +
 *   `migrations`                         ➜
 *   `backend/migrations/`
 *   The absolute resolution makes the call independent of the working
 *   directory from which Jest is invoked (Cloud Build runs from the repo
 *   root; `npm test:integration` runs from `backend/`).
 *
 * Failure handling:
 *   `migrate()` throws on any failure (connection drop, syntax error in a
 *   migration, foreign-key violation when applying ST-030 before ST-031,
 *   etc.). The throw propagates uncaught to Jest, which renders it as a
 *   JUnit `<error>` element (ST-044-AC3 environment failure — distinct
 *   from `<failure>` assertion errors).
 *
 * Logging:
 *   `log: () => {}` silences `node-pg-migrate`'s default stdout chatter
 *   (~3 INFO lines per migration ≈ 9 lines per run) so test output stays
 *   readable. Failures still throw and propagate normally — they never
 *   reach the suppressed `log` callback.
 */
async function applyMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    // Defensive — see waitForPostgres.
    throw new Error(
      '[global-setup] DATABASE_URL is unexpectedly unset at applyMigrations step.',
    );
  }

  const migrationsDir = path.resolve(__dirname, '../../../migrations');

  try {
    await migrate({
      databaseUrl,
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      direction: 'up',
      // Apply ALL pending migrations. `Infinity` is the documented sentinel
      // for "no upper bound" in node-pg-migrate's RunnerOption; this is the
      // correct value for "apply every migration the migrations directory
      // contains" rather than a fixed count.
      count: Infinity,
      // Ignore dotfiles in the migrations directory (e.g. `.gitkeep` placed
      // there to keep the empty directory committed). Without this, the JS
      // API would attempt to `require()` `.gitkeep` as a JavaScript module
      // and throw a `SyntaxError`. The CLI applies this default for us, but
      // the JS API does not — it MUST be passed explicitly here. The pattern
      // `\\..*` is the same default used by the `node-pg-migrate` CLI (see
      // `bin/node-pg-migrate` `defaultDescription: '"\\..*"'`).
      ignorePattern: '\\..*',
      log: () => {
        // Intentional no-op — silence chatter, keep failures throwing.
      },
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      '[global-setup] Migration application failed. ' +
        `Migrations directory: ${migrationsDir}. ` +
        `Cause: ${cause}. ` +
        'See `backend/migrations/*.js` and `docker compose logs postgres` for details.',
    );
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Create Test GCS Bucket (LocalGCP Verification Rule)
// ---------------------------------------------------------------------------

/**
 * Creates a unique-per-run test GCS bucket via the fake-gcs-server emulator
 * and persists the bucket name to {@link TMP_BUCKET_FILE} so:
 *   - GCS fixture helpers (`backend/tests/integration/fixtures/gcs-bucket.ts`,
 *     pending CREATED elsewhere) read the bucket name to perform upload
 *     and signed-URL test cases against the same bucket the production
 *     code path will use.
 *   - `global-teardown.ts` reads the bucket name to delete the bucket after
 *     the run completes (LocalGCP cleanup obligation).
 *
 * Why a unique bucket per run:
 *   - Parallel CI runs (e.g. multiple feature branches) on the same
 *     `fake-gcs-server` instance would collide on a static bucket name.
 *   - A leaked bucket from a previous run (e.g. teardown crash) would
 *     contaminate the next run's results — leftover objects could match
 *     test queries and produce false positives.
 *   - The LocalGCP Verification Rule explicitly mandates "create their own
 *     resources during setup and clean up after teardown — no dependence
 *     on pre-existing LocalGCP state".
 *
 * Why `randomUUID()` for the suffix:
 *   `randomUUID()` is RFC 4122 v4, cryptographically strong, and
 *   collision-free for any practical number of parallel runs. Bucket names
 *   in fake-gcs-server are limited to 63 chars total — `strikeforge-logos-test-`
 *   (23 chars) + UUID (36 chars) = 59 chars, comfortably under the limit.
 *
 * Note on `process.env.GCS_BUCKET_NAME`:
 *   We override the env var here for local convenience, but `globalSetup`
 *   runs in a SEPARATE Node process from the test workers and this mutation
 *   is NOT automatically visible to workers under all Jest configurations.
 *   The CANONICAL pattern (used by fixture helpers) is to read the bucket
 *   name from {@link TMP_BUCKET_FILE} rather than from `process.env`.
 */
async function createTestGcsBucket(): Promise<void> {
  const apiEndpoint = process.env.GCS_EMULATOR_HOST;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (
    apiEndpoint === undefined ||
    apiEndpoint === '' ||
    projectId === undefined ||
    projectId === ''
  ) {
    // Defensive — `validateRequiredEnvVars` should have caught this.
    throw new Error(
      '[global-setup] GCS_EMULATOR_HOST or FIREBASE_PROJECT_ID is unexpectedly unset at createTestGcsBucket step.',
    );
  }

  const testBucketName = `strikeforge-logos-test-${randomUUID()}`;

  const storage = new Storage({ apiEndpoint, projectId });
  try {
    await storage.createBucket(testBucketName);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[global-setup] Failed to create test GCS bucket "${testBucketName}" ` +
        `at ${apiEndpoint}: ${cause}. ` +
        'Verify the gcs-emulator (fake-gcs-server) service is running ' +
        '(see `docker compose ps`).',
    );
  }

  // Persist for fixtures + teardown to discover. The JSON envelope leaves
  // room for future fields (e.g. created-at timestamp, test run id) without
  // breaking existing readers.
  await fs.writeFile(
    TMP_BUCKET_FILE,
    JSON.stringify({ bucket: testBucketName }),
    'utf-8',
  );

  // Override GCS_BUCKET_NAME so backend code paths that read it directly in
  // this same process (e.g. setup-only fixture probes) see the unique
  // bucket. Test workers should still prefer the file-based discovery
  // pattern documented above.
  process.env.GCS_BUCKET_NAME = testBucketName;
}

// ---------------------------------------------------------------------------
// Step 5 — Verify Firebase Auth Emulator Reachability
// ---------------------------------------------------------------------------

/**
 * Confirms the Firebase Auth emulator is reachable BEFORE any test runs.
 *
 * Without this check, every authenticated test would later fail with a
 * non-actionable network error (the Firebase Admin SDK's `verifyIdToken`
 * call would time out or refuse the connection); diagnosing such failures
 * in CI is painful because the failure looks like an assertion error rather
 * than an environment error. Probing here surfaces the misconfiguration
 * with a clear, descriptive message before any test runs.
 *
 * Discovery:
 *   `FIREBASE_AUTH_EMULATOR_HOST` is intentionally NOT in
 *   {@link REQUIRED_ENV_VARS} — in production the Admin SDK uses real
 *   Firebase Auth via workload identity (no emulator). When unset we fall
 *   back to {@link DEFAULT_FIREBASE_EMULATOR_HOST} which is the canonical
 *   emulator port set by `docker-compose.yml`.
 *
 * Reachability semantics:
 *   The emulator's root URL returns either:
 *     - HTTP 200 with a JSON banner ("Ok" or similar), or
 *     - HTTP 404 if no project is registered yet.
 *   Both are acceptable signs of life. Only HTTP 5xx OR a network error
 *   (DNS failure, ECONNREFUSED, timeout) is treated as a failure.
 */
async function verifyFirebaseEmulatorReachable(): Promise<void> {
  const emulatorHost =
    process.env.FIREBASE_AUTH_EMULATOR_HOST ?? DEFAULT_FIREBASE_EMULATOR_HOST;
  const url = emulatorHost.startsWith('http')
    ? emulatorHost
    : `http://${emulatorHost}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[global-setup] Firebase Auth Emulator unreachable at ${url}: ${cause}. ` +
        'Verify the firebase-auth-emulator service is running ' +
        '(see `docker compose ps`).',
    );
  }

  if (res.status >= 500) {
    throw new Error(
      `[global-setup] Firebase Auth Emulator returned HTTP ${res.status} at ${url}. ` +
        'The emulator is reachable but unhealthy.',
    );
  }
}

// ---------------------------------------------------------------------------
// Step 6 — Initialize Empty Test User Tracking File
// ---------------------------------------------------------------------------

/**
 * Initializes {@link TMP_USERS_FILE} as an empty file so the firebase-user
 * fixture's first append (`fs.appendFile`) does not fail with `ENOENT`.
 *
 * The file is treated as JSONL (one JSON record per line); fixtures append
 * `JSON.stringify(record) + '\n'` per created user. `global-teardown.ts`
 * reads the file line-by-line, parses each record, and deletes the
 * corresponding user from the Firebase Auth emulator. Truncating to empty
 * here also clears any leftover records from a previous run whose teardown
 * crashed.
 */
async function initializeTestUserTrackingFile(): Promise<void> {
  await fs.writeFile(TMP_USERS_FILE, '', 'utf-8');
}

// ---------------------------------------------------------------------------
// Default Export — Orchestrator
// ---------------------------------------------------------------------------

/**
 * Default-export the setup function. Jest discovers it via
 * `globalSetup: '<rootDir>/tests/integration/setup/global-setup.ts'` in
 * `backend/jest.config.integration.ts`.
 *
 * Steps run sequentially because each later step depends on the previous
 * step's success:
 *
 *   0. defaultGoogleApplicationCredentials
 *                                   — must precede createTestGcsBucket and
 *                                     any worker-side Storage client. Sets
 *                                     `process.env.GOOGLE_APPLICATION_CREDENTIALS`
 *                                     to the committed synthetic LocalGCP
 *                                     keyfile when unset, so v4 signing in
 *                                     `@google-cloud/storage` works against
 *                                     fake-gcs-server (LocalGCP Verification
 *                                     Rule).
 *   1. validateRequiredEnvVars      — produces actionable errors before any
 *                                     downstream step would fail mysteriously.
 *   2. waitForPostgres              — must precede applyMigrations.
 *   3. applyMigrations              — must precede any DB-touching test.
 *   4. createTestGcsBucket          — must precede any GCS-touching test.
 *   5. verifyFirebaseEmulatorReachable
 *                                   — must precede any auth-touching test.
 *   6. initializeTestUserTrackingFile
 *                                   — last because it has no preconditions
 *                                     and is cheapest to redo if a prior
 *                                     step is later refactored to throw.
 *
 * Any thrown error propagates uncaught to Jest, which aborts the run with
 * a JUnit `<error>` element (ST-044-AC3 environment failure).
 */
export default async function globalSetup(): Promise<void> {
  await defaultGoogleApplicationCredentials();
  validateRequiredEnvVars();
  await waitForPostgres();
  await applyMigrations();
  await createTestGcsBucket();
  await verifyFirebaseEmulatorReachable();
  await initializeTestUserTrackingFile();
}
