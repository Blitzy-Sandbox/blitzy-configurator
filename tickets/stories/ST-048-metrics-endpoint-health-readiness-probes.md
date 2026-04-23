---
id: ST-048
title: Expose Metrics Endpoint and Distinct Health and Readiness Probes
epic: EP-011
layer: observability
points: 5
priority: high
---

## Narrative

As a DevOps engineer, I want every service to expose a metrics endpoint and distinct health and readiness probes, so that scrape-based monitoring and orchestrator lifecycle decisions have the signals they need.

## Acceptance Criteria

- [ ] Each service exposes a metrics endpoint at a documented path that serves service-level metrics (at minimum request rate, request latency distribution, error rate, and a process-up gauge) in a technology-neutral text format suitable for scraping.
- [ ] Each service exposes a liveness probe endpoint that returns a documented success status when the process is running and a documented failure status when the process has entered a non-recoverable state.
- [ ] Each service exposes a readiness probe endpoint, distinct from the liveness probe, that returns a documented success status only when the service is prepared to accept traffic (dependencies reachable, warm-up complete) and a documented failure status otherwise.
- [ ] The metrics endpoint and both probe endpoints can be reached and interpreted in the local development environment without any cloud access, and the expected responses are documented alongside the endpoints.
