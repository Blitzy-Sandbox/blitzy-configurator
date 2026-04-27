/**
 * Foundational HTTP fetch wrapper for the StrikeForge frontend.
 *
 * Authority:
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/api/client.ts → Fetch wrapper attaching Firebase
 *       `idToken` Bearer + `x-correlation-id`.
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       CREATE | frontend/src/api/client.ts | Fetch wrapper attaching
 *       `Authorization: Bearer ${idToken}` + `x-correlation-id: ${uuid()}`.
 *   - AAP §0.5.2 "Dependency Injections":
 *       Every outbound API call attaches `Authorization: Bearer ${await
 *       getIdToken()}` and `x-correlation-id: ${uuid()}`.
 *   - AAP §0.5 / Rule C5 — correlation ID propagation: every outbound
 *     request from `client.ts` MUST attach `X-Correlation-Id: <uuid v4>`
 *     so the backend's correlation middleware
 *     (`backend/src/middleware/correlation.ts`) can stitch logs and traces
 *     end-to-end via `AsyncLocalStorage`.
 *
 * Responsibilities:
 *   1. Attach `Authorization: Bearer ${idToken}` from
 *      `frontend/src/auth/firebase-client.ts` `getIdToken()` (when
 *      `authenticated: true` and a Firebase user is signed in).
 *   2. Attach `X-Correlation-Id: ${crypto.randomUUID()}` (per AAP §0.5 / C5)
 *      so the backend can join logs across services.
 *   3. Set `Accept: application/json` (overridable via `options.accept`)
 *      and `Content-Type: application/json` for requests with bodies.
 *   4. Serialize request bodies via `JSON.stringify` (callers pass plain
 *      objects, never pre-stringified payloads).
 *   5. Parse response bodies via `response.json()` for 2xx statuses
 *      (or return `undefined` for 204 No Content).
 *   6. Throw a typed `ApiError` for non-2xx statuses, with the parsed
 *      response body attached so calling components can render specific
 *      failure messages per ST-018-AC3, ST-019-AC3, ST-021-AC3.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R2 (no credentials in logs): this file contains ZERO `console.*`
 *     calls. The Authorization header, the request body, and any credential
 *     material are NEVER logged. Errors are propagated as `ApiError`,
 *     never printed.
 *   - Rule R3 (Firebase Admin SDK only on backend): the frontend uses the
 *     `firebase` JS SDK (via `getIdToken()`) to obtain the token. This file
 *     forwards the raw token verbatim to the backend; it does NOT decode,
 *     parse, or validate JWT contents. The backend's session middleware
 *     calls `admin.auth().verifyIdToken()` (AAP C2 / Rule R3).
 *   - Rule R4 (analog): `VITE_API_BASE_URL` is OPTIONAL — the frontend
 *     defaults to same-origin (relative URLs). Rule R4 governs the six
 *     backend env vars per AAP §0.1.3 / §0.8.1, not frontend Vite vars.
 *   - Rule R9 (no payment processing): no Stripe / Braintree / PayPal /
 *     payment-intent / charge references appear in this file.
 *
 * Out of scope (per Phase 12 of the file's agent prompt):
 *   - Retry logic — caller's responsibility.
 *   - Request deduplication / caching — caller's responsibility.
 *   - Token refresh — Firebase JS SDK auto-refreshes internally.
 *   - CSRF tokens — Bearer auth is immune to CSRF.
 *   - WebSocket / SSE / streaming — all calls are HTTP request/response.
 *   - W3C `traceparent` propagation from the browser — the backend's OTel
 *     auto-instrumentation handles inter-service propagation; the
 *     correlation ID alone is sufficient for log stitching at the 49
 *     stories' scope.
 */

import { getIdToken } from '../auth/firebase-client';

// ============================================================================
// ApiError
// ============================================================================

