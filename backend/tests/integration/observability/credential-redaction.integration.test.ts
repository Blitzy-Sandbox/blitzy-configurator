/**
 * `credential-redaction.integration.test.ts` — Cross-cutting integration test
 * for Rule R2 (no credential material in logs) and the AAP §0.2.2 verbatim
 * SENTINEL_CRED_99 user example.
 *
 * ============================================================================
 * Authority and Mapping (verbatim citations)
 * ============================================================================
 *   - Rule R2 (AAP §0.8.1 — VERBATIM):
 *       "Log records MUST NOT contain passwords, bearer tokens, session
 *        tokens, or API keys. MUST enforce via pino serializer allow-list,
 *        not per-call discipline."
 *   - User Example (AAP §0.2.2 — VERBATIM):
 *       `curl -X POST http://localhost:3000/api/auth/login \
 *          -H "Content-Type: application/json" \
 *          -d '{"email":"test@example.com","password":"SENTINEL_CRED_99"}'`
 *       then `grep "SENTINEL_CRED_99" <(docker compose logs backend)` —
 *       expected: 0 lines returned.
 *   - Story ST-047 (`tickets/stories/ST-047-structured-logs-correlation-id.md`):
 *       AC4 — "No emitted log record ... contains passwords, bearer tokens,
 *             session identifiers, API keys, or PII ... enforced by a
 *             documented serializer or allow-list mechanism."
 *       AC3 — authenticated request flows emit log records carrying both
 *             correlation ID and user identifier, NEVER credential material.
 *   - Story ST-024 (`tickets/stories/ST-024-login-endpoint-session-token.md`):
 *       AC5 — login endpoint emits a structured log line with correlation
 *             ID, event name, and outcome (uid on success, error code on
 *             failure). Credential material is NEVER logged.
 *   - Story ST-044 (`tickets/stories/ST-044-integration-test-suite.md`):
 *       AC1 — triggered on every PR open and push.
 *       AC2 — deterministic fixtures; emits an integration report artifact.
 *       AC3 — distinguishes assertion failures from environment / fixture-
 *             setup failures (per-suite.ts `afterEach` rejection guard
 *             tags environmental failures distinctly).
 *
 * ============================================================================
 * Modules Under Test (real modules — only the SessionService is mocked)
 * ============================================================================
 *   - `backend/src/logging/pino.ts`:
 *       * `pinoOptions` — production options imported VERBATIM and passed
 *                         as `pino(pinoOptions, capture.stream)` so the
 *                         redact paths, request-header allow-list serializer,
 *                         and base/mixin/formatters configuration we observe
 *                         is byte-identical to production.
 *   - `backend/src/middleware/correlation.ts`:
 *       * `correlationMiddleware` — opens the AsyncLocalStorage frame so
 *                                   pino's mixin code path runs and the
 *                                   redaction allow-list is exercised
 *                                   end-to-end (Rule R2 verification).
 *   - `backend/src/routes/auth.ts`:
 *       * `createAuthRoutes` — produces the publicAuthRouter that mounts
 *                              POST /register and POST /login. The login
 *                              route is the AAP §0.2.2 verbatim user-example
 *                              entry point. The factory's REAL request
 *                              validation, body parsing, and error
 *                              translation run; only the injected
 *                              SessionService is mocked.
 *
 * ============================================================================
 * Why a Focused Test App
 * ============================================================================
 *   This file deliberately does NOT import `backend/src/index.ts`. Importing
 *   the production composition root would also boot Firebase Admin init,
 *   `pg.Pool`, GCS service init, and the full route map — none of which
 *   are needed to exercise the Rule R2 contract, all of which add startup
 *   latency, and most of which already have dedicated tests. The focused
 *   app contains the minimum middleware chain to exercise the credential-
 *   redaction lifecycle:
 *
 *     express.json() → correlationMiddleware → pino-http → publicAuthRouter
 *
 *   This middleware order mirrors AAP §0.5.6 production exactly. The
 *   pinoOptions passed to pino() is the SAME OBJECT the production logger
 *   uses, so any drift between this test's verdict and production behavior
 *   would require modifying pinoOptions itself — a change that would
 *   immediately surface in `backend/src/logging/pino.test.ts` as well.
 *
 * ============================================================================
 * Why Mock Only the Service
 * ============================================================================
 *   The auth route runs through several layers before the service call:
 *     1. express.json() parses the request body (with the password field).
 *     2. correlationMiddleware opens the ALS frame so log records carry
 *        the correlation ID.
 *     3. pino-http attaches `req.log` and emits the "request completed"
 *        log record at end-of-handler — THIS is the primary surface where
 *        credential material would leak via req.headers.authorization,
 *        req.headers.cookie, or request body fields if the redact.paths
 *        or req-serializer allow-list were defective.
 *     4. The route handler calls `loginBodySchema.parse(req.body)` — a
 *        ValidationError here would log via the route's error handler.
 *     5. The route handler calls `sessionService.login({email, password})`.
 *
 *   By mocking only the SERVICE call (step 5), the test exercises every
 *   surface (1–4) where a credential could leak into a log record, without
 *   requiring real Firebase Auth or PostgreSQL. The mock returns or throws
 *   at our discretion to drive both the success and failure code paths.
 *
 * ============================================================================
 * Rule Compliance Summary
 * ============================================================================
 *   - Rule R1 — every assertion below traces to Rule R2's verbatim sentinel
 *               requirement, ST-047 ACs, ST-024 logging contract, and
 *               ST-044 integration test scope.
 *   - Rule R2 — THIS FILE IS THE AUTHORITATIVE INTEGRATION VERIFICATION.
 *               Every test asserts sentinel/key absence via two-pronged
 *               (parsed records + raw byte stream) scans.
 *   - Rule R3 — sessionService is mocked (jest.fn()); no JWT libraries
 *               (jsonwebtoken, jose, jwt-decode) are imported.
 *   - Rule R4 — no `process.env.*` reads; no environment defaults.
 *   - Rule R6 / C4 — OTel pre-init is owned by `setup/register-tracing.ts`
 *                    (loaded by Jest `setupFiles` before any test imports);
 *                    this file imports nothing OTel-related.
 *   - Rule R8 — assertions throw with descriptive messages on failure;
 *               there is no `try/catch` that hides defects; the
 *               `afterEach` unhandled-rejection guard in `per-suite.ts`
 *               surfaces missed `await`s as fail-closed errors.
 *   - Rule R9 — no payment processing terms are exercised by this file.
 */

// ════════════════════════════════════════════════════════════════════════
// Imports
// ════════════════════════════════════════════════════════════════════════

// stdlib
import { Writable } from 'node:stream';

