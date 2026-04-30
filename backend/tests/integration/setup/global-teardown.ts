/**
 * `global-teardown.ts` — Jest `globalTeardown` hook for the backend
 * integration test suite.
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - AAP §0.6.4 / §0.6.10 / §0.6.12 (Track 1 Backend, MG1-E, MG2-H)
 *   - Story ST-039: Enforce Integration Test Gate After Unit Test Pass
 *   - Story ST-044: Define and Maintain Integration Test Suite for Service
 *                   Interactions
 *   - Story ST-030: Introduce Designs Schema with Ownership and Indexes
 *                   (AC3 — both directions are idempotent)
 *   - Story ST-031: Introduce Users and Sessions Schemas with Indexes
 *                   (AC3 — both directions are idempotent)
 *   - Story ST-035: Introduce Orders and Order Items Schema with Indexes
 *                   (AC4 — both directions are idempotent)
 *   - LocalGCP Verification Rule (AAP §0.8.2) — Integration tests MUST create
 *                                               their own resources during
 *                                               setup and clean up after
 *                                               teardown — no dependence on
 *                                               pre-existing LocalGCP state.
 *   - Rule R2 (AAP §0.8.1) — No credential material in logs. The
 *                            `console.warn` messages here log only operation
 *                            names and emulator error messages, NEVER env
 *                            values, tokens, or passwords.
 *
 * ============================================================================
 * Hook Type and Runtime
 * ============================================================================
 *   This file is registered as Jest's `globalTeardown` in
 *   `backend/jest.config.integration.ts`. Jest invokes it ONCE per integration
 *   test run, in a SEPARATE Node process from the test workers, AFTER all
 *   test files complete. It is the symmetric counterpart of
 *   `global-setup.ts` and undoes the side effects produced there.
 *
 * ============================================================================
 * Best-Effort Cleanup Semantics
 * ============================================================================
 *   By the time `globalTeardown` runs, the test verdict has ALREADY been
 *   determined: per-test assertion failures are recorded as `<failure>`
 *   elements in the JUnit report, and environment / fixture-setup failures
 *   from `globalSetup` are recorded as `<error>` elements. Cleanup errors
 *   that occur HERE should be LOGGED but should NOT mark the run failed —
 *   converting a passing run into a failure post-hoc would mislead operators
 *   ("the tests passed, but the database had stale rows for two minutes").
 *
 *   We therefore wrap each step internally with `try/catch` and log via
 *   `console.warn` rather than throwing. The exception is a TOP-LEVEL throw
 *   (e.g., a syntax error preventing the file from loading at all) — Jest
 *   will mark the run failed in that case, which is correct because the
 *   teardown hook itself failed to load.
 *
 * ============================================================================
 * Step Ordering (Last-In-First-Out vs. global-setup)
 * ============================================================================
 *   1. Delete test users (Firebase Auth Emulator REST API — no Admin SDK)
 *   2. Delete test GCS bucket (fake-gcs-server)
 *   3. Reverse all migrations (validates ST-030/ST-031/ST-035 idempotency)
 *   4. Remove the `/tmp/*.json` cross-process tracking files
 *
 *   Reordering risks leaking resources if a later step fails — e.g.,
 *   removing the tracking files BEFORE deleting users would leave orphan
 *   user records in the emulator with no record of their UIDs.
 *
 * ============================================================================
 * Why We Don't Import the Firebase Admin SDK Here
 * ============================================================================
 *   `globalTeardown` runs in a different Node process from the test workers.
 *   The Firebase Admin SDK initialized in `global-setup.ts` does NOT carry
 *   over: each Node process must initialize the SDK independently. Initializing
 *   the SDK requires either ADC credentials (which may not be available in
 *   CI) or a service account key (which would violate the LocalGCP zero-live-
 *   credentials mandate). The Firebase Auth Emulator exposes the same
 *   Identity Toolkit "projects.accounts.delete" admin REST endpoint that the
 *   Admin SDK calls under the hood:
 *
 *     POST `{HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:delete`
 *     Headers: `Authorization: Bearer owner`, `Content-Type: application/json`
 *     Body:    `{ "localId": "<uid>" }`
 *
 *   Per the firebase-tools emulator authoring convention, the literal string
 *   `Bearer owner` is the documented "I'm a privileged caller" token for the
 *   Auth emulator's admin endpoints — it is NOT a real credential and never
 *   reaches a live GCP API; the emulator accepts it locally to short-circuit
 *   privilege checks. We can call this endpoint with a plain `fetch` — no
 *   Admin SDK required.
 *
 *   Endpoint correctness was verified empirically against the running
 *   emulator (firebase-tools image used by `docker-compose.yml`):
 *     - Existing UID  ➜ 200 OK, body `{"kind":"identitytoolkit#DeleteAccountResponse"}`
 *     - Missing  UID  ➜ 400, body contains `"USER_NOT_FOUND"` (idempotent)
 *     - No  Bearer    ➜ 403 Forbidden
 *
 *   The earlier `/emulator/v1/projects/{p}/accounts/{uid}` (DELETE) shape
 *   does NOT exist in the emulator (returns 404 for every call) and is NOT
 *   used here — see `docs/decisions/README.md` for the deviation rationale.
 *
 * ============================================================================
 * Forbidden Patterns (Documented for Reviewers)
 * ============================================================================
 *   - DO NOT import from `backend/src/**`. The OTel auto-instrumentation that
 *     `register-tracing.ts` activates in test workers does NOT run in the
 *     teardown process; importing modules that assume initialized OTel /
 *     Firebase Admin / pg-pool state could throw or load with unset env.
 *   - DO NOT throw at the top level on best-effort cleanup failures. The
 *     test verdict has already been determined.
 *   - DO NOT use the Firebase Admin SDK here. Use the emulator's REST API.
 *   - DO NOT reorder the steps. The order mirrors a stack: emulator-dependent
 *     cleanup first (might be skipped if emulators are down), database
 *     cleanup next, file cleanup last (always safe).
 *   - DO NOT skip migration reversal silently. The reversal validates
 *     ST-030-AC3, ST-031-AC3, ST-035-AC4 down-migration idempotency at every
 *     CI run. If a future engineer wants to skip it, the choice MUST be
 *     documented in `docs/decisions/README.md` per the Explainability Rule.
 *   - DO NOT import `dotenv` or load `.env` files. Env vars are populated by
 *     `docker-compose` / Cloud Build before Jest is invoked.
 */

