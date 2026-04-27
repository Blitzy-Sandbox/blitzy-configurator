/**
 * backend/src/logging/pino.test.ts
 *
 * Unit tests for the pino logger configured by `./pino.ts`.
 *
 * ============================================================================
 * Authority (verbatim from Agent Action Plan and story specifications)
 * ============================================================================
 *
 *   - AAP §0.3.3 / §0.7.1 "Exhaustively In Scope":
 *       co-located *.test.ts files anywhere under `backend/src` (per ST-043)
 *
 *   - ST-047-AC4 (verbatim):
 *       "No emitted log record … contains passwords, bearer tokens, session
 *       identifiers, API keys, or personally identifiable information beyond
 *       the authenticated user identifier; this exclusion is enforced by a
 *       documented serializer or allow-list mechanism so that sensitive-data
 *       redaction is a verifiable property of the logging contract rather
 *       than an ad-hoc per-call discipline."
 *
 *   - AAP §0.8.1 Rule R2 (verbatim, User Example):
 *       send a login request with `"password":"SENTINEL_CRED_99"` and verify
 *       `grep "SENTINEL_CRED_99" <(docker compose logs backend)` returns 0
 *       lines.
 *
 *   - AAP §0.2.2 C5 (verbatim):
 *       "Log records MUST contain only `correlationId` and `uid` as identity
 *       fields — passwords, bearer tokens, session tokens, and API keys MUST
 *       NEVER appear in any log record, enforced by a pino serializer
 *       allow-list (Rule R2) rather than ad-hoc per-call discipline."
 *
 *   - ST-049-AC2 (verbatim):
 *       "Trace records include at minimum the trace identifier, parent span
 *       identifier, span identifier, operation name, start and end timestamps,
 *       and the correlation identifier from the structured logging contract
 *       so traces and logs can be joined."
 *
 *   - ST-043-AC3 (verbatim):
 *       "A failing assertion, a test exception, or a coverage percentage
 *       below the documented threshold produces a failed verdict; the suite
 *       is deterministic, so repeated runs against the same source tree
 *       produce the same verdict."
 *
 *   - ST-043-AC4 (verbatim):
 *       "The suite runs in the local development environment without any
 *       additional services or network access beyond the standard local
 *       toolchain."
 *
 * ============================================================================
 * Contracts verified
 * ============================================================================
 *
 *   Rule R2     — No credential material in log records (serializer allow-list).
 *   C5          — correlationId + uid attached from AsyncLocalStorage; no other
 *                 identity field can leak into log records.
 *   ST-047-AC1  — Required fields: timestamp, severity (string label), event
 *                 name, service identifier, correlation identifier (when in a
 *                 request flow).
 *   ST-047-AC4  — Sensitive-data redaction is a documented serializer/allow-list
 *                 property of the logging contract.
 *   ST-049-AC2  — traceId + spanId attached when an OTel span is active so
 *                 logs and traces can be joined; absent otherwise (no-op
 *                 all-zeros span context is rejected).
 *
 * ============================================================================
 * Test strategy
 * ============================================================================
 *
 *   - Mock `@opentelemetry/api` and `../middleware/correlation` so each test
 *     can control what the pino mixin observes via deterministic stubs. The
 *     mock for `isSpanContextValid` mirrors the real OTel implementation
 *     (rejects all-zeros traceIds and spanIds) so tests validating the
 *     no-op span context path verify production-equivalent behaviour.
 *
 *   - Build a capturing pino logger using the EXACT exported `pinoOptions`
 *     from production with one override: `level: 'trace'`. The override
 *     ensures every emitted record (including `debug`) is captured
 *     regardless of the ambient `LOG_LEVEL`. Sharing `pinoOptions` literally
 *     between production and tests eliminates the drift surface that would
 *     otherwise leave Rule R2 verification gaps.
 *
 *   - Write to an in-memory `Writable` stream so:
 *       (a) tests never touch process.stdout (ST-043-AC4 — no I/O beyond the
 *           local toolchain);
 *       (b) every emitted line can be parsed as JSON for field-level
 *           assertions;
 *       (c) the raw concatenated bytes can be checked for forbidden
 *           substrings (defense-in-depth against a future serialization
 *           change that bypasses the JSON-record parsing layer).
 *
 *   - Determinism (ST-043-AC3): The Jest config sets `clearMocks`,
 *     `resetMocks`, `restoreMocks` to `true`, automatically reverting every
 *     mock between tests. Each test installs its own `mockReturnValue`
 *     for the mocks it relies on; the `beforeEach` block calls `mockReset`
 *     explicitly for clarity even though the Jest config also does this.
 *
 * @see backend/src/logging/pino.ts          — module under test
 * @see backend/src/middleware/correlation.ts — mocked dependency
 * @see backend/jest.config.unit.ts          — Jest runner configuration
 */

