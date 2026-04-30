/**
 * Share-link repository — data-access layer for the `share_links` table.
 *
 * This module owns every direct read or write of the `share_links` table.
 * Higher layers (services, routes) depend ONLY on the typed
 * {@link ShareLinkRepository} interface — they do not import `pg` and do
 * not know any SQL. Co-locating SQL with its schema knowledge keeps
 * migration changes localised and makes the layer trivially mockable in
 * unit tests.
 *
 * Authority:
 *   - AAP §0.3.3 "New Files to Create — Backend":
 *       `backend/src/repositories/share-link.repository.ts | CRUD for
 *        share-link persistence`
 *   - AAP §0.6.4 Track 1 T1-C: repositories belong to the dependency-
 *     ordered backend API implementation.
 *   - Story ST-029 (share-link issuance endpoint — primary consumer).
 *   - Story ST-030 (designs schema migration — defines the parent
 *     `designs` table that this repository's `design_id` FK references).
 *
 * Architectural intent (AAP §0.2.1 "Share-link read-side access"):
 *   Share links are the unauthenticated read path: visiting a share link
 *   returns enough information for the configurator to render the target
 *   design read-only without signing in. The repository's job is the
 *   minimal mechanical CRUD that makes that flow work:
 *
 *     - INSERT a row when an authenticated owner asks for a link.
 *     - SELECT-with-JOIN by token so the unauthenticated `/api/share/:token`
 *       route can hand the design payload to the read-only renderer.
 *     - UPDATE to mark all of a design's active links revoked when the
 *       owner asks to revoke or when the service layer enforces a policy.
 *
 *   The repository deliberately does NOT:
 *     - Generate tokens. Token generation lives in the service layer
 *       (`backend/src/services/share-link.service.ts`) which uses
 *       `crypto.randomBytes(32).toString('base64url')` for 256 bits of
 *       URL-safe entropy. The repository receives a fully-formed token
 *       as an input.
 *     - Evaluate expirations. Whether a link has expired is a business
 *       decision computed by the service layer against the row's
 *       `expiresAt` field. The repository simply stores and returns
 *       the timestamp.
 *     - Enforce ownership for `findByToken`. Visiting a share link is
 *       an UNAUTHENTICATED operation by design (ST-029-AC3), so the
 *       lookup intentionally has no `WHERE owner_uid = $X` filter; the
 *       expiration / revocation gates are the access control here.
 *     - Authorise revocation. The service layer is responsible for
 *       confirming the caller owns the design before invoking
 *       `revoke({ designId, ownerUid })`; the repository's WHERE clause
 *       on `owner_uid` is defense-in-depth, not the primary check.
 *
 * Token-handling discipline (Rule R2 — no credential material in logs):
 *   The `token` column is cryptographically-random material that grants
 *   read-only access to a design. Treating it as credential-like is the
 *   conservative default:
 *     - This module NEVER logs. Period. There is no `pino`, no
 *       `console.*`, no `logger.*` import anywhere in this file.
 *     - Errors propagate as native pg errors plus a small number of
 *       defensive `Error` throws — none of which embed token text.
 *     - Tokens never appear in error messages, exception strings, or any
 *       diagnostic surface emitted by this module.
 *
 * Idempotent-revocation semantics:
 *   The `revoke` UPDATE filters with `revoked_at IS NULL`, which:
 *     - Keeps the FIRST revocation timestamp intact when revoke is
 *       called twice (we never overwrite an existing `revoked_at`).
 *     - Lets `revokedCount` honestly report only the rows whose state
 *       actually transitioned active→revoked in this call.
 *     - Makes the operation safe under retry semantics (e.g. a network
 *       blip between the API server and PG that causes the service
 *       layer to retry).
 *
 * Rule compliance (verbatim from AAP §0.8.1):
 *   - R2 (no credential material in logs): this repository never logs
 *     and never accepts logger references. Tokens are treated as
 *     credential-like material — they never appear in error messages
 *     or any other diagnostic surface.
 *   - R3 (Firebase Admin SDK only): this module imports nothing from
 *     `jsonwebtoken`, `jose`, or `jwt-decode`. Token generation is the
 *     exclusive responsibility of the service layer using
 *     `crypto.randomBytes`; this module never invokes any token-
 *     generation primitive.
 *   - R4 (no env defaults in source): this module reads NO environment
 *     variables. The {@link Pool} is dependency-injected by the caller
 *     (`backend/src/db/pool.ts` builds the pool from `DATABASE_URL`).
 *   - R8 (gates fail closed): query errors propagate as thrown errors;
 *     no silent success on DB errors. The defensive `Error` thrown when
 *     INSERT does not return a row is itself a fail-closed posture.
 *   - R9 (no payment processing): N/A here; this module manages
 *     share-link persistence only.
 *   - R10 (migration filename pattern): N/A here; this module is
 *     consumed by — but does not author — the migration that creates
 *     the `share_links` table.
 *
 * Design discipline:
 *   - Parameterised queries only. Every SQL constant uses `$1`, `$2`
 *     placeholders; user-supplied values flow through the `values` array
 *     of the `QueryConfig`. There is no string interpolation of input
 *     anywhere in this file (SQL-injection invariant).
 *   - The repository is constructed via a factory
 *     (`createShareLinkRepository`) rather than as a class. Factories
 *     make dependency injection explicit at the call site, support
 *     `Object.freeze` of the returned record (preventing accidental
 *     method monkey-patching), and play well with tree-shaking.
 *   - Mapper functions are PRIVATE: `ShareLinkRow` and
 *     `ShareLinkWithDesignRow` are never exported. Public types are
 *     {@link ShareLink} and {@link ShareLinkWithDesign} in camelCase.
 *
 * Coordination (AAP §0.6.4 Track 1):
 *   - `backend/src/db/pool.ts` — provides the `Pool` injected here.
 *   - `backend/src/repositories/design.repository.ts` — exports the
 *     {@link Design} TYPE that this repository borrows for the JOIN
 *     result. This creates a one-way dependency:
 *     share-link.repository → design.repository (the Design TYPE is
 *     borrowed; no business logic is shared between the two
 *     repositories).
 *   - `backend/src/services/share-link.service.ts` — primary consumer;
 *     generates tokens, validates expiration, orchestrates revocation.
 *   - `backend/src/routes/designs.ts` — POST `/api/designs/:id/share-link`
 *     authoring endpoint flows through the service layer into `insert`.
 *   - `backend/src/routes/share.ts` — unauthenticated GET `/api/share/:token`
 *     endpoint flows through the service layer into `findByToken`.
 *   - `backend/migrations/{ts}_*.js` — defines the `share_links` table
 *     and its indexes (notably the partial index on
 *     `(design_id, owner_uid) WHERE revoked_at IS NULL` that backs the
 *     `revoke` UPDATE).
 */

