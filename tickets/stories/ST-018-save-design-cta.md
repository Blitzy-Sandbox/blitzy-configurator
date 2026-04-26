---
id: ST-018
title: Save Current Design via Save Design CTA
epic: EP-005
layer: frontend
points: 3
priority: high
depends-on: [ST-024, ST-027]
---

## Narrative

As an authenticated user, I want to save my current design with a single action, so that I can return to it later without reconfiguring from scratch.

## Acceptance Criteria

- [ ] A Save Design call-to-action is visible in the primary UI and is enabled whenever the current design has unsaved changes and the user is authenticated.
- [ ] Activating the Save Design CTA sends the current design selections to the persistence service and shows a success indicator once the save is confirmed.
- [ ] If persistence fails or the user is not authenticated, the user sees an actionable failure message that names the reason and the next step.
- [ ] Immediately after a successful save, the Save Design CTA reflects the saved state until the user makes another change.