import { Writable } from 'node:stream';

import pino from 'pino';

// ---------------------------------------------------------------------------
// Hoisted mocks — installed BEFORE the module under test loads
// ---------------------------------------------------------------------------
//
// Jest's transformer hoists `jest.mock` calls above all imports, so these
// factories run before the `import` statements below resolve. Each factory
// creates its `jest.fn()` instances inline (jest is a global available at
// factory-evaluation time), and the test code below grabs typed handles to
// those instances via `as jest.MockedFunction<...>` casts after the imports.
//
// IMPORTANT: A factory must NOT close over outer-scope variables that are
// declared after the `jest.mock` call. Doing so triggers the well-known
// "Cannot access X before initialization" hoist error. Both factories below
// are self-contained — they only reference `jest` (a global) and string/
// number literals.

jest.mock('@opentelemetry/api', () => {
  // Mirror the real OpenTelemetry library's `isSpanContextValid` so unit
  // tests reject the no-op "all zeros" span context exactly as production
  // does. The OTel spec defines:
  //   INVALID_TRACE_ID  = '0' × 32  (32-hex-char traceId of all zeros)
  //   INVALID_SPAN_ID   = '0' × 16  (16-hex-char spanId of all zeros)
  // and `isSpanContextValid()` returns false when either matches.
  //
  // Tests that pass with this mock therefore also pass against the real
  // library, which is a stronger guarantee than a trivial stub that
  // unconditionally returns `true`.
  const INVALID_TRACE_ID = '0'.repeat(32);
  const INVALID_SPAN_ID = '0'.repeat(16);
  return {
    __esModule: true,
    trace: {
      getActiveSpan: jest.fn(),
    },
    isSpanContextValid: (ctx: unknown): boolean => {
      if (typeof ctx !== 'object' || ctx === null) {
        return false;
      }
      const c = ctx as { traceId?: unknown; spanId?: unknown };
      return (
        typeof c.traceId === 'string' &&
        c.traceId.length === 32 &&
        c.traceId !== INVALID_TRACE_ID &&
        typeof c.spanId === 'string' &&
        c.spanId.length === 16 &&
        c.spanId !== INVALID_SPAN_ID
      );
    },
  };
});

