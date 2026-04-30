/**
 * Fail-fast environment variable validator (Rule R4).
 *
 * This is the SINGLE place in `backend/src/` where the six required env vars
 * are read for validation. Every downstream module (`db/pool.ts`,
 * `auth/firebase-admin.ts`, `services/gcs.service.ts`, etc.) imports
 * `requireEnv` (or the typed `env` accessor) from here instead of calling
 * `process.env` directly. This makes env-related failures reproducible in
 * exactly ONE place and gives the project a single audit point for
 * Rule R4 compliance.
 *
 * Authority:
 *   - AAP §0.8.1 Rule R4 (verbatim): "All six required environment variables
 *     MUST throw at startup when unset — no fallback values in source code.
 *     Verification: starting the backend without `DATABASE_URL` set exits
 *     non-zero with a descriptive error within 2 seconds."
 *   - AAP §0.1.3: enumerates the six required variables with documented
 *     consumers and failure modes.
 *   - AAP §0.2.2 User Example: `node dist/index.js` without `DATABASE_URL`
 *     must exit non-zero with a descriptive error within 2 seconds.
 *   - AAP §0.6.4 Track 1 T1-C: `requireEnv()` helper throwing on absent var
 *     per Rule R4.
 *
 * Design constraints (intentional):
 *   - ZERO imports. The module sits at the bottom of the dependency chain
 *     and is consumed by many other modules; importing anything else would
 *     risk circular dependencies and could delay the fail-fast check.
 *   - NO fallback / default values for the six required vars. Every required
 *     var either returns a non-empty string OR throws.
 *   - NO async behaviour. `requireEnv` and `validateEnv` are fully
 *     synchronous so the failure surfaces well within Rule R4's 2-second
 *     budget.
 *   - NO `process.exit()` calls. The module THROWS; the caller (specifically
 *     `backend/src/index.ts`) decides exit semantics.
 *   - Empty strings are treated as unset (a `DATABASE_URL=` line in `.env`
 *     with no value is indistinguishable from "forgot to set it" and MUST
 *     fail).
 *
 * Non-required env vars (`NODE_ENV`, `LOG_LEVEL`, `PORT`, `SERVICE_NAME`,
 * `SERVICE_VERSION`, `COMMIT_SHA`, `FIREBASE_AUTH_EMULATOR_HOST`, etc.) are
 * read directly via `process.env.*` at their use sites with documented safe
 * defaults; they do NOT fall under Rule R4's coverage. See AAP §0.1.3 and
 * `docs/decisions/README.md` for the rationale.
 */

/**
 * The six environment variables required by Rule R4 (AAP §0.1.3).
 *
 * This tuple is the canonical list referenced by {@link validateEnv}. Keep
 * the membership and ordering aligned with AAP §0.1.3. Adding or removing a
 * member here is a breaking change that requires corresponding updates to:
 *   - `.env.example` (documentation of required vars)
 *   - `docker-compose.yml` (env stanza for the `backend` service)
 *   - `backend/jest.config.integration.ts` (integration test fail-fast check)
 *   - `cloudbuild.yaml` (secret/env var injection for the deploy step)
 *   - `docs/decisions/README.md` (rationale for the change)
 *
 * The `as const` assertion turns this into a readonly tuple of literal
 * string types — that is what enables the {@link RequiredEnvVar} union type
 * below.
 */
export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'GCS_BUCKET_NAME',
  'GCS_EMULATOR_HOST',
  'COVERAGE_THRESHOLD',
  'GCP_REGION',
] as const;

/**
 * Union type of the six required environment variable names. Derived from
 * the {@link REQUIRED_ENV_VARS} tuple so adding/removing a member there
 * propagates automatically into the type system.
 *
 * Consumers that want compile-time safety can type their parameters with
 * `RequiredEnvVar` instead of `string` — the compiler will then reject any
 * call site that passes a name not in the canonical list.
 */
export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/**
 * Error thrown when a required environment variable is unset or empty.
 *
 * Rule R4 requires a DESCRIPTIVE error message; the message constructed
 * below includes:
 *   1. The variable name, so operators know exactly what is missing.
 *   2. The word "fatal" signalling unrecoverability (the process exits 1).
 *   3. Remediation guidance pointing at `.env` and deployment configuration.
 *
 * The `name` property is set explicitly so pino's serializer emits
 * `"name": "MissingEnvVarError"` in log records, aiding automated error
 * classification and alerting.
 *
 * The `variableName` property exposes the offending variable in a typed,
 * non-string-matched form so callers can react programmatically:
 *
 * ```ts
 * try {
 *   validateEnv();
 * } catch (err) {
 *   if (err instanceof MissingEnvVarError && err.variableName === 'DATABASE_URL') {
 *     // … specific remediation
 *   }
 *   throw err;
 * }
 * ```
 */
export class MissingEnvVarError extends Error {
  /**
   * The name of the environment variable that was unset or empty.
   * Captured separately from {@link Error.message} so callers can react
   * programmatically without parsing message strings.
   */
  public readonly variableName: string;

  constructor(name: string) {
    super(
      `Required environment variable "${name}" is not set. ` +
        'This is a fatal misconfiguration; the backend process cannot start. ' +
        `Verify your .env file or deployment configuration includes a non-empty value for ${name}.`,
    );
    // Explicitly set `name` so pino and other serializers emit a useful
    // class identifier instead of the generic "Error".
    this.name = 'MissingEnvVarError';
    this.variableName = name;
    // Preserve the prototype chain. This is a TypeScript defensive
    // best-practice for `extends Error`: even though we target ES2022
    // (which handles the chain correctly), the call is essentially free
    // and makes `instanceof` work even when the class is accidentally
    // transpiled to an older target by downstream tooling.
    Object.setPrototypeOf(this, MissingEnvVarError.prototype);
  }
}

