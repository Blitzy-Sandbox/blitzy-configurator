---
id: ST-023
title: Register a New User via Registration Endpoint
epic: EP-006
layer: backend
points: 3
priority: high
depends-on: [ST-031]
---

## Narrative

As an end user, I want to create a new account by submitting registration details, so that I can save designs under my own identity.

## Acceptance Criteria

- [ ] The registration endpoint accepts a request with the documented required fields and persists a canonical user record when the input is valid.
- [ ] A successful registration returns the canonical user record (without any credential material) and a success status, and does not issue a session token by itself.
- [ ] Registration attempts that fail validation (missing fields, malformed input, duplicate identifier) return a descriptive, non-leaking error response and do not create any partial record.
- [ ] Credential material submitted at registration is never stored in cleartext and is never returned in any response.
