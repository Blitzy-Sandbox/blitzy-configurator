/**
 * Correlation ID Propagation Middleware — Rule C5
 *
 * Responsibilities:
 *   1. Extract the inbound `x-correlation-id` header (preserve verbatim).
 *   2. If absent (or empty / whitespace), generate a fresh UUID v4.
 *   3. Attach the correlation ID to `req.correlationId` for synchronous
 *      access inside route handlers.
 *   4. Echo the correlation ID on the response header `x-correlation-id`
 *      so clients can correlate their inbound and outbound IDs even when
 *      the request flow ends with an error response.
 *   5. Store the correlation ID in a module-scoped `AsyncLocalStorage` so
 *      every async continuation (`setTimeout`, `Promise.then`, `await`)
 *      can read it without explicit threading through function args.
 *   6. Monkey-patch `http.request`, `http.get`, `https.request`,
 *      `https.get` so every outbound HTTP call automatically carries
 *      the correlation ID header. This is the Rule C5 "every outbound
 *      HTTP client call MUST attach the correlation ID" enforcement
 *      point — it covers Firebase Admin SDK, @google-cloud/storage, and
 *      any direct outbound traffic from application code that uses the
 *      `node:http` / `node:https` core modules.
 *   7. Monkey-patch `globalThis.fetch` so every outbound `fetch()` call
 *      ALSO carries the correlation ID header. Node 20 LTS's global
 *      `fetch` is built on undici and bypasses `node:http` entirely —
 *      without this patch, fetch-based outbound calls (notably the
 *      Firebase Auth REST adapter in `auth/firebase-rest.ts`) would
 *      escape the C5 contract. Both transports are patched independently
 *      so the C5 invariant ("every outbound HTTP client call MUST attach
 *      the correlation ID") holds for the entire backend regardless of
 *      which client library a service chooses.
 *
 * Rule R2 compliance:
 *   The ALS store's shape (`CorrelationContext`) is strictly
 *   `{ correlationId, uid? }`. Pino's serializer allow-list (defined in
 *   `../logging/pino.ts`) ensures no other fields leak into log records.
 *   This file never reads, writes, or logs any credential material.
 *
 * Rule C4/R6 compatibility:
 *   The http/https patches coexist with OpenTelemetry auto-instrumentation.
 *   OTel's http patches are installed during `tracing.ts` bootstrap (which
 *   runs BEFORE this module loads per `index.ts` composition). When this
 *   module loads, `http.request` already points to OTel's wrapper; we
 *   capture that reference and layer our correlation-injection wrapper on
 *   top. Outbound requests therefore receive both `x-correlation-id`
 *   (this layer) and `traceparent` (OTel's layer).
 *
 * Authority:
 *   - AAP §0.8.1 Rule C5 (verbatim) — generate-or-preserve correlation
 *     ID, AsyncLocalStorage, pino hook, outbound header propagation.
 *   - ST-047-AC2 — correlation identifier generated at request boundary
 *     when absent, preserved when present, forwarded downstream.
 *   - ST-026-AC3 — protected handlers receive authenticated user identity
 *     attached to request context (the `uid` field on the ALS store is
 *     populated by `./session.ts` after token validation).
 *   - ST-049-AC1/AC2 — correlation ID rides alongside W3C `traceparent`
 *     in every outbound call; trace records and log records share the
 *     same correlation identifier so traces and logs can be joined.
 *
 * Forbidden patterns (per AAP Phase 12):
 *   - DO NOT import from `../logging/pino` (would create a circular
 *     dependency: pino reads `correlationStore` from this module).
 *   - DO NOT import any auth/JWT library (Rule R3).
 *   - DO NOT use `correlationStore.enterWith()` — it leaks across async
 *     boundaries in older Node releases. Use `.run()` exclusively.
 *   - DO NOT read `process.env.*` (Rule R4 — env validation is owned by
 *     `config/env.ts`; this module is consumer of nothing).
 *   - DO NOT overwrite an explicit caller-provided `x-correlation-id` on
 *     an outbound request (caller's intent wins).
 *   - DO NOT throw from the http-patch wrapper on a malformed argument
 *     list — silently delegate to the original implementation so a
 *     telemetry bug never breaks application I/O.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { v4 as uuidv4 } from 'uuid';

// `Request` from `express` is aliased to `ExpressRequest` to avoid
// shadowing the global WHATWG `Request` constructor (Node 20 `fetch`
// global), which is referenced as a value at the fetch-wrapper site
// below (e.g. `input instanceof Request`). Without the alias, the
// type-only import name `Request` shadows the global value, producing
// `@typescript-eslint/consistent-type-imports` "Type import 'Request'
// is used by decorator metadata" diagnostics. Aliasing keeps the
// Express type usable at the middleware boundary while leaving the
// global `Request` constructor visible to the fetch wrapper below.
import type {
  Request as ExpressRequest,
  Response,
  NextFunction,
  RequestHandler,
} from 'express';

// ---------------------------------------------------------------------------
// Express request augmentation
// ---------------------------------------------------------------------------
// `req.correlationId` is set by `correlationMiddleware`; `req.uid` is set by
// `./session.ts` after `admin.auth().verifyIdToken()` succeeds. TypeScript's
// declaration merging combines both augmentations idempotently — multiple
// modules declaring the same `Express.Request` interface produces a single
// merged type with the union of all members.
//
// The `eslint-disable-next-line` is necessary because
// `@typescript-eslint/no-namespace` flags `namespace` declarations by
// default, but `declare global { namespace Express { ... } }` is the
// canonical Express type-augmentation pattern documented in
// `@types/express`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** RFC 4122 UUID v4 unless the caller supplied one via header. */
      correlationId?: string;
      /** Firebase `uid`, set by session middleware after token verification. */
      uid?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The correlation context carried through a single request's async lifecycle.
 *
 * Per Rule C5 / Rule R2: log records MUST contain only `correlationId` and
 * `uid` as identity fields. This interface IS that contract — adding any
 * field here would propagate it into every log record via the pino mixin
 * that consumes this store, potentially leaking credential material. Any
 * future field addition MUST be reviewed against Rule R2.
 *
 * Mutation pattern:
 *   - `correlationMiddleware` initialises the store with `{ correlationId }`.
 *   - `sessionMiddleware` mutates the SAME store object in-place to add
 *     `uid` after `verifyIdToken` succeeds. The mutation is visible to all
 *     async continuations in the same request because `AsyncLocalStorage`
 *     stores object references (not snapshots).
 */
