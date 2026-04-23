---
id: EP-011
title: Observability & Error Tracking
layer: observability
stories: [ST-047, ST-048, ST-049]
---

## Overview

This epic delivers the observability baseline that makes the configurator operable in production. Three complementary capabilities are authored together: structured logs that carry correlation identifiers across every service boundary so a single user action can be followed end-to-end; a metrics endpoint alongside health and readiness probes so automated orchestration and human operators can tell the service apart from a failing one; and distributed tracing with span propagation so the latency of a request can be attributed to the specific step that consumed it, accompanied by a dashboard template stub that enumerates the panels, queries, thresholds, and alert policies operators will use to watch the system.

The goal is that when something goes wrong, the person on call has exactly enough information to find, diagnose, and fix the problem without needing to reproduce it locally first. Observability is treated as part of the initial delivery, not as a follow-up — the dashboard template ships alongside the emitters that feed it.

## Goals

- Emit structured logs in a consistent schema and propagate a correlation identifier across every service boundary so a single request can be traced end-to-end.
- Expose a metrics endpoint in an agreed-upon, technology-neutral exposition format, with health and readiness probes that report liveness and ready-to-serve separately.
- Emit distributed traces whose spans propagate across service boundaries, and deliver a dashboard template stub enumerating the panels, queries, thresholds, and alert policies operators will use.
- Ensure every observability signal can be exercised in the local development environment so a developer can verify their changes without accessing a shared environment.
- Document what observability capabilities were reused from the existing development environment and what was newly added as part of this epic.

## Success Criteria

- A single user request can be followed through every participating service using only its correlation identifier.
- The metrics endpoint is reachable and returns the agreed-upon signals; the health and readiness probes return distinct, documented responses for their respective liveness and ready-to-serve questions.
- Distributed traces link cleanly across service boundaries, attributing latency to each span.
- The dashboard template lists every panel an operator needs at a glance, along with its query, its threshold, and its alert policy.
- Every observability capability can be exercised in the local development environment with a documented invocation sequence.

## Child Stories

- ST-047 — Structured logging with correlation identifier propagation across service boundaries.
- ST-048 — Metrics endpoint contract alongside health and readiness probe contracts.
- ST-049 — Distributed tracing with span propagation and the dashboard template stub.
