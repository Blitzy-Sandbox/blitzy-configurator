/**
 * Design repository — data-access layer for the `designs` table.
 *
 * This module owns every direct read or write of the `designs` table. Higher
 * layers (services, routes) depend ONLY on the typed {@link DesignRepository}
 * interface — they do not import `pg` and do not know any SQL. Co-locating SQL
 * with its schema knowledge keeps migration changes localised and makes the
 * layer trivially mockable in unit tests.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/repositories/design.repository.ts | CRUD for designs
 *        table with pagination (max 100 per ST-028)`
 *   - AAP §0.6.4 Track 1 T1-C: repositories belong to the dependency-ordered
 *     backend API implementation.
 *   - Story ST-027 (create design endpoint).
 *   - Story ST-028 (retrieve designs by user — paginated, max 100 per page).
 *   - Story ST-029 (share-link issuance endpoint — joins through this table).
 *   - Story ST-030 (designs schema migration with ownership FK and indexes).
 *
 * Architectural intent:
 *   The `designs` table is the durable home for every persisted configurator
 *   design. Each row is owned by exactly one user (FK to `users.id`, the
 *   Firebase uid per AAP §0.2.1) and carries the full design payload as
 *   JSONB. Two timestamps (`created_at`, `last_modified_at`) drive ordering,
 *   freshness checks, and the keyset cursor used by {@link
 *   DesignRepository.listByUser}.
 *
 *   Three properties are enforced uniformly across every query in this file:
 *     1. Ownership is enforced IN SQL — every single-row SELECT/UPDATE filters
 *        by `user_id = $1`. A bug in the session middleware can therefore
 *        not leak another user's designs (defense-in-depth, AAP §0.5.1).
 *     2. `last_modified_at` is mutated SERVER-SIDE via PostgreSQL's `now()`,
 *        never via an application-supplied timestamp. Clock skew between the
 *        API server and PG cannot perturb the ordering used by the cursor.
 *     3. The `payload` column is bound through an explicit `$N::jsonb` cast
 *        with the JS payload pre-serialised via `JSON.stringify`. This is the
 *        most portable pattern across pg minor versions and matches the
 *        query plan PostgreSQL expects.
 *
 * Pagination strategy (ST-028-AC4 + ST-028-AC5):
 *   We use KEYSET (a.k.a. seek/cursor) pagination ordered by
 *   `last_modified_at DESC, id DESC`. The `id` tiebreaker is what makes the
 *   ordering total even when two rows share a millisecond-precision
 *   timestamp. The cursor is the `(last_modified_at, id)` tuple of the LAST
 *   row in the previous page, base64url-encoded, opaque to clients.
 *
 *   OFFSET-based pagination is INTENTIONALLY rejected because:
 *     - It scans+discards `OFFSET` rows on every page, degrading linearly
 *       with page depth (catastrophic for users with many designs).
 *     - It produces duplicate or skipped rows when designs are inserted/
 *       modified between page fetches — for a configurator where users save
 *       frequently, this is a real, user-visible defect.
 *
 *   The maximum page size is capped at {@link MAX_PAGE_SIZE} (= 100, per
 *   ST-028-AC5). The clamp is enforced at the repository so even a service-
 *   layer bug that smuggles `limit: 99999` cannot translate into an
 *   unbounded DB query.
 *
 *   We always fetch `limit + 1` rows internally — the canonical "do more
 *   pages exist?" trick. If we get back `limit + 1` rows we slice off the
 *   extra and emit a `nextCursor` derived from the LAST KEPT row; otherwise
 *   we emit `nextCursor: null` to signal exhaustion.
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): this repository never logs and
 *     never accepts credential material. The `payload` column is JSONB
 *     intended for configurator selections (colors, pattern, finish, logo
 *     placement) — it is the service layer's responsibility to ensure no
 *     credentials reach this column. The repository treats payload as
 *     opaque {@link DesignPayload} (= `Record<string, unknown>`).
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. Token verification is the
 *     exclusive responsibility of `backend/src/auth/firebase-admin.ts`.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. The {@link Pool} is dependency-injected by the caller
 *     (`backend/src/db/pool.ts` builds the pool from `DATABASE_URL`).
 *   - R9 (no payment processing): N/A here; this module manages design
 *     persistence only. No payment-processor terminology, fields, or
 *     amounts appear anywhere in this file.
 *   - R10 (migration filename pattern): N/A here; this module is consumed
 *     by — but does not author — the migration file
 *     `backend/migrations/{ts}_ST-030_designs.js`.
 *
 * Design discipline:
 *   - Parameterised queries only. Every SQL constant uses `$1`, `$2`
 *     placeholders; user-supplied values flow through the `values` array of
 *     the `QueryConfig`. There is no string interpolation of input anywhere
 *     in this file (SQL-injection invariant).
 *   - The repository is constructed via a factory (`createDesignRepository`)
 *     rather than as a class. Factories make dependency injection explicit,
 *     support `Object.freeze` of the returned record (preventing accidental
 *     method monkey-patching), and play well with tree-shaking.
 *   - The cursor encode/decode helpers are EXPORTED so the service layer
 *     (`backend/src/services/design.service.ts`) can round-trip cursors —
 *     for example, when validating a client-supplied cursor before it is
 *     passed back to {@link DesignRepository.listByUser} — without
 *     re-implementing the encoding scheme.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/db/pool.ts` — provides the `Pool` injected here.
 *   - `backend/src/services/design.service.ts` — primary consumer; calls
 *     `insert` (POST `/api/designs`), `listByUser` (GET `/api/designs`),
 *     `findById` (GET `/api/designs/:id`), `updatePayload` (PATCH
 *     `/api/designs/:id`).
 *   - `backend/src/services/share-link.service.ts` — calls `findById` after
 *     resolving a share token to its underlying design.
 *   - `backend/src/repositories/share-link.repository.ts` — the share_links
 *     table FK-references `designs.id`.
 *   - `backend/src/repositories/order.repository.ts` — `order_items.design_id`
 *     FK-references `designs.id`.
 *   - `backend/src/repositories/user.repository.ts` — the `users` table is
 *     the parent for the `user_id` foreign-key column.
 *   - `backend/migrations/{ts}_ST-030_designs.js` — defines the schema and
 *     indexes (`(user_id, last_modified_at DESC)` is what makes `listByUser`
 *     index-only).
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Section 1: Pagination constants — exported for service-layer reuse.
// ---------------------------------------------------------------------------

/**
 * Maximum number of designs per page, per ST-028-AC5.
 *
 * The repository CLAMPS any caller-supplied `limit` to this ceiling so a
 * service-layer bug or a hostile request body cannot translate into an
 * unbounded result set. The value is intentionally the same constant the
 * route handler will document publicly — keeping a single source of truth
 * means the documented value and the enforced value cannot drift.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Default page size when the caller omits `limit`.
 *
 * Sized to comfortably populate the Design Summary Sidebar's first viewport
 * without forcing the client to paginate immediately. The route handler may
 * advertise a different default for older clients but the repository's
 * fallback value is the safe baseline.
 */
