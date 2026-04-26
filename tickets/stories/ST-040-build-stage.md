---
id: ST-040
title: Produce Immutable Build Artifact After Integration Test Pass
epic: EP-009
layer: ci-cd
points: 5
priority: high
depends-on: [ST-039]
---

## Narrative

As a DevOps engineer, I want a build stage that produces an immutable, addressable artifact after all gates pass, so that downstream deploy and promotion stages advance the same artifact rather than rebuilding from source.

## Acceptance Criteria

- [ ] The build stage is triggered after the integration test gate emits a pass verdict for the same `COMMIT_SHA`, and consumes the source tree at that commit.
- [ ] The build stage produces a content-addressable container image and publishes it to the target registry, and emits the stage outputs `IMAGE_DIGEST`, `COMMIT_SHA`, and `BUILD_TIMESTAMP` for downstream stages to consume.
- [ ] A build that fails for any reason (compilation error, resource exhaustion, registry rejection) produces no image digest, marks the pipeline run as failed, and prevents the downstream deploy stage from starting.
- [ ] The produced artifact is immutable: the digest uniquely identifies the image content, and rebuilding the same `COMMIT_SHA` does not overwrite the previously published artifact.
