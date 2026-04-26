---
id: ST-005
title: Meet Preview Framerate and Initial-Load Performance Budget
epic: EP-001
layer: frontend
points: 5
priority: high
---

## Narrative

As a QA engineer, I want the preview to meet a defined framerate and initial-load budget, so that I can certify the product runs smoothly on representative hardware.

## Acceptance Criteria

- [x] Under sustained click-and-drag rotation on the reference hardware profile, the preview maintains a framerate at or above the documented floor of 30 frames per second (FPS).
- [x] Under auto-rotation idle playback on the reference hardware profile, the preview maintains a framerate at or above the documented floor of 30 frames per second (FPS).
- [x] The initial preview render completes within the documented first-render budget of 2 seconds on the reference hardware profile.
- [x] Performance measurements are captured and attached to the release artifact so budget compliance — the 30 FPS floor and the 2-second first-render target — can be audited after the fact.
