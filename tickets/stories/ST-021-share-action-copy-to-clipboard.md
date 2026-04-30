---
id: ST-021
title: Share Current Design via Copy-to-Clipboard Link
epic: EP-005
layer: frontend
points: 3
priority: medium
depends-on: [ST-024, ST-029]
---

## Narrative

As an authenticated user, I want a Share action that gives me a link I can paste elsewhere, so that I can show my design to teammates without sending screenshots.

## Acceptance Criteria

- [x] A Share action in the top navigation requests a shareable link for the current saved design and writes the returned link to the system clipboard on success.
- [x] After a successful copy, the UI confirms "link copied" in a user-visible, dismissible indicator.
- [x] If the share-link request fails, the clipboard is not modified and the user sees an actionable failure message naming the reason.
- [x] Share is disabled until the current design has been saved at least once, and the disabled state explains this precondition via tooltip or inline text.