export interface CorrelationContext {
  correlationId: string;
  uid?: string;
}

// ---------------------------------------------------------------------------
// Module-scoped ALS instance
// ---------------------------------------------------------------------------

/**
 * Singleton AsyncLocalStorage holding the per-request `CorrelationContext`.
 *
 * EXPORTED so:
 *   - `../logging/pino.ts` can read it via a mixin function attached to
 *     pino's `mixin` option.
 *   - `./session.ts` can mutate it to add `uid` after authentication.
 *   - `../routes/*.ts` handlers and any `../services/*.ts` callable can
 *     read the current correlation ID without parameter threading.
 *
 * Every inbound request enters the store via `correlationStore.run(ctx, cb)`
 * inside `correlationMiddleware`. The store object reference is stable for
 * the duration of the request callback's async continuation; mutations to
 * `.uid` are visible to all later continuations in the same request.
 *
 * PROCESS-SHARED SINGLETON (anchored on `http`) — RATIONALE:
 *
 * The bare `new AsyncLocalStorage<CorrelationContext>()` form would create a
 * fresh ALS instance per CommonJS module evaluation. Under `jest.resetModules`
 * — and, more importantly, under Jest's per-test-file fresh module registry
 * (each test file gets its own `Module` cache by design) — re-evaluating this
 * file produces a brand-new ALS instance. That alone would be benign, EXCEPT
 * that the `patchHttpModule` block lower in this file installs `Symbol.for`-
 * keyed sentinels on the GLOBAL `node:http` and `node:https` modules. Those
 * sentinels are registered exactly once per Node process (the http/https
 * core modules are interned by Node), so the first test file's wrappers —
 * which close over THAT file's ALS instance — remain installed for the
 * lifetime of the worker. Subsequent test files create their own ALS
 * instance, run middleware against that instance, but the http/https
 * wrappers (still pointing at the FIRST file's ALS) read from the wrong
 * store. Net effect: outbound `x-correlation-id` injection breaks across
 * suite boundaries (cross-suite state leak — ST-044-AC2 violation).
 *
 * Empirical sandboxing-model finding (verified by adhoc Jest tests):
 *
 *   Object                      | Default-import (`import x from`)  | Cross-test-file shared?
 *   ----------------------------|-----------------------------------|------------------------
 *   `node:http` core module     | YES — `import http from 'node:http'`  | YES (process singleton)
 *   `node:async_hooks` class    | YES — `import {AsyncLocalStorage}`    | YES (process singleton)
 *   `globalThis`                | n/a (intrinsic)                       | NO — per-Jest-VM
 *   `process`                   | n/a (intrinsic)                       | NO — Jest replaces per VM
 *
 *   The first attempt at this fix used `globalThis[Symbol.for(...)]`, which
 *   would have been correct in a non-Jest runtime. In Jest with
 *   `testEnvironment: 'node'`, however, each test file runs inside its own
 *   `vm.createContext` sandbox with its own globalThis. `Symbol.for(name)` IS
 *   shared across sandboxes (V8 engine-level intern), but the storage object
 *   is not. Storing the ALS on globalThis therefore reproduced the same
 *   per-file-fresh-instance problem the fix was supposed to solve.
 *
 *   The correct fix anchors the singleton on a process-shared object. The
 *   `http` core module is the natural choice because (a) it's already where
 *   the existing `__blitzy_correlation_http_patched__` sentinel lives, and
 *   (b) the http patches close over the ALS — keeping the ALS on the same
 *   object the patches mutate ensures both stay in lock-step. `import http
 *   from 'node:http'` (default import) returns the same object across all
 *   Jest test files in the same worker (verified empirically), so the
 *   Symbol.for-keyed property is genuinely shared.
 *
 *   Both the http patches (installed by file A) and the middleware logic
 *   (run by file B) target the SAME store. This restores the original spec
 *   invariant that "the store object reference is stable" across the
 *   entire process.
 *
 * The `Symbol.for` registry approach is preferred over a string-keyed property
 * on `http` because the former cannot collide with arbitrary user code or
 * third-party modules walking `http` keys; symbols are non-enumerable in the
 * default `Object.keys` traversal.
 */
