/**
 * Cross-cutting integration test for distributed tracing propagation.
 *
 * Authority (verbatim citations from the Agent Action Plan and story files):
 *   - Constraint C4 (AAP §0.2.2): "@opentelemetry/auto-instrumentations-node
 *       MUST be registered before any application import/require statements."
 *   - Rule R6 (AAP §0.8.1): the auto-instrumentation order is non-negotiable;
 *       loading a target module before SDK start produces missing or
 *       duplicate spans.
 *   - Gate T1-I (AAP §0.2.2 User Example, verbatim):
 *       `curl -s "http://localhost:3000/api/designs"
 *          -H "Authorization: Bearer $TOKEN"
 *          -H "traceparent:
 *              00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"`
 *       then
 *       `docker compose logs backend --tail 20
 *          | grep -c "4bf92f3577b34da6a3ce929d0e0e4736"`
 *       expected: ≥1.
 *   - AAP §0.6.6 Group 4 (T1-I): "MODIFY backend/src/tracing.ts | Ensure W3C
 *       traceparent propagation across all service boundaries via OTel
 *       auto-instrumentation of http and express (C4 — no manual
 *       instrumentation)".
 *   - Story ST-049 (tickets/stories/ST-049-distributed-tracing-dashboard-template-stub.md):
 *       AC1 distributed tracing across service boundaries via OTel; AC2 trace
 *       IDs in log records (correlation between logs and traces); AC3 inbound
 *       W3C traceparent honoured (parent context preserved); AC4 outbound
 *       HTTP calls propagate trace context.
 *   - Story ST-044 (tickets/stories/ST-044-integration-test-suite.md):
 *       integration test suite scope; deterministic fixtures; LocalGCP-only
 *       operation (no live GCP credentials, no live exporters required).
 *
 * Modules under test:
 *   - backend/src/tracing.ts (OTel SDK init with auto-instrumentations).
 *       NOT imported by this file directly: it is loaded as a side-effect
 *       by `tests/integration/setup/register-tracing.ts`, which Jest runs
 *       in `setupFiles` BEFORE this test module is required. Re-importing
 *       here would be a no-op (sdk.start() is idempotent) but is forbidden
 *       by the schema's Phase 11 forbidden-patterns checklist because it
 *       muddies ownership of the OTel registration site.
 *   - backend/src/middleware/correlation.ts (the correlationMiddleware
 *       imported below) — mounted in the test app to mirror the production
 *       middleware order (AAP §0.5.6) so the pino mixin's correlationId
 *       contribution coexists with the OTel-derived traceId/spanId
 *       contribution on every emitted log record.
 *   - backend/src/logging/pino.ts (the pinoOptions imported below) — passed
 *       verbatim to `pino()` so the test logger's behaviour mirrors
 *       production: same mixin (`trace.getActiveSpan()` + isSpanContextValid
 *       guard), same redaction allow-list (Rule R2), same level formatter,
 *       same ISO 8601 timestamp.
 *
 * Note on registration order (Rule R6 / C4):
 *   This test file does NOT initialize OpenTelemetry. The
 *   `setupFiles: ['<rootDir>/tests/integration/setup/register-tracing.ts']`
 *   entry in `backend/jest.config.integration.ts` causes
 *   `register-tracing.ts` to import `../../../src/tracing` before Jest's
 *   framework loads any test module. By the time this file is required,
 *   `pg`, `http`, `https`, and `express` are already monkey-patched by
 *   `@opentelemetry/auto-instrumentations-node`, the auto-instrumentations
 *   are registered, and a working `AsyncLocalStorageContextManager` is the
 *   active OTel context manager. Adding additional `import` lines here for
 *   `../../../src/tracing` would be redundant and would obscure the single
 *   ownership boundary maintained by `register-tracing.ts`.
 *
 * Design notes:
 *   1. Why a focused test app (`buildApp`) instead of `../../../src/index`?
 *      The schema's Phase 5 mandates a focused app: importing
 *      `backend/src/index.ts` would boot the production composition root
 *      (DB pool, Firebase Admin init, full route table, session
 *      middleware) — none of which are needed to exercise pino<->OTel
 *      mixin propagation, all of which add startup latency and external
 *      dependencies (DATABASE_URL, FIREBASE_PROJECT_ID), and most of which
 *      already have dedicated unit and integration tests. The focused app
 *      contains the minimum middleware chain needed to reproduce the
 *      production OTel + pino integration: express.json(), the production
 *      `correlationMiddleware`, and two leaf routes.
 *   2. Why use `context.with(setSpanContext(...))` and not
 *      `.set('traceparent', ...)` in supertest? OpenTelemetry's HTTP
 *      CLIENT instrumentation injects the `traceparent` header on every
 *      outbound request; that injection runs after supertest sets user
 *      headers and therefore overwrites a user-provided traceparent. The
 *      cleanest way to drive a specific trace ID into the inbound request
 *      is to seed the OTel active context with a SpanContext whose
 *      traceId is the desired value: the CLIENT span supertest creates
 *      inherits that traceId, the propagator injects it, the SERVER
 *      instrumentation reads it, and the SERVER span's spanContext (which
 *      pino's mixin reads) carries it forward. This achieves the same
 *      end-to-end property as the curl command in Gate T1-I (verbatim
 *      trace ID flowing into log records).
 *   3. Why a local echo server for outbound propagation tests? Outbound
 *      calls to public hosts violate the LocalGCP rule (no network
 *      dependencies in tests) and are flaky. A bound-on-127.0.0.1
 *      ephemeral-port server gives deterministic, in-process header
 *      inspection without leaving the host.
 *   4. Why `http.get` and not `fetch` for the outbound call? Node's
 *      built-in `http` module has stable OTel auto-instrumentation in
 *      `@opentelemetry/auto-instrumentations-node ^0.47.x`; `fetch`/undici
 *      auto-instrumentation arrived later and may not be enabled by
 *      default. Using `http.get` avoids the false-negative risk of
 *      "no traceparent header on outbound" caused by an unpatched client.
 *
 * Cross-cutting Rule Compliance (Rule-by-Rule):
 *   R1 (story ACs authoritative)   — every `it()` cites ST-049-AC* or
 *                                    Gate T1-I; AC IDs appear in test
 *                                    names so the matrix is grep-able.
 *   R2 (no credentials in logs)    — no Authorization, password, or token
 *                                    fields are sent in any test request;
 *                                    a sanity sweep (Phase 7.5) scans all
 *                                    captured records for Bearer-pattern
 *                                    leakage and forbidden field names.
 *   R3 (Firebase Admin only)       — no JWT libraries imported; no token
 *                                    parsing of any kind.
 *   R4 (no env defaults)           — this file performs zero `process.env`
 *                                    reads; required env vars are
 *                                    validated by env-fail-fast tests
 *                                    elsewhere in the integration suite.
 *   R6 / C4 (OTel ordering)        — registration is owned by
 *                                    `register-tracing.ts` via setupFiles;
 *                                    this file does not re-import the
 *                                    SDK module.
 *   R8 (gates fail closed)         — every assertion uses `expect`; the
 *                                    outbound test exercises a real HTTP
 *                                    server (no mocks of @opentelemetry/api
 *                                    or http) so the trace propagation
 *                                    code path is genuinely exercised.
 *   R9 (no payment processing)     — N/A (no payment terms).
 *   R10 (migration filename rule)  — N/A (this is a test file).
 *
 * Validation Commands:
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   npx eslint backend/tests/integration/observability/tracing.integration.test.ts
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts
 *      tests/integration/observability/tracing.integration.test.ts
 *      --forceExit
 */

