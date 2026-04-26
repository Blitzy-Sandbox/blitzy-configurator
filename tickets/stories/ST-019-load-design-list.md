---
id: ST-019
title: View and Load a Previously Saved Design
epic: EP-005
layer: frontend
points: 3
priority: high
depends-on: [ST-024, ST-028]
---

## Narrative

As an authenticated user, I want to browse my previously saved designs and open one, so that I can continue from where I left off.

## Acceptance Criteria

- [ ] The UI surfaces a list of designs owned by the current authenticated user, each item showing enough metadata (such as title and last-modified time) to identify it.
- [ ] Selecting a design from the list loads it into the configurator, replacing the current selections with the saved selections on the preview and in the sidebar.
- [ ] If the design list cannot be retrieved, the user sees an actionable failure message and the previous UI state is left intact.
- [ ] Loading a design from the list does not trigger an implicit save, and the Save Design CTA returns to the saved state until the user makes a change.
