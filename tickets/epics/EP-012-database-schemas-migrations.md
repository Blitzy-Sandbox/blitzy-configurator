---
id: EP-012
title: Database Schemas & Migrations
layer: database
stories: [ST-030, ST-031, ST-035]
---

## Overview

This epic is the dedicated home for the database-layer deliverables that underpin the rest of the configurator backlog. Three forward-and-reverse schema migrations introduce the durable tables the API epics write to and read from: the designs table that persists a user's saved configuration, the users and sessions tables that anchor the authenticated-user experience, and the orders and order-items tables that capture a completed cart as an order record. Every migration also introduces the indexes needed to keep the endpoint query patterns within their documented latency budgets as the dataset grows.

The schema work is grouped under its own epic so that it can be reviewed, migrated, and rolled back on its own lifecycle while remaining cleanly linked to the API epics that consume it. EP-007 owns the design-persistence API surface and refers to this epic for the designs and users and sessions tables; EP-008 owns the cart and order flow and refers to this epic for the orders and order-items tables. Each schema story is reachable from the consuming API story through an explicit cross-epic `depends-on` link so that the producer-and-consumer relationship is explicit in frontmatter rather than implicit in prose.

## Goals

- Introduce the designs table with indexes that support list-by-owner and sort-by-last-modified queries without full-table scans.
- Introduce the users and sessions tables with indexes that support session-token lookup and credential-identifier uniqueness.
- Introduce the orders and order-items tables with foreign keys into the designs and users tables and indexes that support retrieval by user and by order identifier.
- Guarantee that every migration applies cleanly forward, rolls back cleanly backward, and is idempotent against repeat application on a clean state.
- Exercise every forward migration in the local development environment against both an empty database and a non-empty database without data loss.

## Success Criteria

- Every migration runs to completion in the local development environment with zero manual cleanup steps.
- Every reverse migration drops its tables in correct foreign-key dependency order and restores the schema to its pre-migration state.
- Indexed queries for the documented access patterns complete within the latency budget at the expected dataset size.
- Credential digest columns are sized and constrained to prevent storage of cleartext credentials, and schema documentation is maintained in a single source that the authentication and persistence stories reference.
- The producer-consumer relationship between each migration and the API stories that consume it is traceable through `depends-on` edges in the relevant story frontmatter.

## Child Stories

- ST-030 — Introduce the designs schema with ownership foreign keys and indexes supporting list-by-owner queries.
- ST-031 — Introduce the users and sessions schemas with unique-identifier and session-token indexes.
- ST-035 — Introduce the orders and order-items schemas with foreign keys into designs and users and indexes supporting retrieval queries.
