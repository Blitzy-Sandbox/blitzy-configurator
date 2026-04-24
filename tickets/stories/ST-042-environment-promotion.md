---
id: ST-042
title: Promote Deployment Through Development, Staging, and Production
epic: EP-009
layer: ci-cd
points: 5
priority: high
depends-on: [ST-041]
---

## Narrative

As a DevOps engineer, I want a promotion stage that advances an already-deployed artifact from one environment to the next under gated approval, so that the same tested artifact flows from development to staging to production without rebuilding.

## Acceptance Criteria

- [ ] The promotion stage consumes `DEPLOYMENT_ID` (the source environment's deployment) and `PROMOTION_APPROVAL_ID` (the recorded approval) and triggers a downstream deploy stage run with the corresponding next-environment `TARGET_ENV`.
- [ ] Permitted promotion paths are development-to-staging and staging-to-production only; any other source-to-target combination is rejected with a documented error and does not trigger a downstream deploy.
- [ ] Promotion to production requires a valid, non-expired `PROMOTION_APPROVAL_ID` recorded against the staging `DEPLOYMENT_ID`; missing or revoked approvals reject the promotion and record the rejection.
- [ ] The promotion stage emits `NEXT_DEPLOYMENT_ID` as an output identifying the downstream deploy stage run it triggered, so that the promotion record is linkable to the resulting deployment without re-querying the pipeline history.
- [ ] The promoted deployment carries the same `IMAGE_DIGEST` and `COMMIT_SHA` as the source deployment, so every environment runs the exact same artifact.
