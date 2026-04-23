---
id: EP-002
title: Panel Color Customization
layer: frontend
stories: [ST-006, ST-007, ST-008, ST-009]
---

## Overview

This epic delivers the color customization surface of the configurator. The user selects a primary color, a secondary color, and an accent color from curated palettes and sees those colors applied to the ball's panels in real time on the 3D preview. The three color roles correspond to the layered visual identity of the ball: a dominant primary tone, a complementary secondary tone, and an accent tone used sparingly for highlight regions.

Color selection is designed to feel immediate and forgiving. Clicking a swatch updates the preview without a perceptible lag; the currently selected swatch in each palette remains visually marked so the user never loses track of their choice; and the palettes are navigable with keyboard and assistive technology alongside mouse and touch input.

## Goals

- Provide a primary-color swatch picker integrated into the configurator control sidebar.
- Provide a secondary-color swatch picker with the same interaction affordances as primary.
- Provide an accent-color swatch picker with the same interaction affordances as primary and secondary.
- Synchronize every color change with the live 3D preview within the defined latency budget.
- Preserve accessibility by making every swatch picker keyboard-navigable and screen-reader-friendly.

## Success Criteria

- A user can pick primary, secondary, and accent colors and see each applied to the preview immediately.
- The currently selected swatch in each palette is visually distinct from unselected swatches.
- Color changes appear on the preview within the published latency budget on the reference hardware.
- Every swatch picker is reachable and operable using only the keyboard.
- Assistive technologies announce the purpose of each swatch control and its current selection state.

## Child Stories

- ST-006 — Primary-color swatch picker with live preview synchronization.
- ST-007 — Secondary-color swatch picker with live preview synchronization.
- ST-008 — Accent-color swatch picker with live preview synchronization.
- ST-009 — Real-time preview synchronization for all three color roles within the latency budget.
