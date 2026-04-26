# Operational Dashboard Template — StrikeForge Configurator

This document is the **tool-agnostic blueprint** for the canonical operational dashboard that supports the StrikeForge configurator in every environment. It enumerates the panels that must be present, the queries those panels answer in plain English, the numeric thresholds that separate healthy from degraded from failing, and the alert policies that convert threshold breaches into tickets and pages. The specification is deliberately vendor-neutral: it names no dashboarding tool, no log aggregator, no tracing backend, and no metrics platform. Once the infrastructure team selects concrete tooling via the EP-009 pipeline and EP-011 telemetry stories, this blueprint is rehydrated into the chosen tool by the teams that own those stories.

Until that rehydration occurs, this document is the single source of truth for panel structure, query semantics, thresholds, and alert policies. It is a sibling of the observability catalog at [./README.md](./README.md) and is referenced by the dashboard template story inside [EP-011](../../tickets/epics/EP-011-observability-error-tracking.md). Any change to the shape of the five observability pillars — structured logging, distributed tracing, metrics, health and readiness checks, and error tracking — MUST be reflected here before the corresponding tooling change is merged.

## Layout Hints

The dashboard is organized into four horizontal rows, each tuned to a specific operator question. **Row 1 — the Overview Row** answers "how busy?" / "how healthy?" / "how fast?" at a glance by placing the Request Rate, Error Rate, and P95 Latency panels left-to-right. These three panels are the first surfaces an on-call engineer consults when paged, and the left-to-right reading order mirrors the diagnostic sequence: confirm traffic is flowing, then confirm it is not failing, then confirm it is not slow. **Row 2 — the Error Drill-Down Row** supports the incident-response pivot from aggregate error behavior to individual requests. It pairs the Error Rate breakout by service and route with the Correlation ID Throughput panel; the breakout narrows the failing surface, and correlation-ID throughput confirms whether the telemetry pipeline itself is healthy enough to trust the numbers above.

**Row 3 — the User & Business Activity Row** contextualizes technical health against the product reality. Active Sessions quantifies how many authenticated users are currently in-flight, and Order Creation Rate quantifies how frequently those sessions are converting to orders. Together these two panels distinguish "we have a platform problem" from "we have a product problem" in situations where technical signals alone are ambiguous. **Row 4 — Deployment Annotations** overlays deploy markers on every time-series panel as vertical annotation lines and also renders them as a discrete event list at the bottom of the dashboard. This allows any visible behavior change in any upper-row panel to be instantly correlated with a deployment event.

Color conventions adopt the Blitzy brand accent palette once rehydrated into the chosen dashboard tool, with warning thresholds shaded in the primary-light band and critical thresholds shaded in the deep-primary band. The default time range is the last 24 hours; typical zoom shortcuts are 1 hour, 6 hours, 24 hours, and 7 days. Every panel supports drill-down from any selected time window to the list of individual correlation identifiers observed inside that window, enabling an operator to pivot from a spike on any chart directly into the structured log stream for the offending requests.

Each panel below carries an explicit alert policy describing how a threshold breach escalates from a ticket to a page.

The global cadence rules in `## Cadence, De-duplication, and Escalation Conventions` apply to every alert policy uniformly so that no panel can quietly invent its own escalation contract.

Where a panel inherits its alert policy from another panel — for example, the Error Rate breakout inherits the top-line Error Rate panel's alert policy — that inheritance is named explicitly in the inheriting panel's alert policy entry rather than left implicit.

This naming convention ensures an operator never has to guess which alert policy is in force when responding to a paged incident.

## Panel Catalog

The following panels are the canonical set. Each panel is specified by name, query description, thresholds, and alert policy. Panels are cataloged linearly below in row-then-position order.

### Request Rate

- **Query:** Count of inbound HTTP requests across all services, grouped in 1-minute buckets, visualized as a stacked area chart by service. The data source is the metrics stream emitted by each service's request instrumentation.
- **Thresholds:** Warning at sustained rate ≥ 2× the 7-day rolling median for 5 minutes — indicates abnormal load that may precede saturation of a downstream service-level objective. Critical at sustained rate ≥ 4× the 7-day rolling median for 5 minutes — indicates near-certain saturation and imminent breach of the availability SLO if uncontained.
- **Alert Policy:** Warning creates a ticket for the platform team within 15 minutes. Critical pages the primary on-call immediately. De-duplicate by the 5-minute sustained window so that a single load event generates at most one page.
- **Layout Position:** Row 1, left.

