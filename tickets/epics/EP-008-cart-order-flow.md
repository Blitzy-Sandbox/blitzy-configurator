---
id: EP-008
title: Cart & Order Flow
layer: backend
stories: [ST-032, ST-033, ST-034, ST-035]
---

## Overview

This epic delivers the capabilities needed to move a completed design from the configurator into an order record: a cart that accumulates the user's intent to purchase, an order creation step that captures the current cart state as a durable order, a finalization step that performs non-payment post-processing (reference numbering, confirmation messaging, order-state bookkeeping), and the underlying schema for orders and their line items.

The epic deliberately stops short of taking payment. Charging a card, collecting a payment method, issuing refunds, and integrating with any external payment processor are all explicitly out of scope for this release. The order record that this epic produces is the handoff point to a future payment capability, not a replacement for one.

## Goals

- Provide a Retrieve Cart endpoint that returns the current cart contents for the signed-in user.
- Provide a Create Order endpoint that captures a cart state as a durable order record.
- Provide a Finalize Order step that performs the non-payment post-processing required when an order is placed.
- Provide the schema migrations introducing the orders and order-items tables with indexes supporting retrieval by user and by order identifier.
- Emit structured, correlation-tagged events for every cart and order transition so downstream observability tooling can trace the flow.

## Success Criteria

- A signed-in user's cart can be retrieved and reflects the items they have added.
- Creating an order produces a persistent record that can be re-retrieved by its identifier.
- Finalizing an order completes all non-payment post-processing steps and leaves the order in the expected terminal state.
- The schema migrations apply cleanly forward and roll back cleanly backward.
- Cart and order events appear in the log stream with correlation identifiers that tie them to the originating request.

## Child Stories

- ST-032 — Create Order endpoint capturing a cart state as a durable order record.
- ST-033 — Retrieve Cart endpoint returning the signed-in user's current cart contents.
- ST-034 — Finalize Order step performing the documented post-processing workflow.
- ST-035 — Orders and order-items schema migration with indexes supporting retrieval queries.

## Out of Scope

The following are explicitly **out of scope** for this epic and for the initial release of the configurator:

- Payment processor integration of any kind.
- Payment method capture (card numbers, bank accounts, digital wallet handles, or any other payment instrument).
- Tokenization of payment instruments.
- Charge authorization, capture, and settlement.
- Refund flows, dispute handling, and chargeback processing.

The order record produced by this epic is the handoff point to a future payment capability. That future capability will be scoped, designed, and tracked under a separate epic when it is prioritized.
