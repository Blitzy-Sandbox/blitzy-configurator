# Observability Catalog — StrikeForge Configurator

This document is the operator-facing catalog of the observability capabilities that ship with the StrikeForge configurator. It is written for engineers, on-call responders, and reviewers who need to know what telemetry the system emits, what contracts that telemetry honors, and how each capability can be exercised on a developer workstation. The content is technology-neutral by design: no log aggregation platform, tracing backend, metrics collector, dashboarding tool, or error-tracking service is named here. Concrete tool selection belongs to the infrastructure track and is captured in the backlog, not in this catalog.

See [EP-011 Observability & Error Tracking](../../tickets/epics/EP-011-observability-error-tracking.md) for the authoritative backlog. The stories under EP-011 are the implementation contracts; this catalog is the human-readable narrative that explains those contracts to an operator and verifies that each contract can be exercised locally. Readers approaching this document in different roles will find the natural entry points in different sections: an on-call responder investigating a live incident will jump to **Local Verification** to confirm which pillar is suspect; a reviewer validating that an observability ticket has been honored will start at **What Was Added** and compare each Contract list against the linked story; and a maintainer preparing a schema or retention change will begin at **Document Maintenance** to understand the update discipline before touching any contract text.

## Scope & Intent

Observability ships with the initial implementation of the StrikeForge configurator — it is not deferred as a post-launch follow-up, it is not left to the first production incident to motivate, and it is not treated as an optional enhancement. The user rule governing this deliverable is categorical and is reproduced verbatim below as the mandate this catalog is written against.

The initial implementation MUST deliver the following five observability pillars:

1. Structured logging with correlation IDs.
2. Distributed tracing across service boundaries.
3. Metrics endpoint.
4. Health and readiness probes.
5. Dashboard template.

This catalog is the bridge between the EP-011 backlog tickets and the operator team who will run the system, translating each ticket's implementation contract into the observable behavior and the on-workstation verification steps that together define "delivered."

The specific pillar selection is not arbitrary. Structured logging answers the operator question *"what happened?"* in fine grain. Distributed tracing answers *"why did it happen in that order, and where was the time spent?"* across service boundaries. Metrics answer *"how often is this happening, and is the rate changing?"* in aggregate. Health and readiness probes answer *"should this instance be receiving traffic right now?"* at the routing layer. The dashboard template answers *"where do I look first?"* when an alert fires. Any one of these questions left unanswered leaves a predictable class of production incident that cannot be diagnosed without adding the missing pillar under duress; the five pillars are therefore the minimum set that makes incident response tractable, and they are cataloged together here so that none is silently dropped during implementation.

**MANDATE:** *A deliverable is not complete until it is observable.*

## What Was Reused from the Local Dev Environment

The repository is currently greenfield. Before the work cataloged in this document, it contained a single root README file and no prior observability posture — no existing log stream, no existing trace collector, no existing metrics endpoint, no existing probe surface, and no existing dashboard assets. Honest accounting therefore yields a single answer to the reuse question: none. Every capability cataloged below is net-new and is introduced specifically to satisfy the observability pillar contract for the StrikeForge configurator. Once the first local development environment is stood up by the infrastructure stories, any platform-level capabilities it exposes — for example, a built-in log stream at the runtime boundary, a built-in process-level health probe, or a built-in request-timing instrumentation — will be adopted preferentially so that the net-new surface cataloged here is only the portion that the platform does not already provide. Until that moment the honest answer remains "none" and this section deliberately does not enumerate reused capabilities that do not yet exist.

This section will be revised once the local development environment is materialized by the infrastructure stories.

## What Was Added

The following five capabilities are introduced from scratch and together satisfy the observability pillar contract.

The five capabilities are deliberately complementary rather than redundant. Structured logs narrate what happened event-by-event and carry the correlation identifier that threads a single user action across services. Distributed traces pick up that same correlation identifier and add a causal timing view of the same action, so an operator can pivot from a single log record into the full trace in which it was emitted. Metrics aggregate the same underlying activity into time-series counters, gauges, and histograms that power dashboards and service-level objective tracking without requiring a per-request drill-down. Health and readiness probes expose the instantaneous routing question — "should this instance receive traffic right now?" — that the aggregate metric view cannot answer cheaply. The dashboard template composes all four of the above into a single operator-facing surface with thresholds and alert policies that turn raw telemetry into actionable signal. Read together, the five pillars form a closed loop from event emission through aggregation and routing to operator visibility, and every pillar is verifiable locally.

