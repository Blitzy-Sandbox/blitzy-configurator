---
id: ST-022
title: Display Current Design Selections in Live Summary Sidebar
epic: EP-005
layer: frontend
points: 3
priority: medium
---

## Narrative

As an end user, I want a live summary of my current design on the right side of the configurator, so that I can see every selection at a glance without hunting through controls.

## Acceptance Criteria

- [x] The design summary panel displays the current primary color, secondary color, accent color, stitching pattern, material finish, and logo state in human-readable form.
- [x] Every change made in the control sidebar updates the design summary within the documented latency budget without requiring a manual refresh.
- [x] Each summary field is labeled clearly and, when applicable, previews the value visually (for example a color swatch next to a color label).
- [x] The summary panel is reachable and readable by assistive technology and remains visible alongside the preview at the required minimum viewport width.
- [x] The summary panel hosts the Save Design and Add to Cart call-to-action anchors alongside the configuration readout, preserving single-viewport access to the design summary and its primary actions.