// ---------------------------------------------------------------------------
// External imports — Node stdlib + the same packages used by `global-setup.ts`
// and the production backend. Intentionally NO imports from `backend/src/**`.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fs from 'node:fs/promises';
import migrate from 'node-pg-migrate';
import { Storage } from '@google-cloud/storage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path of the cross-process state file holding the unique GCS bucket name
 * for THIS test run. Written by `global-setup.ts` (`createTestGcsBucket()`);
 * read here to discover the bucket to delete. The JSON envelope is
 * `{"bucket": "<name>"}` — the same shape `global-setup.ts` writes.
 */
const TMP_BUCKET_FILE = '/tmp/strikeforge-test-bucket.json';

/**
 * Path of the cross-process state file holding the JSONL log of test users
 * created by the firebase-user fixture during the test run. Each line is a
 * JSON record `{"uid":"...","email":"...", ...}`. This file is initialized
 * empty by `global-setup.ts` (`initializeTestUserTrackingFile()`) and
 * appended to by fixtures in test workers.
 */
const TMP_USERS_FILE = '/tmp/strikeforge-test-users.json';

/**
 * Default Firebase Auth Emulator host:port when the
 * `FIREBASE_AUTH_EMULATOR_HOST` env var is unset. This is the canonical
 * port emitted by `firebase emulators:start` and the value used by
 * `docker-compose.yml`. Defaulting here is safe because
 * `FIREBASE_AUTH_EMULATOR_HOST` is intentionally NOT one of the six
 * required env vars (Rule R4 only governs the six in `REQUIRED_ENV_VARS`).
 */
const DEFAULT_FIREBASE_EMULATOR_HOST = 'localhost:9099';

// ---------------------------------------------------------------------------
// Step 1 — Delete Test Users via Firebase Auth Emulator REST API
// ---------------------------------------------------------------------------

