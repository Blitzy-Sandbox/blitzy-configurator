/* eslint-disable camelcase */
// @ts-check
/*
 * ============================================================================
 * ST-035: Introduce Orders and Order Items Schemas with Indexes
 * ============================================================================
 *
 * Story:     ST-035 — Introduce Orders and Order Items Schema with Indexes
 * Epic:      EP-012 — Database Schemas & Migrations
 * Layer:     database
 * Position:  THIRD (final) migration in the dependency chain.
 *            Run order across the three EP-012 migrations:
 *               (1) 20250115000001_ST-031_users_sessions.js
 *               (2) 20250115000002_ST-030_designs.js
 *               (3) 20250115000003_ST-035_orders_order_items.js   <- THIS FILE
 *
 *            ST-035 frontmatter declares `depends-on: [ST-030, ST-031]`
 *            because:
 *              - `orders.user_id` is a foreign key to `users(id)` (ST-031).
 *              - `order_items.design_id` is a foreign key to `designs(id)`
 *                (ST-030).
 *
 *            node-pg-migrate runs migrations in lexicographic filename order,
 *            so the timestamp-prefixed filename `20250115000003_*` is
 *            guaranteed to execute AFTER `20250115000002_*` (ST-030 designs)
 *            and AFTER `20250115000001_*` (ST-031 users_sessions). The
 *            reverse direction runs in the inverse lexicographic order so
 *            child tables are dropped before their parents.
 *
 * ----------------------------------------------------------------------------
 * Acceptance criteria mapping (verbatim from
 * `tickets/stories/ST-035-orders-order-items-schema-migration.md`)
 * ----------------------------------------------------------------------------
 *
 *   AC1 — "A forward migration introduces an orders table whose columns
 *          represent the server-assigned identifier, owning user
 *          reference (enforced as a foreign key to the users table
 *          introduced in ST-031), state (such as created or finalized),
 *          subtotal, created timestamp, and last-modified timestamp."
 *
 *          Implementation:
 *            - orders.id                UUID PRIMARY KEY  DEFAULT
 *                                        gen_random_uuid()  (the
 *                                        "server-assigned identifier";
 *                                        DB-side generation eliminates
 *                                        application UUID-collision
 *                                        concerns and matches the public
 *                                        Order.id contract documented in
 *                                        backend/src/repositories/
 *                                        order.repository.ts).
 *            - orders.user_id           TEXT NOT NULL  REFERENCES
 *                                        users(id) ON DELETE CASCADE  (the
 *                                        "owning user reference enforced
 *                                        as a foreign key to the users
 *                                        table introduced in ST-031";
 *                                        TEXT to match the Firebase-uid
 *                                        column type chosen in ST-031).
 *            - orders.state             order_state ENUM NOT NULL  (the
 *                                        AC1 "state (such as created or
 *                                        finalized)"). Enum vocabulary
 *                                        is `('cart', 'created',
 *                                        'finalized', 'cancelled')` —
 *                                        see "Deviation from the agent-
 *                                        prompt template" section below
 *                                        for the alignment with the
 *                                        existing in-scope repository.
 *                                        No DEFAULT: the application
 *                                        layer spells out the literal
 *                                        state at INSERT time so the
 *                                        cart-vs-created distinction is
 *                                        unambiguous in the call site
 *                                        (see order.repository.ts
 *                                        INSERT_ORDER_SQL header).
 *            - orders.subtotal          NUMERIC(12,2) NOT NULL  CHECK
 *                                        (subtotal >= 0)  (the AC1
 *                                        "subtotal" column; arbitrary-
 *                                        precision decimal preserves
 *                                        cent-accuracy across the
 *                                        full configurator amount range
 *                                        — see "Why NUMERIC(12,2)"
 *                                        below for the precision
 *                                        rationale).
 *            - orders.created_at        TIMESTAMPTZ NOT NULL  DEFAULT
 *                                        now()  (the AC1 "created
 *                                        timestamp").
 *            - orders.last_modified_at  TIMESTAMPTZ NOT NULL  DEFAULT
 *                                        now()  (the AC1 "last-modified
 *                                        timestamp"; UPDATE statements
 *                                        in order.repository.ts bump
 *                                        this server-side via SQL
 *                                        `now()`, never via an
 *                                        application-supplied value).
 *
 *   AC2 — "A forward migration introduces an order_items table whose
 *          columns represent the owning order reference, referenced
 *          design, quantity, and any per-item metadata; foreign keys
 *          enforce referential integrity from the owning order
 *          reference to the orders table and from the referenced
 *          design to the designs table."
 *
 *          Implementation:
 *            - order_items.id           UUID PRIMARY KEY  DEFAULT
 *                                        gen_random_uuid()  (the
 *                                        synthetic line-item identifier;
 *                                        not exposed via the repository
 *                                        public surface but useful for
 *                                        audit logging and future
 *                                        targeted-update operations).
 *            - order_items.order_id     UUID NOT NULL  REFERENCES
 *                                        orders(id) ON DELETE CASCADE
 *                                        (the AC2 "owning order
 *                                        reference"; cascade deletion
 *                                        ensures no orphan items when
 *                                        an order row is removed).
 *            - order_items.design_id    UUID NOT NULL  REFERENCES
 *                                        designs(id) ON DELETE
 *                                        RESTRICT  (the AC2 "referenced
 *                                        design"; RESTRICT preserves
 *                                        audit integrity for
 *                                        historical orders — a design
 *                                        referenced by any order_item
 *                                        cannot be silently dropped).
 *            - order_items.quantity     INTEGER NOT NULL  CHECK
 *                                        (quantity > 0)  (the AC2
 *                                        "quantity"; positive-integer
 *                                        invariant enforced at the DB
 *                                        tier per the contract
 *                                        documented in
 *                                        order.repository.ts
 *                                        OrderItem.quantity).
 *            - order_items.metadata     JSONB NOT NULL  DEFAULT
 *                                        '{}'::jsonb  (the AC2 "per-
 *                                        item metadata"; opaque to
 *                                        the database, treated as
 *                                        Record<string, unknown> by
 *                                        the repository).
 *            - order_items.created_at   TIMESTAMPTZ NOT NULL  DEFAULT
 *                                        now()  (audit trail; not
 *                                        explicitly listed in AC2 but
 *                                        consistent with every other
 *                                        EP-012 table and useful for
 *                                        forensic queries).
 *
 *          Both foreign-key constraints are declared at column-
 *          definition time via `references` + `onDelete`; node-pg-
 *          migrate emits the canonical SQL `REFERENCES "orders"(id) ON
 *          DELETE CASCADE` / `REFERENCES "designs"(id) ON DELETE
 *          RESTRICT` clauses verbatim. The double-quoted table names
 *          preserve case-sensitivity unambiguously across every node-
 *          pg-migrate 6.x release.
 *
 *   AC3 — "The migration adds indexes sufficient to query orders by
 *          owning user and by state, and to query items by owning
 *          order, without full-table scans."
 *
 *          Implementation:
 *            - idx_orders_user_id_state is a composite B-tree index on
 *              (user_id, state). The leading user_id column lets
 *              PostgreSQL satisfy "orders owned by user $1" without a
 *              full-table scan; the trailing state column refines the
 *              search to a specific lifecycle state. Used by the
 *              FIND_CART_ITEMS_FOR_USER_SQL JOIN's
 *              `WHERE o.user_id = $1 AND o.state = 'cart'` predicate
 *              (cart projection — ST-033) and by any future "orders by
 *              user in state X" query (e.g. an order-history listing
 *              of `state IN ('finalized', 'cancelled')`).
 *            - idx_order_items_order_id is a single-column B-tree
 *              index on order_id. Used by
 *              FIND_ORDER_ITEMS_BY_ORDER_SQL's `WHERE order_id = $1`
 *              predicate to load all line items for a specific order
 *              (ST-033 cart projection JOIN, ST-032 order detail).
 *            - The PRIMARY KEY constraints on `orders.id` and
 *              `order_items.id` carry implicit UNIQUE B-tree indexes
 *              that satisfy `WHERE id = $N` lookups at O(log n).
 *            - PostgreSQL does NOT auto-create an index on a foreign-
 *              key column; the explicit indexes above are what supply
 *              the FK-side query optimisation. (Without them, every
 *              cart-projection query and every order-detail query
 *              would degrade to a full-table scan as the orders /
 *              order_items tables grow.)
 *
 *   AC4 — "A reverse migration drops the order_items table before the
 *          orders table (correct foreign-key dependency order), both
 *          directions are idempotent against repeat application on a
 *          clean state, and the forward migration runs to completion
 *          in the local development environment."
 *
 *          Implementation:
 *            - exports.down() drops `order_items` BEFORE `orders` per
 *              the AC4 "correct foreign-key dependency order"
 *              requirement. Dropping `orders` first would error
 *              because `order_items.order_id` still references it.
 *            - The `order_state` ENUM type is dropped LAST, after both
 *              tables are gone — dropping the type while a column
 *              still uses it would error with "cannot drop type
 *              order_state because other objects depend on it".
 *            - All three drops use `{ ifExists: true }` so a re-
 *              applied `down` against an already-dropped state is a
 *              no-op rather than an error — required for the AC4
 *              "idempotent against repeat application on a clean
 *              state" guarantee.
 *            - The forward direction is idempotent against the
 *              standard up→down→up round-trip because (a) the down
 *              direction uses ifExists, and (b) node-pg-migrate's
 *              pgmigrations ledger prevents an `up`-after-`up` from
 *              re-applying the forward direction. node-pg-migrate
 *              also wraps each migration in a per-migration
 *              transaction by default, so a partial failure rolls
 *              back cleanly with no half-applied state.
 *            - "Runs to completion in the local development
 *              environment" is verified by Gate T1-B per AAP §0.6.3:
 *                docker compose exec backend npx node-pg-migrate up
 *                docker compose exec postgres psql -U postgres -d \
 *                  strikeforge -c "\\dt" | grep -cE \
 *                  "users|sessions|designs|orders|order_items"
 *                # expected: 5
 *
 * ----------------------------------------------------------------------------
 * Deviation from the agent-prompt template (Explainability Rule)
 * ----------------------------------------------------------------------------
 *
 * The agent prompt for this file proposed an order_state enum of
 * `('pending', 'finalized')`, a `subtotal_cents BIGINT` column, an
 * `updated_at` column, a separate `finalized_at` column on `orders`, and
 * a `unit_price_cents BIGINT` column on `order_items`. This migration
 * deviates from that template in the following ways, each justified by
 * alignment with the existing in-scope source code (which the agent
 * prompt template was not authored with full visibility into) and with
 * the higher-priority AAP sections and ST-035 acceptance criteria:
 *
 *   1. The order_state enum is `('cart', 'created', 'finalized',
 *      'cancelled')` — NOT `('pending', 'finalized')`.
 *
 *      The existing in-scope `backend/src/repositories/order.repository.ts`
 *      (line 203) already declares:
 *           export type OrderState = 'cart' | 'created' | 'finalized'
 *                                  | 'cancelled';
 *      and the SQL constants at lines 689 and 832 reference the literal
 *      values `'created'` and `'cart'` respectively — values that would
 *      be REJECTED by an enum constrained to `('pending', 'finalized')`.
 *      The migration MUST match the repository contract or the FORWARD
 *      direction would still apply but every order-related query would
 *      fail at runtime with a "invalid input value for enum order_state"
 *      error.
 *
 *      ST-035-AC1 names "(such as created or finalized)" — the literal
 *      `'created'` is in the AC text itself, not `'pending'`. The
 *      agent-prompt template's choice of `'pending'` was a less
 *      literal restatement of the AC.
 *
 *      AAP §0.5.3 describes the column simply as "state enum" without
 *      pinning the vocabulary; the AAP §0.5.1 schema-update table for
 *      `orders` says only "state enum" and the AAP §0.7.2 out-of-scope
 *      list explicitly excludes the EP-008 financial-settlement
 *      vocabulary embargo. None of `cart`, `created`, `finalized`, or
 *      `cancelled` carries financial-settlement semantics, so Rule R9
 *      is fully satisfied (the order.repository.ts header at line
 *      110-117 explicitly documents this Rule R9 compliance). The
 *      decision to use this exact enum vocabulary is documented in
 *      `docs/decisions/README.md` per the user-provided Explainability
 *      Rule (the row is owned by the maintainer of that file and lands
 *      in the same change set).
 *
 *   2. The subtotal column is `NUMERIC(12,2)` — NOT `BIGINT cents`.
 *
 *      The existing in-scope `order.repository.ts` (lines 121-130 of
 *      its file-level docblock) documents the choice in detail:
 *        "PostgreSQL's `NUMERIC(12,2)` is an arbitrary-precision
 *         decimal type. The default `pg` driver returns NUMERIC values
 *         as JavaScript strings to preserve exact precision —
 *         converting to `number` would silently lose precision for
 *         amounts above 2^53 cents..."
 *      The OrderRow type at line 553-554 types the column as `string`
 *      with the comment "NUMERIC(12,2) — pg returns this as a string
 *      to preserve precision". The INSERT_ORDER_SQL at line 690 binds
 *      the parameter via an explicit `$2::numeric` cast. The empty-
 *      cart fallback constant at line 875 is the literal string
 *      `'0.00'` — a two-decimal-place format that only makes sense
 *      against a NUMERIC column.
 *
 *      Switching the migration to BIGINT cents would force a coordinated
 *      rewrite of every SQL constant and every TypeScript type in
 *      order.repository.ts — out of scope for this single-file migration
 *      task. AAP §0.5.3 names the column simply "subtotal" without
 *      pinning the storage representation; the more precise NUMERIC(12,2)
 *      choice is consistent with that wording.
 *
 *   3. The "last-modified" column is named `last_modified_at` — NOT
 *      `updated_at`.
 *
 *      AAP §0.5.3 describes this column as the "last-modified
 *      timestamp" — the precise term `last_modified_at` matches that
 *      wording verbatim. The existing in-scope `order.repository.ts`
 *      OrderRow type (line 556), mapper (line 632), INSERT/UPDATE SQL
 *      (lines 691, 805), and the ST-030 designs migration's
 *      `last_modified_at` column on `designs` all use this name.
 *      Renaming the column to `updated_at` would require a coordinated
 *      change to order.repository.ts that is out of scope for this
 *      single-file migration task.
 *
 *   4. There is NO separate `finalized_at` column on `orders`.
 *
 *      Order finalization (ST-034) is tracked by the combination of
 *      `state = 'finalized'` AND the `last_modified_at` timestamp,
 *      which is bumped server-side via `now()` by every state
 *      transition (UPDATE_ORDER_STATE_SQL at line 801:
 *      `SET state = $3, last_modified_at = now()`). The existing in-
 *      scope `order.repository.ts` neither reads nor writes a
 *      `finalized_at` column. Adding it would constitute schema bloat
 *      with no consumer; ST-034-AC1 names the requirement as a
 *      "transition to a documented finalized state" and the state
 *      enum + last_modified_at pair is sufficient to record both the
 *      target state and the moment of transition.
 *
 *   5. There is NO `unit_price_cents` column on `order_items`.
 *
 *      The existing in-scope `order.repository.ts` neither reads nor
 *      writes a `unit_price_cents` (or any per-item amount) column.
 *      The repository explicitly documents this design at lines 257-
 *      260: "No `subtotal` per item. Per-line-item amounts are folded
 *      into the order-level subtotal by the service layer; the
 *      repository persists the aggregate without re-calculating from
 *      individual items." The order-level `orders.subtotal` is the
 *      single source of bookkeeping truth. Adding `unit_price_cents`
 *      would require either changing the repository to write to it
 *      (out of scope) or leaving it permanently NULL — neither serves
 *      ST-035-AC2 ("quantity, and any per-item metadata"; the
 *      repository contract is that the per-item amount lives in
 *      `metadata` if the service layer chooses to record it).
 *
 *   6. The order_items.id column is preserved (UUID PK).
 *
 *      The existing in-scope `order.repository.ts` does not SELECT or
 *      INSERT `id` into `order_items` (the only writes go through the
 *      `INSERT INTO order_items (order_id, design_id, quantity,
 *      metadata)` statement at line 730), so the column is silently
 *      defaulted via `gen_random_uuid()` on every row. The column is
 *      retained for general schema hygiene: stable per-row
 *      identification supports future audit logging, targeted soft-
 *      delete operations, and any future story that needs to point at
 *      a specific line item without reaching for the composite
 *      `(order_id, design_id)` natural key (which is not unique by
 *      construction — the same design can appear twice in a single
 *      order with different `metadata` values). The DEFAULT keeps the
 *      existing INSERT statement working unchanged.
 *
 * Each of these deviations is a "name it as the existing code expects"
 * or "match the repository contract" change. None alters the schema's
 * intent; all align with the higher-priority AAP §0.5.3 description of
 * the table.
 *
 * ----------------------------------------------------------------------------
 * Why NUMERIC(12,2) for subtotal
 * ----------------------------------------------------------------------------
 *
 * The configurator's amount domain is currency in dollars-and-cents.
 * Three options were considered:
 *
 *   - DOUBLE PRECISION: Floating-point. Subject to representation drift
 *     (e.g. 0.1 + 0.2 != 0.3). Forbidden for financial data.
 *
 *   - BIGINT cents: Integer cents. Avoids floating-point drift but
 *     forces every consumer of the value (frontend, JSON wire format,
 *     any reporting tool) to remember to divide by 100, which is a
 *     well-documented bug source. Requires a coordinated rewrite of
 *     the existing repository (see Deviation #2 above).
 *
 *   - NUMERIC(12,2): Arbitrary-precision decimal with 12 total digits
 *     and 2 fractional digits, supporting amounts from -9,999,999,999.99
 *     to +9,999,999,999.99 ($9.99B) at exact 1-cent precision. The pg
 *     driver returns NUMERIC as a JavaScript string by default,
 *     preserving the exact decimal value through serialization.
 *     Arithmetic is the consumer's responsibility (the repository
 *     header recommends a decimal-safe library).
 *
 * NUMERIC(12,2) is the choice already encoded in the existing in-scope
 * repository (see Deviation #2). The 12,2 sizing comfortably covers any
 * realistic single-cart amount and leaves headroom for the rare bulk
 * order without forcing a column-type migration.
 *
 * ----------------------------------------------------------------------------
 * Why ON DELETE CASCADE on orders.user_id and order_items.order_id
 * ----------------------------------------------------------------------------
 *
 * Cascading deletes from `users` to `orders` and from `orders` to
 * `order_items` is GDPR-aligned (deleting a user wipes their orders and
 * line items in the same statement, no orphan rows left behind) and
 * matches the cascade behaviour declared on `sessions.user_id` and
 * `designs.user_id` — the four tables (users, sessions, designs,
 * orders) form a coherent ownership graph rooted at `users`, with
 * `order_items` as a grandchild via `orders`.
 *
 * ----------------------------------------------------------------------------
 * Why ON DELETE RESTRICT on order_items.design_id
 * ----------------------------------------------------------------------------
 *
 * RESTRICT preserves audit integrity for historical orders: a design
 * referenced by any order_item cannot be silently dropped. This is a
 * deliberate asymmetry against the CASCADE on `designs.user_id` — a
 * user erasure that would CASCADE through to delete a design will FAIL
 * at the RESTRICT boundary if any order in the system (including
 * another user's order) still references that design. The application
 * layer is then responsible for handling the conflict (e.g. by soft-
 * deleting the design or by archiving the order before deleting the
 * design's owner). This trade-off is the canonical one for finance-
 * adjacent referential integrity: silent data loss is a worse failure
 * mode than a loud constraint violation.
 *
 * The cross-reference is documented in the ST-030 designs migration
 * (lines 280-284 of 20250115000002_ST-030_designs.js):
 *   "When a `designs` row is deleted (either via cascade from `users`
 *    or directly), the `order_items.design_id` FK introduced by ST-035
 *    should be configured ON DELETE RESTRICT so that a design
 *    referenced by any line item cannot be silently dropped — that
 *    constraint lives on the ST-035 child side and is documented
 *    there, not here."
 *
 * This file IS the ST-035 child side. The constraint is declared
 * below.
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
 *   - This file imports nothing related to token parsing or
 *     verification. Third-party token libraries forbidden by AAP §0.4.1
 *     are absent here (their absence is verified at the workspace
 *     level against backend/package.json, not against this migration).
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
 *   - Foreign-key constraints fail loudly: an attempt to INSERT an
 *     order_items row with a non-existent design_id surfaces PostgreSQL
 *     error 23503 (foreign_key_violation), which the service layer
 *     maps to HTTP 422.
 *
 * Rule R9 (financial settlement excluded):
 *   - The order_state ENUM contains EXACTLY four values: 'cart',
 *     'created', 'finalized', 'cancelled'. None of these carries
 *     financial-settlement semantics. Verification: the AAP §0.8.1
 *     Rule R9 verification regex returns zero matches against this
 *     file.
 *   - The orders.subtotal column is a bookkeeping aggregate computed
 *     by the service layer; it carries no financial-settlement
 *     semantics.
 *   - No financial-settlement columns exist on either table. Order
 *     finalization (ST-034) is a state-transition + non-financial
 *     post-processing step (inventory reservation, notification,
 *     bookkeeping) per AAP §0.2.1; downstream financial settlement
 *     is excluded per AAP §0.7.2 and EP-008's scope-exclusion
 *     section.
 *
 * Rule R10 (migration filename embeds story id):
 *   - This file's name, `20250115000003_ST-035_orders_order_items.js`,
 *     embeds `ST-035` between the timestamp prefix and the descriptive
 *     suffix. Verification:
 *       ls backend/migrations/ | grep -E '^[0-9]+_ST-[0-9]+_'
 *
 * ----------------------------------------------------------------------------
 * Coordination with other authored files
 * ----------------------------------------------------------------------------
 *
 *   - backend/migrations/20250115000001_ST-031_users_sessions.js — runs
 *     BEFORE this migration. Creates the `users` table that the
 *     `orders.user_id` FK targets; also installs the `pgcrypto`
 *     extension so `gen_random_uuid()` is available for this
 *     migration's id-column DEFAULTs.
 *
 *   - backend/migrations/20250115000002_ST-030_designs.js — runs BEFORE
 *     this migration. Creates the `designs` table that the
 *     `order_items.design_id` FK targets.
 *
 *   - backend/src/repositories/order.repository.ts — primary consumer.
 *     Issues SELECT/INSERT/UPDATE statements against the `orders` and
 *     `order_items` tables created here; relies on the column names,
 *     types, defaults, FK constraints, and the indexes defined in
 *     this file. Specifically:
 *       - INSERT_ORDER_SQL (line 689)              relies on the
 *         `id` UUID DEFAULT, the `state` enum vocabulary, and the
 *         `subtotal NUMERIC(12,2)` column type.
 *       - INSERT_ORDER_ITEMS_SQL (line 730)        relies on the
 *         `metadata` JSONB column, the `quantity > 0` CHECK, and the
 *         `order_id`/`design_id` FK targets.
 *       - FIND_ORDER_BY_ID_SQL (line 752)          relies on the PK
 *         index and the `(user_id, state)` index for ownership-pinned
 *         lookups.
 *       - FIND_ORDER_ITEMS_BY_ORDER_SQL (line 770) relies on the
 *         `(order_id)` index for efficient items-by-order retrieval.
 *       - UPDATE_ORDER_STATE_SQL (line 800)        relies on the
 *         `last_modified_at` column and the conditional state
 *         predicate for idempotent transitions (ST-034-AC3).
 *       - FIND_CART_ITEMS_FOR_USER_SQL (line 828)  relies on the
 *         `(user_id, state)` composite index to make the cart JOIN
 *         index-only.
 *       - FIND_CART_SUBTOTAL_FOR_USER_SQL (line 854) relies on the
 *         `(user_id, state)` composite index for the cart subtotal
 *         lookup.
 *
 *   - backend/src/services/order.service.ts (authored separately) —
 *     orchestrates cart retrieval (ST-033), order creation (ST-032),
 *     and order finalization (ST-034) via the repository.
 *
 *   - backend/src/routes/orders.ts and backend/src/routes/cart.ts
 *     (authored separately) — thin HTTP shells that delegate to the
 *     service.
 *
 *   - docker-compose.yml (already at repo root) declares the
 *     `postgres:15-alpine` service against which these migrations run
 *     during local development and integration tests.
 *
 *   - docs/decisions/README.md — owns the decision-log row recording
 *     the OrderState enum vocabulary choice, the NUMERIC(12,2) subtotal
 *     storage choice, and the RESTRICT vs CASCADE FK strategy. The row
 *     is the responsibility of the maintainer of the decision log and
 *     lands in the same change set per the user-provided Explainability
 *     Rule.
 * ============================================================================
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Forward migration — introduces the `order_state` ENUM type, the `orders`
 * and `order_items` tables, and the supporting indexes required by ST-035-
 * AC3 / ST-032 / ST-033 / ST-034 query patterns.
 *
 * Idempotency posture (ST-035-AC4):
 *   - `pgm.createType`, `pgm.createTable`, and `pgm.createIndex` calls do
 *     NOT use `ifNotExists` because node-pg-migrate's per-migration
 *     transaction rolls back the entire migration on conflict — the
 *     higher-level idempotency contract for the FORWARD direction is
 *     "applies once; re-applying after a successful run is a documented
 *     error". The "idempotent against repeat application on a CLEAN
 *     state" wording of AC4 is what `up`-after-fresh-`down` exercises,
 *     and the `down` direction below uses `ifExists: true` to make that
 *     round-trip repeatable.
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
 * Statement order:
 *   1. CREATE TYPE order_state — must precede the orders table because
 *      orders.state is typed as order_state.
 *   2. CREATE TABLE orders — the parent table; FK target for order_items.
 *   3. CREATE INDEX idx_orders_user_id_state — supports cart/orders-by-
 *      user-and-state queries.
 *   4. CREATE TABLE order_items — the child table; FK references orders
 *      and designs.
 *   5. CREATE INDEX idx_order_items_order_id — supports items-by-order
 *      queries.
 *
 * Reversing this order in the down direction (drop order_items first,
 * then orders, then the type) is what AC4 calls "correct foreign-key
 * dependency order".
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // ---------------------------------------------------------------------
  // (1) `order_state` ENUM type — the lifecycle vocabulary used by
  //     `orders.state`.
  //
  //     Values:
  //       'cart'      — the pre-order projection. A user may have at
  //                     most one `state='cart'` row at a time (enforced
  //                     by the service layer in ST-032). The cart JOIN
  //                     in order.repository.ts FIND_CART_ITEMS_FOR_USER_SQL
  //                     filters on this value.
  //       'created'   — the initial post-submission state. ST-032
  //                     (create order) inserts a row with this state
  //                     literal. ST-032-AC4 names this as the
  //                     "documented non-terminal state".
  //       'finalized' — the post-processing-complete state. ST-034
  //                     (finalize order) transitions to this state via
  //                     order.repository.ts updateOrderState. ST-034-AC1
  //                     names this as the "documented finalized state".
  //       'cancelled' — the off-ramp state. Reserved for cancellation
  //                     flows; not driven by any current acceptance
  //                     criterion but included here so the enum
  //                     vocabulary in this migration matches the
  //                     repository's exported `OrderState` type
  //                     verbatim and avoids a future mismatch.
  //
  //     Rule R9 compliance: NONE of these values carries financial-
  //     settlement semantics. The repository's file-level docblock at
  //     lines 110-117 explicitly documents this Rule R9 compliance.
  //     The AAP §0.8.1 Rule R9 verification regex returns zero matches
  //     against this file.
  // ---------------------------------------------------------------------
  pgm.createType('order_state', ['cart', 'created', 'finalized', 'cancelled']);

  // ---------------------------------------------------------------------
  // (2) `orders` table — durable home for every persisted purchase
  //     intent (cart projection, created order, finalized order, and
  //     cancellation off-ramp).
  //
  //     Schema mapping back to ST-035-AC1:
  //       "server-assigned identifier"     -> id  (UUID PK; DB-side
  //                                          generation via
  //                                          gen_random_uuid()).
  //       "owning user reference (enforced
  //        as a foreign key to the users
  //        table introduced in ST-031)"    -> user_id  REFERENCES
  //                                          users(id) ON DELETE
  //                                          CASCADE.
  //       "state (such as created or
  //        finalized)"                     -> state  order_state ENUM
  //                                          NOT NULL  (no DEFAULT;
  //                                          spelled out at INSERT
  //                                          time per the
  //                                          repository's documented
  //                                          design rationale).
  //       "subtotal"                       -> subtotal  NUMERIC(12,2)
  //                                          NOT NULL  CHECK
  //                                          (subtotal >= 0).
  //       "created timestamp"              -> created_at  TIMESTAMPTZ
  //                                          DEFAULT now().
  //       "last-modified timestamp"        -> last_modified_at
  //                                          TIMESTAMPTZ DEFAULT
  //                                          now().
  //
  //     Every column is NOT NULL: an order without an owner, without a
  //     state, or without a subtotal would be a partial record that
  //     the application has no use for. The defaults on `id`,
  //     `created_at`, and `last_modified_at` mean the application only
  //     supplies `user_id`, `state`, and `subtotal` at INSERT time —
  //     see INSERT_ORDER_SQL in order.repository.ts.
  // ---------------------------------------------------------------------
  pgm.createTable('orders', {
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
      // order.repository.ts FIND_ORDER_BY_ID_SQL at O(log n).
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      // TEXT — must match the `users.id` column type (also TEXT, the
      // Firebase uid per AAP §0.2.1) so the FK can be declared
      // cleanly. A `user_id UUID` declaration would error at CREATE
      // TABLE time with PostgreSQL's "foreign key constraint cannot
      // be implemented" diagnostic because the FK's child column type
      // must match the parent column type.
      //
      // ON DELETE CASCADE: deleting a user removes all of their
      // orders in one statement — GDPR-aligned and matches the
      // cascade behaviour declared on `sessions.user_id` (ST-031)
      // and `designs.user_id` (ST-030). No orphan rows, no extra
      // application-level cleanup. The order_items rows that
      // reference these orders are then cascade-deleted via the
      // `order_items.order_id` FK declared below.
      //
      // The FK reference syntax `'"users"(id)"'` (double-quoted
      // table name) preserves case-sensitivity unambiguously and
      // works across every node-pg-migrate 6.x release.
      type: 'text',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    state: {
      // order_state — the lifecycle enum created in step (1) above.
      // NOT NULL with NO DEFAULT: the application layer spells out
      // the literal state at INSERT time (e.g. 'created' for the
      // standard order-creation path, 'cart' for cart-projection
      // creation). This makes the cart-vs-created distinction
      // unambiguous in the call site rather than inferring it from
      // a column default.
      //
      // The order.repository.ts INSERT_ORDER_SQL (line 689) uses the
      // literal `'created'` directly; a column DEFAULT here would
      // either preclude `'cart'` row creation (default 'created') or
      // risk leaving rows stuck in `'cart'` after the service
      // intended `'created'` (default 'cart'). Spelling the value at
      // the call site is the cleanest design — see the repository's
      // file-level docblock at lines 670-680 for the full rationale.
      type: 'order_state',
      notNull: true,
    },
    subtotal: {
      // NUMERIC(12,2) — arbitrary-precision decimal preserving exact
      // cent-level accuracy across the configurator's amount range
      // ($0.00 to $9,999,999,999.99). The pg driver returns NUMERIC
      // values as JavaScript strings to preserve precision (a
      // `number` would silently lose precision above 2^53 cents per
      // the order.repository.ts file-level docblock, lines 121-130).
      //
      // CHECK (subtotal >= 0): a positive-or-zero invariant. The
      // subtotal is a bookkeeping aggregate, never a debit; negative
      // values would indicate either a calculation bug or an attempt
      // to model out-of-scope financial-reversal flows as negative-
      // subtotal orders — those flows are excluded from this codebase
      // per Rule R9. The CHECK constraint is the DB-tier last line of
      // defense; the service layer is expected to reject negative
      // subtotals before the INSERT is attempted.
      //
      // No DEFAULT: the application supplies the calculated subtotal
      // explicitly at INSERT time (order.repository.ts INSERT_ORDER_SQL
      // binds it as `$2::numeric`). A DEFAULT would mask service-layer
      // calculation bugs by silently substituting a wrong-but-valid
      // value.
      type: 'numeric(12,2)',
      notNull: true,
      check: 'subtotal >= 0',
    },
    created_at: {
      // TIMESTAMPTZ — the row-creation timestamp (AC1's "created
      // timestamp"). Defaulting to `now()` keeps clock authority on
      // the database side; the application never supplies a creation
      // timestamp, so cross-server clock skew cannot perturb the
      // recorded value.
      //
      // TIMESTAMPTZ (rather than TIMESTAMP without time zone) stores
      // the moment in UTC and round-trips correctly across server
      // time zones. This matches every other timestamp in the EP-012
      // schema.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_modified_at: {
      // TIMESTAMPTZ — the last-modification timestamp (AC1's "last-
      // modified timestamp"). On INSERT the column defaults to
      // `now()`; on every UPDATE the order.repository.ts
      // UPDATE_ORDER_STATE_SQL explicitly sets `last_modified_at =
      // now()` so the value tracks every state transition.
      //
      // The combination of `state = 'finalized'` AND a recent
      // `last_modified_at` timestamp is what records "this order was
      // finalized at this moment" — there is intentionally no
      // separate `finalized_at` column (see Deviation #4 in the
      // file header).
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // ---------------------------------------------------------------------
  // (3) Composite index on `(user_id, state)` per ST-035-AC3.
  //
  //     Used by order.repository.ts:
  //
  //       FIND_CART_ITEMS_FOR_USER_SQL:
  //         SELECT oi.design_id, oi.quantity, oi.metadata
  //         FROM orders o
  //         JOIN order_items oi ON oi.order_id = o.id
  //         WHERE o.user_id = $1
  //           AND o.state = 'cart'
  //         ORDER BY oi.design_id
  //
  //       FIND_CART_SUBTOTAL_FOR_USER_SQL:
  //         SELECT subtotal
  //         FROM orders
  //         WHERE user_id = $1
  //           AND state = 'cart'
  //         LIMIT 1
  //
  //     With this index in place, the planner satisfies both queries
  //     as an index range scan (or equality probe in the LIMIT 1 case)
  //     with no extra filter step. A non-composite single-column
  //     `(user_id)` index would still bound the scan to one user but
  //     would then re-filter by state in the heap; the composite is
  //     strictly better for the documented access pattern.
  //
  //     The leading `user_id` column also services any future
  //     "list orders for user $1" query without a state predicate
  //     (PostgreSQL can use the leftmost prefix of a composite index).
  //
  //     B-tree (the default index method) is the right choice here:
  //     each component supports equality and range comparisons, the
  //     index is small per row, and the composite covers the exact
  //     column set the queries need.
  // ---------------------------------------------------------------------
  pgm.createIndex('orders', ['user_id', 'state'], {
    name: 'idx_orders_user_id_state',
  });

  // ---------------------------------------------------------------------
  // (4) `order_items` table — line items belonging to an `orders` row.
  //
  //     Schema mapping back to ST-035-AC2:
  //       "owning order reference (enforced
  //        as a foreign key to the orders
  //        table)"                         -> order_id  REFERENCES
  //                                          orders(id) ON DELETE
  //                                          CASCADE.
  //       "referenced design (enforced as
  //        a foreign key to the designs
  //        table)"                         -> design_id  REFERENCES
  //                                          designs(id) ON DELETE
  //                                          RESTRICT.
  //       "quantity"                       -> quantity  INTEGER NOT
  //                                          NULL  CHECK (quantity > 0).
  //       "any per-item metadata"          -> metadata  JSONB NOT NULL
  //                                          DEFAULT '{}'::jsonb.
  //
  //     Every column except `metadata` and `created_at` is NOT NULL
  //     with no default — the application supplies these explicitly
  //     at INSERT time via order.repository.ts INSERT_ORDER_ITEMS_SQL
  //     (line 730), which binds parallel arrays via UNNEST.
  //
  //     The `id` column is a synthetic UUID PK (see Deviation #6 in
  //     the file header for the rationale): retained for general
  //     schema hygiene even though the existing repository does not
  //     reference it.
  //
  //     The `created_at` column is an audit-trail timestamp not
  //     listed in AC2 but consistent with every other table in the
  //     EP-012 schema; useful for forensic queries (e.g. "when was
  //     this line item added?") without requiring a follow-up
  //     migration.
  // ---------------------------------------------------------------------
  pgm.createTable('order_items', {
    id: {
      // UUID — synthetic line-item identifier. DB-side generation
      // via `gen_random_uuid()` so every row has a stable PK without
      // application involvement. The repository's INSERT statement
      // does not specify `id` (it uses default population); the
      // SELECT statement does not return `id` either.
      //
      // PRIMARY KEY: provides a backing UNIQUE B-tree index for
      // potential future targeted-update operations and for general
      // schema hygiene.
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    order_id: {
      // UUID — must match `orders.id` column type so the FK can be
      // declared cleanly. The FK enforces AC2's "owning order
      // reference enforced as a foreign key to the orders table"
      // requirement.
      //
      // ON DELETE CASCADE: deleting an order removes all of its
      // line items in one statement — supports clean order-deletion
      // flows and the user-erasure cascade chain
      // (users → orders → order_items).
      type: 'uuid',
      notNull: true,
      references: '"orders"(id)',
      onDelete: 'CASCADE',
    },
    design_id: {
      // UUID — must match `designs.id` column type so the FK can be
      // declared cleanly. The FK enforces AC2's "referenced design
      // enforced as a foreign key to the designs table" requirement.
      //
      // ON DELETE RESTRICT: a design referenced by any line item
      // cannot be silently dropped — preserves audit integrity for
      // historical orders. A delete attempt on a referenced design
      // surfaces PostgreSQL error 23503 (foreign_key_violation),
      // which the application layer is responsible for handling
      // (e.g. by archiving the order or by soft-deleting the
      // design). See "Why ON DELETE RESTRICT on order_items.design_id"
      // in the file header.
      type: 'uuid',
      notNull: true,
      references: '"designs"(id)',
      onDelete: 'RESTRICT',
    },
    quantity: {
      // INTEGER — positive-integer line-item quantity. INTEGER
      // (rather than SMALLINT) for headroom against bulk-order
      // scenarios where quantities can exceed 32k.
      //
      // CHECK (quantity > 0): the positive-integer invariant
      // documented in the order.repository.ts OrderItem.quantity
      // contract. The CHECK constraint is the DB-tier last line of
      // defense; the service layer is expected to reject zero and
      // negative values before the INSERT is attempted. The Zod
      // schema in the service layer will use `.int().positive()` to
      // pre-validate.
      type: 'integer',
      notNull: true,
      check: 'quantity > 0',
    },
    metadata: {
      // JSONB — opaque per-item rendering or selection metadata.
      // The repository treats this as `Record<string, unknown>` and
      // never inspects its contents (see order.repository.ts
      // OrderItem.metadata contract, line 226).
      //
      // JSONB (binary JSON) rather than JSON (text):
      //   - JSONB stores a parsed representation, so subsequent
      //     reads do not re-parse the document.
      //   - JSONB indexes (GIN) are available if a future story
      //     introduces partial-payload queries on metadata.
      //   - Whitespace and key ordering are normalised in JSONB,
      //     so equality comparisons across rows are byte-stable.
      //
      // DEFAULT '{}'::jsonb: an empty object is a sensible default
      // for line items that don't need per-item attributes. The
      // mapper in order.repository.ts line 597-602 falls back to
      // `{}` if the column ever surfaces NULL via an out-of-band
      // write, so the public-contract guarantee is preserved
      // either way.
      type: 'jsonb',
      notNull: true,
      default: pgm.func("'{}'::jsonb"),
    },
    created_at: {
      // TIMESTAMPTZ — line-item creation timestamp. Not listed in
      // AC2 but useful for forensic queries (e.g. "when was this
      // line item added to the order?") and consistent with every
      // other table in the EP-012 schema.
      //
      // DEFAULT now(): server-side default keeps clock authority on
      // the database; INSERT statements that don't specify
      // `created_at` (e.g. order.repository.ts INSERT_ORDER_ITEMS_SQL)
      // get the current transaction timestamp automatically.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // ---------------------------------------------------------------------
  // (5) Single-column index on `order_items(order_id)` per ST-035-AC3.
  //
  //     Used by order.repository.ts:
  //
  //       FIND_ORDER_ITEMS_BY_ORDER_SQL:
  //         SELECT order_id, design_id, quantity, metadata
  //         FROM order_items
  //         WHERE order_id = $1
  //         ORDER BY design_id
  //
  //       FIND_CART_ITEMS_FOR_USER_SQL (the JOIN side):
  //         JOIN order_items oi ON oi.order_id = o.id
  //
  //     Both queries probe by `order_id` — the index makes that
  //     probe O(log n) regardless of how many line items exist
  //     across all orders. Without this index, every items-by-order
  //     query would degrade to a full-table scan as the
  //     order_items table accumulates rows.
  //
  //     PostgreSQL does NOT auto-create an index on a foreign-key
  //     column; the FK constraint declared above only validates
  //     referential integrity at write time, it does not provide a
  //     read-side query optimisation. The explicit index here is
  //     what makes the FK-side queries efficient.
  //
  //     B-tree is the right choice: order_id is queried with
  //     equality predicates only, the index is small per row, and
  //     no range-scan or sort optimisation is needed beyond the
  //     base equality probe (the ORDER BY design_id in the SELECT
  //     is satisfied by an in-memory sort over the small per-order
  //     result set).
  // ---------------------------------------------------------------------
  pgm.createIndex('order_items', 'order_id', {
    name: 'idx_order_items_order_id',
  });
};


/**
 * Reverse migration — drops every artifact created by `exports.up` in
 * the correct foreign-key dependency order so the schema returns to
 * exactly the state it was in before this migration ran.
 *
 * ST-035-AC4 idempotency contract:
 *
 *   "A reverse migration drops the order_items table before the
 *    orders table (correct foreign-key dependency order), both
 *    directions are idempotent against repeat application on a clean
 *    state, and the forward migration runs to completion in the
 *    local development environment."
 *
 *   "Idempotent against repeat application on a clean state" is
 *   exercised by the round-trip: up → down → up. The forward
 *   direction's idempotency is verified by the second `up` succeeding
 *   on the schema state left by `down`. The reverse direction's
 *   idempotency is verified by the fact that every drop call below
 *   uses `{ ifExists: true }`, so a second `down` invoked against a
 *   schema that no longer contains these objects is a no-op rather
 *   than a hard error.
 *
 * Drop order (REVERSE of FK dependencies):
 *
 *   1. order_items — must drop FIRST. It holds the FK
 *      `order_items.order_id REFERENCES orders(id)`, so dropping
 *      `orders` first would either fail with a constraint-violation
 *      error or silently CASCADE-drop `order_items` along with the
 *      FK constraint (depending on PostgreSQL behaviour and the
 *      DROP modifier). Dropping `order_items` first removes the
 *      child-side reference cleanly and explicitly.
 *
 *      Note that `order_items.design_id REFERENCES designs(id)` is
 *      ON DELETE RESTRICT, but DROP TABLE is unaffected by that
 *      modifier — RESTRICT only governs row-level deletion. A DROP
 *      TABLE on `order_items` always succeeds regardless of
 *      restrictive FKs out of the table.
 *
 *   2. orders — drop after `order_items`. Once `order_items` is
 *      gone, no FK references `orders` (within the EP-012 schema),
 *      so the DROP TABLE is unconditionally safe. The
 *      `orders.user_id REFERENCES users(id)` FK is on the parent
 *      side of `orders`'s relationship with `users`; dropping
 *      `orders` removes this FK cleanly and leaves `users`
 *      untouched (which is the desired behaviour — `users` is
 *      owned by ST-031 and outlives this migration).
 *
 *   3. order_state ENUM type — drop LAST. The type is referenced
 *      by `orders.state`, so it cannot be dropped while the
 *      `orders` table exists. With `orders` already gone, the
 *      `DROP TYPE` succeeds.
 *
 *   Each drop uses `{ ifExists: true }` so a `down` invoked twice
 *   in succession (or invoked against a schema where these objects
 *   were never created) is a no-op rather than an error. This
 *   protects CI workflows that may invoke `migrate down` defensively
 *   before re-running the suite.
 *
 *   Cross-migration sequencing:
 *
 *     - The `pgcrypto` extension installed by ST-031 is
 *       intentionally NOT dropped here. It supplies
 *       `gen_random_uuid()` for the `id` column defaults of
 *       multiple tables (designs, orders, order_items) and is
 *       owned by ST-031's lifecycle, not this one. Per the ST-031
 *       file header, the extension is also intentionally not
 *       dropped by ST-031's down direction, which means it
 *       persists across all up/down cycles in the EP-012 chain.
 *
 *     - The `users` and `designs` tables are not touched here.
 *       Their lifecycles are owned by ST-031 and ST-030
 *       respectively. Running `migrate down --count 1` against
 *       this migration leaves `users` and `designs` intact.
 *
 *     - Running `migrate down --count 3` (the full EP-012 chain
 *       reset) walks the migrations in reverse: ST-035 down →
 *       ST-030 down → ST-031 down. Each step removes only its own
 *       artifacts; the cumulative result is a database with no
 *       EP-012 tables.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // (1) Drop the child table first. Removes the FK
  //     `order_items.order_id REFERENCES orders(id)` and the FK
  //     `order_items.design_id REFERENCES designs(id)` along with
  //     the table itself. Also drops the `idx_order_items_order_id`
  //     index automatically (PostgreSQL drops indexes when their
  //     parent table is dropped).
  pgm.dropTable('order_items', { ifExists: true });

  // (2) Drop the parent table second. Removes the FK
  //     `orders.user_id REFERENCES users(id)` and the table itself.
  //     Also drops the `idx_orders_user_id_state` composite index
  //     automatically.
  pgm.dropTable('orders', { ifExists: true });

  // (3) Drop the ENUM type last. The type can only be dropped when
  //     no column anywhere in the database references it; with the
  //     `orders` table gone, `orders.state` no longer exists and
  //     the type is droppable.
  pgm.dropType('order_state', { ifExists: true });
};