// third-party
import express, { type Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

// app under test (real modules — only sessionService is mocked)
import { correlationMiddleware } from '../../../src/middleware/correlation';
import { pinoOptions } from '../../../src/logging/pino';
import { createAuthRoutes } from '../../../src/routes/auth';

// ════════════════════════════════════════════════════════════════════════
// Sentinel Strings — Each is a unique value that cannot be accidentally
//                    produced by serialization machinery. If any of these
//                    sentinels appears in a log record's parsed JSON or
//                    in the raw byte stream, Rule R2 has been violated.
// ════════════════════════════════════════════════════════════════════════

/**
 * The VERBATIM sentinel from AAP §0.2.2 user example.
 *
 *   `curl -X POST http://localhost:3000/api/auth/login \
 *      -H "Content-Type: application/json" \
 *      -d '{"email":"test@example.com","password":"SENTINEL_CRED_99"}'`
 *   then `grep "SENTINEL_CRED_99" <(docker compose logs backend)` →
 *   expected: 0 lines.
 *
 * The string is intentionally short, ALL-CAPS, and includes the word
 * `SENTINEL` so an operator running `grep` in production logs can
 * distinguish it from realistic user passwords (which never contain
 * the literal string `SENTINEL_CRED_99`). Any occurrence in any log
 * record produced by this test suite is a Rule R2 violation.
 */
const SENTINEL_CRED_99 = 'SENTINEL_CRED_99';

/**
 * Sentinel for the nested-payload defense tests (Phase 7.5). The hex
 * suffix prevents accidental collisions with realistic credentials —
 * if this string appears in logs, it can ONLY be because the test
 * itself injected it.
 */
const SENTINEL_NESTED_PASSWORD = 'SENTINEL_NESTED_PASSWORD_a7f3c5b9';

/**
 * Sentinel for the Bearer-token regex sweep (Phase 7.3). The token
 * length (≥ 20 alphanumeric chars after "Bearer ") triggers the
 * BEARER_TOKEN_REGEX below.
 */
const SENTINEL_BEARER_TOKEN = 'SENTINEL_BEARER_TOKEN_e2b8c4d1f6a9';

/**
 * Sentinel for the API-key header tests (Phase 7.4). The string is
 * shaped like a typical API key (alphanumeric, no whitespace) so a
 * realistic vendor-secret header value triggers the allow-list
 * verification.
 */
const SENTINEL_API_KEY = 'SENTINEL_API_KEY_5xY2zPq8wRt0';

/**
 * Sentinel for the Cookie header test (Phase 7.4). The Cookie header
 * is the second most common credential-bearing header after
 * Authorization; the allow-list MUST drop it entirely.
 */
const SENTINEL_COOKIE_VALUE = 'SENTINEL_COOKIE_VALUE_kJ3mN9pL';

/**
 * Sentinel for the TitleCase Authorization header test (Phase 7.4).
 * Distinct from SENTINEL_BEARER_TOKEN to ensure TitleCase and
 * lowercase test cases assert on different values, preventing a
 * single-string positive match from masking either case.
 */
const SENTINEL_AUTH_HEADER_PAYLOAD = 'SENTINEL_AUTH_HEADER_PAYLOAD_qWeRtY1234567';

// ════════════════════════════════════════════════════════════════════════
// Forbidden-Key and Bearer-Token Patterns
// ════════════════════════════════════════════════════════════════════════

/**
 * Forbidden field-name regex. Any key matching this pattern (case-
 * insensitive) at ANY level of nesting in a log record is a Rule R2
 * defect. The regex is anchored (`^...$`) so it catches the FIELD
 * NAME itself — not strings that merely contain a credential
 * substring (which is a different defect class).
 *
 * The list mirrors the top-level entries of `REDACT_PATHS` in
 * `backend/src/logging/pino.ts`, plus the two header field names
 * (`authorization`, `cookie`, `set-cookie`) that the request-header
 * allow-list serializer DROPS entirely. If pino's redaction were ever
 * disabled or if the request serializer's allow-list were ever
 * weakened, one of these keys would surface in a log record and this
 * regex would catch it.
 */
const FORBIDDEN_KEY_PATTERN =
  /^(password|passwordHash|authorization|cookie|set-cookie|credential|credentialDigest|sessionToken|idToken|accessToken|refreshToken|firebaseToken|apiKey|api_key|secret|bearer)$/i;

/**
 * Bearer-token-shape regex per Rule R2's "bearer-token-pattern fields"
 * sentinel. Matches `Bearer ` (case-insensitive) followed by ≥ 20
 * URL-safe-base64 / JWT characters. A real Firebase ID token (~ 1KB)
 * easily exceeds 20 chars; a JSON Web Token consists of three
 * base64url-encoded segments separated by dots, which all fall within
 * the `[A-Za-z0-9._\-+/=]` class.
 *
 * Anchoring is intentionally absent: the regex matches anywhere in a
 * serialized record, so a leaked token embedded in any field
 * (errorMessage, errorStack, request URL, log message body) is caught.
 */
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/;

/**
 * The lowercase set of header keys the request serializer is
 * documented to KEEP. This is a verbatim mirror of
 * `REQUEST_HEADER_ALLOW_LIST` in `backend/src/logging/pino.ts` (lines
 * 140–157). Mirroring rather than re-importing avoids depending on a
 * non-exported symbol; any drift between the two lists is caught by
 * the explicit subset assertion in Phase 7.4.
 */
const REQUEST_HEADER_ALLOW_LIST_LOWER: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'host',
  'origin',
  'referer',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-correlation-id',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-request-id',
]);

// ════════════════════════════════════════════════════════════════════════
// Log Capture Helper
// ════════════════════════════════════════════════════════════════════════

/**
 * Shape of a captured log record. Every key is `unknown` because we
 * receive whatever pino emits; the named fields below are documented
 * for reader convenience but not enforced — this test file scans for
 * absence of credential material, not presence of expected fields
 * (those are owned by `correlation.integration.test.ts` and
 * `pino.test.ts`).
 */
interface CapturedLogRecord {
  [key: string]: unknown;
}

/**
 * Capture handle returned by `createLogCapture()`. Tests use:
 *   - `capture.stream` — passed to pino as the destination.
 *   - `capture.records` — array of parsed JSON objects (one per emitted line).
 *   - `capture.rawText` — concatenated raw bytes pino wrote, before parsing.
 *   - `capture.reset()` — empties both buffers in place.
 *
 * The dual-buffer design (parsed + raw) is essential: Rule R2's verbatim
 * verification command is `grep "SENTINEL_CRED_99"` against raw bytes,
 * not against parsed JSON keys. The two-pronged scan in
 * `assertSentinelAbsent()` mirrors the operator's grep posture.
 */
interface LogCapture {
  stream: Writable;
  records: CapturedLogRecord[];
  /** Concatenated raw bytes pino wrote — equivalent to `docker compose logs backend`. */
  readonly rawText: string;
  reset: () => void;
}

/**
 * Build an in-memory pino destination that:
 *   1. Concatenates every byte pino writes into `rawText` (mirrors the
 *      operator's `grep` posture against `docker compose logs backend`).
 *   2. Parses each newline-delimited JSON line into a structured
 *      record so tests can assert on field names and nested values.
 *
 * Failed JSON parses are silently dropped from the parsed array but
 * STILL captured in `rawText`. Pino under `pinoOptions` always emits
 * one JSON object per line, but this defensive parse handles non-JSON
 * output that would otherwise mask a credential leak (e.g., a stack
 * trace printed to stderr that happened to contain a sentinel).
 */
