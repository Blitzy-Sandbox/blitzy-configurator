/**
 * Correlation ID middleware.
 *
 * Per Constraint C5 (NON-NEGOTIABLE): every inbound request carries a
 * correlation ID that is stored in Node's AsyncLocalStorage so that
 * pino log records emitted during the request lifecycle automatically
 * include it, and so that any outbound HTTP call performed during the
 * request lifecycle can attach it as the `x-correlation-id` header.
 *
 * Behaviour contract:
 *   - If the inbound request includes an `x-correlation-id` header,
 *     that value is preserved verbatim (i.e. clients/proxies can
 *     correlate across services).
 *   - Otherwise a UUID v4 is generated and stored as the request's
 *     correlation ID.
 *   - The outbound response always echoes the correlation ID via the
 *     `x-correlation-id` header so clients/proxies can capture it.
 *
 * The AsyncLocalStorage instance is exported so any code path —
 * services, repositories, the pino logger's `mixin` — can read the
 * current request's correlation ID without threading it through every
 * function signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Per-request context that flows with `AsyncLocalStorage`.
 *
 * The `uid` field is reserved for the authenticated user identifier
 * once the session middleware (out of scope for Phase A) has
 * verified the inbound bearer token via `admin.auth().verifyIdToken`.
 * Per Rule R2, only `correlationId` and `uid` may appear as identity
 * fields in log records — credentials never appear in this struct.
 */
export interface CorrelationContext {
  correlationId: string;
  uid?: string;
}

/**
 * Singleton AsyncLocalStorage shared by the middleware, the pino
 * logger's mixin, and any outbound HTTP client interceptor that
 * wants to attach the correlation header.
 */
export const correlationStore = new AsyncLocalStorage<CorrelationContext>();

/**
 * Returns the current request's correlation ID, or `undefined` if
 * called outside of a request context (e.g. at process startup).
 */
export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore()?.correlationId;
}

/**
 * Express middleware factory. Returns a middleware function that
 * extracts (or generates) the correlation ID, stamps it on the
 * response, and runs the rest of the request handler chain inside
 * an `AsyncLocalStorage.run()` so downstream code can read the ID
 * via `currentCorrelationId()`.
 */
export function correlationMiddleware() {
  return function correlationHandler(req: Request, res: Response, next: NextFunction): void {
    // Header lookups in Express are case-insensitive and return
    // `string | string[] | undefined`. Reduce to a single string;
    // when an array slips through (rare; multi-header transports),
    // take the first value.
    const headerValue = req.header('x-correlation-id');
    const correlationId =
      typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : uuidv4();

    // Echo the ID on the response so clients/proxies can capture it
    // — the same header name in both directions.
    res.setHeader('x-correlation-id', correlationId);

    // Run the rest of the request inside the AsyncLocalStorage
    // scope. `next()` is called inside the `run` callback so that
    // every `await` inside subsequent middleware / route handlers
    // can read the correlation context via `currentCorrelationId`.
    correlationStore.run({ correlationId }, () => {
      next();
    });
  };
}

/**
 * pino mixin function that adds the current correlation ID (and uid
 * when authenticated) to every log record emitted during a request
 * lifecycle. Wire this into the pino logger options as
 * `{ mixin: pinoCorrelationMixin }`.
 */
export function pinoCorrelationMixin(): Record<string, string> {
  const ctx = correlationStore.getStore();
  if (ctx === undefined) {
    return {};
  }
  const fields: Record<string, string> = { correlationId: ctx.correlationId };
  if (ctx.uid !== undefined) {
    fields['uid'] = ctx.uid;
  }
  return fields;
}