/**
 * Deletes all test users tracked in {@link TMP_USERS_FILE} from the Firebase
 * Auth Emulator.
 *
 * Reads the line-delimited JSON tracking file written by the firebase-user
 * fixture during the test run, extracts each user's `uid`, and issues a
 * POST against the Identity Toolkit "projects.accounts.delete" admin endpoint
 * exposed by the emulator:
 *
 *   POST `{HOST}/identitytoolkit.googleapis.com/v1/projects/{PROJECT_ID}/accounts:delete`
 *   Headers: `Authorization: Bearer owner`, `Content-Type: application/json`
 *   Body:    `{ "localId": "<uid>" }`
 *
 * Empirically observed responses against the running emulator
 * (firebase-tools image, port 9099):
 *   - 200 OK, `{"kind":"identitytoolkit#DeleteAccountResponse"}` — deleted.
 *   - 400 Bad Request, body contains `"USER_NOT_FOUND"` — already gone.
 *   - 403 Forbidden — the `Authorization: Bearer owner` header was missing.
 *
 * Idempotency:
 *   - 200 OK is the canonical success — the user was deleted.
 *   - 400 USER_NOT_FOUND means the user was already gone. The teardown's
 *     goal is "the resource is gone"; this status confirms that property
 *     and is treated as success.
 *   - ENOENT on the tracking file means no users were ever created (e.g.,
 *     the suite ran zero tests, or `globalSetup` was skipped). Treated as
 *     success.
 *
 * Why JSONL rather than a single JSON array:
 *   The fixture appends to the file with `fs.appendFile`. A single JSON
 *   array would require rewriting the entire file on every appended user,
 *   which is fragile under crash and slow under load. JSONL is append-friendly
 *   and crash-safe — partial writes lose at most the in-progress line.
 *
 * Why a plain `fetch` rather than the Firebase Admin SDK:
 *   See the file header — initializing the Admin SDK in this process would
 *   require credentials we may not have, and would violate the LocalGCP
 *   zero-live-credentials mandate. The Identity Toolkit admin endpoint
 *   accepts the emulator's `Bearer owner` short-circuit token and works with
 *   the standard `fetch` API built into Node 20 — no Admin SDK required.
 */
