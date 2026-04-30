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
 *     - The OTel SDK is registered first via `require('../../../src/tracing')`.
 *     - The workaround runs strictly AFTER SDK registration but still
 *       BEFORE any test framework or application code (since this file is
 *       in `setupFiles`).
 *     - The workaround does NOT load any application module; it only
 *       triggers re-evaluation of two core modules (http, https) through
 *       RITM, which is exactly the path RITM was designed to intercept.
 *
 * OTLP exporter protocol selection (Jest-VM-teardown ReferenceError prevention):
 *
 *   QA Issue #3 (MINOR — "ReferenceError: You are trying to import a file
 *   after the Jest environment has been torn down. From
 *   tests/integration/routes/auth.integration.test.ts. at
 *   Immediate._onImmediate (../node_modules/@opentelemetry/
 *   otlp-proto-exporter-base/src/platform/node/
 *   OTLPProtoExporterNodeBase.ts:78:26)").
 *
 *   ROOT CAUSE: `backend/src/tracing.ts` constructs
 *   `new NodeSDK({ resource, instrumentations: [...] })` WITHOUT an explicit
 *   `traceExporter`, so the SDK relies on its default selection from
 *   `OTEL_EXPORTER_OTLP_PROTOCOL` (defaulting to `'http/protobuf'`). The
 *   resulting `OTLPProtoTraceExporter` extends `OTLPProtoExporterNodeBase`,
 *   whose `send(...)` method has a LAZY-LOAD path:
 *
 *     send(objects, onSuccess, onError) {
 *       if (!this._send) {
 *         setImmediate(() => {
 *           const { send } = require('./util');   // <-- the offender
 *           ...
 *         });
 *       }
 *     }
 *
 *   The `require('./util')` inside the `setImmediate` callback flows
 *   through Jest's per-VM module loader. If a span's exporter `send()` is
 *   invoked AFTER the test's VM has been torn down (e.g. a final BSP flush
 *   triggered as the suite winds down), the `setImmediate` callback fires
 *   on the host event loop while the VM context is gone — and
 *   `require('./util')` throws the ReferenceError.
 *
 *   The HTTP/JSON exporter (`OTLPExporterNodeBase` in
 *   `@opentelemetry/otlp-exporter-base/build/src/platform/node/`) does NOT
 *   use the `setImmediate` lazy-load pattern: its `send(...)` synchronously
 *   serialises the request via `JSON.stringify(serviceRequest)` and calls
 *   `sendWithHttp(...)` immediately. There is no deferred `require`. So
 *   switching the protocol from `http/protobuf` to `http/json` eliminates
 *   the ReferenceError vector entirely while keeping the SDK fully
 *   functional — span IDs are still generated normally, traceparent
 *   propagates normally, and `trace.getActiveSpan()` still returns a real
 *   span (verified by Gate T1-I).
 *
 *   We DELIBERATELY DO NOT set `OTEL_TRACES_EXPORTER=none` because that
 *   sentinel value tells `TracerProviderWithEnvExporter` to skip TracerProvider
 *   initialization entirely:
 *     if (traceExportersList[0] === 'none') {
 *       diag.warn(
 *         'OTEL_TRACES_EXPORTER contains "none". SDK will not be initialized.'
 *       );
 *     }
 *   With the SDK uninitialized, `trace.getTracer(...)` returns the global
 *   NoopTracer, every span has the all-zeros traceId/spanId, `traceFlags=0`,
 *   `isRecording()=false`, and the integration suite's
 *   `toMatchTraceId()` / `toMatchSpanId()` matchers reject those values per
 *   the W3C trace-context specification. That breaks Gate T1-I and ST-049.
 *
 *   Defence-in-depth: we also extend `OTEL_BSP_SCHEDULE_DELAY` and
 *   `OTEL_BSP_EXPORT_TIMEOUT` to 10 minutes. The BatchSpanProcessor's
 *   periodic timer fires every 5 seconds by default and flushes any queued
 *   spans through the exporter's `send(...)`. Tests typically run in tens
 *   of seconds, so a 10-minute schedule delay guarantees no periodic
 *   flush fires during the test lifetime. Combined with the protocol
 *   switch, this gives BOTH a structural fix (no setImmediate-lazy-load
 *   path) AND a quiescence guarantee (no deferred work scheduled at all
 *   during the test lifetime).
 *
 *   The env-var assignment MUST run BEFORE the
 *   `require('../../../src/tracing')` statement on the line below: the
 *   SDK reads these variables synchronously inside its constructor /
 *   `start()` call, which runs at module-load time of `tracing.ts`.
 *
 *   These are OTel-internal selection / tuning variables — they are NOT
 *   part of the six-required-vars set declared in AAP §0.1.3 (which
 *   are validated by `backend/src/config/env.ts` per Rule R4). Setting
 *   them here in the test-only `setupFiles` shim does not affect
 *   production behaviour because this file is referenced exclusively
 *   by `jest.config.integration.ts`.
 *
 *   Story / decision-log coverage:
 *     - QA Issue #3 (MINOR): "OTel ReferenceError after Jest environment
 *       teardown" — resolved by switching to the HTTP/JSON exporter
 *       (no setImmediate lazy-load) AND extending BSP schedule delay
 *       beyond test lifetime.
 *     - Preserves ST-049-AC1, ST-049-AC2, ST-049-AC3 (real spans,
 *       traceparent propagation, log/trace correlation).
 *
 * ---------------------------------------------------------------------------
 * Cross-test-file SDK idempotency + OTel API global pre-population
 * (QA Issue #1 — CRITICAL — ST-044-AC2 deterministic fixtures)
 * ---------------------------------------------------------------------------
 *
 *   ROOT CAUSE (synthesized from exhaustive empirical + source-code
 *   archaeology):
 *
 *   Jest evaluates this `setupFiles` shim ONCE PER TEST FILE in a separate
 *   per-file VM context. Empirically verified state-isolation matrix:
 *
 *     | Object                                     | Cross-file shared? |
 *     |--------------------------------------------|--------------------|
 *     | `globalThis[Symbol.for(...)]`              | NO  (per-VM)       |
 *     | `process[Symbol.for(...)]`                 | NO  (per-VM)       |
 *     | `AsyncLocalStorage` class                  | YES (process-wide) |
 *     | `import http from 'node:http'` (default)   | YES (process-wide) |
 *     | `import * as http from 'node:http'`        | NO  (per-VM)       |
 *
 *   Without idempotency, EVERY test file's evaluation of this shim:
 *     1. Re-evaluates `tracing.ts`, which calls `new NodeSDK(...).start()`
 *        — creating a NEW `NodeTracerProvider`, a NEW
 *        `AsyncLocalStorageContextManager`, and a NEW W3C propagator.
 *     2. Calls `tracerProvider.register({})` which writes the new TP/CM/
 *        propagator into `globalThis[Symbol.for('opentelemetry.js.api.1')]`
 *        — but this `globalThis` is THIS test file's per-VM globalThis.
 *     3. Re-runs `Module.prototype.require.call(...)` workaround which
 *        triggers `HttpInstrumentation._wrap(http, 'request', ...)`.
 *
 *   `InstrumentationBase._wrap` (from
 *   `@opentelemetry/instrumentation/build/src/platform/node/instrumentation.js`)
 *   unwraps any existing `__wrapped` layer before re-wrapping:
 *
 *     this._wrap = (moduleExports, name, wrapper) => {
 *         if (isWrapped(moduleExports[name])) {
 *             this._unwrap(moduleExports, name);
 *         }
 *         return shimmer.wrap(moduleExports, name, wrapper);
 *     };
 *
 *   This peels back ONE layer (the previous file's instrumentation
 *   wrapper) before installing the new one. CRITICALLY, `correlation.ts`
 *   patches `http.request` via DIRECT property assignment WITHOUT setting
 *   the shimmer `__wrapped` flag, so `isWrapped()` returns `false` for
 *   the correlation wrapper. When file 7's `_wrap` runs, it doesn't peel
 *   off correlation's wrapper — it shimmer-wraps directly on top of
 *   correlation. The chain becomes:
 *     `Inst_7 wrapper -> correlation wrapper -> Inst_1 wrapper -> native`
 *   (where `Inst_2`..`Inst_6` were each peeled off by their successor).
 *
 *   `HttpInstrumentation._outgoingRequestFunction` (from
 *   `@opentelemetry/instrumentation-http/build/src/http.js`) closes over
 *   `api_1` — the `@opentelemetry/api` module that THIS instrumentation
 *   instance imported. Each test file's HttpInstrumentation closes over
 *   its OWN file's `api_1`. So:
 *     - `Inst_7.wrapper.api_1` = file 7's `@opentelemetry/api` instance.
 *     - `Inst_1.wrapper.api_1` = file 1's `@opentelemetry/api` instance.
 *
 *   Each `@opentelemetry/api` instance lazily reads from
 *   `globalThis[Symbol.for('opentelemetry.js.api.1')]` (per
 *   `@opentelemetry/api/build/src/internal/global-utils.js` — `getGlobal`
 *   reads `_global = globalThis` per `platform/node/globalThis.js`). Since
 *   each test file has its OWN `globalThis`, each file's API has its own
 *   view of the registered TP/CM/propagator.
 *
 *   FAILURE TRACE (file 7, when tracing tests run 7th):
 *     - File 7's test calls `withTraceContext(spanCtx, () => request(app).get(...))`:
 *       file 7's `trace.setSpanContext(...)` + `context.with(ctx, fn)` writes
 *       seeded context to CM_7 (file 7's ContextManager).
 *     - `request(app).get(...)` triggers `http.request` → outermost wrapper
 *       is `Inst_7` (file 7's wrap). `Inst_7.wrapper` reads file 7's
 *       `api_1.context.active()` → reads CM_7 → sees seeded ✓ — and
 *       injects traceparent with seeded traceId ✓.
 *     - `Inst_7.wrapper` calls `original(...)` which is correlation's
 *       wrapper (because file 7's `_wrap` peeled off file 6's Inst but
 *       not correlation). Correlation's wrapper passes through unchanged.
 *     - Correlation calls captured `originalRequest` = `Inst_1` wrapper
 *       (correlation captured it during file 1's setup before any later
 *       file's `_wrap` ran).
 *     - `Inst_1.wrapper` reads file 1's `api_1.context.active()` → reads
 *       file 1's globalThis CM → no active span (test seeded CM_7, not
 *       file 1's CM). `Inst_1` creates a fresh CLIENT span with a random
 *       traceId, then `propagation.inject(...)` OVERWRITES the traceparent
 *       header with that random traceId ✗.
 *     - HTTP request goes out with random traceparent, NOT the seeded one.
 *     - Server-side: outermost server wrapper extracts the random
 *       traceparent → creates SERVER span with random traceId → pino
 *       mixin reads file 7's `api_1.trace.getActiveSpan()` → reads file 7's
 *       globalThis CM → returns the new server span with random traceId
 *       ✗. Tests asserting `traceId === 'aabbccddeeff00112233445566778899'`
 *       fail.
 *
 *   THE FIX (two-layered):
 *     Layer 1 — SDK idempotency:
 *       Use a Symbol.for sentinel anchored on the process-shared `http`
 *       core module to track whether `tracing.ts` has been imported
 *       previously. Subsequent test files SKIP the
 *       `require('../../../src/tracing')` and the
 *       `Module.prototype.require.call(...)` workaround. Only the first
 *       test file's evaluation creates an SDK, registers TP/CM/propagator,
 *       and triggers RITM. This avoids the unwrap-rewrap cycle that
 *       creates the layered Inst_N wrappers.
 *
 *     Layer 2 — OTel API global pre-population:
 *       The first test file caches `globalThis[Symbol.for(
 *       'opentelemetry.js.api.1')]` (the OTel API global registry) onto
 *       the process-shared `http` core module. Subsequent test files
 *       READ that cached object and ASSIGN it to their own per-VM
 *       `globalThis[Symbol.for('opentelemetry.js.api.1')]` BEFORE any
 *       `@opentelemetry/api` consumer runs. As a result, every test
 *       file's API instance lazily reads from the SAME registered TP/CM/
 *       propagator that the first file created — eliminating the
 *       per-file CM divergence.
 *
 *   `Symbol.for(...)` returns a process-wide registered symbol; the
 *   `@opentelemetry/api` package uses major-version-keyed symbols (e.g.
 *   `Symbol.for('opentelemetry.js.api.1')` for v1.x). The hardcoded `'1'`
 *   suffix tracks `@opentelemetry/api` package version 1.8.0 (verified
 *   via `node_modules/@opentelemetry/api/build/src/version.js`). If the
 *   package's major version is bumped (e.g., to 2.x), update this
 *   constant accordingly.
 *
 *   Story coverage:
 *     - ST-044-AC2 (deterministic fixtures): identical pass/fail outcome
 *       regardless of test execution order.
 *     - ST-049-AC2/AC3/AC4: traceparent propagation and log/trace
 *       correlation work uniformly across all test files.
 *     - QA Issue #1 (CRITICAL): the cross-suite OTel state leak that
 *       caused 3-7 non-deterministic tracing/correlation failures is
 *       eliminated.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */

import http from 'node:http';

// Sentinel symbols are anchored on the process-shared `http` core module
// (NOT on `globalThis`, which is per-Jest-VM-isolated and would defeat
// the cross-file coordination this fix requires).
const SDK_INIT_SENTINEL: unique symbol = Symbol.for(
  '__blitzy_otel_sdk_init_done__',
) as never;
const SHARED_OTEL_API_SENTINEL: unique symbol = Symbol.for(
  '__blitzy_otel_api_global_cache__',
) as never;
// `@opentelemetry/api` storage key; major version follows
// `@opentelemetry/api` package major (currently 1.x). See
// `node_modules/@opentelemetry/api/build/src/internal/global-utils.js`:
//   `const GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for(
//      \`opentelemetry.js.api.\${major}\`);`
const OTEL_API_GLOBAL_KEY: unique symbol = Symbol.for(
  'opentelemetry.js.api.1',
) as never;

const httpAnchor = http as unknown as Record<symbol, unknown>;
const vmGlobal = globalThis as unknown as Record<symbol, unknown>;

if (httpAnchor[SDK_INIT_SENTINEL] !== true) {
  // ============================================================
  // FIRST TEST FILE: full SDK initialization
  // ============================================================
  process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json';
  process.env['OTEL_EXPORTER_OTLP_TRACES_PROTOCOL'] = 'http/json';
  process.env['OTEL_BSP_SCHEDULE_DELAY'] = '600000';
  process.env['OTEL_BSP_EXPORT_TIMEOUT'] = '600000';
  // Endpoint deliberately points to a guaranteed-closed loopback port so
  // any (in the unlikely event) export attempt fails fast with ECONNREFUSED
  // rather than blocking on a connect timeout. The port number 1 is below
  // the privileged-port cutoff and reliably refuses connections.
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://127.0.0.1:1';

  // Side-effect import of `tracing.ts` triggers `new NodeSDK(...).start()`
  // synchronously, which:
  //   - registers `@opentelemetry/auto-instrumentations-node`
  //   - constructs a `NodeTracerProvider` with an
  //     `AsyncLocalStorageContextManager` and W3CTraceContextPropagator
  //   - writes them to `globalThis[Symbol.for('opentelemetry.js.api.1')]`
  // We use `require()` (not the static `import` statement) here because
  // the import must be CONDITIONAL — it must NOT execute on subsequent
  // test files' evaluations. Static `import` is hoisted to module top
  // by TypeScript's CJS emit and would defeat the conditional.
  require('../../../src/tracing');

  // RITM trigger workaround for Jest's `_requireCoreModule` bypass.
  // Force `Module.prototype.require` to run RITM's `onRequire` callbacks
  // for the two core modules whose auto-instrumentations the integration
  // suite depends on. See the long-form documentation block above for
  // the full rationale.
  const Module = require('node:module') as {
    prototype: { require: (this: unknown, id: string) => unknown };
  };
  const triggerModule = {
    id: __filename,
    filename: __filename,
    loaded: true,
  };
  Module.prototype.require.call(triggerModule, 'node:http');
  Module.prototype.require.call(triggerModule, 'node:https');

  // Cache the registered OTel API global onto the process-shared http
  // module so subsequent test files can restore it onto their per-VM
  // `globalThis`. The cached value is the API root object whose shape is
  // (per `@opentelemetry/api/build/src/internal/global-utils.js`):
  //   { version: '1.8.0', trace: TraceAPI, context: ContextAPI,
  //     propagation: PropagationAPI, diag: DiagAPI, metrics: MetricsAPI }
  // All sub-fields hold the SAME singleton TracerProvider /
  // ContextManager / Propagator that `tracerProvider.register({})` wrote.
  const apiGlobal = vmGlobal[OTEL_API_GLOBAL_KEY];
  httpAnchor[SHARED_OTEL_API_SENTINEL] = apiGlobal;
  httpAnchor[SDK_INIT_SENTINEL] = true;
} else {
  // ============================================================
  // SUBSEQUENT TEST FILE: restore cached API onto this VM's globalThis
  // ============================================================
  //
  // We do NOT re-run `tracing.ts` — the SDK is already initialized
  // process-wide. The HttpInstrumentation wrappers from the first file
  // are still installed on the process-shared `http` module (their
  // closures keep file 1's `@opentelemetry/api` reachable across VMs
  // through GC reachability — file 1's VM teardown does not unhook the
  // closures from `http.request`).
  //
  // Restoring the cached API global onto THIS VM's globalThis ensures
  // that any `@opentelemetry/api` instance loaded by THIS test file's
  // code (test-only `import { trace, context } from '@opentelemetry/api'`,
  // pino mixin reading `trace.getActiveSpan()`, etc.) sees the SAME
  // TracerProvider / ContextManager / Propagator that file 1 registered.
  // This eliminates the per-file CM divergence that caused QA Issue #1.
  //
  // The assignment runs BEFORE `setupFilesAfterEnv` and BEFORE any test
  // module's `require()` chain, so by the time any `@opentelemetry/api`
  // consumer runs, the global is already populated.
  const cachedApi = httpAnchor[SHARED_OTEL_API_SENTINEL];
  if (cachedApi !== undefined) {
    vmGlobal[OTEL_API_GLOBAL_KEY] = cachedApi;
  }
}
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
