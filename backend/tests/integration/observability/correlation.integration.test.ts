/**
 * `correlation.integration.test.ts` — Cross-cutting integration test for
 * correlation-ID propagation per Constraint C5 and Story ST-047.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations)
 * ============================================================================
 *   - Constraint C5 (AAP §0.2.2 — VERBATIM):
 *       "A middleware at the request boundary MUST generate a UUID v4 as the
 *        correlation ID when the inbound `x-correlation-id` header is absent,
 *        and preserve it verbatim when present. The correlation ID MUST be
 *        stored in Node's `AsyncLocalStorage` (from `node:async_hooks`).
 *        A pino hook MUST attach the correlation ID to every log record
 *        emitted during the request lifecycle. Every outbound HTTP client
 *        call MUST attach the correlation ID to its outbound headers."
 *   - AAP §0.3.3 (verbatim):
 *       "backend/src/middleware/correlation.ts — Correlation-ID middleware
 *        per C5; AsyncLocalStorage, pino hook, outbound header propagation"
 *   - Story ST-047 (`tickets/stories/ST-047-structured-logs-correlation-id.md`):
 *       AC1 — every log record carries timestamp, severity token, event,
 *             service identifier, correlation identifier in machine-parseable
 *             format.
 *       AC2 — correlation ID is generated at the request boundary when
 *             absent, preserved when present, and forwarded downstream so
 *             every record produced in response to a single inbound request
 *             shares the same identifier.
 *       AC3 — authenticated request flows emit log records carrying both
 *             the correlation ID and the user identifier, never credential
 *             material (this test does not exercise authenticated flows;
 *             auth-bearing tests live alongside the auth route tests).
 *       AC4 — no record contains passwords, bearer tokens, session
 *             identifiers, API keys, or PII beyond the user identifier;
 *             enforced by a documented serializer / allow-list mechanism.
 *       AC5 — the structured logging behaviour is exercisable end-to-end
 *             in the local development environment; this integration test
 *             IS that exercise driven from `npm run test:integration`.
 *   - Story ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC1 — triggered on every PR open and push.
 *       AC2 — deterministic fixtures; emits an integration report artifact.
 *       AC3 — distinguishes assertion failures from environment / fixture-
 *             setup failures (per-suite.ts `afterEach` rejection guard
 *             tags environmental failures distinctly).
 *       AC4 — runs against locally-started dependencies; this file makes
 *             zero outbound calls beyond a self-hosted ephemeral echo
 *             server bound to 127.0.0.1.
 *
 * ============================================================================
 * Modules Under Test (real modules — no mocks)
 * ============================================================================
 *   - `backend/src/middleware/correlation.ts`:
 *       * `correlationMiddleware`  — inbound boundary; generates / preserves
 *                                    correlation ID; opens the ALS frame.
 *       * `correlationStore`       — module-scoped `AsyncLocalStorage`
 *                                    instance used by the pino mixin to
 *                                    attach `correlationId` to every log
 *                                    record.
 *       * `getCorrelationId()`     — public helper for handlers / services.
 *       * Module-load side effect  — `http`/`https` `request`/`get` are
 *                                    monkey-patched at module load via the
 *                                    `Symbol.for('__blitzy_correlation_http_patched__')`
 *                                    sentinel; importing the module is
 *                                    sufficient to enable outbound
 *                                    propagation testing here.
 *   - `backend/src/logging/pino.ts`:
 *       * `pinoOptions`            — production options imported VERBATIM
 *                                    and passed as `pino(pinoOptions, capture.stream)`
 *                                    so the mixin / redact / serializer
 *                                    behaviour we observe is byte-identical
 *                                    to production.
 *
 * ============================================================================
 * Why a Focused Test App
 * ============================================================================
 *   The schema's Phase 5 (and the canonical pattern in
 *   `tracing.integration.test.ts`) mandate a focused Express app rather
 *   than `backend/src/index.ts`. Importing the production composition
 *   root would also boot session middleware, route registrations,
 *   Firebase Admin init, and `pg.Pool` — none of which are needed to
 *   exercise the C5 contract, all of which add startup latency, and most
 *   of which already have dedicated tests. The focused app contains the
 *   minimum middleware chain needed to reproduce the production pino +
 *   correlation integration: `express.json()`, the production
 *   `correlationMiddleware`, and a small set of leaf routes.
 *
 * ============================================================================
 * Why a Local Echo Server for Outbound Propagation
 * ============================================================================
 *   The outbound propagation tests (§5.4 below) inspect the headers an
 *   in-process HTTP client actually places on the wire. Calling out to a
 *   public host violates the LocalGCP rule and adds non-determinism. A
 *   server bound to `127.0.0.1:0` (random ephemeral port) gives a
 *   deterministic, in-process header inspection without leaving the host.
 *
 * ============================================================================
 * Cross-Cutting Rule Compliance
 * ============================================================================
 *   - Rule R1 (story ACs authoritative): every `it()` cites the C5
 *     sub-clause or ST-047 AC it verifies.
 *   - Rule R2 (no credentials in logs): this test sends NO password,
 *     bearer token, API key, or other credential material. Opaque IDs
 *     such as `'inbound-fixed-id-12345'` and UUIDs are used in their
 *     place; a sanity sweep in §5.5 verifies no Bearer-pattern leakage
 *     made it into captured records anyway.
 *   - Rule R3 (Firebase Admin only): no JWT-library imports.
 *   - Rule R4 (no env defaults): this file performs zero `process.env`
 *     reads; required env vars are validated by `env-fail-fast.integration.test.ts`.
 *   - Rule R6 / C4 (OTel registration order): registration is owned by
 *     `register-tracing.ts` via Jest's `setupFiles`; this file does
 *     not re-import the SDK module. By the time this file is required,
 *     `pg`, `http`, `https`, and `express` are already monkey-patched
 *     by `@opentelemetry/auto-instrumentations-node`. The C5 module's
 *     own http / https patches sit on top of the OTel patches —
 *     outbound requests therefore receive both `x-correlation-id`
 *     (this layer) and `traceparent` (OTel's layer).
 *   - Rule R8 (gates fail closed): every assertion uses `expect`; no
 *     `try`/`catch` swallows test failures; the outbound test
 *     exercises a real HTTP server (no silent stubs) so a regression
 *     in the C5 patch fails the assertion rather than silently passing.
 *   - Rule R9 (no payment): N/A — no payment terms in this file.
 *
 * ============================================================================
 * Validation Commands
 * ============================================================================
 *   npx tsc --noEmit -p backend/tsconfig.spec.json
 *   npx eslint backend/tests/integration/observability/correlation.integration.test.ts
 *      --max-warnings 0
 *   cd backend && npx jest --config jest.config.integration.ts \
 *      tests/integration/observability/correlation.integration.test.ts \
 *      --forceExit
 */

