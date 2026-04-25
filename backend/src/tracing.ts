/**
 * OpenTelemetry SDK bootstrap.
 *
 * IMPORTANT: This module MUST be imported as the very first line of
 * `backend/src/index.ts` per Rule R6 / Constraint C4. The OpenTelemetry
 * auto-instrumentations monkey-patch `pg`, `http`, and `express` at
 * import time, so any application code that imports those packages
 * before this module is registered will produce duplicate spans (or no
 * spans at all).
 *
 * The SDK is configured with the auto-instrumentations bundle so that
 * inbound and outbound HTTP, the Express middleware chain, and pg
 * queries are captured automatically. The W3C `traceparent` header is
 * propagated through the auto-instrumented `http` client without any
 * manual instrumentation code (per C4 — manual instrumentation is
 * explicitly forbidden).
 *
 * No exporter is configured here; the SDK falls back to the no-op
 * exporter when neither OTEL_EXPORTER_OTLP_ENDPOINT nor a custom
 * exporter is supplied. This keeps the local-dev startup fast and
 * silent. In CI/production an exporter can be wired through the
 * standard OTEL_* environment variables without touching this file.
 *
 * Per the user-provided LocalGCP rule, this module never reaches out
 * to a live GCP tracing endpoint and never requires GCP credentials.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  // Enable auto-instrumentation BEFORE any application module imports
  // pg / http / express so that auto-instrumentation can patch the
  // module exports. Per Rule R6 / C4, this is the only registration
  // call permitted; manual span construction in application code is
  // forbidden.
  instrumentations: [
    getNodeAutoInstrumentations({
      // The fs auto-instrumentation produces extremely high-volume
      // spans that drown out application traces. Disable it because
      // application telemetry interest is in HTTP, Express, and pg.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

// `start()` is synchronous as of @opentelemetry/sdk-node ^0.50; if a
// future version returns a Promise, await it here.
sdk.start();

// Register a graceful shutdown so spans flush on SIGTERM (Cloud Run
// and Docker Compose both deliver SIGTERM during stop). We swallow
// errors during shutdown to ensure the process can still exit.
const shutdown = async (): Promise<void> => {
  try {
    await sdk.shutdown();
  } catch {
    // Intentionally swallow — the process is exiting and we cannot
    // do anything about a failed flush. Logged-elsewhere policy: the
    // pino logger may have already been torn down.
  }
};

process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

export { sdk };
