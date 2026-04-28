---
id: ST-013
title: Disable Incompatible Pattern and Finish Combinations with Tooltip
epic: EP-003
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want unsupported combinations of pattern and finish to be visually marked as unavailable with an explanation, so that I understand the configurator's boundaries instead of being left to guess.

## Acceptance Criteria

- [x] An unsupported pattern-and-finish combination renders the conflicting option in a disabled visual state.
- [x] Hovering or focusing a disabled option reveals a tooltip explaining why the combination is currently unavailable.
- [x] Clicking a disabled option produces no change to the preview and does not register as a selection.
- [x] When the user changes the other variable so the combination becomes supported, the previously disabled option returns to the enabled state.
