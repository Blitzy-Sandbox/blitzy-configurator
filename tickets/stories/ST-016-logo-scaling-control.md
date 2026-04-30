---
id: ST-016
title: Scale Uploaded Logo Within Enforced Minimum and Maximum Bounds
epic: EP-004
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want to resize my logo within a safe range, so that my branding reads clearly without becoming unreadable or dominating the ball.

## Acceptance Criteria

- [x] A scaling control in the sidebar adjusts the logo's displayed size on the preview in real time.
- [x] The scaling control clamps input to a documented minimum and maximum size, and rejects values outside the range.
- [x] The current scale value is shown as a human-readable percentage or numeric label next to the control.
- [x] Resetting the configurator to defaults restores the logo scale to the documented default value.
