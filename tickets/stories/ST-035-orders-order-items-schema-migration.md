---
id: ST-035
title: Introduce Orders and Order Items Schema with Indexes
epic: EP-008
layer: database
points: 5
priority: high
depends-on: [ST-030, ST-031]
---

## Narrative

As a developer, I want a schema migration that introduces the orders and order_items tables with needed foreign keys and indexes, so that the order endpoints have a durable, queryable home for their records.

## Acceptance Criteria

- [ ] A forward migration introduces an orders table whose columns represent the server-assigned identifier, owning user reference, state (such as created or finalized), subtotal, created timestamp, and last-modified timestamp.
- [ ] A forward migration introduces an order_items table whose columns represent the owning order reference, referenced design, quantity, and any per-item metadata; foreign keys enforce referential integrity to the orders and designs tables.
- [ ] The migration adds indexes sufficient to query orders by owning user and by state, and to query items by owning order, without full-table scans.
- [ ] A reverse migration is provided and both directions are idempotent against repeat application on a clean state, and the forward migration runs to completion in the local development environment.
