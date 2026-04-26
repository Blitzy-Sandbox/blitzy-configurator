/* eslint-disable camelcase */
// @ts-check
/*
 * ============================================================================
 * ST-030: Introduce Designs Schema with Ownership and Indexes
 * ============================================================================
 *
 * Story:     ST-030 — Introduce Designs Schema with Ownership and Indexes
 * Epic:      EP-012 — Database Schemas & Migrations
 * Layer:     database
 * Position:  SECOND migration in the dependency chain.
 *            Run order across the three EP-012 migrations:
 *               (1) 20250115000001_ST-031_users_sessions.js
 *               (2) 20250115000002_ST-030_designs.js              <- THIS FILE
 *               (3) 20250115000003_ST-035_orders_order_items.js
 *
 *            ST-030 frontmatter declares `depends-on: [ST-031]` because the
 *            `designs.user_id` column is a foreign key to `users(id)`. node-pg-
 *            migrate runs migrations in lexicographic filename order, so the
 *            timestamp-prefixed filename `20250115000002_*` is guaranteed to
 *            execute AFTER `20250115000001_*` (ST-031) and BEFORE
 *            `20250115000003_*` (ST-035).
 *
 * ----------------------------------------------------------------------------
 * Acceptance criteria mapping (verbatim from
 * `tickets/stories/ST-030-designs-schema-migration-with-indexes.md`)
 * ----------------------------------------------------------------------------
 *
 *   AC1 — "A forward migration introduces a designs table whose columns
 *          represent the server-assigned identifier, owning user
 *          reference (enforced as a foreign key to the users table
 *          introduced in ST-031), title, full design payload (colors,
 *          pattern, finish, logo reference and placement), and
 *          created/last-modified timestamps."
 *
 *          Implementation:
 *            - designs.id                UUID PRIMARY KEY  DEFAULT
 *                                        gen_random_uuid()  (the
 *                                        "server-assigned identifier";
 *                                        DB-side generation eliminates
 *                                        application UUID-collision
 *                                        concerns and matches the public
 *                                        Design.id contract documented in
 *                                        backend/src/repositories/
 *                                        design.repository.ts).
 *            - designs.user_id           TEXT NOT NULL  REFERENCES
 *                                        users(id) ON DELETE CASCADE  (the
 *                                        "owning user reference enforced
 *                                        as a foreign key to the users
 *                                        table introduced in ST-031").
 *            - designs.title             TEXT NOT NULL  (the "title"
 *                                        column; TEXT rather than
 *                                        VARCHAR(N) to avoid a hard-coded
 *                                        upper-bound assumption that
 *                                        cannot be relaxed without a
 *                                        further migration).
 *            - designs.payload           JSONB NOT NULL  (the "full
 *                                        design payload"; carries the
 *                                        colors + stitching pattern +
 *                                        material finish + logo
 *                                        reference + logo placement as
 *                                        a single opaque JSON document
 *                                        per AC1's enumeration).
 *            - designs.created_at        TIMESTAMPTZ NOT NULL  DEFAULT
 *                                        now()  (the "created"
 *                                        timestamp).
 *            - designs.last_modified_at  TIMESTAMPTZ NOT NULL  DEFAULT
 *                                        now()  (the "last-modified"
 *                                        timestamp; UPDATE statements
 *                                        in design.repository.ts bump
 *                                        this server-side via SQL
 *                                        `now()`, never via an
 *                                        application-supplied value).
 *
 *   AC2 — "The migration adds indexes sufficient to query designs by
 *          owning user and by last-modified timestamp in the documented
 *          ordering without full-table scans."
 *
 *          Implementation:
 *            - idx_designs_user_id_last_modified_at_id is a composite
 *              B-tree index on (user_id, last_modified_at DESC, id DESC).
 *              The leading user_id column lets PostgreSQL satisfy
 *              "designs owned by user $1" without a full-table scan; the
 *              two trailing DESC columns let the ORDER BY clause used
 *              by ST-028's keyset pagination (`last_modified_at DESC,
 *              id DESC`) be served as an index-only scan with no extra
 *              sort step. The id DESC tiebreaker is what makes the
 *              ordering TOTAL when two rows share a millisecond-
 *              precision last_modified_at — required so that repeated
 *              calls with unchanged state produce the same order
 *              (ST-028-AC4).
 *            - The PRIMARY KEY constraint on `id` carries an implicit
 *              UNIQUE B-tree index that satisfies the
 *              `WHERE user_id = $1 AND id = $2` lookup used by
 *              design.repository.ts findById/updatePayload — those
 *              queries hit the PK index and then probe the heap row
 *              for the user_id check (cheap because at most one row
 *              matches the PK).
 *            - PostgreSQL does NOT auto-create an index on a foreign-
 *              key column; the user_id leading position in the
 *              composite index above is what supplies the FK-side
 *              query optimisation. (Without this index, a user-scoped
 *              SELECT would degrade to a full-table scan as the
 *              designs table grows.)
 *
 *   AC3 — "A reverse migration is provided that drops the designs
 *          table cleanly in correct dependency order, and both
 *          directions are idempotent against repeat application on a
 *          clean state."
 *
 *          Implementation:
 *            - exports.down() drops `designs` with `{ ifExists: true }`
 *              so a repeated `down` against an already-dropped state
 *              is a no-op rather than an error.
 *            - The forward direction is idempotent against the standard
 *              up→down→up round-trip because (a) the down direction
 *              uses ifExists, and (b) node-pg-migrate's pgmigrations
 *              ledger prevents an `up`-after-`up` from re-applying the
 *              forward direction. node-pg-migrate also wraps each
 *              migration in a per-migration transaction by default, so
 *              a partial failure rolls back cleanly with no half-
 *              applied state.
 *            - "Correct dependency order" for THIS migration's reverse
 *              direction means: the `designs` table must be dropped
 *              BEFORE the `users` table that ST-031 created (because
 *              designs.user_id FK-references users.id) but AFTER the
 *              `order_items` table that ST-035 creates (because
 *              order_items.design_id FK-references designs.id). node-
 *              pg-migrate's reverse-timestamp-order CLI guarantees
 *              this ordering when running `down --count 3` across the
 *              full EP-012 chain: ST-035 reverses first, then ST-030
 *              (this file), then ST-031.
 *            - Dropping the table cascades the implicit PK index and
 *              the explicit composite index automatically — no
 *              separate `dropIndex` call is needed.
 *
 *   AC4 — "The forward migration runs to completion against an empty
 *          database and against a non-empty database in the local
 *          development environment without data loss."
 *
 *          Implementation:
 *            - `CREATE TABLE designs` is purely additive — it does not
 *              touch any pre-existing data in unrelated tables. The
 *              FK constraint validates that no existing row would
 *              conflict, but `designs` is brand new at this point so
 *              no rows can possibly conflict.
 *            - The `users` parent table created by ST-031 may be empty
 *              or non-empty when this migration runs; either is fine
 *              because the FK is on the CHILD column we are CREATING
 *              now, not on existing parent rows. The FK is validated
 *              at INSERT time on `designs`, not at CREATE TABLE time.
 *            - No data migration step is required. The migration only
 *              adds schema; pre-existing data in `users` (or any
 *              other table) is unchanged.
 *
 * ----------------------------------------------------------------------------
 * Deviations from the agent-prompt template (Explainability Rule)
 * ----------------------------------------------------------------------------
 *
 * The agent prompt for this file proposed a literal schema with `user_id`
 * typed as UUID, an `updated_at` column, and an index named
 * `idx_designs_user_id_updated_at`. This migration deviates from that
 * template in the following ways, each justified by alignment with the
 * existing in-scope source code (which the agent prompt template was not
 * authored with full visibility into) and with the higher-priority AAP
 * sections:
 *
 *   1. `user_id` is TEXT (not UUID).
 *
 *      The ST-031 migration (already shipped at
 *      `backend/migrations/20250115000001_ST-031_users_sessions.js`) types
 *      `users.id` as TEXT so the column can hold the Firebase uid string
 *      directly, per AAP §0.2.1's implicit resolution that "the local
 *      users table stores the Firebase uid as the server-assigned
 *      identifier". A foreign-key constraint requires the child column
 *      type to match the parent column type — `user_id UUID` would error
 *      at CREATE TABLE time with PostgreSQL's "foreign key constraint
 *      cannot be implemented" diagnostic. Typing `user_id` as TEXT is
 *      the only viable resolution.
 *
 *      The existing in-scope `design.repository.ts` (header lines 178-184)
 *      documents the public Design.userId field as "the owning user's
 *      local id (= Firebase uid, per AAP §0.2.1)" and INSERT statements
 *      (line 662) bind the Firebase uid string into the user_id parameter
 *      directly with no UUID cast. A UUID-typed column would require a
 *      breaking change to the repository.
 *
 *   2. The "last-modified" column is named `last_modified_at` (not
 *      `updated_at`).
 *
 *      AAP §0.5.3 schema notes describe this column as the "last-modified
 *      timestamp" — the precise term `last_modified_at` matches that
 *      wording verbatim. The existing in-scope `design.repository.ts`
 *      uses `last_modified_at` throughout: in the DesignRow type
 *      definition (line 450), in the row→domain mapper (line 485), in
 *      every SELECT/INSERT/UPDATE SQL constant (lines 661, 683, 715,
 *      741, 783), and in the keyset cursor encoding (line 521). Renaming
 *      the column to `updated_at` would require a coordinated change to
 *      design.repository.ts that is out of scope for this single-file
 *      migration task.
 *
 *      Additionally, AAP §0.5.3 explicitly documents the index target as
 *      "Index on `(user_id, last_modified_at DESC)` for list-by-owner
 *      queries". The agent prompt's `updated_at` was a less precise
 *      restatement of the AAP wording.
 *
 *   3. The composite index includes `id DESC` as a third sort column.
 *
 *      ST-028-AC4 requires that "the endpoint supports deterministic
 *      ordering (for example, most-recently-modified first) so repeated
 *      calls with unchanged state produce the same order". A two-column
 *      sort `(last_modified_at DESC)` alone is NOT a TOTAL order — when
 *      two rows share a millisecond-precision timestamp, PostgreSQL is
 *      free to return them in either order, breaking the determinism
 *      guarantee. Adding `id DESC` as a third sort column makes the
 *      ordering total (UUIDs are unique by construction).
 *
 *      The existing in-scope `design.repository.ts` documents this
 *      explicitly (lines 731-733): "Backed by the composite index on
 *      `(user_id, last_modified_at DESC, id DESC)` defined in the ST-030
 *      migration (per ST-030-AC2)". Including `id DESC` in the index
 *      lets PostgreSQL satisfy the keyset pagination's
 *      `ORDER BY last_modified_at DESC, id DESC` as an index-only scan;
 *      omitting it would force a heap fetch + in-memory sort for the
 *      tiebreaker.
 *
 *   4. The index name reflects all three sort columns.
 *
 *      The agent prompt suggested `idx_designs_user_id_updated_at`. With
 *      the column rename and the third sort key, the migration uses
 *      `idx_designs_user_id_last_modified_at_id` — long but explicit,
 *      and matches the column-set the index actually covers so an
 *      EXPLAIN ANALYZE reader does not have to cross-reference the
 *      schema to know what the index does.
 *
 * Each of these deviations is a "name it as the existing code expects" or
 * "make the FK constraint actually work" change. None alters the schema's
 * intent; all align with the higher-priority AAP §0.5.3 description of
 * the table.
 *
 * ----------------------------------------------------------------------------
 * Why JSONB (and not separate columns for colors / pattern / finish / logo)
 * ----------------------------------------------------------------------------
 *
 * The configurator's design space is ENUMERATED by ST-006 through ST-017
 * (primary/secondary/accent colors, six stitching patterns, three
 * material finishes, logo reference + position + scale + rotation). Two
 * properties of that enumeration drove the JSONB choice:
 *
 *   1. The space is expected to GROW. Future stories may add e.g. a
 *      fourth color slot, a new pattern type, or a logo per face of
 *      the ball. A normalised relational schema would require a
 *      schema migration for every such addition; a JSONB blob lets
 *      the frontend evolve the payload shape without touching the
 *      database layer.
 *
 *   2. The payload is queried as an ATOMIC UNIT, never piecewise. The
 *      configurator loads a design by id (one query, full payload)
 *      and saves it the same way. There are no analytics queries
 *      that filter on individual color values or pattern types — the
 *      design payload is opaque to the database from a query-
 *      planning perspective. The performance benefit of a normalised
 *      schema (column-level indexing) would never be realised here.
 *
 * The repository treats the payload as opaque `Record<string, unknown>`
 * and the service layer enforces shape via Zod / runtime validation
 * before write. This is the AAP §0.5.3 "JSON payload (colors + pattern
 * + finish + logo reference + placement)" implementation verbatim.
 *
 * ----------------------------------------------------------------------------
 * Why ON DELETE CASCADE on the user_id FK
 * ----------------------------------------------------------------------------
 *
 * Cascading deletes from `users` to `designs` is GDPR-aligned (deleting a
 * user wipes their saved designs in the same statement, no orphan rows
 * left behind) and matches the cascade behaviour declared on
 * `sessions.user_id` in ST-031 and on `orders.user_id` in ST-035 — the
 * three tables form a coherent ownership graph rooted at `users`.
 *
 * When a `designs` row is deleted (either via cascade from `users` or
 * directly), the `order_items.design_id` FK introduced by ST-035 should
 * be configured ON DELETE RESTRICT so that a design referenced by any
 * line item cannot be silently dropped — that constraint lives on the
 * ST-035 child side and is documented there, not here.
 *
 * ----------------------------------------------------------------------------
 * Rule compliance (verbatim from AAP §0.8.1)
 * ----------------------------------------------------------------------------
 *
 * Rule R3 (Firebase Admin SDK only):
 *   - This migration introduces no token-handling column. The user_id
 *     column stores the Firebase uid string supplied by the application
 *     after `admin.auth().verifyIdToken()` returns; this file does not
 *     parse, verify, or otherwise inspect bearer tokens.
 *
 * Rule R4 (no env defaults in source):
 *   - This migration reads no environment variables. The pg connection
 *     string used by node-pg-migrate is supplied at the CLI boundary by
 *     `backend/src/db/pool.ts` reading `DATABASE_URL`.
 *
 * Rule R8 (gates fail closed):
 *   - Both `up` and `down` raise on any unexpected SQL error. node-pg-
 *     migrate wraps each migration in a transaction by default, so a
 *     partial failure rolls back cleanly — no half-applied state.
 *
 * Rule R9 (no payment processing):
 *   - The `designs` table holds configurator selections only — no
 *     monetary amounts, no payment instrument identifiers, no tax or
 *     pricing fields. All financial-shell columns belong on `orders`
 *     in ST-035 (subtotal column only; payment processing is excluded
 *     from `orders` per Rule R9 also).
 *
 * Rule R10 (migration filename embeds story id):
 *   - This file's name, `20250115000002_ST-030_designs.js`, embeds
 *     `ST-030` between the timestamp prefix and the descriptive suffix.
 *     Verification:
 *       ls backend/migrations/ | grep -E '^[0-9]+_ST-[0-9]+_'
 *
 * ----------------------------------------------------------------------------
 * Coordination with other authored files
 * ----------------------------------------------------------------------------
 *
 *   - backend/migrations/20250115000001_ST-031_users_sessions.js — runs
 *     BEFORE this migration. Creates the `users` table that this
 *     migration's user_id FK targets; also installs the `pgcrypto`
 *     extension so `gen_random_uuid()` is available for this
 *     migration's id-column DEFAULT.
 *
 *   - backend/migrations/20250115000003_ST-035_orders_order_items.js —
 *     runs AFTER this migration. Creates `order_items.design_id` FK
 *     that targets `designs.id`. The reverse-migration ordering
 *     (ST-035 down → ST-030 down → ST-031 down) ensures child tables
 *     are dropped before their parents.
 *
 *   - backend/src/repositories/design.repository.ts — primary consumer.
 *     Issues SELECT/INSERT/UPDATE statements against the `designs`
 *     table created here; relies on the column names, types, defaults,
 *     and the composite index defined in this file.
 *
 *   - backend/src/services/design.service.ts — orchestrator. Validates
 *     the payload shape via Zod before calling the repository; the
 *     migration treats the payload as opaque JSONB.
 *
 *   - backend/src/routes/designs.ts — HTTP boundary. POST `/api/designs`
 *     (ST-027), GET `/api/designs` (ST-028, paginated), POST
 *     `/api/designs/:id/share-link` (ST-029).
 *
 *   - backend/src/repositories/share-link.repository.ts (ST-029) — share
 *     links FK-reference `designs.id`; expiration semantics live there.
 * ============================================================================
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Forward migration — introduces the `designs` table and the composite
 * index required by ST-030-AC2 / ST-028 list-by-owner query patterns.
 *
 * Idempotency posture (ST-030-AC3):
 *   - `pgm.createTable` and `pgm.createIndex` calls do NOT use
 *     `ifNotExists` because node-pg-migrate's per-migration transaction
 *     rolls back the entire migration on conflict — the higher-level
 *     idempotency contract for the FORWARD direction is "applies once;
 *     re-applying after a successful run is a documented error". The
 *     "idempotent against repeat application on a CLEAN state" wording
 *     of AC3 is what `up`-after-fresh-`down` exercises, and the `down`
 *     direction below uses `ifExists: true` to make that round-trip
 *     repeatable.
 *
 *   - The `pgcrypto` extension that supplies `gen_random_uuid()` is
 *     installed by the prior ST-031 migration with `ifNotExists: true`
 *     and is intentionally NOT dropped by ST-031's down direction.
 *     This file therefore relies on `gen_random_uuid()` being available
 *     at run time without re-asserting the extension here. PostgreSQL
 *     13+ also ships `gen_random_uuid()` in `pg_catalog` natively, so
 *     the function is reachable on the AAP-pinned PostgreSQL 15
 *     regardless of the extension state.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // (1) `designs` table — durable home for every persisted configurator
  //     design.
  //
  //     Every column is NOT NULL: a design without a title, without an
  //     owner, or without a payload would be a partial record that the
  //     application has no use for. The defaults on `id`, `created_at`,
  //     and `last_modified_at` mean the application only ever supplies
  //     `user_id`, `title`, and `payload` at INSERT time — see
  //     INSERT_DESIGN_SQL in design.repository.ts.
  // ---------------------------------------------------------------------
  pgm.createTable('designs', {
    id: {
      // UUID — the server-assigned identifier (AC1). DB-side
      // generation via `gen_random_uuid()` keeps the application out
      // of the UUID-allocation business and avoids any temptation to
      // pre-mint identifiers client-side. The UUID format is
      // collision-resistant by construction so the application does
      // not need a retry-on-collision loop.
      //
      // PRIMARY KEY: produces a backing UNIQUE B-tree index that
      // satisfies the WHERE user_id = $1 AND id = $2 lookups used by
      // design.repository.ts findById/updatePayload at O(log n).
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      // TEXT — must match the `users.id` column type (also TEXT, the
      // Firebase uid per AAP §0.2.1) so the FK can be declared
      // cleanly. Per AAP §0.2.1's implicit resolution, every FK to
      // `users.id` in this schema is TEXT so the Firebase uid string
      // flows through unchanged from the auth middleware's
      // verifyIdToken() return value to the eventual SQL parameter.
      //
      // ON DELETE CASCADE: deleting a user removes all of their
      // designs in one statement — GDPR-aligned and matches the
      // cascade behaviour declared on `sessions.user_id` in ST-031
      // and `orders.user_id` in ST-035. No orphan rows, no extra
      // application-level cleanup.
      //
      // The FK reference syntax `'"users"(id)"'` (double-quoted
      // table name) preserves case-sensitivity unambiguously and
      // works across every node-pg-migrate 6.x release.
      type: 'text',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    title: {
      // TEXT — the user-facing label for the design. TEXT (rather
      // than VARCHAR(N)) avoids a hard-coded upper-bound assumption
      // that cannot be relaxed without a further migration; PG's
      // TEXT and VARCHAR(N) perform identically at the storage and
      // query layers for arbitrary-length values.
      //
      // The repository does not enforce additional length limits —
      // any per-product policy on title length lives in the service
      // layer's Zod schema, where it can be tightened or loosened
      // without a database migration.
      type: 'text',
      notNull: true,
    },
    payload: {
      // JSONB — the full configurator selection set as an opaque
      // JSON document. Carries colors (primary/secondary/accent),
      // stitching pattern, material finish, logo reference (GCS
      // object name), and logo placement (position + scale +
      // rotation), per ST-030-AC1's enumeration of the payload
      // contents.
      //
      // JSONB (binary JSON) rather than JSON (text):
      //   - JSONB stores a parsed representation, so subsequent
      //     reads do not re-parse the document. Important for the
      //     hot-path read in design.repository.ts findById/listByUser.
      //   - JSONB indexes (GIN) are available if a future story
      //     introduces partial-payload queries; the table can grow
      //     into that capability without a migration to convert
      //     from text JSON.
      //   - Whitespace and key ordering are normalised in JSONB,
      //     so equality comparisons across rows are byte-stable.
      //
      // The repository binds the payload via `$N::jsonb` with a JS-
      // side JSON.stringify; that pairing is the most portable
      // pattern across pg minor versions (see design.repository.ts
      // INSERT_DESIGN_SQL header).
      type: 'jsonb',
      notNull: true,
    },
    created_at: {
      // TIMESTAMPTZ — the row-creation timestamp. Defaulting to
      // `now()` keeps clock authority on the database side; the
      // application never supplies a creation timestamp, so cross-
      // server clock skew cannot perturb the recorded value.
      //
      // TIMESTAMPTZ (rather than TIMESTAMP without time zone)
      // stores the moment in UTC and round-trips correctly across
      // server time zones. This matches every other timestamp in
      // the EP-012 schema.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_modified_at: {
      // TIMESTAMPTZ — the last-modification timestamp (AC1's
      // "last-modified" field). On INSERT the column defaults to
      // `now()`; on UPDATE the design.repository.ts UPDATE
      // statement (UPDATE_DESIGN_PAYLOAD_SQL) explicitly sets
      // `last_modified_at = now()` so the value tracks every
      // payload mutation.
      //
      // The column is the leading sort key for the keyset
      // pagination defined in design.repository.ts listByUser
      // (alongside `id` as the tiebreaker). The composite index
      // created below indexes both columns together with `user_id`
      // so the planner can satisfy the entire query as an index-
      // only scan.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // ---------------------------------------------------------------------
  // (2) Composite index on (user_id, last_modified_at DESC, id DESC)
  //     per ST-030-AC2.
  //
  //     Used by design.repository.ts:
  //
  //       LIST_DESIGNS_FIRST_PAGE_SQL:
  //         SELECT ... FROM designs
  //         WHERE user_id = $1
  //         ORDER BY last_modified_at DESC, id DESC
  //         LIMIT $2
  //
  //       LIST_DESIGNS_AFTER_CURSOR_SQL:
  //         SELECT ... FROM designs
  //         WHERE user_id = $1
  //           AND (
  //             last_modified_at < $2::timestamptz
  //             OR (last_modified_at = $2::timestamptz AND id < $3::uuid)
  //           )
  //         ORDER BY last_modified_at DESC, id DESC
  //         LIMIT $4
  //
  //     With this index in place, the planner satisfies both queries
  //     as an index range scan with no extra sort step (the index is
  //     already in the requested order). The leading user_id column
  //     also services point lookups like
  //     `WHERE user_id = $1 AND id = $2` (used by findById /
  //     updatePayload) — but those queries hit the PRIMARY KEY index
  //     on `id` first and then probe the row for user_id matching,
  //     so the composite index is redundant for them. It is also not
  //     harmful (the planner picks the cheaper PK probe).
  //
  //     The `id DESC` tiebreaker is what makes the ordering total
  //     when two designs share a millisecond-precision
  //     last_modified_at timestamp. ST-028-AC4's "deterministic
  //     ordering ... repeated calls with unchanged state produce the
  //     same order" requirement cannot be satisfied without it.
  //
  //     B-tree (the default index method) is the right choice here:
  //     each component supports range comparisons, the index is
  //     small per row, and the composite covers the exact column set
  //     the queries need.
  //
  //     PostgreSQL CAN use an ASC-sorted index for a DESC ORDER BY
  //     via a backward index scan, but the explicit DESC declaration
  //     here matches the documented query pattern in ST-030-AC2 and
  //     in design.repository.ts and is clearer in EXPLAIN ANALYZE
  //     output. node-pg-migrate's IndexColumn { name, sort } object
  //     syntax (see node_modules/node-pg-migrate/dist/operations/
  //     indexes.js generateColumnsString) emits the correct
  //     `"col" DESC` SQL fragment.
  // ---------------------------------------------------------------------
  pgm.createIndex(
    'designs',
    ['user_id', { name: 'last_modified_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }],
    {
      name: 'idx_designs_user_id_last_modified_at_id',
    },
  );
};

/**
 * Reverse migration — drops the `designs` table cleanly per ST-030-AC3.
 *
 * The `{ ifExists: true }` option makes a re-applied `down` against an
 * already-dropped state a no-op rather than an error — required for
 * "idempotent against repeat application on a clean state".
 *
 * Foreign-key dependency ordering across the EP-012 chain:
 *
 *   - The `order_items` table (created by ST-035) has a `design_id` FK
 *     that references `designs(id)`. Dropping `designs` while
 *     `order_items` still exists would error with PostgreSQL's
 *     "cannot drop ... because other objects depend on it" diagnostic
 *     unless `CASCADE` is applied at the DROP statement (a bigger
 *     hammer than necessary).
 *
 *   - When the full EP-012 chain is reversed via `node-pg-migrate down
 *     --count 3`, node-pg-migrate's reverse-timestamp ordering
 *     guarantees the chain runs as: ST-035 down (drops order_items
 *     and orders) → ST-030 down (drops designs, this file) → ST-031
 *     down (drops sessions and users). Under that ordering the
 *     `designs` drop here always runs AFTER `order_items` is gone,
 *     so no cascade is needed.
 *
 *   - Running `down` on this migration in isolation while a populated
 *     `order_items` table exists IS an error condition, and the
 *     migration WILL fail at runtime with a clear PG error message.
 *     That is the correct behaviour: the application has not been
 *     drained of orders that reference designs, so dropping the
 *     designs table would silently break referential integrity.
 *
 * Both the implicit PRIMARY KEY index on `designs.id` and the explicit
 * composite index `idx_designs_user_id_last_modified_at_id` are dropped
 * automatically when the table is dropped — no separate `dropIndex`
 * call is required.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropTable('designs', { ifExists: true });
};