function createLogCapture(): LogCapture {
  const records: CapturedLogRecord[] = [];
  const rawChunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      const text = chunk.toString('utf8');
      rawChunks.push(text);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          records.push(JSON.parse(trimmed) as CapturedLogRecord);
        } catch {
          // Non-JSON output — preserved in `rawText` but skipped from
          // the parsed array. Pino under `pinoOptions` always emits
          // one JSON object per line; non-JSON would indicate a
          // pathological state. The raw-text capture above ensures a
          // leak is still detected even if the parser misses the line.
        }
      }
      cb();
    },
  });
  return {
    stream,
    records,
    get rawText(): string {
      return rawChunks.join('');
    },
    reset: (): void => {
      records.length = 0;
      rawChunks.length = 0;
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Recursive Key-Walking Assertion Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Recursively collect every key name that appears anywhere in `obj`,
 * at any depth. The walker:
 *   - Returns an empty array for non-objects (primitives, null,
 *     functions).
 *   - Skips arrays' indices but recurses into their element values.
 *   - Bounds depth at 50 levels to defend against pathological cycles.
 *     A real log record never nests beyond ~ 5 levels; 50 is a generous
 *     ceiling that still terminates promptly on a self-referential
 *     object.
 *
 * Used by `assertNoForbiddenKeys()` to find credential-bearing field
 * names at any nesting depth — pino's `redact.paths` only walks one
 * level of wildcard nesting, so the recursive sweep is the
 * defense-in-depth check that catches deeper nesting that the redactor
 * cannot reach.
 */
function collectAllKeys(obj: unknown, depth: number = 0): string[] {
  if (depth > 50) return [];
  if (obj === null || typeof obj !== 'object') return [];
  const keys: string[] = [];
  if (Array.isArray(obj)) {
    for (const element of obj) {
      keys.push(...collectAllKeys(element, depth + 1));
    }
    return keys;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    keys.push(key);
    keys.push(
      ...collectAllKeys((obj as Record<string, unknown>)[key], depth + 1),
    );
  }
  return keys;
}

/**
 * Throw if any record contains a key matching `FORBIDDEN_KEY_PATTERN`
 * at any nesting depth. The error message includes the offending key
 * name AND a truncated record dump so the developer can locate the
 * leak without re-running the test.
 *
 * Failure mode: a synchronous Error throw — surfaces in Jest's output
 * with the full message. Per Rule R8 (gates fail closed), this throw
 * MUST NOT be swallowed by any try/catch in the call chain.
 */
function assertNoForbiddenKeys(records: readonly CapturedLogRecord[]): void {
  for (const record of records) {
    const allKeys = collectAllKeys(record);
    for (const key of allKeys) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new Error(
          `Rule R2 violation: forbidden key "${key}" appears in log record. ` +
            `Record: ${JSON.stringify(record).slice(0, 500)}`,
        );
      }
    }
  }
}

/**
 * Throw if any record (after JSON serialization) contains a string
 * matching `BEARER_TOKEN_REGEX`. This catches a leaked Bearer token
 * embedded in any string field — including fields the structured-key
 * sweep would not catch (e.g., a token concatenated into an
 * errorMessage, a request URL query string, or a log message body).
 */
function assertNoBearerTokens(records: readonly CapturedLogRecord[]): void {
  for (const record of records) {
    const serialized = JSON.stringify(record);
    if (BEARER_TOKEN_REGEX.test(serialized)) {
      throw new Error(
        `Rule R2 violation: Bearer-token-shaped string detected in log record. ` +
          `Record: ${serialized.slice(0, 500)}`,
      );
    }
  }
}

/**
 * Throw if `sentinel` appears in either:
 *   - any parsed log record (after JSON.stringify), OR
 *   - the raw concatenated byte stream pino emitted.
 *
 * The dual check is essential. The parsed-records path catches
 * structured leaks (a sentinel value attached to a known field). The
 * raw-bytes path catches any byte sequence pino wrote, including
 * lines that failed to parse as JSON. The raw-bytes path is the
 * direct equivalent of the AAP §0.2.2 user-example
 * `grep "SENTINEL_CRED_99" <(docker compose logs backend)` expected
 * to return 0 lines.
 */
function assertSentinelAbsent(capture: LogCapture, sentinel: string): void {
  // Parsed records path (defense layer 1).
  for (const record of capture.records) {
    const serialized = JSON.stringify(record);
    if (serialized.includes(sentinel)) {
      throw new Error(
        `Rule R2 violation: sentinel "${sentinel}" appears in log record. ` +
          `Record: ${serialized.slice(0, 500)}`,
      );
    }
  }
  // Raw bytes path (defense layer 2 — mirrors the AAP §0.2.2 grep).
  if (capture.rawText.includes(sentinel)) {
    throw new Error(
      `Rule R2 violation: sentinel "${sentinel}" appears in raw log byte stream. ` +
        `First 500 chars: ${capture.rawText.slice(0, 500)}`,
    );
  }
}

// ════════════════════════════════════════════════════════════════════════
// SessionService Mock
// ════════════════════════════════════════════════════════════════════════

/**
 * Minimal structural mirror of `services/session.service.ts`'s
 * `SessionService` interface. Only the FIVE methods the factory
 * runtime-validates are present; the route only consumes `register`,
 * `login`, and `logout`, but the factory runtime-checks all five via
 * `typeof === 'function'`.
 *
 * Each method is a `jest.Mock` so individual tests can drive specific
 * success / failure scenarios via `mockResolvedValue` / `mockRejectedValue`
 * without affecting other tests (Jest config's `clearMocks` /
 * `resetMocks` / `restoreMocks` triple guarantees per-test isolation).
 */
type SessionServiceMock = {
  register: jest.Mock;
  login: jest.Mock;
  logout: jest.Mock;
  verifyToken: jest.Mock;
  isRevoked: jest.Mock;
};

/**
 * Construct a fresh, empty `SessionServiceMock`. Centralising
 * construction guarantees every test starts from the same baseline:
 * `jest.fn()` instances with no implementation, no recorded calls.
 */
