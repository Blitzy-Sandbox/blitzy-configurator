/**
 * Unit tests for `backend/src/config/env.ts`.
 *
 * Verifies the four exported members (`requireEnv`, `validateEnv`,
 * `MissingEnvVarError`, `env`) against the Rule R4 fail-fast contract
 * (AAP §0.8.1):
 *
 *   "All six required environment variables MUST throw at startup when unset
 *    — no fallback values in source code."
 *
 * Authority:
 *   - Story ST-043 acceptance criteria (deterministic, local-only, no network):
 *       AC1: triggered on every PR
 *       AC2: produces a coverage report at a documented path
 *       AC3: failing assertion or coverage below threshold produces failed
 *            verdict; suite is deterministic
 *       AC4: runs locally without additional services or network access
 *   - The folder requirement (verbatim from this file's agent prompt):
 *       requireEnv('MISSING')   throws MissingEnvVarError
 *       requireEnv('EMPTY')     throws MissingEnvVarError when value is ''
 *       requireEnv('PRESENT')   returns the value when value is set
 *       validateEnv()           throws when ANY required var is missing
 *       validateEnv()           does NOT throw when all six vars are set
 *
 * Determinism (ST-043-AC3):
 *   Each describe block snapshots `process.env` to a local constant and
 *   reassigns it to a freshly-cloned object at the start of each test.
 *   The `afterEach` hook restores the original reference so subsequent
 *   tests, hooks, and Jest internals are unaffected. This pattern is the
 *   accepted way to isolate `process.env` mutations in Jest workers (which
 *   reuse a single Node process across many tests).
 *
 * Locality (ST-043-AC4):
 *   The suite makes ZERO network calls, opens ZERO files, and depends on
 *   ZERO services. Every assertion exercises pure synchronous JavaScript.
 *
 * @see backend/src/config/env.ts — module under test
 * @see tickets/stories/ST-043-unit-test-suite.md — story specification
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

import { env, MissingEnvVarError, requireEnv, validateEnv } from './env';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Canonical valid value for every one of the six required env vars.
 *
 * Each value is a syntactically reasonable example for its consumer
 * (`DATABASE_URL` is a valid Postgres connection string, `GCS_EMULATOR_HOST`
 * is a valid HTTP origin, `COVERAGE_THRESHOLD` is a numeric string in the
 * accepted 0–100 range). Values are intentionally stable across tests so
 * that assertions can compare against the literal.
 *
 * The variable names here MUST stay aligned with `REQUIRED_ENV_VARS` in
 * `env.ts`. Adding or removing a member in `env.ts` requires a
 * corresponding update here AND additional `it()` cases in
 * `describe('validateEnv', ...)` and `describe('env (frozen getter-based
 * accessor)', ...)` below.
 */
const ALL_REQUIRED_VARS: Readonly<Record<string, string>> = Object.freeze({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  FIREBASE_PROJECT_ID: 'test-project',
  GCS_BUCKET_NAME: 'test-bucket',
  GCS_EMULATOR_HOST: 'http://localhost:4443',
  COVERAGE_THRESHOLD: '80',
  GCP_REGION: 'us-central1',
});

// ---------------------------------------------------------------------------
// MissingEnvVarError — error class shape and message contract
// ---------------------------------------------------------------------------

