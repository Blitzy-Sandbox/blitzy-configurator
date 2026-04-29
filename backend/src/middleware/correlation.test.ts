/**
 * Unit tests for `backend/src/middleware/correlation.ts`.
 *
 * Verifies the C5 contract surface against the public API
 * (`correlationMiddleware`, `correlationStore`, `getCorrelationId`)
 * exported from the module under test.
 *
 * Contract surface verified (per AAP §0.8.1 Rule C5, ST-026, ST-047):
 *
 *   1. Header preservation:    inbound `x-correlation-id` is used verbatim.
 *   2. UUID v4 generation:     absent header => fresh RFC 4122 UUID v4.
 *   3. Empty / whitespace:     treated as absent; new UUID generated.
 *   4. Array-valued header:    first element wins (RFC 7230 conformance).
 *   5. Response echo:          `res.setHeader('x-correlation-id', id)` set.
 *   6. `req.correlationId`:    attached to the request object synchronously.
 *   7. AsyncLocalStorage:      `correlationStore.getStore()` returns the
 *                              context inside the `next()` callback and all
 *                              its async continuations (setTimeout,
 *                              process.nextTick, Promise.then).
 *   8. Concurrent isolation:   two requests with overlapping timers each
 *                              observe ONLY their own correlation ID — no
 *                              cross-talk between ALS frames.
 *   9. Allow-list shape:       store contains only `correlationId` and
 *                              optionally `uid` (Rule R2: no credential
 *                              material can leak into log records).
 *  10. `next()` invariants:    called exactly once with no arguments on
 *                              both the header-present and UUID-generated
 *                              paths.
 *  11. `getCorrelationId()`:   returns the current ID inside an ALS frame;
 *                              returns `undefined` outside any frame.
 *  12. Outbound HTTP propagation: `http.request(...)` invoked from inside
 *                              an ALS frame produces a `ClientRequest`
 *                              whose `x-correlation-id` header equals the
 *                              ALS context's correlation ID.
 *  13. Outbound HTTP preservation: when the caller explicitly sets
 *                              `x-correlation-id` on the outbound request,
 *                              the middleware does NOT overwrite it
 *                              (caller intent always wins).
 *  14. Outbound outside ALS:   when no ALS frame is active, the
 *                              `http.request` patch is a no-op — outbound
 *                              requests carry no correlation header.
 *
 * Authority:
 *   - tickets/stories/ST-026-session-validation-middleware-contract.md
 *     (the request context contract that this middleware feeds).
 *   - tickets/stories/ST-047-structured-logs-correlation-id.md AC2 — the
 *     "generated when absent / preserved when present / forwarded
 *     downstream" requirement.
 *   - tickets/stories/ST-049-distributed-tracing-dashboard-template-stub.md
 *     AC1/AC2 — correlation ID rides alongside W3C `traceparent`.
 *   - tickets/stories/ST-043-unit-test-suite.md AC3 (deterministic) and
 *     AC4 (no network access beyond the local toolchain).
 *   - AAP §0.7.1 "Exhaustively In Scope" — co-located unit tests under
 *     `backend/src` (the `*.test.ts` glob pattern).
 *   - AAP §0.8.1 Rule C5 — verbatim source of every behaviour asserted
 *     in this file.
 *
 * Determinism (ST-043-AC3):
 *   - The Jest config (`backend/jest.config.unit.ts`) sets `clearMocks`,
 *     `resetMocks`, and `restoreMocks` to `true`, so every spy installed
 *     by `jest.spyOn` is reverted between tests automatically.
 *   - No fake timers are used. The C5 contract REQUIRES real
 *     AsyncLocalStorage propagation across real async boundaries
 *     (setTimeout, Promise.then, process.nextTick); fake timers would
 *     break that propagation and produce false-positive passes.
 *   - The handful of `setTimeout` waits used for concurrent-isolation
 *     and Promise-chain tests are short (10–60 ms) and well under the
 *     10 s per-test timeout configured in `jest.config.unit.ts`.
 *
 * Locality (ST-043-AC4):
 *   - The outbound-HTTP tests would normally initiate a TCP connection
 *     to the requested host. To stay strictly local-only, the suite
 *     spies on `http.globalAgent.addRequest` and replaces it with a
 *     no-op for those tests. With the agent's queue function disabled,
 *     the native `http.request` constructor still runs and populates
 *     `ClientRequest` headers from the (correlation-injected) options
 *     object — but no socket is ever allocated and no DNS lookup or
 *     TCP connect is initiated. Each `ClientRequest` is `destroy()`ed
 *     before the test returns to release any internal queueing.
 *
 * @see backend/src/middleware/correlation.ts — module under test
 * @see backend/jest.config.unit.ts — Jest runner configuration
 */

import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import http from 'node:http';

import {
  correlationMiddleware,
  correlationStore,
  getCorrelationId,
  _injectCorrelationHeaderIntoFetchInit,
} from './correlation';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal Express-shaped `Request` double. The middleware reads
 * exclusively from `req.headers` (lowercased keys, per Express's own
 * normalisation) and writes `req.correlationId` once the inbound header
 * is decoded; nothing else is touched. A bare object with the headers
 * map is therefore sufficient — booting a real Express app would add
 * cost without exercising any additional contract surface.
 */
function buildReq(headers: Record<string, string | string[] | undefined> = {}): any {
  return {
    headers,
    method: 'GET',
    url: '/api/designs',
  };
}

/**
 * Build a minimal Express-shaped `Response` double. The middleware
 * touches exactly two members on `res`: `setHeader(name, value)` (used
 * to echo the correlation ID on the response) and `getHeader(name)`
 * (used by some tests to read back what was set). Both are recorded via
 * an internal lowercase map so case-insensitive lookups behave the way
 * Node's real `ServerResponse` would.
 */