/**
 * Error thrown by `request()` for non-2xx HTTP responses.
 *
 * The `body` field carries the parsed response body (JSON object, string, or
 * `undefined`) so calling components can render specific error messages per
 * ST-018-AC3 ("actionable failure message"), ST-019-AC3 ("the user sees an
 * actionable failure message"), and ST-021-AC3 ("user sees an actionable
 * failure message naming the reason").
 *
 * Rule R2: this error MUST NOT include the request's Authorization header,
 * the user's password, or any other credential material. The constructor
 * intentionally accepts only the response triple `(status, statusText, body)`.
 *
 * Callers narrow the type with `instanceof ApiError`:
 *
 *   try {
 *     await request<Design>('/api/designs/...');
 *   } catch (err) {
 *     if (err instanceof ApiError) {
 *       if (err.status === 401) { showSignInPrompt(); return; }
 *       showFailure(err.body);
 *     } else {
 *       showNetworkError();
 *     }
 *   }
 */
export class ApiError extends Error {
  /** HTTP status code (e.g., 400, 401, 404, 500). */
  public readonly status: number;

  /**
   * HTTP status text (e.g., "Bad Request", "Unauthorized"). Some browsers
   * (notably modern Chrome over HTTP/2) return an empty string here; that is
   * normal and not an error condition.
   */
  public readonly statusText: string;

  /**
   * Parsed response body. Typed as `unknown` because the shape depends on
   * the endpoint and HTTP status — calling components MUST use type guards
   * (e.g., `if (typeof err.body === 'object' && err.body && 'message' in
   * err.body)`) before reading specific fields.
   */
  public readonly body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API request failed: ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;

    // Restore the prototype chain. With `target: ES2022` (per
    // `frontend/tsconfig.json`) native `class extends Error` works
    // correctly without this line, but including it is a defensive measure
    // that costs zero runtime performance and protects against future
    // tsconfig changes that lower the target (e.g., to ES5/ES2017 where
    // `instanceof ApiError` would otherwise return `false`).
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

// ============================================================================
// RequestOptions
// ============================================================================

/**
 * Options accepted by `request()`. All fields are optional; sensible defaults
 * are applied so the common case `request<T>('/api/path')` requires no
 * options object.
 */
export interface RequestOptions {
  /**
   * HTTP method. Defaults to `'GET'`. The backend exposes:
   *   - GET for reads (`/api/cart`, `/api/designs`, `/api/share/:token`).
   *   - POST for creates (`/api/auth/register`, `/api/designs`,
   *     `/api/orders`, `/api/designs/:id/share-link`,
   *     `/api/orders/:id/finalize`).
   *   - DELETE for revocations (e.g., logout in some implementations).
   */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /**
   * Request body. When defined, it is `JSON.stringify`'d and sent with
   * `Content-Type: application/json`. When `undefined`, no body is sent
   * and no `Content-Type` header is added (so GET requests stay idempotent
   * and proxy-cache-friendly). Pass plain objects or primitives; do NOT
   * pre-stringify.
   */
  body?: unknown;

  /**
   * When `true` (default), `Authorization: Bearer ${idToken}` is attached
   * if a Firebase user is currently signed in. When `false`, the
   * Authorization header is omitted — used for the unauthenticated
   * `/api/share/:token` endpoint and for sign-in / sign-up flows that
   * predate authentication.
   */
  authenticated?: boolean;

  /**
   * Optional explicit correlation ID. When omitted, a fresh RFC 4122 UUID
   * v4 is generated via `crypto.randomUUID()`. Tests may pass a fixed
   * value for deterministic logging assertions; production code should
   * always omit this field and let the wrapper generate fresh IDs.
   *
   * Per AAP §0.5 / Rule C5: the backend correlation middleware preserves
   * a caller-provided correlation ID verbatim and only generates a new
   * one when the inbound header is absent.
   */
  correlationId?: string;

  /**
   * Optional `AbortSignal` for request cancellation. Calling components
   * can pass an `AbortSignal` from a `useEffect` cleanup so unmounted
   * components don't have in-flight fetches racing to set state on dead
   * components. The signal is forwarded directly to `fetch()`.
   */
  signal?: AbortSignal;

