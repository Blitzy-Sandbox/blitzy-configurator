---
id: ST-001
title: Render Initial Sphere Preview on Configurator Load
epic: EP-001
layer: frontend
points: 5
priority: high
---

## Narrative

As an end user, I want the three-dimensional ball to appear on the configurator screen when I first open it, so that I can immediately see what I am designing.

## Acceptance Criteria

- [ ] Opening the configurator displays a three-dimensional spherical ball centered in the preview area within the documented initial-load budget on the reference hardware profile.
- [ ] The ball renders with the documented default visual state (default panel colors, default stitching pattern, default finish) before any user selection is made.
- [ ] Resizing the browser window re-centers the ball and keeps it fully visible without distortion or clipping.
- [ ] The initial render cycle completes without producing visible artifacts or console-level error output.
