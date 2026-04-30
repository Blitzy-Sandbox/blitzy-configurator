/**
 * `env-fail-fast.integration.test.ts` — Cross-cutting integration test for
 * Rule R4: fail-fast on missing required environment variables.
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - Rule R4 (AAP §0.8.1, VERBATIM):
 *       "All six required environment variables MUST throw at startup when
 *        unset — no fallback values in source code. Verification: starting
 *        the backend without `DATABASE_URL` set exits non-zero with a
 *        descriptive error within 2 seconds."
 *   - User Example (AAP §0.2.2, VERBATIM):
 *       "Starting backend without `DATABASE_URL` exits non-zero with a
 *        descriptive error within 2 seconds."
 *   - Story ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       integration test suite scope and ST-044-AC3 (assertion-vs-environment
 *       failure distinction in the integration report).
 *   - AAP §0.1.3: enumerates the six required variables (DATABASE_URL,
 *     FIREBASE_PROJECT_ID, GCS_BUCKET_NAME, GCS_EMULATOR_HOST,
 *     COVERAGE_THRESHOLD, GCP_REGION) with documented consumers and failure
 *     modes.
 *
 * ============================================================================
 * Module Under Test
 * ============================================================================
 *   - `backend/src/config/env.ts` — exports REQUIRED_ENV_VARS,
 *     MissingEnvVarError, requireEnv(), validateEnv(), env accessor.
 *   - `backend/src/index.ts` — entry point that invokes validateEnv() in its
 *     synchronous bootstrap phase and converts any thrown MissingEnvVarError
 *     into `console.error('[fatal] backend failed to start:', message)` +
 *     `process.exit(1)`.
 *
 * ============================================================================
 * Why Subprocess (and not in-process supertest)
 * ============================================================================
 *   This is the ONLY test in the entire integration suite that uses
 *   `child_process.spawn`. Every other integration test uses in-process
 *   supertest against a `createApp({ ... })` factory. The subprocess
 *   approach is REQUIRED here because:
 *
 *     - Rule R4 verifies STARTUP behaviour: exit code, exit timing, and
 *       descriptive error on stderr. These can only be observed from
 *       OUTSIDE the process under test.
 *     - The backend's `process.exit(1)` call would terminate the Jest
 *       runner if executed in-process; spawning a child process isolates
 *       the exit-on-error path from Jest's own lifecycle.
 *     - Measuring a 2-second budget requires a clean Node startup,
 *       uncontaminated by Jest's worker overhead. The subprocess starts
 *       a fresh Node process whose elapsed time is directly comparable
 *       to a production `node dist/index.js` invocation.
 *
 * ============================================================================
 * Why `dist/index.js`, NOT `ts-node src/index.ts`
 * ============================================================================
 *   - ts-node's cold-start TypeScript compilation adds ~500–1500ms to
 *     every invocation. Rule R4's 2-second budget is ABSOLUTE; using
 *     ts-node would falsely fail R4 verification because the budget
 *     would be eaten by ts-node, not by the env validator.
 *   - The compiled `dist/index.js` runs in node directly with realistic
 *     production-like startup characteristics (the same artifact Cloud
 *     Run executes in production).
 *
 *   The pre-test sentinel below throws a CLEAR error if `dist/index.js`
 *   is missing, with explicit remediation guidance ("run npm run build").
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance
 * ============================================================================
 *   - Rule R1 (story ACs authoritative): every assertion below traces to
 *     Rule R4's verbatim user example.
 *   - Rule R2 (no credentials in logs): placeholder env values are
 *     non-credential strings; no real secrets are used in the spawned env.
 *   - Rule R3 (Firebase Admin only): no JWT-library imports.
 *   - Rule R4 (no env defaults): THIS FILE IS THE AUTHORITATIVE
 *     VERIFICATION OF R4. Every test asserts non-zero exit when a
 *     required var is unset.
 *   - Rule R6 / C4 (OTel registration order): the spawned subprocess
 *     loads the production index.ts which imports tracing.ts FIRST; this
 *     test verifies the subsequent env-validation step is also
 *     fail-fast, completing the full bootstrap-order contract.
 *   - Rule R8 (gates fail closed): timeouts are treated as test failures
 *     (`timedOut === true` is asserted false); no try/catch swallows
 *     assertion failures.
 *   - Rule R9 (no payment): N/A — no payment terms or processors involved.
 */

