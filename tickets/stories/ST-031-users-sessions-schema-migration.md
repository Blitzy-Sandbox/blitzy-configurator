---
id: ST-031
title: Introduce Users and Sessions Schemas with Indexes
epic: EP-012
layer: database
points: 5
priority: high
---

## Narrative

As a developer, I want a schema migration that introduces the users and sessions tables, so that authentication flows have a durable, queryable home for accounts and session tokens.

## Acceptance Criteria

- [ ] A forward migration introduces a users table whose columns represent the server-assigned identifier, login identifier (such as email) covered by a unique index that guarantees no two users share the same identifier, credential digest, created timestamp, and any profile fields required by the registration endpoint.
- [ ] A forward migration introduces a sessions table whose columns represent the session token reference, the owning user reference (enforced as a foreign key to the users table), issued timestamp, expiration timestamp, and a revocation marker, with a unique index on the session token reference for lookup and a secondary index on the owning user reference.
- [ ] A reverse migration drops both the sessions table and the users table cleanly (sessions first, then users, in correct foreign-key dependency order), and both directions are idempotent against repeat application on a clean state.
- [ ] Credential digest columns are sized and constrained to prevent storage of cleartext credentials, and the schema is documented in a single source referenced by the authentication stories.