### Error Rate

- **Query:** Ratio of HTTP responses with status 5xx to total HTTP responses across all services, grouped in 1-minute buckets, visualized as a line chart. The data source is the metrics stream emitted by each service's response instrumentation.
- **Thresholds:** Warning at sustained error rate ≥ 1% for 5 minutes — indicates a user-visible regression worth investigation. Critical at sustained error rate ≥ 5% for 5 minutes or any single minute ≥ 10% — indicates active degradation requiring immediate attention to preserve the availability SLO.
- **Alert Policy:** Warning creates a ticket for the owning service team within 15 minutes. Critical pages the primary on-call immediately. De-duplicate by the 5-minute sustained window.
- **Layout Position:** Row 1, center.

### P95 Latency

- **Query:** 95th percentile of request duration across all services, grouped in 1-minute buckets, visualized as a line chart with a separate line per service. The data source is the metrics stream emitted by each service's duration instrumentation.
- **Thresholds:** Warning at sustained P95 ≥ 500ms for 10 minutes — the latency SLO target is 500ms, so sustained breach indicates SLO burn is active. Critical at sustained P95 ≥ 1000ms for 10 minutes — user experience is materially degraded and SLO burn rate is more than double the allowed monthly budget.
- **Alert Policy:** Warning creates a ticket for the owning service team within 30 minutes. Critical pages the primary on-call immediately. De-duplicate by the 10-minute sustained window.
- **Layout Position:** Row 1, right.

### Error Rate — Breakout by Service and Route

- **Query:** Error rate identical to the top-line Error Rate panel but broken out by `service` and `route` labels, visualized as a table sorted descending by error count over the selected time window. The data source is the same metrics stream as the top-line Error Rate panel, with label-level grouping enabled.
- **Thresholds:** Inherited from the top-line Error Rate panel; row highlighting triggered at the same 1% warning and 5% critical thresholds to visually surface the highest-error routes during triage.
- **Alert Policy:** This panel is diagnostic only; it inherits alerts from the top-line Error Rate panel and does not fire its own. Its role is to accelerate root-cause localization once the top-line panel has fired.
- **Layout Position:** Row 2, left.

### Correlation ID Throughput

- **Query:** Count of distinct correlation identifiers observed in the structured log stream, grouped in 1-minute buckets, visualized as a bar chart. The data source is the structured log stream itself; a healthy pipeline produces one correlation identifier per inbound request and propagates it across all downstream service boundaries.
- **Thresholds:** Warning at drop ≥ 50% compared to the 1-hour rolling median for 5 minutes — a drop implies the logging or correlation-propagation pipeline has stalled and upstream dashboards may be reporting stale or incomplete data. Critical at drop ≥ 90% for 5 minutes — effective telemetry outage; the observability posture is compromised even if service health appears nominal.
- **Alert Policy:** Warning creates a ticket for the platform team within 15 minutes. Critical pages the primary on-call immediately — treat as a telemetry outage on equal footing with a service outage, because operators cannot see service behavior while this panel is red.
- **Layout Position:** Row 2, right.

### Active Sessions

- **Query:** Count of valid, non-expired session tokens issued by the authentication service, sampled every minute and visualized as a line chart. The data source is the metrics stream emitted by the session-issuance service; the sample is a gauge of currently-valid sessions at read time.
- **Thresholds:** Warning at drop ≥ 50% compared to the 7-day rolling median at the same time-of-day for 15 minutes — indicates a likely authentication regression or a product-surface outage preventing users from reaching the configurator. Critical at drop ≥ 90% for 15 minutes — indicates near-total authentication failure.
- **Alert Policy:** Warning creates a ticket for the product team within one hour. Critical pages the primary on-call immediately — treat as a user-impacting incident because session collapse blocks the entire authenticated feature surface.
- **Layout Position:** Row 3, left.

### Order Creation Rate

