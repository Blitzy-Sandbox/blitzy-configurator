---
id: ST-020
title: Reset Configurator to Defaults via New Design Action
epic: EP-005
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want a New Design action that resets the configurator with a confirmation prompt, so that I can start over without accidentally losing unsaved work.

## Acceptance Criteria

- [ ] A New Design action is accessible from the top navigation area and is reachable by both pointer and keyboard.
- [ ] Activating New Design while the current design has unsaved changes shows a confirmation prompt naming what will be lost, and allows the user to cancel or proceed.
- [ ] Confirming the prompt resets every configurator surface — preview, color pickers, pattern selector, finish selector, logo controls, and summary sidebar — to the documented default values.
- [ ] Cancelling the prompt leaves every configurator surface unchanged and does not reset any selection.