describe('MissingEnvVarError', () => {
  it('is an instance of Error', () => {
    // The class extends Error, so `instanceof Error` MUST be true. Pino's
    // serializer (and any structured-logger error renderer) relies on this
    // chain to format the stack trace correctly.
    const err = new MissingEnvVarError('FOO');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of MissingEnvVarError (prototype chain preserved)', () => {
    // Constraint C2 of the env.ts implementation explicitly preserves the
    // prototype chain via `Object.setPrototypeOf` so `instanceof` works
    // reliably across transpilation targets.
    const err = new MissingEnvVarError('FOO');
    expect(err).toBeInstanceOf(MissingEnvVarError);
  });

  it('has name "MissingEnvVarError"', () => {
    // Pino's default error serializer uses `error.name` as the `name`
    // field in the JSON log record. A descriptive class name is required
    // so log-based alerting can route on a known identifier rather than
    // matching message substrings.
    const err = new MissingEnvVarError('FOO');
    expect(err.name).toBe('MissingEnvVarError');
  });

  it('includes the variable name in the message', () => {
    // Rule R4 mandates a "descriptive error". The variable name is the
    // single most actionable piece of information for the operator;
    // verifying its presence is the primary message contract.
    const err = new MissingEnvVarError('DATABASE_URL');
    expect(err.message).toContain('DATABASE_URL');
  });

  it('includes remediation guidance in the message', () => {
    // The message must guide developers toward the .env file or
    // deployment configuration. The implementation includes the words
    // "fatal", ".env", "deployment", and "configuration" — at least one
    // of those keywords must be present.
    const err = new MissingEnvVarError('DATABASE_URL');
    expect(err.message.toLowerCase()).toMatch(/\.env|deployment|configuration|fatal/);
  });

  it('exposes the variableName property for programmatic access', () => {
    // The `variableName` property exposes the offending variable in a
    // typed, non-string-matched form so callers can react programmatically
    // without parsing the message. This is the primary integration point
    // for downstream code that wants to handle different missing vars
    // differently.
    const err = new MissingEnvVarError('DATABASE_URL');
    expect(err.variableName).toBe('DATABASE_URL');
  });

  it('produces a non-empty message', () => {
    // Defensive check: ensures the constructor's super() call always
    // produces a non-empty Error.message. An empty message would defeat
    // Rule R4's "descriptive error" requirement.
    const err = new MissingEnvVarError('FOO');
    expect(err.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// requireEnv — primary fail-fast primitive
// ---------------------------------------------------------------------------

describe('requireEnv', () => {
  // Snapshot the live process.env reference once per describe block. Tests
  // mutate a CLONE so the original is never affected; afterEach restores
  // the original reference defensively.
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Create a fresh shallow clone for each test. Using a clone (rather
    // than mutating the live object directly) means a leaked `delete` or
    // assignment in one test cannot corrupt the next test's view.
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    // Restore the live object reference so Jest's own internal env reads
    // (notably the COVERAGE_THRESHOLD pickup at coverage-report time) see
    // the original values.
    process.env = ORIGINAL_ENV;
  });

  it('returns the value when the env var is set to a non-empty string', () => {
    process.env.TEST_VAR_PRESENT = 'hello-world';
    expect(requireEnv('TEST_VAR_PRESENT')).toBe('hello-world');
  });

  it('returns the value when the env var is a numeric string', () => {
    // Node coerces numbers to strings on assignment; this test documents
    // that the function returns the coerced string verbatim.
    process.env.TEST_VAR_NUMERIC = '42';
    expect(requireEnv('TEST_VAR_NUMERIC')).toBe('42');
  });

  it('returns the value when the env var is a URL', () => {
    // Real-world env vars (DATABASE_URL, GCS_EMULATOR_HOST) carry URLs
    // with special characters; this test verifies pass-through fidelity.
    process.env.TEST_VAR_URL = 'postgres://user:pass@localhost:5432/db';
    expect(requireEnv('TEST_VAR_URL')).toBe('postgres://user:pass@localhost:5432/db');
  });

  it('throws MissingEnvVarError when the env var is undefined', () => {
    delete process.env.TEST_VAR_MISSING;
    expect(() => requireEnv('TEST_VAR_MISSING')).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when the env var is an empty string', () => {
    // The "empty string is treated as unset" policy is critical: a
    // `DATABASE_URL=` line in `.env` produces an empty string, which
    // must fail the same way as a fully missing variable.
    process.env.TEST_VAR_EMPTY = '';
    expect(() => requireEnv('TEST_VAR_EMPTY')).toThrow(MissingEnvVarError);
  });

  it('throws with a descriptive message including the variable name (undefined case)', () => {
    delete process.env.SOME_SPECIFIC_VAR;
    // toThrow(regex) verifies the message contains the variable name
    // without requiring a try/catch dance.
    expect(() => requireEnv('SOME_SPECIFIC_VAR')).toThrow(/SOME_SPECIFIC_VAR/);
  });

  it('throws with a descriptive message including the variable name (empty case)', () => {
    process.env.SOME_OTHER_VAR = '';
    expect(() => requireEnv('SOME_OTHER_VAR')).toThrow(/SOME_OTHER_VAR/);
  });

  it('throw includes both error class and message context', () => {
    // Belt-and-suspenders: this assertion triple-checks that the thrown
    // value is BOTH the right class AND has a usable message. Using
    // expect.assertions guarantees the catch block executed at least
    // once (otherwise this test silently passes).
    expect.assertions(3);
    delete process.env.TEST_BOTH;
    try {
      requireEnv('TEST_BOTH');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvVarError);
      expect((err as MissingEnvVarError).variableName).toBe('TEST_BOTH');
      expect((err as Error).message).toContain('TEST_BOTH');
    }
  });

  it('accepts whitespace-only values (policy: no trimming)', () => {
    // A single space is NOT an empty string. This test documents the
    // intentional absence of trim() in requireEnv: trimming is rejected
    // because (a) some legitimate values include whitespace, and (b) a
    // whitespace-only value is most often a copy-paste error in `.env`
    // that surfaces a fast downstream failure (e.g., a refused pg
    // connection) easier to diagnose than a silent empty return.
    process.env.TEST_VAR_SPACE = ' ';
    expect(requireEnv('TEST_VAR_SPACE')).toBe(' ');
  });

  it('accepts a single non-empty character', () => {
    // Smallest possible non-empty value. Confirms there is no minimum
    // length check beyond the empty-string rejection.
    process.env.TEST_VAR_TINY = 'x';
    expect(requireEnv('TEST_VAR_TINY')).toBe('x');
  });

  it('is consulted by the env record getters (lazy validation)', () => {
    // Confirms the getter-based re-validation pattern. Rule R4 requires
    // fail-fast at startup; the getter form provides additional
    // belt-and-suspenders enforcement for any code path that mutates
    // process.env at runtime.
    delete process.env.DATABASE_URL;
    expect(() => env.DATABASE_URL).toThrow(MissingEnvVarError);
  });
});

// ---------------------------------------------------------------------------
// validateEnv — bulk validator for all six required vars
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Start from a clean slate populated with all six required vars set
    // to their canonical valid values. Individual tests then `delete` the
    // var they are exercising, so the negative path is unambiguous.
    process.env = { ...ALL_REQUIRED_VARS };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does not throw when all six required env vars are set', () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it('returns void (undefined) when all six required env vars are set', () => {
    // The function signature declares `: void` (Rule: validateEnv is a
    // void contract; consumers use `requireEnv` or `env.X` for values).
    // This assertion documents that contract.
    expect(validateEnv()).toBeUndefined();
  });

  it('throws MissingEnvVarError when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it('throws MissingEnvVarError when FIREBASE_PROJECT_ID is missing', () => {
    delete process.env.FIREBASE_PROJECT_ID;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('throws MissingEnvVarError when GCS_BUCKET_NAME is missing', () => {
    delete process.env.GCS_BUCKET_NAME;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/GCS_BUCKET_NAME/);
  });

  it('throws MissingEnvVarError when GCS_EMULATOR_HOST is missing', () => {
    delete process.env.GCS_EMULATOR_HOST;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/GCS_EMULATOR_HOST/);
  });

  it('throws MissingEnvVarError when COVERAGE_THRESHOLD is missing', () => {
    delete process.env.COVERAGE_THRESHOLD;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/COVERAGE_THRESHOLD/);
  });

  it('throws MissingEnvVarError when GCP_REGION is missing', () => {
    delete process.env.GCP_REGION;
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
    expect(() => validateEnv()).toThrow(/GCP_REGION/);
  });

  it('throws MissingEnvVarError when DATABASE_URL is an empty string', () => {
    // Empty strings are treated identically to undefined per the
    // requireEnv policy. validateEnv inherits this behavior because it
    // delegates to requireEnv internally.
    process.env.DATABASE_URL = '';
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when COVERAGE_THRESHOLD is an empty string', () => {
    // Confirms empty-string handling is consistent across all six vars,
    // not just DATABASE_URL. This guards against a future regression
    // where someone special-cases the implementation per-variable.
    process.env.COVERAGE_THRESHOLD = '';
    expect(() => validateEnv()).toThrow(MissingEnvVarError);
  });

  it('throws on the FIRST missing var (fail-fast), not a collected error bag', () => {
    // Design invariant: validateEnv halts at the first failure rather
    // than collecting all errors. Rationale: a single error is
    // actionable; a bag of errors invites partial remediation that masks
    // subsequent failures. The implementation iterates REQUIRED_ENV_VARS
    // in order, so deleting DATABASE_URL (first) and FIREBASE_PROJECT_ID
    // (second) MUST surface DATABASE_URL — never FIREBASE_PROJECT_ID.
    expect.assertions(3);
    delete process.env.DATABASE_URL;
    delete process.env.FIREBASE_PROJECT_ID;
    try {
      validateEnv();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvVarError);
      expect((err as MissingEnvVarError).variableName).toBe('DATABASE_URL');
      // The thrown error must NOT name the second-missing var.
      expect((err as Error).message).not.toContain('FIREBASE_PROJECT_ID');
    }
  });

  it('completes synchronously well within Rule R4 budget', () => {
    // Rule R4 specifies "exits non-zero within 2 seconds" for the entire
    // startup path. validateEnv itself is microsecond-scale; this test
    // verifies that it does not introduce any unexpected latency (e.g.,
    // accidental synchronous I/O or file reads).
    const start = Date.now();
    expect(() => validateEnv()).not.toThrow();
    const elapsed = Date.now() - start;
    // Generous 100ms ceiling to accommodate Jest harness overhead;
    // real-world execution is sub-millisecond.
    expect(elapsed).toBeLessThan(100);
  });

  it('is idempotent — repeated calls produce the same result', () => {
    // Calling validateEnv multiple times in succession must not change
    // the result or throw spuriously. This guards against any future
    // refactor that introduces accidental state mutation.
    expect(() => validateEnv()).not.toThrow();
    expect(() => validateEnv()).not.toThrow();
    expect(() => validateEnv()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// env — frozen getter-based accessor for the six required vars
// ---------------------------------------------------------------------------

describe('env (frozen getter-based accessor)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ALL_REQUIRED_VARS };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('exposes DATABASE_URL as a getter returning the current process.env value', () => {
    expect(env.DATABASE_URL).toBe(ALL_REQUIRED_VARS.DATABASE_URL);
  });

  it('exposes FIREBASE_PROJECT_ID as a getter', () => {
    expect(env.FIREBASE_PROJECT_ID).toBe(ALL_REQUIRED_VARS.FIREBASE_PROJECT_ID);
  });

  it('exposes GCS_BUCKET_NAME as a getter', () => {
    expect(env.GCS_BUCKET_NAME).toBe(ALL_REQUIRED_VARS.GCS_BUCKET_NAME);
  });

  it('exposes GCS_EMULATOR_HOST as a getter', () => {
    expect(env.GCS_EMULATOR_HOST).toBe(ALL_REQUIRED_VARS.GCS_EMULATOR_HOST);
  });

  it('exposes COVERAGE_THRESHOLD as a getter', () => {
    expect(env.COVERAGE_THRESHOLD).toBe(ALL_REQUIRED_VARS.COVERAGE_THRESHOLD);
  });

  it('exposes GCP_REGION as a getter', () => {
    expect(env.GCP_REGION).toBe(ALL_REQUIRED_VARS.GCP_REGION);
  });

  it('is frozen — Object.isFrozen returns true', () => {
    // Object.freeze prevents property addition/removal AND makes existing
    // properties non-configurable. This is the canonical immutability
    // assertion.
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('rejects mutation attempts in strict mode', () => {
    // TypeScript compiles to strict-mode JavaScript by default
    // (alwaysStrict: true in backend/tsconfig.json), so writes to a
    // frozen object throw TypeError at runtime. This test exercises the
    // runtime behavior; the TypeScript compiler also rejects the write
    // statically due to the `Readonly<...>` annotation on the export.
    expect(() => {
      // The cast bypasses the readonly type check so we can verify the
      // RUNTIME freeze behavior (the static check is a separate concern).
      (env as unknown as Record<string, string>).DATABASE_URL = 'mutated';
    }).toThrow(TypeError);
  });

  it('rejects new property addition (frozen object)', () => {
    expect(() => {
      (env as unknown as Record<string, string>).BRAND_NEW_KEY = 'value';
    }).toThrow(TypeError);
  });

  it('throws MissingEnvVarError when DATABASE_URL is unset at access time', () => {
    delete process.env.DATABASE_URL;
    expect(() => env.DATABASE_URL).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when FIREBASE_PROJECT_ID is unset at access time', () => {
    delete process.env.FIREBASE_PROJECT_ID;
    expect(() => env.FIREBASE_PROJECT_ID).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when GCS_BUCKET_NAME is unset at access time', () => {
    delete process.env.GCS_BUCKET_NAME;
    expect(() => env.GCS_BUCKET_NAME).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when GCS_EMULATOR_HOST is unset at access time', () => {
    delete process.env.GCS_EMULATOR_HOST;
    expect(() => env.GCS_EMULATOR_HOST).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when COVERAGE_THRESHOLD is unset at access time', () => {
    delete process.env.COVERAGE_THRESHOLD;
    expect(() => env.COVERAGE_THRESHOLD).toThrow(MissingEnvVarError);
  });

  it('throws MissingEnvVarError when GCP_REGION is unset at access time', () => {
    delete process.env.GCP_REGION;
    expect(() => env.GCP_REGION).toThrow(MissingEnvVarError);
  });

  it('getter re-validates on every access (Rule R4 belt-and-suspenders)', () => {
    // Access succeeds with the value set
    expect(env.DATABASE_URL).toBe(ALL_REQUIRED_VARS.DATABASE_URL);
    // Now remove the env var and observe that subsequent access throws.
    // This is the critical edge case: if env.DATABASE_URL were cached at
    // module-load time (instead of re-read on each access), this test
    // would fail.
    delete process.env.DATABASE_URL;
    expect(() => env.DATABASE_URL).toThrow(MissingEnvVarError);
  });

  it('getter returns the LATEST value when process.env mutates between accesses', () => {
    // Confirms the getter does not memoize. After the first read the
    // value MUST update if the underlying env var changes.
    expect(env.DATABASE_URL).toBe(ALL_REQUIRED_VARS.DATABASE_URL);
    process.env.DATABASE_URL = 'postgres://different-host:5432/db';
    expect(env.DATABASE_URL).toBe('postgres://different-host:5432/db');
  });
});
