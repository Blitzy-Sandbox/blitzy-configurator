/**
 * Live design API module for the StrikeForge frontend.
 *
 * Authority:
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/api/designs.ts → Design API calls — stubbed during
 *       Track 2, wired to live backend during MG1-F.
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       CREATE | frontend/src/api/designs.ts | Real calls to
 *       POST /api/designs, GET /api/designs,
 *       POST /api/designs/:id/share-link.
 *   - User stories:
 *       ST-018 (Save Current Design via Save Design CTA) →
 *         createDesign() POSTs /api/designs.
 *       ST-019 (View and Load a Previously Saved Design) →
 *         listDesigns() GETs /api/designs (paginated).
 *       ST-021 (Share Current Design via Copy-to-Clipboard Link) →
 *         createShareLink() POSTs /api/designs/:id/share-link.
 *       ST-027 (Persist New Design Record via Create Design Endpoint) is
 *         the backend counterpart of ST-018; the request/response shapes
 *         declared here mirror the canonical persisted record returned by
 *         that endpoint.
 *       ST-028 (Retrieve Designs Owned by Authenticated User) is the
 *         backend counterpart of ST-019; the cursor-based pagination
 *         contract declared here matches the documented bounded paginated
 *         traversal mechanism with a server-enforced max page size.
 *       ST-029 (Issue Time-Limited Share Link for a Saved Design) is the
 *         backend counterpart of ST-021; the ShareLink shape carries the
 *         documented expiration timestamp.
 *
 * Purpose:
 *   This module is the SINGLE point through which the frontend creates,
 *   lists, and shares designs. Every function delegates to the request()
 *   wrapper in ./client so that the cross-cutting concerns (Firebase
 *   Bearer auth attachment, x-correlation-id propagation, JSON
 *   serialization, ApiError throwing) are applied uniformly.
 *
 * Cross-cutting rules enforced here:
 *
 *   - Rule R2 (no credentials in logs). This file contains ZERO console.*
 *     calls. Errors are propagated as ApiError (thrown from ./client) so
 *     the calling component decides what to render — never print here.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend). This frontend module
 *     does NOT decode, parse, or validate any JWT. Token attachment is
 *     delegated to ./client which forwards the raw Firebase ID token
 *     verbatim to the backend. The backend's session middleware calls
 *     admin.auth().verifyIdToken() (AAP C2) as the SOLE authority on
 *     validity. NO custom JWT-handling libraries are imported here or
 *     anywhere else in the frontend.
 *
 *   - Rule R9 (no payment processing). This module is a sibling of
 *     ./orders.ts and inherits the same defensive posture: NO
 *     payment-processor SDKs, no settlement / billing / tokenization
 *     identifiers, and no field names associated with downstream
 *     financial transactions appear in this file.
 *
 *   - C5 (correlation ID propagation). Every request issued by this
 *     module receives an X-Correlation-Id header generated inside
 *     ./client's request() helper. This file does NOT manage correlation
 *     IDs directly — that responsibility lives in ./client.
 *
 * Out of scope (per the file's agent prompt §8):
 *   - getDesign(id) / loadDesign(id) — single-design fetch is not in the
 *     49 stories' surface (ST-019 loads via listDesigns + state hydration).
 *   - deleteDesign / updateDesign — the AAP does not specify these
 *     endpoints; saves create new immutable records per ST-027.
 *   - Optimistic UI updates — calling component's responsibility.
 *   - Retry logic — calling component wraps with retry helper if needed.
 *   - Caching — calling component (e.g., the Zustand store) handles it.
 *   - Logo upload — orchestrated by frontend/src/configurator/controls/
 *     logo/LogoUploader.tsx; the DesignPayload.logo.reference field
 *     carries the GCS object name AFTER upload completes.
 */

import { request } from './client';

// ============================================================================
// Type definitions — request and response shapes for the /api/designs/*
// endpoints. Every interface uses camelCase field names to match the
// backend's default JSON serialization (Express + pino), and every
// timestamp is an ISO-8601 string (the canonical wire format chosen by
// the backend per ST-027-AC2 / ST-028-AC2).
// ============================================================================

