---
id: ST-024
title: Issue Session Token on Successful Login
epic: EP-006
layer: backend
points: 3
priority: high
depends-on: [ST-031]
---

## Narrative

As an end user, I want to sign in and receive a session, so that subsequent actions in the configurator can be attributed to my account.

## Acceptance Criteria

- [ ] The login endpoint accepts valid credentials and returns an opaque session token with a documented lifetime and expiration timestamp.
- [ ] Invalid credentials return a generic failure response that does not disclose whether the user identifier exists, and the response carries no session token.
- [ ] Each successful login creates a new session record associated with the authenticated user, and repeated logins do not invalidate active sessions from other devices unless policy requires it.
- [ ] Login responses and the subsequent use of the returned token are exchanged only over a confidential transport and do not echo credential material in any form.
- [ ] Successful and failed login attempts emit a structured log record containing at minimum a correlation identifier, an event name that distinguishes success from failure, the outcome, and the authenticated user identifier when the attempt succeeded (never credential material), so that downstream observability tooling can trace the full session lifecycle.
