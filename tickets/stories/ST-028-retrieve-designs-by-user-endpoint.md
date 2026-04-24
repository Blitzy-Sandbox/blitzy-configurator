---
id: ST-028
title: Retrieve Designs Owned by Authenticated User
epic: EP-007
layer: backend
points: 3
priority: high
depends-on: [ST-024, ST-030]
---

## Narrative

As an authenticated user, I want to fetch the list of my saved designs from the server, so that my client can present them for browsing and loading.

## Acceptance Criteria

- [ ] The retrieval endpoint requires a valid session and returns only designs owned by the authenticated user, never designs owned by other users.
- [ ] The response includes, per design, the server-assigned identifier, title, last-modified timestamp, and enough metadata for a client to render a list without loading the full design payload.
- [ ] When the authenticated user has no designs, the endpoint returns an empty collection with a success status (not an error).
- [ ] The endpoint supports deterministic ordering (for example, most-recently-modified first) so repeated calls with unchanged state produce the same order.
