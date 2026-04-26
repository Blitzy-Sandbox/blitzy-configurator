---
id: ST-033
title: Retrieve Current Cart for Authenticated User
epic: EP-008
layer: backend
points: 3
priority: high
depends-on: [ST-024, ST-035]
---

## Narrative

As an authenticated user, I want to fetch my current cart from the server, so that my client can render it accurately on any device I'm signed in on.

## Acceptance Criteria

- [x] The retrieval endpoint requires a valid session and returns only the cart belonging to the authenticated user, never cart data belonging to other users.
- [x] The response includes each cart line item with quantity, referenced design identifier, and any per-item metadata required to render the cart, along with a calculated subtotal.
- [x] When the authenticated user has no active cart, the endpoint returns an empty cart representation with a success status rather than a not-found error.
- [x] The endpoint does not create, mutate, or finalize the cart and is safe to call repeatedly from the client without side effects.
