---
id: ST-004
title: Apply Selected Material Swatch to Preview in Real Time
epic: EP-001
layer: frontend
points: 3
priority: high
---

## Narrative

As an end user, I want the ball preview to reflect the material swatch I pick, so that I can evaluate how each material looks on the finished product.

## Acceptance Criteria

- [x] Selecting a material swatch in the control sidebar updates the ball preview to display that material within the documented latency budget.
- [x] The previously applied material is replaced, so only the currently selected material is visible on the ball at any time.
- [x] The chosen swatch remains visually marked as active in the sidebar after selection.
- [x] Switching materials does not reset the current rotation or any unrelated selections (color, pattern, logo).