/**
 * Logo placement metadata persisted as part of a {@link DesignPayload}.
 *
 * When the user has applied a logo via the LogoUploader (ST-014) and
 * positioned it via the LogoPositioner (ST-015 / ST-016), the resulting
 * placement is captured by this interface and serialized as part of the
 * design's payload. When no logo is applied, the parent DesignPayload's
 * `logo` field is `null` (not an empty DesignLogo with default values) —
 * the absence of a logo is semantically distinct from a centered, full-
 * size logo and the frontend MUST distinguish the two when rendering.
 *
 * Coordinate system rationale:
 *   - `position` uses normalized [0, 1] UV coordinates because the ball
 *     surface is a sphere and the logo is composited onto a Fabric.js
 *     canvas whose (u, v) coordinates map directly to Three.js texture
 *     coordinates. UV space is resolution-independent so the persisted
 *     value remains valid across viewport changes (ST-001-AC3 viewport
 *     re-fit) and across different baseline texture resolutions.
 *   - `scale` is a multiplier (1.0 = native size) so that values around
 *     1.0 are visually intuitive in the UI and JSON-friendly in storage.
 *   - `rotation` is in radians (Three.js / Fabric.js native unit) so the
 *     value can be passed verbatim to the rendering pipeline without a
 *     degree-to-radian conversion at every render.
 */
export interface DesignLogo {
  /**
   * Server-assigned logo reference (e.g., a GCS object name returned by
   * the logo upload endpoint). The frontend treats this as opaque — it
   * is generated by the backend's GCS upload flow and is the SAME value
   * the backend uses to issue v4 signed URLs (AAP C1 / Rule R5) for
   * read access.
   */
  reference: string;

  /**
   * Position on the ball surface in normalized [0, 1] UV coordinates.
   * `u` is the horizontal (azimuth) axis; `v` is the vertical
   * (latitude) axis. Values outside [0, 1] are clamped server-side.
   */
  position: { u: number; v: number };

  /**
   * Scale factor applied to the logo where 1.0 represents the native
   * upload size. The backend may enforce upper / lower bounds (e.g.,
   * to prevent a 1000x scale that would consume the entire texture);
   * frontend callers do NOT enforce bounds locally — that would
   * duplicate business rules between layers.
   */
  scale: number;

  /**
   * Rotation in radians around the logo's center. Positive values
   * rotate counter-clockwise per Three.js / Fabric.js conventions.
   * Two-pi periodicity is handled server-side; the frontend does NOT
   * normalise the value before sending.
   */
  rotation: number;
}

/**
 * Configurator selections persisted as part of a {@link Design}.
 *
 * This is the canonical shape of "what the user designed" — the colors,
 * stitching pattern, finish, and optional logo placement. It is
 * authored on the frontend by the configurator UI (color pickers,
 * pattern selector, finish selector, logo controls) and round-tripped
 * unchanged through the backend's /api/designs endpoint per
 * ST-027-AC1 ("persists a new design record with all configurator
 * selections (colors, stitching pattern, material finish, logo
 * reference and placement)").
 *
 * Hex color contract:
 *   The frontend authors hex strings with a leading `#` and uppercase
 *   alphanumeric body (e.g., `#FF6600`). The backend accepts any RGB
 *   hex format and stores the value verbatim; the frontend and backend
 *   agree to use the canonical uppercase-with-hash form so equality
 *   comparisons on the wire produce predictable results. Three- and
 *   four-character shorthand (e.g., `#F60`) and rgb()/rgba() functions
 *   are NOT used.
 *
 * Pattern and finish identifier contract:
 *   The `pattern` field is one of six documented stitching pattern
 *   identifiers per ST-010 (the canonical list lives in the frontend's
 *   pattern selector module — it is intentionally a string here rather
 *   than a literal union so that adding a new pattern in the UI does
 *   not require regenerating this types file). The `finish` field is
 *   one of three documented material finishes per ST-011 (typically
 *   `'matte'`, `'glossy'`, or `'metallic'`). String values that
 *   reference unknown identifiers are server-rejected with HTTP 400.
 */
export interface DesignPayload {
  /**
   * Hex color string for the primary panel color (ST-006). Canonical
   * form is `#RRGGBB` with uppercase hex digits.
   */
  primaryColor: string;

  /**
   * Hex color string for the secondary panel color (ST-007). Canonical
   * form is `#RRGGBB` with uppercase hex digits.
   */
  secondaryColor: string;