A typical incident-response flow illustrates how the pillars compose. An alert on the dashboard surfaces a threshold breach on a metric family — for example, the error-rate counter for a specific route crossing the warning band. The operator opens the metric's drill-down to the list of correlation identifiers that emitted errors inside the breach window. Picking one correlation identifier, the operator pivots into the log stream and reads the narrative of what the request did and where it failed, then pivots into the trace for the same correlation identifier to see the timing and causal chain across service boundaries. If the investigation points to a specific instance, the readiness probe on that instance confirms whether it is currently serving traffic and which of its dependencies are reporting unhealthy. No additional tooling is required beyond the five pillars and the catalog entries that document them; the same flow works identically in the local development environment and in production.

### 1. Structured Logging with Correlation IDs

Every event of operational interest emits exactly one structured log record, and every such record carries a correlation identifier that ties it back to the originating request. The structured format is what makes the record machine-readable by any downstream aggregator; the correlation identifier is what makes the record stitchable across service boundaries into a single end-to-end narrative of a user action. Structured logging replaces free-form application log lines — which are cheap to write and expensive to consume — with a disciplined, schema-bearing record format that is cheap to write and cheap to consume at scale.

**Contract:**

- Every log record is a single structured object with the following enumerated fields: `timestamp` (ISO-8601, UTC, millisecond precision), `level`, `message`, `correlation_id`, `service`, `event`, and a free-form `context` map that carries event-specific key-value data.
- The `correlation_id` is generated or accepted at every inbound request boundary: a client-supplied correlation identifier on an incoming request is honored verbatim, and if none is supplied the boundary generates a fresh one. Every outbound call made while handling that request attaches the same correlation identifier on its outbound request boundary.
- Log levels follow a conventional ordering from most-verbose to least-verbose: `debug`, `info`, `warn`, `error`, `fatal`. The threshold at which records are emitted is environment-configurable.
- Records are emitted in a line-oriented format — one record per line — consumable by any downstream aggregator that reads line-delimited structured records.
- The record schema is stable and versioned; any breaking change to the set of required fields or their semantics requires a version-field bump so that downstream consumers can detect and adapt to the change.
- Personally identifiable information and secrets are never logged: high-risk fields are redacted at the emission boundary before a record enters the log stream, and the redaction policy is enumerated in the backlog so that reviewers can confirm it is applied uniformly.
- Retention defaults to seven days in non-production environments and thirty days in production; retention is overridable per environment by the infrastructure stories and is documented alongside the dashboard template.

**Backlog Reference:** Authored in [ST-047](../../tickets/stories/).

### 2. Distributed Tracing Across Service Boundaries

Every cross-service operation emits a trace span, and every span is linked to its parent by a propagated trace identifier. Tracing is what turns a distributed request into a visualizable causal chain rather than a disconnected set of per-service log fragments. The operator value of tracing is answering questions that logs alone cannot answer efficiently — *which downstream call took the longest*, *did that downstream call retry*, and *did two services call the same third service redundantly* — and doing so without requiring the operator to run correlation queries by hand across multiple log streams.

**Contract:**

- Each incoming request opens a root span at the entry boundary of the receiving service. Every downstream call made while handling that request opens a child span whose parent is either the root span or another child span in the same request's causal chain.
- Trace identifiers propagate via standard request headers on every boundary-crossing call, so that a downstream service can attribute the work it performs to the correct trace without any side-channel coordination.
- Span attributes include, at minimum: the operation name, the start and end timestamps, the status code, and a reference back to the owning `correlation_id`. This last field is what lets an operator pivot from a single log record into the full trace in which that log record was emitted.
- Sampling policy: all spans belonging to a trace that contains at least one error are retained in full, all spans belonging to a trace whose root-span duration exceeds the P95 latency threshold are retained in full, and the remaining traffic is sampled at a fixed rate that is documented per environment in the dashboard template.
- Trace retention defaults to seven days in non-production environments and thirty days in production. Retention settings are overridable per environment by the infrastructure stories.
- Span names follow a stable convention that pairs the operation with the layer it belongs to — for example, an entry-boundary span names the inbound route, a database span names the query shape, and a downstream-call span names the called service and operation — so that operators can compose trace searches without having to memorize per-service span vocabularies.
- Traces and logs are cross-linkable in both directions: every log record carries the correlation identifier that identifies its owning trace, and every span carries a back-reference to the correlation identifier that identifies its owning log narrative, so an operator can pivot from either pillar into the other without leaving the incident context.

