---
id: ST-034
title: Finalize Order with Post-Processing Steps
epic: EP-008
layer: backend
points: 5
priority: medium
depends-on: [ST-024, ST-032, ST-035]
---

## Narrative

As an authenticated user, I want my created order to be finalized by the documented post-processing workflow, so that the order progresses to a completed state with the required downstream notifications and bookkeeping recorded.

## Acceptance Criteria

- [ ] The finalization endpoint requires a valid session, operates only on an existing order owned by the authenticated user, and transitions that order to a documented finalized state.
- [ ] Finalization triggers the documented post-processing workflow (such as reserving inventory against the order's line items, emitting an order confirmation notification to the authenticated user, and recording order-state bookkeeping entries), and persists the outcome of each step against the order.
- [ ] Finalization is rejected with a descriptive error when the target order is already finalized, is missing required references, or fails any post-processing step, and leaves the persisted order state coherent (either fully finalized or unchanged).
- [ ] The scope of finalization is limited to the post-processing workflow named above and explicitly excludes any downstream financial settlement activity, which remains out of scope per the epic's scope-exclusion section.
