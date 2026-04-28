---
id: ST-043
title: Define and Maintain Unit Test Suite with Coverage Report
epic: EP-010
layer: testing
points: 5
priority: high
test-type: unit
depends-on: [ST-038]
---

## Narrative

As a QA engineer, I want a unit test suite that runs on every pull request, so that regressions in single-unit logic are caught at the earliest possible moment.

## Acceptance Criteria

- [x] The unit test suite is triggered on every pull request open and on every subsequent push to an open pull request against the default branch.
- [x] Each run produces a coverage report artifact at a documented path and surfaces both a pass/fail verdict and a measured coverage percentage.
- [x] A failing assertion, a test exception, or a coverage percentage below the documented threshold produces a failed verdict; the suite is deterministic, so repeated runs against the same source tree produce the same verdict.
- [x] The suite runs in the local development environment without any additional services or network access beyond the standard local toolchain.