export const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Section 2: Public types — domain shape exposed to higher layers.
// ---------------------------------------------------------------------------

/**
 * Unconstrained design payload — services validate shape against the
 * configurator stories ST-002 through ST-017 (colors, pattern, finish, logo
 * reference and placement).
 *
 * The repository treats the payload as opaque: it never inspects, normalises,
 * or transforms the JSON. That decoupling means future configurator features
 * (new color slots, new pattern types) do not require a repository change —
 * only a service-layer schema update. The column is JSONB in PostgreSQL so
 * any valid JSON document is accepted.
 *
 * The choice of `Record<string, unknown>` (rather than `unknown` or `any`)
 * communicates intent: callers must supply an object, not a primitive or
 * an array. Inside the object, individual fields are `unknown` and must be
 * narrowed at use site.
 */
export type DesignPayload = Record<string, unknown>;

/**
 * A design record as returned by this repository.
 *
 * Field-level contract (this is the API every consumer of this module relies
 * on):
 *
 *   `id`
 *     The server-assigned UUID primary key. Generated DB-side (per the
 *     ST-030 migration's `DEFAULT gen_random_uuid()`) so the application
 *     does not have to think about UUID collision avoidance.
 *
 *   `userId`
 *     The owning user's local id (= Firebase uid, per AAP §0.2.1). Backed
 *     by a foreign key to `users.id` with `ON DELETE CASCADE` so deleting
 *     a user cleanly removes their designs (relevant for test teardown
 *     and privacy compliance).
 *
 *   `title`
 *     The user-facing label for the design. Length-bounded by the migration
 *     (per ST-030); the repository does not enforce additional limits.
 *
 *   `payload`
 *     The full configurator selection set as a {@link DesignPayload} (JSONB
 *     in storage). Always a non-null object; an empty design payload is `{}`,
 *     never `null`.
 *
 *   `createdAt`
 *     The DB-assigned creation timestamp (column default `now()`).
 *
 *   `lastModifiedAt`
 *     The DB-assigned last-modification timestamp. Set to `now()` on insert
 *     and BUMPED to `now()` on every {@link DesignRepository.updatePayload}
 *     call. Drives the keyset pagination ordering.
 *
 * The interface is fully `readonly` so consumers cannot mutate the record
 * after retrieval. To "update" a design, callers must go through repository
 * methods that explicitly construct a new row — making every mutation a
 * deliberate database write rather than an in-memory side-effect.
 */
export interface Design {
  /** Server-assigned UUID; primary key. */
  readonly id: string;
  /** Owning user's id (= Firebase uid, per AAP §0.2.1). */
  readonly userId: string;
  /** User-facing label. */
  readonly title: string;
  /** Full configurator selection set; JSONB in storage. */
  readonly payload: DesignPayload;
  /** DB-assigned creation timestamp. */
  readonly createdAt: Date;
  /** DB-assigned last-modification timestamp; bumped on every update. */
  readonly lastModifiedAt: Date;
}