// Type-only import — required by the `@typescript-eslint/consistent-type-
// imports` ESLint rule. The `Pool` type is used solely as the
// `createShareLinkRepository(pool: Pool)` factory parameter; the actual
// runtime instance is injected by the composition root.
import type { Pool } from 'pg';

// Type-only import — borrowing the `Design` interface from the design
// repository so that `findByToken`'s JOIN result is strongly typed. This
// is a TYPE-ONLY dependency: no design-repository runtime code is
// imported, executed, or referenced. Rebuilding the design payload from
// the JOINed columns is intentional rather than calling
// `findById(designId)` so the share-link route runs in a single DB
// round-trip.
import type { Design } from './design.repository';

// ---------------------------------------------------------------------------
// Section 1: Public types — domain shape exposed to higher layers.
// ---------------------------------------------------------------------------

/**
 * A share-link record as returned by this repository.
 *
 * Field-level contract (the API every consumer of this module relies on):
 *
 *   `token`
 *     The cryptographically-random URL-safe string that uniquely
 *     identifies this share link. Generated by the service layer via
 *     `crypto.randomBytes(32).toString('base64url')` (256 bits of
 *     entropy, ~43 characters, non-enumerable). It is the PRIMARY KEY
 *     of the `share_links` table — the column choice is deliberate
 *     because token uniqueness is the integrity invariant the repository
 *     can rely on at the database tier.
 *
 *   `designId`
 *     UUID of the design that this share link points to. Backed by a
 *     foreign key to `designs.id` with `ON DELETE CASCADE` so that
 *     deleting a design cleanly removes its share links (relevant for
 *     test teardown and privacy compliance).
 *
 *   `ownerUid`
 *     The Firebase uid of the user who issued this share link — kept
 *     for audit purposes and for the bulk-revoke filter on
 *     {@link ShareLinkRepository.revoke}. NOT used for ownership
 *     enforcement on read (visiting a share link is unauthenticated by
 *     design — ST-029-AC3), only for revocation scoping.
 *
 *   `issuedAt`
 *     The DB-assigned creation timestamp. Set by the column default
 *     (`now()`) so the application never thinks about clock skew.
 *
 *   `expiresAt`
 *     The instant after which the share link must no longer be
 *     considered valid. The service layer COMPUTES this value from a
 *     policy-driven duration (per ST-029-AC2 — "each issued share link
 *     carries a documented expiration") and PERSISTS it; this repository
 *     simply stores what it is told.
 *
 *   `revokedAt`
 *     `null` for active share links; non-null for revoked links. The
 *     timestamp captures the moment of FIRST revocation —
 *     {@link ShareLinkRepository.revoke}'s `WHERE revoked_at IS NULL`
 *     filter ensures subsequent revoke calls do NOT overwrite the
 *     original timestamp.
 *
 * The interface is fully `readonly` so consumers cannot mutate the
 * record after retrieval. To "update" a share link, callers must go
 * through repository methods that explicitly construct a new row —
 * making every mutation a deliberate database write rather than an
 * in-memory side-effect.
 */
