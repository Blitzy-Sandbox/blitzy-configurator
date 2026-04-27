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
 *
 * Test-environment workaround for Jest's core-module require bypass:
 *   In production (Node.js CJS loader), every `require('http')` /
 *   `require('node:http')` flows through `Module.prototype.require`, which
 *   `@opentelemetry/instrumentation`'s `RequireInTheMiddleSingleton`
 *   monkey-patches at SDK start. The patched `Module.prototype.require`
 *   detects core modules and triggers `HttpInstrumentation`'s `onRequire`
 *   hook, which patches `http.request`, `http.get`, and
 *   `http.Server.prototype.emit` in place — installing both client-side
 *   `traceparent` injection and server-side root-span creation.
 *
 *   In Jest's test environment, however, core-module requires are routed
 *   through `jest-runtime`'s `_requireCoreModule(moduleName)`, which
 *   delegates to `require(moduleName)` from jest-runtime's own module
 *   scope. This call resolves through `jest-runtime`'s closure-bound
 *   `require`, completely bypassing the patched
 *   `Module.prototype.require`. Diagnostic verification:
 *     - `Module.prototype.require` IS RITM-patched after `sdk.start()`
 *       (source dump confirms RITM wrapper signature with
 *       `if (self._unhooked === true)`).
 *     - `require('node:http')` from this file returns http where
 *       `http.request.__wrapped === undefined` (RITM did not fire).
 *     - `Module.prototype.require.call({...}, 'node:http')` triggers RITM,
 *       which patches http in place and produces
 *       `http.request.__wrapped === true`.
 *   This means the SDK has registered all the right hooks, but Jest never
 *   gives them an opportunity to fire for core modules.
 *
 *   The workaround below explicitly invokes
 *   `Module.prototype.require.call(...)` for `node:http` and `node:https`,
 *   forcing RITM's `patchedRequire` to execute its registered onRequire
 *   callbacks (the OTel auto-instrumentations). RITM's exports cache is
 *   keyed on (filename, isBuiltin) and short-circuits on second invocation
 *   — so this is idempotent and safe to repeat. Both `request`/`get` and
 *   `Server.prototype.emit` get wrapped, enabling:
 *     - Client-side: outbound `http.request` / `http.get` injects W3C
 *       `traceparent` and propagates the active trace context (ST-049-AC4).
 *     - Server-side: inbound HTTP requests create a SERVER span as a child
 *       of any inbound `traceparent` header, so `trace.getActiveSpan()`
 *       returns a valid span context inside route handlers — and the pino
 *       mixin (`backend/src/logging/pino.ts`) attaches `traceId` / `spanId`
 *       to log records emitted during the request lifecycle (ST-049-AC2,
 *       Gate T1-I).
 *
 *   This workaround is bounded strictly to the test environment (this file
 *   is referenced ONLY by `jest.config.integration.ts` `setupFiles`).
 *   Production-runtime code (`backend/src/index.ts` -> `import './tracing'`
 *   -> `sdk.start()`) does NOT need this workaround because Node's standard
 *   CJS loader uses `Module.prototype.require` directly.
 *
 *   Rule R6 / C4 compliance:
 *     - The OTel SDK is registered first via `import '../../../src/tracing'`.
 *     - The workaround runs strictly AFTER SDK registration but still
 *       BEFORE any test framework or application code (since this file is
 *       in `setupFiles`).
 *     - The workaround does NOT load any application module; it only
 *       triggers re-evaluation of two core modules (http, https) through
 *       RITM, which is exactly the path RITM was designed to intercept.
 */
import '../../../src/tracing';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const Module = require('node:module') as {
  prototype: { require: (this: unknown, id: string) => unknown };
};

// A synthetic "trigger" module identity passed as `this` to
// `Module.prototype.require`. RITM uses `this` only for relative-path
// resolution of NON-core modules. For core modules (the http and https
// names below), RITM short-circuits resolution to the bare filename, so
// the `this` value's contents are not used by the lookup. The fields
// below match the minimum Node.js Module shape so any defensive
// inspection inside RITM still finds well-formed values.
const triggerModule = {
  id: __filename,
  filename: __filename,
  loaded: true,
};

// Trigger RITM's `onRequire` hook for the two core modules whose
// auto-instrumentations the integration suite depends on. Both calls are
// idempotent: on first invocation RITM caches the patched exports keyed
// on (filename, isBuiltin); subsequent calls return the cached patched
// module. The return values are intentionally discarded — the patches
// are applied IN-PLACE to the singleton core-module exports object, so
// every existing `require('http')` reference in the rest of the process
// sees the patched methods after these calls complete.
Module.prototype.require.call(triggerModule, 'node:http');
Module.prototype.require.call(triggerModule, 'node:https');
