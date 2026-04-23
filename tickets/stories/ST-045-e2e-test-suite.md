---
id: ST-045
title: Define and Maintain End-to-End Test Suite for Critical User Flows
epic: EP-010
layer: testing
points: 8
priority: high
test-type: e2e
depends-on: [ST-039]
---

## Narrative

As a QA engineer, I want an end-to-end test suite that drives the full user interface against running services on every merge to the default branch, so that critical user flows are verified before a change is allowed to reach a released environment.

## Acceptance Criteria

- [ ] The end-to-end suite is triggered on every merge to the default branch and on every scheduled nightly run, and exercises at least the configurator load, color selection, save-design, load-design, and order creation flows against running services.
- [ ] Each run produces a per-flow pass/fail verdict, captures screenshots or recordings for any failed flow, and emits a test report artifact at a documented path.
- [ ] A failing flow produces a failed verdict that blocks deployment to production until the flow is fixed or explicitly waived through the documented exception process.
- [ ] The suite runs in the local development environment against locally-started services so developers can reproduce failures without remote access.
