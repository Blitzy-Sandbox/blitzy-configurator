/* eslint-disable camelcase */
// @ts-check
/*
 * ============================================================================
 * ST-031: Introduce Users and Sessions Schemas with Indexes
 * ============================================================================
 *
 * Story:     ST-031 — Introduce Users and Sessions Schemas with Indexes
 * Epic:      EP-012 — Database Schemas & Migrations
 * Layer:     database
 * Position:  FIRST migration in the dependency chain (no prerequisites).
 *            Run order across the three EP-012 migrations:
 *               (1) 20250115000001_ST-031_users_sessions.js   <- THIS FILE
 *               (2) 20250115000002_ST-030_designs.js
 *               (3) 20250115000003_ST-035_orders_order_items.js
 *
 * ----------------------------------------------------------------------------
 * Acceptance criteria mapping (verbatim from
 * `tickets/stories/ST-031-users-sessions-schema-migration.md`)
 * ----------------------------------------------------------------------------
 *
 *   AC1 — "A forward migration introduces a users table whose columns
 *          represent the server-assigned identifier, login identifier
 *          (such as email) covered by a unique index that guarantees no
 *          two users share the same identifier, credential digest,
 *          created timestamp, and any profile fields required by the
 *          registration endpoint."
 *
 *          Implementation:
 *            - users.id              TEXT PRIMARY KEY  (server-assigned
 *                                    identifier == Firebase uid; see
 *                                    'AAP §0.2.1 implicit resolution'
 *                                    note below for why this is TEXT
 *                                    rather than UUID).
 *            - users.login_identifier TEXT NOT NULL UNIQUE  (the unique
 *                                    index is the implicit backing index
 *                                    on the UNIQUE constraint).
 *            - users.credential_digest VARCHAR(255) NULL with a CHECK
 *                                    constraint pinning it to NULL —
 *                                    see AC4 below.
 *            - users.created_at      TIMESTAMPTZ NOT NULL DEFAULT now().
 *
 *   AC2 — "A forward migration introduces a sessions table whose columns
 *          represent the session token reference, the owning user
 *          reference (enforced as a foreign key to the users table),
 *          issued timestamp, expiration timestamp, and a revocation
 *          marker, with a unique index on the session token reference
 *          for lookup and a secondary index on the owning user
 *          reference."
 *
 *          Implementation:
 *            - sessions.token_ref    TEXT PRIMARY KEY  (the PK is the
 *                                    "unique index on the session token
 *                                    reference for lookup" per AC2 — a
 *                                    PRIMARY KEY constraint creates a
 *                                    backing UNIQUE index automatically).
 *            - sessions.user_id      TEXT NOT NULL  REFERENCES users(id)
 *                                    ON DELETE CASCADE  (foreign key,
 *                                    "owning user reference enforced as
 *                                    a foreign key").
 *            - sessions.issued_at    TIMESTAMPTZ NOT NULL DEFAULT now().
 *            - sessions.expires_at   TIMESTAMPTZ NOT NULL.
 *            - sessions.revoked_at   TIMESTAMPTZ NULL  (the revocation
 *                                    marker; non-null means revoked,
 *                                    NULL means active).
 *            - idx_sessions_user_id  is the AC2 "secondary index on the
 *                                    owning user reference".
 *
 *   AC3 — "A reverse migration drops both the sessions table and the
 *          users table cleanly (sessions first, then users, in correct
 *          foreign-key dependency order), and both directions are
 *          idempotent against repeat application on a clean state."
 *
 *          Implementation:
 *            - exports.down() drops `sessions` BEFORE `users` (sessions
 *              has a FK referencing users.id; dropping the parent first
 *              would error).
 *            - Both `dropTable` calls pass `{ ifExists: true }` so a
 *              repeated `down` against an already-dropped state is a
 *              no-op rather than an error.
 *            - `pgm.createExtension('pgcrypto', { ifNotExists: true })`
 *              in `up` makes the FORWARD direction idempotent against
 *              repeated application on a clean state — re-applying when
 *              the extension already exists is a no-op.
 *
 *   AC4 — "Credential digest columns are sized and constrained to
 *          prevent storage of cleartext credentials, and the schema is
 *          documented in a single source referenced by the
 *          authentication stories."
 *
 *          Implementation:
 *            - The `users.credential_digest` column is sized
 *              VARCHAR(255) — large enough for any modern hash digest
 *              (bcrypt 60, scrypt variable, Argon2 ~100, SHA-512 hex
 *              128) but bounded against arbitrarily large payloads.
 *            - The column carries a CHECK constraint
 *              `CHECK (credential_digest IS NULL)` which is the
 *              strongest possible reading of "constrained to prevent
 *              storage of cleartext credentials": the column is
 *              physically incapable of storing ANY value, cleartext or
 *              digest. Per Rule R3 + AAP §0.2.1 the column exists ONLY
 *              for ST-031-AC4 schema-shape conformance; Firebase Auth
 *              owns credentials end-to-end and the application layer
 *              has no write path that targets this column.
 *            - This file IS the single source of truth for the schema
 *              (see this header). Authentication stories ST-023, ST-024,
 *              ST-025, and ST-026 cross-reference this migration in
 *              their `depends-on:` frontmatter (ST-023 directly via
 *              `depends-on: [ST-031]`; ST-025 and ST-026 transitively
 *              via the session stories that read/write the `sessions`
 *              table created here).
 *
 * ----------------------------------------------------------------------------
 * AAP §0.2.1 implicit resolution — why `users.id` is TEXT (the Firebase uid)
 * ----------------------------------------------------------------------------
 *
 * The user prompt mandates that authentication uses Firebase Admin SDK
 * `verifyIdToken` exclusively (Rule R3). AAP §0.2.1 documents the
 * resolution: "the local users table stores the Firebase uid as the
 * server-assigned identifier along with login-identifier and timestamp
 * columns".
 *
 * The architectural consequence is that `users.id` IS the Firebase uid
 * (a TEXT/string), NOT a separate UUID with `firebase_uid` as an extra
 * column. This:
 *
 *   1. Eliminates a translation table on the request hot path. After
 *      `verifyIdToken(rawBearerToken)` returns the verified `uid`, the
 *      session-validation middleware queries `users WHERE id = $1`
 *      directly — one O(log n) PK probe, no extra JOIN.
 *   2. Keeps every downstream FK column (`sessions.user_id`,
 *      `designs.user_id`, `orders.user_id`) typed as TEXT, matching the
 *      Firebase uid format that arrives over the wire.
 *   3. Avoids a class of "uid drift" bugs where the local UUID and the
 *      Firebase uid disagree because one was used in some queries and
 *      the other in others.
 *
 * The existing in-scope repositories
 *   - backend/src/repositories/user.repository.ts
 *   - backend/src/repositories/session.repository.ts
 *   - backend/src/repositories/design.repository.ts
 *   - backend/src/repositories/order.repository.ts
 * all encode this assumption — for example
 *   `INSERT INTO users (id, login_identifier) VALUES ($1, $2)` with
 *   `$1 = params.firebaseUid`. The schema below is the exact shape
 * those queries target.
 *
 * ----------------------------------------------------------------------------
 * Rule compliance
 * ----------------------------------------------------------------------------
 *
 * Rule R3 (Firebase Admin SDK only — AAP §0.8.1):
 *   - This migration introduces NO column intended to receive a
 *     credential. The `users.credential_digest` column exists ONLY for
 *     ST-031-AC4 schema-shape conformance; its CHECK constraint pins it
 *     to NULL so even direct SQL inserts cannot smuggle a credential
 *     past the application layer.
 *   - This file imports nothing related to token parsing or
 *     verification. The forbidden third-party token-handling
 *     libraries enumerated in AAP §0.4.1 are absent here (verified by
 *     the AAP §0.4.1 forbidden-package grep check at the workspace
 *     level). Token validation is the exclusive responsibility of the
 *     Firebase-Admin-SDK-backed wrapper at
 *     `backend/src/auth/firebase-admin.ts`.
 *
 * Rule R2 (no credential material in logs/DB — AAP §0.8.1):
 *   - The `sessions.token_ref` column is documented in
 *     `backend/src/repositories/session.repository.ts` as a STABLE
 *     OPAQUE REFERENCE supplied by the service layer (typically a
 *     SHA-256 hash of the Firebase id token's `jti` claim or a
 *     server-minted opaque session id). It is NEVER a raw Firebase
 *     id token. Raw id tokens appear only in HTTP `Authorization`
 *     headers and are validated via `admin.auth().verifyIdToken()`
 *     (Rule R3) — they are NEVER persisted.
 *
 * Rule R10 (migration filename embeds story id — AAP §0.8.1):
 *   - This file's name, `20250115000001_ST-031_users_sessions.js`,
 *     embeds `ST-031` between the timestamp prefix and the descriptive
 *     suffix. Verification:
 *       ls backend/migrations/ | grep -E '^[0-9]+_ST-[0-9]+_'
 *
 * Rule R8 (gates fail closed — AAP §0.8.1):
 *   - Both `up` and `down` raise on any unexpected SQL error. node-pg-
 *     migrate wraps each migration in a transaction by default, so a
 *     partial failure rolls back cleanly — no half-applied state.
 *
 * Rule R4 (no env defaults in source — AAP §0.8.1):
 *   - This migration reads NO environment variables. The `pg`
 *     connection string used by node-pg-migrate is supplied at the CLI
 *     boundary by `backend/src/db/pool.ts` reading `DATABASE_URL`.
 *
 * ----------------------------------------------------------------------------
 * Sessions semantics summary (ST-024 / ST-025 / ST-026)
 * ----------------------------------------------------------------------------
 *
 *   - On login (ST-024) the auth service inserts a row:
 *       INSERT INTO sessions (token_ref, user_id, issued_at, expires_at)
 *       VALUES ($1, $2, $3, $4);
 *     where `token_ref` is the opaque hash/identifier described above.
 *
 *   - On logout (ST-025) the auth service marks the row revoked:
 *       UPDATE sessions
 *       SET    revoked_at = COALESCE(revoked_at, now())
 *       WHERE  token_ref = $1;
 *     The `COALESCE` makes logout idempotent (ST-025-AC3) and preserves
 *     the FIRST revocation timestamp on repeated calls.
 *
 *   - On every authenticated request (ST-026) the session middleware:
 *       1. Calls `admin.auth().verifyIdToken(rawBearerToken)` —
 *          Firebase decides whether the id token is cryptographically
 *          valid and unexpired (Rule R3).
 *       2. Looks up the corresponding row by `token_ref`.
 *       3. Rejects requests where the row is missing OR `revoked_at IS
 *          NOT NULL` OR `expires_at <= now()`.
 *
 * ----------------------------------------------------------------------------
 * Deviation from the agent-prompt template (Explainability Rule)
 * ----------------------------------------------------------------------------
 *
 * The agent-prompt for this file proposed a literal schema with `id`
 * UUID PK, a separate `firebase_uid` column, an `email` column, an
 * `updated_at` column, a `sessions.id` UUID PK, and a `revocation_reason`
 * column. This migration deviates from that template in the following
 * ways, each justified by alignment with the higher-priority AAP
 * sections and with the in-scope existing repositories:
 *
 *   1. `users.id` is TEXT (Firebase uid), not a separate UUID with a
 *      `firebase_uid` companion column. AAP §0.2.1 implicit resolution
 *      and AAP §0.5.3 ("users (id PK, login identifier UNIQUE,
 *      credential digest …, created timestamp)") both align with this
 *      design. The existing user.repository.ts INSERT statement
 *      (`INSERT INTO users (id, login_identifier) VALUES ($1, $2)`
 *      with `$1 = params.firebaseUid`) requires this exact shape.
 *
 *   2. The login identifier column is named `login_identifier` (not
 *      `email`) so existing repository SQL — which uses
 *      `WHERE login_identifier = $1` — runs without modification. This
 *      also matches AAP §0.5.3's "login identifier UNIQUE" wording
 *      verbatim.
 *
 *   3. No `updated_at` column on `users`. AAP §0.5.3 lists only
 *      "created timestamp" for the `users` table, and the existing
 *      user.repository.ts neither reads nor writes an `updated_at`
 *      column. Adding the column would constitute schema bloat with no
 *      consumer.
 *
 *   4. `sessions.token_ref` is the PRIMARY KEY (not a separate UNIQUE
 *      column with `id` as the PK). AAP §0.5.3 lists `sessions
 *      (token ref, user FK, issued timestamp, expires timestamp,
 *      revocation marker)` — only five columns, no separate `id`. The
 *      existing session.repository.ts queries by `token_ref` and its
 *      documentation explicitly describes this column as the PRIMARY
 *      KEY. AC2's "unique index on the session token reference for
 *      lookup" is satisfied by the PK's backing UNIQUE index.
 *
 *   5. No `revocation_reason` column on `sessions`. AAP §0.5.3's
 *      "revocation marker" is satisfied by `revoked_at` (NULL =
 *      active, non-null = revoked at this time). The existing
 *      session.repository.ts neither reads nor writes a
 *      `revocation_reason` column. Adding the column would constitute
 *      schema bloat with no consumer.
 *
 *   6. `users.credential_digest` carries an additional
 *      `CHECK (credential_digest IS NULL)` constraint. AC4 says the
 *      column must be "sized and constrained to prevent storage of
 *      cleartext credentials". The CHECK constraint is the strongest
 *      possible reading: the column is physically unable to store ANY
 *      value, cleartext or otherwise. The user.repository.ts header
 *      explicitly cross-references this constraint
 *      ("the schema CHECK constraint (defined in the ST-031
 *      migration) makes [non-null storage] physically impossible
 *      unless someone bypasses the application layer to write
 *      directly to the table").
 *
 * The Explainability Rule requires non-trivial deviations to be
 * recorded in `docs/decisions/README.md`. This file's authoring is
 * scoped to the schema only; the corresponding decision row is owned
 * by the Track-1 backend agent that maintains the decision log and
 * lands in the same change set.
 * ============================================================================
 */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Forward migration — introduces the `users` and `sessions` tables and
 * the secondary indexes required by ST-031-AC2 / ST-026 query patterns.
 *
 * Idempotency posture (ST-031-AC3):
 *   - `pgm.createExtension('pgcrypto', { ifNotExists: true })` is a
 *     no-op when the extension is already present (e.g. PostgreSQL
 *     13+ ships `gen_random_uuid()` in `pg_catalog` natively, and the
 *     extension may also have been installed by an earlier deployment).
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
 * Why `pgcrypto` here when this migration itself does not use
 * `gen_random_uuid()`:
 *   - The two follow-on migrations in EP-012 (ST-030 designs and
 *     ST-035 orders/order_items) DO use `gen_random_uuid()` for their
 *     UUID primary keys. Enabling the extension in the FIRST migration
 *     of the chain is the single safest place to do it.
 *   - PostgreSQL 13+ provides `gen_random_uuid()` from `pg_catalog`
 *     without needing the extension, but the `IF NOT EXISTS` guard
 *     keeps the migration portable to PostgreSQL 12 environments
 *     occasionally encountered in CI fallbacks.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  // -------------------------------------------------------------------
  // (1) Ensure `gen_random_uuid()` is reachable for downstream
  //     migrations. PostgreSQL 13+ ships this in `pg_catalog`; we
  //     additionally install `pgcrypto` for portability to older
  //     PostgreSQL versions encountered in some CI fallback images.
  //     `ifNotExists` makes the call idempotent against re-application
  //     and against the extension being pre-installed by a base image.
  // -------------------------------------------------------------------
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // -------------------------------------------------------------------
  // (2) `users` table — local mirror of Firebase Auth identities.
  //
  //     Schema mapping back to ST-031-AC1:
  //       "server-assigned identifier"     -> id  (the Firebase uid;
  //                                          server-assigned by
  //                                          Firebase Auth, mirrored
  //                                          here as the local PK).
  //       "login identifier (such as email)
  //        covered by a unique index"      -> login_identifier UNIQUE.
  //       "credential digest"              -> credential_digest
  //                                          (sized + CHECK-constrained
  //                                          to NULL per AC4).
  //       "created timestamp"              -> created_at TIMESTAMPTZ
  //                                          DEFAULT now().
  //       "any profile fields required by
  //        the registration endpoint"      -> the four columns above
  //                                          are the documented set
  //                                          (see ST-023 acceptance
  //                                          criteria — registration
  //                                          accepts and persists the
  //                                          documented required
  //                                          fields, which is exactly
  //                                          login_identifier and the
  //                                          server-side
  //                                          firebaseUid -> id).
  // -------------------------------------------------------------------
  pgm.createTable('users', {
    id: {
      // TEXT — the Firebase uid is a string (typically 28 base-62
      // characters; never a UUID). Per AAP §0.2.1 implicit resolution
      // we use the Firebase uid directly as the local PK so the
      // session middleware can resolve `uid -> user record` in O(log n)
      // without a translation table.
      type: 'text',
      primaryKey: true,
      // No default — the auth service supplies the Firebase uid
      // explicitly at INSERT time; a server-side default would
      // generate a wrong identifier.
    },
    login_identifier: {
      // The user-facing login identifier (e.g. email). UNIQUE
      // satisfies AC1 "covered by a unique index that guarantees no
      // two users share the same identifier"; the database surfaces a
      // duplicate as PG error code 23505 (unique_violation), which the
      // service layer maps to HTTP 409 Conflict per ST-023-AC3.
      type: 'text',
      notNull: true,
      unique: true,
    },
    credential_digest: {
      // VARCHAR(255) — large enough for any modern hash digest
      // (bcrypt 60 chars, scrypt variable, Argon2 ~100, SHA-512 hex
      // 128) but bounded against arbitrarily large payloads. The
      // CHECK constraint `credential_digest IS NULL` then locks the
      // column to NULL as the strongest possible reading of AC4
      // ("constrained to prevent storage of cleartext credentials"):
      // the column is physically unable to store ANY value, cleartext
      // or digest. Per Rule R3 + AAP §0.2.1 the column exists ONLY
      // for ST-031-AC4 schema-shape conformance; the application layer
      // has no write path that targets it.
      type: 'varchar(255)',
      notNull: false,
      check: 'credential_digest IS NULL',
    },
    created_at: {
      // The local row-creation timestamp. Distinct from the Firebase
      // account-creation timestamp; this column records when the
      // local mirror was first populated, which is what audit and
      // forensic queries against this database want to know.
      // TIMESTAMPTZ stores moments in UTC and round-trips correctly
      // across server timezones.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  // Note: the UNIQUE constraint on `login_identifier` automatically
  // creates a backing unique index — no separate `pgm.createIndex`
  // call is needed to satisfy AC1's "covered by a unique index"
  // requirement.

  // -------------------------------------------------------------------
  // (3) `sessions` table — local revocation list and login-audit log.
  //
  //     Schema mapping back to ST-031-AC2:
  //       "session token reference"        -> token_ref TEXT PK (the
  //                                          PK gives the AC2 "unique
  //                                          index on the session
  //                                          token reference for
  //                                          lookup").
  //       "owning user reference (enforced
  //        as a foreign key to users)"     -> user_id REFERENCES
  //                                          users(id) ON DELETE
  //                                          CASCADE.
  //       "issued timestamp"               -> issued_at TIMESTAMPTZ
  //                                          DEFAULT now().
  //       "expiration timestamp"           -> expires_at TIMESTAMPTZ
  //                                          NOT NULL.
  //       "revocation marker"              -> revoked_at TIMESTAMPTZ
  //                                          NULL  (NULL == active,
  //                                          non-null == revoked at
  //                                          that timestamp).
  //
  //     The `ON DELETE CASCADE` on the FK supports clean GDPR-erasure
  //     and test-teardown flows: deleting a user row deletes all of
  //     their sessions automatically, with no orphan rows left
  //     behind.
  // -------------------------------------------------------------------
  pgm.createTable('sessions', {
    token_ref: {
      // TEXT — an opaque, stable, server-minted reference supplied by
      // the auth service (typically a SHA-256 hash of the Firebase id
      // token's `jti` claim, or a server-minted opaque session id).
      // Per Rule R2 this is NEVER a raw Firebase id token: raw id
      // tokens appear only in HTTP `Authorization` headers and are
      // validated by `admin.auth().verifyIdToken()` (Rule R3) — they
      // are never persisted to PostgreSQL.
      //
      // PRIMARY KEY: gives the AC2 "unique index on the session token
      // reference for lookup" automatically; the resulting B-tree
      // index keeps the ST-026-AC4 hot-path lookup
      // (`SELECT ... WHERE token_ref = $1`) at O(log n).
      type: 'text',
      primaryKey: true,
    },
    user_id: {
      // TEXT — must match the `users.id` column type so the FK can be
      // declared cleanly. The FK constraint is the AC2 enforcement
      // mechanism for "owning user reference enforced as a foreign
      // key to the users table".
      //
      // ON DELETE CASCADE: deleting a user row removes all of their
      // sessions in one statement — no orphan rows, no extra
      // application-level cleanup. Useful for GDPR-erasure and
      // for test-suite teardown.
      type: 'text',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    issued_at: {
      // The local server-side login timestamp. Defaulting to `now()`
      // keeps clock authority on the database side — the auth service
      // does not need to construct a timestamp at insert time.
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    expires_at: {
      // The instant after which the session is no longer considered
      // active regardless of revocation status. The auth service
      // derives this from the Firebase id token's `exp` claim (or a
      // server-side policy fallback) so the local revocation check
      // and the cryptographic JWT check agree on end-of-life.
      // No DEFAULT: every insert MUST supply this value explicitly.
      type: 'timestamptz',
      notNull: true,
    },
    revoked_at: {
      // The "revocation marker" of AC2. NULL means the session is
      // active. A non-null value records the FIRST revocation
      // timestamp; the auth service uses
      // `SET revoked_at = COALESCE(revoked_at, now())` to make logout
      // idempotent (ST-025-AC3) and to preserve the audit-correct
      // first-revocation moment on repeated logout calls against the
      // same token_ref.
      type: 'timestamptz',
      notNull: false,
    },
  });

  // -------------------------------------------------------------------
  // (4) Secondary index on `sessions(user_id)` per ST-031-AC2.
  //
  //     Used by user-scoped revocation flows (e.g. "revoke all
  //     sessions for user $uid"), session-counting diagnostics, and
  //     any future garbage-collection sweep that operates by owner.
  //     A regular (non-partial) B-tree index is the right tool here:
  //     the predicate space is the full table, not a filtered subset.
  // -------------------------------------------------------------------
  pgm.createIndex('sessions', 'user_id', {
    name: 'idx_sessions_user_id',
  });

  // -------------------------------------------------------------------
  // (5) Partial index for fast active-session lookup (ST-026 hot
  //     path).
  //
  //     Most queries that ask "is this user's session still valid?"
  //     filter on `revoked_at IS NULL` (active sessions only). As the
  //     table accumulates revoked rows over months, a non-partial
  //     index would grow unboundedly while always being scanned with
  //     a filter that excludes most of its entries. The partial
  //     index includes ONLY active rows, so it stays small and is
  //     exactly the rows the planner wants for active-session
  //     queries. node-pg-migrate's `where` option emits the partial-
  //     index `WHERE` clause in the generated CREATE INDEX statement
  //     (verified in `node_modules/node-pg-migrate/dist/operations/
  //     indexes.js` at the `${where}` interpolation).
  // -------------------------------------------------------------------
  pgm.createIndex('sessions', ['user_id', 'revoked_at'], {
    name: 'idx_sessions_user_id_active',
    where: 'revoked_at IS NULL',
  });
};

/**
 * Reverse migration — drops `sessions` then `users` in correct
 * foreign-key dependency order, and is idempotent against repeated
 * application via `ifExists: true` on each drop.
 *
 * `pgcrypto` is intentionally NOT dropped:
 *   - The two follow-on migrations in EP-012 (ST-030 designs and
 *     ST-035 orders/order_items) also rely on `gen_random_uuid()`.
 *     Dropping the extension here would break the round-trip
 *     reverse-then-forward sequence at the next migration's `up`.
 *   - Extensions are typically managed at a level above per-migration
 *     teardown; if the entire schema is being torn down (rare), the
 *     manual sequence is `node-pg-migrate down --count <N>` followed
 *     by `DROP EXTENSION pgcrypto` issued out of band.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  // -------------------------------------------------------------------
  // (1) Drop `sessions` BEFORE `users` per ST-031-AC3 ("sessions
  //     first, then users, in correct foreign-key dependency order").
  //     The `ON DELETE CASCADE` on sessions.user_id FK does NOT help
  //     here — that cascade fires on ROW deletion, not on parent-
  //     TABLE drop. PostgreSQL refuses to drop the parent table while
  //     the child table still references it (unless `CASCADE` is
  //     used at the DROP statement level, which would be a bigger
  //     hammer than necessary).
  // -------------------------------------------------------------------
  pgm.dropTable('sessions', { ifExists: true });

  // -------------------------------------------------------------------
  // (2) Drop `users` after `sessions` is gone. The `ifExists` guard
  //     makes a re-applied `down` against an already-dropped state a
  //     no-op rather than an error — required for ST-031-AC3
  //     "idempotent against repeat application on a clean state".
  // -------------------------------------------------------------------
  pgm.dropTable('users', { ifExists: true });

  // Intentional: do NOT `pgm.dropExtension('pgcrypto')` here. See
  // function-level docblock above for the rationale.
};
