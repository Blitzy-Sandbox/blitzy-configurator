---
id: ST-039
title: Enforce Integration Test Gate After Unit Test Pass
epic: EP-009
layer: ci-cd
points: 5
priority: high
depends-on: [ST-038]
---

## Narrative

As a DevOps engineer, I want an integration test gate that runs after the unit test gate, so that service-to-service interactions are verified before any build or deployment work begins.

## Acceptance Criteria

- [x] The integration test gate is triggered after the unit test gate emits a pass verdict for the same `COMMIT_SHA`, and consumes the source tree along with any documented integration fixtures.
- [x] The integration test gate executes the integration test suite and emits an integration report artifact at a documented artifact path, along with a pass/fail verdict.
- [x] A failing integration test gate blocks merge and prevents the downstream build stage from starting; a passing verdict publishes the report and unlocks the build stage.
- [x] The gate's dependencies (fixtures, test data, external stubs) are declared in versioned source so every run is reproducible given the same `COMMIT_SHA`.