**Backlog Reference:** Authored in [ST-049](../../tickets/stories/).

### 3. Metrics Endpoint

Each service exposes a dedicated scrape endpoint that serves counters, gauges, and histograms in a text-based interchange format. Metrics are the aggregate view of system behavior that powers dashboards, alerts, and service-level objective tracking. A metric answers "how often" and "how fast" across millions of requests in a single time-series point, which is the scale at which logs and traces become too expensive to consult directly — and which is exactly the scale at which an on-call engineer has to be able to answer "is the system healthy right now?" in a few seconds.

**Contract:**

- The endpoint path is a stable, well-known route on each service. The path is identical across services so that a single scrape configuration reaches every instance.
- The response is served over HTTP with a documented content type that advertises the text-based interchange format and its version.
- Exposed metrics include at minimum: request counters partitioned by route and status class, request latency histograms with buckets aligned to the service-level latency objectives, error counters partitioned by route and error class, and in-flight request gauges.
- Metric names follow a consistent `service.subsystem.metric` dot-separated convention — the equivalent underscore convention is also acceptable provided the choice is applied uniformly across every service so that cross-service queries do not require per-service name translation.
- Every metric carries three mandated labels: `service`, `environment`, and `version`. The `version` label is what enables a deployment-annotated view of metric behavior on every time-series panel of the operational dashboard.
- Service-level objective tie-ins: the error-rate and P95-latency metrics exposed here feed directly into the service-level objectives documented in the backlog and visualized on the operational dashboard.
- Cardinality is disciplined: per-user identifiers, per-session identifiers, free-form URL path segments, and any other unbounded label value are never emitted as metric labels, because unbounded cardinality is the most common cause of metrics-pipeline collapse. Unbounded attributes belong in logs or traces, not in metrics.
- Individual services may expose additional service-specific metrics beyond the mandated minimum, provided those metrics follow the same naming and label conventions and provided any new metric family that feeds a threshold or alert is documented in the dashboard template before it is consumed.

**Backlog Reference:** Authored in [ST-048](../../tickets/stories/).

### 4. Health and Readiness Probes

Two distinct endpoints report liveness and readiness semantics. The separation matters because the two questions they answer — "should this process be restarted?" and "should this instance receive traffic right now?" — have different answers during startup, shutdown, and dependency outages, and conflating them causes unnecessary restarts or traffic to instances that cannot serve it. The specific combination of a liveness probe that is slow to fail and a readiness probe that is quick to fail is what allows the traffic-routing layer to drain an unhealthy instance within seconds while giving a merely-slow instance enough time to recover before being killed.

**Contract:**

- The liveness probe returns success when the process is running and able to handle a request at all. It returns failure only when the process has entered an unrecoverable state and must be restarted. A dependency outage alone does not fail liveness, because restarting the process does not repair a downstream dependency.
- The readiness probe returns success when the service is fully initialized — dependencies are reachable, required caches are warmed, configuration has loaded — and false when the service is starting up, shutting down, or experiencing a dependency outage that makes it unable to serve traffic. Readiness is the signal that traffic routing consults.
- Both probes are HTTP endpoints on well-known paths. The paths are identical across services for the same reason the metrics path is identical: a single platform-level probe configuration reaches every instance.
- Probe responses include a compact JSON body enumerating each checked dependency and its current status. This body is what gives an operator the first diagnostic pivot — "which dependency is unhappy?" — without requiring any additional tooling.
- Probe endpoints are unauthenticated and safe to call with high frequency. They do not return sensitive information and they do not consume significant resources.
- Probe response time is budgeted: every probe returns its verdict within a small, documented latency ceiling so that the probe itself never becomes a reason a healthy instance is judged unhealthy by an over-eager external poller.
- On graceful shutdown, the readiness probe begins reporting not-ready a short, configurable grace period before the process actually exits. This ensures in-flight traffic is drained to other healthy instances before the shutting-down instance stops accepting new requests.