function buildRes(): any {
  const headers: Record<string, string> = {};
  return {
    _headers: headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
}

/**
 * Canonical RFC 4122 UUID v4 regex.
 *
 * Anatomy: 8-4-4-4-12 hexadecimal digits where:
 *   - the THIRD group's leading nibble MUST be `4` (version).
 *   - the FOURTH group's leading nibble MUST be in `{8, 9, a, b}` (variant
 *     bits `10xx`).
 * The `i` flag tolerates both upper- and lower-case hex (the `uuid` package
 * emits lowercase, but newer Node `crypto.randomUUID()` outputs are also
 * lowercase — the regex is intentionally case-insensitive for forward
 * compatibility).
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Top-level isolation invariant
// ---------------------------------------------------------------------------
//
// A correlation context is established ONLY inside the synchronous body of
// `correlationMiddleware`. At the top level of the module — before any
// describe block or test function has invoked the middleware — there is no
// active ALS frame. This top-level assertion is duplicated as an explicit
// `it()` in the AsyncLocalStorage block below so it runs as part of the
// test suite, but the invariant is stated here as documentation for any
// future contributor reading this file.

describe('correlationMiddleware — C5 contract', () => {
  // -------------------------------------------------------------------------
  // Header preservation when `x-correlation-id` is present
  // -------------------------------------------------------------------------

  describe('preserves x-correlation-id when present', () => {
    it('uses the exact inbound header value verbatim (a UUID v4)', (done) => {
      const inboundId = '4fa3d2c1-7b6e-4a5f-9c8d-3e2f1a0b9c8d';
      const req = buildReq({ 'x-correlation-id': inboundId });
      const res = buildRes();

      const next = jest.fn(() => {
        // Inside next(), the ALS frame is active and the store should
        // carry the EXACT inbound id (no UUID re-generation, no
        // normalisation, no truncation).
        expect(correlationStore.getStore()?.correlationId).toBe(inboundId);
        expect(req.correlationId).toBe(inboundId);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('preserves non-UUID correlation IDs (contract: verbatim pass-through)', (done) => {
      // The C5 contract is "preserve verbatim" — there is NO format
      // validation on the inbound value. Upstream systems may mint
      // request IDs in any opaque format (snowflakes, ksuids, custom
      // schemes), and the middleware MUST pass them through unmodified.
      const opaqueId = 'custom-tracing-id-from-upstream-service-12345';
      const req = buildReq({ 'x-correlation-id': opaqueId });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe(opaqueId);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('honours the lowercase header key as Express normalises it', (done) => {
      // Express normalises every inbound header key to lowercase regardless
      // of wire case (HTTP headers are themselves case-insensitive per
      // RFC 7230). The middleware reads from the lowercase form, which is
      // what Express, Node, and the wire converge on.
      const inboundId = 'inbound-abc-123';
      const req = buildReq({ 'x-correlation-id': inboundId });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe(inboundId);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('handles array-valued header (RFC 7230 duplicates) by taking the first value', (done) => {
      // Node's `http` module surfaces duplicate headers as a string array.
      // Express's `req.header(name)` returns the first element of such
      // arrays, and the middleware's `coerceToString` mirrors that
      // behaviour. The second element is intentionally a different value
      // so we can detect any accidental "join" or "concat" semantics.
      const req = buildReq({
        'x-correlation-id': ['first-value-1234', 'second-value-5678'],
      });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe('first-value-1234');
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('falls back to x-request-id when x-correlation-id is absent', (done) => {
      // The middleware supports a legacy fallback header `x-request-id`
      // for upstream load-balancers (Heroku, AWS ALB, some nginx ingresses)
      // that mint a request ID under that name. The fallback applies ONLY
      // when the primary `x-correlation-id` is absent — never when both
      // are present (in which case the primary always wins).
      const fallbackId = 'lb-issued-request-id-99';
      const req = buildReq({ 'x-request-id': fallbackId });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe(fallbackId);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('prefers x-correlation-id over x-request-id when both are present', (done) => {
      // Primary always wins; the legacy fallback exists ONLY for the
      // missing-primary case.
      const primaryId = 'primary-correlation-id';
      const fallbackId = 'legacy-request-id';
      const req = buildReq({
        'x-correlation-id': primaryId,
        'x-request-id': fallbackId,
      });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe(primaryId);
        done();
      });

      correlationMiddleware(req, res, next);
    });
  });

  // -------------------------------------------------------------------------
  // UUID v4 generation when `x-correlation-id` is absent
  // -------------------------------------------------------------------------

  describe('generates a UUID v4 when x-correlation-id is absent', () => {
    it('generates a UUID v4 string when no inbound header is present', (done) => {
      const req = buildReq({});
      const res = buildRes();

      const next = jest.fn(() => {
        const generated = correlationStore.getStore()?.correlationId;
        expect(generated).toBeDefined();
        // Shape assertion via canonical RFC 4122 v4 regex. Specific value
        // assertions would be brittle: the `uuid` package emits random
        // values — only the shape is contractually stable.
        expect(generated).toMatch(UUID_V4_REGEX);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('generates a DIFFERENT UUID on each invocation', (done) => {
      // Uniqueness is the entire point of correlation IDs — two requests
      // arriving back-to-back without inbound headers MUST receive
      // distinct identifiers so their log records can be told apart.
      let firstId: string | undefined;

      const req1 = buildReq({});
      const res1 = buildRes();
      const next1 = jest.fn(() => {
        firstId = correlationStore.getStore()?.correlationId;
      });
      correlationMiddleware(req1, res1, next1);

      const req2 = buildReq({});
      const res2 = buildRes();
      const next2 = jest.fn(() => {
        const secondId = correlationStore.getStore()?.correlationId;
        expect(secondId).toBeDefined();
        expect(secondId).toMatch(UUID_V4_REGEX);
        expect(firstId).toBeDefined();
        expect(firstId).toMatch(UUID_V4_REGEX);
        expect(secondId).not.toBe(firstId);
        done();
      });
      correlationMiddleware(req2, res2, next2);
    });

    it('treats an empty-string header as absent and generates a new UUID', (done) => {
      // Security-relevant edge case: a buggy or malicious upstream MUST
      // NOT be able to suppress correlation IDs by sending
      // `x-correlation-id: ` (empty). The middleware treats empty as
      // absent and generates a fresh UUID, ensuring every request can
      // be traced.
      const req = buildReq({ 'x-correlation-id': '' });
      const res = buildRes();

      const next = jest.fn(() => {
        const generated = correlationStore.getStore()?.correlationId;
        expect(generated).toMatch(UUID_V4_REGEX);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('treats a whitespace-only header as absent and generates a new UUID', (done) => {
      // The same defensive trim applies to whitespace-only values.
      const req = buildReq({ 'x-correlation-id': '   \t  ' });
      const res = buildRes();

      const next = jest.fn(() => {
        const generated = correlationStore.getStore()?.correlationId;
        expect(generated).toMatch(UUID_V4_REGEX);
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('trims surrounding whitespace from a non-empty inbound header', (done) => {
      // `coerceToString` trims leading/trailing whitespace so an upstream
      // proxy that pads the header with a single space cannot produce a
      // distinct correlation ID. This keeps log queries straightforward
      // ("find logs where correlationId = X" matches regardless of the
      // upstream's whitespace habits).
      const req = buildReq({ 'x-correlation-id': '  trim-me  ' });
      const res = buildRes();

      const next = jest.fn(() => {
        expect(correlationStore.getStore()?.correlationId).toBe('trim-me');
        done();
      });

      correlationMiddleware(req, res, next);
    });
  });

  // -------------------------------------------------------------------------
  // Response header echo
  // -------------------------------------------------------------------------

  describe('echoes the correlation ID on the response header', () => {
    it('sets response x-correlation-id to the inbound ID when present', () => {
      const inboundId = 'abc-123';
      const req = buildReq({ 'x-correlation-id': inboundId });
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      // The middleware sets the response header BEFORE invoking next() so
      // even error responses (4xx, 5xx, thrown errors) carry the ID. The
      // call signature is `setHeader(name, value)` with the canonical
      // lowercase name.
      expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', inboundId);
    });

    it('sets response x-correlation-id to the generated UUID when inbound is absent', () => {
      const req = buildReq({});
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      // Locate the setHeader call for `x-correlation-id` and verify the
      // value matches the canonical UUID v4 shape (specific value would
      // be random and unstable).
      const headerCall = (res.setHeader as jest.Mock).mock.calls.find(
        (c: unknown[]) => c[0] === 'x-correlation-id',
      );
      expect(headerCall).toBeDefined();
      expect(headerCall?.[1]).toMatch(UUID_V4_REGEX);
    });

    it('sets the response header BEFORE next() runs', () => {
      // The ordering is critical: by the time route handlers see the
      // request, the response header has already been queued. This
      // guarantees error paths (handlers that throw before writing the
      // body) also see the correlation ID echoed.
      const req = buildReq({ 'x-correlation-id': 'order-test' });
      const res = buildRes();

      let setHeaderCallCountAtNext = 0;
      const next = jest.fn(() => {
        setHeaderCallCountAtNext = (res.setHeader as jest.Mock).mock.calls.length;
      });

      correlationMiddleware(req, res, next);

      expect(setHeaderCallCountAtNext).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // AsyncLocalStorage context behaviour
  // -------------------------------------------------------------------------

  describe('AsyncLocalStorage context', () => {
    it('exposes correlationStore with no active frame at module load time', () => {
      // Before any middleware invocation, the ALS instance is dormant
      // (no active frame). Outside any request, getStore() returns
      // undefined. This is the intentional behaviour codified by the
      // C5 contract: "callers in those contexts that need a correlation
      // ID for a synthetic outbound call MUST generate their own UUID".
      const currentStore = correlationStore.getStore();
      expect(currentStore).toBeUndefined();
    });

    it('persists the store through a setTimeout chain inside next()', (done) => {
      const req = buildReq({ 'x-correlation-id': 'tick-12345' });
      const res = buildRes();

      const next = jest.fn(() => {
        // The setTimeout callback runs asynchronously, on a different
        // tick. AsyncLocalStorage's contract is that the ALS frame
        // propagates through this async boundary; if it does not, the
        // store would be undefined inside the timer and the test fails.
        setTimeout(() => {
          expect(correlationStore.getStore()?.correlationId).toBe('tick-12345');
          done();
        }, 10);
      });

      correlationMiddleware(req, res, next);
    });

    it('persists the store through a Promise.then chain inside next()', async () => {
      const req = buildReq({ 'x-correlation-id': 'promise-67890' });
      const res = buildRes();
      let observedId: string | undefined;

      const next = jest.fn(() => {
        // Microtask continuation. A Promise's .then callback runs in a
        // separate microtask but on the same call stack frame as the
        // original Promise resolution; ALS MUST propagate through this
        // boundary.
        //
        // We use the `void` operator to discard the Promise — Express's
        // `NextFunction` is synchronous (returns `void`), so we must not
        // return the Promise to the middleware. The `.then` callback
        // still schedules a microtask and `observedId` is still captured.
        void Promise.resolve().then(() => {
          observedId = correlationStore.getStore()?.correlationId;
        });
      });

      correlationMiddleware(req, res, next);
      // Yield to the microtask queue so the .then callback runs before
      // we read `observedId`. A 10 ms macrotask delay is more than
      // sufficient for any pending microtasks (which are drained before
      // the next macrotask).
      await setTimeoutPromise(10);

      expect(observedId).toBe('promise-67890');
    });

    it('persists the store through process.nextTick inside next()', (done) => {
      const req = buildReq({ 'x-correlation-id': 'nextTick-abc' });
      const res = buildRes();

      const next = jest.fn(() => {
        // process.nextTick is its own continuation queue (drained between
        // the current operation and the next phase of the event loop).
        // ALS propagates through it like any other async boundary.
        process.nextTick(() => {
          expect(correlationStore.getStore()?.correlationId).toBe('nextTick-abc');
          done();
        });
      });

      correlationMiddleware(req, res, next);
    });

    it('persists the store across an awaited Promise inside next()', async () => {
      const req = buildReq({ 'x-correlation-id': 'await-xyz' });
      const res = buildRes();
      let observedAfterAwait: string | undefined;

      const next = jest.fn(() => {
        // The async IIFE suspends on the await and resumes on a new
        // microtask. ALS MUST propagate through await boundaries because
        // every realistic Express handler uses async/await pervasively.
        //
        // We wrap the async work in an immediately-invoked async function
        // and `void` the resulting Promise so `next` itself returns
        // `void` (matching Express's `NextFunction` contract). The outer
        // test then awaits a macrotask delay long enough for the inner
        // await to resolve.
        void (async () => {
          await setTimeoutPromise(5);
          observedAfterAwait = correlationStore.getStore()?.correlationId;
        })();
      });

      correlationMiddleware(req, res, next);
      await setTimeoutPromise(20);

      expect(observedAfterAwait).toBe('await-xyz');
    });

    it('isolates concurrent request frames so neither sees the other', (done) => {
      // The #1 production bug in correlation systems is ALS frames
      // bleeding between requests. This test invokes two middleware
      // calls back-to-back, with overlapping setTimeout callbacks, and
      // asserts that each request observes ONLY its own correlation ID.
      // A failure here would mean log records in production could carry
      // the WRONG correlation ID — an obvious operational catastrophe.
      const observations: Array<{ who: string; id: string | undefined }> = [];

      const reqA = buildReq({ 'x-correlation-id': 'aaa-isolation' });
      const resA = buildRes();
      const nextA = jest.fn(() => {
        // A's continuation fires LATER (20 ms) so B's continuation runs
        // first and could hypothetically pollute A's frame.
        setTimeout(() => {
          observations.push({
            who: 'A',
            id: correlationStore.getStore()?.correlationId,
          });
        }, 20);
      });

      const reqB = buildReq({ 'x-correlation-id': 'bbb-isolation' });
      const resB = buildRes();
      const nextB = jest.fn(() => {
        setTimeout(() => {
          observations.push({
            who: 'B',
            id: correlationStore.getStore()?.correlationId,
          });
        }, 10);
      });

      correlationMiddleware(reqA, resA, nextA);
      correlationMiddleware(reqB, resB, nextB);

      // Wait long enough for both timers to fire (worst case 20 ms),
      // then assert each saw the expected ID — never the other's.
      setTimeout(() => {
        const observationA = observations.find((o) => o.who === 'A');
        const observationB = observations.find((o) => o.who === 'B');
        expect(observationA?.id).toBe('aaa-isolation');
        expect(observationB?.id).toBe('bbb-isolation');
        done();
      }, 60);
    });

    it('store contains only correlationId and uid keys (Rule R2 allow-list)', (done) => {
      // Rule R2 forbids credential material in log records. The pino
      // logger is configured to emit ONLY the keys present on the ALS
      // store — so adding any other field here would silently propagate
      // it into log lines. This test pins the allow-list at exactly
      // {correlationId, uid?}: any future PR adding a third field
      // breaks the test, forcing a deliberate Rule-R2 review.
      const req = buildReq({});
      const res = buildRes();

      const next = jest.fn(() => {
        const store = correlationStore.getStore();
        expect(store).toBeDefined();
        const keys = Object.keys(store!);
        // `correlationId` is always present; `uid` is added later by
        // session middleware (after `verifyIdToken` succeeds) and is
        // therefore absent on a fresh frame.
        expect(keys).toContain('correlationId');
        for (const k of keys) {
          expect(['correlationId', 'uid']).toContain(k);
        }
        done();
      });

      correlationMiddleware(req, res, next);
    });

    it('returns to no-active-frame after the middleware callback unwinds', async () => {
      // After the middleware's run() callback completes, the ALS frame
      // is reference-counted out of existence. A subsequent top-level
      // read MUST see no active frame — otherwise frames would leak
      // and accumulate over time.
      const req = buildReq({ 'x-correlation-id': 'unwind-check' });
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);
      // Yield to ensure any synchronous post-run cleanup has completed.
      await setTimeoutPromise(5);

      expect(correlationStore.getStore()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // `req.correlationId` attachment
  // -------------------------------------------------------------------------

  describe('req.correlationId attachment', () => {
    it('attaches the inbound ID to req.correlationId synchronously', () => {
      // Route handlers reach for `req.correlationId` to log it or pass
      // it as an argument. The attachment MUST be synchronous (i.e.,
      // visible immediately after the middleware returns) so handlers
      // running on the same tick can read it.
      const inbound = 'req-field-test-id';
      const req = buildReq({ 'x-correlation-id': inbound });
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      expect(req.correlationId).toBe(inbound);
    });

    it('attaches the generated UUID to req.correlationId when no header is present', () => {
      const req = buildReq({});
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      expect(req.correlationId).toMatch(UUID_V4_REGEX);
    });

    it('attaches the same value as is stored in the ALS frame', (done) => {
      // The two surfaces (`req.correlationId` and the ALS store) MUST
      // never disagree. Both come from the same `correlationId` local
      // in the middleware; this test pins the invariant in case a
      // future refactor accidentally introduces a divergence.
      const inbound = 'sync-pin-test';
      const req = buildReq({ 'x-correlation-id': inbound });
      const res = buildRes();
      const next = jest.fn(() => {
        const fromStore = correlationStore.getStore()?.correlationId;
        const fromReq = req.correlationId;
        expect(fromStore).toBeDefined();
        expect(fromReq).toBeDefined();
        expect(fromStore).toBe(fromReq);
        done();
      });

      correlationMiddleware(req, res, next);
    });
  });

  // -------------------------------------------------------------------------
  // `next()` invocation invariants
  // -------------------------------------------------------------------------

  describe('next() invocation', () => {
    it('calls next() exactly once with no arguments on the header-present path', () => {
      const req = buildReq({ 'x-correlation-id': 'next-test-1' });
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      // Called exactly once …
      expect(next).toHaveBeenCalledTimes(1);
      // … with no arguments. Express treats `next(err)` as an error
      // hand-off; the correlation middleware must NEVER trigger that
      // path because correlation establishment is non-erroring.
      expect(next).toHaveBeenCalledWith();
    });

    it('calls next() exactly once with no arguments on the UUID-generated path', () => {
      const req = buildReq({});
      const res = buildRes();
      const next = jest.fn();

      correlationMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('does not throw when invoked with empty headers object', () => {
      const req = buildReq({});
      const res = buildRes();
      const next = jest.fn();

      // The middleware must be resilient against the smallest possible
      // request shape — no thrown errors on the absent-header path.
      expect(() => correlationMiddleware(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// `getCorrelationId()` helper
// ---------------------------------------------------------------------------

describe('getCorrelationId()', () => {
  it('returns the current correlation ID when called inside an ALS frame', (done) => {
    const inboundId = 'helper-test-12345';
    const req = buildReq({ 'x-correlation-id': inboundId });
    const res = buildRes();

    const next = jest.fn(() => {
      // Helper is the public, parameter-free way for service-layer code
      // to read the correlation ID without threading it through every
      // function signature.
      expect(getCorrelationId()).toBe(inboundId);
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('returns undefined when called outside any ALS frame', () => {
    // At top level, before any middleware has run — and after any
    // middleware's run() callback has unwound — there is no active
    // frame, so the helper returns undefined. This is the correct
    // behaviour: callers in a no-context environment (background jobs,
    // startup scripts) MUST generate their own UUID rather than
    // assume the helper will produce a default.
    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the matching value across multiple reads in the same frame', (done) => {
    // Two reads in the same ALS frame MUST return the same value —
    // the store is mutable for `uid` only; `correlationId` is set once
    // and never reassigned.
    const req = buildReq({ 'x-correlation-id': 'stable-read' });
    const res = buildRes();

    const next = jest.fn(() => {
      const first = getCorrelationId();
      const second = getCorrelationId();
      expect(first).toBe('stable-read');
      expect(second).toBe('stable-read');
      expect(first).toBe(second);
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('returns the generated UUID when the inbound header was absent', (done) => {
    const req = buildReq({});
    const res = buildRes();

    const next = jest.fn(() => {
      const id = getCorrelationId();
      expect(id).toMatch(UUID_V4_REGEX);
      done();
    });

    correlationMiddleware(req, res, next);
  });
});

// ---------------------------------------------------------------------------
// Outbound HTTP correlation ID propagation
// ---------------------------------------------------------------------------
//
// Strategy notes:
//   The correlation module installs a global monkey-patch on `http.request`
//   and `http.get` at module load time. The patch reads the active ALS
//   frame's correlationId and mutates the outbound options.headers object
//   in-place BEFORE forwarding to the original (native) http.request. The
//   mutated headers then flow into the resulting `ClientRequest` via Node's
//   normal header-setting path.
//
//   Verifying the contract therefore requires the patch to actually run —
//   which means we cannot use `jest.spyOn(http, 'request').mockImplementation()`
//   because that would REPLACE the patched `http.request` (defeating the
//   patch entirely) rather than wrapping it.
//
//   Instead, we suppress the actual TCP connection at a lower level by
//   spying on `http.globalAgent.addRequest` — the Agent method invoked by
//   `ClientRequest` to queue the request for connection. With this method
//   replaced by a no-op, the `ClientRequest` is still constructed, headers
//   are still set on it, but no socket is allocated, no DNS lookup is
//   performed, and no connection attempt is made. The test then reads
//   `clientReq.getHeader('x-correlation-id')` synchronously to verify
//   what the wrapped http.request actually injected.
//
//   This satisfies ST-043-AC4 (no network access beyond local toolchain)
//   without sacrificing the integrity of the test — the wrapper actually
//   runs end-to-end on every assertion.
// ---------------------------------------------------------------------------

describe('outbound HTTP correlation ID propagation', () => {
  beforeEach(() => {
    // Replace the globalAgent's request-queueing method with a no-op so
    // ClientRequests created during the test cause zero network I/O.
    // The Jest config's `restoreMocks: true` automatically reverts the
    // spy in `afterEach` so the patch state is restored cleanly.
    //
    // Note: `addRequest` is an internal Node.js Agent method not present in
    // the public `http.Agent` type definitions. We cast to a permissive
    // shape here so `jest.spyOn` accepts the method name without compile
    // errors, while still exercising the real, runtime-installed method.
    const agentInternals = http.globalAgent as unknown as {
      addRequest: (...args: unknown[]) => void;
    };
    jest.spyOn(agentInternals, 'addRequest').mockImplementation(() => {
      /* no-op: prevents actual TCP connection / DNS lookup */
    });
  });

  /**
   * Helper: create a ClientRequest with safe defaults, attach an error
   * handler so any pending socket/timeout error is suppressed, and queue
   * a destroy() call to release internal resources before the test ends.
   *
   * The hostname/port targets a definitely-unreachable address but no
   * connection is attempted because `addRequest` is mocked — these are
   * defence-in-depth in case Node's behaviour ever diverges from the
   * test's assumptions.
   */
  function makeOutboundRequest(extraHeaders: Record<string, string> = {}): http.ClientRequest {
    const clientReq = http.request({
      hostname: '127.0.0.1',
      port: 1, // privileged; would fail fast even if connect were attempted
      path: '/',
      method: 'GET',
      headers: {
        'user-agent': 'correlation-test',
        ...extraHeaders,
      },
    });

    // Suppress any 'error' event that may fire asynchronously (e.g.
    // ECONNREFUSED, abort) — without this, an unhandled error would
    // crash the entire Jest worker.
    clientReq.on('error', () => {
      /* swallow — no real I/O is expected */
    });

    return clientReq;
  }

  it('attaches x-correlation-id to outbound http.request calls inside an ALS frame', (done) => {
    const inboundId = 'outbound-test-xyz';
    const req = buildReq({ 'x-correlation-id': inboundId });
    const res = buildRes();

    const next = jest.fn(() => {
      const clientReq = makeOutboundRequest();

      // The wrappedRequest (installed at module load) read the active
      // ALS context, mutated options.headers to include
      // `x-correlation-id`, and forwarded to the native http.request.
      // The native constructor then copied the (mutated) headers onto
      // the ClientRequest object — verifiable via getHeader.
      expect(clientReq.getHeader('x-correlation-id')).toBe(inboundId);

      clientReq.destroy();
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('attaches a generated UUID to outbound calls when the inbound header was absent', (done) => {
    // The ALS frame holds a generated UUID; that UUID must propagate
    // outbound just like an inbound-supplied one.
    const req = buildReq({});
    const res = buildRes();

    const next = jest.fn(() => {
      const clientReq = makeOutboundRequest();

      const outboundHeader = clientReq.getHeader('x-correlation-id');
      expect(typeof outboundHeader).toBe('string');
      expect(outboundHeader as string).toMatch(UUID_V4_REGEX);
      // And it equals the value the middleware decided on for this request.
      expect(outboundHeader).toBe(getCorrelationId());

      clientReq.destroy();
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('does NOT overwrite an explicit outbound x-correlation-id (caller intent wins)', (done) => {
    // Downstream code may want to set a custom outbound correlation ID
    // (e.g., a derived ID for a retry, or an upstream-provided ID for a
    // fanout call). The middleware MUST respect this explicit choice
    // and never clobber it with the ambient ALS value.
    const ambientId = 'ambient-abc';
    const explicitOutboundId = 'explicit-xyz';
    const req = buildReq({ 'x-correlation-id': ambientId });
    const res = buildRes();

    const next = jest.fn(() => {
      const clientReq = makeOutboundRequest({
        'x-correlation-id': explicitOutboundId,
      });

      // Explicit caller wins.
      expect(clientReq.getHeader('x-correlation-id')).toBe(explicitOutboundId);
      // And the ambient ALS value is unaffected — verify by reading
      // the ALS store directly.
      expect(getCorrelationId()).toBe(ambientId);

      clientReq.destroy();
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('does NOT overwrite an explicit outbound header even with mixed-case key', (done) => {
    // The detection of an explicit caller-set header is case-insensitive
    // because Node accepts headers in any case. A caller setting
    // `X-Correlation-Id` (TitleCase) is logically the same header as
    // `x-correlation-id` and MUST win against the ambient injection.
    const ambientId = 'ambient-mixed-case';
    const explicitId = 'explicit-mixed-case';
    const req = buildReq({ 'x-correlation-id': ambientId });
    const res = buildRes();

    const next = jest.fn(() => {
      const clientReq = makeOutboundRequest({
        // Note: TitleCase. Node normalises to lowercase internally
        // when storing headers on the ClientRequest, so getHeader
        // returns the value regardless of which case set it.
        'X-Correlation-Id': explicitId,
      });

      const outboundHeader = clientReq.getHeader('x-correlation-id');
      expect(outboundHeader).toBe(explicitId);

      clientReq.destroy();
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('does NOT attach a correlation header when http.request is called outside any ALS frame', (done) => {
    // No active ALS frame ⇒ store.getStore() returns undefined ⇒ the
    // injection branch is skipped. Outbound requests in a non-context
    // (e.g., a startup script, or any code that calls http.request
    // before the middleware mounts) therefore carry no correlation
    // header. This is the correct behaviour: the contract is "ride
    // the inbound request's ID outbound" — without an inbound request,
    // there is nothing to ride.
    const clientReq = makeOutboundRequest();

    const outboundHeader = clientReq.getHeader('x-correlation-id');
    expect(outboundHeader).toBeUndefined();

    clientReq.destroy();
    done();
  });

  it('attaches the correlation header to outbound http.get calls inside an ALS frame', (done) => {
    // `http.get` is patched by the same module (it's a thin convenience
    // wrapper around `http.request` that automatically calls .end()).
    // This test confirms the patch covers it equally — a regression
    // here would silently drop correlation IDs from any outbound
    // GET-style request.
    const inboundId = 'http-get-test-id';
    const req = buildReq({ 'x-correlation-id': inboundId });
    const res = buildRes();

    const next = jest.fn(() => {
      const clientReq = http.get({
        hostname: '127.0.0.1',
        port: 1,
        path: '/',
        headers: { 'user-agent': 'correlation-test' },
      });
      clientReq.on('error', () => {
        /* swallow */
      });

      expect(clientReq.getHeader('x-correlation-id')).toBe(inboundId);

      clientReq.destroy();
      done();
    });

    correlationMiddleware(req, res, next);
  });

  it('attaches the correlation header through async continuations inside next()', (done) => {
    // The most realistic scenario: a route handler does some async
    // work, then makes an outbound API call. ALS must persist across
    // the async boundary so the outbound call carries the correct ID.
    const inboundId = 'async-outbound-test';
    const req = buildReq({ 'x-correlation-id': inboundId });
    const res = buildRes();

    const next = jest.fn(() => {
      // Defer the outbound call to a setTimeout to simulate an awaited
      // operation completing before the API call.
      setTimeout(() => {
        const clientReq = makeOutboundRequest();
        try {
          expect(clientReq.getHeader('x-correlation-id')).toBe(inboundId);
        } finally {
          clientReq.destroy();
        }
        done();
      }, 5);
    });

    correlationMiddleware(req, res, next);
  });
});

// ---------------------------------------------------------------------------
// Outbound fetch correlation propagation — Issue #1 (QA Final F)
// ---------------------------------------------------------------------------
//
// Why a separate top-level describe:
//   The http/https patches operate on `node:http`'s `request` / `get`
//   functions and are exercised by the block above. The fetch patch
//   operates on `globalThis.fetch` (Node 20 LTS's undici-backed WHATWG
//   fetch), which is a SEPARATE transport surface that does NOT route
//   through `node:http`. Without dedicated tests, an OTel-undici
//   instrumentation upgrade or a Node major-version bump that changed
//   undici internals could silently regress the C5 contract for
//   fetch-based outbound calls — exactly the failure mode QA Final F
//   Issue #1 documented. These tests close that gap and become the
//   regression baseline.
//
// Strategy:
//   - Pure-function tests on `_injectCorrelationHeaderIntoFetchInit`
//     verify every input shape the WHATWG fetch standard accepts:
//       fetch(string)
//       fetch(string, init)
//       fetch(URL)
//       fetch(URL, init)
//       fetch(Request)
//       fetch(Request, init)
//     plus the three `init.headers` shapes (undefined, plain object,
//     array of tuples, Headers instance) and the case-insensitive
//     skip-on-explicit-caller-header rule.
//
//   - End-to-end tests on the wrapped `globalThis.fetch` install a
//     mock fetch via `jest.spyOn(global, 'fetch').mockImplementation(...)`.
//     With the spy in place, the wrapper still runs (it was installed
//     at module load time), invokes the spy, and the spy's call args
//     are inspected for the `x-correlation-id` header. This is the
//     analogue of the http test pattern that spies on
//     `http.globalAgent.addRequest` and reads `clientReq.getHeader(...)`.
//   - No real network I/O occurs — the spy short-circuits the call.

describe('outbound fetch correlation ID propagation (Issue #1, C5)', () => {
  // -------------------------------------------------------------------------
  // Pure-function unit tests — _injectCorrelationHeaderIntoFetchInit
  // -------------------------------------------------------------------------

  describe('_injectCorrelationHeaderIntoFetchInit (pure function)', () => {
    const corrId = 'unit-test-corr-id';

    it('synthesises an init with the correlation header when none is supplied (string input)', () => {
      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/path',
        undefined,
        corrId,
      ) as { headers: Record<string, string> };

      expect(result).toBeDefined();
      expect(result.headers).toBeDefined();
      expect(result.headers['x-correlation-id']).toBe(corrId);
    });

    it('synthesises an init with the correlation header when none is supplied (URL input)', () => {
      const url = new URL('https://example.test/path');
      const result = _injectCorrelationHeaderIntoFetchInit(url, undefined, corrId) as {
        headers: Record<string, string>;
      };

      expect(result.headers['x-correlation-id']).toBe(corrId);
    });

    it('extends a plain-object headers map with the correlation header', () => {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' } };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as typeof init & { headers: Record<string, string> };

      // Original headers preserved.
      expect(result.headers['content-type']).toBe('application/json');
      // New header attached.
      expect(result.headers['x-correlation-id']).toBe(corrId);
    });

    it('extends an array-of-tuples headers value with the correlation header', () => {
      const init = {
        method: 'POST',
        headers: [['content-type', 'application/json']] as [string, string][],
      };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: [string, string][] };

      expect(result.headers).toEqual(
        expect.arrayContaining([['x-correlation-id', corrId]]),
      );
      // Pre-existing entry preserved.
      expect(result.headers).toEqual(
        expect.arrayContaining([['content-type', 'application/json']]),
      );
    });

    it('extends a Headers instance with the correlation header', () => {
      // The `Headers` global is part of WHATWG fetch and is available in
      // Node 20 LTS without an import.
      const headers = new Headers({ 'content-type': 'application/json' });
      const init = { method: 'POST', headers };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: Headers };

      expect(result.headers.get('x-correlation-id')).toBe(corrId);
      // Pre-existing entry preserved.
      expect(result.headers.get('content-type')).toBe('application/json');
    });

    it('does NOT overwrite a caller-supplied x-correlation-id (lowercase)', () => {
      const explicitId = 'caller-explicit-id';
      const init = { headers: { 'x-correlation-id': explicitId } };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: Record<string, string> };

      expect(result.headers['x-correlation-id']).toBe(explicitId);
    });

    it('does NOT overwrite a caller-supplied x-correlation-id (TitleCase)', () => {
      // Caller supplied the same logical header in mixed case. The
      // detection MUST be case-insensitive — Node and undici accept
      // either case on the wire.
      const explicitId = 'caller-explicit-mixed-case';
      const init = { headers: { 'X-Correlation-Id': explicitId } };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: Record<string, string> };

      // The original key is preserved (no duplicate added under
      // lowercase) and its value is unchanged.
      expect(result.headers['X-Correlation-Id']).toBe(explicitId);
      // The wrapper MUST NOT add a second entry under a different case.
      const occurrences = Object.keys(result.headers).filter(
        (k) => k.toLowerCase() === 'x-correlation-id',
      );
      expect(occurrences.length).toBe(1);
    });

    it('does NOT overwrite a caller-supplied header in a Headers instance', () => {
      const explicitId = 'headers-instance-explicit';
      const headers = new Headers({ 'X-Correlation-Id': explicitId });
      const init = { headers };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: Headers };

      // Headers' get() is case-insensitive per WHATWG fetch.
      expect(result.headers.get('x-correlation-id')).toBe(explicitId);
    });

    it('does NOT overwrite a caller-supplied header in an array-of-tuples', () => {
      const explicitId = 'array-explicit';
      const init = {
        headers: [['x-correlation-id', explicitId]] as [string, string][],
      };

      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        init,
        corrId,
      ) as { headers: [string, string][] };

      const corrEntries = result.headers.filter((e) => e[0].toLowerCase() === 'x-correlation-id');
      expect(corrEntries.length).toBe(1);
      expect(corrEntries[0]?.[1]).toBe(explicitId);
    });

    it('does NOT overwrite a caller-supplied header on a Request input', () => {
      // When the input is already a Request with x-correlation-id set,
      // the wrapper MUST NOT add an override that the underlying fetch
      // would merge over the Request's own headers.
      const explicitId = 'request-input-explicit';
      const request = new Request('https://example.test/x', {
        headers: { 'X-Correlation-Id': explicitId },
      });

      const result = _injectCorrelationHeaderIntoFetchInit(request, undefined, corrId);

      // The wrapper passes through init unchanged when the Request
      // already carries the header.
      expect(result).toBeUndefined();
    });

    it('attaches the correlation header when a Request input has no x-correlation-id', () => {
      const request = new Request('https://example.test/x', {
        headers: { 'content-type': 'application/json' },
      });

      const result = _injectCorrelationHeaderIntoFetchInit(request, undefined, corrId) as {
        headers: Record<string, string>;
      };

      expect(result).toBeDefined();
      expect(result.headers['x-correlation-id']).toBe(corrId);
    });

    it('passes through unchanged when init is a non-object value', () => {
      // Defensive — the fetch standard would reject a string init with
      // TypeError. Our wrapper must NOT throw.
      const result = _injectCorrelationHeaderIntoFetchInit(
        'https://example.test/x',
        'not-an-object',
        corrId,
      );
      expect(result).toBe('not-an-object');
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end wrapper tests on globalThis.fetch — using a real local
  // HTTP server as the destination so the wrapper's full call chain
  // (including its closure-captured `originalFetch` delegate) is
  // exercised on every assertion.
  // -------------------------------------------------------------------------
  //
  // Why a real local HTTP server (not a spy on globalThis.fetch):
  //   The wrapper's code captures a reference to the underlying fetch
  //   implementation at module load time and delegates to that captured
  //   reference. Spying on `globalThis.fetch` AFTER the wrapper was
  //   installed REPLACES the wrapper itself — the wrapper's injection
  //   logic is bypassed, defeating the test's purpose.
  //
  //   A local HTTP server bound to 127.0.0.1 on an ephemeral port
  //   (loopback-only, port 0 lets the kernel pick a free port) keeps
  //   the test deterministic and fully local (ST-043-AC4: "no network
  //   access beyond the standard local toolchain"), while still
  //   exercising the FULL fetch wrapper → undici → loopback TCP →
  //   server path. The server's request handler reads the inbound
  //   `x-correlation-id` header, allowing direct assertions on what
  //   the wrapper actually injected.

  describe('wrapped globalThis.fetch — end-to-end injection through a local server', () => {
    let server: http.Server;
    let serverUrl: string;
    let lastReceivedHeaders: http.IncomingHttpHeaders = {};

    beforeAll((done) => {
      server = http.createServer((req, res) => {
        // Capture the inbound headers for the assertion AND respond
        // immediately with 204 so the fetch resolves cleanly.
        lastReceivedHeaders = req.headers;
        res.statusCode = 204;
        res.end();
      });
      // `0` lets the kernel assign an ephemeral free port, eliminating
      // any chance of port-conflict flakiness across parallel test runs.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr !== null) {
          serverUrl = `http://127.0.0.1:${addr.port}`;
        }
        done();
      });
    });

    afterAll((done) => {
      server.close(() => done());
    });

    beforeEach(() => {
      lastReceivedHeaders = {};
    });

    it('injects x-correlation-id on outbound fetch when called inside an ALS frame', async () => {
      const inboundId = 'fetch-e2e-test-id';
      const req = buildReq({ 'x-correlation-id': inboundId });
      const res = buildRes();

      await new Promise<void>((resolve, reject) => {
        const next = jest.fn(() => {
          // Inside the ALS frame established by correlationMiddleware:
          // call the global fetch. The wrapper installed at module load
          // is what handles this call — it reads the ALS context, mutates
          // init.headers, and forwards to undici.
          fetch(`${serverUrl}/test`, { method: 'GET' })
            .then(async (r) => {
              // Drain the body so the connection isn't held open.
              await r.arrayBuffer();
              expect(lastReceivedHeaders['x-correlation-id']).toBe(inboundId);
              resolve();
            })
            .catch(reject);
        });

        correlationMiddleware(req, res, next);
      });
    });

    it('attaches a generated UUID v4 to outbound fetch when no inbound header was supplied', async () => {
      // Same flow as the http tests: the middleware generates a UUID
      // when no inbound header is present; that UUID must propagate to
      // outbound fetch calls just like an explicit inbound ID.
      const req = buildReq({});
      const res = buildRes();

      let observedId: string | undefined;

      await new Promise<void>((resolve, reject) => {
        const next = jest.fn(() => {
          observedId = getCorrelationId();
          fetch(`${serverUrl}/test2`, { method: 'GET' })
            .then(async (r) => {
              await r.arrayBuffer();
              expect(lastReceivedHeaders['x-correlation-id']).toBe(observedId);
              expect(observedId).toMatch(UUID_V4_REGEX);
              resolve();
            })
            .catch(reject);
        });

        correlationMiddleware(req, res, next);
      });
    });

    it('does NOT overwrite an explicit caller-supplied x-correlation-id (caller intent wins)', async () => {
      // The wrapper's contract mirrors the http patch: when the caller
      // supplies an explicit x-correlation-id, the ambient ALS value
      // does NOT override it. This is the equivalent of the http test
      // 'does NOT overwrite an explicit outbound x-correlation-id'.
      const ambientId = 'fetch-ambient-id';
      const explicitId = 'fetch-explicit-caller-id';
      const req = buildReq({ 'x-correlation-id': ambientId });
      const res = buildRes();

      await new Promise<void>((resolve, reject) => {
        const next = jest.fn(() => {
          fetch(`${serverUrl}/test3`, {
            method: 'GET',
            headers: { 'x-correlation-id': explicitId },
          })
            .then(async (r) => {
              await r.arrayBuffer();
              // Explicit caller wins.
              expect(lastReceivedHeaders['x-correlation-id']).toBe(explicitId);
              // Ambient ALS unaffected.
              expect(getCorrelationId()).toBe(ambientId);
              resolve();
            })
            .catch(reject);
        });

        correlationMiddleware(req, res, next);
      });
    });

    it('does NOT overwrite an explicit caller-supplied header even with mixed-case key', async () => {
      // Detection of an explicit header is case-insensitive — undici
      // and the WHATWG Headers class normalise to lowercase, but the
      // wrapper must check before normalisation occurs.
      const ambientId = 'fetch-ambient-mixed';
      const explicitId = 'fetch-explicit-mixed';
      const req = buildReq({ 'x-correlation-id': ambientId });
      const res = buildRes();

      await new Promise<void>((resolve, reject) => {
        const next = jest.fn(() => {
          fetch(`${serverUrl}/test4`, {
            method: 'GET',
            headers: { 'X-Correlation-Id': explicitId },
          })
            .then(async (r) => {
              await r.arrayBuffer();
              // Inbound headers on the server are normalised to lowercase
              // by Node's http parser — but the value is preserved.
              expect(lastReceivedHeaders['x-correlation-id']).toBe(explicitId);
              resolve();
            })
            .catch(reject);
        });

        correlationMiddleware(req, res, next);
      });
    });

    it('does NOT attach a correlation header when fetch is called outside any ALS frame', async () => {
      // No active ALS frame ⇒ store.getStore() returns undefined ⇒ the
      // injection branch is skipped. Outbound fetches in a non-context
      // (e.g., a startup script, a background timer) therefore carry
      // no correlation header — same behaviour as the http test
      // 'does NOT attach a correlation header when http.request is
      // called outside any ALS frame'.
      const r = await fetch(`${serverUrl}/test5`, { method: 'GET' });
      await r.arrayBuffer();
      expect(lastReceivedHeaders['x-correlation-id']).toBeUndefined();
    });

    it('attaches the correlation header through async continuations inside next()', async () => {
      // Most realistic scenario: a route handler does some async work
      // (e.g., await pgClient.query()), then makes an outbound fetch
      // call. ALS must persist across the async boundary so the fetch
      // carries the correct correlation ID. This is the analogue of
      // the http test 'attaches the correlation header through async
      // continuations inside next()'.
      const inboundId = 'fetch-async-continuation';
      const req = buildReq({ 'x-correlation-id': inboundId });
      const res = buildRes();

      await new Promise<void>((resolve, reject) => {
        const next = jest.fn(() => {
          // Defer the outbound fetch to a setTimeoutPromise to simulate
          // an awaited operation completing before the API call.
          setTimeoutPromise(5)
            .then(() => fetch(`${serverUrl}/test6`, { method: 'GET' }))
            .then(async (r) => {
              await r.arrayBuffer();
              expect(lastReceivedHeaders['x-correlation-id']).toBe(inboundId);
              resolve();
            })
            .catch(reject);
        });

        correlationMiddleware(req, res, next);
      });
    });

    it('preserves the sentinel symbol so the fetch patch is idempotent across module reloads', () => {
      // The fetch sentinel is `Symbol.for('__blitzy_correlation_fetch_patched__')`,
      // anchored on the http core module (same anchor as
      // CORRELATION_STORE_SENTINEL — see correlation.ts module
      // documentation for the per-Jest-VM-context vs process-singleton
      // discussion). Verifying the sentinel exists confirms the
      // installation block ran exactly once.
      const FETCH_PATCHED_SENTINEL = Symbol.for('__blitzy_correlation_fetch_patched__');
      const httpAsRecord = http as unknown as Record<symbol, unknown>;

      expect(httpAsRecord[FETCH_PATCHED_SENTINEL]).toBe(true);
    });

    it('preserves function metadata: globalThis.fetch.name === "fetch" after wrapping', () => {
      // The wrapper uses Object.defineProperty(wrappedFetch, 'name',
      // { value: 'fetch' }) so debugger / profiler tooling still shows
      // the public function name `fetch` rather than the inner wrapper
      // name. This is the analogue of the http patch's similar
      // metadata preservation for `request` and `get`.
      const wrappedName = (globalThis.fetch as unknown as { name: string }).name;
      expect(wrappedName).toBe('fetch');
    });
  });
});