/**
 * Reads `process.env[name]` and returns the value, or throws
 * {@link MissingEnvVarError} if the value is `undefined` or an empty
 * string.
 *
 * This is the PRIMARY fail-fast primitive. Callers in other modules
 * (e.g., `db/pool.ts`, `auth/firebase-admin.ts`, `services/gcs.service.ts`)
 * invoke `requireEnv('DATABASE_URL')` at the top of their initialisation
 * code; the throw propagates all the way up to the bootstrap's outer
 * `try`/`catch` in `backend/src/index.ts`, which logs and exits non-zero.
 *
 * Empty strings are treated as unset. A `DATABASE_URL=` line in `.env`
 * (no value after the equals sign) is indistinguishable from "forgot to
 * set it" and MUST fail. Whitespace-only values are accepted as a
 * documented policy — trimming is intentionally NOT performed because:
 *   - some legitimate values (e.g., spaces inside connection strings)
 *     would be corrupted by trimming;
 *   - whitespace-only values nearly always indicate a copy/paste error in
 *     `.env` that produces a fast, obvious downstream failure (e.g., a
 *     pg connection refusal) which is easier to diagnose than the silent
 *     failure mode of returning `''`.
 *
 * Running time is microseconds — trivially within Rule R4's 2-second
 * budget even when called many times during bootstrap.
 *
 * @param name - The environment variable name (uppercase by convention).
 * @returns The non-empty string value of the variable.
 * @throws {MissingEnvVarError} If the variable is `undefined` or `''`.
 */
export function requireEnv(name: string): string {
  // Bracket access keeps `requireEnv` agnostic to the variable name and
  // works correctly under TypeScript strict mode where `process.env` is
  // typed as `NodeJS.ProcessEnv` — bracket access returns `string |
  // undefined` which we explicitly narrow below.
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new MissingEnvVarError(name);
  }
  return value;
}

/**
 * Validates that all six required env vars are set and non-empty.
 *
 * Called ONCE from `backend/src/index.ts` during bootstrap, AFTER
 * `import './tracing'` (Rule R6 / Constraint C4 — tracing must register
 * its auto-instrumentations before any application import) and BEFORE
 * any other initialisation (DB pool, Firebase Admin SDK, GCS client,
 * route handlers). This ordering is critical: every downstream module
 * relies on a validated env, so a `validateEnv()` call here means
 * those modules can use {@link requireEnv} or {@link env} without
 * defensive null-checking.
 *
 * Throws on the FIRST missing var (fail-fast behaviour). Rationale:
 * any missing var is fatal; "collect all errors into a bag" is not
 * Rule R4's intent. A single error is actionable; a bag of errors
 * invites partial remediation that can mask a subsequent failure when
 * the operator fixes only the first reported var.
 *
 * Running time is microseconds — trivially within Rule R4's 2-second
 * budget.
 *
 * @throws {MissingEnvVarError} If any required var is unset or empty.
 *   The thrown error's `variableName` property identifies which var.
 */
export function validateEnv(): void {
  for (const name of REQUIRED_ENV_VARS) {
    // `requireEnv` throws `MissingEnvVarError` on the first missing
    // var; iteration halts there. The return value is intentionally
    // discarded — `validateEnv` is a void contract; consumers that
    // need values use `env.X` or `requireEnv('X')` at their use site.
    requireEnv(name);
  }
}

/**
 * Typed, frozen accessor for the six required env vars.
 *
 * Each property is a getter that calls {@link requireEnv} on access.
 * This provides belt-and-suspenders Rule R4 enforcement for rare cases
 * where {@link validateEnv} was called at startup but the env was
 * subsequently modified at runtime (e.g., by a test harness that
 * clears variables, or by a process that intentionally mutates
 * `process.env` for reload semantics).
 *
 * Two equivalent usage patterns are supported:
 *
 * ```ts
 * // Function-call style (recommended in most places):
 * const url = requireEnv('DATABASE_URL');
 *
 * // Struct-access style (equivalent; some modules prefer the typed shape):
 * const url = env.DATABASE_URL;
 * ```
 *
 * Both forms are equivalent in behaviour; choose based on readability
 * at the call site. Multi-var initialisations often read better with
 * the struct form; single-var initialisations often read better with
 * the function-call form.
 *
 * The object is frozen with `Object.freeze` so that properties cannot
 * be added, removed, or reassigned. Attempting `env.DATABASE_URL =
 * 'foo'` at runtime throws a `TypeError` in strict mode (which
 * TypeScript emits by default — see `alwaysStrict: true` in
 * `backend/tsconfig.json`).
 *
 * The explicit `Readonly<Record<RequiredEnvVar, string>>` annotation
 * is what tells the compiler the getters return `string` (not
 * `string | undefined`). This works because each getter wraps
 * {@link requireEnv}, whose return type is `string`.
 */
export const env: Readonly<Record<RequiredEnvVar, string>> = Object.freeze({
  get DATABASE_URL(): string {
    return requireEnv('DATABASE_URL');
  },
  get FIREBASE_PROJECT_ID(): string {
    return requireEnv('FIREBASE_PROJECT_ID');
  },
  get GCS_BUCKET_NAME(): string {
    return requireEnv('GCS_BUCKET_NAME');
  },
  get GCS_EMULATOR_HOST(): string {
    return requireEnv('GCS_EMULATOR_HOST');
  },
  get COVERAGE_THRESHOLD(): string {
    return requireEnv('COVERAGE_THRESHOLD');
  },
  get GCP_REGION(): string {
    return requireEnv('GCP_REGION');
  },
});