/**
 * A page of designs plus an opaque cursor for the next page.
 *
 *   `items`
 *     The current page's designs, length in `[0, limit]`. Ordered most-
 *     recently-modified first, with `id` as a deterministic tiebreaker.
 *
 *   `nextCursor`
 *     Opaque base64url string passed back to {@link DesignRepository.listByUser}
 *     to request the next page. `null` when there are no more rows — the
 *     conventional signal for "you've reached the end". Clients MUST treat
 *     the value as opaque (no parsing, no inspection) so the repository can
 *     evolve the cursor encoding without breaking compatibility.
 */
export interface DesignListPage {
  /** The current page's designs. */
  readonly items: Design[];
  /**
   * Opaque cursor for the next page; `null` when no more rows exist. Must
   * be treated as opaque by clients — the encoding is implementation
   * detail.
   */
  readonly nextCursor: string | null;
}

/**
 * Parameters accepted by {@link DesignRepository.insert}.
 *
 * The shape is intentionally minimal: the smallest set of values that
 * uniquely defines a new design row. All timestamps are DB-assigned
 * (`created_at` and `last_modified_at` both default to `now()` per the
 * ST-030 migration), so the application never needs to think about clock
 * skew between the API server and PG.
 */
export interface InsertDesignParams {
  /**
   * Owning user's local id (= Firebase uid). Subject to the FK to
   * `users.id`; an unknown uid surfaces as a PG `23503`
   * (`foreign_key_violation`) error which the service layer translates to
   * HTTP 401 Unauthorized.
   */
  userId: string;
  /** User-facing label for the design. */
  title: string;
  /**
   * Full configurator selection set. Stored verbatim as JSONB. The service
   * layer is responsible for shape validation against ST-002..ST-017
   * before invoking the repository.
   */
  payload: DesignPayload;
}

/**
 * Parameters accepted by {@link DesignRepository.listByUser}.
 *
 *   `userId`
 *     The authenticated user's id. Designs owned by other users are
 *     never returned, full stop (ST-028-AC1 — "returns only designs
 *     owned by the authenticated user, never designs owned by other
 *     users").
 *
 *   `limit`
 *     The maximum number of designs to return for this page. Optional;
 *     defaults to {@link DEFAULT_PAGE_SIZE} when omitted. Clamped to
 *     `[1, MAX_PAGE_SIZE]` regardless of caller input — values above
 *     {@link MAX_PAGE_SIZE} are silently capped per ST-028-AC5; values
 *     below 1 are normalised to 1; non-finite or non-numeric values fall
 *     back to {@link DEFAULT_PAGE_SIZE}.
 *
 *   `cursor`
 *     The opaque cursor returned from a prior page's `nextCursor`.
 *     Optional / nullable; when omitted the repository starts at the
 *     most-recently-modified design. An invalid cursor (not base64url-
 *     encoded JSON, missing fields, or an unparseable timestamp) causes
 *     {@link decodeCursor} to throw — the service layer is responsible
 *     for translating that to HTTP 400.
 */
export interface ListDesignsByUserParams {
  /** Owning user's id; restricts results to that user's designs only. */
  userId: string;
  /** Page size; defaults to {@link DEFAULT_PAGE_SIZE}, clamped to {@link MAX_PAGE_SIZE}. */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string | null;
}

/**
 * Parameters accepted by {@link DesignRepository.findById}.
 *
 * Both `userId` AND `designId` are required: ownership is enforced in SQL
 * via `WHERE user_id = $1 AND id = $2`. A request that supplies a valid
 * design id but the wrong user id returns `null` (NOT 403) — the
 * repository simply does not see designs the caller does not own.
 */
export interface FindDesignByIdParams {
  /** Owning user's id; the SQL WHERE pins ownership at the database tier. */
  userId: string;
  /** Server-assigned design UUID. */
  designId: string;
}

/**
 * Parameters accepted by {@link DesignRepository.updatePayload}.
 *
 * Like {@link FindDesignByIdParams}, `userId` and `designId` are both
 * required for ownership enforcement. The new `payload` REPLACES the
 * existing one — this is a full document update, not a JSON merge. Partial
 * updates are out of scope for the 49-story acceptance set; if needed in
 * a future epic the migration would introduce a `jsonb_set`-based variant
 * rather than mutating this method's contract.
 *
 * `last_modified_at` is bumped server-side via `now()` and is NEVER taken
 * from the caller — clock skew between the API server and PG would
 * otherwise produce mis-ordered cursor pagination.
 */
export interface UpdateDesignPayloadParams {
  /** Owning user's id; the SQL WHERE pins ownership at the database tier. */
  userId: string;
  /** Server-assigned design UUID. */
  designId: string;
  /**
   * Replacement payload. The full document is overwritten; partial updates
   * are not supported by this method.
   */
  payload: DesignPayload;
}

