/**
 * Pino Structured Logger with Serializer Allow-List — Rule R2 / C5 / ST-047 / ST-049-AC2.
 *
 * Authority (verbatim from the Agent Action Plan):
 *   - §0.3.3 "New Files to Create — Backend":
 *       "backend/src/logging/pino.ts | Pino logger with redaction allow-list
 *        per Rule R2; serializer drops password, Authorization, credential,
 *        bearer-token-pattern fields"
 *   - §0.6.5 Track 1 Backend Observability (T1-D):
 *       "CREATE | backend/src/logging/pino.ts | Pino logger with serializer
 *        allow-list dropping password, Authorization, credential, bearer-pattern
 *        fields per Rule R2"
 *   - §0.8.1 Rule R2 (verbatim):
 *       "No credential material in logs. Log records MUST NOT contain
 *        passwords, bearer tokens, session tokens, or API keys. MUST enforce
 *        via pino serializer allow-list, not per-call discipline."
 *   - §0.2.2 C5 (verbatim):
 *       "Log records MUST contain only correlationId and uid as identity
 *        fields — passwords, bearer tokens, session tokens, and API keys
 *        MUST NEVER appear in any log record, enforced by a pino serializer
 *        allow-list (Rule R2) rather than ad-hoc per-call discipline."
 *   - ST-047-AC1: structured records carry timestamp, severity (debug|info|
 *       warn|error|fatal), event name, service identifier, correlation
 *       identifier in machine-parseable format.
 *   - ST-049-AC2: trace records include trace identifier, span identifier,
 *       and the correlation identifier from the structured logging contract.
 *
 * Design — Belt-and-Suspenders:
 *   1. PATH-BASED REDACTION (`redact.paths`) — pino's built-in path matcher
 *      replaces named credential fields with `[REDACTED]` so the field
 *      remains visible to debuggers (operationally useful for detecting
 *      attempts to log credentials) but the raw value never escapes.
 *   2. REQUEST-SERIALIZER ALLOW-LIST (`req` serializer) — total filter that
 *      drops every header NOT on the allow-list, defending against vendor-
 *      specific credential headers (e.g. x-firebase-auth, x-api-key) that
 *      may not be on the redact path list. This is the PRIMARY defense
 *      against header leakage.
 *
 * Forbidden patterns (per Agent Action Plan Phase 13):
 *   - DO NOT add `pino-pretty` as a runtime dependency — production logs are
 *     JSON consumed by Cloud Logging; local pretty printing is achieved via
 *     `npm run dev | pino-pretty` if desired.
 *   - DO NOT add per-call redaction (e.g. `logger.info({ password: '***' })`)
 *     — Rule R2 mandates redaction is a documented serializer property, not
 *     per-call discipline.
 *   - DO NOT add `hostname` or `pid` to `base` — `service` is sufficient
 *     identity and matches the OTel resource `service.name` and the prom-
 *     client `service` label.
 *   - DO NOT perform database lookups, async calls, or expensive computation
 *     inside the mixin — it runs per log record and MUST be fast.
 *   - DO NOT import from `./index`, any route, service, or repository —
 *     circular-dependency hazard. Imports limited to: `pino`,
 *     `@opentelemetry/api`, and `../middleware/correlation` (correlationStore).
 *   - DO NOT initialize the OTel SDK here — that lives in
 *     `backend/src/tracing.ts` (Rule R6).
 *   - DO NOT export `logger as default` — named export only.
 *   - DO NOT pass a custom `destination` in production — the default stdout
 *     destination integrates correctly with Cloud Run's log collector and
 *     `docker compose logs`.
 */

import pino, { type LoggerOptions } from 'pino';
import { trace, isSpanContextValid } from '@opentelemetry/api';

import { correlationStore } from '../middleware/correlation';

// ---------------------------------------------------------------------------
// Service-identity constants
// ---------------------------------------------------------------------------

