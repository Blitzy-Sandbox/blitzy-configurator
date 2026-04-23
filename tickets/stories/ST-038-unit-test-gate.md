---
id: ST-038
title: Enforce Unit Test Gate with Coverage Threshold
epic: EP-009
layer: ci-cd
points: 5
priority: high
depends-on: [ST-037]
---

## Narrative

As a DevOps engineer, I want a unit test gate that runs after the type-check gate and enforces a coverage threshold, so that every change keeps the unit test safety net above an agreed-upon floor.

## Acceptance Criteria

- [ ] The unit test gate is triggered after the type-check gate emits a pass verdict for the same `COMMIT_SHA`, and consumes the source tree plus the `COVERAGE_THRESHOLD` environment variable.
- [ ] The unit test gate executes the unit test suite and emits a coverage report artifact at a documented artifact path, along with a pass/fail verdict and the measured coverage percentage.
- [ ] A failing unit test, or a coverage percentage below `COVERAGE_THRESHOLD`, produces a failed verdict that blocks merge and prevents the downstream integration test gate from starting.
- [ ] The gate fails closed: an infrastructure or tooling error during the gate is reported as a failed verdict rather than being interpreted as a pass.