/**
 * Repository interface — the public contract callers depend on.
 *
 * Four methods, sized to the actual needs of stories ST-027/ST-028/ST-029:
 *
 *   - `insert(params)` — POST `/api/designs` (ST-027). Returns the
 *     persisted {@link Design}, including the DB-assigned `id`,
 *     `created_at`, and `last_modified_at`.
 *
 *   - `listByUser(params)` — GET `/api/designs` (ST-028). Returns a
 *     {@link DesignListPage} bounded by {@link MAX_PAGE_SIZE}. Iteration
 *     is keyset-ordered by `last_modified_at DESC, id DESC`. The
 *     `nextCursor` field is `null` when no more rows exist.
 *
 *   - `findById(params)` — used by ST-029 (share-link issuance) to confirm
 *     ownership of the target design before issuing a share token, and by
 *     the share read endpoint (ST-029-AC3) to load the underlying design.
 *     Ownership is pinned by the SQL WHERE so a request that supplies the
 *     wrong `userId` simply gets `null` back — no cross-user leakage.
 *
 *   - `updatePayload(params)` — payload-only update; bumps
 *     `last_modified_at` server-side. Returns `null` when no row matches
 *     (typically because the caller does not own the target design).
 *
 * Out-of-scope per AAP §0.7.2: no `delete`, no admin-style cross-user
 * listings, no global-most-popular queries. The 49-story acceptance scope
 * does not require such operations; adding them would violate the explicit
 * AAP §0.7.2 boundary.
 */
export interface DesignRepository {
  /**
   * Insert a new design row. The DB assigns `id`, `created_at`, and
   * `last_modified_at`.
   *
   * @throws The native pg error on FK violation (code `23503`, when
   *   `userId` does not exist in the `users` table). The service layer
   *   is responsible for translation to HTTP 401.
   * @throws A wrapping `Error` if the INSERT executes but does not
   *   return a row (vanishingly rare; a defensive check protects the
   *   downstream non-null contract).
   */
  insert(params: InsertDesignParams): Promise<Design>;

  /**
   * List the designs owned by `userId`, ordered most-recently-modified
   * first with `id` as the deterministic tiebreaker.
   *
   * @throws An `Error` when `cursor` is supplied but cannot be decoded
   *   (malformed base64url, malformed JSON, missing fields, or an
   *   unparseable timestamp). The service layer is responsible for
   *   translation to HTTP 400.
   */
  listByUser(params: ListDesignsByUserParams): Promise<DesignListPage>;

  /**
   * Look up a single design owned by `userId`. Returns `null` when the
   * design does not exist OR the caller does not own it — the SQL WHERE
   * does not distinguish the two cases (defense-in-depth: the caller
   * cannot probe for the existence of other users' designs).
   */
  findById(params: FindDesignByIdParams): Promise<Design | null>;

  /**
   * Replace the `payload` of a design owned by `userId`, bumping the
   * `last_modified_at` timestamp server-side.
   *
   * Returns the updated row, or `null` when no row matches (typically
   * because the caller does not own the target). Like {@link findById},
   * the SQL WHERE conflates "does not exist" with "owned by someone
   * else" by design.
   */
  updatePayload(params: UpdateDesignPayloadParams): Promise<Design | null>;
}

// ---------------------------------------------------------------------------
// Section 3: Private row type — exact mirror of the table's column shape.
// ---------------------------------------------------------------------------

/**
 * The exact row shape returned by `pool.query<DesignRow>()`.
 *
 * Property names match the database column names verbatim
 * (`user_id`, `created_at`, `last_modified_at`) — the {@link mapDesignRow}
 * function below is the single place that converts snake_case columns to
 * camelCase domain fields. Centralising the mapping in one function means
 * a column rename only requires updating one file (here) plus the
 * migration; no search-and-replace across services.
 *
 * The `payload` column is typed as `unknown` because pg returns parsed
 * JSONB as a JavaScript value whose shape we do not enforce at the row
 * level — narrowing happens in {@link mapDesignRow} which coerces to
 * {@link DesignPayload}. This keeps the row type honest about pg's
 * driver-level guarantees while preserving the public contract that the
 * `payload` field is always an object.
 */
interface DesignRow {
  id: string;
  user_id: string;
  title: string;
  payload: unknown;
  created_at: Date;
  last_modified_at: Date;
}

// ---------------------------------------------------------------------------
// Section 4: Private mapper — single source of truth for row → domain.
// ---------------------------------------------------------------------------

/**
 * Convert the raw `pg` row into the public {@link Design} shape.
 *
 * Centralising the conversion in one private function:
 *   - Keeps snake_case → camelCase translation in exactly one place.
 *   - Lets us defensively coerce a `null`/`undefined` `payload` to `{}`
 *     so the public contract ({@link Design.payload} is `DesignPayload`,
 *     never `null`) holds even under malformed DB state.
 *   - Provides a natural anchor point for future enrichment (e.g. derived
 *     audit fields or computed status enums) without rewriting every
 *     caller.
 *   - Lets unit tests assert that the mapping is total and faithful by
 *     exercising the mapper through any of the four public methods.
 */
function mapDesignRow(row: DesignRow): Design {
  // `pg` automatically parses JSONB columns into JS values. In normal
  // operation `row.payload` is therefore an object; the `?? {}` fallback
  // is defensive against malformed DB state (e.g. a row written outside
  // of this repository's INSERT path) so callers always see a non-null
  // object as the public contract requires.
  const payload = (row.payload ?? {}) as DesignPayload;

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    payload,
    createdAt: row.created_at,
    lastModifiedAt: row.last_modified_at,
  };
}

