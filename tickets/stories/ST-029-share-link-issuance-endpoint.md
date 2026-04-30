---
id: ST-029
title: Issue Time-Limited Share Link for a Saved Design
epic: EP-007
layer: backend
points: 3
priority: medium
depends-on: [ST-024, ST-030]
---

## Narrative

As an authenticated user, I want to issue a shareable link for one of my saved designs, so that I can let teammates view the design in the configurator without granting them account access.

## Acceptance Criteria

- [x] The share-link endpoint requires a valid session and issues a share link only for a design owned by the authenticated user.
- [x] Each issued share link carries a documented expiration and points to exactly one design; expired links are rejected by the read side with a documented error.
- [x] Visiting a valid, unexpired share link returns enough information for the configurator to render the target design read-only without requiring the visitor to sign in.
- [x] Revoking a share link (by the owner or by expiration) renders the link inoperable on subsequent requests and does not affect the underlying design record.
