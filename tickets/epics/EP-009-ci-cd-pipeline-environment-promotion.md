---
id: EP-009
title: CI/CD Pipeline & Environment Promotion
layer: ci-cd
stories: [ST-036, ST-037, ST-038, ST-039, ST-040, ST-041, ST-042]
---

## Overview

This epic delivers the automated delivery pipeline that runs between a developer submitting a change and that change reaching production. The pipeline is composed of seven sequential gates and stages, each with a well-defined responsibility, inputs, and outputs: a lint gate, a type-check gate, a unit test gate, an integration test gate, a build stage, a deploy stage, and an environment promotion step. Earlier gates act as inexpensive filters that prevent obviously broken changes from consuming the time and resources of later stages. Later stages produce durable artifacts (container images, deployment identifiers) that subsequent stages consume to complete the delivery flow.

Each stage is authored as its own story so that its acceptance criteria — the environment variables it consumes, the artifacts it produces, and the conditions under which it passes or fails — can be verified in isolation and so that ownership and on-call responsibility can be assigned at stage granularity.

## Goals

- Enforce a static lint gate on every pull request that blocks merge on failure.
- Enforce a static type-check gate on every pull request that blocks merge on failure.
- Enforce a unit test gate on every pull request that blocks merge on coverage or test failure.
- Enforce an integration test gate on every pull request that blocks merge on failure.
- Produce a durable build artifact from a passing change with embedded traceability metadata.
- Deploy the build artifact to the development environment automatically once the pipeline passes.
- Promote a deployed artifact from development to staging and from staging to production under explicit human approval.

## Success Criteria

- A change cannot reach the default branch without passing every earlier gate.
- The build stage produces an artifact that is uniquely identifiable and traceable back to the originating commit.
- The deploy stage produces a deployment identifier and URL that downstream promotion stages consume.
- Promotion from one environment to the next requires a recorded human approval identifier.
- Every stage surfaces a pass/fail verdict and a human-readable report locatable from the pipeline run.

## Child Stories

- ST-036 — Lint gate on pull-request open emitting a pass/fail verdict and a lint report artifact.
- ST-037 — Type-check gate consuming the lint pass and emitting a type report artifact.
- ST-038 — Unit test gate consuming the type-check pass and emitting a coverage report artifact.
- ST-039 — Integration test gate consuming the unit test pass and emitting an integration report artifact.
- ST-040 — Build stage consuming the integration pass and emitting a container image digest and build metadata.
- ST-041 — Deploy stage consuming the build digest and emitting a deployment URL and deployment identifier.
- ST-042 — Environment promotion consuming a deployment identifier and approval, advancing the artifact through development, staging, and production.