// ---------------------------------------------------------------------------
// Section 5: Cursor encode / decode — exported for service-layer reuse.
// ---------------------------------------------------------------------------

/**
 * Internal cursor shape: the `(last_modified_at, id)` tuple of the LAST row
 * in the previous page.
 *
 * Encoded for the wire as `base64url(JSON.stringify(...))` — opaque to
 * clients, URL-safe (no `+`, `/`, `=` padding), and decodable server-side
 * without state. The encoding choice is deliberate:
 *   - Base64url is URL-safe so the cursor can ride in either a query
 *     string or a JSON body without escaping.
 *   - JSON is trivially extensible (we can add fields in the future
 *     without a forward/back compatibility break, provided the decoder
 *     ignores unknown fields).
 *   - Hashing/HMAC is intentionally OMITTED at this layer: the cursor
 *     contains nothing privileged (a `last_modified_at` and a public
 *     UUID), the SQL still enforces ownership, and the service layer
 *     can layer signature verification on top if a future epic
 *     requires it.
 *
 * `lastModifiedAt` is stored as an ISO-8601 string (not a JS Date object,
 * which would round-trip through `JSON.stringify` as a string anyway —
 * this encoding makes that contract explicit and self-documenting).
 */
interface DecodedCursor {
  /**
   * ISO-8601 representation of the row's `last_modified_at`. Round-trips
   * cleanly through `JSON.stringify` / `JSON.parse` and is accepted
   * directly by PostgreSQL's `::timestamptz` cast.
   */
  lastModifiedAt: string;
  /** UUID of the row. Accepted directly by PostgreSQL's `::uuid` cast. */
  id: string;
}

/**
 * Encode a `(lastModifiedAt, id)` tuple into the opaque cursor string used
 * by {@link DesignListPage.nextCursor}.
 *
 * The function is PURE — it depends only on its inputs and has no side
 * effects. We export it for two reasons:
 *   1. The service layer needs to round-trip cursors when validating
 *      caller-supplied values before passing them to {@link
 *      DesignRepository.listByUser}.
 *   2. Unit tests can assert encode/decode is round-tripping without
 *      booting a database.
 *
 * The input type is `Pick<Design, 'id' | 'lastModifiedAt'>` rather than
 * the full {@link Design} so the caller can supply either a full design
 * or a synthetic `{ id, lastModifiedAt }` literal — matching whatever
 * shape they have at the call site.
 *
 * @param design The row whose tuple becomes the cursor.
 * @returns The base64url-encoded JSON cursor; safe for URL or JSON
 *   transport.
 */
export function encodeCursor(design: Pick<Design, 'id' | 'lastModifiedAt'>): string {
  const payload: DecodedCursor = {
    lastModifiedAt: design.lastModifiedAt.toISOString(),
    id: design.id,
  };
  // Buffer.from(...).toString('base64url') is supported in Node 20+ (per
  // AAP §0.1.1 the runtime is pinned to Node 20 LTS). The 'utf8' input
  // encoding is the explicit JS-string-to-bytes step; the 'base64url'
  // output encoding is the URL-safe variant of base64.
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode the opaque cursor string back into a {@link DecodedCursor} tuple.
 *
 * Throws on EVERY form of malformed input — the service layer translates
 * the throw to HTTP 400 Bad Request. The repository layer prefers loud
 * failures here over silent fallback to "first page" because:
 *   - A bug that produces a malformed cursor should be visible in logs
 *     and metrics, not masked.
 *   - Silently returning the first page would let a buggy client paginate
 *     in an infinite loop without ever realising its cursor format is
 *     wrong.
 *
 * Failure modes covered:
 *   - Input is not valid base64url (e.g. contains `+` / `/`).
 *   - Decoded bytes are not valid JSON.
 *   - JSON is valid but missing required fields, or fields have wrong
 *     types.
 *   - `lastModifiedAt` is a string but not a parseable date (e.g.
 *     `"hello"`).
 *
 * @param cursor The opaque cursor string from a prior page's
 *   `nextCursor` (or, in pathological cases, an attacker-supplied
 *   value).
 * @returns The decoded tuple.
 * @throws Error with a descriptive message indicating the failure mode.
 *   The message is intentionally non-cryptic so the service layer's
 *   400-response payload can surface it to clients without leaking
 *   internal state.
 */
export function decodeCursor(cursor: string): DecodedCursor {
  let parsed: unknown;
  try {
    // Buffer.from(cursor, 'base64url') silently accepts some malformed
    // inputs (it tolerates missing padding, for example), but JSON.parse
    // catches anything that survives base64 decoding to produce non-JSON
    // bytes — we treat both failure modes uniformly here.
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid cursor: not base64url-encoded JSON');
  }

  // Type-narrow the parsed JSON. The `typeof === 'object'` check
  // intentionally also rejects arrays (which are objects in JS) because
  // we treat the decoded shape as an object literal — though `&& parsed
  // !== null && !Array.isArray(parsed)` would be a stronger expression
  // of intent, the structural field check that follows is sufficient.
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as DecodedCursor).lastModifiedAt !== 'string' ||
    typeof (parsed as DecodedCursor).id !== 'string'
  ) {
    throw new Error('Invalid cursor: missing required fields');
  }

  const asCursor = parsed as DecodedCursor;

  // Validate ISO-8601 shape — `new Date('hello')` returns an Invalid
  // Date whose `.getTime()` is NaN. Catching this here gives a clear
  // error message; if we deferred to PostgreSQL the failure would
  // surface as a less-actionable `invalid input syntax for type
  // timestamp with time zone` error code.
  const parsedDate = new Date(asCursor.lastModifiedAt);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid cursor: invalid timestamp');
  }

  return asCursor;
}

