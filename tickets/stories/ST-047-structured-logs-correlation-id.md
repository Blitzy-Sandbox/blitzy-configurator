---
id: ST-047
title: Emit Structured Logs with Correlation ID Across Service Boundaries
epic: EP-011
layer: observability
points: 5
priority: high
depends-on: [ST-024]
---

## Narrative

As a DevOps engineer, I want every service to emit structured log records carrying a correlation identifier that propagates across service boundaries, so that I can follow a single user action through every component that served it.

## Acceptance Criteria

- [ ] Every emitted log record is a structured record containing at least a timestamp, severity, event name, service identifier, and correlation identifier, rendered in a machine-parseable format.
- [ ] A correlation identifier is generated at the request boundary when absent, is preserved when present, and is forwarded to every downstream service call so that all log records produced in response to a single inbound request share the same identifier.
- [ ] Authenticated request flows (registration, login, session validation) emit log records that carry both the correlation identifier and the authenticated user identifier (never credential material) so that the full lifecycle of a session is traceable.
- [ ] The structured logging behavior can be exercised end-to-end in the local development environment by following a documented sequence that produces and surfaces correlated log records for a sample request.