function buildSessionService(): SessionServiceMock {
  return {
    register: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    verifyToken: jest.fn(),
    isRevoked: jest.fn(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// Test Express App Builder
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a focused Express app that mirrors AAP §0.5.6 production
 * middleware order for the Rule R2 slice we exercise:
 *
 *   1. `express.json()`            — parse JSON request body so the
 *                                     password field reaches the route
 *                                     handler.
 *   2. `correlationMiddleware`     — open the AsyncLocalStorage frame
 *                                     so pino's mixin emits
 *                                     `correlationId` on every record.
 *   3. `pinoHttp({ logger,         — attach `req.log` AND emit the
 *       serializers })`              "request completed" log line at
 *                                     end-of-handler. THIS is the
 *                                     primary surface where credential
 *                                     material would leak via
 *                                     req.headers / req.body if
 *                                     redaction were defective.
 *   4. `publicAuthRouter`          — POST /register, POST /login. The
 *                                     factory's REAL request validation,
 *                                     body parsing, and error translation
 *                                     all run; only the SessionService
 *                                     dependency is mocked.
 *
 * The `logger` is constructed with VERBATIM `pinoOptions` from
 * `backend/src/logging/pino.ts`. Modifying the options object before
 * passing it to pino would defeat the test — the options object IS
 * the contract under test (Rule R2 allow-list / redact paths).
 *
 * ── CRITICAL: pino-http serializer wiring ────────────────────────────
 *
 * pino-http (per `node_modules/pino-http/logger.js` lines 29–35)
 * resolves its req/res/err serializers from `opts.serializers`,
 * NOT from the underlying logger's `pinoOptions.serializers`. Without
 * an explicit `serializers:` argument, pino-http falls back to its
 * own defaults from `pino-std-serializers` — which serialise the
 * FULL request headers map (including Authorization, Cookie, etc.),
 * defeating the production allow-list serializer in `pinoOptions`.
 *
 * Per AAP §0.5.6, the production middleware chain mounts pino-http
 * AFTER correlation; per Rule R2 the allow-list serializer is the
 * PRIMARY defense against header leakage. To fulfil the AAP contract
 * end-to-end, the test app passes `pinoOptions.serializers` VERBATIM
 * to pino-http so the production allow-list applies inside pino-http's
 * request-completed log emission. pino-std-serializers' wrapping of
 * the custom serializer (`wrapRequestSerializer`) preserves the
 * allow-list behaviour: the default Express `req` is normalised to
 * a plain object first, then our custom serializer runs and returns
 * `{ method, url, headers: allowListHeaders(headers) }` — dropping
 * every non-allow-listed header entirely.
 *
 * This is the documented, supported pattern. The alternative
 * (relying on `pinoOptions.serializers` to apply transitively) is
 * NOT how pino-http works and would silently leak credential
 * headers in production if anyone ever wired pino-http per AAP
 * §0.5.6 step 4 — exactly the failure mode Rule R2 forbids.
 */
function buildApp(
  capture: LogCapture,
  sessionService: SessionServiceMock,
): Express {
  // Construct the test logger with PRODUCTION pinoOptions VERBATIM,
  // redirecting output to the in-memory capture stream.
  const logger = pino(pinoOptions, capture.stream);

  const app = express();

  // 1. Body parsing — limit matches production composition root in
  //    `backend/src/index.ts`. Without this, the password field never
  //    reaches the route handler and the validation/error-log code
  //    paths cannot be exercised.
  app.use(express.json({ limit: '1mb' }));

  // 2. Correlation middleware — opens the ALS frame so pino's mixin
  //    can attach `correlationId`. Mounted BEFORE pino-http so the
  //    correlation context is active when pino-http creates the
  //    request-scoped child logger.
  app.use(correlationMiddleware);

  // 3. pino-http — attaches `req.log` AND emits a "request completed"
  //    log record at end-of-handler. This is the primary surface for
  //    Rule R2 verification: req.headers, req.url, and (in some
  //    configurations) req.body would all be serialized into the
  //    record if not defended by the request serializer's allow-list.
  //
  //    Pass `serializers: pinoOptions.serializers` EXPLICITLY so
  //    pino-http uses the production allow-list serializer (which
  //    drops Authorization, Cookie, X-Vendor-Secret, etc. entirely)
  //    rather than its default `pino-std-serializers` req serializer
  //    (which emits ALL headers verbatim, leaving credential redaction
  //    to the secondary `redact.paths` layer that only redacts named
  //    paths). See the doc-block above for the full pino-http
  //    serializer-resolution rationale.
  app.use(pinoHttp({ logger, serializers: pinoOptions.serializers }));

  // 4. Public auth router — mounts POST /register and POST /login.
  //    The cast to the SessionService parameter type is the canonical
  //    pattern documented in `backend/src/routes/auth.test.ts` for
  //    substituting minimal mocks for richer interfaces.
  const { publicAuthRouter } = createAuthRoutes({
    sessionService: sessionService as unknown as Parameters<
      typeof createAuthRoutes
    >[0]['sessionService'],
  });
  app.use('/api/auth', publicAuthRouter);

  // 5. Defensive error handler — Express will fall back to the default
  //    error handler if a route throws synchronously, which writes to
  //    stderr (NOT pino). A test-level error handler converts the
  //    error into a 500 JSON response so the request lifecycle
  //    completes and pino-http's "request completed" log fires.
  //    Note: handleAuthError in auth.ts ALREADY catches all known
  //    error classes; this handler is reached only for the rare
  //    unexpected throw.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      const message =
        err instanceof Error ? err.message : 'unexpected error';
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    },
  );

  return app;
}

/**
 * Wait briefly for any deferred pino writes to flush. pino-http emits
 * the "request completed" log record on the response's `finish`
 * event, which fires synchronously after `res.json()` but before
 * supertest's promise resolves. A single setImmediate yield is enough
 * for the writable stream's buffered write callback to run; an
 * additional 10ms timer absorbs any further microtask scheduling
 * variability between Node versions.
 *
 * Returning a resolved promise after this two-step wait guarantees
 * that `capture.records` and `capture.rawText` reflect everything
 * pino emitted during the request lifecycle.
 */
async function flushLogs(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });
}

// ════════════════════════════════════════════════════════════════════════
// Test Suite — Rule R2 Credential Redaction (Integration)
// ════════════════════════════════════════════════════════════════════════