export interface ShareLink {
  /** Cryptographically-random URL-safe token; primary key. */
  readonly token: string;
  /** Foreign key to `designs.id`. */
  readonly designId: string;
  /** Firebase uid of the user who issued this share link (audit trail). */
  readonly ownerUid: string;
  /** DB-assigned creation timestamp. */
  readonly issuedAt: Date;
  /** Expiration timestamp; readers reject when `now() > expiresAt`. */
  readonly expiresAt: Date;
  /** `null` for active share links; the FIRST revocation timestamp otherwise. */
  readonly revokedAt: Date | null;
}

/**
 * A share-link record JOINed with the underlying design, as returned by
 * {@link ShareLinkRepository.findByToken}.
 *
 * Used by the unauthenticated `/api/share/:token` route to render
 * read-only design data per ST-029-AC3 ("visiting a valid, unexpired
 * share link returns enough information for the configurator to render
 * the target design read-only without signing in"). The single-query
 * JOIN means the route handler does NOT need to call `findById` after
 * resolving the token — saving a database round-trip on the read path.
 *
 * The `design` field is typed `Design | null` for defensive symmetry
 * with the LEFT JOIN: although the foreign key constraint with
 * `ON DELETE CASCADE` in practice means a non-null share link always
 * has a matching design row, modelling the JOIN faithfully (LEFT, not
 * INNER) protects against schema drift and makes the repository's
 * behaviour predictable if the FK is ever relaxed in a future
 * migration.
 *
 * The interface `extends ShareLink` rather than duplicating fields so
 * a single source of truth governs the shape of the share link itself —
 * adding a column to `ShareLink` automatically widens
 * `ShareLinkWithDesign` without further changes here.
 */
export interface ShareLinkWithDesign extends ShareLink {
  /**
   * Full design record for read-only rendering. `null` would only occur
   * if the JOIN found no matching `designs` row — a vanishingly rare
   * defensive edge case the consumer should treat as a documented
   * error state per ST-029-AC2.
   */
  readonly design: Design | null;
}

/**
 * Parameters accepted by {@link ShareLinkRepository.insert}.
 *
 * Notice what is NOT here:
 *   - No `issuedAt`. The column defaults to `now()` in the migration
 *     so the application never has to think about clock skew between
 *     the API server and PG.
 *   - No `revokedAt`. New share links are always active at insert time;
 *     the column defaults to `NULL`.
 *
 * The shape is intentionally minimal: the smallest set of values that
 * uniquely defines a new share-link row.
 */
export interface InsertShareLinkParams {
  /**
   * Cryptographically-random URL-safe token generated by the service
   * layer. Subject to the PRIMARY KEY constraint; vanishingly rare
   * collisions surface as PG `23505` (`unique_violation`).
   */
  token: string;
  /**
   * UUID of the design this link points to. Subject to the FK to
   * `designs.id`; an unknown id surfaces as PG `23503`
   * (`foreign_key_violation`) which the service layer translates to
   * HTTP 404 Not Found.
   */
  designId: string;
  /**
   * Firebase uid of the user issuing the link. The service layer is
   * responsible for confirming this uid OWNS the design before invoking
   * `insert`; this repository does not double-check.
   */
  ownerUid: string;
  /**
   * Expiration timestamp. Computed by the service layer (typically as
   * `now() + policy-defined duration`) and stored verbatim. Per
   * ST-029-AC2, the expiration MUST be documented; the repository does
   * not enforce a min/max.
   */
  expiresAt: Date;
}

