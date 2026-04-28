---
id: ST-044
title: Define and Maintain Integration Test Suite for Service Interactions
epic: EP-010
layer: testing
points: 5
priority: high
test-type: integration
depends-on: [ST-039]
---

## Narrative

As a QA engineer, I want an integration test suite that exercises service-to-service interactions on every pull request, so that contract drift between components is caught before it reaches a built artifact.

## Acceptance Criteria

- [x] The integration test suite is triggered on every pull request open and on every subsequent push to an open pull request against the default branch.
- [x] Each run uses deterministic fixtures (seeded data, stubbed external dependencies) so repeated runs against the same source tree produce the same verdict, and the run emits an integration report artifact at a documented path.
- [x] A failing integration test produces a failed verdict that blocks merge; the suite distinguishes assertion failures from environment or fixture-setup failures in the report.
- [x] The suite runs in the local development environment against locally-started dependencies and does not require network access to remote environments.
