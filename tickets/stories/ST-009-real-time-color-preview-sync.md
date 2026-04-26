---
id: ST-009
title: Propagate Color Selections to Preview in Real Time
epic: EP-002
layer: frontend
points: 3
priority: high
---

## Narrative

As an end user, I want my color selections to appear on the ball immediately, so that I can iterate on my design without waiting for the preview to catch up.

## Acceptance Criteria

- [x] A primary-color selection is reflected on the preview within the documented latency budget on the reference hardware profile.
- [x] A secondary-color selection is reflected on the preview within the documented latency budget on the reference hardware profile.
- [x] An accent-color selection is reflected on the preview within the documented latency budget on the reference hardware profile.
- [x] Rapid successive color changes arrive on the preview in the order they were made, with no lost or reordered updates.