/**
 * Parameters accepted by {@link ShareLinkRepository.revoke}.
 *
 * Both `designId` AND `ownerUid` are required: the bulk-revoke is
 * scoped to a single (design, owner) tuple. This shape supports the
 * primary use case ("revoke all active share links the owner has
 * issued for this design") while preventing two anti-patterns:
 *   - Cross-user revocation: a request scoped only by `designId` would
 *     let one user revoke share links issued by another user (in the
 *     edge case where two owners somehow shared a design — currently
 *     impossible, but worth structurally preventing).
 *   - Owner-wide revocation: a request scoped only by `ownerUid` would
 *     revoke all share links the owner has ever issued, across all
 *     their designs — far broader than the documented use cases.
 */
export interface RevokeShareLinkParams {
  /** UUID of the design whose links are being revoked. */
  designId: string;
  /** Firebase uid of the owner whose links are being revoked. */
  ownerUid: string;
}

/**
 * Result of a bulk revoke operation.
 *
 * The `revokedCount` is the number of rows whose state transitioned
 * from active → revoked in THIS call (i.e. rows that matched
 * `(design_id, owner_uid)` AND had `revoked_at IS NULL` BEFORE the
 * UPDATE). The count is therefore strictly informational from the
 * service layer's perspective — a value of 0 means the (design,
 * owner) tuple had no active share links, which is a perfectly valid
 * state and not an error.
 *
 * Modelled as an interface (rather than a bare `number`) so future
 * additions (e.g. an array of revoked tokens for audit logging) can
 * extend the shape without breaking the public contract.
 */
export interface RevokeShareLinkResult {
  /**
   * Number of rows that transitioned from active to revoked in this
   * call. Zero is a valid result that simply means no active share
   * links matched the supplied (designId, ownerUid) tuple.
   */
  readonly revokedCount: number;
}

/**
 * Repository interface — the public contract callers depend on.
 *
 * Three methods, sized to the actual needs of story ST-029:
 *
 *   - `insert(params)` — POST `/api/designs/:id/share-link` (ST-029).
 *     Returns the persisted {@link ShareLink}, including the
 *     DB-assigned `issuedAt`. Throws on PRIMARY KEY collision (PG
 *     `23505`) and on foreign-key violation (PG `23503`); the service
 *     layer is responsible for translating those to HTTP statuses.
 *
 *   - `findByToken(token)` — GET `/api/share/:token` (ST-029-AC3).
 *     Returns a {@link ShareLinkWithDesign} including the full
 *     embedded design payload, in a SINGLE database round-trip. Returns
 *     `null` when no row matches the supplied token (the service layer
 *     translates that to HTTP 404). The expiration / revocation checks
 *     are the SERVICE layer's responsibility — the repository simply
 *     returns whatever is in storage.
 *
 *   - `revoke(params)` — bulk revocation (ST-029-AC4). Marks all active
 *     share links for the (design, owner) tuple as revoked, idempotently.
 *     Returns the number of rows that transitioned active→revoked in
 *     THIS call.
 *
 * Out-of-scope per AAP §0.7.2: no list/paginate methods, no admin-style
 * cross-user listings, no token-rotation flows. The 49-story acceptance
 * scope does not require such operations; adding them would violate the
 * explicit AAP §0.7.2 boundary.
 */
export interface ShareLinkRepository {
  /**
   * Insert a new share-link row. The DB assigns `issuedAt`.
   *
   * @throws The native pg error on PRIMARY KEY collision (code `23505`)
   *   or foreign-key violation (code `23503`). The service layer is
   *   responsible for translation to HTTP statuses.
   * @throws A wrapping `Error` if the INSERT executes but does not
   *   return a row (vanishingly rare; a defensive check protects the
   *   downstream non-null contract).
   */
  insert(params: InsertShareLinkParams): Promise<ShareLink>;

  /**
   * Look up a share link by its token, JOINing through to the
   * underlying design so the consumer can render the design read-only
   * in a single round-trip.
   *
   * Returns `null` when no row matches the supplied token. Does NOT
   * filter on expiration or revocation — the consumer (typically the
   * service layer) is responsible for evaluating those state checks
   * after retrieval, so that the repository can support both "render
   * if valid" (active) and "produce a clear error message" (expired
   * / revoked) without duplicate queries.
   *
   * Backed by the PRIMARY KEY index on `share_links.token`, so the
   * lookup is O(log n) regardless of table size.
   */
  findByToken(token: string): Promise<ShareLinkWithDesign | null>;

