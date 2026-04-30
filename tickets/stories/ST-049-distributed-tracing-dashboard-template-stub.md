---
id: ST-049
title: Propagate Distributed Traces and Publish Dashboard Template Stub
epic: EP-011
layer: observability
points: 8
priority: high
depends-on: [ST-047]
---

## Narrative

As a DevOps engineer, I want distributed traces whose spans propagate across service boundaries and a dashboard template that visualizes them alongside core service metrics, so that service-level behavior can be investigated and monitored from a single view.

## Acceptance Criteria

- [x] Every inbound request to any service opens a trace span with a parent-child relationship to any caller-provided span; when no caller-provided span is present the opened span is the topmost span in the trace, designated the root span, and every outbound call to a downstream service forwards the trace identifiers in a documented trace-context header so that the full request path is reconstructible as a single trace anchored at its root.
- [x] Trace records include at minimum the trace identifier, parent span identifier, span identifier, operation name, start and end timestamps, and the correlation identifier from the structured logging contract so traces and logs can be joined.
- [x] Trace span attributes and span events do not include passwords, bearer tokens, session identifiers, API keys, or personally identifiable information beyond the authenticated user identifier, mirroring the sensitive-data exclusion enforced by the structured logging contract in ST-047 so that traces and logs share the same redaction guarantee.
- [x] The tracing instrumentation applies a documented sampling policy: a baseline sampling rate is specified and configurable per environment, spans for requests that result in errors are always retained regardless of the baseline sampling decision, and the sampling configuration is surfaced so operators can distinguish a missing trace from a sampled-out trace.
- [x] A dashboard template stub is delivered as a versioned artifact that defines the expected panels (request rate, latency percentiles, error rate, trace throughput), the query descriptions for each panel in technology-neutral terms, and the alert thresholds recommended for each panel, published at the canonical path /docs/observability/dashboard-template.md (see [/docs/observability/dashboard-template.md](../../docs/observability/dashboard-template.md) for the canonical panel catalog).
- [x] The tracing instrumentation and the dashboard template stub can be exercised in the local development environment by following a documented sequence that produces a multi-service trace and renders it against the dashboard panels' query descriptions.
