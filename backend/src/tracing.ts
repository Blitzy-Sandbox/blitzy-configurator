/**
 * OpenTelemetry SDK bootstrap (Rule R6 / Constraint C4).
 *
 * This file MUST be imported as the FIRST line of `backend/src/index.ts`.
 * The OpenTelemetry auto-instrumentations monkey-patch `pg`, `http`, and
 * `express` at registration time, so any application module that loads
 * those packages BEFORE the SDK starts will produce missing or duplicate
 * spans. Per Constraint C4 the order is non-negotiable; per Rule R6
 * verification is by inspection (`import './tracing'` is the first
 * statement in `index.ts`).
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.6.5 (Track 1 / T1-D): "CREATE | backend/src/tracing.ts |
 *     Register @opentelemetry/auto-instrumentations-node BEFORE any
 *     application import per C4/R6".
 *   - §0.6.6 (Track 1 / T1-I): "MODIFY | backend/src/tracing.ts |
 *     Ensure W3C `traceparent` propagation across all service boundaries
 *     via OTel auto-instrumentation of `http` and `express` (C4 — no
 *     manual instrumentation)".
 *   - §0.8.1 Rule R6 / C4: registration MUST precede any application
 *     `import`/`require`; this file's import surface is limited to
 *     `@opentelemetry/*` packages and `process.env` reads (no relative
 *     imports from `./config`, `./logging`, etc.).
 *
 * Story coverage:
 *   - ST-047: structured logs join traces because pino mixin reads the
 *     active span via `@opentelemetry/api`. No coupling here — pino
 *     does the joining; the SDK simply provides the active span.
 *   - ST-048-AC2: every metric carries `service`, `environment`, and
 *     `version` labels; the OTel `Resource` defined here uses the same
 *     three values so traces and metrics correlate dimensionally.
 *   - ST-049-AC1: W3C `traceparent` header propagates automatically via
 *     `@opentelemetry/instrumentation-http`. ST-049-AC2 trace records
 *     include the trace and span identifiers automatically. ST-049-AC3
 *     credential redaction is upheld by NEVER adding manual span
 *     attributes from request bodies in this file.
 *
 * Verification (Gate T1-I, AAP §0.6.6 verbatim):
 *   curl -s "http://localhost:3000/api/designs" \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
 *   docker compose logs backend --tail 20 \
 *     | grep -c "4bf92f3577b34da6a3ce929d0e0e4736"
 *   # expected: ≥1
 *
 * LocalGCP rule: no live exporter is configured here. The default
 * NodeSDK behaviour relies on the standard OTEL_EXPORTER_OTLP_*
 * environment variables to wire an exporter when one is desired; in
 * local dev with no OTLP endpoint set, spans are created and propagate
 * through context (satisfying trace-ID propagation into pino logs) but
 * are not shipped anywhere — no live GCP credentials required.
 *
 * Forbidden patterns (per Agent Action Plan Phase 10):
 *   - DO NOT import any application module (e.g. `./logging/pino`,
 *     `./config/env`). Doing so creates a require-order hazard: those
 *     modules' own dependencies (pg, http, express) would load BEFORE
 *     the SDK is registered, defeating Rule R6.
 *   - DO NOT export the `sdk` instance for other modules to consume —
 *     manual span construction belongs in services via the public
 *     `@opentelemetry/api` `trace.getTracer(...)` API, never via the
 *     SDK directly.
 *   - DO NOT validate the six Rule R4-required environment variables
 *     here. Validation lives in `config/env.ts`, called from
 *     `index.ts` AFTER tracing has registered. A fail-fast exit here
 *     would kill the process before any spans could flush.
 *   - DO NOT add custom samplers, exporters, or processors. The
 *     greenfield default (parentbased_always_on sampler, no exporter
 *     unless OTEL_EXPORTER_* env vars are set) is correct. Sampling
 *     policy is documented as part of `docs/observability/dashboard-template.md`,
 *     not pinned here.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

/**
 * Service identity used to dimension every emitted span. These
 * constants intentionally mirror the prom-client `defaultLabels`
 * applied in `backend/src/routes/metrics.ts` so that operators can
 * cross-filter traces and metrics by the same `service` /
 * `environment` / `version` keys (ST-048-AC2).
 *
 * Each value reads its environment variable directly and falls back
 * to a documented operational default if unset. The fallback values
 * are EXACTLY the same as the defaults in `backend/src/config/env.ts`
 * so a deployment that does not override `SERVICE_NAME` /
 * `SERVICE_VERSION` / `NODE_ENV` produces identical labels in both
 * traces and metrics — the cardinal property that makes ST-048-AC2
 * trace-metric correlation actually work.
 *
 * The fallbacks (`'strikeforge-backend'`, `'unknown'`, `'development'`)
 * intentionally do NOT throw when an env var is absent — Rule R4
 * fail-fast applies to the six listed variables in `config/env.ts`,
 * not to observability metadata. A traced span tagged
 * `version=unknown` is strictly more useful than no traces at all
 * because the SDK refused to start. The six required env vars are
 * validated by `loadEnv()` later in the boot sequence; if any of
 * those is missing, the backend exits AFTER tracing has had a chance
 * to emit a startup span describing the failure.
 */