  /**
   * Mark every active share link for the supplied (designId, ownerUid)
   * tuple as revoked. Idempotent — already-revoked links are filtered
   * out by the `revoked_at IS NULL` predicate so their original
   * `revoked_at` timestamp is preserved.
   *
   * Returns the number of rows that transitioned active→revoked in
   * THIS call. A return value of 0 is NOT an error; it simply means
   * the tuple had no active share links.
   */
  revoke(params: RevokeShareLinkParams): Promise<RevokeShareLinkResult>;
}

// ---------------------------------------------------------------------------
// Section 2: Private row types — exact mirrors of the table column shapes.
// ---------------------------------------------------------------------------

/**
 * The exact row shape returned by `pool.query<ShareLinkRow>()` for the
 * INSERT and (the share-link half of the) SELECT statements.
 *
 * Property names match the database column names verbatim
 * (`design_id`, `owner_uid`, `issued_at`, `expires_at`, `revoked_at`) —
 * the {@link mapShareLinkRow} function below is the single place that
 * converts snake_case columns to camelCase domain fields. Centralising
 * the mapping in one function means a column rename only requires
 * updating one file (here) plus the migration; no search-and-replace
 * across services.
 *
 * This type is deliberately NOT exported. The public type that
 * describes the same shape is {@link ShareLink}, which uses camelCase
 * field names and is the contract every consumer depends on.
 */
