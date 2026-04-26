/**
 * Pino logger with serializer-driven redaction.
 *
 * Per Rule R2 (NON-NEGOTIABLE): log records MUST NOT contain
 * passwords, bearer tokens, session tokens, or API keys. Enforcement
 * is via two complementary layers — applied at logger construction so
 * every record (including those from pino-http, child loggers, and
 * request-scoped binders) is scrubbed of credentials regardless of the
 * call-site discipline of the caller:
 *
 *   1. PATH-BASED REDACTION (`redact.paths`) — pino's built-in
 *      allow-list of structured field paths whose values are replaced
 *      with the censor string. Matches occur on TYPED VALUES (the
 *      property at that path is replaced wholesale), so this layer
 *      defends against credentials passed in as STRUCTURED fields
 *      (e.g. `{ password: 'secret' }` inside `req.body`).
 *
 *   2. CUSTOM `err` SERIALIZER — overrides pino's default
 *      `stdSerializers.err` to strip body-parser–attached fields that
 *      may contain credentials embedded INSIDE STRING VALUES (which
 *      path-based redaction cannot reach). The body-parser package
 *      attaches the RAW REQUEST BODY STRING to `err.body` when JSON
 *      parsing fails; that string can contain credentials embedded
 *      within otherwise-malformed JSON (e.g. `{"password":"..","bad`).
 *      The serializer removes `body` (and other body-parser
 *      housekeeping fields like `expose`) before the record is
 *      emitted.
 *
 * Together these layers prevent credential leaks via:
 *   - Authentication request bodies (path: `password`, `body.password`,
 *     `req.body.password`, `request.body.password`, `*.password`)
 *   - Authorization headers (path: `Authorization`, `headers.authorization`,
 *     `req.headers.authorization`, `request.headers.authorization`)
 *   - Cookies / session tokens (path: `cookie`, `headers.cookie`,
 *     `headers["set-cookie"]`)
 *   - Generic credential containers (path: `credential`, `*.credential`,
 *     `apiKey`, `*.apiKey`, `idToken`, `*.idToken`, `sessionToken`,
 *     `*.sessionToken`, `bearer`, `*.bearer`, `token`, `*.token`,
 *     `access_token`, `*.access_token`)
 *   - body-parser SyntaxError raw-body leaks (custom err serializer
 *     strips `err.body`; redact path `err.body` provides
 *     belt-and-suspenders defense)
 *
 * The Rule R2 user-supplied SENTINEL test ("SENTINEL_CRED_99" inside
 * a JSON `password` field MUST not appear in the logs) is satisfied
 * because:
 *   - Well-formed JSON: `password` path matches both the top-level
 *     and the nested `req.body.password` locations → redacted.
 *   - Malformed JSON (the QA-discovered leak path): the custom err
 *     serializer strips `err.body` before serialization → eliminated.
 */

import pino from 'pino';
import type { Logger, LoggerOptions, SerializerFn } from 'pino';

/**
 * Optional fields that the caller can attach to every record via the
 * pino `mixin` hook (e.g. AsyncLocalStorage-derived correlationId).
 */