  /**
   * Optional override for the request's `Accept` header. Defaults to
   * `'application/json'`. Useful if a future endpoint returns a non-JSON
   * payload (e.g., a CSV export). The current implementation always
   * parses 2xx response bodies as JSON; non-JSON payloads would require
   * a parallel `requestRaw()` helper which is out of scope for the 49
   * stories.
   */
  accept?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Read the configured API base URL.
 *
 * Vite replaces `import.meta.env.VITE_API_BASE_URL` at build time with the
 * literal value from the `.env` file (or the shell environment). When the
 * variable is unset, this function returns `''` (the empty string), which
 * causes `buildUrl(path)` to produce a relative URL — appropriate when the
 * frontend and backend are served from the same origin (e.g., behind a
 * reverse proxy in production, or behind Vite's preview server in CI).
 *
 * Rule R4 (analog): there is no fallback to `'http://localhost:3000'` here.
 * If the deployment requires an absolute base URL (cross-origin frontend +
 * backend), the operator MUST set `VITE_API_BASE_URL` at build time; the
 * frontend will not silently misroute calls to localhost in production.
 */
function getApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL;
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : '';
}

/**
 * Build the full request URL from a caller-supplied path.
 *
 * Three modes:
 *   1. Absolute URL passed in (`http://...`, `https://...`): use as-is.
 *      No base URL is prepended — useful for share-link previews that may
 *      embed a fully-qualified URL.
 *   2. Base URL configured via `VITE_API_BASE_URL`: prepend it, normalising
 *      slashes so `'https://api.example.com/'` + `'/api/designs'` becomes
 *      `'https://api.example.com/api/designs'` (single slash, not double).
 *   3. No base URL configured: return the path verbatim (relative URL),
 *      which the browser resolves against `window.location.origin`.
 */
function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const base = getApiBaseUrl();
  if (base.length === 0) {
    return path;
  }
  // Normalise slashes at the boundary: avoid both `//` and missing `/`.
  if (base.endsWith('/') && path.startsWith('/')) {
    return base + path.slice(1);
  }
  if (!base.endsWith('/') && !path.startsWith('/')) {
    return `${base}/${path}`;
  }
  return base + path;
}

/**
 * Generate a fresh correlation ID for an outbound request.
 *
 * Uses `crypto.randomUUID()` which returns an RFC 4122 UUID v4 string and is
 * available in:
 *   - Chrome 92+ (Vite minimum supported target).
 *   - Firefox 95+.
 *   - Safari 15.4+ (covers Playwright's WebKit project per AAP §0.6.12).
 *   - Node 19+ (for any future SSR scenario; currently unused).
 *
 * If `crypto.randomUUID` is unavailable (older browser, hardened sandbox),
 * this function throws an explicit `Error` rather than silently returning a
 * non-unique fallback. Per Rule R8 ("Gates fail closed"), a missing platform
 * primitive is a hard failure, not a silent degradation — a non-unique
 * correlation ID would break end-to-end log stitching invisibly.
 *
 * No `uuid` npm package is used here. Adding it would add ~5 KB minified to
 * the production bundle for no correctness benefit; per AAP §0.4.2 the
 * `uuid` package is in `backend/package.json` only, not `frontend/package.json`.
 */
function generateCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error(
    'crypto.randomUUID is unavailable; this browser is not supported. ' +
      'StrikeForge requires a browser that supports the Web Crypto API.',
  );
}

/**
 * Best-effort parse of a response body for an error response.
 *
 * Rationale: when the server returns a non-2xx status, we want to preserve
 * whatever it said in the body so the calling component can render a
 * specific message (per ST-018-AC3 / ST-019-AC3 / ST-021-AC3). The body
 * may be JSON (the typical case) or plain text (some proxies return text
 * for 502/504), or empty.
 *
 * Returns `undefined` rather than throwing on a parse failure — a parse
 * error here would mask the actual HTTP error from the caller.
 */