  /**
   * Hex color string for the accent color (ST-008). Canonical form is
   * `#RRGGBB` with uppercase hex digits.
   */
  accentColor: string;

  /**
   * One of the six documented stitching pattern identifiers (ST-010).
   * The canonical identifier list is defined by the pattern selector
   * UI module; values outside that set are rejected by the backend.
   */
  pattern: string;

  /**
   * One of the three documented material finish identifiers (ST-011),
   * typically `'matte'`, `'glossy'`, or `'metallic'`. The canonical
   * identifier list is defined by the finish selector UI module;
   * values outside that set are rejected by the backend.
   */
  finish: string;

  /**
   * Logo state. `null` indicates the user has NOT applied a logo —
   * this is semantically distinct from "logo applied with default
   * placement". When the user applies a logo via LogoUploader
   * (ST-014) the field becomes a {@link DesignLogo} object capturing
   * the reference, UV position, scale, and rotation per
   * ST-015 / ST-016. When the user removes the logo, the field
   * returns to `null`.
   */
  logo: DesignLogo | null;
}

/**
 * The canonical persisted design record returned by the backend's
 * /api/designs endpoints (ST-027-AC2 / ST-028-AC2).
 *
 * This is the full record (id + title + payload + timestamps). For the
 * lighter list-rendering shape used by /api/designs (GET) per ST-028-AC2,
 * see {@link DesignSummary}.
 *
 * Identifier contract:
 *   The backend assigns the `id` field server-side (typically a UUID v4
 *   per ST-027-AC2). The frontend treats it as opaque — it is used as
 *   a path segment in /api/designs/:id/share-link (createShareLink) and
 *   as a foreign key reference inside cart line items (orders.ts
 *   CartItem.designId). No frontend code parses or validates the
 *   identifier format.
 *
 * Timestamp contract:
 *   `createdAt` and `lastModifiedAt` are ISO-8601 strings (e.g.,
 *   `'2025-01-15T13:42:11.123Z'`) — not numeric epoch milliseconds.
 *   This matches the default JSON serialization of PostgreSQL
 *   `timestamptz` columns through pg + Express, and avoids ambiguity
 *   about timezone (Z is always UTC). Frontend code that needs a
 *   `Date` object converts via `new Date(design.lastModifiedAt)`.
 */
export interface Design {
  /**
   * Server-assigned identifier (typically a UUID v4 per ST-027-AC2).
   * Treated as opaque by the frontend.
   */
  id: string;

  /**
   * Human-readable design title authored by the user via the Save
   * Design CTA (ST-018) and accepted by the backend per ST-027-AC1.
   * The backend may enforce length validation; the frontend trusts
   * server validation rather than duplicating it.
   */
  title: string;

  /**
   * The full configurator selections persisted with this design
   * (ST-027-AC1). Loading a design from the list (ST-019-AC2)
   * replaces the current configurator state with this payload.
   */
  payload: DesignPayload;

  /**
   * ISO-8601 creation timestamp (UTC). Set by the backend at insert
   * time and immutable thereafter.
   */
  createdAt: string;

  /**
   * ISO-8601 last-modified timestamp (UTC). Set by the backend at
   * insert time and updated on subsequent mutations of the design
   * record. Used for sorting in /api/designs (GET) per ST-028-AC4
   * ("most-recently-modified first").
   */
  lastModifiedAt: string;
}

/**
 * Lightweight metadata returned by /api/designs (GET) per ST-028-AC2
 * ("enough metadata for a client to render a list without loading the
 * full design payload").
 *
 * The DesignSummary intentionally OMITS the `payload` field so the
 * list endpoint can return many designs without the per-record
 * payload bloat. When the user clicks a list item (ST-019-AC2), the
 * calling component fetches the full Design record (or, in the
 * pre-MG2 implementation, hydrates from the summary plus a
 * subsequent fetch).
 *
 * Field selection rationale:
 *   - `id` — needed as the React list key and as the share-link path
 *     parameter for ST-021.
 *   - `title` — needed for human-readable list rendering (ST-019-AC1
 *     "each item showing enough metadata (such as title and
 *     last-modified time) to identify it").
 *   - `lastModifiedAt` — needed for relative-time display
 *     ("modified 2 hours ago") and for the documented sort order
 *     (ST-028-AC4).
 *   - `createdAt` — included as the secondary sort key and for
 *     "Created" labels in detail views; the marginal payload cost is
 *     negligible (~30 bytes per record) versus the UX cost of a
 *     second round trip to fetch it.
 */