**Backlog Reference:** Authored in [ST-048](../../tickets/stories/).

### 5. Dashboard Template

A template specifies the canonical operational dashboard layout, panels, queries, thresholds, and alert policies for the StrikeForge configurator. The template is the deliverable that closes the loop from "telemetry exists" to "telemetry is visible and actionable at a glance." Without the template, each team member would build a personal dashboard with idiosyncratic panel placements and inconsistent thresholds, and the on-call rotation would spend its first minutes of every incident hunting for the right view rather than diagnosing the problem.

**Contract:**

- The template is tool-agnostic: it describes panels and queries in plain English, naming the metric or log or trace source each panel consumes, the threshold values that separate healthy from degraded from failing, and the alert policy that converts threshold breaches into tickets and pages.
- It is intended to be rehydrated into the team's dashboard tool of choice once that tool is selected by the infrastructure stories. The rehydration step is a mechanical one-to-one translation from the panel specification into the chosen tool's query language.
- It covers all five observability pillars documented above, surfaces the key performance indicators that feed the service-level objectives, and overlays deployment annotations on every time-series panel so that any visible behavior change can be correlated with a deployment event.
- Changes to the template precede tooling changes: whenever a new metric, log field, trace attribute, or probe signal begins feeding an operator-visible threshold or alert, the template is updated first, and only after that update is the rehydrated dashboard in the chosen tool modified to match. This discipline keeps the template as the single source of truth for dashboard intent and prevents the rehydrated dashboard from quietly drifting away from the backlog contract.

See [dashboard-template.md](./dashboard-template.md) for the panel, query, threshold, and alert-policy specification.

**Backlog Reference:** Authored in [ST-049](../../tickets/stories/).

## Local Verification

The user rule governing observability is absolute: *If it cannot be exercised locally, it is not delivered.* The steps below describe how each of the five capabilities catalogued above is exercised on a developer workstation, expressed in plain English so that the verification remains valid regardless of the concrete tooling the infrastructure stories eventually select. Each verification is a short, sequential procedure that an engineer can work through end-to-end without consulting external documentation.

Verification "success" in this catalog means two things simultaneously: that the capability is observable locally using nothing but the local development environment and a standard HTTP client, and that the observable behavior matches the contract documented in the corresponding subsection of **What Was Added**. If either condition fails — the capability cannot be exercised at all, or it can be exercised but its behavior deviates from the contract — the pillar is treated as undelivered and the corresponding backlog ticket is re-opened with a failing acceptance criterion. This catalog is therefore both a reference for operators and a gating document for reviewers.

The verification flows are deliberately scoped to a single developer workstation. No shared staging environment, no production credentials, and no external service accounts are required. That scoping is the test that every pillar is truly first-class rather than being entangled with an inaccessible external service: if a reviewer cannot reproduce the expected behavior on a clean workstation using only the local development environment, the pillar has not been delivered. New team members onboarding to the configurator can work through these five procedures in order and emerge with a working mental model of the system's observability posture in under an hour.

### Verify Structured Logging

1. Start the local development environment.
2. Trigger a representative user action — for example, submit a request to any application entry point and let the service perform its normal downstream work.
3. Observe the local log stream for the services involved in handling that action.
4. Confirm that each emitted record is a single structured object with every mandated field present: `timestamp`, `level`, `message`, `correlation_id`, `service`, `event`, and `context`.
5. Confirm that the `correlation_id` field is populated on every record and that the same value appears on every record generated by the single triggering action across every service involved.
6. Confirm that the record schema version advertised by the records matches the version documented in the backlog and that the record stream is line-oriented — one record per line — with no truncation or interleaving.

### Verify Distributed Tracing

1. Start the local development environment with tracing enabled.
2. Trigger a representative cross-service request that exercises at least one downstream call from the entry boundary.
3. Open the local trace viewer that the development environment exposes.
4. Confirm that a root span appears for the entry boundary of the originating service and that a child span appears for each downstream call made while handling that request.
5. Confirm that every span in the request shares the same trace identifier and that every span carries a reference back to the owning `correlation_id`.
6. Confirm that the sampling policy behaves as documented by triggering an error-bearing request and observing that its full trace is retained, then triggering a normal request and observing that retention follows the documented sample rate.