jest.mock('../middleware/correlation', () => ({
  __esModule: true,
  correlationStore: {
    // The ONLY method the pino mixin actually invokes. Tests control its
    // return value per-test via `mockGetStore.mockReturnValue(...)`.
    getStore: jest.fn(),
    // Minimal AsyncLocalStorage surface sufficient to keep TypeScript types
    // happy if any consumer were to call these. The pino module does not
    // call them, so they are never exercised by the suite below.
    run: <R>(_store: unknown, fn: () => R): R => fn(),
    enterWith: jest.fn(),
    exit: <R>(fn: () => R): R => fn(),
    disable: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports of the mocked modules and the module under test
// ---------------------------------------------------------------------------
//
// These imports MUST come AFTER the `jest.mock` calls above. Jest's
// Babel/SWC transformer hoists `jest.mock` over imports automatically, but
// keeping the imports physically below the mocks documents the intended
// load order for human readers and survives any future refactor that
// disables hoisting.

import { trace } from '@opentelemetry/api';

import { correlationStore } from '../middleware/correlation';

import { allowListHeaders, pinoOptions } from './pino';

// ---------------------------------------------------------------------------
// Typed handles to the mock functions
// ---------------------------------------------------------------------------
//
// At runtime, `trace.getActiveSpan` and `correlationStore.getStore` are the
// `jest.fn()` instances created inside the mock factories. TypeScript still
// sees them as the original `() => Span | undefined` and
// `() => CorrelationContext | undefined` signatures (because the imports
// resolve to the real `.d.ts` declarations). Casting through
// `jest.MockedFunction<typeof X>` recovers the mock's `mockReturnValue`,
// `mockReset`, `mockClear`, and other Jest-specific methods while
// preserving the exact call signature.

const mockGetActiveSpan = trace.getActiveSpan as jest.MockedFunction<typeof trace.getActiveSpan>;

const mockGetStore = correlationStore.getStore as jest.MockedFunction<
  typeof correlationStore.getStore
>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Loose record type for parsed JSON log lines. */
type LogRecord = Record<string, unknown>;

/**
 * Build a fresh pino logger that uses the EXACT same `pinoOptions` exported
 * from production but writes to an in-memory `Writable` stream.
 *
 * Each chunk written to the stream is appended to the `chunks` buffer (so
 * raw bytes can be inspected for forbidden substrings — defense-in-depth
 * for Rule R2 sentinel checks) AND each non-empty line is parsed as JSON
 * and pushed onto `records` (so individual fields can be asserted).
 *
 * The `level: 'trace'` override ensures EVERY call (including `debug`) is
 * captured regardless of the ambient `LOG_LEVEL` resolution that pino uses
 * in non-test runtimes. The override is the only deviation from production
 * options — redaction, mixin, serializers, formatters, base, and timestamp
 * are all preserved.
 *
 * Pino writes to a custom `Writable` synchronously (the `write` callback's
 * `cb()` is invoked inline), so the buffer is up-to-date immediately after
 * `logger.info(...)` returns — no `await` or `flush()` is required.
 */
function makeCapturingLogger(): {
  logger: pino.Logger;
  records: LogRecord[];
  rawOutput: () => string;
} {
  const records: LogRecord[] = [];
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(chunk);
      const text = chunk.toString('utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // Pino MAY emit non-JSON content during fatal flushes or
          // serialization errors. Defensively ignore unparseable lines —
          // tests assert on `records` for parsed-field checks and on
          // `rawOutput()` for substring-forbidden checks, so a malformed
          // line does not lose coverage.
        }
      }
      cb();
    },
  });
  // Spread the production options so every redact path, mixin, serializer,
  // formatter, base field, and timestamp function is identical to what runs
  // in production. Override `level` only.
  const logger = pino({ ...pinoOptions, level: 'trace' }, stream);
  return {
    logger,
    records,
    rawOutput: (): string => Buffer.concat(chunks).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backend/src/logging/pino.ts', () => {
  beforeEach(() => {
    // Explicit reset for clarity — `clearMocks`, `resetMocks`, and
    // `restoreMocks` in jest.config.unit.ts already auto-reset between
    // tests, but stating the reset here documents the intent and survives
    // any future config change.
    mockGetActiveSpan.mockReset();
    mockGetStore.mockReset();
  });

  // -----------------------------------------------------------------------
  //  Rule R2 — credential material MUST NOT appear in log output
  // -----------------------------------------------------------------------
  //
  // The first test mirrors the User Example in AAP §0.8.1 Rule R2 verbatim:
  // a payload with `password: 'SENTINEL_CRED_99'` MUST not produce any
  // output containing the sentinel substring. This is the strongest
  // possible Rule R2 assertion — if it fails, redaction is broken at the
  // foundational layer regardless of what other tests pass.

  describe('Rule R2: redact.paths removes credentials', () => {
    it('redacts a top-level password field (SENTINEL_CRED_99 User Example)', () => {
      const { logger, records, rawOutput } = makeCapturingLogger();

      logger.info({ event: 'auth.login', password: 'SENTINEL_CRED_99' }, 'login attempt');

      // The sentinel substring MUST NEVER appear anywhere in the
      // serialized output — neither as a value nor accidentally embedded
      // inside another field. This is the bytes-level Rule R2 guarantee.
      expect(rawOutput()).not.toContain('SENTINEL_CRED_99');
      expect(records).toHaveLength(1);
      expect(records[0]?.password).toBe('[REDACTED]');
    });

    it('redacts a nested password field (one level deep)', () => {
      // The pino redact paths include `*.password` to cover one level of
      // nesting (e.g. `user.password`, `body.password`). This test
      // exercises that wildcard against `{ user: { password: ... } }`.
      const { logger, records, rawOutput } = makeCapturingLogger();

      logger.info(
        { event: 'auth.register', user: { password: 'SENTINEL_CRED_99' } },
        'register attempt',
      );

      expect(rawOutput()).not.toContain('SENTINEL_CRED_99');
      const user = records[0]?.user as LogRecord | undefined;
      expect(user?.password).toBe('[REDACTED]');
    });

    // Parameterized coverage of every named credential field in REDACT_PATHS.
    // Adding a new redact-path entry to pino.ts MUST be paired with a new
    // row here to keep regression coverage tight.
    it.each([
      ['token', 'bearer-abc-123'],
      ['sessionToken', 'sess-aaa-bbb'],
      ['idToken', 'firebase.id.token.eyJxxx'],
      ['accessToken', 'acc-xyz-123'],
      ['refreshToken', 'ref-xyz-456'],
      ['firebaseToken', 'fb-token-789'],
      ['apiKey', 'sk_live_ABCDEF'],
      ['api_key', 'sk_live_ABCDEF'],
      ['credential', 'cred-material-xyz'],
      ['credentialDigest', 'digest-material-xyz'],
      ['secret', 'secret-value-xyz'],
      ['bearer', 'bearer-token-xyz'],
      ['passwordHash', 'hash-material-xyz'],
    ])('redacts the %s field value', (field, value) => {
      const { logger, records, rawOutput } = makeCapturingLogger();

      logger.info({ event: 'x', [field]: value }, 'msg');

      // Bytes-level — the raw value MUST NOT appear anywhere in serialized
      // output, even if pino were to embed it in a different field.
      expect(rawOutput()).not.toContain(value);
      // Field-level — the named field MUST be replaced with the censor
      // string, preserving operational evidence that a redaction occurred.
      expect(records[0]?.[field]).toBe('[REDACTED]');
    });

    it('redacts the lowercase authorization field', () => {
      const { logger, rawOutput } = makeCapturingLogger();

      logger.info({ event: 'x', authorization: 'Bearer eyJxxxxxxxx' }, 'msg');

      expect(rawOutput()).not.toContain('Bearer eyJxxxxxxxx');
    });

    it('redacts the TitleCase Authorization field', () => {
      // Both lowercase `authorization` and TitleCase `Authorization` are
      // included in REDACT_PATHS because Node's `http` module sometimes
      // preserves the original casing when caller code reads
      // `res.getHeaders()` and forwards it to the logger directly.
      const { logger, rawOutput } = makeCapturingLogger();

      logger.info({ event: 'x', Authorization: 'Bearer eyJxxxxxxxx' }, 'msg');

      expect(rawOutput()).not.toContain('Bearer eyJxxxxxxxx');
    });

    it('redacts cookie fields at top level (lowercase and TitleCase)', () => {
      // Cookie headers carry session identifiers (`session=...`) and CSRF
      // tokens (`csrf=...`); both must be redacted regardless of casing.
      const { logger, rawOutput } = makeCapturingLogger();

      logger.info(
        { event: 'x', cookie: 'session=xyz; csrf=abc', Cookie: 'session=xyz' },
        'msg',
      );

      expect(rawOutput()).not.toContain('session=xyz');
      expect(rawOutput()).not.toContain('csrf=abc');
    });
  });

  // -----------------------------------------------------------------------
  //  `req` serializer: request header allow-list (PRIMARY defense)
  // -----------------------------------------------------------------------
  //
  // The `req` serializer is the PRIMARY defense against header leakage —
  // it is a TOTAL filter that drops every header NOT on the allow-list
  // regardless of whether the header name happens to be on the
  // `redact.paths` list. This defends against vendor-specific credential
  // headers (e.g. `x-firebase-auth`, `x-vendor-secret`) that may not have
  // been anticipated in the redact paths.

  describe('req serializer: header allow-list', () => {
    it('keeps allow-listed headers verbatim', () => {
      const { logger, records } = makeCapturingLogger();

      logger.info(
        {
          req: {
            method: 'GET',
            url: '/api/designs',
            headers: {
              'content-type': 'application/json',
              'content-length': '42',
              'user-agent': 'jest-test',
              'x-correlation-id': 'corr-abc-123',
              traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
            },
          },
        },
        'allowed req',
      );

      const req = records[0]?.req as
        | { method?: string; url?: string; headers?: Record<string, string> }
        | undefined;
      expect(req?.method).toBe('GET');
      expect(req?.url).toBe('/api/designs');
      expect(req?.headers).toEqual({
        'content-type': 'application/json',
        'content-length': '42',
        'user-agent': 'jest-test',
        'x-correlation-id': 'corr-abc-123',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      });
    });

    it('drops non-allow-listed request headers entirely', () => {
      const { logger, records, rawOutput } = makeCapturingLogger();

      logger.info(
        {
          req: {
            method: 'POST',
            url: '/api/auth/login',
            headers: {
              authorization: 'Bearer eyJxxxxxxxx',
              cookie: 'session=xyz; csrf=abc',
              'x-api-key': 'sk_live_SECRET_XYZ',
              'x-vendor-secret': 'top-secret-123',
              'x-internal-debug': 'internal-only',
            },
          },
        },
        'sensitive req',
      );

      const req = records[0]?.req as { headers?: Record<string, unknown> } | undefined;
      expect(req?.headers).toBeDefined();
      expect(req?.headers?.['authorization']).toBeUndefined();
      expect(req?.headers?.['cookie']).toBeUndefined();
      expect(req?.headers?.['x-api-key']).toBeUndefined();
      expect(req?.headers?.['x-vendor-secret']).toBeUndefined();
      expect(req?.headers?.['x-internal-debug']).toBeUndefined();

      // Defense in depth — the raw serialized output must not contain
      // any of these sensitive values anywhere (not even nested
      // elsewhere through some unexpected serialization path).
      const raw = rawOutput();
      expect(raw).not.toContain('Bearer eyJxxxxxxxx');
      expect(raw).not.toContain('session=xyz');
      expect(raw).not.toContain('sk_live_SECRET_XYZ');
      expect(raw).not.toContain('top-secret-123');
      expect(raw).not.toContain('internal-only');
    });

    it('keeps the standard allow-listed headers and drops vendor headers in a mixed payload', () => {
      // A realistic request from `pino-http`: `Content-Type` set by the
      // client, `User-Agent` set by curl, `Authorization` set by the
      // browser, `X-Correlation-Id` set by the upstream. The serializer
      // must keep the first three and drop the Authorization field.
      const { logger, records } = makeCapturingLogger();

      logger.info(
        {
          req: {
            method: 'POST',
            url: '/api/orders',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'curl/8.4.0',
              authorization: 'Bearer should-disappear',
              'x-correlation-id': 'mixed-case-id',
              'x-vendor-secret': 'should-disappear-too',
            },
          },
        },
        'mixed req',
      );

      const req = records[0]?.req as { headers?: Record<string, unknown> } | undefined;
      expect(req?.headers).toEqual({
        'content-type': 'application/json',
        'user-agent': 'curl/8.4.0',
        'x-correlation-id': 'mixed-case-id',
      });
    });
  });

  // -----------------------------------------------------------------------
  //  allowListHeaders() helper — direct unit tests
  // -----------------------------------------------------------------------
  //
  // The helper is exported specifically to enable focused unit tests that
  // give cleaner failure messages when the allow-list is tampered with than
  // assertions made through the full pino pipeline. Once the production
  // `req` serializer is in place, the serializer itself is exercised via
  // `logger.info({ req: ... })` (above), but direct unit tests of the
  // helper provide the fastest feedback loop for allow-list regressions.

  describe('allowListHeaders helper', () => {
    it('returns empty object when given undefined', () => {
      // `pino-http` may serialize a request whose `headers` member is
      // missing (Node's `IncomingMessage` always populates `.headers`,
      // but the serializer must defend against unexpected shapes).
      expect(allowListHeaders(undefined)).toEqual({});
    });

    it('returns empty object when given empty headers', () => {
      expect(allowListHeaders({})).toEqual({});
    });

    it('keeps allow-listed lowercase headers', () => {
      expect(
        allowListHeaders({
          'content-type': 'application/json',
          'user-agent': 'jest',
        }),
      ).toEqual({
        'content-type': 'application/json',
        'user-agent': 'jest',
      });
    });

    it('keeps allow-listed TitleCase headers (case-insensitive match)', () => {
      // HTTP headers are case-insensitive per RFC 7230 §3.2; the allow-list
      // matcher MUST honour that, even though Express normalises inbound
      // headers to lowercase. This protects against direct calls from
      // non-Express code paths that may preserve original casing.
      expect(
        allowListHeaders({
          'Content-Type': 'application/json',
          'User-Agent': 'jest',
          'X-Correlation-ID': 'corr-123',
          Traceparent: '00-abc-def-01',
        }),
      ).toEqual({
        'Content-Type': 'application/json',
        'User-Agent': 'jest',
        'X-Correlation-ID': 'corr-123',
        Traceparent: '00-abc-def-01',
      });
    });

    it('drops every non-allow-listed header regardless of case', () => {
      // `Authorization`, `Cookie`, and `X-Api-Key` are dropped at every
      // case variant (lower, Title, mixed). `X-Custom-Header` is also
      // dropped because it is not on the allow-list — adding new headers
      // requires explicit Rule R2 review per the comment in pino.ts.
      expect(
        allowListHeaders({
          Authorization: 'Bearer xyz',
          authorization: 'Bearer xyz',
          Cookie: 'session=abc',
          cookie: 'session=abc',
          'X-Api-Key': 'sk_xyz',
          'x-api-key': 'sk_xyz',
          'X-Custom-Header': 'anything',
        }),
      ).toEqual({});
    });

    it('handles a mix of allow-listed and disallowed headers', () => {
      expect(
        allowListHeaders({
          'content-type': 'application/json',
          authorization: 'Bearer xyz',
          'user-agent': 'jest',
          'x-api-key': 'sk_xyz',
        }),
      ).toEqual({
        'content-type': 'application/json',
        'user-agent': 'jest',
      });
    });

    it('preserves original key casing on allow-listed entries', () => {
      // The function clones the matched value verbatim under the original
      // key name. This is by design: downstream tooling that searches for
      // a specific header casing will find it.
      const result = allowListHeaders({
        'X-Correlation-ID': 'preserved',
        'Content-Type': 'application/json',
      });
      expect(Object.keys(result).sort()).toEqual(['Content-Type', 'X-Correlation-ID']);
      expect(result['X-Correlation-ID']).toBe('preserved');
      expect(result['Content-Type']).toBe('application/json');
    });
  });

  // -----------------------------------------------------------------------
  //  C5 — correlationId + uid attached via pino mixin (AsyncLocalStorage)
  // -----------------------------------------------------------------------
  //
  // The mixin reads `correlationStore.getStore()` once per record and adds
  // `correlationId` and `uid` to the merged record. Per Rule R2 / C5, no
  // other identity field is permitted. The mock allows tests to control
  // exactly what the mixin observes via `mockGetStore.mockReturnValue(...)`.

  describe('C5: mixin attaches correlationId + uid from AsyncLocalStorage', () => {
    it('attaches correlationId when the ALS store has one', () => {
      mockGetStore.mockReturnValue({ correlationId: 'corr-abc-123' });
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBe('corr-abc-123');
    });

    it('attaches both correlationId and uid when both are set', () => {
      // After session middleware mutates the store object in-place to add
      // `uid` post-`verifyIdToken`, every subsequent log record carries
      // both fields per ST-047-AC3 ("authenticated request flows … emit
      // log records that carry both the correlation identifier and the
      // authenticated user identifier").
      mockGetStore.mockReturnValue({
        correlationId: 'corr-abc-123',
        uid: 'user-xyz',
      });
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBe('corr-abc-123');
      expect(records[0]?.uid).toBe('user-xyz');
    });

    it('omits correlationId and uid when the ALS store is undefined', () => {
      // Outside any request context (application startup, background
      // timers, signal handlers), `correlationStore.getStore()` returns
      // `undefined` and the mixin emits NO identity fields. This is the
      // expected behaviour for non-request-bound log records.
      mockGetStore.mockReturnValue(undefined);
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBeUndefined();
      expect(records[0]?.uid).toBeUndefined();
    });

    it('omits uid when only correlationId is set in ALS', () => {
      // Pre-authentication request flows (the inbound boundary before
      // session middleware runs) carry `correlationId` but no `uid`.
      mockGetStore.mockReturnValue({ correlationId: 'corr-abc-123' });
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBe('corr-abc-123');
      expect(records[0]?.uid).toBeUndefined();
    });

    it('omits correlationId when the store has an empty string', () => {
      // Defense against a buggy upstream that mutates the store to an
      // empty correlation ID. The mixin's defensive checks
      // (`store.correlationId.length > 0`) MUST drop this case rather
      // than emit `correlationId: ''` which would distort dashboards.
      mockGetStore.mockReturnValue({ correlationId: '' });
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBeUndefined();
    });

    it('omits uid when the store has an empty string', () => {
      mockGetStore.mockReturnValue({ correlationId: 'corr-abc-123', uid: '' });
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.correlationId).toBe('corr-abc-123');
      expect(records[0]?.uid).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  //  ST-049-AC2 — traceId + spanId attached from the OTel active span
  // -----------------------------------------------------------------------
  //
  // ST-049-AC2 requires that "trace records include … the trace identifier,
  // … span identifier, … and the correlation identifier from the structured
  // logging contract so traces and logs can be joined". The pino mixin
  // satisfies this by reading `trace.getActiveSpan()` once per record and
  // emitting `traceId`/`spanId` when the span context is valid.

  describe('ST-049-AC2: mixin attaches traceId + spanId from OTel active span', () => {
    it('attaches traceId + spanId when a valid span is active', () => {
      // The hex strings here are the canonical W3C `traceparent` example
      // values from RFC: traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
      // (32 hex chars) and spanId = '00f067aa0ba902b7' (16 hex chars).
      // The mock's `isSpanContextValid` accepts these values exactly as
      // the real OTel library would.
      mockGetActiveSpan.mockReturnValue({
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1,
        }),
      } as unknown as ReturnType<typeof trace.getActiveSpan>);
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'traced');

      expect(records[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(records[0]?.spanId).toBe('00f067aa0ba902b7');
    });

    it('omits traceId + spanId when no active span', () => {
      mockGetActiveSpan.mockReturnValue(undefined);
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'untraced');

      expect(records[0]?.traceId).toBeUndefined();
      expect(records[0]?.spanId).toBeUndefined();
    });

    it('omits traceId + spanId when span context is the all-zeros no-op value', () => {
      // The OTel SDK returns a "non-recording" no-op span when no real
      // tracer has been registered. That span's `spanContext()` is the
      // INVALID_SPAN_CONTEXT (all-zeros traceId and spanId). The real
      // `isSpanContextValid()` rejects this; the mock mirrors it.
      // Without this rejection, the mixin would emit the literal string
      // '00000000000000000000000000000000' as the traceId, polluting
      // dashboards during application startup before OTel
      // auto-instrumentation opens the first inbound-request span.
      mockGetActiveSpan.mockReturnValue({
        spanContext: () => ({
          traceId: '0'.repeat(32),
          spanId: '0'.repeat(16),
          traceFlags: 0,
        }),
      } as unknown as ReturnType<typeof trace.getActiveSpan>);
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'invalid span');

      expect(records[0]?.traceId).toBeUndefined();
      expect(records[0]?.spanId).toBeUndefined();
    });

    it('combines correlationId + uid from ALS with traceId + spanId from OTel', () => {
      // The mixin emits all four identity fields in a single record when
      // both sources have valid data — this is the ST-049-AC2 logs↔traces
      // join path: a trace ID for OTel correlation, a correlation ID for
      // request-flow correlation, and a uid for user-flow correlation.
      mockGetStore.mockReturnValue({ correlationId: 'corr-xyz', uid: 'user-1' });
      mockGetActiveSpan.mockReturnValue({
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1,
        }),
      } as unknown as ReturnType<typeof trace.getActiveSpan>);
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'auth.success' }, 'login complete');

      expect(records[0]?.correlationId).toBe('corr-xyz');
      expect(records[0]?.uid).toBe('user-1');
      expect(records[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(records[0]?.spanId).toBe('00f067aa0ba902b7');
    });
  });

  // -----------------------------------------------------------------------
  //  ST-047-AC1 — required base fields: time, level, service, event
  // -----------------------------------------------------------------------
  //
  // ST-047-AC1 requires every record to carry "a timestamp, a severity
  // whose value is one of the enumerated tokens debug, info, warn, error,
  // or fatal, an event name, a service identifier, and a correlation
  // identifier, rendered in a machine-parseable format". This block
  // verifies the first four (correlationId is covered by the C5 block
  // above).

  describe('ST-047: required base fields', () => {
    it('emits the `service` field on every record', () => {
      // The `service` field must equal the OTel resource `service.name`
      // and the prom-client `service` label so cross-pillar correlation
      // works. The constant in pino.ts is `'strikeforge-backend'`.
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'a' }, 'one');
      logger.warn({ event: 'b' }, 'two');
      logger.error({ event: 'c' }, 'three');

      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.service).toBe('strikeforge-backend');
      }
    });

    it('emits the `level` as a string label (debug | info | warn | error | fatal)', () => {
      // Pino's default integer-level encoding (10|20|30|40|50|60) violates
      // ST-047-AC1 which specifies the severity be one of the enumerated
      // tokens. The `formatters.level` function in pino.ts converts the
      // integer to the canonical string label.
      const { logger, records } = makeCapturingLogger();

      logger.debug({ event: 'x' }, 'debug msg');
      logger.info({ event: 'x' }, 'info msg');
      logger.warn({ event: 'x' }, 'warn msg');
      logger.error({ event: 'x' }, 'error msg');
      logger.fatal({ event: 'x' }, 'fatal msg');

      expect(records.map((r) => r.level)).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
    });

    it('emits a `time` field in ISO 8601 UTC format', () => {
      // Pino's default `time` is epoch milliseconds. ST-047-AC1 requires a
      // "machine-parseable format"; ISO 8601 is that format. The pino
      // option `timestamp: pino.stdTimeFunctions.isoTime` enforces this.
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'timestamped');

      // Match `YYYY-MM-DDTHH:MM:SS(.sss)?Z` — the ISO 8601 UTC form
      // emitted by pino's `isoTime` function. Hardcoding a specific
      // value would create a flaky test; regex matching is the canonical
      // pattern for timestamp assertions.
      expect(records[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it('preserves the caller-supplied `event` field', () => {
      // The `event` field is the ST-047-AC1 "event name" — operator-facing
      // dashboard panels and alert rules filter on this stable identifier.
      // The logger MUST pass it through verbatim without renaming or
      // transforming it.
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'auth.login.success' }, 'msg');

      expect(records[0]?.event).toBe('auth.login.success');
    });

    it('omits the default pino `pid` and `hostname` base fields', () => {
      // The `base` option in pino.ts replaces pino's default
      // `{ pid, hostname }` with `{ service }`. This is intentional: pid
      // and hostname add noise without aiding debuggability in a
      // containerized single-process deployment, and a single `service`
      // field is the canonical identity dimension across logs, traces,
      // and metrics.
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'msg');

      expect(records[0]?.pid).toBeUndefined();
      expect(records[0]?.hostname).toBeUndefined();
      expect(records[0]?.service).toBe('strikeforge-backend');
    });

    it('preserves the caller-supplied human-readable `msg` field', () => {
      // The second argument to `logger.info(obj, msg)` becomes the `msg`
      // field in the emitted record. This is a pino convention preserved
      // verbatim so dashboards can display the human-readable string
      // alongside the structured `event` token.
      const { logger, records } = makeCapturingLogger();

      logger.info({ event: 'x' }, 'human readable');

      expect(records[0]?.msg).toBe('human readable');
    });
  });

  // -----------------------------------------------------------------------
  //  Error serializer — pino.stdSerializers.err
  // -----------------------------------------------------------------------
  //
  // The `err` serializer in pino.ts is `pino.stdSerializers.err`, the
  // canonical pino error serializer that produces a structured object with
  // `type`, `message`, and `stack`. This shape matches downstream tooling
  // (Cloud Logging, Sentry-compatible parsers, etc.).

  describe('err serializer (pino.stdSerializers.err)', () => {
    it('serializes Error objects with type, message, and stack', () => {
      const { logger, records } = makeCapturingLogger();
      const err = new Error('test error');

      logger.error({ event: 'test.err', err }, 'failed');

      const serialized = records[0]?.err as LogRecord | undefined;
      expect(serialized).toBeDefined();
      expect(serialized?.type).toBe('Error');
      expect(serialized?.message).toBe('test error');
      expect(typeof serialized?.stack).toBe('string');
    });

    it('serializes custom Error subclasses with the subclass name as `type`', () => {
      // Custom error classes are common in production code (e.g.
      // `class ValidationError extends Error`). The serializer reads
      // `error.constructor.name`, which is the subclass name — important
      // for dashboard aggregations that group by error type.
      class ValidationError extends Error {}
      const { logger, records } = makeCapturingLogger();
      const err = new ValidationError('field missing');

      logger.error({ event: 'validate.fail', err }, 'failed');

      const serialized = records[0]?.err as LogRecord | undefined;
      expect(serialized?.type).toBe('ValidationError');
      expect(serialized?.message).toBe('field missing');
    });
  });
});