/**
 * The `service` field value emitted on every log record.
 *
 * MUST equal:
 *   - The OTel resource `service.name` set in `backend/src/tracing.ts`
 *     (currently `'strikeforge-backend'`), so traces and logs share a
 *     dimension.
 *   - The prom-client `service` label set in `backend/src/routes/metrics.ts`
 *     (ST-048-AC2), so metrics and logs share a dimension.
 *
 * Cross-pillar correlation (trace → log → metric) breaks if these three
 * values diverge. Do NOT parameterize this — a single service identity is
 * intended for the StrikeForge backend.
 */
const SERVICE_NAME = 'strikeforge-backend';

/** Default log level when NODE_ENV=production. */
const DEFAULT_LOG_LEVEL_PROD = 'info';

/** Default log level for dev / test / CI environments. */
const DEFAULT_LOG_LEVEL_DEV = 'debug';

// ---------------------------------------------------------------------------
// Log level resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the active log level from the `LOG_LEVEL` environment variable
 * with a sensible default.
 *
 * `LOG_LEVEL` is intentionally NOT one of the six required env vars (Rule R4
 * — AAP §0.1.3); it has a documented safe default so the logger works even
 * when the variable is unset, and omitting it never triggers the fail-fast
 * startup path. The logger is a foundational primitive that needs to be
 * available BEFORE `validateEnv()` runs (so a Rule R4 failure can be logged).
 *
 * @returns A pino-recognized level token ('trace'|'debug'|'info'|'warn'|
 *   'error'|'fatal'|'silent'), or the operator-supplied override.
 */
function resolveLogLevel(): string {
  const override = process.env['LOG_LEVEL'];
  if (typeof override === 'string' && override.length > 0) {
    return override;
  }
  return process.env['NODE_ENV'] === 'production'
    ? DEFAULT_LOG_LEVEL_PROD
    : DEFAULT_LOG_LEVEL_DEV;
}

// ---------------------------------------------------------------------------
// Request-header allow-list — primary defense against header leakage
// ---------------------------------------------------------------------------

/**
 * Allow-list of request header keys that MAY appear in log records.
 *
 * Matching is case-insensitive (HTTP headers are case-insensitive per RFC
 * 7230 §3.2). All headers NOT on this list are DROPPED ENTIRELY by the
 * `req` serializer below — even if they are not on `redact.paths`.
 *
 * This set is deliberately minimal: only headers needed for debugging,
 * correlation, distributed tracing, and content negotiation. Any header
 * that could carry credential material (Authorization, Cookie, X-Api-Key,
 * X-Firebase-*, Proxy-Authorization, etc.) MUST NEVER be added here.
 *
 * Adding a new entry requires explicit Rule R2 review: the proposed header
 * MUST be a documented standard header carrying no credential or PII payload.
 */
