---
id: ST-037
title: Enforce Type-Check Gate After Lint Pass
epic: EP-009
layer: ci-cd
points: 3
priority: high
depends-on: [ST-036]
---

## Narrative

As a DevOps engineer, I want a type-check gate that runs after the lint gate, so that type errors are caught before any test runs or builds consume compute budget.

## Acceptance Criteria

- [ ] The type-check gate is triggered after the lint gate emits a pass verdict for the same `COMMIT_SHA` on the same pull request.
- [ ] The type-check gate consumes the source tree and emits a type report artifact at a documented artifact path, along with a pass/fail verdict.
- [ ] A failing type-check gate blocks merge and prevents the downstream unit test gate from starting; a passing verdict publishes the report and unlocks the next stage.
- [ ] The type-check gate's configuration (strictness, target paths, ignore list) is stored as versioned source and changes to it require the same review path as any other source change.
