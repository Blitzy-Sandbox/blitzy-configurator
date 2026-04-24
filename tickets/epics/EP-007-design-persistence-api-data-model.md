---
id: EP-007
title: Design Persistence API & Data Model
layer: backend
stories: [ST-027, ST-028, ST-029]
---

## Overview

This epic delivers the persistence API surface behind the user-facing design management flow. When a user saves a design, an endpoint accepts the configuration payload and writes it durably so that it can be retrieved later. When a user opens Load Design, an endpoint returns the list of designs the user owns. When a user invites someone to view their work, an endpoint produces a link that resolves to a read-only view of a specific design snapshot.

The endpoints in this epic sit on top of a data model that is authored under its own epic (EP-012 Database Schemas & Migrations) so that schema changes can be reviewed and migrated on their own lifecycle. Each endpoint story here declares an explicit `depends-on` link to the migration story that introduces the tables it writes to or reads from, making the producer-and-consumer relationship between API and schema traceable through frontmatter.

## Goals

- Provide a Create Design endpoint that accepts a configuration payload and persists it to the owner's account.
- Provide a Retrieve Designs endpoint that returns the list of designs owned by the signed-in user.
- Provide a Share Link endpoint that mints a link resolving to a read-only snapshot of a specific design.
- Consume the designs, users, and sessions schemas introduced under EP-012 via explicit `depends-on` links from every endpoint story to the migration story it relies on.
- Expose consistent identifiers and timestamps across every endpoint in the epic so downstream consumers and observability tooling can correlate records.

## Success Criteria

- A design saved through the Create endpoint can be retrieved later with byte-equivalent configuration.
- The Retrieve endpoint returns only designs owned by the requesting user.
- A share link returned by the Share endpoint resolves to a read-only snapshot that honors the link's configured lifetime.
- Every endpoint's query shape is served by an index introduced in the schema migration it depends on, and response latencies stay within the documented budget at the expected dataset size.
- Every endpoint story names the schema migration story it depends on, and that dependency is traceable through the `depends-on` frontmatter field.

## Child Stories

- ST-027 — Create Design endpoint accepting and persisting a configuration payload.
- ST-028 — Retrieve Designs endpoint returning the signed-in user's design list.
- ST-029 — Share Link endpoint issuing a read-only snapshot link with a configured lifetime.