export interface DesignSummary {
  /** Server-assigned identifier (matches {@link Design.id}). */
  id: string;

  /** Human-readable title for list rendering (ST-019-AC1). */
  title: string;

  /**
   * ISO-8601 last-modified timestamp (UTC). Used for sort ordering
   * (most-recent first per ST-028-AC4) and for relative-time
   * rendering in the design list UI.
   */
  lastModifiedAt: string;

  /** ISO-8601 creation timestamp (UTC). */
  createdAt: string;
}

/**
 * Request body shape for {@link createDesign}.
 *
 * Per ST-027-AC1 the create endpoint accepts the title and the full
 * configurator selections; the backend assigns `id`, `createdAt`, and
 * `lastModifiedAt` server-side per ST-027-AC2 and returns them in the
 * response. The user-supplied input therefore intentionally OMITS those
 * server-assigned fields — including them in the request body would
 * either be ignored or rejected by the backend, depending on its strict
 * mode posture.
 */
export interface CreateDesignInput {
  /**
   * Human-readable title chosen by the user. The backend may enforce
   * length validation per ST-027-AC3 ("malformed input"); the
   * frontend's Save form is responsible for surfacing user-actionable
   * validation errors that the backend returns.
   */
  title: string;

  /**
   * Full configurator selections to persist (colors + pattern +
   * finish + logo). The frontend MUST send all required fields per
   * ST-027-AC1; missing required selections are rejected with HTTP
   * 400 per ST-027-AC3 and a descriptive error body.
   */
  payload: DesignPayload;
}

/**
 * Optional parameters for {@link listDesigns}.
 *
 * Both fields are optional. Omitting both fetches the FIRST page with
 * the server's default page size. Pass `cursor` to fetch the NEXT page
 * after a previous response. Pass `limit` to request a specific page
 * size; the backend enforces a documented maximum (max 100 per AAP
 * §0.3.3 / ST-028-AC5) and silently caps larger values.
 *
 * Why object parameters instead of positional?
 *   The agent prompt's signature sketch is `listDesigns(cursor)`, but
 *   adopting an object parameter (`ListDesignsParams`) is a strict
 *   superset that:
 *     - allows passing `limit` independently of `cursor`,
 *     - preserves call-site readability (`listDesigns({ cursor: x })`
 *       is more self-documenting than `listDesigns(x)`),
 *     - permits future extension (e.g., `sortDirection`) without
 *       breaking call sites.
 *   The exports schema declares `ListDesignsParams` with both members
 *   (cursor + limit), confirming the object-parameter choice is the
 *   intended contract.
 */
export interface ListDesignsParams {
  /**
   * Opaque cursor returned by a previous call's
   * {@link ListDesignsResponse.nextCursor}. Omit (`undefined`) for the
   * first page. Treat as opaque — do NOT decode or interpret the
   * value; the server's encoding may change.
   */
  cursor?: string;

  /**
   * Requested page size. Omit (`undefined`) to use the server default
   * (typically a small number like 20 to balance round-trip latency
   * against scroll performance). Per AAP §0.3.3 / ST-028-AC5 the
   * server enforces a maximum of 100; values above 100 are silently
   * capped server-side.
   */
  limit?: number;
}

/**
 * Response shape for {@link listDesigns} per ST-028.
 *
 * The response always contains `items` (possibly empty per
 * ST-028-AC3 — "no designs returns an empty collection with a success
 * status, NOT an error") and a `nextCursor` indicating whether more
 * pages remain.
 *
 * Pagination protocol:
 *   - `items` is the current page, ordered most-recently-modified
 *     first per ST-028-AC4. Each element is a {@link DesignSummary}.
 *   - `nextCursor` is `null` when no more pages remain, or an opaque
 *     string token to pass as the `cursor` parameter on the next
 *     call. The explicit `null` (not undefined) makes the
 *     "no more pages" sentinel unambiguous: callers use
 *     `if (response.nextCursor !== null)` rather than truthy checks
 *     that would also be false for empty strings.
 *
 * Empty-state handling:
 *   When the user has no designs, the backend returns
 *   `{ items: [], nextCursor: null }` with HTTP 200. The calling
 *   component renders an empty-state UI based on `items.length === 0`,
 *   NOT on a thrown ApiError. This matches the cart-empty pattern
 *   in ./orders.ts getCart().
 */