const CORRELATION_STORE_SENTINEL: unique symbol = Symbol.for(
  '__blitzy_correlation_store__',
) as never;
// Anchor the singleton on the process-shared `http` core-module object.
// `import http from 'node:http'` is a default import; per TypeScript CJS
// interop this resolves to the require()'d module object (the same object
// across all Jest test-file sandboxes in the worker). This makes the
// Symbol-keyed property genuinely process-singleton, unlike a globalThis-
// keyed property which is per-Jest-VM-context.
const __httpForStore = http as unknown as Record<
  symbol,
  AsyncLocalStorage<CorrelationContext> | undefined
>;
if (__httpForStore[CORRELATION_STORE_SENTINEL] === undefined) {
  __httpForStore[CORRELATION_STORE_SENTINEL] =
    new AsyncLocalStorage<CorrelationContext>();
}
export const correlationStore: AsyncLocalStorage<CorrelationContext> =
  __httpForStore[CORRELATION_STORE_SENTINEL] as AsyncLocalStorage<CorrelationContext>;

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------
//
// The inbound, outbound, and response header all use the same canonical
// name `x-correlation-id`. The fallback inbound header `x-request-id` is a
// widely-used legacy alias propagated by load balancers and ingress
// controllers (Heroku Router, some nginx configurations, AWS ALB). Falling
// back preserves continuity with upstream systems that already mint a
// request ID; if neither header is present, we generate our own.
//
// Header lookups in Express's `req.headers` are LOWERCASE (Express
// normalises every inbound header to lowercase regardless of the wire
// case), so we use lowercase constants here.
const INBOUND_HEADER = 'x-correlation-id';
const FALLBACK_INBOUND_HEADER = 'x-request-id';
const RESPONSE_HEADER = 'x-correlation-id';
const OUTBOUND_HEADER = 'x-correlation-id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an Express header value (`string | string[] | undefined`) into a
 * single trimmed string, or `undefined` if no usable value is present.
 *
 * Handling rules:
 *   - `undefined` / `null`: absent.
 *   - Empty string / whitespace-only string: treated as absent. (Prevents
 *     a buggy or malicious upstream from suppressing correlation IDs by
 *     sending an empty header — we ALWAYS generate a fresh UUID in that
 *     case.)
 *   - Array form (RFC 7230 duplicate headers): take the FIRST element.
 *     This matches Express's own behaviour when calling `req.header(name)`
 *     and the conventional handling of duplicate headers.
 *   - Non-string entries in arrays / non-string values are rejected
 *     defensively.
 */