interface ShareLinkRow {
  token: string;
  design_id: string;
  owner_uid: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * The exact row shape returned by `pool.query<ShareLinkWithDesignRow>()`
 * for the JOIN-bearing FIND_BY_TOKEN_SQL.
 *
 * Inherits the `share_links` columns from {@link ShareLinkRow} and adds
 * the `designs`-table columns prefixed with `design_` — the prefix is
 * applied via SQL `AS` aliases in the SELECT list so the column-name
 * collision (`share_links.design_id` vs `designs.id`) is resolved at
 * the SQL layer, not in JavaScript.
 *
 * The `design_payload` column is typed as `unknown` because pg returns
 * parsed JSONB as a JavaScript value whose shape we do not enforce at
 * the row level — narrowing happens in
 * {@link mapShareLinkWithDesignRow}, which coerces to
 * {@link Design.payload} (= `DesignPayload` in the design-repository
 * module). This keeps the row type honest about pg's driver-level
 * guarantees while preserving the public contract.
 *
 * The `design_*` columns are typed as nullable scalars (the JOIN is
 * LEFT JOIN, so the design row may be absent) but in practice the FK
 * constraint with `ON DELETE CASCADE` ensures they are always present
 * for any non-revoked share link. The mapper handles the absence path
 * defensively.
 */
interface ShareLinkWithDesignRow extends ShareLinkRow {
  /** Title from the JOINed designs row; `null` if no matching design. */
  design_title: string | null;
  /**
   * Payload (JSONB) from the JOINed designs row; `null` if no matching
   * design. Typed as `unknown` because pg returns parsed JSONB as a
   * JavaScript value whose shape we do not enforce at the row level.
   */
  design_payload: unknown;
  /** Owning user from the JOINed designs row; `null` if no matching design. */
  design_user_id: string | null;
  /** Creation timestamp from the JOINed designs row; `null` if no match. */
  design_created_at: Date | null;
  /** Last-modified timestamp from the JOINed designs row; `null` if no match. */
  design_last_modified_at: Date | null;
}

// ---------------------------------------------------------------------------
// Section 3: Private mappers — single source of truth for row → domain.
// ---------------------------------------------------------------------------

/**
 * Convert the raw `pg` row into the public {@link ShareLink} shape.
 *
 * Centralising the conversion in one private function:
 *   - Keeps snake_case → camelCase translation in exactly one place.
 *   - Provides a natural anchor point for future enrichment (e.g.
 *     derived audit fields or computed status enums) without requiring
 *     every caller to be rewritten.
 *   - Lets unit tests assert that the mapping is total and faithful by
 *     exercising the mapper through any of the public methods.
 *
 * The function is pure: no side effects, no dependencies beyond its
 * argument. That purity is what makes the repository's behaviour
 * unit-testable with a mocked pool.
 */
function mapShareLinkRow(row: ShareLinkRow): ShareLink {
  return {
    token: row.token,
    designId: row.design_id,
    ownerUid: row.owner_uid,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Convert the raw `pg` row into the public {@link ShareLinkWithDesign}
 * shape, including the embedded {@link Design} reconstructed from the
 * `design_*` JOINed columns.
 *
 * The function delegates to {@link mapShareLinkRow} for the share-link
 * fields and then composes the `design` field from the JOINed columns,
 * faithfully matching the {@link Design} contract from
 * `design.repository.ts`:
 *   - `id` is the joined `designs.id` — which equals `share_links.design_id`
 *     because that's the join condition. We use `row.design_id` here
 *     because either source produces the same value, and the
 *     `share_links` column is guaranteed non-null by the table's
 *     NOT NULL constraint.
 *   - `userId` is the joined `designs.user_id` (returned via the
 *     `design_user_id` alias).
 *   - `title`, `payload`, `createdAt`, `lastModifiedAt` come from the
 *     joined design row.
 *
 * The `design === null` case occurs only when the LEFT JOIN finds no
 * matching design — a defensive fallback in case the FK is ever
 * relaxed. In normal operation (with the ST-030 designs schema's
 * `ON DELETE CASCADE` FK) the design always exists alongside the
 * share link, but we model the LEFT JOIN faithfully so consumers can
 * handle the impossible case explicitly rather than crashing on a
 * `null.title` access.
 *
 * The `payload ?? {}` defensive coercion mirrors the pattern used in
 * `design.repository.ts`'s `mapDesignRow` — it ensures the public
 * contract that `Design.payload` is always a non-null object holds
 * even if a row was written outside the design repository's INSERT
 * path with a NULL or missing payload.
 */
function mapShareLinkWithDesignRow(row: ShareLinkWithDesignRow): ShareLinkWithDesign {
  const baseShareLink = mapShareLinkRow(row);

  // The design half of the JOIN is composed only when the JOINed row
  // produced design columns. We use `design_user_id` as the
  // canary because:
  //   - It is NOT NULL in the `designs` schema, so a NULL value
  //     unambiguously means "no JOIN match" (vs. a column that
  //     could legitimately be empty).
  //   - It is the cheapest column to test (a string equality check).
  const design: Design | null =
    row.design_user_id !== null &&
    row.design_title !== null &&
    row.design_created_at !== null &&
    row.design_last_modified_at !== null
      ? {
          // `id` MUST match the joined design's id. Because the SQL
          // join condition is `d.id = sl.design_id`, the share-link's
          // `design_id` and the design's `id` are equal — we use the
          // share-link column here because it is structurally
          // guaranteed non-null by the `share_links.design_id NOT
          // NULL` constraint.
          id: row.design_id,
          userId: row.design_user_id,
          title: row.design_title,
          // Defensive coercion of `null`/`undefined` payload to an
          // empty object preserves the {@link Design.payload} contract
          // (always a non-null object). The `as Design['payload']`
          // cast borrows the public type from the design repository
          // — that is the contractual narrowing point for JSONB into
          // the application's domain type.
          payload: (row.design_payload ?? {}) as Design['payload'],
          createdAt: row.design_created_at,
          lastModifiedAt: row.design_last_modified_at,
        }
      : null;

  return {
    ...baseShareLink,
    design,
  };
}

// ---------------------------------------------------------------------------
// Section 4: SQL constants — parameterised, audit-ready statements.
// ---------------------------------------------------------------------------

/**
 * INSERT a new share-link row.
 *
 * The four-column INSERT (`token`, `design_id`, `owner_uid`,
 * `expires_at`) leaves `issued_at` to its column default (`now()`),
 * so the application never assigns the issuance timestamp. The
 * database is the single source of truth for that column, eliminating
 * clock-skew concerns between the API server and PG. Likewise
 * `revoked_at` defaults to `NULL` (a just-issued link is always
 * active).
 *
 * The `$4::timestamptz` cast on `expires_at` guarantees pg's
 * parameter binding accepts ISO-8601 strings (which we send via
 * `Date.toISOString()`) reliably across pg minor versions. Without
 * the cast, pg may try to infer the column type from the parameter
 * shape — a robustness concern for unusual JS Date values (very
 * early epoch timestamps, dates produced by Date arithmetic in
 * non-UTC timezones).
 *
 * The RETURNING clause hands back the full canonical row so callers
 * do NOT need a follow-up SELECT to obtain the persisted state.
 * This is both faster (one round-trip instead of two) and more
 * correct (no race window between INSERT and SELECT in which a
 * concurrent UPDATE — e.g. a revocation — could land).
 */
const INSERT_SHARE_LINK_SQL = `
  INSERT INTO share_links (token, design_id, owner_uid, expires_at)
  VALUES ($1, $2, $3, $4::timestamptz)
  RETURNING token, design_id, owner_uid, issued_at, expires_at, revoked_at
`;

/**
 * SELECT a share link by token, JOINing through to the underlying
 * design so the unauthenticated `/api/share/:token` route can render
 * the design payload without a second round-trip.
 *
 * Backed by the PRIMARY KEY index on `share_links.token` (the lookup
 * is O(log n) regardless of table size). The JOIN target
 * (`designs.id`) is also indexed (PRIMARY KEY), so the planner
 * produces a nested-loop join with two index probes — well under any
 * latency budget.
 *
 * LEFT JOIN (rather than INNER JOIN) is the deliberate choice:
 *   - The FK with `ON DELETE CASCADE` means a non-orphaned share link
 *     always has a matching design row. INNER JOIN would behave
 *     identically in normal operation.
 *   - However, LEFT JOIN models the intent faithfully: "return the
 *     share link record, plus the design if it exists." If the
 *     constraint were ever relaxed, INNER JOIN would silently start
 *     returning no rows for orphaned share links, producing 404s
 *     where the application would prefer to surface a more specific
 *     error.
 *   - The defensive {@link mapShareLinkWithDesignRow} mapper handles
 *     `design === null` explicitly so the LEFT JOIN's behaviour is
 *     visible to callers rather than hidden under a coalesce.
 *
 * Column aliasing convention: every column from the `designs` table
 * is prefixed `design_*` in the SELECT list to avoid the
 * `share_links.design_id` vs `designs.id` collision. The mapper's
 * row type ({@link ShareLinkWithDesignRow}) declares the same alias
 * names verbatim, keeping the SQL → row type mapping explicit.
 *
 * The repository deliberately does NOT filter on expiration or
 * revocation here — the consumer (typically the service layer)
 * decides whether to render the design or surface an "expired" /
 * "revoked" error. Pushing that decision into SQL would lose the
 * ability to distinguish "no such token" (HTTP 404) from
 * "token exists but expired" (HTTP 410 Gone, per
 * ST-029-AC2: "expired links are rejected by the read side with a
 * documented error").
 */
const FIND_BY_TOKEN_SQL = `
  SELECT
    sl.token,
    sl.design_id,
    sl.owner_uid,
    sl.issued_at,
    sl.expires_at,
    sl.revoked_at,
    d.title             AS design_title,
    d.payload           AS design_payload,
    d.user_id           AS design_user_id,
    d.created_at        AS design_created_at,
    d.last_modified_at  AS design_last_modified_at
  FROM share_links sl
  LEFT JOIN designs d ON d.id = sl.design_id
  WHERE sl.token = $1
`;

/**
 * UPDATE all active share links for `(design_id, owner_uid)` to
 * mark them revoked.
 *
 * The `WHERE revoked_at IS NULL` predicate is what makes this
 * UPDATE idempotent:
 *   - Already-revoked rows are filtered out, so their original
 *     `revoked_at` timestamp is preserved (audit-correct).
 *   - The RETURNING list emits only rows that ACTUALLY transitioned
 *     active→revoked in THIS call; the repository can therefore
 *     report `revokedCount` honestly without a separate query.
 *   - A retried call (e.g. after a transient network blip) becomes
 *     safe — the second call simply matches zero rows.
 *
 * The `(design_id, owner_uid)` composite filter scopes revocation
 * to a single user's links for a single design — the intended use
 * case from ST-029-AC4 ("revoking a share link by the owner [...]
 * renders the link inoperable on subsequent requests"). Filtering
 * by `owner_uid` is defense-in-depth against a service-layer bug
 * that might attempt to revoke another user's links.
 *
 * The UPDATE is backed by the partial index documented in the
 * migration:
 *   `CREATE INDEX ... ON share_links (design_id, owner_uid)
 *      WHERE revoked_at IS NULL`
 * This makes the index narrow (only active rows) and the UPDATE's
 * filter exactly index-aligned, keeping latency comfortable even
 * with tens of thousands of expired/revoked rows in the table.
 *
 * `RETURNING token` returns the affected token strings for use as
 * a count source. We could RETURNING `*` but token alone is
 * sufficient and avoids serialising columns the repository will
 * not use.
 */
const REVOKE_SHARE_LINKS_SQL = `
  UPDATE share_links
  SET revoked_at = now()
  WHERE design_id = $1
    AND owner_uid = $2
    AND revoked_at IS NULL
  RETURNING token
`;

// ---------------------------------------------------------------------------
// Section 5: Factory — wires the SQL constants to a Pool and returns the
// public {@link ShareLinkRepository} interface.
// ---------------------------------------------------------------------------

/**
 * Create a {@link ShareLinkRepository} backed by the supplied pg
 * {@link Pool}.
 *
 * Why a factory (and not a class)?
 *   - Dependency injection is explicit at the call site
 *     (`createShareLinkRepository(pool)`) — easier to mock in unit
 *     tests than constructor injection.
 *   - The returned object is a plain record literal of methods, which
 *     `Object.freeze` protects from monkey-patching downstream.
 *   - There is no per-call state to encapsulate; a class would add
 *     ceremony without benefit.
 *
 * The returned record is `Object.freeze`-d so calling code cannot
 * substitute one of the methods at runtime — preventing a class of
 * bugs where a test or middleware accidentally mutates the shared
 * repository instance.
 *
 * The methods are defined on the literal directly so `repo.insert`
 * and `const { insert } = repo; insert(...)` behave identically — no
 * `this`-binding confusion.
 *
 * @param pool A connected `pg.Pool` instance (typically from
 *   `backend/src/db/pool.ts`). The repository never closes the pool —
 *   pool lifecycle is the caller's responsibility.
 * @returns A frozen {@link ShareLinkRepository} ready for use.
 */
export function createShareLinkRepository(pool: Pool): ShareLinkRepository {
  const repository: ShareLinkRepository = {
    async insert(params: InsertShareLinkParams): Promise<ShareLink> {
      // ISO-8601 strings are the most reliable wire format for
      // TIMESTAMPTZ columns under pg's parameter binding. We pair
      // this with the explicit `::timestamptz` cast inside
      // INSERT_SHARE_LINK_SQL so pg never has to guess the parameter
      // type.
      //
      // The token, designId, and ownerUid fields are passed as their
      // native string types — pg's TEXT/VARCHAR/UUID inference is
      // unambiguous for them.
      const result = await pool.query<ShareLinkRow>({
        text: INSERT_SHARE_LINK_SQL,
        values: [params.token, params.designId, params.ownerUid, params.expiresAt.toISOString()],
      });

      // Defensive: the RETURNING clause guarantees a row when the
      // INSERT succeeds, but if a future schema change were to alter
      // that contract we want a loud, descriptive failure instead of
      // a silent `undefined` propagating into business logic.
      // The error message intentionally does NOT include the token
      // value (Rule R2 — token-like material must never appear in
      // exception messages or any other diagnostic surface).
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          'share_links INSERT did not return a row; this should be impossible ' +
            'when the INSERT statement contains RETURNING. Investigate ' +
            'recent schema or migration changes.',
        );
      }

      return mapShareLinkRow(row);
    },

    async findByToken(token: string): Promise<ShareLinkWithDesign | null> {
      const result = await pool.query<ShareLinkWithDesignRow>({
        text: FIND_BY_TOKEN_SQL,
        values: [token],
      });

      // The PRIMARY KEY constraint on `share_links.token` guarantees
      // at most one row; `rows[0]` is `ShareLinkWithDesignRow |
      // undefined`. The `row ? ... : null` collapses that to the
      // public contract of `ShareLinkWithDesign | null`.
      const row = result.rows[0];
      return row ? mapShareLinkWithDesignRow(row) : null;
    },

    async revoke(params: RevokeShareLinkParams): Promise<RevokeShareLinkResult> {
      // The query returns one row per share link that ACTUALLY
      // transitioned active→revoked in this call (rows already
      // revoked are filtered out by `WHERE revoked_at IS NULL`).
      // We need only the count, not the tokens themselves; using
      // `RETURNING token` keeps the wire payload minimal while
      // letting pg report `rowCount` accurately.
      const result = await pool.query<{ token: string }>({
        text: REVOKE_SHARE_LINKS_SQL,
        values: [params.designId, params.ownerUid],
      });

      // `rowCount` can theoretically be `null` for some pg query
      // shapes; for an UPDATE-with-RETURNING it is always a
      // non-negative integer, but we coerce defensively with `?? 0`
      // so the public contract (`revokedCount: number`) holds even
      // under driver edge cases.
      return { revokedCount: result.rowCount ?? 0 };
    },
  };

  // Freeze the record so middlewares, services, or tests cannot
  // monkey-patch a repository method at runtime — a defensive measure
  // against a class of bugs that are typically very hard to diagnose.
  return Object.freeze(repository);
}