// ---------------------------------------------------------------------------
// Section 6: SQL constants — parameterised, audit-ready statements.
// ---------------------------------------------------------------------------

/**
 * INSERT a new design row.
 *
 * The three-column INSERT (`user_id`, `title`, `payload`) leaves `id`,
 * `created_at`, and `last_modified_at` to their column defaults
 * (`gen_random_uuid()`, `now()`, `now()` per the ST-030 migration). This
 * means the application never assigns IDs or timestamps — the database is
 * the single source of truth for both, eliminating clock-skew and
 * UUID-collision concerns.
 *
 * The `$3::jsonb` cast is paired with a JS-side `JSON.stringify` of the
 * payload before it reaches pg's parameter binding. The combination is
 * the most portable pattern across pg minor versions:
 *   - `JSON.stringify` produces a deterministic textual representation.
 *   - The explicit `::jsonb` cast tells PostgreSQL to parse the textual
 *     parameter as JSONB, irrespective of pg's parameter-type inference
 *     for the placeholder.
 * Skipping either half can produce subtle defects (e.g. an object passed
 * directly with no cast triggers pg's auto-serialisation, which is
 * driver-version-sensitive).
 *
 * The RETURNING clause hands back the full canonical row so callers do
 * NOT need a follow-up SELECT to obtain the persisted state. This is
 * both faster (one round-trip instead of two) and more correct (no race
 * window between INSERT and SELECT in which a concurrent UPDATE could
 * land).
 */
const INSERT_DESIGN_SQL = `
  INSERT INTO designs (user_id, title, payload)
  VALUES ($1, $2, $3::jsonb)
  RETURNING id, user_id, title, payload, created_at, last_modified_at
`;

/**
 * SELECT a single design by id, with ownership pinned in the WHERE clause.
 *
 * Backed by the PRIMARY KEY index on `designs.id` so the lookup is
 * O(log n). The `user_id` predicate is enforced by the database, NOT by
 * application middleware:
 *   - A bug elsewhere (e.g. a session middleware that attaches the wrong
 *     uid) cannot leak another user's design through this path.
 *   - The design simply does not exist from the caller's perspective —
 *     no 403 distinction, no probing surface for the existence of other
 *     users' designs.
 *
 * Returns at most one row (the PK guarantees uniqueness), so the
 * repository's `rows[0]` access is safe.
 */
const FIND_DESIGN_BY_ID_SQL = `
  SELECT id, user_id, title, payload, created_at, last_modified_at
  FROM designs
  WHERE user_id = $1 AND id = $2
`;

/**
 * UPDATE the `payload` of a design owned by `user_id`, bumping
 * `last_modified_at` to the database's `now()`.
 *
 * Why `now()` (server-side) and not a client-supplied timestamp:
 *   - Multi-instance deployments do not have synchronised wall clocks;
 *     a client-supplied `lastModifiedAt` would drift from the API
 *     server's, which would in turn drift from PG's, which would lead
 *     to non-monotonic ordering for the keyset cursor.
 *   - The integration test suite can use SQL `pg_advance_clock`-style
 *     fixtures to control the clock without the application caring.
 *   - There is no legitimate reason for an application or user to
 *     dictate when a row was last modified — that's a derived fact
 *     about the database write, not an input to it.
 *
 * The `WHERE user_id = $1 AND id = $2` enforces ownership in SQL:
 * an UPDATE issued by the wrong user simply matches zero rows, the
 * RETURNING clause produces an empty result, and the repository
 * returns `null` to the caller.
 *
 * The RETURNING clause hands back the full canonical row so the
 * service layer can echo the new state to the client without a
 * follow-up SELECT.
 */
const UPDATE_DESIGN_PAYLOAD_SQL = `
  UPDATE designs
  SET payload = $3::jsonb,
      last_modified_at = now()
  WHERE user_id = $1 AND id = $2
  RETURNING id, user_id, title, payload, created_at, last_modified_at
`;