function coerceToString(headerValue: string | string[] | undefined): string | undefined {
  if (headerValue === undefined || headerValue === null) {
    return undefined;
  }
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

/**
 * Read the inbound correlation ID from the primary header, with fallback
 * to the legacy `x-request-id` header. Either may be absent; if both are
 * absent, returns `undefined` and the caller generates a new UUID.
 */
function readInboundCorrelationId(
  primary: string | string[] | undefined,
  fallback: string | string[] | undefined,
): string | undefined {
  const fromPrimary = coerceToString(primary);
  if (fromPrimary !== undefined) {
    return fromPrimary;
  }
  const fromFallback = coerceToString(fallback);
  return fromFallback;
}

/**
 * Generate a new correlation ID. Uses RFC 4122 UUID v4 per Rule C5.
 *
 * The `uuid` package's `v4` function is the canonical, well-tested path;
 * pinned at `^9.0.1` in `backend/package.json`. We use it rather than
 * `crypto.randomUUID()` because the AAP §0.4.1 dependency inventory names
 * `uuid` explicitly — keeping a single well-tested code path over the
 * Node-built-in alternative.
 */
function generateCorrelationId(): string {
  return uuidv4();
}

/**
 * Public helper: read the current correlation ID from the active ALS
 * context. Returns `undefined` when called outside any request context
 * (e.g., during application startup, in a background timer, or from a
 * caller that never entered the ALS frame).
 *
 * Callers in those contexts that need a correlation ID for a synthetic
 * outbound call MUST generate their own UUID — they cannot rely on this
 * helper to produce a default.
 */
export function getCorrelationId(): string | undefined {
  return correlationStore.getStore()?.correlationId;
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that establishes the correlation context for the
 * request.
 *
 * This is a DIRECT middleware (NOT a factory): use it as
 *   `app.use(correlationMiddleware)`
 *
 * It MUST be applied BEFORE any logging middleware (e.g. `pino-http`) in
 * the middleware chain so that every log record emitted during the request
 * lifecycle carries the correlation ID via the pino mixin.
 *
 * Behaviour:
 *   1. Read `x-correlation-id` (or `x-request-id` fallback) from the
 *      request headers, treating empty values as absent.
 *   2. If present, preserve verbatim; if absent, generate a UUID v4.
 *   3. Attach to `req.correlationId` for synchronous handler access.
 *   4. Set the response header `x-correlation-id` (via `setHeader`).
 *      This happens BEFORE the response is written so even error
 *      responses (4xx, 5xx, thrown errors) carry the correlation ID for
 *      debugging.
 *   5. Enter `correlationStore.run({ correlationId }, () => next())` so
 *      every async continuation in the request lifecycle can read the
 *      context.
 *
 * Why `.run()` and not `.enterWith()`:
 *   - `.run()` creates a tidy ALS frame that auto-exits when the callback
 *     returns. The frame is reference-counted across async continuations.
 *   - `.enterWith()` leaks across unrelated async boundaries in older
 *     Node versions and is harder to reason about. Always prefer `.run()`.
 *
 * Why DIRECT (not factory):
 *   - This middleware has no external dependencies to inject — the
 *     `correlationStore` is module-scoped. Contrast with
 *     `sessionMiddleware({ sessionService })` which IS a factory because
 *     it depends on a service instance.
 */
export const correlationMiddleware: RequestHandler = function correlationMiddleware(
  req: ExpressRequest,
  res: Response,
  next: NextFunction,
): void {
  // ----- Step 1: Determine the correlation ID -----------------------------
  const inbound = readInboundCorrelationId(
    req.headers[INBOUND_HEADER],
    req.headers[FALLBACK_INBOUND_HEADER],
  );

  const correlationId: string = inbound ?? generateCorrelationId();

  // ----- Step 2: Attach to the request object for synchronous access -----
  req.correlationId = correlationId;

  // ----- Step 3: Echo on the response header -----------------------------
  // `res.setHeader` (rather than Express's `res.header` alias) is the
  // lower-level, well-specified method that works in any Node HTTP server
  // context. Setting the header before `next()` runs guarantees error
  // responses also carry the correlation ID — a 500 without a correlation
  // ID is nearly impossible to debug; a 500 WITH one lets operators find
  // the matching log entries.
  res.setHeader(RESPONSE_HEADER, correlationId);

  // ----- Step 4: Enter the ALS context, then delegate to next() ----------
  // `.run(ctx, cb)` creates a fresh ALS frame that persists for the
  // duration of `cb`'s async continuations. The store object is
  // intentionally a fresh `{ correlationId }` so subsequent middleware
  // (specifically `./session.ts`) can mutate `.uid` in-place after token
  // verification without colliding with other requests.
  const context: CorrelationContext = { correlationId };
  correlationStore.run(context, () => {
    next();
  });
};

// ---------------------------------------------------------------------------
// Outbound HTTP correlation injection
// ---------------------------------------------------------------------------

/**
 * Given the variadic argument list of an `http.request` / `http.get` call,
 * locate the options object and ensure its `headers` property includes the
 * correlation ID.
 *
 * Node's `http.request` signature variants:
 *   - `request(options[, callback])`
 *     where `options` is `RequestOptions | string | URL`
 *   - `request(url[, options][, callback])`
 *     where `url` is `string | URL`
 *
 * Strategy:
 *   - Iterate `args`; the first non-function, non-string, non-URL object
 *     is the options object.
 *   - If no options object is found, construct one and insert it after
 *     the URL argument(s) — Node's `request` accepts the synthetic
 *     options seamlessly.
 *   - Ensure `options.headers` exists and is an object.
 *   - If a header key matching `x-correlation-id` (case-insensitive)
 *     already exists, preserve the caller's explicit value (NEVER
 *     overwrite — caller intent always wins).
 *
 * Mutates `args` in-place. Exported for unit-test introspection (the `_`
 * prefix signals "intended for tests / internal use"). Tests can call it
 * directly without going through `http.request`, providing a pure-function
 * surface for the outbound-propagation contract.
 */
export function _injectCorrelationHeaderIntoArgs(args: unknown[], correlationId: string): void {
  // Step 1: locate the existing options object, if any.
  let optionsIndex = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg === 'function') continue;
    if (typeof arg === 'string') continue;
    if (arg instanceof URL) continue;
    if (arg !== null && typeof arg === 'object') {
      optionsIndex = i;
      break;
    }
  }

  // Step 2a: no options object — synthesise one positioned after any URL
  // arguments. Node's `request(url, options, callback)` accepts a synthetic
  // options object inserted between the URL and any trailing callback.
  if (optionsIndex === -1) {
    let insertAt = 0;
    while (
      insertAt < args.length &&
      (typeof args[insertAt] === 'string' || args[insertAt] instanceof URL)
    ) {
      insertAt += 1;
    }
    args.splice(insertAt, 0, {
      headers: { [OUTBOUND_HEADER]: correlationId },
    });
    return;
  }

  // Step 2b: existing options object — ensure `headers` exists and add the
  // correlation header if not already present.
  const options = args[optionsIndex] as Record<string, unknown>;
  if (options.headers === undefined || options.headers === null) {
    options.headers = {};
  }
  if (typeof options.headers !== 'object') {
    // Headers is a non-object (e.g. a string — which Node would reject
    // anyway). Defensively skip injection rather than coerce, so we
    // never break a request that would have failed on Node's own
    // validation path.
    return;
  }
  const headers = options.headers as Record<string, unknown>;

  // Case-insensitive existence check. Node accepts request headers in any
  // case and normalises them later; an explicit caller-set `X-Correlation-Id`
  // (any case) MUST win over our default.
  const hasCorrelation = Object.keys(headers).some((key) => key.toLowerCase() === OUTBOUND_HEADER);

  if (!hasCorrelation) {
    headers[OUTBOUND_HEADER] = correlationId;
  }
}

