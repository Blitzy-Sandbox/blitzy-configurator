---
id: ST-041
title: Deploy Build Artifact to Target Environment
epic: EP-009
layer: ci-cd
points: 5
priority: high
depends-on: [ST-040]
---

## Narrative

As a DevOps engineer, I want a deploy stage that advances the built artifact into a target environment, so that every successful build lands on a reachable URL in a known environment for validation.

## Acceptance Criteria

- [ ] The deploy stage is triggered after the build stage publishes an `IMAGE_DIGEST` for the same `COMMIT_SHA`, and accepts a `TARGET_ENV` input whose permitted values are the documented environment tokens (for example `dev`, `staging`, `prod`).
- [ ] The deploy stage releases the image identified by `IMAGE_DIGEST` into the environment identified by `TARGET_ENV` and emits the stage outputs `DEPLOYMENT_URL` and `DEPLOYMENT_ID` for downstream promotion stages to consume.
- [ ] A deployment that fails any readiness check rolls back to the previous known-good deployment for the same `TARGET_ENV`, records the failure against the pipeline run, and does not emit a successful `DEPLOYMENT_ID`.
- [ ] Every deployment is auditable: each run records which `COMMIT_SHA`, `IMAGE_DIGEST`, `TARGET_ENV`, and actor initiated the deployment, and the record is accessible without re-running the pipeline.