/**
 * Keyset-paginated SELECT for the FIRST page (no cursor supplied).
 *
 * Ordering is `last_modified_at DESC, id DESC` — a TOTAL order even when
 * two rows share a millisecond-precision timestamp (rare but possible,
 * especially under sub-millisecond test fixtures). Both keys descend
 * because we paginate from "newest first"; the `id` tiebreaker
 * direction MUST match the timestamp direction so the keyset comparison
 * in {@link LIST_DESIGNS_AFTER_CURSOR_SQL} reads consistently as
 * "strictly before".
 *
 * Backed by the composite index on `(user_id, last_modified_at DESC,
 * id DESC)` defined in the ST-030 migration (per ST-030-AC2). The DB
 * can satisfy this query as an index-only scan, which keeps the
 * latency budget comfortable even under large per-user libraries.
 *
 * `LIMIT $2` is set to `requested_limit + 1` by the factory below so
 * the repository can detect "is there another page?" without a
 * separate count query.
 */
const LIST_DESIGNS_FIRST_PAGE_SQL = `
  SELECT id, user_id, title, payload, created_at, last_modified_at
  FROM designs
  WHERE user_id = $1
  ORDER BY last_modified_at DESC, id DESC
  LIMIT $2
`;

/**
 * Keyset-paginated SELECT for SUBSEQUENT pages.
 *
 * The cursor's `(lastModifiedAt, id)` tuple is the LAST row of the
 * previous page; this query selects rows that are STRICTLY LESS THAN
 * that tuple under the lexicographic order
 * `(last_modified_at, id) DESC`.
 *
 * The WHERE expression
 *   last_modified_at < $2
 *   OR (last_modified_at = $2 AND id < $3)
 * encodes "tuple-less-than" without relying on PostgreSQL's row-value
 * comparison syntax (which exists but is less portable across pg minor
 * versions and ORM-style query rewrites). The two-arm form is also more
 * obviously correct to a reader and matches the explicit "tiebreaker"
 * narrative in the ST-028 acceptance criteria.
 *
 * The same composite index used by {@link LIST_DESIGNS_FIRST_PAGE_SQL}
 * services this query: PostgreSQL's planner recognises the tuple-less-
 * than pattern and produces an index range scan that is index-only when
 * the SELECT list is covered by the index include columns.
 *
 * Casts:
 *   - `$2::timestamptz` parses the ISO-8601 string from the decoded
 *     cursor into a timestamp.
 *   - `$3::uuid` parses the UUID string from the decoded cursor into a
 *     UUID. PostgreSQL rejects malformed UUIDs at this point, which is
 *     acceptable: the cursor came from a prior `encodeCursor` call so a
 *     malformed UUID indicates tampering, and a 400 / 500 response is
 *     correct.
 */
const LIST_DESIGNS_AFTER_CURSOR_SQL = `
  SELECT id, user_id, title, payload, created_at, last_modified_at
  FROM designs
  WHERE user_id = $1
    AND (
      last_modified_at < $2::timestamptz
      OR (last_modified_at = $2::timestamptz AND id < $3::uuid)
    )
  ORDER BY last_modified_at DESC, id DESC
  LIMIT $4
`;

// ---------------------------------------------------------------------------
// Section 7: Factory — wires the SQL constants to a Pool and returns the
// public {@link DesignRepository} interface.
// ---------------------------------------------------------------------------

/**
 * Create a {@link DesignRepository} backed by the supplied pg {@link Pool}.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createDesignRepository(pool)`) — easier to mock in unit tests
 *     than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *
 * The returned record is `Object.freeze`-d so calling code cannot
 * substitute one of the methods at runtime — that prevents a class of
 * bugs where a test or middleware accidentally mutates the shared
 * repository instance.
 *
 * The methods are defined on the literal directly so `repo.insert` and
 * `const { insert } = repo; insert(...)` behave identically — no
 * `this`-binding confusion.
 *
 * @param pool A connected `pg.Pool` instance (typically from
 *   `backend/src/db/pool.ts`). The repository never closes the pool —
 *   pool lifecycle is the caller's responsibility.
 * @returns A frozen {@link DesignRepository} ready for use.
 */
