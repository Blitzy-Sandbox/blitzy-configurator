---
id: ST-026
title: Enforce Session Validation Contract on Protected Endpoints
epic: EP-006
layer: backend
points: 3
priority: high
depends-on: [ST-024]
---

## Narrative

As a developer, I want a single session validation contract applied uniformly to protected endpoints, so that authentication behavior is consistent and testable across the service.

## Acceptance Criteria

- [ ] Requests to any protected endpoint without a session token are rejected with the documented unauthenticated status and response body, and never reach the protected handler.
- [ ] Requests carrying an expired, malformed, or revoked session token are rejected with the documented invalid-session status and response body, distinct from the no-token response.
- [ ] Requests carrying a valid, unexpired session token are forwarded to the protected handler with the authenticated user identity attached to the request context.
- [ ] The session validation contract is documented in a single source (request shape, accepted tokens, rejection statuses, rejection bodies) and the documentation is updated whenever the contract changes.