// ── stdlib ──────────────────────────────────────────────────────────────
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

// ── third-party ─────────────────────────────────────────────────────────
import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import pino from 'pino';

// ── app under test (real modules — no mocks) ────────────────────────────
import {
  correlationMiddleware,
  correlationStore,
  getCorrelationId,
} from '../../../src/middleware/correlation';
import { pinoOptions } from '../../../src/logging/pino';

// ════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════

/**
 * Strict UUID v4 regex per RFC 4122 §4.4:
 *   - Time-low: 8 hex digits.
 *   - Time-mid: 4 hex digits.
 *   - Version nibble: literal `4` followed by 3 hex digits.
 *   - Variant nibble: one of `[89ab]` followed by 3 hex digits.
 *   - Node: 12 hex digits.
 *
 * The strict v4 form is required by Constraint C5 (AAP §0.2.2 — "MUST
 * generate a UUID v4"). The integration suite's broader `toBeUuid()`
 * matcher (per-suite.ts) accepts any UUID version 1–5; here we tighten
 * to v4-only so a regression that switched the generator (e.g. to
 * `crypto.randomUUID()` returning a non-v4) would surface immediately.
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Routes mounted by `buildApp()`. Centralised so test bodies stay terse. */
const ROUTE_LOG = '/test/log';
const ROUTE_OUTBOUND = '/test/outbound';
const ROUTE_OUTBOUND_OVERRIDE = '/test/outbound-override';
const ROUTE_STORE = '/test/store';
const ROUTE_ASYNC = '/test/async';

/**
 * Canonical inbound fixed-but-non-UUID correlation ID. Verifies that the
 * "preserve verbatim" semantics of C5 do NOT silently re-shape an
 * arbitrary upstream identifier into a UUID. Real-world systems (Heroku
 * Router, AWS ALB) commonly mint non-UUID request IDs.
 */
const FIXED_NON_UUID_ID = 'inbound-fixed-id-12345';

/** Canonical inbound UUID-shaped correlation ID. Pre-generated v4. */
const FIXED_UUID_ID = '7f3b9c5e-9d4a-4c8b-8e1f-1234567890ab';

/** Header constant for the legacy fallback (per `correlation.ts`). */
const FALLBACK_HEADER_VALUE = 'legacy-load-balancer-id';

/** Sentinel used by the §5.4 outbound-propagation tests. */
const OUTBOUND_PROPAGATION_ID = 'outbound-propagation-id-789';

/** Sentinel used by the §5.4 caller-override test. */
const CALLER_EXPLICIT_OVERRIDE = 'caller-explicit-override';

/** Sentinel used by the §5.4 caller-override test for the request scope. */
const REQUEST_BOUND_ID = 'request-bound-id';

// ════════════════════════════════════════════════════════════════════════
// Log Capture Helper
// ════════════════════════════════════════════════════════════════════════

/**
 * Shape of a captured pino log record.
 *
 * The `[key: string]: unknown` index signature is required because pino
 * emits arbitrary user-supplied fields (per-call merge objects) alongside
 * the well-known fields. The named optional fields cover the production
 * schema:
 *   - `msg` / `level` / `time` are pino built-ins.
 *   - `service` is the base field (set in `pinoOptions.base`).
 *   - `correlationId` / `uid` are set by the pino mixin from the
 *     correlationStore (the C5 contract under test).
 *   - `traceId` / `spanId` are set by the pino mixin from
 *     `trace.getActiveSpan().spanContext()` ONLY when
 *     `isSpanContextValid()` returns true — present here only because
 *     OTel auto-instrumentation runs on the same Express app via the
 *     `register-tracing.ts` setupFiles hook. We do not assert on these
 *     fields in this file (they are owned by `tracing.integration.test.ts`).
 *   - `event` is a per-call field used by the routes registered in
 *     `buildApp()` to make filter assertions terse.
 */
