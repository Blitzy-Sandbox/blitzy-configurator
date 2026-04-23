---
id: EP-003
title: Stitching Pattern & Finish Selection
layer: frontend
stories: [ST-010, ST-011, ST-012, ST-013]
---

## Overview

This epic lets the user choose how the ball's surface is stitched together and how light reflects off of it. Six stitching patterns are offered — Classic, Hexagonal, Diamond, Spiral, Star, and Grid — each evoking a different visual identity. Three material finishes — Matte, Glossy, and Metallic — define the sheen and light response. Selections made in the sidebar apply to the 3D preview with a visible transition so the user can see the change happen rather than being startled by an instantaneous swap.

Not every combination of pattern and finish is supported at launch; in such cases the unsupported option is shown in a disabled state with a tooltip explaining which alternative combinations are available. This makes the configurator's boundaries legible to the user rather than leaving them to guess.

## Goals

- Offer a selectable gallery of six stitching patterns with clear visual previews of each.
- Offer a selectable set of three material finishes with clear visual previews of each.
- Animate or transition the preview when the user changes pattern or finish so the change is visually acknowledged.
- Disable incompatible pattern-finish combinations with a tooltip that explains the limitation.
- Ensure every supported combination renders correctly on the 3D preview.

## Success Criteria

- Each of the six stitching patterns can be applied and renders accurately on the preview.
- Each of the three finishes visibly changes how light interacts with the ball's surface.
- Switching pattern or finish produces a visual transition rather than an abrupt swap.
- Unsupported combinations are disabled and accompanied by an explanatory tooltip.
- No supported combination produces a broken or visually degraded preview.

## Child Stories

- ST-010 — Stitching pattern selector covering Classic, Hexagonal, Diamond, Spiral, Star, and Grid.
- ST-011 — Material finish selector covering Matte, Glossy, and Metallic.
- ST-012 — Visual transition feedback when pattern or finish is changed.
- ST-013 — Disabled-state handling for unsupported pattern-finish combinations with explanatory tooltip.