const SERVICE_NAME = process.env['SERVICE_NAME'] ?? 'strikeforge-backend';
const SERVICE_VERSION = process.env['SERVICE_VERSION'] ?? process.env['COMMIT_SHA'] ?? 'unknown';
const DEPLOYMENT_ENVIRONMENT = process.env['NODE_ENV'] ?? 'development';

/**
 * Resource describing the entity producing telemetry. Attached to
 * every span so downstream collectors (Cloud Trace, Tempo, Jaeger)
 * can group spans by service identity.
 *
 * The `SemanticResourceAttributes.*` constants are the canonical OTel
 * attribute keys (`service.name`, `service.version`,
 * `deployment.environment`); using the constant rather than the raw
 * string ensures interoperability with any OTel-compliant collector.
 */
const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
  [SemanticResourceAttributes.SERVICE_VERSION]: SERVICE_VERSION,
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: DEPLOYMENT_ENVIRONMENT,
});

/**
 * The NodeSDK orchestrates tracer-provider lifecycle and registers
 * every instrumentation in a single boot step. The
 * `getNodeAutoInstrumentations()` bundle returns instrumentations
 * for http, express, pg, net, dns, and many others; the SDK
 * monkey-patches each module's exports the first time the module is
 * required AFTER `sdk.start()`.
 *
 * The `'@opentelemetry/instrumentation-fs'` override disables the
 * filesystem instrumentation. The fs instrumentation is correct but
 * extremely chatty — Node's module loader calls `fs.statSync()`
 * thousands of times during startup alone. Disabling it keeps traces
 * focused on application I/O (HTTP requests, database queries,
 * Express middleware) rather than module-loading noise.
 *
 * All other instrumentations (http, express, pg) are left at default
 * configuration; their default behaviour is to read inbound
 * `traceparent` headers, create child spans, and propagate
 * `traceparent` on outbound calls — which is exactly what Gate T1-I
 * verifies (AAP §0.6.6).
 */
const sdk = new NodeSDK({
  resource,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

/**
 * Synchronous registration. `sdk.start()` returns `void` in
 * `@opentelemetry/sdk-node@^0.50.x` (earlier versions returned a
 * Promise; this one does not). The require-hook that
 * auto-instrumentation installs is in place by the time `start()`
 * returns, so any `import` statement that runs AFTER this line —
 * including the rest of `backend/src/index.ts` — sees the
 * monkey-patched module exports.
 *
 * The SDK's `start()` is idempotent: a second call is a no-op with a
 * warning. No defensive guard is needed.
 */
sdk.start();

/**
 * Pretty-print shutdown errors to stderr. Cannot use pino here —
 * `tracing.ts` is forbidden from importing application modules
 * (Phase 10) and pino is owned by `logging/pino.ts`. A direct
 * `process.stderr.write(...)` is the simplest reliable channel for
 * the rare shutdown-failure case.
 *
 * The `unknown` parameter type is the safest signature for a
 * Promise.catch handler; we narrow to `Error` only when extracting
 * the human-readable message.
 */
const handleShutdownError = (err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[tracing] OTel SDK shutdown error: ${message}\n`);
};

/**
 * Graceful SDK shutdown on container termination.
 *
 * Cloud Run delivers SIGTERM with a ~10 second grace period before
 * SIGKILL during a rollout. Calling `sdk.shutdown()` flushes any
 * in-flight span batches to the configured exporter before the
 * process exits — without this handler, the last few seconds of
 * traces are silently dropped, creating a blind spot in error
 * investigations that correlate with deploys.
 *
 * SIGINT is the local Ctrl+C signal; the same flush logic applies so
 * developers see a consistent experience between local dev and
 * production.
 *
 * Both handlers use `void sdk.shutdown().catch(...)` to explicitly
 * discard the returned Promise (Node signal handlers are synchronous
 * and cannot await). The `.catch()` ensures shutdown errors are
 * surfaced to stderr rather than producing an unhandled rejection.
 *
 * Note: `index.ts` registers its own SIGTERM/SIGINT handlers for
 * HTTP server shutdown. Both this file's handlers AND those handlers
 * run on signal — Node's signal-handler list supports multiple
 * listeners and runs each in registration order. Both must complete
 * within Cloud Run's 10s grace window; in practice each takes
 * milliseconds.
 */
process.on('SIGTERM', () => {
  void sdk.shutdown().catch(handleShutdownError);
});

process.on('SIGINT', () => {
  void sdk.shutdown().catch(handleShutdownError);
});
