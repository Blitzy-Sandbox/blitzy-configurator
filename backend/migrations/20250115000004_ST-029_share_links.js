/* eslint-disable camelcase */
// @ts-check
/*
 * ============================================================================
 * ST-029: Share-Link Persistence Schema
 * ============================================================================
 *
 * Story:     ST-029 — Share-Link Issuance Endpoint
 * Epic:      EP-007 — Design Persistence API (with backing schema in EP-012)
 * Layer:     database
 * Position:  FOURTH migration in the dependency chain.
 *            Run order across the four EP-012/ST-029 migrations:
 *               (1) 20250115000001_ST-031_users_sessions.js
 *               (2) 20250115000002_ST-030_designs.js
 *               (3) 20250115000003_ST-035_orders_order_items.js
 *               (4) 20250115000004_ST-029_share_links.js              <- THIS FILE
 *
 *            ST-029 frontmatter implies `depends-on: [ST-030, ST-031]`
 *            because the `share_links.design_id` column is a foreign key
 *            to `designs(id)` (ST-030) and `share_links.owner_uid` is a
 *            foreign key to `users(id)` (ST-031). node-pg-migrate runs
 *            migrations in lexicographic filename order, so the
 *            timestamp-prefixed filename `20250115000004_*` is guaranteed
 *            to execute AFTER `20250115000001_*` (ST-031) AND
 *            `20250115000002_*` (ST-030).
 *
 * ----------------------------------------------------------------------------
 * Why this migration was authored AFTER ST-031, ST-030, ST-035
 * ----------------------------------------------------------------------------
 *
 * The original migration set in `backend/migrations/` covered ST-030,
 * ST-031, and ST-035 — the three migrations the AAP §0.6.3 explicitly
 * names. The share-link persistence schema for ST-029, however, was
 * absent: every column the `share-link.repository.ts` SQL references
 * (`token`, `design_id`, `owner_uid`, `issued_at`, `expires_at`,
 * `revoked_at`) requires a `share_links` table that no migration
 * creates. The QA Gate T1-C report ("Issue #3 — `share_links` table is
 * missing") flagged this as a CRITICAL defect because the
 * `shareLinkService.issue(...)` code path errors with
 * `relation "share_links" does not exist` at the first invocation.
 *
 * This migration closes that gap. Filename pattern follows Rule R10
 * verbatim:
 *
 *     {14-digit-timestamp}_ST-{NNN}_{description}.js
 *
 *     20250115000004_ST-029_share_links.js
 *     ^               ^      ^
 *     timestamp       story  description
 *
 * Verification (verbatim from Rule R10 verification command):
 *
 *     ls backend/migrations/ | grep -E '^[0-9]+_ST-[0-9]+_'
 *
 * ----------------------------------------------------------------------------
 * Acceptance criteria mapping (verbatim from
 * `tickets/stories/ST-029-share-link-issuance-endpoint.md` and the
 * SQL contract documented in `backend/src/repositories/share-link.repository.ts`)
 * ----------------------------------------------------------------------------
 *
 *   ST-029-AC1 — "POST /api/designs/:id/share-link with a valid session
 *                 requires the caller to own the design referenced by :id."
 *
 *                 Implementation: enforced by the SQL JOIN in
 *                 `share-link.repository.ts:insert(...)` against
 *                 `designs.user_id = $owner_uid`. This migration
 *                 supplies the FK column (`owner_uid`) and the FK
 *                 reference (`REFERENCES users(id)`) the SQL relies
 *                 on. The `design_id` FK additionally guarantees that
 *                 the share link cannot reference a design that does
 *                 not exist.
 *
 *   ST-029-AC2 — "The response includes a cryptographically-random
 *                 URL-safe token and an absolute `expiresAt` timestamp."
 *
 *                 Implementation:
 *                   - share_links.token TEXT PRIMARY KEY            (the token)
 *                   - share_links.expires_at TIMESTAMPTZ NOT NULL   (absolute
 *                     expiration)
 *
 *                 Token format and generation lives at the application
 *                 layer (`share-link.service.ts:generateToken`) which
 *                 emits 43-char base64url strings encoding 256 bits
 *                 of entropy from `crypto.randomBytes(32)`. The
 *                 database treats the value as opaque — the PRIMARY
 *                 KEY constraint and its backing UNIQUE B-tree index
 *                 ensure no collisions are accepted at write time.
 *
 *   ST-029-AC3 — "The companion unauthenticated read route is
 *                 GET /api/share/:token (lives in `routes/share.ts`)."
 *
 *                 Implementation: served by
 *                 `share-link.repository.ts:findByToken(...)` which
 *                 does a LEFT JOIN with `designs` and returns
 *                 `ShareLinkWithDesign`. The single-query JOIN means
 *                 the route handler does NOT need to call `findById`
 *                 after resolving the token — saving a DB round-trip
 *                 on the read path.
 *
 *                 The active-row partial index defined below
 *                 (`idx_share_links_active_by_design_owner WHERE
 *                 revoked_at IS NULL`) services the
 *                 `share-link.repository.ts:revokeForDesign(...)`
 *                 query path's `WHERE design_id = $1 AND owner_uid =
 *                 $2 AND revoked_at IS NULL` predicate as an index-only
 *                 scan over a typically tiny set of active rows.
 *
 * ----------------------------------------------------------------------------
 * Schema design rationale
 * ----------------------------------------------------------------------------
 *
 * `token TEXT PRIMARY KEY`:
 *   The application layer generates the token (see
 *   share-link.service.ts:SHARE_LINK_TTL_MS comment); the database
 *   stores it as opaque text. PRIMARY KEY produces the backing UNIQUE
 *   B-tree index that satisfies findByToken's `WHERE token = $1`
 *   lookup at O(log n) and the INSERT's collision-detection
 *   guarantee. TEXT is sized appropriately for the 43-char token
 *   format the application uses, and TEXT-vs-VARCHAR(N) is a
 *   storage-equivalent choice on PostgreSQL.
 *
 * `design_id UUID NOT NULL REFERENCES designs(id) ON DELETE CASCADE`:
 *   Dropping a design removes every share link issued for it in the
 *   same statement. This matches the ownership-cascade pattern
 *   established by ST-030 (`designs.user_id` ON DELETE CASCADE) and
 *   ST-031 (`sessions.user_id` ON DELETE CASCADE). When a user is
 *   deleted, the cascade propagates: users → designs (cascade) →
 *   share_links (cascade). No orphan rows.
 *
 * `owner_uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`:
 *   The `owner_uid` column duplicates ownership information that is
 *   ALSO derivable from `designs.user_id` via the `design_id` FK. The
 *   denormalisation is intentional:
 *
 *     1. The `revokeForDesign` query filters by `(design_id, owner_uid)`
 *        and would otherwise need a JOIN against `designs` to verify
 *        ownership — a JOIN that runs on every revocation request.
 *        Storing `owner_uid` directly lets the partial index defined
 *        below cover the predicate without a JOIN.
 *
 *     2. The audit trail benefits from a denormalised column: a
 *        future "show me every share link this user has ever issued"
 *        query reads `WHERE owner_uid = $1` against this table alone.
 *
 *     3. The denormalisation is safe because shareLinkService.issue
 *        always sets `owner_uid` to the same value as the
 *        `designs.user_id` of the FK target — verified by the service
 *        layer before the INSERT runs.
 *
 *   ON DELETE CASCADE: deleting a user removes every share link they
 *   own — same GDPR alignment as the cascade on `designs`.
 *
 * `issued_at TIMESTAMPTZ NOT NULL DEFAULT now()`:
 *   The DB-side default keeps clock authority on the database side.
 *   The application never supplies an issuance timestamp, so cross-
 *   server clock skew cannot perturb the recorded value. Mirrors the
 *   `created_at` defaults on `users`, `sessions`, `designs`, and
 *   `orders`.
 *
 * `expires_at TIMESTAMPTZ NOT NULL`:
 *   Supplied by the application at INSERT time as `now() + 14 days`
 *   (per `share-link.service.ts:SHARE_LINK_TTL_MS` = 14 days). The
 *   migration does NOT impose a DB-level CHECK constraint that
 *   `expires_at > issued_at` because the service layer's
 *   monotonically-future calculation already guarantees this — and a
 *   CHECK constraint would couple the schema to the service's TTL
 *   policy, which a future story might tune (e.g., 30-day shares for
 *   premium tiers) without a migration.
 *
 * `revoked_at TIMESTAMPTZ NULL` (no NOT NULL):
 *   `NULL` means "active"; non-NULL means "revoked at this timestamp".
 *   Soft-delete semantics rather than hard-delete preserve the audit
 *   trail: a revoked share link's row remains so operators can answer
 *   "this URL used to work — when did it stop?" via a single read.
 *
 *   The application layer's `revokeForDesign` updates this field via
 *
 *       UPDATE share_links SET revoked_at = now()
 *       WHERE design_id = $1 AND owner_uid = $2 AND revoked_at IS NULL
 *       RETURNING token
 *
 *   per `share-link.repository.ts`. The `WHERE ... AND revoked_at IS
 *   NULL` predicate guarantees that re-revocation is a no-op (the
 *   matching set is empty) and that the FIRST revocation timestamp
 *   wins.
 *
 * ----------------------------------------------------------------------------
 * Active-row partial index
 * ----------------------------------------------------------------------------
 *
 * `idx_share_links_active_by_design_owner` is a partial B-tree index
 * on `(design_id, owner_uid)` qualified by `WHERE revoked_at IS NULL`.
 * Used by:
 *
 *   - share-link.repository.ts:revokeForDesign — the UPDATE's WHERE
 *     clause is exactly the partial index's predicate, so the planner
 *     scans the partial index directly.
 *
 *   - share-link.repository.ts:findActiveByDesign (and any future
 *     "list active share links I've issued for this design" query) —
 *     same access pattern, same partial index.
 *
 * Why a PARTIAL index rather than a full one:
 *   - Active share links are a small minority of all share links
 *     after the table matures. A full index on (design_id, owner_uid)
 *     would have to be traversed for every revocation request only to
 *     skip over the already-revoked majority. A partial index has
 *     entries for active rows only, so the scan is over a tiny set.
 *
 *   - The partial index uses less storage and less RAM for the
 *     working set on the hot path.
 *
 *   - PostgreSQL's planner correctly chooses the partial index for
 *     queries whose WHERE clause matches the partial predicate —
 *     verified empirically against PG 15 (the AAP-pinned version).
 *
 * Why NOT a UNIQUE partial index:
 *   The application allows a user to issue MULTIPLE active share
 *   links for the same design (e.g., one per recipient channel). The
 *   token PRIMARY KEY guarantees uniqueness across rows; uniqueness
 *   across (design_id, owner_uid) for active rows would block this
 *   use case. The partial index is therefore non-unique.
 *
 * ----------------------------------------------------------------------------
 * Rule compliance (verbatim from AAP §0.8.1)
 * ----------------------------------------------------------------------------
 *
 * Rule R3 (Firebase Admin SDK only):
 *   - This migration introduces no token-handling column for Firebase
 *     bearer tokens. The `token` column stores share-URL tokens
 *     (URL-safe random strings), not Firebase JWTs. No JWT parsing,
 *     no signature verification.
 *
 * Rule R4 (no env defaults in source):
 *   - This migration reads no environment variables. The pg
 *     connection string used by node-pg-migrate is supplied at the
 *     CLI boundary by `backend/src/db/pool.ts` reading `DATABASE_URL`.
 *
 * Rule R8 (gates fail closed):
 *   - Both `up` and `down` raise on any unexpected SQL error. node-
 *     pg-migrate wraps each migration in a transaction by default, so
 *     a partial failure rolls back cleanly — no half-applied state.
 *
 * Rule R9 (no payment processing):
 *   - The `share_links` table holds tokens for read-only design
 *     sharing only — no monetary amounts, no payment instrument
 *     identifiers, no tax or pricing fields. Share links carry no
 *     financial significance.
 *
 * Rule R10 (migration filename embeds story id):
 *   - This file's name, `20250115000004_ST-029_share_links.js`,
 *     embeds `ST-029` between the timestamp prefix and the
 *     descriptive suffix. Verification:
 *       ls backend/migrations/ | grep -E '^[0-9]+_ST-[0-9]+_'
 *
 * ----------------------------------------------------------------------------
 * Coordination with other authored files
 * ----------------------------------------------------------------------------
 *
 *   - backend/migrations/20250115000001_ST-031_users_sessions.js — runs
 *     BEFORE this migration. Creates the `users` table that this
 *     migration's owner_uid FK targets.
 *
 *   - backend/migrations/20250115000002_ST-030_designs.js — runs
 *     BEFORE this migration. Creates the `designs` table that this
 *     migration's design_id FK targets.
 *
 *   - backend/src/repositories/share-link.repository.ts — primary
 *     consumer. Issues SELECT/INSERT/UPDATE statements against the
 *     `share_links` table created here. Specifically depends on:
 *       - The exact column set (token, design_id, owner_uid,
 *         issued_at, expires_at, revoked_at).
 *       - The PRIMARY KEY UNIQUE index on `token`.
 *       - The partial index `idx_share_links_active_by_design_owner`.
 *
 *   - backend/src/services/share-link.service.ts — orchestrator.
 *     Generates the token, validates owner_uid + design_id, computes
 *     expires_at as `now() + 14 days`, then calls the repository's
 *     insert.
 *
 *   - backend/src/routes/designs.ts — POST /api/designs/:id/share-link
 *     handler. Mounts the share-link issuance flow.
 *
 *   - backend/src/routes/share.ts — GET /api/share/:token public
 *     unauthenticated read flow. Calls
 *     `shareLinkService.getByToken(...)` which calls
 *     `share-link.repository.ts:findByToken(...)` against this table.
 * ============================================================================
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Forward migration — introduces the `share_links` table and the
 * partial index required for the active-share-link revoke query path.
 *
 * Idempotency posture (mirrors ST-030's idempotency contract):
 *   - `pgm.createTable` and `pgm.createIndex` calls do NOT use
 *     `ifNotExists` because node-pg-migrate's per-migration
 *     transaction rolls back the entire migration on conflict — the
 *     higher-level idempotency contract for the FORWARD direction is
 *     "applies once; re-applying after a successful run is a
 *     documented error". The "idempotent against repeat application
 *     on a CLEAN state" wording from the EP-012 family is what
 *     `up`-after-fresh-`down` exercises, and the `down` direction
 *     below uses `ifExists: true` to make that round-trip repeatable.
 *
 *   - The `pgcrypto` extension and `gen_random_uuid()` function are
 *     NOT required by this migration because the `token` column is
 *     application-generated. The migration depends ONLY on standard
 *     PostgreSQL 15 features (TEXT, UUID, TIMESTAMPTZ, partial
 *     index).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // (1) `share_links` table — durable home for every issued share link.
  //
  //     Every column except `revoked_at` is NOT NULL. `revoked_at`
  //     intentionally permits NULL because NULL is the discriminator
  //     for "active" (the revocation timestamp does not yet exist).
  //
  //     Defaults on `issued_at` keep clock authority on the DB side.
  //     `expires_at` is application-supplied (the service computes
  //     `now() + 14 days`) so the migration declares no default for it.
  // ---------------------------------------------------------------------
  pgm.createTable('share_links', {
    token: {
      // TEXT — application-generated 43-char base64url string
      // encoding 256 bits of entropy. PRIMARY KEY produces the
      // backing UNIQUE B-tree index that satisfies findByToken's
      // `WHERE token = $1` lookup at O(log n).
      //
      // TEXT vs VARCHAR(N): identical storage and query performance
      // on PostgreSQL; TEXT avoids a hard-coded length assumption
      // that cannot be relaxed without a further migration. The
      // application layer enforces the canonical 43-char length;
      // the schema does not (and should not) duplicate that policy.
      type: 'text',
      primaryKey: true,
    },
    design_id: {
      // UUID — must match the `designs.id` column type so the FK
      // can be declared cleanly. The reference syntax `'"designs"(id)"'`
      // (double-quoted table name) preserves case-sensitivity
      // unambiguously and works across every node-pg-migrate 6.x
      // release.
      //
      // ON DELETE CASCADE: deleting a design removes every share
      // link issued for it. Matches the cascade behaviour declared
      // on `designs.user_id` (ST-030) and `sessions.user_id`
      // (ST-031). When a user is deleted, the cascade propagates:
      // users → designs → share_links. No orphan rows.
      type: 'uuid',
      notNull: true,
      references: '"designs"(id)',
      onDelete: 'CASCADE',
    },
    owner_uid: {
      // TEXT — must match the `users.id` column type (also TEXT, the
      // Firebase uid per AAP §0.2.1) so the FK can be declared
      // cleanly. Per AAP §0.2.1, every FK to `users.id` in this
      // schema is TEXT so the Firebase uid string flows through
      // unchanged from the auth middleware's verifyIdToken() return
      // value to the eventual SQL parameter.
      //
      // Denormalised from `designs.user_id` for revoke-query
      // efficiency — see the partial index below.
      //
      // ON DELETE CASCADE: deleting a user removes every share link
      // they have issued. Matches every other ownership FK in the
      // schema.
      type: 'text',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    issued_at: {
      // TIMESTAMPTZ — the issuance timestamp. Defaulting to `now()`
      // keeps clock authority on the database side; the application
      // never supplies an issuance timestamp, so cross-server clock
      // skew cannot perturb the recorded value.
      //
      // TIMESTAMPTZ (rather than TIMESTAMP without time zone) stores
      // the moment in UTC and round-trips correctly across server
      // time zones. This matches every other timestamp in the
      // EP-012/ST-029 schema family.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    expires_at: {
      // TIMESTAMPTZ — the absolute expiration timestamp (ST-029-AC2).
      // Application-supplied: the service computes `now() + 14 days`
      // (per `share-link.service.ts:SHARE_LINK_TTL_MS` = 14 days).
      // The schema does NOT impose a CHECK constraint that
      // `expires_at > issued_at` because:
      //   - The service layer's monotonically-future calculation
      //     already guarantees this.
      //   - A CHECK constraint would couple the schema to the
      //     service's TTL policy. A future story might tune the TTL
      //     (e.g., 30-day shares for premium tiers); the schema
      //     should not require a migration for that.
      type: 'timestamptz',
      notNull: true,
    },
    revoked_at: {
      // TIMESTAMPTZ NULL — soft-delete discriminator. NULL means
      // "active"; non-NULL means "revoked at this timestamp". This
      // preserves the audit trail (a revoked share link's row
      // remains so operators can answer "this URL used to work —
      // when did it stop?" via a single read).
      //
      // The application layer's `revokeForDesign` updates this field
      // via UPDATE ... SET revoked_at = now() WHERE ... AND
      // revoked_at IS NULL. The `WHERE ... AND revoked_at IS NULL`
      // predicate guarantees that re-revocation is a no-op and that
      // the FIRST revocation timestamp wins.
      type: 'timestamptz',
      notNull: false,
    },
  });

  // ---------------------------------------------------------------------
  // (2) Partial index on (design_id, owner_uid) WHERE revoked_at IS NULL
  //
  //     Used by share-link.repository.ts:
  //
  //       REVOKE_FOR_DESIGN_SQL:
  //         UPDATE share_links
  //            SET revoked_at = now()
  //          WHERE design_id = $1
  //            AND owner_uid = $2
  //            AND revoked_at IS NULL
  //          RETURNING token
  //
  //     With this partial index in place, the planner scans the
  //     index directly for the matching active rows rather than
  //     traversing a full index that includes already-revoked rows.
  //
  //     Why partial:
  //       - Active share links are a minority of all share links
  //         once the table matures. A full index on (design_id,
  //         owner_uid) would have to be traversed past every
  //         already-revoked entry on every revocation request. A
  //         partial index has entries for active rows only.
  //       - Smaller index = less storage, less RAM, faster scans.
  //
  //     Why NOT unique:
  //       - The application allows a user to issue MULTIPLE active
  //         share links for the same design. The token PK guarantees
  //         uniqueness across rows; uniqueness on (design_id,
  //         owner_uid) for active rows would block this use case.
  //
  //     B-tree (the default index method) is the right choice here:
  //     each component supports range comparisons, the index is
  //     small per row, and the composite covers the exact column
  //     set the queries need.
  // ---------------------------------------------------------------------
  pgm.createIndex(
    'share_links',
    ['design_id', 'owner_uid'],
    {
      name: 'idx_share_links_active_by_design_owner',
      where: 'revoked_at IS NULL',
    },
  );
};

/**
 * Reverse migration — drops the `share_links` table cleanly.
 *
 * The `{ ifExists: true }` option makes a re-applied `down` against
 * an already-dropped state a no-op rather than an error — required
 * for "idempotent against repeat application on a clean state"
 * (matches the ST-030 / ST-031 / ST-035 reverse-migration posture).
 *
 * Foreign-key dependency ordering:
 *
 *   - This migration's `share_links` table is a CHILD of `designs`
 *     and `users`. When the full migration chain is reversed via
 *     `node-pg-migrate down --count 4`, node-pg-migrate's reverse-
 *     timestamp ordering runs: ST-029 down (this file, drops
 *     share_links) → ST-035 down (drops order_items + orders) →
 *     ST-030 down (drops designs) → ST-031 down (drops sessions +
 *     users). Under that ordering the `share_links` drop here
 *     always runs BEFORE its parent tables (`designs`, `users`)
 *     are dropped, so no cascade is needed.
 *
 *   - Running `down` on this migration in isolation is safe at any
 *     time because no other migration's table FK-references
 *     `share_links` — the share-link table is a leaf node in the
 *     ownership graph.
 *
 * Both the implicit PRIMARY KEY index on `share_links.token` and the
 * explicit partial index `idx_share_links_active_by_design_owner` are
 * dropped automatically when the table is dropped — no separate
 * `dropIndex` call is required.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('share_links', { ifExists: true });
};
