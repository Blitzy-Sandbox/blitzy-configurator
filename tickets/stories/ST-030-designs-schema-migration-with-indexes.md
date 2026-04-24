---
id: ST-030
title: Introduce Designs Schema with Ownership and Indexes
epic: EP-012
layer: database
points: 5
priority: high
depends-on: [ST-031]
---

## Narrative

As a developer, I want a schema migration that introduces the designs table with needed indexes, so that design persistence endpoints have a durable, queryable home for their records.

## Acceptance Criteria

- [ ] A forward migration introduces a designs table whose columns represent the server-assigned identifier, owning user reference (enforced as a foreign key to the users table introduced in ST-031), title, full design payload (colors, pattern, finish, logo reference and placement), and created/last-modified timestamps.
- [ ] The migration adds indexes sufficient to query designs by owning user and by last-modified timestamp in the documented ordering without full-table scans.
- [ ] A reverse migration is provided that drops the designs table cleanly in correct dependency order, and both directions are idempotent against repeat application on a clean state.
- [ ] The forward migration runs to completion against an empty database and against a non-empty database in the local development environment without data loss.