// stdlib only — DO NOT import any application module here. The test
// exercises the BUILT artifact `dist/index.js` as a subprocess; importing
// `backend/src/config/env` would defeat the purpose of testing startup
// behaviour from outside the process under test.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The six environment variables Rule R4 (AAP §0.1.3) requires. Order matches
 * `REQUIRED_ENV_VARS` in `backend/src/config/env.ts` so a future engineer who
 * audits both files sees identical sequences (eases diffs and review).
 *
 * The `as const` assertion turns this into a readonly tuple of literal
 * string types — that is what enables the `RequiredEnvVar` union type below
 * to be the precise discriminated union of the six variable names.
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
 * Discriminated union of the six required environment variable names.
 * Derived from {@link REQUIRED_ENV_VARS}; adding a member there propagates
 * automatically into the type system.
 */
type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * Rule R4's strict 2-second budget (per AAP §0.2.2 verbatim). Assertions
 * use this as a `toBeLessThan(...)` upper bound.
 */
const RULE_R4_BUDGET_MS = 2_000;

/**
 * Spawn timeout — strictly greater than {@link RULE_R4_BUDGET_MS} so a
 * compliant fail-fast process exits via `process.exit(N)` BEFORE the
 * timer fires. A process that hits this timer is, by definition, in
 * Rule R4 violation: the test marks it `timedOut === true` and the
 * subsequent assertion (`expect(timedOut).toBe(false)`) fails the test.
 *
 * The 500ms margin (2_500 - 2_000) absorbs measurement overhead — Jest's
 * timer granularity, OS process-table latency, and `Date.now()` resolution
 * are all in the low-millisecond range, so 500ms is comfortably wider than
 * any plausible measurement noise while still being tight enough to
 * surface real regressions.
 */
const SPAWN_TIMEOUT_MS = 2_500;

/**
 * Brief-spawn duration used by the sanity counter-test (test 6.4 below).
 * When all six env vars ARE set, the env validator must NOT throw. The
 * process will continue into DB-pool / Firebase-Admin / GCS init steps
 * (which legitimately fail because we use placeholder values that point
 * at nothing real), but those failures are NOT what the counter-test
 * verifies — the counter-test only verifies that the env validator
 * itself does not produce a `MissingEnvVarError` within the first 500ms.
 */
const BRIEF_SPAWN_DURATION_MS = 500;

/**
 * Absolute filesystem path to the compiled backend entry point.
 *
 * Resolved RELATIVE to this test file's location:
 *   __dirname = .../backend/tests/integration/observability/
 *   ../        = .../backend/tests/integration/
 *   ../../     = .../backend/tests/
 *   ../../../  = .../backend/
 *   dist/      = .../backend/dist/
 *   index.js   = .../backend/dist/index.js
 *
 * Using `path.resolve` (not string concatenation) produces a canonical
 * absolute path that survives platform-specific separator differences and
 * works correctly regardless of the working directory from which Jest is
 * invoked. The constant is anchored to `__dirname` so it remains correct
 * even if the test is executed from CI workspaces with unusual cwd
 * conventions.
 */
const DIST_INDEX_PATH = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

/**
 * Synthetic but plausible values for each required env var. None of these
 * values reach a real backend — the backend either:
 *   (a) exits during env validation when one is omitted (the negative
 *       cases in tests 6.1, 6.2, 6.3); OR
 *   (b) progresses past env validation but fails later when it tries to
 *       open a TCP connection to the placeholder host (the positive case
 *       in test 6.4, which kills the process at 500ms).
 *
 * The values were chosen for syntactic plausibility (a parseable
 * connection string, a UUID-ish project id, a single-character bucket
 * name etc.) so that a downstream defect that accepts these placeholders
 * as valid would still be detected by integration tests that EXERCISE
 * the real DB / GCS code paths (which run with real LocalGCP fixtures
 * elsewhere in the suite).
 */