const REQUEST_HEADER_ALLOW_LIST: ReadonlySet<string> = new Set([
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

/**
 * Return a new object containing ONLY headers on the allow-list.
 *
 * Exported so unit tests can verify the filter directly without going
 * through the full pino pipeline. The `ReadonlySet` provides O(1)
 * membership checking on the request hot path.
 *
 * @param headers The full request headers map (possibly undefined when
 *   `pino-http` serializes a request with no headers, or when the test
 *   harness invokes the serializer with a malformed shape).
 * @returns A shallow clone containing only allow-listed keys, with the
 *   original case preserved (Express normalizes inbound headers to
 *   lowercase, but Node's `http` server may emit either form depending
 *   on the source).
 */
export function allowListHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (headers === undefined || headers === null) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(headers)) {
    if (REQUEST_HEADER_ALLOW_LIST.has(key.toLowerCase())) {
      result[key] = headers[key];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Redact paths — secondary defense against named credential field leakage
// ---------------------------------------------------------------------------

/**
 * Paths redacted in every log record. Pino replaces the value at each
 * matching path with the censor string (`[REDACTED]`); the field itself
 * remains in the record so debuggers can still see that it was present.
 *
 * Wildcards cover ONE level of nesting only: `*.password` matches
 * `user.password` but NOT `user.auth.password`. For deeply nested request
 * headers, the `req` serializer's allow-list provides total filtering
 * regardless of depth.
 *
 * Both lowercase and TitleCase variants of HTTP header field names are
 * included because Node's `http` module sometimes preserves the original
 * casing (Express normalizes inbound, but res.setHeader / res.getHeaders
 * returns whatever case the application set).
 *
 * Adding a new path requires explicit Rule R2 review: every entry below
 * is documented as a known credential-bearing field name observed in
 * popular libraries, custom code, or the user-prompt threat model.
 */
const REDACT_PATHS: readonly string[] = [
  // Generic credential material — top-level (root) keys.
  'password',
  'passwordHash',
  'token',
  'sessionToken',
  'idToken',
  'accessToken',
  'refreshToken',
  'firebaseToken',
  'apiKey',
  'api_key',
  'credential',
  'credentialDigest',
  'secret',
  'bearer',

  // Generic credential material — one level deep (e.g. `user.password`,
  // `body.token`, `payload.apiKey`). The wildcard matcher walks ONE level
  // of nesting; deeper structures rely on the `req` serializer or on
  // explicit per-call discipline at the call site (which Rule R2 says
  // is not a substitute for serializer-level enforcement).
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.sessionToken',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  '*.firebaseToken',
  '*.apiKey',
  '*.api_key',
  '*.credential',
  '*.credentialDigest',
  '*.secret',
  '*.bearer',

  // HTTP header field names emitted directly (e.g. when a caller writes
  // `logger.info({ authorization: req.headers.authorization })` —
  // discouraged but defended). Note: pino redact paths require bracket
  // notation for keys containing hyphens (e.g. `set-cookie`); pino's
  // path validator rejects bare hyphenated identifiers.
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  '["set-cookie"]',
  '["Set-Cookie"]',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',

  // pino-http populates `req.headers` and `res.headers`. The req serializer
  // below defangs `req.headers`, but explicit redact paths cover `res.headers`
  // and provide belt-and-suspenders defense for `req.headers` in case a
  // future refactor weakens or removes the serializer.
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'res.headers["set-cookie"]',
  'res.headers["Set-Cookie"]',
];

// ---------------------------------------------------------------------------
// Error serializer — scalar-only allow-list, defends against pg.Client leak
// ---------------------------------------------------------------------------

/**
 * Maximum recursion depth followed when serialising an error's `.cause`
 * chain. Typical chains are 1-2 deep; the bound exists to defend against
 * a (pathological) self-referencing cause chain that would otherwise
 * recurse without bound.
 */
const ERR_CAUSE_MAX_DEPTH = 5;

/**
 * Custom error serializer used by the pino logger's `err` slot.
 *
 * Why custom rather than `pino.stdSerializers.err`:
 *   The canonical pino error serializer constructs its output as
 *     `{ type, message, stack, ...err }`
 *   — a spread of EVERY enumerable own property of the error instance.
 *   For ordinary `Error` and `Error`-subclass instances this is fine
 *   (the relevant own properties are the standard scalar fields), but
 *   third-party error classes routinely attach large internal-state
 *   objects as own properties. The most consequential offender in this
 *   backend is `pg.DatabaseError`: when the connection pool encounters a
 *   broken-connection or admin-shutdown error, the thrown error carries
 *   an `err.client` field referencing the entire `pg.Client` instance —
 *   sockets, type registries, the connection-parameters block (host,
 *   port, database, user), and the pg-protocol cancel `secretKey`. The
 *   `pino.stdSerializers.err` spread copies all of that into the log
 *   record, producing single records of ~4KB and disclosing internal
 *   database topology unnecessarily.
 *
 * Strategy:
 *   1. Pass through non-Error values unchanged (preserves pino's
 *      default no-op behaviour when something other than an Error is
 *      logged at the `err` slot).
 *   2. Always emit the canonical fields: `type` (constructor name),
 *      `message`, `stack`. The standard tooling shape stays intact.
 *   3. Include the own `name` field if present — `pg.DatabaseError`
 *      sets `name = 'error'` (lowercase, intentional), and other
 *      libraries similarly shadow `Error.prototype.name` with their own
 *      value; preserving it aids dashboard aggregations.
 *   4. Iterate every other own enumerable property and INCLUDE ONLY
 *      scalar primitives (`string`, `number`, `boolean`). Nested
 *      objects, arrays, and functions are silently dropped. This keeps
 *      pg-specific scalar metadata that is operationally useful for
 *      debugging — `code` (e.g. `'57P01'`, `'23505'`), `severity`
 *      (`'FATAL'`, `'ERROR'`, `'WARNING'`), `detail`, `hint`,
 *      `position`, `where`, `schema`, `table`, `column`, `dataType`,
 *      `constraint`, `file`, `line`, `routine`, `length` — without
 *      retaining the bloated `client`, `connection`, `_events`, or
 *      `_types` objects.
 *   5. Recursively process `err.cause` (Node 16.9+ error-cause chain)
 *      with a depth bound — typical chains are 1-2 deep and the bound
 *      defends against a pathological self-referencing cause.
 *
 * What is intentionally DROPPED, with rationale:
 *   - `err.client` (pg.DatabaseError) — internal `pg.Client` instance.
 *     ~4KB per error; reveals internal database topology and the
 *     pg-protocol cancel `secretKey`.
 *   - `err.connection` — internal pg connection state.
 *   - `err._events`, `err._eventsCount` — EventEmitter internals.
 *   - `err.body` — body-parser raw request bytes (already redacted
 *     upstream by `sanitiseBodyParserError`, but defence-in-depth
 *     drops any object-shaped body slipping past that middleware).
 *   - Any other nested object, array, or function value.
 *
 * What is preserved (scalar primitives only):
 *   - All standard `Error` fields (`type`, `message`, `stack`, `name`).
 *   - All scalar pg metadata (code, severity, detail, hint, position,
 *     where, schema, table, column, dataType, constraint, file, line,
 *     routine, length, internalPosition).
 *   - `err.cause` (recursed under the same allow-list).
 *
 * Rule R2 posture:
 *   This serializer's allow-list intentionally REJECTS object values
 *   wholesale. Even if a future library attaches a credential-bearing
 *   object as an enumerable own property of an error (e.g.
 *   `err.headers = { authorization: 'Bearer ...' }`), the scalar-only
 *   filter drops it before it reaches the log writer. The pino-options
 *   `redact.paths` array still applies on the OUTSIDE of the
 *   serializer's output for the same field names (e.g. an `err.code`
 *   value coincidentally named like a credential header would be
 *   redacted by the path matcher).
 *
 * Exported for unit-test surface only — the production code path
 * references this function via the `serializers.err` slot below.
 *
 * @param err The value passed by pino at the `err` slot of a log call.
 * @param depth Internal recursion depth tracker; callers MUST omit.
 * @returns A scalar-only projection of the error suitable for emission
 *          as a JSON log record.
 */
export function errSerializer(err: unknown, depth: number = 0): unknown {
  // Non-Error pass-through. Pino's default behaviour passes any
  // non-Error value at the `err` slot through unchanged; we preserve
  // that to avoid surprising callers that occasionally log non-Error
  // values (e.g., a string or a plain object) at the `err` slot.
  if (!(err instanceof Error)) {
    return err;
  }

  // Canonical pino error envelope — these three fields are what every
  // downstream tool expects.
  const result: Record<string, unknown> = {
    type: err.constructor.name,
    message: err.message,
    stack: err.stack,
  };

  // Preserve `name` if it's an own property (Error subclasses sometimes
  // shadow Error.prototype.name with their own value, e.g.
  // `pg.DatabaseError` sets `name = 'error'` lowercase as part of its
  // type discriminator). The `Object.prototype.hasOwnProperty.call`
  // form defends against the (uncommon) case of an Error subclass that
  // overrides `hasOwnProperty` itself.
  if (Object.prototype.hasOwnProperty.call(err, 'name')) {
    const ownName = (err as unknown as Record<string, unknown>)['name'];
    if (typeof ownName === 'string') {
      result['name'] = ownName;
    }
  }

  // Iterate every other own enumerable property; preserve only scalar
  // primitives. This is the single mechanism that keeps the bloated
  // `pg.DatabaseError.client` object (and analogous fields on other
  // libraries' error classes) out of log records.
  for (const key of Object.keys(err)) {
    // Skip fields already emitted above and the recursive `cause`
    // (handled separately below to allow controlled-depth recursion).
    if (key === 'message' || key === 'stack' || key === 'name' || key === 'cause') {
      continue;
    }
    const value = (err as unknown as Record<string, unknown>)[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      result[key] = value;
    }
  }

  // Handle the `error.cause` chain (Node 16.9+). Bounded recursion
  // protects against a pathological self-referencing cause chain that
  // would otherwise blow the call stack.
  if ('cause' in err) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined && depth < ERR_CAUSE_MAX_DEPTH) {
      result['cause'] = errSerializer(cause, depth + 1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pino options — exported for test parity
// ---------------------------------------------------------------------------

/**
 * Pino configuration applied to the application-wide `logger` constant.
 *
 * Exported so unit tests in `pino.test.ts` (and ad-hoc verification
 * harnesses) can build a capturing logger with the EXACT same redaction,
 * mixin, serializer, and formatter behaviour as production. Any drift
 * between test and production behaviour would leave Rule R2 verification
 * gaps; sharing the literal options object eliminates the drift surface.
 *
 * Members (per the file's export schema):
 *   - level         resolved by `resolveLogLevel()` from `LOG_LEVEL` env var
 *   - timestamp     ISO 8601 UTC via `pino.stdTimeFunctions.isoTime`
 *   - base          replaces pino's default `{ pid, hostname }` with `{ service }`
 *   - mixin         per-record dynamic fields: correlationId, uid, traceId, spanId
 *   - redact        path-based censoring of named credential fields
 *   - serializers   `req` allow-list filter, `res` minimal projection, `err` standard
 *   - formatters    string-token level output (debug|info|warn|error|fatal)
 */
export const pinoOptions: LoggerOptions = {
  // Active log level — see `resolveLogLevel()`.
  level: resolveLogLevel(),

  // ISO 8601 UTC timestamps. ST-047-AC1 requires a "machine-parseable
  // format"; ISO 8601 is the canonical choice for pino in production
  // (the default is epoch milliseconds, which is harder to eyeball
  // during incident response).
  timestamp: pino.stdTimeFunctions.isoTime,

  // `base` REPLACES pino's default `{ pid, hostname }`. Only `service` is
  // emitted as a base field; it matches the OTel resource `service.name`
  // (set in tracing.ts) and the prom-client `service` label (set in
  // routes/metrics.ts) so cross-pillar correlation works without
  // dimensional drift. `pid` and `hostname` are intentionally omitted —
  // they add noise without improving debuggability in a containerized
  // single-process deployment (Cloud Run launches one process per
  // container instance; the container ID is sufficient host identity).
  base: {
    service: SERVICE_NAME,
  },

  /**
   * Dynamic fields merged into every log record.
   *
   * Pino calls this mixin function ONCE per record before the record is
   * serialized. The function MUST be fast and allocation-conservative —
   * any latency here multiplies by the request log volume.
   *
   * Fields emitted:
   *   - `correlationId` — read from `correlationStore.getStore()`
   *     (AsyncLocalStorage populated by `middleware/correlation.ts` per
   *     Rule C5). Present on every record emitted DURING a request; absent
   *     during application startup (before the first request) and during
   *     background timers / signal handlers that have not entered an ALS
   *     frame.
   *   - `uid` — read from the same ALS store after `middleware/session.ts`
   *     mutates the in-place `{ correlationId }` object to add `.uid`
   *     post-`verifyIdToken`. Per ST-047-AC3 the authenticated request
   *     flow's logs carry the user identifier; per Rule R2 / C5 it is the
   *     ONLY identity field beyond `correlationId`.
   *   - `traceId` / `spanId` — read from the active OTel span via
   *     `trace.getActiveSpan()`. ST-049-AC2 mandates that traces and logs
   *     share trace and span identifiers so they can be joined by an
   *     observability backend (Cloud Trace, Tempo, Jaeger, etc.). Emitted
   *     ONLY when the span context is valid — `isSpanContextValid()`
   *     rejects the OTel no-op all-zeros context that would otherwise
   *     produce useless `'00000000000000000000000000000000'` traceId
   *     strings during application startup before OTel auto-instrumentation
   *     opens the first span.
   *
   * Field set is INTENTIONALLY MINIMAL per Rule R2 / C5: ONLY
   * `correlationId`, `uid`, `traceId`, `spanId`. No IP address, no
   * user-agent, no request route, no headers, no request ID beyond the
   * correlation ID. Any future field addition MUST be reviewed against
   * Rule R2 and the Observability Rule.
   */
  mixin: () => {
    const merged: Record<string, string> = {};

    // Correlation context — present during requests, absent during
    // startup and background timers. The optional-chain access avoids a
    // throw when the ALS frame is not active.
    const store = correlationStore.getStore();
    if (store !== undefined) {
      if (typeof store.correlationId === 'string' && store.correlationId.length > 0) {
        merged['correlationId'] = store.correlationId;
      }
      if (typeof store.uid === 'string' && store.uid.length > 0) {
        merged['uid'] = store.uid;
      }
    }

    // OpenTelemetry trace context — emitted only when the span context
    // is valid (rejects the OTel no-op all-zeros context). The
    // auto-instrumentation in tracing.ts opens spans on every inbound
    // HTTP request, so this is populated for every request log record;
    // it is absent for records emitted before the first request span
    // opens or after the last span closes.
    const activeSpan = trace.getActiveSpan();
    if (activeSpan !== undefined) {
      const spanContext = activeSpan.spanContext();
      if (isSpanContextValid(spanContext)) {
        merged['traceId'] = spanContext.traceId;
        merged['spanId'] = spanContext.spanId;
      }
    }

    return merged;
  },

  /**
   * Path-based redaction (Rule R2 — secondary defense layer).
   *
   * Pino walks each path on every log record and, on a match, replaces
   * the value at that path with the censor string. Wildcards (`*.x`)
   * cover one level of nesting only.
   *
   * `remove: false` is INTENTIONAL: keeping the field with a `[REDACTED]`
   * marker (rather than deleting it) preserves operationally useful
   * evidence that a credential field was present. An auditor can grep
   * for `[REDACTED]` to find code paths that attempted to log
   * credentials and remediate the call site. The trade-off is slightly
   * larger log payloads in pathological cases — acceptable in exchange
   * for the auditability gain.
   */
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
    remove: false,
  },

  /**
   * Per-type serializers.
   *
   * `req` — PRIMARY DEFENSE against header leakage. Returns a NEW object
   * containing ONLY `method`, `url`, and the allow-listed subset of
   * `headers`. Any header not on the allow-list is dropped entirely
   * (not just redacted) — this defends against vendor-specific
   * credential headers (e.g. x-firebase-auth, x-api-key) that may not
   * be on the redact path list. Notably, the request BODY, PARAMS, and
   * QUERY are NOT serialized: they routinely carry credentials
   * (password, token, apiKey) that the structured-redact layer cannot
   * reliably catch through nested wildcards.
   *
   * `res` — minimal projection: only `statusCode` is emitted. Response
   * headers (which can carry `Set-Cookie`) and response bodies are
   * dropped entirely.
   *
   * `err` — custom scalar-only error serializer (see {@link errSerializer}).
   * This serializer emits the canonical pino fields (`type`, `message`,
   * `stack`, `name`) plus an explicit allow-list of useful pg-error
   * scalar metadata (`code`, `severity`, `detail`, `hint`, etc.), and
   * DROPS every nested-object own property — most importantly the
   * `pg.DatabaseError.client` field, which carries the entire Client
   * instance (sockets, connection parameters, type registries, the
   * pg-protocol cancel `secretKey`) and bloats every connection-pool
   * error log to ~4KB. Using `pino.stdSerializers.err` would
   * spread-include all enumerable own properties via `...err`, which
   * leaks that internal state into logs.
   *
   * Body-parser `err.body` (raw JSON request body attached when parsing
   * fails) is still handled UPSTREAM in `backend/src/index.ts` via the
   * `sanitiseBodyParserError` middleware that runs before any error
   * reaches the logger; the present serializer is defence-in-depth in
   * case any parser regression slips an `err.body` past that middleware
   * (an object-typed `err.body` is dropped here regardless).
   *
   * The emitted shape (`type`, `message`, `stack`, plus scalar fields)
   * remains compatible with downstream tooling that consumes pino's
   * canonical error envelope (Cloud Logging, Sentry-compatible parsers).
   */
  serializers: {
    req: (req: { method?: string; url?: string; headers?: Record<string, unknown> }) => ({
      method: req.method,
      url: req.url,
      headers: allowListHeaders(req.headers),
    }),
    res: (res: { statusCode?: number }) => ({
      statusCode: res.statusCode,
    }),
    err: errSerializer,
  },

  /**
   * Format the level as a string token rather than pino's default
   * integer (10|20|30|40|50|60). ST-047-AC1 requires the severity be
   * "one of the enumerated tokens debug, info, warn, error, or fatal";
   * pino's default integer encoding violates this AC.
   *
   * Also serves dashboards / log aggregators that filter on the
   * literal level string (e.g. `severity:error`).
   */
  formatters: {
    level: (label) => ({ level: label }),
  },
};

// ---------------------------------------------------------------------------
// Application logger instance
// ---------------------------------------------------------------------------

/**
 * The single pino logger used throughout the StrikeForge backend.
 *
 * Usage conventions:
 *   - Every module that logs imports this `logger` directly:
 *       import { logger } from '../logging/pino';
 *   - `pino-http` (in `backend/src/index.ts`) wraps this logger to
 *     attach a request-scoped child at `req.log` on every Express
 *     request. INSIDE A REQUEST HANDLER, prefer `req.log` over this
 *     module-level reference so the correlation ID is captured
 *     automatically by the mixin running on the child.
 *   - Callers MUST provide an `event` field as the FIRST object key so
 *     dashboard panels and alert rules can filter on a stable
 *     identifier:
 *
 *       logger.info({ event: 'auth.login.success', uid }, 'User logged in');
 *       logger.error({ event: 'db.pool.error', err }, 'Pool error');
 *
 * The `event` field is the ST-047-AC1 "event name" requirement; it is
 * the operator-facing equivalent of an OTel span name and is how
 * incident-response dashboards group related records.
 *
 * No default export — named import is the documented pattern. The
 * Phase 13 anti-pattern list explicitly forbids a default export to
 * keep grep-ability high (`grep "import { logger }"` is unambiguous).
 */
export const logger = pino(pinoOptions);