/**
 * Monkey-patch a Node http-like module's `request` and `get` functions so
 * outbound calls from within an ALS context automatically carry the
 * correlation header.
 *
 * Coexistence note (Rule C4/R6):
 *   Because `tracing.ts` runs BEFORE this module via the `index.ts` import
 *   order, when we capture the "current" `request` function here it's
 *   already OTel's wrapper. We wrap on top, producing a call chain:
 *     caller → our wrapper → OTel wrapper → Node's native request
 *   Outbound requests therefore receive both `x-correlation-id` (this
 *   layer) and `traceparent` (OTel's layer).
 *
 * Error handling: a `try { ... } catch {}` around the injection logic is
 * intentional. If something in our injection logic throws (e.g., a
 * pathological options argument), we MUST NOT break outbound HTTP calls.
 * Production reliability trumps perfect telemetry — a missing correlation
 * header is a debugging nuisance; a thrown exception in `http.request` is
 * a service outage.
 */
function patchHttpModule(mod: typeof http | typeof https): void {
  const originalRequest = mod.request;
  const originalGet = mod.get;

  function wrappedRequest(this: unknown, ...args: unknown[]): http.ClientRequest {
    try {
      const ctx = correlationStore.getStore();
      if (ctx?.correlationId !== undefined) {
        _injectCorrelationHeaderIntoArgs(args, ctx.correlationId);
      }
    } catch {
      // Swallow — never let a patch failure break an outbound HTTP call.
    }
    return (originalRequest as (...a: unknown[]) => http.ClientRequest).apply(this, args);
  }

  function wrappedGet(this: unknown, ...args: unknown[]): http.ClientRequest {
    try {
      const ctx = correlationStore.getStore();
      if (ctx?.correlationId !== undefined) {
        _injectCorrelationHeaderIntoArgs(args, ctx.correlationId);
      }
    } catch {
      // Swallow.
    }
    return (originalGet as (...a: unknown[]) => http.ClientRequest).apply(this, args);
  }

  // Preserve function name metadata so debugger / profiler tooling still
  // shows `request` / `get` as the function names rather than the inner
  // wrapper names.
  Object.defineProperty(wrappedRequest, 'name', { value: 'request' });
  Object.defineProperty(wrappedGet, 'name', { value: 'get' });

  // Replace the exports. The cast routes around the read-only declarations
  // in `@types/node`; runtime reassignment is fully supported by Node's
  // module loader and is the documented pattern used by OTel's
  // auto-instrumentation as well.
  (mod as unknown as { request: typeof wrappedRequest }).request = wrappedRequest;
  (mod as unknown as { get: typeof wrappedGet }).get = wrappedGet;
}

