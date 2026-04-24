---
id: ST-036
title: Enforce Lint Gate on Pull Requests
epic: EP-009
layer: ci-cd
points: 3
priority: high
---

## Narrative

As a DevOps engineer, I want the pipeline to run a lint gate on every pull request, so that style and static-analysis failures are caught before a change is allowed to advance.

## Acceptance Criteria

- [ ] The lint gate is triggered on every pull request open and on every subsequent push to an open pull request against the default branch.
- [ ] The lint gate consumes the pull request source tree at commit `COMMIT_SHA` and emits a lint report artifact at a documented artifact path, along with a pass/fail verdict.
- [ ] A failing lint gate blocks merge of the pull request and surfaces the lint report as a required check; a passing lint gate publishes the report and allows downstream stages to consume its verdict.
- [ ] The lint gate's configuration (rules, severity thresholds, excluded paths) is stored as versioned source and changes to it require the same review path as any other source change.