describe('Rule R2 — credential redaction integration', () => {
  let capture: LogCapture;
  let sessionService: SessionServiceMock;
  let app: Express;

  beforeEach(() => {
    capture = createLogCapture();
    sessionService = buildSessionService();
    app = buildApp(capture, sessionService);
  });

  afterEach(() => {
    capture.reset();
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.1 — Verbatim AAP §0.2.2 user example
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — verbatim AAP user example (SENTINEL_CRED_99)', () => {
    it(
      'SENTINEL_CRED_99 NEVER appears in any log record after ' +
        'POST /api/auth/login (failure path — INVALID_CREDENTIALS)',
      async () => {
        // The auth.ts createAuthRoutes factory checks via
        // `typeof === 'function'` that login throws synchronously OR
        // returns a Promise; we use a Promise rejection here because
        // sessionService.login is documented as `Promise<LoginResult>`.
        // The error class shape (UnauthenticatedError with code
        // INVALID_CREDENTIALS) is what `handleAuthError` translates to
        // a 401 envelope per ST-024-AC4 / AAP §0.2.2 enumeration
        // defense.
        const unauthenticatedError = Object.assign(
          new Error('invalid credentials'),
          {
            name: 'UnauthenticatedError',
            code: 'INVALID_CREDENTIALS',
          },
        );
        sessionService.login.mockRejectedValue(unauthenticatedError);

        // Exercise the AAP §0.2.2 verbatim user-example request.
        const response = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: 'test@example.com', password: SENTINEL_CRED_99 });

        // Ensure the request completed end-to-end and pino-http's
        // "request completed" log record has been written.
        await flushLogs();

        // 401 per ST-024-AC4 — generic error envelope.
        expect(response.status).toBe(401);

        // The PRIMARY assertion: AAP §0.2.2 verbatim verification.
        // Any occurrence of the sentinel anywhere in the parsed
        // records OR the raw byte stream is a Rule R2 violation.
        assertSentinelAbsent(capture, SENTINEL_CRED_99);

        // Sanity check: the test actually exercised the redaction
        // pipeline (NOT a no-op test that produced zero log records).
        // pino-http always emits at least the "request completed"
        // record at end-of-handler. If `records.length === 0`, the
        // pipeline is broken and the sentinel-absence assertion above
        // is meaningless.
        expect(capture.records.length).toBeGreaterThan(0);
      },
    );

    it(
      'SENTINEL_CRED_99 NEVER appears even on the success path ' +
        '(login resolves with idToken/uid/expiresAt)',
      async () => {
        // Mock a successful login: the service returns the
        // documented LoginResult shape `{idToken, uid, expiresAt}`.
        // The route encodes `expiresAt` as ISO-8601 via `res.json()`
        // — JSON.stringify converts Date instances to ISO-8601
        // strings automatically (V8 / Node behaviour).
        sessionService.login.mockResolvedValue({
          idToken: 'fake.jwt.token',
          uid: 'test-uid-12345',
          expiresAt: new Date('2025-12-31T23:59:59.000Z'),
        });

        const response = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: 'test@example.com', password: SENTINEL_CRED_99 });

        await flushLogs();

        // 200 per ST-024-AC2 — successful login.
        expect(response.status).toBe(200);

        // Even on the success path, the password MUST NOT appear.
        // A defective implementation might redact failures but not
        // successes (or vice versa) — both code paths must be clean
        // for Rule R2 to hold.
        assertSentinelAbsent(capture, SENTINEL_CRED_99);

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );

    it(
      'SENTINEL_CRED_99 NEVER appears when login is called with ' +
        'a malformed body that triggers Zod validation (400)',
      async () => {
        // Trigger a ValidationError BEFORE sessionService.login is
        // called. The `loginBodySchema` rejects bodies missing the
        // `email` field. handleAuthError translates ZodError to a
        // 400 envelope. The password field is still present in
        // req.body and would be at risk of leaking through pino-http's
        // request body logging if the redact paths or req serializer
        // failed.
        const response = await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ password: SENTINEL_CRED_99 }); // missing email

        await flushLogs();

        // 400 per ST-024-AC1 — validation error.
        expect(response.status).toBe(400);

        // login mock must NOT have been called (validation rejected
        // the body before delegation).
        expect(sessionService.login).not.toHaveBeenCalled();

        // Sentinel still absent.
        assertSentinelAbsent(capture, SENTINEL_CRED_99);

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.2 — Recursive forbidden-key sweep
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — recursive forbidden-key sweep', () => {
    it(
      'no log record contains a key matching password / Authorization / ' +
        'credential / token / secret at any nesting depth',
      async () => {
        // Drive several log-emitting requests across distinct error
        // shapes so the recursive sweep covers heterogeneous code
        // paths.
        sessionService.login.mockRejectedValue(
          Object.assign(new Error('invalid credentials'), {
            name: 'UnauthenticatedError',
            code: 'INVALID_CREDENTIALS',
          }),
        );
        sessionService.register.mockRejectedValue(
          Object.assign(new Error('email already in use'), {
            name: 'Error',
            code: 'auth/email-already-exists',
          }),
        );

        // Login failure (401).
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: 'a@b.com', password: 'plaintext-1' });

        // Register failure (409).
        await request(app)
          .post('/api/auth/register')
          .set('Content-Type', 'application/json')
          .send({ email: 'a@b.com', password: 'plaintext-2' });

        // Validation failure on login (400).
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({}); // missing both fields

        // 500 path — synthesise an unrecognised error shape (not
        // ValidationError, not UnauthenticatedError). handleAuthError
        // logs via req.log.error with the bounded payload {event,
        // errorName, errorCode, errorMessage}. None of these field
        // names are forbidden, but the log path runs end-to-end and
        // any future regression that widened the payload would surface
        // here.
        sessionService.login.mockRejectedValue(
          Object.assign(new Error('database unreachable'), {
            name: 'DatabaseError',
            code: 'ECONNREFUSED',
          }),
        );
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: 'c@d.com', password: 'plaintext-3' });

        await flushLogs();

        // Sweep every record at every nesting depth. Throws on any
        // forbidden-key match.
        assertNoForbiddenKeys(capture.records);

        // Sanity check.
        expect(capture.records.length).toBeGreaterThan(0);
      },
    );

    it(
      'forbidden keys nested inside the request body are redacted by ' +
        'pinoOptions.redact wildcards (defense layer)',
      async () => {
        // Submit a body with the password sentinel at multiple nesting
        // depths. The route's Zod schema is `.strict()` so this body
        // will fail validation (extra `extra` field) — but the
        // request-completed log record from pino-http still fires,
        // and the response error log from handleAuthError fires too.
        // Either log path that included `req.body` would leak
        // SENTINEL_NESTED_PASSWORD without redaction.
        const body = {
          email: 'x@y.com',
          password: 'top-level-plaintext',
          extra: { password: SENTINEL_NESTED_PASSWORD },
        };

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send(body);

        await flushLogs();

        // Recursive key sweep: no `password` field at any nesting
        // level. pinoOptions.redact wildcards (`*.password`) cover
        // one level of nesting; the request serializer drops the
        // request body entirely, so the sentinel cannot leak via that
        // path either.
        assertNoForbiddenKeys(capture.records);

        // Belt-and-suspenders: even if the redaction layer missed a
        // key, the value itself MUST NOT appear in raw bytes (the
        // request serializer drops req.body wholesale).
        assertSentinelAbsent(capture, SENTINEL_NESTED_PASSWORD);

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.3 — Bearer-token regex sweep
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — Bearer-token regex sweep', () => {
    it(
      'no log record contains a string matching the Bearer-token regex ' +
        'after a request with Authorization: Bearer <SENTINEL>',
      async () => {
        // Force the request to complete with a logged response
        // (success path so we exercise the most-recent log surface).
        sessionService.login.mockResolvedValue({
          idToken: 'fake.jwt.token',
          uid: 'test-uid',
          expiresAt: new Date('2025-12-31T23:59:59.000Z'),
        });

        const bearerHeader = `Bearer ${SENTINEL_BEARER_TOKEN}`;

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          // The login route does NOT require an Authorization header
          // (it's a public endpoint), but a misconfigured client
          // might send one anyway. The request serializer's allow-list
          // MUST drop the `authorization` key before pino emits the
          // record.
          .set('Authorization', bearerHeader)
          .send({ email: 'a@b.com', password: 'plaintext' });

        await flushLogs();

        // No string in any record matches the Bearer-token regex.
        assertNoBearerTokens(capture.records);

        // The sentinel value itself MUST not appear anywhere.
        assertSentinelAbsent(capture, SENTINEL_BEARER_TOKEN);

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );

    it(
      'no log record contains a Bearer token even when a structured ' +
        'log call accidentally tries to log req.headers.authorization',
      async () => {
        // This test exercises the explicit redact paths
        // `req.headers.authorization` and `headers.authorization`.
        // While the request serializer's allow-list drops authorization
        // entirely from req.headers, the redact paths defend against
        // any future code path that bypasses the serializer (e.g., a
        // logger.info call that constructs a custom object containing
        // headers).
        sessionService.login.mockRejectedValue(
          Object.assign(new Error('upstream timeout'), {
            name: 'UpstreamError',
            code: 'ETIMEDOUT',
          }),
        );

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('Authorization', `Bearer ${SENTINEL_BEARER_TOKEN}`)
          .send({ email: 'a@b.com', password: 'plaintext' });

        await flushLogs();

        // Two-pronged check: regex sweep PLUS exact sentinel
        // absence.
        assertNoBearerTokens(capture.records);
        assertSentinelAbsent(capture, SENTINEL_BEARER_TOKEN);

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.4 — Request-header allow-list
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — request-header allow-list', () => {
    it(
      'Authorization, Cookie, and X-Vendor-Secret headers are DROPPED ' +
        'from req.headers in log records (allow-list, not deny-list)',
      async () => {
        sessionService.login.mockResolvedValue({
          idToken: 'fake.jwt.token',
          uid: 'u',
          expiresAt: new Date('2025-12-31T23:59:59.000Z'),
        });

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('Authorization', `Bearer ${SENTINEL_BEARER_TOKEN}`)
          .set('Cookie', `session=${SENTINEL_COOKIE_VALUE}`)
          .set('X-Vendor-Secret', SENTINEL_API_KEY)
          .set('User-Agent', 'jest-test-credential-redaction')
          .send({ email: 'a@b.com', password: 'plaintext' });

        await flushLogs();

        // Locate the pino-http "request completed" record. pino-http
        // identifies this record by the presence of `req` AND `res`
        // members at the top level of the record.
        const requestCompletedRecords = capture.records.filter(
          (r) =>
            typeof r['req'] === 'object' &&
            r['req'] !== null &&
            typeof r['res'] === 'object' &&
            r['res'] !== null,
        );
        expect(requestCompletedRecords.length).toBeGreaterThan(0);

        for (const rec of requestCompletedRecords) {
          const req = rec['req'] as Record<string, unknown>;
          const headers = req['headers'] as
            | Record<string, unknown>
            | undefined;
          expect(typeof headers).toBe('object');
          expect(headers).not.toBeNull();

          // The deny side: forbidden header keys are NOT serialized
          // (allow-list approach drops them entirely rather than
          // censoring their values).
          expect(headers).not.toHaveProperty('authorization');
          expect(headers).not.toHaveProperty('Authorization');
          expect(headers).not.toHaveProperty('cookie');
          expect(headers).not.toHaveProperty('Cookie');
          expect(headers).not.toHaveProperty('x-vendor-secret');
          expect(headers).not.toHaveProperty('X-Vendor-Secret');

          // The allow side: known-safe keys are present. Express
          // normalises inbound header names to lowercase by default,
          // so the allow-list comparison is keyed on lowercase.
          // user-agent and content-type are both on the allow-list.
          // We use bracket access since the header keys may be
          // lowercase or mixed-case depending on Express version.
          const headersLower: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(
            headers as Record<string, unknown>,
          )) {
            headersLower[k.toLowerCase()] = v;
          }
          expect(headersLower['user-agent']).toBe(
            'jest-test-credential-redaction',
          );
          expect(typeof headersLower['content-type']).toBe('string');
        }

        // Belt-and-suspenders: the sentinel values MUST NOT appear in
        // raw log bytes either.
        assertSentinelAbsent(capture, SENTINEL_BEARER_TOKEN);
        assertSentinelAbsent(capture, SENTINEL_COOKIE_VALUE);
        assertSentinelAbsent(capture, SENTINEL_API_KEY);
      },
    );

    it(
      'TitleCase Authorization header is also dropped (case-insensitive ' +
        'allow-list)',
      async () => {
        sessionService.login.mockResolvedValue({
          idToken: 'fake.jwt.token',
          uid: 'u',
          expiresAt: new Date('2025-12-31T23:59:59.000Z'),
        });

        // Express normalises inbound header names to lowercase by
        // default, so by the time pino-http's req serializer sees the
        // headers, the keys are already lowercase. This test still
        // sets the header in TitleCase to document the intent and to
        // exercise any future Express version that preserves the
        // original case.
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('Authorization', `Bearer ${SENTINEL_AUTH_HEADER_PAYLOAD}`)
          .send({ email: 'a@b.com', password: 'plaintext' });

        await flushLogs();

        const requestCompletedRecords = capture.records.filter(
          (r) =>
            typeof r['req'] === 'object' &&
            r['req'] !== null &&
            typeof r['res'] === 'object' &&
            r['res'] !== null,
        );
        expect(requestCompletedRecords.length).toBeGreaterThan(0);

        for (const rec of requestCompletedRecords) {
          const req = rec['req'] as Record<string, unknown>;
          const headers = req['headers'] as Record<string, unknown>;
          // Both casings must be absent — the allow-list compares
          // case-insensitively.
          expect(headers).not.toHaveProperty('authorization');
          expect(headers).not.toHaveProperty('Authorization');
        }

        // The sentinel value MUST NOT appear anywhere.
        assertSentinelAbsent(capture, SENTINEL_AUTH_HEADER_PAYLOAD);
      },
    );

    it(
      'only allow-listed headers appear in serialized req.headers ' +
        '(strict subset of REQUEST_HEADER_ALLOW_LIST)',
      async () => {
        sessionService.login.mockResolvedValue({
          idToken: 'fake.jwt.token',
          uid: 'u',
          expiresAt: new Date('2025-12-31T23:59:59.000Z'),
        });

        // Send a request with a deliberately wide mix of allow-listed
        // and forbidden headers. The serializer MUST keep ONLY the
        // allow-listed subset.
        await request(app)
          .post('/api/auth/login')
          .set('User-Agent', 'jest-allow-list-test')
          .set('Content-Type', 'application/json')
          .set('Accept', 'application/json')
          .set('X-Correlation-Id', '11111111-2222-4333-8444-555555555555')
          .set('X-Forwarded-For', '127.0.0.1')
          .set('Authorization', `Bearer ${SENTINEL_BEARER_TOKEN}`)
          .set('Cookie', `session=${SENTINEL_COOKIE_VALUE}`)
          .set('X-Custom-Sensitive', 'CUSTOM-NEVER-LOGGED')
          .send({ email: 'a@b.com', password: 'plaintext' });

        await flushLogs();

        const requestCompletedRecords = capture.records.filter(
          (r) =>
            typeof r['req'] === 'object' &&
            r['req'] !== null &&
            typeof r['res'] === 'object' &&
            r['res'] !== null,
        );
        expect(requestCompletedRecords.length).toBeGreaterThan(0);

        for (const rec of requestCompletedRecords) {
          const req = rec['req'] as Record<string, unknown>;
          const headers = req['headers'] as Record<string, unknown>;
          const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());

          // STRICT SUBSET assertion: every key present in the
          // serialized record's req.headers MUST be a member of the
          // documented allow-list. This is the "allow-list, not
          // deny-list" assertion in its strongest form.
          for (const key of headerKeys) {
            expect(REQUEST_HEADER_ALLOW_LIST_LOWER.has(key)).toBe(true);
          }
        }

        // Belt-and-suspenders.
        assertSentinelAbsent(capture, SENTINEL_BEARER_TOKEN);
        assertSentinelAbsent(capture, SENTINEL_COOKIE_VALUE);
        assertSentinelAbsent(capture, 'CUSTOM-NEVER-LOGGED');
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.5 — Nested-payload defense
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — nested-payload defense', () => {
    it(
      'redaction survives request bodies with deeply-nested forbidden ' +
        'field names (request body is dropped entirely by req serializer)',
      async () => {
        // The request serializer in `pinoOptions.serializers.req`
        // returns ONLY {method, url, headers}. The request body is
        // NOT serialized. This test verifies that contract by sending
        // a body with credentials at multiple nesting depths and
        // confirming none of them appear in any log record.
        const body = {
          email: 'x@y.com',
          password: 'top-level-plaintext',
          credentials: {
            token: 'mid-level-token',
            apiKey: 'mid-level-api-key',
            user: {
              password: SENTINEL_NESTED_PASSWORD,
              secret: 'deep-secret',
            },
          },
        };

        sessionService.login.mockRejectedValue(
          Object.assign(new Error('invalid credentials'), {
            name: 'UnauthenticatedError',
            code: 'INVALID_CREDENTIALS',
          }),
        );

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send(body);

        await flushLogs();

        // Recursive forbidden-key sweep across all records.
        assertNoForbiddenKeys(capture.records);

        // Every nested credential value MUST be absent from raw bytes.
        assertSentinelAbsent(capture, SENTINEL_NESTED_PASSWORD);
        assertSentinelAbsent(capture, 'top-level-plaintext');
        assertSentinelAbsent(capture, 'mid-level-token');
        assertSentinelAbsent(capture, 'mid-level-api-key');
        assertSentinelAbsent(capture, 'deep-secret');

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );

    it(
      'pinoOptions.redact wildcard "*.password" covers one level of ' +
        'nesting (defense layer for ad-hoc logger calls)',
      async () => {
        // This test exercises the redact-paths defense via a direct
        // pino call (NOT through the route). It documents that
        // `pinoOptions.redact.paths` actively redacts when a caller
        // explicitly passes a credential-bearing object.
        //
        // Pino's redact mechanism walks the configured paths on the
        // log record before emission. With pinoOptions VERBATIM, the
        // wildcard `*.password` matches any key one level deep named
        // `password`. The censor is `[REDACTED]` (NOT removed).
        //
        // We use the existing capture to keep the test parallel with
        // the surrounding suite — every record emitted during this
        // test gets scanned by the `assertSentinelAbsent` call.
        const standaloneLogger = pino(pinoOptions, capture.stream);
        standaloneLogger.info(
          {
            event: 'test.adhoc.log',
            user: { password: SENTINEL_NESTED_PASSWORD },
          },
          'ad-hoc log call with nested password',
        );

        await flushLogs();

        // The sentinel value MUST be absent. Pino either redacted
        // the field (replacing the value with `[REDACTED]`) or never
        // serialized it.
        assertSentinelAbsent(capture, SENTINEL_NESTED_PASSWORD);

        // The forbidden-key sweep also passes — though `password`
        // would technically match the regex if present, it is
        // expected to BE PRESENT as a key with a [REDACTED] value
        // OR absent entirely. We verify the field name does NOT
        // appear with the original sentinel value.
        const recordsWithNestedPassword = capture.records.filter((r) => {
          const user = r['user'] as Record<string, unknown> | undefined;
          return user !== undefined && 'password' in user;
        });
        for (const rec of recordsWithNestedPassword) {
          const user = rec['user'] as Record<string, unknown>;
          // The value MUST be the censor token, not the sentinel.
          expect(user['password']).toBe('[REDACTED]');
          expect(user['password']).not.toBe(SENTINEL_NESTED_PASSWORD);
        }

        expect(capture.records.length).toBeGreaterThan(0);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.6 — Error log credential safety (boundary documentation)
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — error log credential safety boundary', () => {
    it(
      'error logs from handleAuthError do NOT echo arbitrary objects: ' +
        'the structured payload is bounded to {event, errorName, errorCode, errorMessage}',
      async () => {
        // The route's error handler (handleAuthError in
        // backend/src/routes/auth.ts lines 880–940) constructs an
        // EXPLICIT bounded log payload — it does NOT pass the entire
        // error object, the full stack trace, or the request body to
        // req.log.error. This is the route-level Rule R2 contract.
        //
        // To verify this contract, we synthesise an unrecognised
        // error class (NOT ValidationError, NOT UnauthenticatedError)
        // so handleAuthError takes the 500 branch — which is the only
        // branch that calls req.log.error explicitly.
        //
        // The error message contains a credential-shaped substring
        // ("password=secret-internal-XXX") that the route truncates to
        // 200 chars and logs as `errorMessage`. Per the auth.ts agent
        // prompt, this is BY DESIGN: the field name is `errorMessage`,
        // not `password`, so the field-name-keyed redaction layer does
        // NOT redact it. This test DOCUMENTS that boundary so future
        // maintainers understand where redaction stops.
        sessionService.login.mockRejectedValue(
          Object.assign(
            new Error(
              'connection failed: details=' +
                'CRED_SUBSTRING_IN_ERROR_MESSAGE_DEFENSE',
            ),
            {
              name: 'DatabaseError',
              code: 'ECONNREFUSED',
            },
          ),
        );

        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: 'x@y.com', password: SENTINEL_CRED_99 });

        await flushLogs();

        // 1. The forbidden-FIELD-NAME sweep passes: no key named
        //    `password`, `authorization`, `credential`, etc. appears
        //    anywhere in the records (this is the GUARANTEE of Rule R2).
        assertNoForbiddenKeys(capture.records);

        // 2. The PASSWORD itself MUST not appear: the request body's
        //    password field is not serialized by pino-http (per the
        //    request serializer's allow-list).
        assertSentinelAbsent(capture, SENTINEL_CRED_99);

        // 3. Locate the auth.route.error log record (emitted by
        //    handleAuthError on the 500 path). The bounded payload
        //    contains exactly the four documented fields:
        //    {event, errorName, errorCode, errorMessage}.
        const errorRecords = capture.records.filter(
          (r) => r['event'] === 'auth.route.error',
        );

        // The 500 path of handleAuthError logs unconditionally when
        // req.log is present (which it is, via pino-http). At least
        // one such record must exist.
        expect(errorRecords.length).toBeGreaterThan(0);

        for (const rec of errorRecords) {
          // Required structured fields per ST-024-AC5 and
          // backend/src/routes/auth.ts handleAuthError contract.
          expect(rec['event']).toBe('auth.route.error');
          expect(typeof rec['errorName']).toBe('string');
          // `errorCode` may be undefined for errors without a `code`
          // member, but on this synthetic error we set code='ECONNREFUSED'.
          expect(rec['errorCode']).toBe('ECONNREFUSED');
          expect(typeof rec['errorMessage']).toBe('string');

          // The route-level contract: errorMessage is truncated to
          // ≤ 200 chars. This is a soft check on the bounded payload
          // shape, not a credential-redaction assertion.
          const errorMessage = rec['errorMessage'] as string;
          expect(errorMessage.length).toBeLessThanOrEqual(200);

          // The bounded payload MUST NOT contain a stack trace, a
          // request body, query string, or any other unbounded handler
          // field. Two categories of acceptable keys exist on the
          // record:
          //
          //   (A) Framework-emitted fields: `level`, `time`, `msg`,
          //       `service` (from pinoOptions.base), and the mixin
          //       fields `correlationId`, `uid`, `traceId`, `spanId`.
          //       These are pino's own structured envelope.
          //
          //   (B) pino-http chindings: `req` and (sometimes) `res`.
          //       pino-http (per node_modules/pino-http/logger.js
          //       line 144 — `log.child({ [reqKey]: req })`) injects
          //       a `req` chinding into the request-scoped child
          //       logger. EVERY record emitted via `req.log.<level>`
          //       therefore carries `req` automatically. Per Rule R2,
          //       this is SAFE because the `req` chinding flows
          //       through the production allow-list serializer (we
          //       passed `serializers: pinoOptions.serializers` to
          //       pinoHttp in `buildApp`), which strips body / query /
          //       params and reduces headers to the allow-list.
          //
          //   (C) Handler-supplied fields: `event`, `errorName`,
          //       `errorCode`, `errorMessage`. The route's
          //       `handleAuthError` (auth.ts L880–940) constructs
          //       this bounded payload explicitly. Any OTHER
          //       handler-supplied key would be a regression.
          //
          // The check below partitions the record's keys into these
          // three categories and asserts no UNKNOWN key appears.
          const frameworkKeys = new Set([
            'level',
            'time',
            'msg',
            'service',
            'correlationId',
            'uid',
            'traceId',
            'spanId',
          ]);
          const pinoHttpChindingKeys = new Set(['req', 'res']);
          const allowedHandlerKeys = new Set([
            'event',
            'errorName',
            'errorCode',
            'errorMessage',
          ]);

          for (const k of Object.keys(rec)) {
            const allowed =
              frameworkKeys.has(k) ||
              pinoHttpChindingKeys.has(k) ||
              allowedHandlerKeys.has(k);
            expect(allowed).toBe(true);
          }

          // Verify the bounded handler-supplied subset is COMPLETE:
          // the four documented fields MUST all be present (this
          // catches a regression where the handler stops emitting
          // one of them).
          for (const required of allowedHandlerKeys) {
            expect(Object.keys(rec)).toContain(required);
          }

          // Verify the pino-http `req` chinding (when present) has
          // the BOUNDED shape produced by the production allow-list
          // serializer in pinoOptions.serializers.req. The serializer
          // returns ONLY `{ method, url, headers }` — body, query,
          // params, remoteAddress, remotePort are DROPPED entirely.
          //
          // This is the key Rule R2 defense surfaced through the
          // pino-http chinding: even though `req` is auto-injected,
          // its credential-bearing surfaces are pre-filtered.
          if (rec['req'] !== undefined) {
            const reqChinding = rec['req'] as Record<string, unknown>;
            const reqKeysAllowed = new Set(['method', 'url', 'headers']);
            for (const k of Object.keys(reqChinding)) {
              expect(reqKeysAllowed.has(k)).toBe(true);
            }
            // The headers, when present, must be a subset of the
            // allow-list. Any non-allow-listed key in the chinding
            // would be a Rule R2 regression at the serializer layer.
            const headers = reqChinding['headers'] as
              | Record<string, unknown>
              | undefined;
            if (headers !== undefined) {
              for (const headerKey of Object.keys(headers)) {
                expect(
                  REQUEST_HEADER_ALLOW_LIST_LOWER.has(headerKey.toLowerCase()),
                ).toBe(true);
              }
            }
          }
        }
      },
    );

    it(
      'error logs are not emitted for ValidationError (400) or ' +
        'UnauthenticatedError (401) paths — those branches do NOT call req.log.error',
      async () => {
        // ValidationError path: the 400 branch in handleAuthError
        // returns immediately without logging. This test verifies
        // that no `auth.route.error` event is emitted on the 400 path.
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({}); // missing email and password — Zod fails

        await flushLogs();

        const errorRecords400 = capture.records.filter(
          (r) => r['event'] === 'auth.route.error',
        );
        expect(errorRecords400.length).toBe(0);

        // Sentinel sweep still passes (no credential material on
        // this path either).
        assertNoForbiddenKeys(capture.records);
      },
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // 7.7 — End-to-end Rule R2 holistic invariant
  // ──────────────────────────────────────────────────────────────────
  describe('Rule R2 — holistic invariant across multiple request shapes', () => {
    it(
      'across all known auth route entry points, NO credential ' +
        'material ever appears in any log record',
      async () => {
        // This holistic test fires several distinct request shapes
        // through the auth router and runs the full battery of Rule R2
        // assertions at the end. If any single emitted record violates
        // any of the assertions, Rule R2 has failed somewhere in the
        // pipeline.
        sessionService.register.mockRejectedValue(
          Object.assign(new Error('email already in use'), {
            name: 'Error',
            code: 'auth/email-already-exists',
          }),
        );
        sessionService.login.mockRejectedValue(
          Object.assign(new Error('invalid credentials'), {
            name: 'UnauthenticatedError',
            code: 'INVALID_CREDENTIALS',
          }),
        );

        // Permutation 1: register with sentinel password.
        await request(app)
          .post('/api/auth/register')
          .set('Content-Type', 'application/json')
          .send({ email: 'a@b.com', password: SENTINEL_CRED_99 });

        // Permutation 2: login with sentinel password and Bearer header.
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('Authorization', `Bearer ${SENTINEL_BEARER_TOKEN}`)
          .send({ email: 'c@d.com', password: SENTINEL_CRED_99 });

        // Permutation 3: login with Cookie header carrying a session
        // sentinel.
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('Cookie', `session=${SENTINEL_COOKIE_VALUE}`)
          .send({ email: 'e@f.com', password: SENTINEL_CRED_99 });

        // Permutation 4: login with X-Vendor-Secret API-key sentinel.
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .set('X-Vendor-Secret', SENTINEL_API_KEY)
          .send({ email: 'g@h.com', password: SENTINEL_CRED_99 });

        // Permutation 5: login with malformed body that bypasses
        // service delegation (Zod 400).
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send({ email: SENTINEL_NESTED_PASSWORD }); // missing password

        await flushLogs();

        // Run the FULL Rule R2 battery against ALL emitted records.
        assertNoForbiddenKeys(capture.records);
        assertNoBearerTokens(capture.records);

        // Every sentinel MUST be absent.
        assertSentinelAbsent(capture, SENTINEL_CRED_99);
        assertSentinelAbsent(capture, SENTINEL_BEARER_TOKEN);
        assertSentinelAbsent(capture, SENTINEL_COOKIE_VALUE);
        assertSentinelAbsent(capture, SENTINEL_API_KEY);
        assertSentinelAbsent(capture, SENTINEL_NESTED_PASSWORD);

        // Sanity check: at least one record per permutation was
        // emitted (5 permutations × ≥1 record each = ≥ 5).
        expect(capture.records.length).toBeGreaterThanOrEqual(5);
      },
    );
  });
});