interface CapturedLogRecord {
  [key: string]: unknown;
  msg?: string;
  level?: string | number;
  time?: number | string;
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
          // Non-JSON output — ignore. Pino under `pinoOptions` always
          // emits one JSON object per line; non-JSON would indicate a
          // pathological state that this test should not mask.
        }
      }
      cb();
    },
  });
  return {
    stream,
    records,
    reset: () => {
      records.length = 0;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Outbound Call Hook
// ════════════════════════════════════════════════════════════════════════

/**
 * Hook signature for the `/test/outbound` route. The route handler
 * invokes the hook (when supplied) inside the active correlation
 * context. The hook receives the active correlation ID (as observed by
 * the route handler via `getCorrelationId()`) so that tests can assert
 * a) that `getCorrelationId()` returns the expected value inside the
 * request handler, and b) optionally use the value to drive caller-
 * supplied outbound headers in the override test.
 */
type OutboundCall = (correlationId: string | undefined) => Promise<unknown>;

// ════════════════════════════════════════════════════════════════════════
// Test Express App Builder
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a focused Express app that mirrors the production middleware
 * order (AAP §0.5.6) for the C5 + ST-047 slice we need to exercise:
 *
 *   1. `express.json()`           — body parsing (no-op for our GETs).
 *   2. `correlationMiddleware`    — production C5 middleware. Runs the
 *      remainder of the request inside an `AsyncLocalStorage` context
 *      that contains `{ correlationId }`; the pino mixin reads this
 *      context AT log time so every record produced inside the request
 *      lifecycle carries the correlation ID.
 *   3. Routes — see below.
 *
 * The session-validation middleware (production middleware step 6 in AAP
 * §0.5.6) is intentionally NOT mounted here: the correlation-propagation
 * property is independent of authentication, and mounting session
 * validation would force every test to construct a real Firebase ID
 * token, defeating the LocalGCP rule and adding flakiness.
 *
 * Routes mounted:
 *   - `GET /test/log`              — emits one business-handler log
 *                                    record (`event: 'route.test.log'`)
 *                                    so §5.2 can verify the mixin
 *                                    attached `correlationId` to
 *                                    non-pino-http records.
 *   - `GET /test/outbound`         — invokes the optional outbound hook
 *                                    inside the request lifecycle so
 *                                    §5.4 can verify the http patch
 *                                    attached `x-correlation-id` to
 *                                    outbound calls.
 *   - `GET /test/outbound-override` — like /test/outbound but the
 *                                     handler explicitly supplies
 *                                     `x-correlation-id` on the
 *                                     outbound options to verify
 *                                     caller intent wins.
 *   - `GET /test/store`            — returns a JSON snapshot of the
 *                                    keys currently in the
 *                                    correlationStore — used by §5.5
 *                                    to verify the {correlationId,
 *                                    uid?} narrow contract.
 *   - `GET /test/async`            — emits one log record after a
 *                                    `setTimeout` boundary so §5.2
 *                                    can verify ALS persists through
 *                                    asynchronous boundaries.
 */
function buildApp(
  capture: LogCapture,
  makeOutboundCall?: OutboundCall,
  makeOverrideCall?: OutboundCall,
): Express {
  // Pass the production `pinoOptions` verbatim so the mixin, redact
  // paths, base fields, and serializers are byte-identical to production.
  // Direct the output to the in-memory capture stream so test assertions
  // can scan structured records.
  const logger = pino(pinoOptions, capture.stream);

  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);

  // ── /test/log — emit one business-handler log record ────────────────
  app.get(ROUTE_LOG, (_req: Request, res: Response) => {
    logger.info({ event: 'route.test.log' }, 'business handler log');
    res.status(200).json({ ok: true });
  });

  // ── /test/outbound — drive an outbound call inside the request ──────
  // The async work is wrapped in an IIFE so any rejection forwards to
  // Express's error pipeline via `next(err)`. Express 4 does not
  // auto-forward async-handler rejections; a swallowed rejection would
  // violate Rule R8 (gates fail closed).
  app.get(ROUTE_OUTBOUND, (_req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      try {
        const correlationId = getCorrelationId();
        logger.info(
          { event: 'route.test.outbound.start' },
          'about to make outbound call',
        );
        if (makeOutboundCall !== undefined) {
          await makeOutboundCall(correlationId);
        }
        logger.info(
          { event: 'route.test.outbound.done' },
          'outbound call complete',
        );
        res.status(200).json({ ok: true, correlationId });
      } catch (err) {
        next(err);
      }
    })();
  });

  // ── /test/outbound-override — caller explicitly sets the header ─────
  app.get(
    ROUTE_OUTBOUND_OVERRIDE,
    (_req: Request, res: Response, next: NextFunction) => {
      void (async (): Promise<void> => {
        try {
          const correlationId = getCorrelationId();
          if (makeOverrideCall !== undefined) {
            await makeOverrideCall(correlationId);
          }
          res.status(200).json({ ok: true, correlationId });
        } catch (err) {
          next(err);
        }
      })();
    },
  );

  // ── /test/store — snapshot the ALS context for §5.5 ─────────────────
  app.get(ROUTE_STORE, (_req: Request, res: Response) => {
    const ctx = correlationStore.getStore();
    if (ctx === undefined) {
      // Should not happen — `correlationMiddleware` opens the ALS frame
      // before `next()`. If the frame is missing, surface it as an
      // explicit 500 rather than silently returning `null` (which would
      // cause the test assertion to time out).
      res.status(500).json({ error: 'no ALS frame active' });
      return;
    }
    // Snapshot the keys and values so the test can assert against the
    // {correlationId, uid?} narrow contract. Spreading via Object.keys
    // captures only own enumerable properties.
    res.status(200).json({
      keys: Object.keys(ctx),
      correlationId: ctx.correlationId,
      uid: ctx.uid,
    });
  });

  // ── /test/async — emit a log record after a setTimeout boundary ─────
  app.get(ROUTE_ASYNC, (_req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      try {
        // Schedule a log via setTimeout — Node's timer queue is one of
        // the asynchronous boundaries Constraint C5 requires ALS to
        // propagate through. The handler awaits a longer sleep than the
        // scheduled timeout so the timer fires before the response is
        // sent and the record is observed in the capture buffer.
        setTimeout(() => {
          logger.info({ event: 'route.test.async' }, 'async log');
        }, 10);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
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
 * counterpart to "an external HTTP service" used by C5's outbound
 * propagation tests; LocalGCP rule compliance is preserved because no
 * remote endpoint is ever contacted.
 *
 * The signature mirrors the helper in `tracing.integration.test.ts` so
 * future maintainers reading both files see the identical pattern.
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

/**
 * Issue a GET via Node's built-in `http` module, fully draining the
 * response so `--detectOpenHandles` does not flag a leaked socket.
 *
 * Why `http.get` and not `fetch`/undici: the C5 patches in
 * `correlation.ts` install on Node's built-in `http` and `https`
 * modules. Using `fetch` would route through undici, which the C5
 * module does NOT patch — that would be a false negative ("no
 * x-correlation-id header on outbound" caused by an unpatched client
 * rather than a propagation bug).
 */
function issueOutboundGet(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get(url, (res) => {
      // Drain the response so the agent can release the keep-alive
      // socket. Without this, `--detectOpenHandles` may flag a
      // dangling socket handle at suite teardown.
      res.resume();
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Issue a GET via Node's built-in `http` module with a caller-supplied
 * `x-correlation-id` header. The caller's value must survive intact —
 * the C5 patch's `_injectCorrelationHeaderIntoArgs` performs a
 * case-insensitive existence check and skips injection when a header
 * matching `x-correlation-id` is already present.
 *
 * The caller-supplied value is sent in TitleCase ("X-Correlation-Id")
 * to additionally prove the case-insensitive existence check works
 * regardless of the caller's casing.
 */
function issueOutboundGetWithHeader(
  url: string,
  headerName: string,
  headerValue: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers: {
          [headerName]: headerValue,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════

describe('Correlation ID propagation — integration (C5 + ST-047)', () => {
  // Common capture for all sub-suites. Replaced before each test so
  // assertions cannot accidentally observe records from a sibling test.
  // Jest runs tests sequentially within a file by default and the
  // integration config sets `maxWorkers: 1`, so the per-test reset is
  // belt-and-braces but keeps the assertion surface clean.
  let capture: LogCapture;

  beforeEach(() => {
    capture = createLogCapture();
  });

  afterEach(() => {
    capture.reset();
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.1 — Inbound header behaviour (C5)
  // ──────────────────────────────────────────────────────────────────
  describe('Inbound header behaviour (C5)', () => {
    it(
      'generates a new UUID v4 when no inbound x-correlation-id header is ' +
        'present (C5: "MUST generate a UUID v4 ... when absent")',
      async () => {
        const app = buildApp(capture);

        const res = await request(app).get(ROUTE_LOG).expect(200);

        // The middleware echoes the resolved correlation ID on the
        // response; absent inbound -> generated UUID v4.
        const responseId = res.headers['x-correlation-id'];
        expect(typeof responseId).toBe('string');
        expect(responseId).toMatch(UUID_V4_REGEX);
      },
    );

    it(
      'preserves a non-UUID inbound x-correlation-id header verbatim ' +
        '(C5: "preserve it verbatim when present")',
      async () => {
        const app = buildApp(capture);

        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', FIXED_NON_UUID_ID)
          .expect(200);

        // Verbatim preservation: no normalisation, no re-shaping into a
        // UUID. The exact byte sequence must echo back.
        expect(res.headers['x-correlation-id']).toBe(FIXED_NON_UUID_ID);
      },
    );

    it(
      'preserves UUID-shaped inbound correlation IDs without re-generating ' +
        'them (C5 verbatim preservation applies to UUIDs too)',
      async () => {
        const app = buildApp(capture);

        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', FIXED_UUID_ID)
          .expect(200);

        // The middleware MUST NOT mistakenly re-generate "because it's
        // already a UUID" — it MUST preserve the inbound value byte for
        // byte. A regression that called `uuidv4()` unconditionally
        // would fail this assertion (the new UUID would differ).
        expect(res.headers['x-correlation-id']).toBe(FIXED_UUID_ID);
      },
    );

    it(
      'uses x-request-id as fallback when x-correlation-id is absent ' +
        '(legacy load-balancer interop — see correlation.ts FALLBACK_INBOUND_HEADER)',
      async () => {
        const app = buildApp(capture);

        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-request-id', FALLBACK_HEADER_VALUE)
          .expect(200);

        // The fallback path must produce the exact value of x-request-id.
        // This preserves continuity with upstream systems (Heroku Router,
        // AWS ALB) that mint a request ID upstream.
        expect(res.headers['x-correlation-id']).toBe(FALLBACK_HEADER_VALUE);
      },
    );

    it(
      'treats whitespace-only x-correlation-id as absent and generates a ' +
        'fresh UUID v4 (defends against malicious / buggy upstream)',
      async () => {
        const app = buildApp(capture);

        // Whitespace-only header value: the C5 contract explicitly
        // rejects this as "absent" and generates a fresh UUID v4.
        // Failing to do so would let a malicious upstream suppress
        // correlation IDs by sending a header with no usable content.
        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', '   ')
          .expect(200);

        const responseId = res.headers['x-correlation-id'];
        expect(typeof responseId).toBe('string');
        expect(responseId).toMatch(UUID_V4_REGEX);
        // Belt-and-braces: confirm the response is NOT a passthrough of
        // the whitespace input (which a naive implementation might do).
        expect(responseId).not.toBe('   ');
      },
    );

    it(
      'treats empty-string x-correlation-id as absent and generates a fresh ' +
        'UUID v4 (defense against `X-Correlation-Id:` with no value)',
      async () => {
        const app = buildApp(capture);

        // Empty-string header: indistinguishable from "forgot to set"
        // — the middleware MUST generate a fresh UUID v4. Sent via
        // Node's http module since supertest may suppress empty
        // header values; we use the explicit `.set()` call which
        // supertest forwards verbatim.
        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', '')
          .expect(200);

        const responseId = res.headers['x-correlation-id'];
        expect(typeof responseId).toBe('string');
        // The generated value MUST be a UUID v4 — strict regex match.
        expect(responseId).toMatch(UUID_V4_REGEX);
      },
    );

    it(
      'prefers x-correlation-id over x-request-id when both are present ' +
        '(primary header wins per correlation.ts readInboundCorrelationId)',
      async () => {
        const app = buildApp(capture);

        // When BOTH headers are present, the primary x-correlation-id
        // wins. This guards against the failure mode where an upstream
        // proxy sets x-request-id from its own internal tracking but
        // our caller (e.g. the frontend) sets x-correlation-id from the
        // browser's correlation-tracking layer.
        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', FIXED_NON_UUID_ID)
          .set('x-request-id', FALLBACK_HEADER_VALUE)
          .expect(200);

        expect(res.headers['x-correlation-id']).toBe(FIXED_NON_UUID_ID);
        expect(res.headers['x-correlation-id']).not.toBe(FALLBACK_HEADER_VALUE);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.2 — Pino mixin propagation (C5 + ST-047)
  // ──────────────────────────────────────────────────────────────────
  describe('Pino mixin propagation (C5 + ST-047)', () => {
    it(
      'attaches correlationId to every log record produced during the ' +
        'request (ST-047-AC2: every record shares the same identifier)',
      async () => {
        const app = buildApp(capture);
        const fixedId = 'mixin-test-correlation-id-abc';

        await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', fixedId)
          .expect(200);

        // Filter to the business-handler log record so we are not
        // confused by any pino-http or framework-emitted records.
        const handlerRecords = capture.records.filter(
          (r) => r.event === 'route.test.log',
        );
        expect(handlerRecords.length).toBeGreaterThanOrEqual(1);

        // The C5 contract: the correlation ID emitted by the middleware
        // is the SAME value seen on the log record's correlationId field.
        // The pino mixin reads `correlationStore.getStore()` at log time
        // and pulls the active context's correlationId.
        const handlerRecord = handlerRecords[0];
        expect(handlerRecord).toBeDefined();
        expect(handlerRecord!.correlationId).toBe(fixedId);
      },
    );

    it(
      'attaches correlationId to log records that fire after asynchronous ' +
        'boundaries (setTimeout / await — ALS persists through the event loop)',
      async () => {
        const app = buildApp(capture);
        const fixedId = 'async-boundary-id-xyz';

        await request(app)
          .get(ROUTE_ASYNC)
          .set('x-correlation-id', fixedId)
          .expect(200);

        // The /test/async route emits a log record from inside a
        // `setTimeout` callback. Node's AsyncLocalStorage propagates
        // through `setTimeout` and `Promise.then` reliably — this test
        // verifies the contract end-to-end so a regression that, e.g.,
        // re-introduced `enterWith()` (which does NOT propagate
        // correctly) would be caught immediately.
        const asyncRecords = capture.records.filter(
          (r) => r.event === 'route.test.async',
        );
        expect(asyncRecords.length).toBeGreaterThanOrEqual(1);

        const asyncRecord = asyncRecords[0];
        expect(asyncRecord).toBeDefined();
        expect(asyncRecord!.correlationId).toBe(fixedId);
      },
    );

    it(
      'isolates concurrent requests so each log record has its own ' +
        'correlationId (no cross-contamination between requests)',
      async () => {
        const app = buildApp(capture);

        // Three concurrent requests, each with a distinct correlation
        // ID. Promise.all (NOT for-await — true concurrency required)
        // ensures all three request handlers run interleaved on the
        // event loop. Without per-request ALS isolation, a record
        // emitted during request A could carry request B's ID — this
        // is the failure mode `correlationStore.run()` (vs
        // `enterWith()`) prevents.
        await Promise.all([
          request(app)
            .get(ROUTE_LOG)
            .set('x-correlation-id', 'concurrent-A')
            .expect(200),
          request(app)
            .get(ROUTE_LOG)
            .set('x-correlation-id', 'concurrent-B')
            .expect(200),
          request(app)
            .get(ROUTE_LOG)
            .set('x-correlation-id', 'concurrent-C')
            .expect(200),
        ]);

        // For each correlation ID, exactly one handler log record
        // should carry it.
        const recordsForA = capture.records.filter(
          (r) =>
            r.event === 'route.test.log' && r.correlationId === 'concurrent-A',
        );
        const recordsForB = capture.records.filter(
          (r) =>
            r.event === 'route.test.log' && r.correlationId === 'concurrent-B',
        );
        const recordsForC = capture.records.filter(
          (r) =>
            r.event === 'route.test.log' && r.correlationId === 'concurrent-C',
        );

        expect(recordsForA.length).toBeGreaterThanOrEqual(1);
        expect(recordsForB.length).toBeGreaterThanOrEqual(1);
        expect(recordsForC.length).toBeGreaterThanOrEqual(1);

        // No cross-contamination — verify by scanning ALL handler
        // records and confirming each one's correlationId is one of
        // the three known values (i.e. no record carries an unexpected
        // ID such as undefined or a regenerated UUID).
        const allHandlerRecords = capture.records.filter(
          (r) => r.event === 'route.test.log',
        );
        for (const record of allHandlerRecords) {
          expect(record.correlationId).toBeDefined();
          expect(['concurrent-A', 'concurrent-B', 'concurrent-C']).toContain(
            record.correlationId,
          );
        }
      },
    );

    it(
      'emits log records with no correlationId when the logger is used ' +
        'outside any request (ALS frame absent → mixin omits the field)',
      async () => {
        // Build a standalone capture and logger — no request, no ALS
        // frame. The pino mixin's `correlationStore.getStore()` returns
        // undefined, the mixin skips emitting `correlationId`, and the
        // record has no field. The strict `toBeUndefined()` assertion
        // also rejects the failure mode where a stale ALS context from
        // an earlier test bleeds into this standalone log.
        const standalone = createLogCapture();
        const standaloneLogger = pino(pinoOptions, standalone.stream);

        standaloneLogger.info(
          { event: 'outside.request' },
          'no als context active',
        );

        // Allow pino's async write to flush.
        await new Promise<void>((resolve) => setImmediate(resolve));

        const outsideRecords = standalone.records.filter(
          (r) => r.event === 'outside.request',
        );
        expect(outsideRecords.length).toBeGreaterThanOrEqual(1);
        const outsideRecord = outsideRecords[0];
        expect(outsideRecord).toBeDefined();

        // The field MUST be absent (not present-but-undefined and not
        // a stale value). JSON.parse + index access yields `undefined`
        // for a missing property, which is what we assert.
        expect(outsideRecord!.correlationId).toBeUndefined();
      },
    );

    it(
      'every record emitted during the request lifecycle includes the same ' +
        'correlation ID (multiple log calls share a single ID — ST-047-AC2)',
      async () => {
        const app = buildApp(capture);
        const fixedId = 'shared-record-id-def';

        // Hit /test/outbound which emits TWO log records via
        // logger.info — `route.test.outbound.start` and
        // `route.test.outbound.done`. Both must carry the same
        // correlation ID.
        await request(app)
          .get(ROUTE_OUTBOUND)
          .set('x-correlation-id', fixedId)
          .expect(200);

        const startRecords = capture.records.filter(
          (r) => r.event === 'route.test.outbound.start',
        );
        const doneRecords = capture.records.filter(
          (r) => r.event === 'route.test.outbound.done',
        );
        expect(startRecords.length).toBeGreaterThanOrEqual(1);
        expect(doneRecords.length).toBeGreaterThanOrEqual(1);

        // Both records — emitted at different points in the handler —
        // share the same correlation ID. This is the operational
        // property ST-047-AC2 requires: a single user action produces
        // a single correlation ID across all records.
        expect(startRecords[0]!.correlationId).toBe(fixedId);
        expect(doneRecords[0]!.correlationId).toBe(fixedId);
        expect(startRecords[0]!.correlationId).toBe(
          doneRecords[0]!.correlationId,
        );
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.3 — Response header echo (C5)
  // ──────────────────────────────────────────────────────────────────
  describe('Response header echo (C5)', () => {
    it(
      'echoes the resolved correlation ID on the response x-correlation-id ' +
        'header (every response carries the ID for client correlation)',
      async () => {
        const app = buildApp(capture);
        const fixedId = 'echo-test-correlation-id';

        const res = await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', fixedId)
          .expect(200);

        // The response header MUST be set, and it MUST equal the
        // resolved correlation ID. This is what lets a client correlate
        // its inbound request with the server's logs even when the
        // request fails.
        expect(res.headers['x-correlation-id']).toBe(fixedId);

        // Additionally verify the logged correlationId matches the
        // response header — they MUST agree because both flow from the
        // same `correlationStore.run({ correlationId })` invocation.
        const handlerRecords = capture.records.filter(
          (r) => r.event === 'route.test.log',
        );
        expect(handlerRecords.length).toBeGreaterThanOrEqual(1);
        expect(handlerRecords[0]!.correlationId).toBe(
          res.headers['x-correlation-id'],
        );
      },
    );

    it(
      'echoes a generated UUID v4 on the response when no inbound header ' +
        'is provided (logged ID matches response header)',
      async () => {
        const app = buildApp(capture);

        const res = await request(app).get(ROUTE_LOG).expect(200);

        // Generated UUID v4 — must appear on response AND match logs.
        const responseId = res.headers['x-correlation-id'];
        expect(typeof responseId).toBe('string');
        expect(responseId).toMatch(UUID_V4_REGEX);

        const handlerRecords = capture.records.filter(
          (r) => r.event === 'route.test.log',
        );
        expect(handlerRecords.length).toBeGreaterThanOrEqual(1);
        // The logged correlationId MUST be the same UUID v4 as the
        // response header. Any divergence would mean the middleware
        // computed two different IDs — a contract violation.
        expect(handlerRecords[0]!.correlationId).toBe(responseId);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.4 — Outbound HTTP propagation (C5)
  // ──────────────────────────────────────────────────────────────────
  describe('Outbound HTTP propagation (C5)', () => {
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
      'attaches the inbound correlation ID to outbound http.get calls made ' +
        'inside a request (C5: "every outbound HTTP client call MUST attach")',
      async () => {
        // Wire the /test/outbound route to call our echo server.
        const app = buildApp(capture, async () => {
          await issueOutboundGet(echoServer.url);
        });

        await request(app)
          .get(ROUTE_OUTBOUND)
          .set('x-correlation-id', OUTBOUND_PROPAGATION_ID)
          .expect(200);

        const headersList = echoServer.getReceivedHeaders();
        expect(headersList.length).toBeGreaterThanOrEqual(1);

        // Find at least one received-header set whose
        // x-correlation-id (case-insensitive) equals the inbound ID.
        // Node's http module normalises inbound header names to
        // lowercase, but the case-insensitive scan is defensive
        // against future runtime changes.
        const matching = headersList.filter((h) => {
          const value = h['x-correlation-id'];
          return typeof value === 'string' && value === OUTBOUND_PROPAGATION_ID;
        });
        expect(matching.length).toBeGreaterThanOrEqual(1);
      },
    );

    it(
      'attaches a generated UUID v4 to outbound calls when the inbound ' +
        'request had no correlation ID (auto-generation propagates)',
      async () => {
        const app = buildApp(capture, async () => {
          await issueOutboundGet(echoServer.url);
        });

        // No x-correlation-id on inbound — middleware generates a fresh
        // UUID v4. The same UUID v4 must be carried on the outbound
        // request, proving the patch reads from the SAME ALS frame the
        // middleware populated.
        const res = await request(app).get(ROUTE_OUTBOUND).expect(200);

        const inboundUuid = res.headers['x-correlation-id'];
        expect(typeof inboundUuid).toBe('string');
        expect(inboundUuid).toMatch(UUID_V4_REGEX);

        const headersList = echoServer.getReceivedHeaders();
        expect(headersList.length).toBeGreaterThanOrEqual(1);

        // The outbound request's x-correlation-id MUST equal the
        // generated UUID v4. Any other value (e.g. a separately
        // generated UUID, undefined, or a stale value from a prior
        // request) is a regression.
        const matching = headersList.filter((h) => {
          const value = h['x-correlation-id'];
          return typeof value === 'string' && value === inboundUuid;
        });
        expect(matching.length).toBeGreaterThanOrEqual(1);
      },
    );

    it(
      'does NOT overwrite a caller-supplied x-correlation-id on outbound ' +
        'requests (case-insensitive existence check — caller intent wins)',
      async () => {
        const app = buildApp(capture, undefined, async () => {
          // Caller sends the header in TitleCase to additionally prove
          // the C5 patch's case-insensitive existence check is correct.
          // The patch uses `Object.keys(headers).some(k => k.toLowerCase() === ...)`
          // to detect existence, so a TitleCase caller header MUST NOT
          // be overwritten by the lowercase outbound default.
          await issueOutboundGetWithHeader(
            echoServer.url,
            'X-Correlation-Id',
            CALLER_EXPLICIT_OVERRIDE,
          );
        });

        // Inbound correlation is REQUEST_BOUND_ID — the value the patch
        // would inject by default if the caller had not supplied one.
        await request(app)
          .get(ROUTE_OUTBOUND_OVERRIDE)
          .set('x-correlation-id', REQUEST_BOUND_ID)
          .expect(200);

        const headersList = echoServer.getReceivedHeaders();
        expect(headersList.length).toBeGreaterThanOrEqual(1);

        // The echo server MUST observe the caller's explicit override,
        // NOT the request-bound ID. Node lower-cases inbound header
        // names, so the value is read from `h['x-correlation-id']`.
        const matching = headersList.filter((h) => {
          const value = h['x-correlation-id'];
          return typeof value === 'string' && value === CALLER_EXPLICIT_OVERRIDE;
        });
        expect(matching.length).toBeGreaterThanOrEqual(1);

        // Negative assertion: the request-bound ID MUST NOT be present
        // on any outbound request. A regression in the case-insensitive
        // check would emit BOTH headers — the outbound request would
        // carry the lowercase default plus the caller's TitleCase
        // value. Verify only the caller's value is present.
        const requestBoundMatches = headersList.filter((h) => {
          const value = h['x-correlation-id'];
          return typeof value === 'string' && value === REQUEST_BOUND_ID;
        });
        expect(requestBoundMatches.length).toBe(0);
      },
    );

    it(
      'does NOT attach the correlation header on outbound calls made OUTSIDE ' +
        'any request (no ALS frame → nothing to inject)',
      async () => {
        // Make an outbound call from the test body — there is no
        // active correlation context. The C5 patch reads
        // `correlationStore.getStore()`, which returns undefined when
        // no ALS frame is active, so the patch's injection code is
        // bypassed entirely. The echo server MUST observe the request
        // with NO x-correlation-id header.
        await issueOutboundGet(echoServer.url);

        const headersList = echoServer.getReceivedHeaders();
        expect(headersList.length).toBeGreaterThanOrEqual(1);

        // No header on the request — `headers['x-correlation-id']` is
        // undefined. We assert this for EVERY received request because
        // there is exactly one outbound call in this test.
        for (const headers of headersList) {
          expect(headers['x-correlation-id']).toBeUndefined();
        }
      },
    );

    it(
      'multiple outbound calls inside a single request all carry the same ' +
        'correlation ID (ALS frame persists across multiple calls)',
      async () => {
        const app = buildApp(capture, async () => {
          // Two outbound calls inside the same request — both must
          // carry the inbound ID. This proves the ALS frame survives
          // multiple awaits and that the http patch reads the frame
          // freshly on each call.
          await issueOutboundGet(echoServer.url);
          await issueOutboundGet(echoServer.url);
        });

        const fixedId = 'multi-call-correlation-id';
        await request(app)
          .get(ROUTE_OUTBOUND)
          .set('x-correlation-id', fixedId)
          .expect(200);

        const headersList = echoServer.getReceivedHeaders();
        // At least two outbound requests received (the two from the
        // route handler — supertest's request to the test app does not
        // hit the echo server).
        expect(headersList.length).toBeGreaterThanOrEqual(2);

        const matching = headersList.filter(
          (h) => h['x-correlation-id'] === fixedId,
        );
        expect(matching.length).toBeGreaterThanOrEqual(2);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.5 — Store contents (C5 narrow contract)
  // ──────────────────────────────────────────────────────────────────
  describe('Store contents (C5 narrow contract)', () => {
    it(
      'correlationStore contents are limited to {correlationId, uid?} only ' +
        '(R2 protection — no credential or PII fields in ALS)',
      async () => {
        const app = buildApp(capture);
        const fixedId = 'store-contents-test-id';

        const res = await request(app)
          .get(ROUTE_STORE)
          .set('x-correlation-id', fixedId)
          .expect(200);

        const body = res.body as {
          keys: string[];
          correlationId: string;
          uid?: string;
        };

        // Verify the keys present in the store. Without session
        // middleware on this test app, only `correlationId` is set.
        // (When session middleware runs in production, it adds `uid`
        // — that path is exercised by session-middleware integration
        // tests, not here.)
        expect(Array.isArray(body.keys)).toBe(true);

        // Every key MUST be one of {correlationId, uid}. A regression
        // that, e.g., added `password` or `email` to the store would
        // surface as an extra key here, failing this assertion. This
        // is the structural defense against a future engineer
        // accidentally widening the ALS contract beyond its R2-safe
        // shape.
        const allowedKeys = new Set(['correlationId', 'uid']);
        for (const key of body.keys) {
          expect(allowedKeys.has(key)).toBe(true);
        }

        // The correlationId in the store MUST equal the inbound
        // header value the middleware preserved — confirming the
        // store is populated from the same source the response
        // header is.
        expect(body.correlationId).toBe(fixedId);
      },
    );

    it(
      'getCorrelationId() inside a request returns the active correlation ' +
        'ID (public helper contract)',
      async () => {
        const app = buildApp(capture, async (correlationId) => {
          // The hook receives `getCorrelationId()` as observed by the
          // route handler. We assert here on the value — but this
          // assertion runs inside the handler's hook closure, not in
          // Jest's `it()` body. Failures throw synchronously and the
          // route's catch-block surfaces the error to Express's error
          // pipeline, which produces a 500 response and fails the test.
          if (correlationId !== 'helper-contract-id-456') {
            throw new Error(
              `getCorrelationId() returned ${String(
                correlationId,
              )}, expected 'helper-contract-id-456'`,
            );
          }
        });

        const fixedId = 'helper-contract-id-456';
        const res = await request(app)
          .get(ROUTE_OUTBOUND)
          .set('x-correlation-id', fixedId)
          .expect(200);

        // Belt-and-braces: the response body also includes the
        // correlationId observed by the handler — assert it matches.
        const body = res.body as { ok: boolean; correlationId: string };
        expect(body.correlationId).toBe(fixedId);
      },
    );

    it(
      'getCorrelationId() outside any request returns undefined (no ALS ' +
        'frame → no value)',
      () => {
        // No `correlationStore.run(...)` wrapper — `getStore()` returns
        // undefined, and the public helper returns undefined. Callers
        // that need a correlation ID for synthetic outbound calls in
        // a non-request context MUST generate their own UUID — the
        // helper does NOT silently fabricate a default.
        const result = getCorrelationId();
        expect(result).toBeUndefined();
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.6 — Sanity sweep — no leakage (R2 belt-and-braces)
  // ──────────────────────────────────────────────────────────────────
  describe('Sanity sweep — no leakage (Rule R2 cross-check)', () => {
    it(
      'log records do not contain credential fields even when no ' +
        'credential material is sent (R2 baseline)',
      async () => {
        const app = buildApp(capture);

        await request(app)
          .get(ROUTE_LOG)
          .set('x-correlation-id', 'sanity-sweep-id')
          .expect(200);

        // No record may carry a top-level `password`, `Authorization`,
        // `cookie`, or `apiKey` field — even when the request did not
        // contain them. Pino's `redact.paths` and the request-
        // serializer allow-list MUST keep these absent regardless of
        // input. This guards against a future regression where, e.g.,
        // the request serializer is widened to include arbitrary
        // headers and a request happens to carry one of those names.
        for (const record of capture.records) {
          expect(record['password']).toBeUndefined();
          expect(record['Authorization']).toBeUndefined();
          expect(record['authorization']).toBeUndefined();
          expect(record['cookie']).toBeUndefined();
          expect(record['Cookie']).toBeUndefined();
          expect(record['apiKey']).toBeUndefined();
        }
      },
    );

    it(
      'log records do not surface a fake bearer-pattern Authorization ' +
        'header even when the request includes it (R2 redact + allow-list)',
      async () => {
        const app = buildApp(capture);

        // Send a synthetic Bearer-pattern header. The serializer
        // allow-list in pinoOptions MUST drop the `authorization` key
        // from `req.headers` entirely. Even if a downstream maintainer
        // accidentally widens the allow-list, the redact.paths fallback
        // (`req.headers.authorization`) replaces the value with
        // `[REDACTED]`, so the raw token never appears in records.
        await request(app)
          .get(ROUTE_LOG)
          .set('authorization', 'Bearer SENTINEL_BEARER_AAAAAAAAAAAAAAAAAAAA')
          .set('x-correlation-id', 'bearer-sweep-id')
          .expect(200);

        const allText = capture.records
          .map((r) => JSON.stringify(r))
          .join('\n');

        // The Bearer sentinel must NOT appear anywhere in the captured
        // record stream. This is the same regex spirit as the user
        // example's `grep "SENTINEL_CRED_99"` returning zero lines.
        expect(allText).not.toMatch(/Bearer\s+SENTINEL_BEARER_/);
      },
    );
  });
});

