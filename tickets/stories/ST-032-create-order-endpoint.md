---
id: ST-032
title: Create Order from Cart Contents via Order Endpoint
epic: EP-008
layer: backend
points: 5
priority: high
depends-on: [ST-024, ST-030, ST-035]
---

## Narrative

As an authenticated user, I want my cart contents to be turned into a persistent order, so that the configurator has a durable record of what I intend to purchase.

## Acceptance Criteria

- [x] The create-order endpoint requires a valid session and writes a new order record with order line items derived from the authenticated user's current cart contents.
- [x] A successful order creation returns the canonical persisted order, including a server-assigned order identifier, the line items, a calculated subtotal, and a created timestamp.
- [x] Requests with empty carts, malformed line items, or invalid references to designs are rejected with descriptive errors and leave the persistence layer unchanged.
- [x] The endpoint persists the order in a documented non-terminal state and defers downstream financial settlement to a separate capability that is currently out of scope, as catalogued in the epic's scope-exclusion section.
