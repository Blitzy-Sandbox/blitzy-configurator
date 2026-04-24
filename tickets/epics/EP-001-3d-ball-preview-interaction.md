---
id: EP-001
title: 3D Ball Preview & Interaction
layer: frontend
stories: [ST-001, ST-002, ST-003, ST-004, ST-005]
---

## Overview

This epic delivers the live, interactive 3D ball preview that anchors the configurator experience. A user opens the configurator and sees a spherical ball rendered at the center of the screen; every customization choice applied through the surrounding controls is reflected on the sphere in real time. The preview responds to direct manipulation — the user rotates the ball by clicking and dragging — and, when no interaction is taking place, the ball gently rotates on its own so the viewer can appreciate the full design from every angle without effort.

The preview is engineered to feel responsive on mainstream consumer hardware. Initial render completes quickly on first load, visual updates reflect design changes without perceptible delay, and sustained interaction maintains a smooth framerate within a defined performance budget.

## Goals

- Render an interactive three-dimensional ball preview at the center of the configurator.
- Enable intuitive click-and-drag rotation so users can inspect every region of the ball.
- Automatically rotate the ball when the user is idle, revealing the full design without requiring manual interaction.
- Propagate every design selection (color, pattern, finish, branding) to the preview in real time.
- Maintain a target interactive framerate and initial-load budget on representative hardware.

## Success Criteria

- The preview appears on the configurator screen within the initial-load budget on a typical consumer device.
- Click-and-drag rotation feels smooth and responsive, with no visible stutter during continuous interaction.
- After a defined idle interval, the ball begins to auto-rotate without user input.
- A material or color selection applied in the sidebar is visible on the preview within the latency budget.
- Sustained interaction maintains a framerate at or above the budget floor on the reference hardware profile.

## Child Stories

- ST-001 — Render the initial spherical ball preview on configurator load.
- ST-002 — Support click-and-drag rotation of the ball with momentum-consistent motion.
- ST-003 — Automatically rotate the ball when the user has been idle for the configured interval.
- ST-004 — Apply selected material swatches to the preview in real time.
- ST-005 — Meet the interactive framerate and initial-load performance budget on the reference hardware profile.
