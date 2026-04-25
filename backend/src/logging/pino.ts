/**
 * Pino logger with serializer-driven redaction.
 *
 * Per Rule R2 (NON-NEGOTIABLE): log records MUST NOT contain
 * passwords, bearer tokens, session tokens, or API keys. Enforcement
 * is via pino's built-in `redact` paths (an allow-list of fields that
 * are masked or removed) — not via per-call discipline. This means
 * application code can safely log a request body / response object
 * and the logger will scrub credentials before emission.
 *
 * The redaction list below covers every credential surface that can
 * realistically appear in a log record:
 *   - `password` and `*.password`              (form bodies)
 *   - `Authorization` and `headers.Authorization`  (bearer / basic)
 *   - `authorization` and `headers.authorization`  (lowercase)
 *   - `cookie` / `headers.cookie`              (session tokens)
 *   - `set-cookie` / `headers.set-cookie`      (server-issued cookies)
 *   - `credential` / `*.credential`            (generic catchall)
 *   - `apiKey` / `*.apiKey`                    (provider keys)
 *   - `idToken` / `*.idToken`                  (Firebase IdToken)
 *   - `sessionToken` / `*.sessionToken`
 *   - `bearer` / `*.bearer`
 *   - `body.password`, `req.body.password`, `request.body.password`
 *
 * The Rule R2 user-supplied SENTINEL test ("SENTINEL_CRED_99" inside
 * a JSON `password` field MUST not appear in the logs) is satisfied
 * because the `password` path matches both the top-level and the
 * nested req.body.password locations.
 */

import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

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
   * threading. See `middleware/correlation.ts#pinoCorrelationMixin`.
   */
  mixin?: () => Record<string, unknown>;
}

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
