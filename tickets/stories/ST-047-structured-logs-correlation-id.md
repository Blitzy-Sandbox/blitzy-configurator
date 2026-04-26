---
id: ST-047
title: Emit Structured Logs with Correlation ID Across Service Boundaries
epic: EP-011
layer: observability
points: 5
priority: high
depends-on: [ST-023, ST-024, ST-026]
---

## Narrative

As a DevOps engineer, I want every service to emit structured log records carrying a correlation identifier that propagates across service boundaries, so that I can follow a single user action through every component that served it.

## Acceptance Criteria

- [ ] Every emitted log record is a structured record containing at least a timestamp, a severity whose value is one of the enumerated tokens debug, info, warn, error, or fatal, an event name, a service identifier, and a correlation identifier, rendered in a machine-parseable format.
- [ ] A correlation identifier is generated at the request boundary when absent, is preserved when present, and is forwarded to every downstream service call so that all log records produced in response to a single inbound request share the same identifier.
- [ ] Authenticated request flows (registration, login, session validation) emit log records that carry both the correlation identifier and the authenticated user identifier (never credential material) so that the full lifecycle of a session is traceable.
- [ ] No emitted log record, whether produced by an authenticated or an unauthenticated request flow, contains passwords, bearer tokens, session identifiers, API keys, or personally identifiable information beyond the authenticated user identifier; this exclusion is enforced by a documented serializer or allow-list mechanism so that sensitive-data redaction is a verifiable property of the logging contract rather than an ad-hoc per-call discipline.
- [ ] The structured logging behavior can be exercised end-to-end in the local development environment by following a documented sequence that produces and surfaces correlated log records for a sample request.
