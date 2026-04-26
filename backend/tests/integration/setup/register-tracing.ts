/**
 * Side-effect import: bootstraps OpenTelemetry auto-instrumentation BEFORE
 * any application module is required by Jest's integration test workers.
 *
 * Per AAP Rule R6 / Constraint C4 (verbatim from §0.8.1):
 *   "@opentelemetry/auto-instrumentations-node MUST be registered before any
 *   application imports."
 *   "auto-instrumentation monkey-patches pg, http, and express, and any
 *   application import before registration produces duplicate spans or no
 *   spans at all."
 *
 * Why `setupFiles` (this hook) and NOT `setupFilesAfterEnv`:
 *   Jest's `setupFiles` phase runs BEFORE the Jest framework loads — and,
 *   critically, BEFORE any test module's `require()` chain begins. It is
 *   the only phase in the Jest lifecycle that runs before `pg`, `http`, or
 *   `express` could be loaded by test code. Importing `../../../src/tracing`
 *   here triggers the OpenTelemetry NodeSDK initialization (synchronous
 *   `sdk.start()` at top-level of `backend/src/tracing.ts`) and registers
 *   the auto-instrumentations BEFORE any subsequent `require()` returns the
 *   target module. This is the integration-suite analogue of the first-line
 *   `import './tracing'` in `backend/src/index.ts`.
 *
 *   Moving this file to `setupFilesAfterEnv` would silently break Rule R6:
 *   by that phase, Jest's framework has already loaded some of the
 *   instrumentation targets (e.g. `http`), and instrumentation would be
 *   partial. Future maintainers MUST preserve `setupFiles` as the
 *   registration site (see `backend/jest.config.integration.ts`).
 *
 * Why a thin shim with no other logic:
 *   Any additional statement here introduces a `require()` of another
 *   module BEFORE OpenTelemetry registration — which is exactly the
 *   ordering bug Rule R6 / C4 forbids. Examples of forbidden additions:
 *     - `console.log(...)` injects `node:console`'s require chain.
 *     - `import '../../../src/logging/pino'` defeats the shim entirely.
 *     - `import { initializeFirebaseAdmin } from ...` defeats the shim.
 *   The single `import` statement below is the only safe payload for this
 *   file. Treat this constraint as inviolable.
 *
 * Coordination with neighbouring files:
 *   - `backend/jest.config.integration.ts` references this file as
 *     `setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts']`.
 *   - `backend/src/tracing.ts` is the side-effect target — it synchronously
 *     constructs the NodeSDK, calls `sdk.start()`, and registers SIGTERM /
 *     SIGINT shutdown handlers. Its `start()` is idempotent; multiple
 *     workers triggering it is safe.
 *   - `backend/tests/integration/setup/per-suite.ts` runs AFTER this shim
 *     (in the `setupFilesAfterEnv` phase). By the time `per-suite.ts`
 *     loads, `pg` / `http` / `express` are already monkey-patched.
 *
 * Story coverage:
 *   - ST-044-AC2 (deterministic fixtures, integration report): traces
 *     emitted during integration runs share the same trace-ID format
 *     across runs, supporting deterministic verification.
 *   - ST-049-AC1 (W3C traceparent propagation): auto-instrumentation
 *     registers HTTP middleware that reads inbound `traceparent` headers
 *     and propagates them on outbound calls.
 *   - ST-049-AC2 (trace records include trace/span IDs and correlation
 *     identifier): the active span made available by the SDK is consumed
 *     by `backend/src/logging/pino.ts` to join logs and traces.
 *
 * Path-resolution sanity check:
 *   `backend/tests/integration/setup/../../../src/tracing` resolves to
 *   `backend/src/tracing` (verified: `realpath` returns
 *   `<repo>/backend/src/tracing.ts`). The three-level `..` traversal is:
 *     setup/  -> integration/   (..)
 *     setup/  -> tests/         (../..)
 *     setup/  -> backend/       (../../..)
 *   then `src/tracing` lands on `backend/src/tracing.ts`. A tsconfig path
 *   alias (e.g. `@/tracing`) is intentionally NOT used here because alias
 *   resolution requires additional ts-jest configuration that may not be
 *   in effect during the `setupFiles` phase; plain relative paths are
 *   robust under all loaders.
 */
import '../../../src/tracing';