### Verify Metrics Endpoint

1. Start the local development environment.
2. Issue an HTTP request against the metrics scrape endpoint for any service in the environment.
3. Confirm that the response is served with the documented content type that advertises the text-based interchange format and its version.
4. Confirm that the response includes at minimum the required metric families: request counters partitioned by route and status class, request latency histograms, error counters partitioned by route and error class, and in-flight request gauges.
5. Confirm that every metric in the response carries the three mandated labels: `service`, `environment`, and `version`.
6. Confirm that metric names use a consistent separator convention across the response and that the service-level-objective-feeding metrics — error rate and P95 latency — are present and non-empty after a handful of triggering requests.

### Verify Health and Readiness Probes

1. Start the local development environment.
2. While the service is still initializing, issue a request to the readiness probe and confirm that it reports a not-ready state along with a body listing each dependency and its current status.
3. Once the service has fully started, issue a second request to the readiness probe and confirm that it reports ready and that the dependency list shows every dependency healthy.
4. Issue a request to the liveness probe at any time after startup and confirm that it reports alive.
5. Simulate the loss of a declared dependency — for example, stop the local instance of a required downstream service — and confirm that the readiness probe transitions to not-ready while the liveness probe continues to report alive, because the process itself is still healthy.
6. Restore the dependency and confirm that the readiness probe returns to ready without the owning process being restarted.

### Verify Dashboard Template

1. Open [dashboard-template.md](./dashboard-template.md) and walk the panel catalog top-to-bottom.
2. For each panel specified, identify the corresponding metric, log, or trace source in the local development environment using the verification steps above.
3. Confirm that the data the template describes for each panel is observable using the sources that the structured logging, distributed tracing, and metrics verifications surfaced.
4. Confirm that the threshold values named for each panel are consistent with what the local environment reports under normal load and that the alert-policy description is consistent with the observability posture.
5. Record any panel that cannot be populated from local data as a gap in the decision log at [../decisions/README.md](../decisions/README.md) so that the gap is tracked rather than silently accepted.

## Cross-References

The following links point to every artifact materially connected to this catalog. The epic and story links are the authoritative implementation contracts; the template link is the operational companion document that this catalog summarizes; the decision-log and executive-summary links are the surrounding context that explains the choices behind the observability posture and communicates them to non-technical leadership.

- Epic: [EP-011 Observability & Error Tracking](../../tickets/epics/EP-011-observability-error-tracking.md) — the authoritative backlog record of the observability work, enumerating every child story and the acceptance criteria that gate them.
- Story — Structured Logging: [ST-047](../../tickets/stories/) — the story implementing the structured-logging-with-correlation-IDs contract cataloged in pillar 1 above. The link points to the stories directory; the exact slug is finalized by the stories author.
- Story — Metrics & Health/Readiness: [ST-048](../../tickets/stories/) — the story implementing the metrics-endpoint contract in pillar 3 and the health-and-readiness-probes contract in pillar 4.
- Story — Distributed Tracing & Dashboard: [ST-049](../../tickets/stories/) — the story implementing the distributed-tracing contract in pillar 2 and the dashboard-template contract in pillar 5.
- Dashboard Template: [dashboard-template.md](./dashboard-template.md) — the sibling operational-dashboard specification covering panel layout, queries, thresholds, and alert policies.
- Executive Summary (Slide 12 depicts the observability posture): [../executive-summary.html](../executive-summary.html) — the non-technical leadership presentation; the observability-posture slide visualizes how the five pillars compose into a single telemetry pipeline.

## Document Maintenance

This document is updated alongside any change to the EP-011 backlog tickets or to the local development environment's observability posture. The maintenance triggers are explicit: a new pillar being added, an existing pillar's contract being revised, a field or label being added to or removed from the structured record or metric schema, a change in how a capability is exercised locally, or the first time a platform-level reuse source is adopted preferentially by the **What Was Reused** section. Each such change is reflected here in the same change-set that modifies the backlog, and reviewers confirm catalog updates as part of the acceptance check on the corresponding ticket. Rationale for every non-trivial change is recorded in the decision log at [../decisions/README.md](../decisions/README.md); this catalog carries the "what" and the "how to verify," while the decision log carries the "why."