export interface ListDesignsResponse {
  /**
   * Page of design summaries, ordered most-recently-modified first
   * per ST-028-AC4. Empty when the user has no designs (or has
   * paginated past the last page) per ST-028-AC3.
   */
  items: DesignSummary[];

  /**
   * Cursor for the next page, or `null` when no more pages remain.
   * The explicit `null` (vs. `undefined`) makes the "end of stream"
   * signal unambiguous in callers' equality checks.
   */
  nextCursor: string | null;
}

/**
 * Response shape for {@link createShareLink} per ST-029.
 *
 * Per ST-029-AC2 each issued share link "carries a documented
 * expiration and points to exactly one design". The token is the
 * primary key into the share-link store; the URL is the
 * fully-qualified, copy-paste-ready string the frontend writes to the
 * clipboard per ST-021-AC1 ("writes the returned link to the system
 * clipboard"); the expiration is the time after which the read side
 * rejects the token per ST-029-AC2.
 *
 * URL composition rationale:
 *   The frontend does NOT compose the URL by concatenating
 *   `window.location.origin` + token — the backend is the canonical
 *   authority on the URL because it knows the deployment's public
 *   origin (which may differ from the API origin in some
 *   configurations). The frontend writes the backend-supplied URL
 *   verbatim to the clipboard.
 */
export interface ShareLink {
  /**
   * Opaque server-assigned token (typically a long random string).
   * Treated as opaque by the frontend; revoking the token (by the
   * owner or by expiration) renders the link inoperable per
   * ST-029-AC4 — the backend handles revocation, NOT the frontend.
   */
  token: string;

  /**
   * Fully-qualified URL the user can paste anywhere. The frontend
   * writes this verbatim to the clipboard via
   * `navigator.clipboard.writeText(shareLink.url)` per ST-021-AC1
   * — but ONLY on a successful resolve of the {@link createShareLink}
   * promise. Per ST-021-AC3 the clipboard is NOT modified on a
   * rejected share-link request.
   */
  url: string;

  /**
   * ISO-8601 expiration timestamp (UTC). After this moment the
   * read side rejects the token with a documented error per
   * ST-029-AC2. The frontend may render a "this link expires
   * <relative-time>" hint based on this value; the canonical
   * expiration check happens server-side.
   */
  expiresAt: string;
}

// ============================================================================
// API functions — every call delegates to ./client's request() helper
// ============================================================================
//
// The cross-cutting concerns enforced by request() are:
//   - Authorization: Bearer ${idToken} attachment (forwarded from the
//     Firebase JS SDK via getIdToken(); Rule R3 keeps token decoding
//     SOLELY on the backend).
//   - X-Correlation-Id: ${uuid} attachment (AAP C5 — every outbound
//     request carries a fresh v4 UUID so the backend can stitch logs
//     across services).
//   - JSON serialization of the request body (callers pass plain
//     objects; request() handles JSON.stringify and Content-Type).
//   - JSON parsing of 2xx response bodies (request() handles
//     response.json() and returns the parsed payload typed as T).
//   - ApiError thrown for non-2xx responses, with the parsed body
//     attached so calling components render specific failure messages
//     per ST-018-AC3, ST-019-AC3, and ST-021-AC3.
//   - Zero console.* calls (Rule R2).
// ============================================================================

