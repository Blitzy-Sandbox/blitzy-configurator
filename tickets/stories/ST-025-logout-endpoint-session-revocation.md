---
id: ST-025
title: Revoke Active Session via Logout Endpoint
epic: EP-006
layer: backend
points: 2
priority: high
depends-on: [ST-024, ST-026]
---

## Narrative

As an authenticated user, I want to end my session on demand, so that I can sign out and prevent further use of the issued session token.

## Acceptance Criteria

- [ ] The logout endpoint accepts a valid session token and marks the associated session as revoked in the persistence layer.
- [ ] Any subsequent request authenticated with a revoked session token is rejected as if no session existed, with the status and body defined by the session validation contract.
- [ ] Logout is idempotent: submitting the same revoked token again returns a documented non-error response and does not alter state.
- [ ] Logout is rejected with a documented error when called without a valid, non-expired session token, and leaves no partial state behind.