// ---------------------------------------------------------------------------
// Outbound fetch correlation injection (undici / WHATWG fetch)
// ---------------------------------------------------------------------------
//
// QA finding (Final F, Issue #1, MAJOR — Constraint C5 partial violation):
//   tcpdump captures during the login flow showed the Firebase REST
//   adapter's outbound call to
//   `/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
//   carried `traceparent` (via OTel auto-instrumentation of undici) but
//   NOT `x-correlation-id` — because Node 20's global `fetch` is
//   implemented on top of undici and bypasses `node:http` / `node:https`
//   entirely. The http/https monkey-patches above therefore do NOT cover
//   fetch-based outbound calls. The C5 invariant "every outbound HTTP
//   client call MUST attach the correlation ID" was violated for the
//   single most security-relevant outbound call in the system.
//
// Resolution:
//   Wrap `globalThis.fetch` with a thin correlation-injecting layer that
//   mirrors the http patch's contract:
//     - Read the active correlation ID from the ALS store; if no frame
//       is active, no-op (no header attached).
//     - Locate / synthesise a `Headers`-shaped value on `init`.
//     - Skip injection if the caller explicitly supplied an
//       `x-correlation-id` header (case-insensitive). Caller intent
//       always wins.
//     - Otherwise, attach the correlation ID and forward to the
//       underlying fetch implementation unchanged.
//   Wrap fetch in try/catch so any pathological argument NEVER breaks
//   the underlying request — exactly as the http patch does.

/**
 * The minimal subset of the `fetch` Headers parameter we need to support.
 *
 * The fetch standard accepts three shapes:
 *   - A `Headers` instance.
 *   - An array of `[name, value]` tuples (`[string, string][]`).
 *   - A plain object with string-or-string-array values (record form).
 *
 * Our injection logic handles all three by upgrading the value to a
 * `Headers` instance whenever needed (the standard's algorithm constructs
 * a `Headers` internally anyway, so this matches its observable behaviour).
 */
type FetchHeadersLike = Headers | [string, string][] | Record<string, string | string[]>;

/**
 * Case-insensitive existence check on a fetch-compatible headers value.
 *
 * Returns `true` if the headers already declare an `x-correlation-id` (in
 * any case) so the caller's explicit value is preserved. The check covers
 * all three input shapes the fetch standard supports.
 */
function fetchHeadersHasCorrelation(headers: FetchHeadersLike | undefined): boolean {
  if (headers === undefined || headers === null) {
    return false;
  }
  // `Headers` has `.has()` which is case-insensitive by spec.
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.has(OUTBOUND_HEADER);
  }
  if (Array.isArray(headers)) {
    return headers.some(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        entry[0].toLowerCase() === OUTBOUND_HEADER,
    );
  }
  if (typeof headers === 'object') {
    return Object.keys(headers as object).some(
      (key) => key.toLowerCase() === OUTBOUND_HEADER,
    );
  }
  return false;
}

/**
 * Attach `x-correlation-id` to a fetch-compatible headers value, returning
 * the (possibly new) headers value. Pure: never mutates the caller-supplied
 * object beyond well-defined `Headers.set` / array push / property write.
 *
 * The return value is whichever shape the caller passed in, so the resulting
 * `init.headers` is structurally compatible with anything fetch already
 * accepts. When `headers` is `undefined`, we synthesise a plain record (the
 * least-surprising default — matches what most callers pass).
 */