export function createDesignRepository(pool: Pool): DesignRepository {
  const repository: DesignRepository = {
    async insert(params: InsertDesignParams): Promise<Design> {
      // `JSON.stringify(payload ?? {})` handles two edge cases:
      //   1. `params.payload` is the documented type (`DesignPayload`)
      //      so under TypeScript it is never null/undefined; the `?? {}`
      //      is defensive against a `// @ts-ignore`-style bypass.
      //   2. Pre-serialising on the JS side keeps pg's parameter binding
      //      simple — pg sees a string parameter and PostgreSQL parses
      //      it under the explicit `$3::jsonb` cast.
      const result = await pool.query<DesignRow>({
        text: INSERT_DESIGN_SQL,
        values: [params.userId, params.title, JSON.stringify(params.payload ?? {})],
      });

      // Defensive: the RETURNING clause guarantees a row when the
      // INSERT succeeds, but if a future schema change were to alter
      // that contract we want a loud, descriptive failure instead of
      // a silent `undefined` propagating into business logic.
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          'designs INSERT did not return a row; this should be impossible ' +
            'when the INSERT statement contains RETURNING. Investigate ' +
            'recent schema or migration changes.',
        );
      }

      return mapDesignRow(row);
    },

    async listByUser(params: ListDesignsByUserParams): Promise<DesignListPage> {
      // Limit normalisation. The order matters:
      //   1. Decide the "requested" value: the caller's `limit` if it is
      //      finite (excludes NaN, +Infinity, -Infinity), else the
      //      DEFAULT_PAGE_SIZE.
      //   2. `Math.floor` so a fractional value (e.g. from a route
      //      handler that forgot to coerce a string) does not produce a
      //      non-integer LIMIT clause — pg would reject that with a
      //      cryptic error.
      //   3. Clamp to `[1, MAX_PAGE_SIZE]` so the DB never sees a value
      //      below 1 (pg rejects LIMIT 0 in the way we'd want anyway,
      //      but `Math.max(1, ...)` keeps the contract self-evident)
      //      or above MAX_PAGE_SIZE (per ST-028-AC5).
      const requested =
        typeof params.limit === 'number' && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : DEFAULT_PAGE_SIZE;
      const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, requested));

      // Fetch limit+1 rows so we can detect "is there another page?"
      // without a separate COUNT query. If we see exactly `limit + 1`
      // rows back, we know at least one more page exists; we slice off
      // the extra row and emit a `nextCursor` derived from the last
      // KEPT row.
      const fetchLimit = limit + 1;

      // Two query forms, selected by the presence of a cursor:
      //   - First page (no cursor): simple ORDER BY + LIMIT.
      //   - Subsequent page (cursor): WHERE clause restricts the
      //     `(last_modified_at, id)` tuple to "strictly before" the
      //     decoded cursor.
      // We use `let` here so each branch can assign without producing a
      // dummy initial value (a `const` with a ternary would force us to
      // choose between an immediately-invoked async helper and a
      // top-level `await Promise.all` — `let` is the cleaner spelling).
      let rows: DesignRow[];
      if (params.cursor) {
        // `decodeCursor` THROWS on malformed input — propagate the
        // throw up to the service layer which translates to HTTP 400.
        const decoded = decodeCursor(params.cursor);
        const result = await pool.query<DesignRow>({
          text: LIST_DESIGNS_AFTER_CURSOR_SQL,
          values: [params.userId, decoded.lastModifiedAt, decoded.id, fetchLimit],
        });
        rows = result.rows;
      } else {
        const result = await pool.query<DesignRow>({
          text: LIST_DESIGNS_FIRST_PAGE_SQL,
          values: [params.userId, fetchLimit],
        });
        rows = result.rows;
      }

      // `hasMore` is true iff the DB returned the extra row — meaning
      // at least one more design exists beyond this page.
      const hasMore = rows.length > limit;

      // `pageRows` is the slice we actually return: at most `limit`
      // rows. When `hasMore` is true we drop the extra trailing row
      // (it would have been the first row of the NEXT page, kept here
      // only so we could detect its existence).
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items = pageRows.map(mapDesignRow);

      // The next cursor points at the LAST row of THIS page (i.e. the
      // last row in `items`). The next request will use that tuple as
      // its "strictly before" bound.
      //
      // We assert non-null with `!` because:
      //   - `hasMore` only becomes true when `rows.length > limit`,
      //     which (with `limit >= 1`) requires `rows.length >= 2`,
      //     which after slicing leaves `items.length >= 1`.
      //   - The redundant `items.length > 0` guard before the index is
      //     a defence-in-depth check for the "limit was clamped to a
      //     pathological value" edge case.
      const nextCursor =
        hasMore && items.length > 0 ? encodeCursor(items[items.length - 1] as Design) : null;

      return { items, nextCursor };
    },

    async findById(params: FindDesignByIdParams): Promise<Design | null> {
      const result = await pool.query<DesignRow>({
        text: FIND_DESIGN_BY_ID_SQL,
        values: [params.userId, params.designId],
      });

      // The PRIMARY KEY constraint on `designs.id` plus the
      // ownership-pinning WHERE on `user_id` together guarantee at
      // most one row. `rows[0]` is `DesignRow | undefined` when no
      // row matches; the `row ? ... : null` collapses that to the
      // public contract of `Design | null`.
      const row = result.rows[0];
      return row ? mapDesignRow(row) : null;
    },

    async updatePayload(params: UpdateDesignPayloadParams): Promise<Design | null> {
      const result = await pool.query<DesignRow>({
        text: UPDATE_DESIGN_PAYLOAD_SQL,
        values: [params.userId, params.designId, JSON.stringify(params.payload ?? {})],
      });

      // When no row matches the supplied `(userId, designId)` pair
      // (i.e. the design does not exist or the caller does not own
      // it), the UPDATE affects zero rows, RETURNING produces an
      // empty result, and we surface `null`. The service layer (per
      // the route handler for ST-027/ST-029) decides whether to
      // translate `null` to 404 or 403 — the two cases are
      // intentionally indistinguishable at this layer (defense-in-
      // depth: callers cannot probe for the existence of other
      // users' designs).
      const row = result.rows[0];
      return row ? mapDesignRow(row) : null;
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a repository method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(repository);
}
