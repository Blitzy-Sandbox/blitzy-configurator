/**
 * Environment variable validation.
 *
 * Per Rule R4 (NON-NEGOTIABLE): every required environment variable
 * MUST throw at startup when absent. There are no fallback values in
 * source code. The backend MUST exit non-zero within 2 seconds of
 * startup with a descriptive error message that names the missing
 * variable.
 *
 * This module is loaded eagerly from `backend/src/index.ts` AFTER the
 * tracing module (per Rule R6). The `loadEnv()` invocation at the
 * bottom of this file is what triggers the fail-fast behaviour.
 *
 * The six variables validated here are exactly the set listed in the
 * Agent Action Plan §0.1.3 and `.env.example`:
 *   1. DATABASE_URL
 *   2. FIREBASE_PROJECT_ID
 *   3. GCS_BUCKET_NAME
 *   4. GCS_EMULATOR_HOST
 *   5. COVERAGE_THRESHOLD
 *   6. GCP_REGION
 *
 * Consumers import the frozen `env` object below; they MUST NOT read
 * `process.env` directly (this avoids accidental fall-through to an
 * undefined value).
 */

/**
 * Reads `name` from process.env and throws a descriptive Error if the
 * variable is absent or empty.
 *
 * "Empty" includes both `undefined` and `''` because `cp .env.example
 * .env` produces a file where every variable is the empty string —
 * Rule R4 still requires a fail-fast in that case.
 *
 * @param name The environment variable name (uppercase by convention)
 * @returns The non-empty string value of the variable
 * @throws Error if the variable is unset or empty
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
        `Per Rule R4, the backend cannot start without it. ` +
        `See .env.example for documentation, then export the variable ` +
        `or copy .env.example to .env and edit.`,
    );
  }
  return value;
}

/**
 * Reads `name` from process.env, validates it via `requireEnv`, then
 * parses it as an integer between `min` and `max` (inclusive).
 *
 * Used for COVERAGE_THRESHOLD (0–100) per AAP §0.1.3.
 */
export function requireIntEnv(name: string, min: number, max: number): number {
  const raw = requireEnv(name);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Required environment variable ${name} must be an integer between ` +
        `${String(min)} and ${String(max)}; got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * The shape of validated environment configuration. Frozen after
 * construction so consumers cannot accidentally mutate it.
 */
export interface EnvConfig {
  readonly DATABASE_URL: string;
  readonly FIREBASE_PROJECT_ID: string;
  readonly GCS_BUCKET_NAME: string;
  readonly GCS_EMULATOR_HOST: string;
  readonly COVERAGE_THRESHOLD: number;
  readonly GCP_REGION: string;
  readonly NODE_ENV: string;
  readonly PORT: number;
  readonly SERVICE_NAME: string;
  readonly SERVICE_VERSION: string;
}

/**
 * Validates and freezes all required environment variables. Throws
 * synchronously on the first missing variable so the process exits
 * non-zero within Rule R4's 2-second budget.
 *
 * NODE_ENV, PORT, SERVICE_NAME, and SERVICE_VERSION are NOT in the
 * Rule R4 list because the AAP only enumerates six required vars.
 * They are read with sensible operational defaults.
 */
export function loadEnv(): EnvConfig {
  // Order matters: validate the six R4-required variables first so a
  // fail-fast surfaces the most-frequently-misconfigured variables
  // before we read the optional operational ones.
  const DATABASE_URL = requireEnv('DATABASE_URL');
  const FIREBASE_PROJECT_ID = requireEnv('FIREBASE_PROJECT_ID');
  const GCS_BUCKET_NAME = requireEnv('GCS_BUCKET_NAME');
  const GCS_EMULATOR_HOST = requireEnv('GCS_EMULATOR_HOST');
  const COVERAGE_THRESHOLD = requireIntEnv('COVERAGE_THRESHOLD', 0, 100);
  const GCP_REGION = requireEnv('GCP_REGION');

  // Operational variables (NOT in Rule R4 list); read with documented
  // defaults that match docker-compose.yml's environment block.
  const NODE_ENV = process.env['NODE_ENV'] ?? 'development';
  const portRaw = process.env['PORT'] ?? '3000';
  const PORT = Number.parseInt(portRaw, 10);
  if (Number.isNaN(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error(`PORT must be a valid TCP port (1–65535); got "${portRaw}".`);
  }
  const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';
  const SERVICE_VERSION = process.env['SERVICE_VERSION'] ?? '0.1.0';

  return Object.freeze({
    DATABASE_URL,
    FIREBASE_PROJECT_ID,
    GCS_BUCKET_NAME,
    GCS_EMULATOR_HOST,
    COVERAGE_THRESHOLD,
    GCP_REGION,
    NODE_ENV,
    PORT,
    SERVICE_NAME,
    SERVICE_VERSION,
  });
}