function fetchHeadersWithCorrelation(
  headers: FetchHeadersLike | undefined,
  correlationId: string,
): FetchHeadersLike {
  // No headers supplied → synthesise a plain record. We DO NOT use a
  // `Headers` instance here because the global `Headers` constructor is
  // present in Node 20 LTS but creating one always allocates more than a
  // simple object literal; plain records are valid `RequestInit.headers`.
  if (headers === undefined || headers === null) {
    return { [OUTBOUND_HEADER]: correlationId };
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.set(OUTBOUND_HEADER, correlationId);
    return headers;
  }
  if (Array.isArray(headers)) {
    headers.push([OUTBOUND_HEADER, correlationId]);
    return headers;
  }
  if (typeof headers === 'object') {
    (headers as Record<string, string>)[OUTBOUND_HEADER] = correlationId;
    return headers;
  }
  // Non-object, non-array, non-Headers value (e.g. a string). The fetch
  // standard would reject this and throw `TypeError`; we defensively skip
  // injection rather than coerce, so we never break a request that would
  // have failed on fetch's own validation path.
  return headers;
}

/**
 * Pure helper: given the variadic argument list of a `fetch(input, init?)`
 * call and an active correlation ID, return a NEW `init` object with the
 * correlation header attached.
 *
 * Input shapes handled:
 *   - `fetch(string)`                — no init; we synthesise one with
 *                                       headers carrying the correlation ID.
 *   - `fetch(string, init)`          — extend `init.headers`.
 *   - `fetch(URL)`                   — same as string-input case.
 *   - `fetch(URL, init)`             — extend `init.headers`.
 *   - `fetch(Request)`               — Request objects already encapsulate
 *                                       headers; we MUST NOT mutate the
 *                                       Request (it may be in use elsewhere).
 *                                       Instead we synthesise an `init` with
 *                                       headers carrying ONLY the correlation
 *                                       ID — the underlying fetch then merges
 *                                       this with the Request's own headers.
 *   - `fetch(Request, init)`         — extend the supplied `init`.
 *
 * Returns the NEW init object that the caller MUST forward to the original
 * fetch implementation as its second argument. Never mutates the input
 * `init` if the input has an own `headers` property of `Headers` type — the
 * mutation through `Headers.set` is observable on the input only because
 * the headers ARE the storage; the spec considers this acceptable since
 * the `Headers` instance was supplied explicitly to fetch and is therefore
 * owned by the call.
 *
 * Skips injection (returns `init` unchanged or a synthesised init without
 * the correlation header) if the caller supplied an explicit
 * `x-correlation-id` header — caller intent always wins.
 *
 * Exported for unit-test introspection (the `_` prefix signals "intended
 * for tests / internal use"). Tests can call it directly without going
 * through the global fetch, providing a pure-function surface for the
 * outbound-propagation contract.
 */
export function _injectCorrelationHeaderIntoFetchInit(
  input: unknown,
  init: unknown,
  correlationId: string,
): unknown {
  // If the caller supplied an init with an explicit x-correlation-id
  // (any case), preserve their intent — return init unchanged.
  if (init !== undefined && init !== null && typeof init === 'object') {
    const initObj = init as { headers?: FetchHeadersLike };
    if (fetchHeadersHasCorrelation(initObj.headers)) {
      return init;
    }
  }

  // If the caller supplied a Request as `input` and that Request already
  // has the correlation header set on its own headers object, preserve
  // their intent — leave init untouched (we still pass it through).
  if (
    typeof Request !== 'undefined' &&
    input !== null &&
    typeof input === 'object' &&
    input instanceof Request
  ) {
    if (input.headers.has(OUTBOUND_HEADER)) {
      return init;
    }
  }

  // No explicit caller header — inject. Build (or extend) init.
  if (init === undefined || init === null) {
    return {
      headers: { [OUTBOUND_HEADER]: correlationId },
    };
  }
  if (typeof init !== 'object') {
    // Non-object init (e.g. a string passed by mistake). The fetch
    // standard would reject this; defensively pass through unchanged.
    return init;
  }

  const initObj = init as { headers?: FetchHeadersLike };
  initObj.headers = fetchHeadersWithCorrelation(initObj.headers, correlationId);
  return init;
}