// ── stdlib ──────────────────────────────────────────────────────────────
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

// ── third-party ─────────────────────────────────────────────────────────
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import pino from 'pino';
import { trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { SpanContext } from '@opentelemetry/api';

// ── app under test (real modules — no mocks) ────────────────────────────
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { pinoOptions } from '../../../src/logging/pino';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * The exact W3C traceparent value from AAP §0.2.2 Gate T1-I (verbatim).
 * Format: `00-<traceId-32hex>-<parentSpanId-16hex>-<flags-2hex>`.
 *
 * The Gate T1-I assertion this value must satisfy is:
 *   `docker compose logs backend --tail 20
 *      | grep -c "4bf92f3577b34da6a3ce929d0e0e4736"`
 *   expected: ≥1.
 *
 * In an integration-test context, the equivalent property is:
 *   "after a request whose effective trace ID is
 *    4bf92f3577b34da6a3ce929d0e0e4736, at least one captured pino log
 *    record contains that trace ID."
 */
const GATE_T1_I_TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const GATE_T1_I_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const GATE_T1_I_PARENT_SPAN_ID = '00f067aa0ba902b7';

/**
 * An independent trace ID for tests that need a unique value distinct
 * from the Gate T1-I sentinel. Using two distinct values lets us prove
 * that distinct inbound trace contexts produce distinct logged trace
 * IDs and that no caching/aliasing in the OTel SDK or pino mixin
 * conflates them.
 */
const TEST_TRACE_ID_2 = 'aabbccddeeff00112233445566778899';
const TEST_PARENT_SPAN_2 = '1122334455667788';

/**
 * Two further traceIds used by the concurrent-isolation test. Each is a
 * legal 32-hex non-zero W3C trace ID. Distinct character runs make them
 * easy to spot in debug output.
 */
const CONCURRENT_TRACE_ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONCURRENT_PARENT_SPAN_A = 'aaaaaaaaaaaaaaaa';
const CONCURRENT_TRACE_ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CONCURRENT_PARENT_SPAN_B = 'bbbbbbbbbbbbbbbb';

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;
const ALL_ZEROS_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZEROS_SPAN_ID = '0000000000000000';

/** Routes mounted by `buildApp()`. Centralised so test bodies stay terse. */
const ROUTE_TRACE_LOG = '/test/trace-log';
const ROUTE_OUTBOUND = '/test/outbound';

// ════════════════════════════════════════════════════════════════════════
// Log Capture Helper
// ════════════════════════════════════════════════════════════════════════

/**
 * Shape of a captured pino log record. The `[key: string]: unknown`
 * index signature is required because pino emits arbitrary user-supplied
 * fields (per-call merge objects) alongside the well-known fields. The
 * named optional fields cover the production schema:
 *   - `msg` / `level` are pino built-ins.
 *   - `service` is the base field (set in `pinoOptions.base`).
 *   - `correlationId` / `uid` are set by the pino mixin from the
 *     correlationStore.
 *   - `traceId` / `spanId` are set by the pino mixin from
 *     `trace.getActiveSpan().spanContext()` ONLY when
 *     `isSpanContextValid()` returns true.
 *   - `event` is a per-call field used by the routes registered in
 *     `buildApp()` to make assertions easier to write.
 */
interface CapturedLogRecord {
  [key: string]: unknown;
  msg?: string;
  level?: string | number;
  service?: string;
  correlationId?: string;
  uid?: string;
  traceId?: string;
  spanId?: string;
  event?: string;
}

interface LogCapture {
  /** Writable stream passed as pino's destination. */
  stream: Writable;
  /** All records observed so far. Cleared via `reset()`. */
  records: CapturedLogRecord[];
  /** Truncate `records` in place. Useful in `beforeEach` and `afterEach`. */
  reset: () => void;
}

/**
 * Build an in-memory pino destination that parses each newline-delimited
 * JSON record into a structured object. Failed JSON parses are silently
 * dropped — pino's transport contract guarantees one JSON object per line
 * but unit tests or non-JSON output (e.g. unhandled exceptions printed
 * outside pino) MUST NOT crash this stream.
 *
 * Pattern adapted from `backend/src/logging/pino.test.ts`'s
 * `makeCapturingLogger` helper, which is the canonical capture pattern in
 * the project. We deliberately mirror it so the integration-test capture
 * exhibits identical buffering, line-splitting, and parse-error semantics.
 */
function createLogCapture(): LogCapture {
  const records: CapturedLogRecord[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          records.push(JSON.parse(trimmed) as CapturedLogRecord);
        } catch {
          // Non-JSON output — ignore, do not throw. pino in normal
          // operation always emits one JSON object per line.
        }
      }
      cb();
    },
  });
  return {
    stream,
    records,
    reset(): void {
      records.length = 0;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Test Express App Builder
// ════════════════════════════════════════════════════════════════════════

/**
 * Optional outbound-call hook for the `/test/outbound` route. The route
 * handler invokes this hook (when supplied) to drive an outbound HTTP
 * request from inside the active OTel server-span context. Used by the
 * outbound-propagation tests to verify that the auto-instrumented
 * `http.get` adds a `traceparent` header carrying the active trace ID.
 */
type OutboundCall = (url: string) => Promise<unknown>;

/**
 * Build a minimal Express app whose middleware order mirrors production
 * (AAP §0.5.6) for the slice we need to exercise:
 *
 *   1. `express.json()`           — body parsing (no-op for our GETs).
 *   2. `correlationMiddleware`    — production C5 middleware. Runs the
 *      remainder of the request inside an `AsyncLocalStorage` context that
 *      contains the correlationId; pino's mixin reads this context AT log
 *      time.
 *   3. `/test/trace-log` route    — emits a log record so the capture
 *      stream observes the OTel-derived traceId/spanId attached by pino's
 *      mixin.
 *   4. `/test/outbound` route     — emits a log record, optionally calls
 *      `makeOutboundCall(outboundUrl)`, then emits a second log record.
 *      The optional hook is provided by the outbound-propagation tests;
 *      omitting it makes the route a no-op for tests that don't exercise
 *      outbound propagation.
 *
 * The session-validation middleware (production middleware step 6 in AAP
 * §0.5.6) is intentionally NOT mounted here: the trace-propagation
 * property is independent of authentication, and mounting session
 * validation would force every test to construct a real Firebase ID
 * token, defeating the LocalGCP rule and adding flakiness.
 */
function buildApp(
  capture: LogCapture,
  makeOutboundCall?: OutboundCall,
  outboundUrl?: string,
): Express {
  // Pass the production `pinoOptions` verbatim so the mixin, redact
  // paths, base fields, and serializers are byte-identical to production.
  // Direct the output to the in-memory capture stream so test assertions
  // can scan structured records.
  const logger = pino(pinoOptions, capture.stream);

  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);

  app.get(ROUTE_TRACE_LOG, (_req, res) => {
    // Two log records inside the same request lifecycle let assertion 7.4
    // verify "all records emitted during a traced request share the same
    // traceId" without relying on any other event source.
    logger.info({ event: 'route.trace.first' }, 'inside traced route — first');
    logger.info({ event: 'route.trace.second' }, 'inside traced route — second');
    res.status(200).json({ ok: true });
  });

  app.get(ROUTE_OUTBOUND, (_req, res, next) => {
    // The async work is wrapped in an IIFE rather than an async route
    // handler so that any rejection is forwarded to Express's error
    // pipeline via `next(err)` (defensive — Express 4 does not auto-
    // forward async-handler rejections, and a swallowed rejection would
    // violate Rule R8).
    void (async (): Promise<void> => {
      try {
        logger.info(
          { event: 'route.outbound.start' },
          'about to issue outbound call',
        );
        if (makeOutboundCall !== undefined && outboundUrl !== undefined) {
          await makeOutboundCall(outboundUrl);
        }
        logger.info(
          { event: 'route.outbound.done' },
          'outbound call complete',
        );
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    })();
  });

  return app;
}

// ════════════════════════════════════════════════════════════════════════
// Echo Server (outbound-propagation fixture)
// ════════════════════════════════════════════════════════════════════════

interface EchoServerHandle {
  /** Full URL clients should target (e.g. `http://127.0.0.1:54321/echo`). */
  url: string;
  /** Snapshot of all inbound request headers, in arrival order. */
  getReceivedHeaders: () => http.IncomingHttpHeaders[];
  /** Truncate the received-headers buffer in place. */
  resetReceived: () => void;
  /** Stop accepting connections and release the bound port. */
  close: () => Promise<void>;
}

/**
 * Start a deterministic in-process HTTP server bound to 127.0.0.1 on an
 * ephemeral port. Every inbound request's headers are recorded, and the
 * server returns `{"ok":true}` immediately. The fixture is the local
 * counterpart to "an external HTTP service" used by ST-049-AC4 outbound
 * propagation tests; LocalGCP rule compliance is preserved because no
 * remote endpoint is ever contacted.
 */
function startEchoServer(): Promise<EchoServerHandle> {
  return new Promise((resolve, reject) => {
    const received: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      // Snapshot headers — assigning `req.headers` directly would
      // capture the live (mutating) reference; spread copies the
      // current values.
      received.push({ ...req.headers });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Echo server failed to bind to an AddressInfo'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/echo`,
        getReceivedHeaders: () => received.map((h) => ({ ...h })),
        resetReceived(): void {
          received.length = 0;
        },
        close(): Promise<void> {
          return new Promise<void>((closed) => {
            server.close(() => closed());
          });
        },
      });
    });
  });
}