/**
 * Persist a new design for the authenticated user (ST-018 frontend /
 * ST-027 backend).
 *
 * Endpoint: POST /api/designs
 * Auth: requires a valid Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-018 / ST-027 acceptance criteria):
 *   - ST-018-AC2: "Activating the Save Design CTA sends the current
 *     design selections to the persistence service" — this function
 *     IS the call that does the sending. The Save Design CTA's click
 *     handler awaits this promise and surfaces the success indicator
 *     on resolve.
 *   - ST-018-AC3: "If persistence fails or the user is not
 *     authenticated, the user sees an actionable failure message" —
 *     errors from request() propagate as ApiError to the caller. The
 *     calling component reads `err.status` and `err.body` to render
 *     a specific message naming the reason and the next step.
 *   - ST-027-AC1: the backend persists ALL configurator selections
 *     (colors, pattern, finish, logo) and the user-supplied title.
 *   - ST-027-AC2: on success the backend returns the canonical
 *     persisted Design with a server-assigned `id`, `createdAt`, and
 *     `lastModifiedAt`. The calling component MAY use the returned
 *     `id` to subsequently call {@link createShareLink}.
 *   - ST-027-AC3: malformed input is rejected with HTTP 400 and a
 *     descriptive error body. The persistence layer is left
 *     UNCHANGED on rejection (the calling component can safely
 *     re-submit after the user fixes the input).
 *   - ST-027-AC4: requests without a valid session are rejected by
 *     the backend's session validation contract (ST-026) before
 *     reaching the persistence layer. The frontend surfaces this as
 *     "please sign in".
 *
 * @param input - Title and full configurator selections to persist.
 * @returns The newly created Design with server-assigned id and
 *   timestamps.
 * @throws ApiError with status 400 when the input is malformed
 *   (ST-027-AC3). The error body's message field describes the
 *   specific problem.
 * @throws ApiError with status 401 when the Firebase session is
 *   invalid or expired (ST-026 / ST-027-AC4). The calling component
 *   prompts re-authentication.
 * @throws ApiError with status 5xx for backend errors. The calling
 *   component shows a generic retry UI; per ST-027-AC3 the
 *   persistence layer is left unchanged so retry is safe.
 */
export async function createDesign(input: CreateDesignInput): Promise<Design> {
  return request<Design>('/api/designs', {
    method: 'POST',
    body: input,
  });
}

/**
 * Retrieve a paginated page of designs owned by the authenticated user
 * (ST-019 frontend / ST-028 backend).
 *
 * Endpoint: GET /api/designs[?cursor=...&limit=...]
 * Auth: requires a valid Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-019 / ST-028 acceptance criteria):
 *   - ST-019-AC1: "The UI surfaces a list of designs owned by the
 *     current authenticated user" — this function fetches that list.
 *     The Bearer token is attached by ./client so the backend's
 *     session middleware (ST-026) can resolve `uid` and the
 *     repository scopes the query to that owner.
 *   - ST-019-AC3: "If the design list cannot be retrieved, the user
 *     sees an actionable failure message and the previous UI state
 *     is left intact" — errors propagate as ApiError; the calling
 *     component shows the failure and avoids mutating state.
 *   - ST-028-AC1: the backend returns ONLY designs owned by the
 *     authenticated user. The frontend trusts the backend's
 *     ownership filter — it does NOT cross-check.
 *   - ST-028-AC2: each item in the response is a DesignSummary
 *     (id + title + lastModifiedAt + createdAt) — the FULL payload
 *     is NOT returned by this endpoint to keep list responses small.
 *   - ST-028-AC3: when the user has no designs, the backend returns
 *     `{ items: [], nextCursor: null }` with HTTP 200 — NOT a 404.
 *     The calling component renders an empty-state UI based on
 *     `items.length === 0`, NOT on a thrown ApiError.
 *   - ST-028-AC4: the response is ordered most-recently-modified
 *     first; repeated calls with unchanged state produce the same
 *     order.
 *   - ST-028-AC5: the endpoint enforces a documented maximum page
 *     size and supports bounded paginated traversal. This module
 *     uses cursor-based pagination because it is friendlier to
 *     infinite-scroll UI and more robust against insertions during
 *     paging.
 *
 * Query string construction:
 *   Both `cursor` and `limit` are OPTIONAL. When both are omitted the
 *   path is `/api/designs` with no query string (proxy-cache-friendly
 *   first page). When either is present, URLSearchParams composes the
 *   query string; the backend handles URL decoding.
 *
 * @param params - Optional cursor for pagination and optional page
 *   size. When omitted entirely (or `{}`), fetches the first page
 *   with the server default page size.
 * @returns A page of DesignSummary items plus the next cursor (or
 *   `null` when no more pages remain).
 * @throws ApiError with status 401 when the Firebase session is
 *   invalid or expired (ST-026). The calling component prompts
 *   re-authentication.
 * @throws ApiError with status 5xx for backend errors. The calling
 *   component shows a retry UI per ST-019-AC3 ("the previous UI
 *   state is left intact").
 */
