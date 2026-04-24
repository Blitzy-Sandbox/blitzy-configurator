---
id: ST-034
title: Finalize Order with Non-Payment Post-Processing
epic: EP-008
layer: backend
points: 5
priority: medium
depends-on: [ST-032]
---

## Narrative

As an authenticated user, I want my created order to be finalized through non-payment post-processing, so that the order progresses to a completed state with the downstream notifications and bookkeeping recorded.

## Acceptance Criteria

- [ ] The finalization endpoint requires a valid session, operates only on an existing order owned by the authenticated user, and transitions that order to a documented finalized state.
- [ ] Finalization triggers the non-payment post-processing steps (such as reserving inventory against the order's line items and emitting an order confirmation notification), and records the outcome of each step against the order.
- [ ] Finalization is rejected with a descriptive error when the target order is already finalized, is missing required references, or fails any post-processing step, and leaves the persisted order state coherent (either fully finalized or unchanged).
- [ ] The endpoint does not authorize, capture, refund, or otherwise process payment; every payment-related step is explicitly deferred to a future capability that is currently out of scope.
