---
id: EP-007
title: Design Persistence API & Data Model
layer: backend
stories: [ST-027, ST-028, ST-029, ST-030, ST-031]
---

## Overview

This epic delivers the persistence foundation behind the user-facing design management flow. When a user saves a design, an endpoint accepts the configuration payload and writes it durably so that it can be retrieved later. When a user opens Load Design, an endpoint returns the list of designs the user owns. When a user invites someone to view their work, an endpoint produces a link that resolves to a read-only view of a specific design snapshot.

Alongside the endpoints, this epic delivers the underlying data model: the schema that describes a design, the schema that describes a user and their session, and the indexes that keep the endpoint latencies predictable as the dataset grows. The data model work is authored as its own stories so the schema changes can be reviewed and migrated on their own lifecycle even though they are conceptually part of the same capability.

## Goals

- Provide a Create Design endpoint that accepts a configuration payload and persists it to the owner's account.
- Provide a Retrieve Designs endpoint that returns the list of designs owned by the signed-in user.
- Provide a Share Link endpoint that mints a link resolving to a read-only snapshot of a specific design.
- Provide the schema migrations introducing the designs, users, and sessions tables with appropriate indexes.
- Expose consistent identifiers and timestamps across every endpoint and schema in the epic so downstream consumers and observability tooling can correlate records.

## Success Criteria

- A design saved through the Create endpoint can be retrieved later with byte-equivalent configuration.
- The Retrieve endpoint returns only designs owned by the requesting user.
- A share link returned by the Share endpoint resolves to a read-only snapshot that honors the link's configured lifetime.
- The schema migrations apply cleanly forward and roll back cleanly backward.
- Indexed queries return results within the latency budget at the expected dataset size.

## Child Stories

- ST-027 — Create Design endpoint accepting and persisting a configuration payload.
- ST-028 — Retrieve Designs endpoint returning the signed-in user's design list.
- ST-029 — Share Link endpoint issuing a read-only snapshot link with a configured lifetime.
- ST-030 — Designs schema migration with indexes supporting list-by-owner queries.
- ST-031 — Users and sessions schema migration with indexes supporting session lookup.
