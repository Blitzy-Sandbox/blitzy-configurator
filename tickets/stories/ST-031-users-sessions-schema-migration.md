---
id: ST-031
title: Introduce Users and Sessions Schemas with Indexes
epic: EP-007
layer: database
points: 5
priority: high
---

## Narrative

As a developer, I want a schema migration that introduces the users and sessions tables, so that authentication flows have a durable, queryable home for accounts and session tokens.

## Acceptance Criteria

- [ ] A forward migration introduces a users table whose columns represent the server-assigned identifier, unique user identifier (such as email), credential digest, created timestamp, and any profile fields required by the registration endpoint.
- [ ] A forward migration introduces a sessions table whose columns represent the session token reference, the owning user reference, issued timestamp, expiration timestamp, and a revocation marker, with indexes sufficient to look up sessions by token reference and by owning user.
- [ ] A reverse migration is provided for both tables and both directions are idempotent against repeat application on a clean state.
- [ ] Credential digest columns are sized and constrained to prevent storage of cleartext credentials, and the schema is documented in a single source referenced by the authentication stories.