export async function listDesigns(params: ListDesignsParams = {}): Promise<ListDesignsResponse> {
  const search = new URLSearchParams();
  if (params.cursor !== undefined) {
    search.set('cursor', params.cursor);
  }
  if (params.limit !== undefined) {
    search.set('limit', String(params.limit));
  }
  const query = search.toString();
  const path = query.length > 0 ? `/api/designs?${query}` : '/api/designs';
  return request<ListDesignsResponse>(path);
}

/**
 * Issue a time-limited share link for a saved design owned by the
 * authenticated user (ST-021 frontend / ST-029 backend).
 *
 * Endpoint: POST /api/designs/:id/share-link
 * Auth: requires a valid Firebase ID token (attached by ./client).
 *
 * Behaviour (per ST-021 / ST-029 acceptance criteria):
 *   - ST-021-AC1: "A Share action ... requests a shareable link for
 *     the current saved design and writes the returned link to the
 *     system clipboard on success" — this function makes the
 *     request. The CALLING COMPONENT is responsible for the
 *     clipboard write; this function ONLY returns the URL. The
 *     calling component MUST `await` this promise and only then
 *     call `navigator.clipboard.writeText(shareLink.url)`.
 *   - ST-021-AC3: "If the share-link request fails, the clipboard
 *     is not modified" — errors propagate as ApiError; the calling
 *     component MUST guard the clipboard write inside an
 *     `await`/`try`-`catch` so a rejected promise does NOT execute
 *     the clipboard write.
 *   - ST-029-AC1: the backend issues a share link only for a design
 *     OWNED by the authenticated user. The frontend trusts the
 *     backend's ownership check — it does NOT cross-check.
 *   - ST-029-AC2: each issued link carries a documented
 *     expiration; the {@link ShareLink.expiresAt} field exposes
 *     this so the frontend can render a "this link expires
 *     <relative-time>" hint.
 *   - ST-029-AC3: visiting a valid, unexpired share link returns
 *     enough information for the configurator to render the target
 *     design read-only without sign-in. That visit is handled by a
 *     SEPARATE unauthenticated GET endpoint (/api/share/:token)
 *     which is NOT called from this module.
 *   - ST-029-AC4: revoked or expired links return a documented
 *     error from the read side. This module is the WRITE side
 *     (issuance) — revocation handling is server-side only.
 *
 * URL encoding rationale:
 *   The `designId` is URL-encoded via encodeURIComponent() defensively.
 *   Server-assigned UUIDs from PostgreSQL's uuid_generate_v4() are
 *   URL-safe by default (only hex digits and dashes), but encoding is
 *   a defense-in-depth measure that protects against future identifier
 *   schemes (base64-encoded snowflakes, etc.) that might contain `+`,
 *   `/`, or `=` — none of which are safe in URL path segments.
 *
 * Request body rationale:
 *   The body is the empty object `{}`. The backend's POST handler
 *   accepts JSON and may use a body-parser that requires non-empty
 *   bytes; sending `{}` ensures Content-Type negotiation works and
 *   provides a future extension point (e.g., `{ ttlSeconds: 3600 }`
 *   per ST-029-AC2). The backend ignores extra fields it does not
 *   recognize.
 *
 * @param designId - Server-assigned identifier of a saved design
 *   owned by the authenticated user (typically obtained from a
 *   previous {@link createDesign} response's `id` or from a
 *   {@link DesignSummary.id} in {@link listDesigns} results).
 * @returns The issued ShareLink with token, fully-qualified URL,
 *   and expiration timestamp.
 * @throws ApiError with status 401 when the Firebase session is
 *   invalid or expired (ST-026). The calling component prompts
 *   re-authentication and DOES NOT modify the clipboard
 *   (ST-021-AC3).
 * @throws ApiError with status 403 when the authenticated user
 *   does not own the target design (per ST-029-AC1 the backend
 *   restricts share-link issuance to the design's owner). The
 *   calling component DOES NOT modify the clipboard.
 * @throws ApiError with status 404 when the design does not exist.
 *   The calling component DOES NOT modify the clipboard.
 * @throws ApiError with status 5xx for backend errors. The calling
 *   component shows a retry UI and DOES NOT modify the clipboard
 *   (ST-021-AC3).
 */
export async function createShareLink(designId: string): Promise<ShareLink> {
  const path = `/api/designs/${encodeURIComponent(designId)}/share-link`;
  return request<ShareLink>(path, {
    method: 'POST',
    body: {},
  });
}
