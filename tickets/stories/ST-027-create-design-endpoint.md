---
id: ST-027
title: Persist New Design Record via Create Design Endpoint
epic: EP-007
layer: backend
points: 5
priority: high
depends-on: [ST-024, ST-030]
---

## Narrative

As an authenticated user, I want to save the current configurator selections as a design I own, so that the design is retrievable later under my account.

## Acceptance Criteria

- [ ] The Create Design endpoint requires a valid session and persists a new design record with all configurator selections (colors, stitching pattern, material finish, logo reference and placement) owned by the authenticated user.
- [ ] A successful create returns the canonical persisted design, including a server-assigned identifier and timestamps, and does not mutate any other design owned by the user.
- [ ] Requests with invalid input (missing required selections, malformed logo reference) are rejected with a descriptive error and leave the persistence layer unchanged.
- [ ] Requests without a valid session are rejected by the session validation contract before reaching the persistence layer.