export interface CreateLoggerOptions {
  service: string;
  environment: string;
  version: string;
  /**
   * Optional pino mixin function. Called at every record emission;
   * the returned object is merged into the record so dynamic fields
   * such as the current correlation ID can be added without manual
   * threading. The application-level mixin is defined in
   * `backend/src/index.ts`, where it reads the active
   * `correlationStore` (`AsyncLocalStorage` from
   * `./middleware/correlation`) and emits `correlationId` (and `uid`
   * when authenticated) on every log record.
   */
  mixin?: () => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Custom err serializer — Rule R2 / ST-047-AC4 hardening
// ---------------------------------------------------------------------------

/**
 * Set of error properties that body-parser, http-errors, and similar
 * Express ecosystem libraries attach to thrown errors but which can
 * contain credential material verbatim. These properties are stripped
 * from every serialized error record before it reaches the logger
 * output stream.
 *
 * Why an allow-LIST of fields-to-DROP rather than an allow-list of
 * fields-to-KEEP:
 *   The default `pino.stdSerializers.err` already produces a small
 *   structured shape (`type`, `message`, `stack`, `cause`) and spreads
 *   any additional enumerable error properties. The vast majority of
 *   those additional properties (e.g. `code`, `errno`, `syscall`,
 *   `address`, `port` from Node networking errors; `statusCode`,
 *   `status` from HTTP errors) are SAFE and operationally useful for
 *   debugging. Only the small named set below is dangerous, so a
 *   targeted strip-list preserves debuggability while closing the
 *   credential leak.
 *
 * The set:
 *   - `body`    — the RAW REQUEST BODY STRING attached by body-parser
 *                 when JSON parsing fails. This is the QA-discovered
 *                 leak surface (`{"password":"<CREDENTIAL>","bad`).
 *                 Stripping unconditionally because it can NEVER
 *                 contain credential-free content useful for debugging
 *                 (the original bytes are inherently unredactable, and
 *                 the actual error message — `"Unexpected token at
 *                 position N"` — already conveys the parse position).
 *   - `expose`  — `http-errors`' "should this be sent to client" flag.
 *                 Operational metadata of no debugging value; included
 *                 here so the serialized err object stays compact.
 *   - `headers` — some HTTP-aware error libraries attach response or
 *                 request headers to the error. Headers can contain
 *                 `Authorization`, `Cookie`, etc. — high-leak-risk.
 *   - `config`  — axios-style error config with potentially full
 *                 request data including auth headers. We don't use
 *                 axios in the backend (Firebase Admin SDK uses its
 *                 own HTTP client), but stripping defensively prevents
 *                 future regression if a library is added later.
 *   - `request` — http.ClientRequest object reference; can serialize
 *                 to a wall of bytes including the full request body
 *                 if the consumer .toString()s it.
 *   - `response`— same risk as `request` for the response side.
 *   - `req`     — body-parser's own attachment of the inbound request
 *                 (the entire Express Request object). Pino's `req`
 *                 serializer would handle a top-level `req`, but a
 *                 NESTED `req` inside an `err` bypasses it.
 *   - `res`     — same as `req` for the response side.
 */
const STRIPPED_ERR_PROPERTIES: ReadonlySet<string> = new Set([
  'body',
  'expose',
  'headers',
  'config',
  'request',
  'response',
  'req',
  'res',
]);

/**
 * Custom err serializer that wraps `pino.stdSerializers.err` and
 * strips body-parser–attached and HTTP-library–attached fields that
 * may contain credential material.
 *
 * This serializer is the PRIMARY defense against the QA-discovered
 * Issue 3: body-parser's `createError(400, err, { body: str, ... })`
 * call (in `node_modules/body-parser/lib/read.js`) attaches the raw
 * request body string to the SyntaxError. Because path-based redaction
 * cannot match credentials embedded INSIDE A STRING VALUE, eliminating
 * the field at serialization time is the only complete fix.
 *
 * Behaviour:
 *   - `null` / `undefined` / non-Error inputs: returned unchanged so
 *     the standard serializer's edge-case handling is preserved.
 *   - `Error` instances: passed through `pino.stdSerializers.err` to
 *     get the canonical { type, message, stack, ... } shape, then
 *     fields in `STRIPPED_ERR_PROPERTIES` are removed from the result.
 *   - Always returns a NEW object — the input err is never mutated, so
 *     downstream consumers (e.g. an Express error handler that calls
 *     `next(err)` after logging) receive an unchanged error.
 *
 * Per AAP §0.5.6 the err serializer is composed from `pino.stdSerializers.err`
 * (not a from-scratch serializer) so the canonical output shape stays
 * compatible with any external log-aggregation tooling that expects
 * pino's standard format. We only SUBTRACT dangerous fields; we never
 * ADD non-standard ones.
 */
const safeErrSerializer: SerializerFn = function safeErrSerializer(err: unknown): unknown {
  // Edge case: explicit null/undefined. Matches the behaviour of pino's
  // standard serializer (which returns the input unchanged in these
  // cases).
  if (err === null || err === undefined) {
    return err;
  }

  // Edge case: non-Error value passed (e.g. a string thrown via
  // `throw 'oops'`). pino's stdSerializers.err handles this by wrapping
  // in a pseudo-error shape; we delegate identically.
  if (!(err instanceof Error)) {
    // Preserve pino's own non-Error handling. The `stdSerializers.err`
    // signature accepts `Error` but at runtime tolerates other values
    // — we cast through `unknown` to satisfy TypeScript without losing
    // strictness in callers.
    return pino.stdSerializers.err(err as Error);
  }

  // Standard path: serialize via pino's canonical serializer, then
  // subtract dangerous fields.
  const serialized = pino.stdSerializers.err(err);
  if (typeof serialized !== 'object' || serialized === null) {
    return serialized;
  }

  // Build a fresh object so we never mutate pino's returned reference.
  // Iterate explicitly so we drop only the named dangerous fields and
  // preserve all other enumerable error metadata (statusCode, code,
  // errno, syscall, etc.) that operators rely on for debugging.
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(serialized as Record<string, unknown>)) {
    if (STRIPPED_ERR_PROPERTIES.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

/**
 * Public re-export of the safe err serializer for use in unit tests.
 * Tests can import this and assert that a body-parser–style error with
 * an attached `body` field has the field stripped at serialization
 * time. The export name is prefixed with an underscore to signal that
 * it is internal-to-tests and not part of the application API.
 */
export const _safeErrSerializer = safeErrSerializer;

/**
 * Creates the application-wide pino logger with the redaction
 * allow-list applied. Returns a real Logger instance — there is no
 * mocking / no-op logger; per the user-provided Observability Rule
 * the logger is part of the Phase A foundation.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const opts: LoggerOptions = {
    // Use ISO timestamps so log aggregation systems can sort
    // chronologically without bespoke parsers.
    timestamp: pino.stdTimeFunctions.isoTime,
    // Default level falls back to "info" so production-like
    // verbosity is the baseline; LOG_LEVEL=debug enables verbose
    // diagnostics without source changes.
    level: process.env['LOG_LEVEL'] ?? 'info',
    // Base fields stamped on every record — these align with the
    // service / environment / version labels required by the
    // Prometheus metrics endpoint (ST-048-AC2) so log+metric joins
    // are straightforward.
    base: {
      service: options.service,
      environment: options.environment,
      version: options.version,
      pid: process.pid,
    },
    // Mixin hook for AsyncLocalStorage-derived fields (correlationId,
    // uid). When `options.mixin` is undefined, no extra fields are
    // emitted — but an undefined mixin is itself rejected by pino, so
    // we only attach the property when defined.
    ...(options.mixin !== undefined ? { mixin: options.mixin } : {}),
    // Custom serializers — wraps pino's built-in serializers and
    // overrides the `err` serializer with our credential-stripping
    // implementation. Per Rule R2 (ST-047-AC4): this is the PRIMARY
    // defense against body-parser SyntaxError → err.body credential
    // leaks (path-based redaction cannot match substrings inside
    // string values, but a custom serializer can simply drop the
    // dangerous field).
    serializers: {
      // Spread pino's standard serializers (req, res, err defaults)
      // first, then OVERRIDE the err serializer with our hardened
      // version. The req/res serializers are kept as defaults because
      // they are well-tested and our redact paths cover their known
      // credential-bearing fields (headers.authorization, etc.).
      ...pino.stdSerializers,
      err: safeErrSerializer,
    },
    // Redaction allow-list. Pino redacts paths via the `paths` array
    // and replaces matching values with "[Redacted]" by default; the
    // `censor` option below sets a more explicit masked value so the
    // operator can tell at a glance that a credential WAS present in
    // the source object but was sanitised before emission.
    // Pino path syntax: bare keys MUST be valid identifiers; keys
    // containing hyphens or other special characters MUST use bracket
    // notation (e.g. `headers["set-cookie"]`). Top-level hyphenated
    // keys (such as a literal `set-cookie` field) are addressed via
    // `["set-cookie"]`. The wildcard `*.password` matches any
    // immediate child key named `password`.
    redact: {
      paths: [
        'password',
        '*.password',
        'req.body.password',
        'request.body.password',
        'body.password',
        'req.headers.authorization',
        'req.headers.Authorization',
        'request.headers.authorization',
        'request.headers.Authorization',
        'headers.authorization',
        'headers.Authorization',
        'Authorization',
        'authorization',
        'req.headers.cookie',
        'request.headers.cookie',
        'headers.cookie',
        'cookie',
        'res.headers["set-cookie"]',
        'response.headers["set-cookie"]',
        'headers["set-cookie"]',
        '["set-cookie"]',
        'credential',
        '*.credential',
        'credentials',
        '*.credentials',
        'apiKey',
        '*.apiKey',
        'api_key',
        '*.api_key',
        'idToken',
        '*.idToken',
        'sessionToken',
        '*.sessionToken',
        'bearer',
        '*.bearer',
        'token',
        '*.token',
        'access_token',
        '*.access_token',
        // ── ST-047-AC4 / Rule R2 — body-parser leak path defense.
        // The custom `err` serializer above strips `body` from every
        // serialized error object. These redact paths provide
        // belt-and-suspenders defense in case (a) a future code path
        // logs an error WITHOUT going through the err serializer
        // (e.g. logger.error({ payload: { body: "..." } })), or (b)
        // a downstream library spreads err properties into a different
        // top-level field. Pino's path matcher replaces the entire
        // value at the path with the censor — for a string field,
        // that means the whole string becomes "[Redacted]" rather
        // than leaking partial content.
        'err.body',
        'err.expose',
        'error.body',
        'error.expose',
        '*.err.body',
        '*.error.body',
      ],
      censor: '[Redacted]',
      remove: false,
    },
    // Pretty-print only in development. JSON in production / CI so
    // log aggregation can parse without a transformer.
    transport:
      process.env['NODE_ENV'] === 'development' && process.stdout.isTTY
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  };

  return pino(opts);
}
