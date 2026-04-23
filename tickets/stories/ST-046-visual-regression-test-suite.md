---
id: ST-046
title: Define and Maintain Visual Regression Test Suite with Baselines
epic: EP-010
layer: testing
points: 5
priority: medium
test-type: visual-regression
depends-on: [ST-039]
---

## Narrative

As a QA engineer, I want a visual regression test suite that compares rendered screenshots of key UI surfaces against baseline snapshots on every pull request, so that unintended visual changes are surfaced alongside code review.

## Acceptance Criteria

- [ ] The visual regression suite is triggered on every pull request open and on every subsequent push to an open pull request against the default branch, and captures screenshots of at least the configurator, design list, cart, and order confirmation surfaces.
- [ ] Each captured screenshot is compared against a versioned baseline at a fixed viewport size, and any delta exceeding the documented pixel-difference threshold produces a failed verdict.
- [ ] A failed verdict surfaces side-by-side baseline and current screenshots in the report and blocks merge until the difference is acknowledged.
- [ ] Baseline updates require an explicit commit to the versioned baseline artifacts so no run can silently overwrite the baseline with a new capture.