const PLACEHOLDER_VALUES: Readonly<Record<RequiredEnvVar, string>> = {
  DATABASE_URL: 'postgres://placeholder@127.0.0.1:5432/placeholder',
  FIREBASE_PROJECT_ID: 'placeholder-project-id',
  GCS_BUCKET_NAME: 'placeholder-bucket',
  GCS_EMULATOR_HOST: 'http://127.0.0.1:9999',
  COVERAGE_THRESHOLD: '80',
  GCP_REGION: 'us-central1',
};

// ---------------------------------------------------------------------------
// Subprocess Outcome Type and Helpers
// ---------------------------------------------------------------------------

/**
 * Result shape produced by every subprocess spawn helper in this file.
 *
 * Field semantics:
 *   - `exitCode`:   the numeric exit code if the process exited cleanly
 *                   via `process.exit(N)`; `null` if the process was
 *                   terminated by a signal.
 *   - `signal`:     the signal name if the process was terminated by a
 *                   signal (e.g. `'SIGKILL'` from the spawn timeout);
 *                   `null` if the process exited cleanly.
 *   - `stdout`:     accumulated stdout output (utf-8 decoded).
 *   - `stderr`:     accumulated stderr output (utf-8 decoded). Rule R4's
 *                   "descriptive error" lives here.
 *   - `elapsedMs`:  wall-clock time from spawn-start to exit. Rule R4's
 *                   2-second budget is asserted against this field.
 *   - `timedOut`:   `true` iff the SPAWN_TIMEOUT_MS killTimer fired
 *                   before the child process exited. A `true` value is
 *                   itself a Rule R4 violation (a hung backend cannot
 *                   satisfy "exits within 2 seconds").
 */
interface SpawnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * Spawn the compiled backend with the given environment and resolve with
 * a {@link SpawnOutcome} describing the outcome.
 *
 * Contract:
 *   - NEVER rejects. Even on spawn error or timeout, the returned
 *     promise resolves with an outcome that the caller can inspect.
 *     Test assertions then determine pass/fail. This keeps the test
 *     code linear and makes Rule R8 (fail-closed) compliance easier
 *     to audit — there is no try/catch path that could accidentally
 *     swallow a failure.
 *   - On spawn timeout, the child is killed with `SIGKILL`. SIGKILL
 *     (not SIGTERM) is intentional: a hung process is itself a Rule
 *     R4 violation, so we do not give the child an opportunity to
 *     graceful-shutdown. The test asserts `timedOut === false`,
 *     converting the timeout into a failed test.
 *   - The child inherits no parent file descriptors except the three
 *     stdio streams: stdin is `'ignore'` (the backend never reads
 *     stdin), stdout and stderr are `'pipe'` so the test can capture
 *     them verbatim.
 *   - `shell: false` ensures we invoke the literal `node` binary, not
 *     a shell wrapper. This avoids cross-platform shell-quoting hazards
 *     and minimises spawn latency (no shell fork).
 *
 * @param env - Environment variables for the spawned process. Pass the
 *              output of {@link buildEnvOmitting} to control which of
 *              the six required vars is unset.
 * @returns Promise resolving to the {@link SpawnOutcome}.
 */
function spawnBackend(env: NodeJS.ProcessEnv): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const start = Date.now();
    const child: ChildProcess = spawn('node', [DIST_INDEX_PATH], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // The optional-chaining `?.` calls guard against the (unlikely)
    // case where stdout / stderr were not piped due to a spawn failure.
    // Buffer concatenation via `+=` is acceptable here because the
    // backend's stderr output is bounded — it prints exactly one line
    // (`[fatal] backend failed to start: ...`) before exiting.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // killTimer enforces the 2.5-second spawn timeout. If the child
    // exits cleanly before the timer fires, `child.on('exit', ...)`
    // clears it. If the timer fires first, we mark `timedOut = true`
    // and SIGKILL the child to ensure deterministic teardown.
    const killTimer = setTimeout(() => {
      timedOut = true;
      // The kill() call may itself throw (e.g. ESRCH if the process
      // already exited in a tiny race window). The catch is empty
      // because the subsequent `exit` event handler will resolve the
      // promise with the correct timedOut state regardless.
      try {
        child.kill('SIGKILL');
      } catch {
        // Intentionally empty: race-window with natural process exit.
      }
    }, SPAWN_TIMEOUT_MS);

    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - start,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        elapsedMs: Date.now() - start,
        timedOut: false,
      });
    });
  });
}

