---
id: EP-006
title: User Authentication & Sessions
layer: backend
stories: [ST-023, ST-024, ST-025, ST-026]
---

## Overview

This epic delivers the authentication surface of the configurator: an account creation path, a sign-in path that establishes a session, an explicit sign-out path that ends it, and the shared contract that protected operations use to verify that an incoming request is carrying a valid session.

The surface is intentionally minimal for the first release: it is built to support the authenticated actions that other epics depend on (saving designs, loading a personal design list, issuing share links, placing orders) and nothing more. Account recovery, social sign-in, multi-factor authentication, and administrative user management are explicitly out of scope.

## Goals

- Provide a registration endpoint that accepts new user credentials and creates an account.
- Provide a login endpoint that validates credentials and issues a session identifier.
- Provide a logout endpoint that revokes the active session.
- Publish a session validation contract used by every protected endpoint to gate access.
- Emit structured, correlation-tagged logs for every authentication event so the observability pipeline can ingest them.

## Success Criteria

- A new user can register and immediately sign in without intermediate manual steps.
- A signed-in user can invoke protected endpoints for the lifetime of the session and is rejected after logout.
- Logging out revokes the current session identifier so its further use returns an unauthenticated response.
- Every protected endpoint refuses requests that carry no session identifier or an invalid one.
- Authentication events appear in the log stream with correlation identifiers that tie them to the originating request.

## Child Stories

- ST-023 — User registration endpoint creating a new account from submitted credentials.
- ST-024 — Login endpoint validating credentials and issuing a session identifier.
- ST-025 — Logout endpoint revoking the active session.
- ST-026 — Session validation middleware contract gating every protected endpoint.