async function parseErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  try {
    const text = await response.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Public request function
// ============================================================================

/**
 * Perform an HTTP request to the backend API with cross-cutting concerns
 * applied uniformly. Every outbound API call in
 * `frontend/src/api/designs.ts` and `frontend/src/api/orders.ts` delegates
 * to this function so authentication, correlation ID propagation, JSON
 * serialization, and error handling are consistent across the frontend.
 *
 * Behaviour summary:
 *   - `Authorization: Bearer ${idToken}` is attached when
 *     `authenticated: true` (default) AND a Firebase user is signed in
 *     (i.e., `getIdToken()` resolves to a non-null string). When the user
 *     is signed out, the header is silently omitted; the backend then
 *     returns 401, which the calling component surfaces as
 *     "please sign in".
 *   - `X-Correlation-Id: ${uuid v4}` is attached on every request. The
 *     backend's correlation middleware reads this header (case-insensitive
 *     per RFC 7230), threads it through `AsyncLocalStorage`, and includes
 *     it in every pino log record emitted during the request lifecycle.
 *   - `Accept: application/json` (overridable via `options.accept`).
 *   - `Content-Type: application/json` is set only when `body !== undefined`
 *     so GET requests remain proxy-cache-friendly.
 *   - Request bodies are `JSON.stringify`'d.
 *   - 2xx responses are parsed as JSON and returned typed as `T`.
 *   - 204 No Content responses return `undefined` cast to `T`. Callers
 *     using endpoints that may return 204 should ensure `T` includes
 *     `undefined` or `void` (e.g., `request<void>(...)`).
 *   - Non-2xx responses throw `ApiError` with the parsed body attached.
 *   - Network errors (fetch rejection, AbortError from a passed signal)
 *     propagate as the original `Error` / `DOMException`.
 *
 * Rule R2: this function NEVER logs the Authorization header, the request
 * body, or the response body. It contains ZERO `console.*` calls. Errors
 * are surfaced to the caller via `throw`, which integrates with React error
 * boundaries and `try/catch` in async/await code.
 *
 * Rule R3: this function does NOT decode, parse, or validate the JWT
 * contents of `idToken` — it forwards the opaque string verbatim to the
 * backend. The backend's session middleware calls
 * `admin.auth().verifyIdToken()` (AAP C2) as the SOLE authority on token
 * validity.
 *
 * @typeParam T - The expected response payload type. Defaults to `unknown`
 *   so callers MUST narrow the return type explicitly (preventing
 *   accidental `any` flow).
 * @param path - The endpoint path. Either:
 *   - Relative (`/api/designs`): resolved against `VITE_API_BASE_URL` if
 *     set, otherwise against `window.location.origin`.
 *   - Absolute (`https://api.example.com/...`): used verbatim.
 * @param options - Optional request configuration; see `RequestOptions`.
 * @returns The parsed JSON response body typed as `T`, or `undefined as T`
 *   for 204 No Content.
 * @throws `ApiError` for any non-2xx HTTP response.
 * @throws The underlying `Error` for network failures, abort, or
 *   unexpected JSON-parse failures on a 2xx response.
 */
export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    body,
    authenticated = true,
    correlationId = generateCorrelationId(),
    signal,
    accept = 'application/json',
  } = options;

  // Build the request headers. We construct a fresh object per call so the
  // caller's options object is never mutated and the header set is always
  // request-local (no cross-request leakage of Authorization values).
  const headers: Record<string, string> = {
    Accept: accept,
    'X-Correlation-Id': correlationId,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (authenticated) {
    // `getIdToken()` returns the raw Firebase ID token (a JWT string) or
    // `null` if the user is not signed in or the SDK has not initialized.
    // Per Rule R3, we forward the token VERBATIM to the backend; we do NOT
    // inspect it. Per Rule R2, the token is never logged or stored —
    // it lives only in the headers object and inside `fetch()`'s internals
    // for the duration of this call.
    const idToken = await getIdToken();
    if (idToken !== null) {
      headers.Authorization = `Bearer ${idToken}`;
    }
  }

  const response = await fetch(buildUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    // Bearer-token auth does not require cookies. `'same-origin'` is the
    // safest default: same-origin cookies are harmless (they would be
    // ignored by the backend since it uses Bearer tokens), and we do NOT
    // need cross-origin cookies (`'include'`) which would broaden the
    // attack surface for CSRF-like vectors.
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const parsedBody = await parseErrorBody(response);
    throw new ApiError(response.status, response.statusText, parsedBody);
  }

  if (response.status === 204) {
    // No Content — return `undefined` cast to T. Callers using endpoints
    // that may return 204 should declare `T` as `void` or `undefined | ...`
    // so the cast is type-safe at the call site.
    return undefined as T;
  }

  return (await response.json()) as T;
}