/**
 * Spawn the compiled backend, but kill it after `durationMs` regardless
 * of whether it has exited. This is used by the sanity counter-test
 * (6.4 below) to verify the env validator does NOT throw when all six
 * required vars are set.
 *
 * The process WILL continue past env validation and attempt to open a
 * DB connection, init Firebase Admin, and connect to GCS — those steps
 * legitimately fail with placeholder env values, but the failure modes
 * (DB connection refused, Firebase auth failure, GCS host unreachable)
 * are out of scope for this test. The counter-test therefore inspects
 * stderr/stdout produced WITHIN the first {@link BRIEF_SPAWN_DURATION_MS}
 * milliseconds, asserts that the env validator's error signatures
 * (`MissingEnvVarError`, `Required environment variable ... is not set`)
 * do NOT appear, and tolerates other failure messages.
 *
 * @param env - Environment variables for the spawned process. Use
 *              `buildEnvOmitting(null)` to populate all six vars with
 *              placeholders.
 * @param durationMs - How long to let the process run before SIGKILL.
 * @returns Promise resolving to the {@link SpawnOutcome}.
 */
function spawnBackendBriefly(env: NodeJS.ProcessEnv, durationMs: number): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    const start = Date.now();
    const child: ChildProcess = spawn('node', [DIST_INDEX_PATH], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // After `durationMs`, SIGKILL the child if it is still running.
    // The 'exit' handler will then resolve the promise with the
    // accumulated outcome.
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Intentionally empty: race-window with natural process exit.
      }
    }, durationMs);

    // The brief-spawn semantics resolve on first exit OR on error.
    // `resolved` guards against a double-resolve in the corner case
    // where 'exit' and 'error' both fire (e.g. spawn failure followed
    // by a synthetic exit event).
    const finalize = (outcome: SpawnOutcome): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(killTimer);
      resolve(outcome);
    };

    child.on('exit', (code, signal) => {
      finalize({
        exitCode: code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on('error', (err) => {
      finalize({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        elapsedMs: Date.now() - start,
        timedOut: false,
      });
    });
  });
}

/**
 * Build a {@link NodeJS.ProcessEnv} that:
 *   1. Inherits the parent's PATH / HOME / and other system vars (so the
 *      `node` binary can be found and OS conveniences like `tmp` work).
 *   2. CLEARS any inherited values for the six required Rule R4 vars
 *      (in case the parent has them set — e.g. CI runners often set
 *      DATABASE_URL globally).
 *   3. POPULATES placeholder values for each required var EXCEPT the one
 *      named in `omit`. When `omit` is `null`, ALL six are populated
 *      (used by the sanity counter-test).
 *   4. Sets `NODE_ENV='test'` and `NO_COLOR='1'` for predictable output
 *      parsing.
 *   5. Deletes `NODE_OPTIONS` so a parent shell with `NODE_OPTIONS=
 *      --inspect` (common in dev workflows) cannot slow down or alter
 *      the spawned child's startup behaviour. Without this delete, a
 *      `--inspect` flag could keep the child alive past the 2.5-second
 *      timeout (waiting for a debugger to attach).
 *
 * Rationale for "build from scratch" rather than "delete one var":
 *   The naive approach `{ ...process.env, DATABASE_URL: undefined }`
 *   does NOT reliably remove the variable — `undefined` properties are
 *   serialised differently by different Node versions and may leak the
 *   parent's value. Explicit enumeration is the only robust pattern.
 *
 * @param omit - The single required var to omit (`null` = omit none).
 * @returns A new env object suitable for `spawn(node, [...], { env })`.
 */
function buildEnvOmitting(omit: RequiredEnvVar | null): NodeJS.ProcessEnv {
  // Start from a copy of the parent env so PATH / HOME / etc. propagate.
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Step 1: scrub any inherited values for the six required vars.
  // This is critical because CI runners (and developer shells with
  // sourced `.env` files) often have these vars set globally — without
  // explicit deletion, a "missing var" test would silently pass with
  // the parent's value.
  for (const v of REQUIRED_ENV_VARS) {
    delete env[v];
  }

  // Step 2: populate placeholders for every required var EXCEPT the
  // one being tested for absence. When `omit` is null, ALL six are
  // populated (sanity counter-test path).
  for (const v of REQUIRED_ENV_VARS) {
    if (v !== omit) {
      env[v] = PLACEHOLDER_VALUES[v];
    }
  }

  // Step 3: pin NODE_ENV to 'test' for predictable behaviour. The
  // backend reads NODE_ENV with a 'development' fallback (see
  // backend/src/index.ts step 1a) — we set 'test' here so log
  // verbosity and other env-sensitive defaults are deterministic.
  env['NODE_ENV'] = 'test';

  // Step 4: disable ANSI colour codes so stderr regex assertions are
  // not confounded by escape sequences. Pino respects NO_COLOR=1.
  env['NO_COLOR'] = '1';

  // Step 5: remove NODE_OPTIONS to prevent inherited inspector flags
  // (e.g. `--inspect`) from delaying the child's startup. A debugger
  // attach can add seconds of latency, breaking Rule R4's 2-second
  // budget through no fault of the env validator.
  delete env['NODE_OPTIONS'];

  return env;
}

// ---------------------------------------------------------------------------
// Pre-Test Build Sentinel
// ---------------------------------------------------------------------------

/**
 * Before any test runs, verify `dist/index.js` exists. The test cannot
 * meaningfully proceed without the compiled artifact (Rule R4's 2-second
 * budget makes ts-node startup unsuitable; see the file-level comment).
 *
 * The thrown error includes EXPLICIT remediation guidance — operators
 * reading the failure in CI logs should know exactly what to run. The
 * preferred remedy is to add a `pretest:integration` npm script that
 * invokes `npm run build` automatically; this beforeAll is a defensive
 * backstop in case that script is removed or skipped.
 *
 * `fs.existsSync` is the correct primitive here because `beforeAll` is
 * the appropriate place for synchronous setup checks; an `async` fs
 * variant would only complicate the sentinel without any benefit.
 */
beforeAll((): void => {
  if (!fs.existsSync(DIST_INDEX_PATH)) {
    throw new Error(
      `env-fail-fast tests require ${DIST_INDEX_PATH} to exist. ` +
        `Run "npm run build" inside backend/ before "npm run test:integration", ` +
        `or have CI invoke build before integration tests. ` +
        `(This is required because Rule R4's 2-second budget makes ts-node startup unsuitable.)`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Rule R4 — fail-fast on missing env vars (subprocess integration)', () => {
  // The integration suite's per-suite hook (`per-suite.ts`) sets a 30-second
  // per-test timeout. This file's tests each run ≤ SPAWN_TIMEOUT_MS (2.5s),
  // and we have at most 30+ sub-tests via parameterisation, so 60s is
  // comfortably sufficient even when CI runners are slow. Setting it
  // explicitly here documents the intent and prevents per-suite drift.
  jest.setTimeout(60_000);

  // -------------------------------------------------------------------------
  // 6.1 — AAP §0.2.2 verbatim verification
  // -------------------------------------------------------------------------

  describe('Rule R4 — verbatim AAP user example: missing DATABASE_URL', () => {
    it('starting backend without DATABASE_URL exits non-zero within 2 seconds with a descriptive error', async () => {
      // Arrange: build an env that contains every required var EXCEPT
      // DATABASE_URL — exactly the configuration the AAP §0.2.2 user
      // example tests.
      const env = buildEnvOmitting('DATABASE_URL');

      // Act: spawn the compiled backend and observe its exit behaviour.
      const outcome = await spawnBackend(env);

      // Assert (1): the spawn killTimer must NOT have fired. A timed-out
      // process is itself a Rule R4 violation regardless of any other
      // assertion below.
      expect(outcome.timedOut).toBe(false);

      // Assert (2): the process must have exited within Rule R4's strict
      // 2-second budget. This is the literal numeric assertion of the
      // AAP §0.2.2 user example.
      expect(outcome.elapsedMs).toBeLessThan(RULE_R4_BUDGET_MS);

      // Assert (3): the exit code must be non-zero. Rule R4's "exits
      // non-zero" requirement.
      expect(outcome.exitCode).not.toBe(0);

      // Assert (4): the process must have exited cleanly via
      // process.exit(N), not been killed by a signal. A signal-terminated
      // process indicates the env validator did not detect the missing
      // var (the killTimer had to step in) — that would be a Rule R4
      // failure mode.
      expect(outcome.exitCode).not.toBeNull();
      expect(outcome.signal).toBeNull();

      // Assert (5): the descriptive error must mention DATABASE_URL by
      // name. Operators reading the error in CI logs need to know
      // EXACTLY which variable is missing — a generic "env error" would
      // not satisfy "descriptive error" per Rule R4.
      const combined = `${outcome.stderr}\n${outcome.stdout}`;
      expect(combined).toMatch(/DATABASE_URL/);

      // Assert (6): the error must include a fail-flavoured keyword for
      // human readability (matches the literal MissingEnvVarError
      // message: "Required environment variable ... is not set. This is
      // a fatal misconfiguration ...").
      expect(combined).toMatch(/required|missing|not set|fatal|failed/i);
    });
  });

  // -------------------------------------------------------------------------
  // 6.2 — Every required env var causes fail-fast
  // -------------------------------------------------------------------------

  describe('Rule R4 — every required env var causes fail-fast on startup', () => {
    // `describe.each` parameterises the entire describe block over the six
    // required variables, producing 6 × 5 = 30 sub-tests. Each sub-test
    // verifies a distinct facet of the fail-fast contract for one variable.
    //
    // The subprocess is spawned ONCE in `beforeAll` per variable; the
    // resulting outcome is then asserted against in five separate `it`
    // blocks. This keeps the suite fast (one spawn per variable, not five)
    // while preserving precise per-assertion failure messages in Jest's
    // test report.
    describe.each(REQUIRED_ENV_VARS)('when %s is unset', (varName) => {
      let outcome: SpawnOutcome;

      beforeAll(async () => {
        outcome = await spawnBackend(buildEnvOmitting(varName));
        // Note: SPAWN_TIMEOUT_MS + 1_000ms safety margin for the
        // describe-level beforeAll. The spawn itself is bounded by
        // SPAWN_TIMEOUT_MS internally; the +1_000ms allows for Promise
        // resolution overhead.
      }, SPAWN_TIMEOUT_MS + 1_000);

      it('exits non-zero (does NOT exit 0)', () => {
        // Rule R4: exits non-zero. Zero exit would falsely indicate
        // success on a misconfigured environment.
        expect(outcome.exitCode).not.toBe(0);
      });

      it('exits within 2 seconds (Rule R4 budget)', () => {
        // Rule R4's strict 2-second budget. The killTimer guard
        // (`timedOut`) provides defence-in-depth: even if elapsedMs is
        // measured incorrectly somehow, a true `timedOut` flag would
        // still fail this test.
        expect(outcome.timedOut).toBe(false);
        expect(outcome.elapsedMs).toBeLessThan(RULE_R4_BUDGET_MS);
      });

      it('process exits cleanly via process.exit (no SIGKILL/SIGTERM signal)', () => {
        // A clean fail-fast looks like exitCode=1, signal=null. A
        // signal-terminated process (exitCode=null, signal='SIGKILL')
        // means the killTimer had to force teardown — a Rule R4
        // violation even if the elapsed time happened to be < 2s.
        expect(outcome.signal).toBeNull();
        expect(outcome.exitCode).not.toBeNull();
      });

      it('descriptive error names the missing variable in stderr or stdout', () => {
        // Operators must be told EXACTLY which variable is missing.
        // The literal MissingEnvVarError message (constructed in
        // `backend/src/config/env.ts`) interpolates the variable name
        // into the message, so a literal `.toContain(varName)` is the
        // most precise possible assertion.
        const combined = `${outcome.stderr}\n${outcome.stdout}`;
        expect(combined).toContain(varName);
      });

      it('descriptive error includes a fail/required keyword for human readability', () => {
        // Human-readability check. The MissingEnvVarError message
        // contains the substring "Required environment variable" and
        // the word "fatal", both of which match this regex.
        const combined = `${outcome.stderr}\n${outcome.stdout}`;
        expect(combined).toMatch(/required|missing|not set|fatal|failed/i);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6.3 — Empty string is treated as unset
  // -------------------------------------------------------------------------

  describe('Rule R4 — empty string is treated as unset', () => {
    // The env.ts contract treats `process.env.X === ''` the same as
    // `process.env.X === undefined`. This is essential because a
    // `.env` file with `DATABASE_URL=` (no value after the equals
    // sign) is indistinguishable from "operator forgot to set it" and
    // MUST fail.
    //
    // Whitespace-only values (e.g. `DATABASE_URL=   `) are
    // INTENTIONALLY accepted — see the doc comment on requireEnv() in
    // env.ts for rationale. We do NOT test whitespace here because
    // doing so would lock in the current policy as a contract; the
    // documented policy is that whitespace passes through, so a future
    // tightening would not break this test.
    it('empty string DATABASE_URL is rejected the same as unset', async () => {
      // Arrange: populate all six vars, then blank out DATABASE_URL.
      // This is distinct from `buildEnvOmitting('DATABASE_URL')` —
      // here the variable IS present but empty.
      const env = buildEnvOmitting(null);
      env['DATABASE_URL'] = '';

      // Act
      const outcome = await spawnBackend(env);

      // Assert: same shape as test 6.1's positive case.
      expect(outcome.timedOut).toBe(false);
      expect(outcome.elapsedMs).toBeLessThan(RULE_R4_BUDGET_MS);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.exitCode).not.toBeNull();
      expect(outcome.signal).toBeNull();

      const combined = `${outcome.stderr}\n${outcome.stdout}`;
      expect(combined).toContain('DATABASE_URL');
      expect(combined).toMatch(/required|missing|not set|fatal|failed/i);
    });
  });

  // -------------------------------------------------------------------------
  // 6.4 — Sanity counter-test: all six set => env validator passes
  // -------------------------------------------------------------------------

  describe('Rule R4 — all six variables set: env validator should NOT trip', () => {
    // Without this counter-test, a defective implementation that
    // ALWAYS throws would pass tests 6.1–6.3 but be useless. The
    // counter-test confirms the validator passes when env is properly
    // populated.
    //
    // The process WILL legitimately fail later (placeholder DB host,
    // placeholder GCS host) but those failures are NOT what the
    // counter-test verifies. The test inspects ONLY the first 500ms of
    // output and asserts the env validator's specific error signatures
    // do NOT appear.
    it('with all six required env vars set, env validator does not throw within first 500ms', async () => {
      // Arrange: all six populated with placeholders.
      const env = buildEnvOmitting(null);

      // Act: spawn briefly (kill at 500ms). The process may exit
      // earlier on its own due to DB/GCS init failures — that's fine.
      // We only care about the env validator step.
      const outcome = await spawnBackendBriefly(env, BRIEF_SPAWN_DURATION_MS);

      // Assert: the env validator's error signatures must NOT appear.
      //
      // The MissingEnvVarError message starts with the literal text
      // "Required environment variable" and ends with "is not set"
      // (constructed in `backend/src/config/env.ts`). Either of these
      // appearing in the early output means the env validator threw,
      // which contradicts the test's premise that all six vars are
      // set with valid placeholders.
      //
      // The error class name "MissingEnvVarError" is also asserted
      // absent — pino emits this as the `err.name` field in error log
      // records, and the bootstrap's stderr fallback in `index.ts`
      // includes it via `err.message` (which contains the wrapper
      // "Required environment variable ..." text from our regex
      // already, but checking the class name independently catches
      // alternate error-printing paths).
      const combined = `${outcome.stderr}\n${outcome.stdout}`;
      expect(combined).not.toMatch(/MissingEnvVarError/);
      expect(combined).not.toMatch(/Required environment variable.*is not set/);
    });
  });
});