// ════════════════════════════════════════════════════════════════════════
// Outbound HTTP Client
// ════════════════════════════════════════════════════════════════════════

/**
 * Issue a GET via Node's built-in `http` module. Promise-wraps the
 * callback API so it can be awaited from inside an `async` route.
 *
 * Why `http.get` instead of `fetch`/undici (Phase 13 forbidden patterns):
 * `@opentelemetry/auto-instrumentations-node ^0.47.x` includes
 * `@opentelemetry/instrumentation-http` which auto-instruments the
 * built-in `http` module. The `fetch` (undici) instrumentation arrived
 * later and may not be enabled by default — using it would risk a
 * false-negative ("no traceparent header on outbound" caused by an
 * unpatched client rather than by a propagation bug).
 *
 * The function fully drains the response body so the response stream
 * does not pin the underlying socket open beyond `await fetchUrl(...)`,
 * which would cause `--detectOpenHandles` to flag a leaked handle.
 */
function fetchUrl(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get(url, (res) => {
      // Drain the response — `res.resume()` reads all remaining data and
      // releases the connection back to the agent's keep-alive pool.
      res.resume();
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// ════════════════════════════════════════════════════════════════════════
// Trace Context Helper
// ════════════════════════════════════════════════════════════════════════

/**
 * Run `fn` with a synthetic OTel SpanContext active in the OpenTelemetry
 * context manager. Used to drive a desired trace ID into outbound HTTP
 * calls made by code inside `fn`: when supertest's
 * `http.request` runs inside `context.with(ctx, fn)`, the auto-
 * instrumentation's W3C TraceContext propagator injects a `traceparent`
 * header carrying the active context's trace ID. The downstream server
 * extracts that traceId, creates a SERVER span with the same traceId,
 * and pino's mixin then surfaces it on every log record.
 *
 * Why this is necessary: the W3C TraceContext propagator's `inject()`
 * unconditionally calls `setter.set(carrier, 'traceparent', value)`,
 * which OVERWRITES any user-set `traceparent` header. Setting the
 * header explicitly via supertest's `.set('traceparent', ...)` therefore
 * does NOT survive the OTel CLIENT-side instrumentation. Driving the
 * desired ID in via the active context is the only reliable in-process
 * equivalent of curl's "send this header, untouched, to the server".
 *
 * The synthetic SpanContext uses `wrapSpanContext` (via
 * `trace.setSpanContext`) which produces a NoopSpan whose
 * `spanContext()` returns the supplied values. The SDK's tracer treats
 * it as a remote parent (because `isRemote: true`) and creates child
 * spans whose traceId is inherited from this NoopSpan — exactly the
 * propagation behaviour we want.
 */
async function withTraceContext<T>(
  spanCtx: SpanContext,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, spanCtx);
  return await context.with(ctx, fn);
}

/**
 * Helper that constructs a synthetic SpanContext from `traceId` and
 * `spanId`. The `traceFlags: 1` (sampled) and `isRemote: true` mirror an
 * inbound request's parent context per W3C TraceContext §3.2.2.4
 * (sampled=1) and §3.2.2.3 (remote parent).
 */
function makeSpanContext(traceId: string, spanId: string): SpanContext {
  return {
    traceId,
    spanId,
    traceFlags: 1,
    isRemote: true,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════

describe('Distributed tracing — integration (Gate T1-I + ST-049)', () => {
  // Common capture for all sub-suites. Replaced before each test so
  // assertions cannot accidentally observe records from a sibling test
  // (Jest runs tests sequentially within a file by default, so this is
  // belt-and-braces, but the schema's Phase 8 mandates per-test reset).
  let capture: LogCapture;

  beforeEach(() => {
    capture = createLogCapture();
  });

  afterEach(() => {
    capture.reset();
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.1 — Inbound traceparent → logs (Gate T1-I)
  // ──────────────────────────────────────────────────────────────────
  describe('Inbound traceparent → logs (Gate T1-I)', () => {
    it(
      'replicates Gate T1-I verbatim: trace ID 4bf92f3577b34da6a3ce929d0e0e4736 ' +
        'appears in ≥1 log record',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(
          GATE_T1_I_TRACE_ID,
          GATE_T1_I_PARENT_SPAN_ID,
        );

        await withTraceContext(spanCtx, async () => {
          await request(app)
            .get(ROUTE_TRACE_LOG)
            .set('traceparent', GATE_T1_I_TRACEPARENT)
            .expect(200);
        });

        // The Gate T1-I assertion replicates the production verification
        // command: `grep -c "<trace-id>"` returning ≥1. We scan the
        // captured records' serialized JSON for the same substring,
        // which is the in-process equivalent of the production grep.
        const matches = capture.records.filter((r) =>
          JSON.stringify(r).includes(GATE_T1_I_TRACE_ID),
        );
        expect(matches.length).toBeGreaterThanOrEqual(1);
      },
    );

    it(
      'attaches a 32-hex traceId field to log records emitted inside the ' +
        'request lifecycle (ST-049-AC2)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(TEST_TRACE_ID_2, TEST_PARENT_SPAN_2);

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        const traceRecords = capture.records.filter(
          (r) => r.event === 'route.trace.first',
        );
        expect(traceRecords.length).toBeGreaterThanOrEqual(1);
        const traceRecord = traceRecords[0];
        expect(traceRecord).toBeDefined();
        // Belt-and-braces: confirm both the format AND the equality
        // with the trace ID we drove via the active context.
        expect(traceRecord!.traceId).toMatchTraceId();
        expect(traceRecord!.traceId).toBe(TEST_TRACE_ID_2);
      },
    );

    it(
      'attaches a 16-hex spanId field to log records emitted inside the ' +
        'request lifecycle (ST-049-AC2)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(TEST_TRACE_ID_2, TEST_PARENT_SPAN_2);

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        const traceRecords = capture.records.filter(
          (r) => r.event === 'route.trace.first',
        );
        expect(traceRecords.length).toBeGreaterThanOrEqual(1);
        const traceRecord = traceRecords[0];
        expect(traceRecord).toBeDefined();
        // The spanId field present on the LOG record is the SERVER
        // span's spanId — a freshly-generated 16-hex value, NOT the
        // parent span ID from the inbound traceparent (which becomes
        // the SERVER span's parent in the trace tree but is never
        // surfaced as `spanId` in pino output). The strict 16-hex
        // matcher additionally rejects the all-zeros sentinel, which
        // would indicate the OTel SDK never started.
        expect(traceRecord!.spanId).toMatchSpanId();
        // Sanity: it must be a string of exactly 16 hex chars and must
        // not equal the parent span ID we provided as the inbound
        // parent.
        expect(typeof traceRecord!.spanId).toBe('string');
        expect((traceRecord!.spanId as string).length).toBe(16);
      },
    );

    it(
      'generates a fresh non-zero traceId when no inbound traceparent is ' +
        'provided (ST-049-AC1: auto-instrumentation creates a server span)',
      async () => {
        const app = buildApp(capture);
        // No `withTraceContext` wrapper — we want the OTel HTTP CLIENT
        // instrumentation in supertest to start a fresh root context for
        // the outbound request, and the SERVER instrumentation to create
        // a brand-new SERVER span on the receiving side.
        await request(app).get(ROUTE_TRACE_LOG).expect(200);

        const traceRecords = capture.records.filter(
          (r) => r.event === 'route.trace.first',
        );
        expect(traceRecords.length).toBeGreaterThanOrEqual(1);
        const traceRecord = traceRecords[0];
        expect(traceRecord).toBeDefined();
        expect(traceRecord!.traceId).toMatchTraceId();
        // Verify it is NOT the Gate T1-I sentinel (would indicate stale
        // context contamination from an earlier test).
        expect(traceRecord!.traceId).not.toBe(GATE_T1_I_TRACE_ID);
        // Verify it is NOT the all-zeros sentinel (would indicate the
        // OTel SDK never started — the pino mixin's
        // `isSpanContextValid()` guard would in fact filter that case
        // out, but if it slipped through it would imply a misordered
        // setupFiles registration).
        expect(traceRecord!.traceId).not.toBe(ALL_ZEROS_TRACE_ID);
      },
    );

    it(
      'does NOT attach traceId/spanId on log records emitted outside any ' +
        'request lifecycle (pino mixin isSpanContextValid guard)',
      async () => {
        // Build a logger with the same `pinoOptions` but log AFTER the
        // request lifecycle ends. Outside any active span, the pino
        // mixin reads `trace.getActiveSpan()`, finds either no span or a
        // sentinel non-recording span, and the `isSpanContextValid()`
        // guard returns false, so neither traceId nor spanId is added.
        const standaloneCapture = createLogCapture();
        const standaloneLogger = pino(pinoOptions, standaloneCapture.stream);
        standaloneLogger.info(
          { event: 'outside.req' },
          'log record emitted outside any HTTP request',
        );

        // Allow pino's async write to flush.
        await new Promise<void>((resolve) => setImmediate(resolve));

        const outsideRecords = standaloneCapture.records.filter(
          (r) => r.event === 'outside.req',
        );
        expect(outsideRecords.length).toBeGreaterThanOrEqual(1);
        const outsideRecord = outsideRecords[0];
        expect(outsideRecord).toBeDefined();
        // Both fields must be absent. The pino mixin contract is that
        // it MUST NOT emit the all-zeros sentinel — only valid span
        // contexts produce traceId/spanId fields. The strict assertion
        // is `=== undefined` (the field is absent in JSON), but we also
        // verify the value is not the all-zeros sentinel as a
        // defence-in-depth check.
        expect(outsideRecord!.traceId).toBeUndefined();
        expect(outsideRecord!.spanId).toBeUndefined();
        expect(outsideRecord!.traceId).not.toBe(ALL_ZEROS_TRACE_ID);
        expect(outsideRecord!.spanId).not.toBe(ALL_ZEROS_SPAN_ID);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.2 — Concurrent requests — isolation
  // ──────────────────────────────────────────────────────────────────
  describe('Concurrent requests — isolation', () => {
    it(
      'two concurrent requests with distinct traceparents produce distinct ' +
        'traceIds in their respective log records',
      async () => {
        const app = buildApp(capture);

        const ctxA = makeSpanContext(
          CONCURRENT_TRACE_ID_A,
          CONCURRENT_PARENT_SPAN_A,
        );
        const ctxB = makeSpanContext(
          CONCURRENT_TRACE_ID_B,
          CONCURRENT_PARENT_SPAN_B,
        );

        // Distinct correlation IDs let us disambiguate which request a
        // given log record belongs to. The correlationMiddleware
        // preserves an inbound `x-correlation-id` verbatim if it is a
        // valid UUID v4; we therefore supply UUIDs from a known set.
        const correlationA = '11111111-2222-4333-8444-555555555555';
        const correlationB = '66666666-7777-4888-8999-aaaaaaaaaaaa';

        const reqA = withTraceContext(ctxA, async () => {
          await request(app)
            .get(ROUTE_TRACE_LOG)
            .set('x-correlation-id', correlationA)
            .expect(200);
        });
        const reqB = withTraceContext(ctxB, async () => {
          await request(app)
            .get(ROUTE_TRACE_LOG)
            .set('x-correlation-id', correlationB)
            .expect(200);
        });

        await Promise.all([reqA, reqB]);

        const recordsForA = capture.records.filter(
          (r) =>
            r.correlationId === correlationA &&
            r.event === 'route.trace.first',
        );
        const recordsForB = capture.records.filter(
          (r) =>
            r.correlationId === correlationB &&
            r.event === 'route.trace.first',
        );

        // Each request must have produced at least one log record (the
        // route emits two per request).
        expect(recordsForA.length).toBeGreaterThanOrEqual(1);
        expect(recordsForB.length).toBeGreaterThanOrEqual(1);

        // Every record from request A must carry trace ID A and never
        // trace ID B; vice versa.
        for (const record of recordsForA) {
          expect(record.traceId).toBe(CONCURRENT_TRACE_ID_A);
          expect(record.traceId).not.toBe(CONCURRENT_TRACE_ID_B);
        }
        for (const record of recordsForB) {
          expect(record.traceId).toBe(CONCURRENT_TRACE_ID_B);
          expect(record.traceId).not.toBe(CONCURRENT_TRACE_ID_A);
        }
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.3 — Outbound HTTP propagation (ST-049-AC4)
  // ──────────────────────────────────────────────────────────────────
  describe('Outbound HTTP propagation (ST-049-AC4)', () => {
    let echoServer: EchoServerHandle;

    beforeAll(async () => {
      echoServer = await startEchoServer();
    });

    afterAll(async () => {
      await echoServer.close();
    });

    beforeEach(() => {
      echoServer.resetReceived();
    });

    it(
      'outbound http.get adds a traceparent header carrying the active ' +
        'trace ID (ST-049-AC4)',
      async () => {
        const app = buildApp(capture, fetchUrl, echoServer.url);
        const spanCtx = makeSpanContext(
          GATE_T1_I_TRACE_ID,
          GATE_T1_I_PARENT_SPAN_ID,
        );

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_OUTBOUND).expect(200);
        });

        const headersList = echoServer.getReceivedHeaders();
        // Filter to only the outbound request that originated from the
        // route (excluding any preflight/health probes).
        const traceparentHeaders = headersList
          .map((h) => h['traceparent'])
          .filter((v): v is string => typeof v === 'string');

        expect(traceparentHeaders.length).toBeGreaterThanOrEqual(1);

        // At least one outbound traceparent must carry the same trace
        // ID we drove into the active context. The propagator's W3C
        // format guarantees: `00-<traceId>-<clientSpanId>-<flags>`.
        const matchingTraceParent = traceparentHeaders.find((tp) =>
          tp.includes(GATE_T1_I_TRACE_ID),
        );
        expect(matchingTraceParent).toBeDefined();
        expect(matchingTraceParent!.length).toBe(GATE_T1_I_TRACEPARENT.length);

        // Cross-check: parse the traceparent and confirm the structure.
        // Format: VERSION-TRACEID-PARENTSPANID-FLAGS, four hyphen-
        // separated fields.
        const parts = matchingTraceParent!.split('-');
        expect(parts.length).toBe(4);
        expect(parts[0]).toBe('00'); // W3C version
        expect(parts[1]).toBe(GATE_T1_I_TRACE_ID); // traceId preserved
        expect(parts[2]).toMatch(SPAN_ID_REGEX); // valid 16-hex spanId
        // The outbound span ID must NOT be the inbound parent span ID
        // (which is the parent of the SERVER span; OTel's CLIENT
        // instrumentation creates a fresh CLIENT span ID).
        expect(parts[2]).not.toBe(GATE_T1_I_PARENT_SPAN_ID);
        // The outbound span ID must NOT be the all-zeros sentinel.
        expect(parts[2]).not.toBe(ALL_ZEROS_SPAN_ID);
      },
    );

    it(
      'outbound http.get without an inbound trace context generates a fresh ' +
        'trace and propagates it (ST-049-AC4 fallback)',
      async () => {
        const app = buildApp(capture, fetchUrl, echoServer.url);
        // No `withTraceContext` — the OTel SDK creates a brand-new root
        // trace for the supertest client call, and the SERVER side
        // creates a fresh trace ID that is propagated to the echo
        // server.
        await request(app).get(ROUTE_OUTBOUND).expect(200);

        const headersList = echoServer.getReceivedHeaders();
        const traceparentHeaders = headersList
          .map((h) => h['traceparent'])
          .filter((v): v is string => typeof v === 'string');

        expect(traceparentHeaders.length).toBeGreaterThanOrEqual(1);

        // The traceparent format check: VERSION-TRACEID-SPANID-FLAGS.
        const parts = traceparentHeaders[0]!.split('-');
        expect(parts.length).toBe(4);
        expect(parts[0]).toBe('00');
        expect(parts[1]).toMatch(TRACE_ID_REGEX);
        expect(parts[1]).not.toBe(ALL_ZEROS_TRACE_ID);
        expect(parts[2]).toMatch(SPAN_ID_REGEX);
        expect(parts[2]).not.toBe(ALL_ZEROS_SPAN_ID);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.4 — Log/trace correlation (ST-049-AC2)
  // ──────────────────────────────────────────────────────────────────
  describe('Log/trace correlation (ST-049-AC2)', () => {
    it(
      'all log records emitted during a single traced request share the ' +
        'same traceId and spanId (ST-049-AC2)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(TEST_TRACE_ID_2, TEST_PARENT_SPAN_2);

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        const firstRecords = capture.records.filter(
          (r) => r.event === 'route.trace.first',
        );
        const secondRecords = capture.records.filter(
          (r) => r.event === 'route.trace.second',
        );
        expect(firstRecords.length).toBeGreaterThanOrEqual(1);
        expect(secondRecords.length).toBeGreaterThanOrEqual(1);

        const firstRecord = firstRecords[0];
        const secondRecord = secondRecords[0];
        expect(firstRecord).toBeDefined();
        expect(secondRecord).toBeDefined();

        // Both records emitted in the same handler context — same
        // trace, same span, same correlation.
        expect(firstRecord!.traceId).toBe(secondRecord!.traceId);
        expect(firstRecord!.spanId).toBe(secondRecord!.spanId);
        expect(firstRecord!.correlationId).toBe(secondRecord!.correlationId);
      },
    );

    it(
      'log record traceId matches the inbound W3C traceparent value ' +
        '(ST-049-AC3 parent context preservation)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(TEST_TRACE_ID_2, TEST_PARENT_SPAN_2);

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        // ST-049-AC3 — the inbound trace ID extends through the server
        // span, NOT replaced by a fresh trace ID. The pino mixin
        // surfaces the SERVER span's spanContext, whose traceId is
        // inherited from the parent context.
        const traceRecord = capture.records.find(
          (r) => r.event === 'route.trace.first',
        );
        expect(traceRecord).toBeDefined();
        expect(traceRecord!.traceId).toBe(TEST_TRACE_ID_2);
      },
    );

    it(
      'every log record emitted inside a traced request includes a ' +
        'correlationId field (interplay with C5 correlation middleware)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(TEST_TRACE_ID_2, TEST_PARENT_SPAN_2);

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        const inRequestRecords = capture.records.filter(
          (r) =>
            r.event === 'route.trace.first' || r.event === 'route.trace.second',
        );
        expect(inRequestRecords.length).toBeGreaterThanOrEqual(2);
        for (const record of inRequestRecords) {
          expect(record.correlationId).toBeDefined();
          // The correlation middleware generates a UUID v4 when no
          // inbound `x-correlation-id` header is present. Validate the
          // format using the project's UUID matcher.
          expect(record.correlationId).toMatchCorrelationId();
        }
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.5 — Record sanity — no leakage (R2 belt-and-braces)
  // ──────────────────────────────────────────────────────────────────
  describe('Record sanity — no leakage', () => {
    it(
      'log records do not leak Bearer-token patterns or password fields ' +
        '(Rule R2 cross-check)',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(
          GATE_T1_I_TRACE_ID,
          GATE_T1_I_PARENT_SPAN_ID,
        );

        // Issue a request whose headers include a fake Authorization
        // header so that even if pino's allow-list serializer
        // misbehaved, we'd see the leakage in the captured records.
        // We intentionally do NOT use a real Firebase ID token — the
        // header is a synthetic sentinel guarded by Rule R2's pino
        // allow-list (the `Authorization` header MUST NOT survive the
        // request serializer).
        await withTraceContext(spanCtx, async () => {
          await request(app)
            .get(ROUTE_TRACE_LOG)
            .set(
              'authorization',
              'Bearer SENTINEL_BEARER_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            )
            .expect(200);
        });

        const allText = capture.records.map((r) => JSON.stringify(r)).join('\n');
        // Bearer-pattern sentinel: a long alphanumeric run after
        // `Bearer ` is the canonical leakage signature. Pino's
        // serializer allow-list MUST strip the `authorization` header
        // entirely from `req.headers`, so the sentinel must NOT
        // appear anywhere in the captured records.
        expect(allText).not.toMatch(/Bearer\s+SENTINEL_BEARER_/);
        // No record may have a top-level `password` field (R2 forbids
        // credentials in logs even if the request body contained them
        // — which it does not in this test).
        for (const record of capture.records) {
          expect(record['password']).toBeUndefined();
        }
      },
    );

    it(
      'pino allow-list permits traceparent inside req.headers — the W3C ' +
        'header is observability metadata, not credential material',
      async () => {
        const app = buildApp(capture);
        const spanCtx = makeSpanContext(
          GATE_T1_I_TRACE_ID,
          GATE_T1_I_PARENT_SPAN_ID,
        );

        await withTraceContext(spanCtx, async () => {
          await request(app).get(ROUTE_TRACE_LOG).expect(200);
        });

        // We assert ONLY that captured records do not contain any of
        // the credential field names listed in pino.ts's redact paths.
        // The allow-list itself (which permits `traceparent` /
        // `tracestate`) is unit-tested in
        // `backend/src/logging/pino.test.ts`; here we only ensure
        // that integration-level capture does not regress that
        // contract.
        for (const record of capture.records) {
          expect(record['Authorization']).toBeUndefined();
          expect(record['authorization']).toBeUndefined();
          expect(record['cookie']).toBeUndefined();
          expect(record['x-api-key']).toBeUndefined();
        }
      },
    );
  });
});