- **Query:** Count of successful order-creation events in the structured log stream, grouped in 5-minute buckets, visualized as a bar chart. The data source is the structured log stream filtered on the order-creation event category emitted by the order service.
- **Thresholds:** Warning at drop ≥ 50% compared to the 7-day rolling median at the same time-of-day for 30 minutes — indicates an order-flow regression that is not yet a full outage but is actively eroding revenue. Critical at drop ≥ 90% for 30 minutes — indicates near-total order-flow failure.
- **Alert Policy:** Warning creates a ticket for the product team within two hours. Critical pages the primary on-call immediately — treat as a revenue-impacting incident because order collapse is the highest-cost failure mode the configurator can experience.
- **Layout Position:** Row 3, right.

### Deploy Markers

- **Query:** Event stream of deployment completion events emitted by the CI/CD pipeline build stage, rendered as vertical annotation lines on every time-series panel AND as a tabular event list at the bottom of the dashboard. Each event carries the target environment, the commit short SHA, and the deployment identifier so that any behavior change in any upper-row panel can be immediately correlated with the deployment that preceded it.
- **Thresholds:** Not applicable — this is an event annotation panel, not a metric. It carries no thresholds by design, because deployments are expected events and alerting on them would produce continuous noise.
- **Alert Policy:** Not applicable. Deploy markers are passive annotations that aid incident triage by correlating behavior shifts with deployments. Active alerting on deploy events is explicitly excluded.
- **Layout Position:** Row 4 (overlay on all time-series panels plus event list at the bottom), spans the full width of the dashboard.

## Alert Policy Summary

The following table consolidates the per-panel alert policies into a single reference. All cadences assume the threshold condition has been sustained for the window defined in the panel's threshold description above.

| Panel | Warning Cadence | Critical Cadence | Notified Role |
|---|---|---|---|
| Request Rate | Ticket within 15 min | Page immediately | Platform team / primary on-call |
| Error Rate | Ticket within 15 min | Page immediately | Owning service team / primary on-call |
| P95 Latency | Ticket within 30 min | Page immediately | Owning service team / primary on-call |
| Error Rate — Breakout | Inherited | Inherited | Inherited |
| Correlation ID Throughput | Ticket within 15 min | Page immediately | Platform team / primary on-call |
| Active Sessions | Ticket within 1 hour | Page immediately | Product team / primary on-call |
| Order Creation Rate | Ticket within 2 hours | Page immediately | Product team / primary on-call |
| Deploy Markers | N/A | N/A | N/A |

## Cadence, De-duplication, and Escalation Conventions

Alerts de-duplicate on the panel name plus a 5-minute suppression window to prevent alert storms during sustained incidents; a single threshold breach produces at most one page per suppression window regardless of how many individual minute-buckets cross the line. Warning tickets auto-escalate to paging the owning team's primary on-call after one hour if unacknowledged, ensuring that non-critical regressions cannot indefinitely sit unaddressed. Critical pages auto-escalate to the secondary on-call after 15 minutes if unacknowledged by the primary, and auto-escalate further to the platform team distribution list after 30 minutes of continued non-acknowledgement. All alerts carry a direct link back to the triggering panel's current view, pre-filtered to the time window that breached the threshold, so that the operator acknowledging the alert lands inside the evidence rather than inside a navigation tree.

## SLO Tie-Ins

The dashboard panels map to the service-level objectives defined in the EP-011 backlog via the following abstract identifiers. The concrete SLO text, window definitions, and error budget math live in the EP-011 ticket body and are not duplicated here; this section establishes only the source panel for each SLO's computation.

- `SLO-001 — Availability ≥ 99.9%` is computed from the Error Rate panel as (1 − error-rate), integrated over the SLO window.
- `SLO-002 — P95 latency ≤ 500ms` is read directly from the P95 Latency panel; SLO burn equals the fraction of minute-buckets exceeding the threshold over the SLO window.
- `SLO-003 — Telemetry completeness ≥ 99.95%` is computed from the Correlation ID Throughput panel as observed-throughput divided by expected-throughput baseline over the SLO window.
- `SLO-004 — Session integrity` is monitored via the Active Sessions panel's trend deviation; sustained negative deviation beyond the warning threshold consumes the error budget for this SLO.
- `SLO-005 — Order-flow continuity` is monitored via the Order Creation Rate panel's trend deviation; sustained negative deviation beyond the warning threshold consumes the error budget for this SLO.

