---
id: EP-005
title: Design Management
layer: frontend
stories: [ST-018, ST-019, ST-020, ST-021, ST-022]
---

## Overview

This epic delivers the user-facing lifecycle of a design: saving a work-in-progress, loading a previously saved design, starting fresh with a blank canvas, and sharing a finished design with another viewer via a copyable link. A compact design summary sidebar sits at the right of the configurator and mirrors every selection the user has made, giving a running at-a-glance snapshot of the current design without requiring the user to re-open each control group.

The epic scope is confined to the UI surface of design management — the buttons, confirmations, and summary view that the user sees and clicks. The persistence engine that durably stores designs, authenticates their owner, and mints share links lives in a separate epic and is linked from each relevant story through an explicit dependency declaration. Splitting the work this way keeps each story scoped to a single layer and allows the UI and backend to be delivered on independent cadences.

## Goals

- Provide a Save Design call-to-action that captures the current configuration and hands it off to the persistence layer.
- Provide a Load Design flow that lets the user pick from their previously saved designs and restores one.
- Provide a New Design action that resets the configurator to a clean starting state after a confirmation prompt.
- Provide a Share action that produces a copyable link to the current design.
- Provide a right-side Design Summary sidebar that updates live as the user makes selections.

## Success Criteria

- Pressing Save produces a visible confirmation that the design has been captured.
- Opening Load displays the current user's previously saved designs and lets them restore one with a single click.
- Pressing New prompts the user to confirm and, on confirmation, clears all current selections.
- Pressing Share produces a link that the user can copy to the clipboard with one further click.
- The Design Summary sidebar reflects every selection the user makes without a manual refresh.

## Child Stories

- ST-018 — Save Design call-to-action wired to the persistence handoff.
- ST-019 — Load Design flow listing the user's previously saved designs with a single-click restore.
- ST-020 — New Design reset action guarded by a confirmation prompt.
- ST-021 — Share action producing a copyable link to the current design.
- ST-022 — Design Summary sidebar mirroring current selections in real time.