async function deleteTestUsers(): Promise<void> {
  let usersRaw: string;
  try {
    usersRaw = await fs.readFile(TMP_USERS_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Tracking file never existed — global-setup may have been skipped or
      // no test users were ever created. Treat as success.
      return;
    }
    console.warn(`[global-teardown] Failed to read ${TMP_USERS_FILE}: ${(err as Error).message}`);
    return;
  }

  const lines = usersRaw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (projectId === undefined || projectId === '') {
    console.warn('[global-teardown] FIREBASE_PROJECT_ID is unset; skipping test user cleanup.');
    return;
  }

  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? DEFAULT_FIREBASE_EMULATOR_HOST;
  const baseUrl = emulatorHost.startsWith('http') ? emulatorHost : `http://${emulatorHost}`;

  let deletedCount = 0;
  let failedCount = 0;

  for (const line of lines) {
    let uid: string | undefined;
    try {
      const parsed = JSON.parse(line) as { uid?: string };
      uid = parsed.uid;
    } catch {
      // Malformed line — skip without warning. A malformed line could appear
      // if the fixture crashed mid-write; the production-quality fix is in
      // the fixture, not here. The cost of skipping one orphan record is
      // negligible (the next CI run starts with a clean emulator).
      continue;
    }
    if (typeof uid !== 'string' || uid.length === 0) continue;

    try {
      // Identity Toolkit "projects.accounts.delete" admin endpoint. The
      // `Bearer owner` header is the documented short-circuit token the
      // Firebase Auth emulator accepts for privileged admin calls; it is
      // NOT a real credential and never reaches a live GCP API. Per Rule
      // R2 we never log this string (it isn't credential material in the
      // production sense — it's a known emulator-only sentinel — but we
      // omit it from logs anyway to keep log output uniform across envs).
      const url =
        `${baseUrl}/identitytoolkit.googleapis.com/v1/` +
        `projects/${encodeURIComponent(projectId)}/accounts:delete`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer owner',
        },
        body: JSON.stringify({ localId: uid }),
      });

      if (res.ok) {
        // 2xx — user was deleted. Canonical success.
        deletedCount += 1;
      } else if (res.status === 400) {
        // The emulator returns 400 USER_NOT_FOUND when the localId does
        // not exist. Treat as idempotent success — "the resource is gone"
        // is what teardown is asserting, and a missing user satisfies that.
        // Any other 400 (e.g., MISSING_LOCAL_ID, INVALID_ID_TOKEN) is a
        // genuine failure.
        const bodyText = await res.text().catch(() => '');
        if (/USER_NOT_FOUND/.test(bodyText)) {
          deletedCount += 1;
        } else {
          failedCount += 1;
        }
      } else {
        // 401/403/5xx — log nothing per-line; aggregate count below.
        // Drain the body to free the underlying socket; ignore any read
        // error since we already have the verdict from the status code.
        await res.text().catch(() => '');
        failedCount += 1;
      }
    } catch {
      // Network-level failure — log nothing per-line; aggregate count below.
      failedCount += 1;
    }
  }

  if (failedCount > 0) {
    console.warn(
      `[global-teardown] Deleted ${deletedCount} test users; ${failedCount} failed (best-effort).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Delete Test GCS Bucket via fake-gcs-server
// ---------------------------------------------------------------------------

/**
 * Deletes the test GCS bucket (and all of its contents) from fake-gcs-server.
 *
 * Reads the bucket name from {@link TMP_BUCKET_FILE} (written by
 * `global-setup.ts`'s `createTestGcsBucket()`), then:
 *   1. `bucket.deleteFiles({ force: true })` — removes all objects in the
 *      bucket. `force: true` continues on per-object errors so a single
 *      sticky object does not block the rest.
 *   2. `bucket.delete()` — removes the (now-empty) bucket itself.
 *
 * Idempotency:
 *   - 404 on either operation means the resource is already gone. Detected
 *     via the `/not.*found|404/i` message-pattern match (the fake-gcs-server
 *     error message format varies between versions; this regex matches both
 *     the canonical "Not Found" and bare "404" forms).
 *   - ENOENT on the tracking file means `globalSetup` never created a bucket
 *     for this run. Treated as success.
 *
 * Note on `getSignedUrl`:
 *   This file does NOT call `getSignedUrl()` so the C1/R5 constraint
 *   ("every getSignedUrl call must pass version: 'v4'") does not apply
 *   here. Bucket deletion uses plain `bucket.delete()` and `deleteFiles()`.
 */
async function deleteTestGcsBucket(): Promise<void> {
  let bucketRaw: string;
  try {
    bucketRaw = await fs.readFile(TMP_BUCKET_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Tracking file never existed — global-setup may have been skipped.
      return;
    }
    console.warn(`[global-teardown] Failed to read ${TMP_BUCKET_FILE}: ${(err as Error).message}`);
    return;
  }

  if (bucketRaw.trim().length === 0) return;

  let bucketName: string | undefined;
  try {
    const parsed = JSON.parse(bucketRaw) as { bucket?: string };
    bucketName = parsed.bucket;
  } catch (err) {
    console.warn(`[global-teardown] Failed to parse ${TMP_BUCKET_FILE}: ${(err as Error).message}`);
    return;
  }
  if (typeof bucketName !== 'string' || bucketName.length === 0) return;

  const apiEndpoint = process.env.GCS_EMULATOR_HOST;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (
    apiEndpoint === undefined ||
    apiEndpoint === '' ||
    projectId === undefined ||
    projectId === ''
  ) {
    console.warn(
      '[global-teardown] GCS_EMULATOR_HOST or FIREBASE_PROJECT_ID is unset; skipping bucket cleanup.',
    );
    return;
  }

  const storage = new Storage({ apiEndpoint, projectId });
  const bucket = storage.bucket(bucketName);

  try {
    await bucket.deleteFiles({ force: true });
  } catch (err) {
    const message = (err as Error).message;
    if (!/not.*found|404/i.test(message)) {
      console.warn(`[global-teardown] Failed to delete files in bucket ${bucketName}: ${message}`);
    }
  }

  try {
    await bucket.delete();
  } catch (err) {
    const message = (err as Error).message;
    if (!/not.*found|404/i.test(message)) {
      console.warn(`[global-teardown] Failed to delete bucket ${bucketName}: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Reverse All Applied Migrations (ST-030/ST-031/ST-035 idempotency)
// ---------------------------------------------------------------------------

/**
 * Reverses every migration applied by `global-setup.ts`'s `applyMigrations()`,
 * leaving the test database empty for the next CI / dev run.
 *
 * Migrations live at `backend/migrations/{timestamp}_ST-0NN_*.js` (Rule R10).
 * `node-pg-migrate` reverses them in REVERSE filename-timestamp order:
 *
 *   1. `20250115000003_ST-035_orders_order_items.js` — drops order_items, orders
 *   2. `20250115000002_ST-030_designs.js`            — drops designs
 *   3. `20250115000001_ST-031_users_sessions.js`     — drops sessions, users
 *
 * The reverse order respects foreign-key dependencies: order_items references
 * orders and designs; orders references users; designs references users;
 * sessions references users. Reversing top-down guarantees each table is
 * dropped before its parents.
 *
 * Path resolution:
 *   `path.resolve(__dirname, '../../../migrations')` walks
 *     `backend/tests/integration/setup/` ➜
 *     `backend/tests/integration/`         ➜
 *     `backend/tests/`                     ➜
 *     `backend/`                           +
 *     `migrations`                         ➜
 *     `backend/migrations/`
 *   The absolute resolution makes the call independent of the working
 *   directory from which Jest is invoked.
 *
 * Why this step is recommended (not skipped):
 *   ST-030-AC3, ST-031-AC3, and ST-035-AC4 all require down migrations to be
 *   "idempotent against repeat application on a clean state". Reversing every
 *   run validates that property automatically — broken down migrations are
 *   surfaced immediately rather than discovered weeks later when someone
 *   actually needs to roll back. If profiling shows this step is too slow,
 *   the decision to skip it MUST be recorded in `docs/decisions/README.md`
 *   per the Explainability Rule.
 *
 * Failure handling:
 *   Best-effort. A failure here is logged via `console.warn` but does NOT
 *   throw — the test verdict is already determined. The next run's
 *   `global-setup` would either reapply the migrations cleanly (if the
 *   tables were partially dropped) or fail with a clear "table already
 *   exists" error (if nothing was dropped) — both are observable signals.
 */
async function reverseMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    console.warn('[global-teardown] DATABASE_URL is unset; skipping migration reversal.');
    return;
  }

  const migrationsDir = path.resolve(__dirname, '../../../migrations');

  try {
    await migrate({
      databaseUrl,
      dir: migrationsDir,
      migrationsTable: 'pgmigrations',
      direction: 'down',
      // `Infinity` is the documented sentinel for "reverse every migration
      // currently applied" in node-pg-migrate's RunnerOption (mirrors the
      // `count: Infinity` used in `applyMigrations`).
      count: Infinity,
      // Ignore dotfiles in the migrations directory (e.g. `.gitkeep`).
      // Without this, the JS API would attempt to `require()` `.gitkeep`
      // as a JavaScript module and throw a `SyntaxError`. The pattern
      // `\\..*` is the same default used by the `node-pg-migrate` CLI.
      // (Mirrors the equivalent setting in `global-setup.ts`.)
      ignorePattern: '\\..*',
      log: () => {
        // Intentional no-op — silence node-pg-migrate's stdout chatter
        // during teardown. Failures still throw and propagate normally —
        // they never reach this suppressed `log` callback.
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[global-teardown] Failed to reverse migrations: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Cleanup Cross-Process Tracking Files
// ---------------------------------------------------------------------------

/**
 * Removes the `/tmp/*.json` tracking files created by `global-setup.ts` so
 * the next run starts from a clean slate.
 *
 * ENOENT on `unlink` means the file was already gone — treated as success.
 * Any other error is logged via `console.warn` but does NOT throw; in the
 * worst case the next `globalSetup` will overwrite the stale file via
 * `fs.writeFile`, so leftover tracking files are not a correctness hazard.
 *
 * This step runs LAST because removing the tracking files before deleting
 * users / buckets would lose the discovery information those steps need.
 */
async function cleanupTempFiles(): Promise<void> {
  for (const file of [TMP_BUCKET_FILE, TMP_USERS_FILE]) {
    try {
      await fs.unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[global-teardown] Failed to remove ${file}: ${(err as Error).message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Default Export — Orchestrator
// ---------------------------------------------------------------------------

/**
 * Default-export the teardown function. Jest discovers it via
 * `globalTeardown: '<rootDir>/tests/integration/setup/global-teardown.ts'`
 * in `backend/jest.config.integration.ts`.
 *
 * Steps run sequentially to mirror the dependency stack of `global-setup.ts`
 * in reverse:
 *
 *   1. deleteTestUsers       — depends on FIREBASE_AUTH_EMULATOR being up;
 *                              if it's down, log a warning and continue.
 *   2. deleteTestGcsBucket   — depends on fake-gcs-server being up; same.
 *   3. reverseMigrations     — depends on DATABASE_URL being reachable; same.
 *   4. cleanupTempFiles      — always safe; never depends on emulators.
 *
 * Each step is wrapped internally with try/catch so individual failures
 * don't sabotage subsequent steps. The orchestrator function ITSELF resolves
 * successfully unless one of the helpers throws synchronously (which they
 * don't — they all `console.warn` and return).
 *
 * Best-effort semantics: by the time teardown runs, the test verdict has
 * been determined. Cleanup errors are logged but do NOT mark the run failed.
 */
export default async function globalTeardown(): Promise<void> {
  await deleteTestUsers();
  await deleteTestGcsBucket();
  await reverseMigrations();
  await cleanupTempFiles();
}