## Implementation Notes

This template specification has been translated into a live Prometheus + log-based scraping setup as part of the implementation phase. The concrete data sources for each panel are now:

- **Request Rate, Error Rate, P95 Latency, Error Rate Breakout** — sourced from the `/metrics` endpoint emitted by `backend/src/routes/metrics.ts` using the `prom-client` library. Metrics carry the three mandated labels (`service`, `environment`, `version`) per ST-048-AC2. The endpoint serves Prometheus text format with content type `text/plain; version=0.0.4; charset=utf-8`.
- **Correlation ID Throughput** — sourced from the structured log stream emitted by `backend/src/logging/pino.ts` plus the AsyncLocalStorage propagation in `backend/src/middleware/correlation.ts`. A pipeline-level dashboard query counts distinct `correlationId` values per minute bucket from the JSON log lines. Every log record carries a `correlationId` populated from the AsyncLocalStorage hook, ensuring the throughput count is a direct proxy for the inbound request rate.
- **Active Sessions** — sourced from a custom gauge in `backend/src/routes/metrics.ts` (`active_sessions{service,environment,version}`). The gauge is incremented on session creation in `backend/src/services/session.service.ts` (login path, ST-024) and decremented on session revocation (logout path, ST-025). The gauge is reconciled at process startup against the active row count in the `sessions` table to recover correct values after a restart.
- **Order Creation Rate** — sourced from the structured log stream filtered on `event: "order.created"` records emitted by `backend/src/services/order.service.ts` (ST-032). Each record carries the `correlationId`, `userId` (only the Firebase `uid`, never credential material per Rule R2), and `orderId` for downstream attribution.
- **Deploy Markers** — sourced from Cloud Build's `build-metadata.json` artifact emitted by the `cloudbuild.yaml` build step. Each completed build produces a deployment marker event with `commitSha`, `imageDigest`, and `deploymentId`. The Cloud Deploy `promotion` step extends each marker with the target environment (`development`, `staging`, `production`) per ST-042.

Concrete dashboarding tool selection is deferred to the infrastructure track. Until that selection occurs, this template remains the authoritative blueprint and the verification commands in `docs/observability/README.md` § Local Verification exercise each data source against the local development environment. The alert policy entries here are the source of truth for the eventual rehydrated dashboard's alert configuration.

## Cross-References

- Observability catalog: [./README.md](./README.md)
- Epic: [EP-011 Observability & Error Tracking](../../tickets/epics/EP-011-observability-error-tracking.md)
- Decision log: [../decisions/README.md](../decisions/README.md)
- Story — Distributed Tracing & Dashboard Template Stub: [ST-049 — Distributed Tracing & Dashboard Template Stub](../../tickets/stories/ST-049-distributed-tracing-dashboard-template-stub.md)
- Story — Metrics Endpoint, Health/Readiness Probes: [ST-048 — Metrics Endpoint, Health/Readiness Probes](../../tickets/stories/ST-048-metrics-endpoint-health-readiness-probes.md)
- Story — Structured Logs & Correlation ID: [ST-047 — Structured Logs & Correlation ID](../../tickets/stories/ST-047-structured-logs-correlation-id.md)
- Implementation — Metrics route: [../../backend/src/routes/metrics.ts](../../backend/src/routes/metrics.ts)
- Implementation — Health/readiness routes: [../../backend/src/routes/health.ts](../../backend/src/routes/health.ts)
- Implementation — Pino logger: [../../backend/src/logging/pino.ts](../../backend/src/logging/pino.ts)
- Implementation — Correlation middleware: [../../backend/src/middleware/correlation.ts](../../backend/src/middleware/correlation.ts)

## Document Maintenance

This template is updated whenever an EP-011 story changes the contract of any of the five observability pillars — structured logging, distributed tracing, metrics, health and readiness checks, or error tracking — or whenever an SLO identifier is added, removed, or re-scoped. Rationale for any non-trivial edit is recorded as a new row in the decision log at [../decisions/README.md](../decisions/README.md) before the edit is merged, so that the "why" of every template change is traceable and separate from the template body itself.