/**
 * Monkey-patch `globalThis.fetch` so outbound calls from within an ALS
 * context automatically carry the correlation header.
 *
 * Coexistence with OTel undici instrumentation:
 *   `@opentelemetry/auto-instrumentations-node` includes
 *   `@opentelemetry/instrumentation-undici`, which patches undici's
 *   internal dispatcher to attach the W3C `traceparent` header. That
 *   patching layer operates BELOW the public fetch surface (at undici's
 *   request-dispatch boundary) and is independent of fetch wrapping at
 *   the public surface. Both layers therefore coexist: a single outbound
 *   `fetch()` call carries `x-correlation-id` (this layer) and
 *   `traceparent` (OTel's undici layer) without interference.
 *
 * Error handling: a `try { ... } catch {}` around the injection logic is
 * intentional. If something in our injection logic throws (e.g., a
 * pathological arguments object), we MUST NOT break outbound fetch calls.
 * Production reliability trumps perfect telemetry — a missing correlation
 * header is a debugging nuisance; a thrown exception in `fetch` is a
 * service outage.
 *
 * Idempotency: the caller is responsible for ensuring this function runs
 * exactly once per process via the sentinel block below. Re-running
 * unconditionally would compound wrapper layers indefinitely on every
 * `jest.resetModules()` call.
 */
function patchFetch(): void {
  // `globalThis.fetch` may be undefined in extremely old Node versions;
  // guard so the patch is a strict no-op when fetch is not present
  // (preserves backward compatibility — though Node 20 LTS, our minimum,
  // has fetch globally available since v18).
  const target = globalThis as unknown as { fetch?: typeof globalThis.fetch };
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') {
    return;
  }

  const wrappedFetch = function wrappedFetch(
    this: unknown,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): ReturnType<typeof globalThis.fetch> {
    let effectiveInit: unknown = init;
    try {
      const ctx = correlationStore.getStore();
      if (ctx?.correlationId !== undefined) {
        effectiveInit = _injectCorrelationHeaderIntoFetchInit(
          input,
          init,
          ctx.correlationId,
        );
      }
    } catch {
      // Swallow — never let a patch failure break an outbound fetch
      // call. The fetch will proceed without the correlation header,
      // matching the behaviour of any pre-patch caller.
      effectiveInit = init;
    }
    return originalFetch.call(
      this,
      input,
      effectiveInit as Parameters<typeof globalThis.fetch>[1],
    );
  };

  // Preserve function name metadata for debugger/profiler clarity.
  Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' });

  target.fetch = wrappedFetch as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Idempotent module-load patch installation
// ---------------------------------------------------------------------------

/**
 * Idempotency sentinel: ensure the http/https monkey-patch is applied
 * exactly once even if this module is reloaded (e.g. by `jest.resetModules()`
 * during test setup, or by any HMR-like mechanism).
 *
 * `Symbol.for(name)` interns the symbol in the GLOBAL registry — every call
 * with the same name returns the same Symbol value. This is critical because
 * a `Symbol(name)` call (without `.for`) creates a NEW Symbol on every
 * module reload, defeating idempotency. Without this sentinel, a test suite
 * that calls `jest.resetModules()` could accumulate nested wrapper chains:
 *   our-wrapper-3 → our-wrapper-2 → our-wrapper-1 → OTel-wrapper → Node-native
 * which would slow down outbound calls and (in pathological cases) overflow
 * the call stack.
 *
 * Re-patching is detected by checking whether the `http` module already
 * carries the sentinel; if so, the patch is skipped entirely.
 */
const PATCHED_SENTINEL = Symbol.for('__blitzy_correlation_http_patched__');

/**
 * Separate sentinel for the fetch wrapper. Anchored on the same `http`
 * core-module object as the http/https sentinel for the same process-
 * shared-singleton reasoning documented above on `correlationStore` —
 * the `http` module is interned per-process and survives Jest test-file
 * sandbox boundaries, whereas `globalThis` is per-Jest-VM-context and
 * therefore unsuitable as the sentinel anchor.
 *
 * The fetch sentinel is intentionally distinct from the http sentinel
 * because the two patches operate on different transport surfaces — a
 * future refactor that disables fetch patching but keeps http patching
 * (or vice versa) MUST be expressible without flipping a shared boolean.
 */
const FETCH_PATCHED_SENTINEL = Symbol.for('__blitzy_correlation_fetch_patched__');

interface Patchable {
  [key: symbol]: unknown;
}

if (!(http as unknown as Patchable)[PATCHED_SENTINEL]) {
  patchHttpModule(http);
  patchHttpModule(https);
  (http as unknown as Patchable)[PATCHED_SENTINEL] = true;
  (https as unknown as Patchable)[PATCHED_SENTINEL] = true;
}

if (!(http as unknown as Patchable)[FETCH_PATCHED_SENTINEL]) {
  patchFetch();
  (http as unknown as Patchable)[FETCH_PATCHED_SENTINEL] = true;
}
