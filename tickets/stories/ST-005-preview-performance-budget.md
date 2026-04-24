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

- [ ] Under sustained click-and-drag rotation on the reference hardware profile, the preview maintains a framerate at or above the documented floor.
- [ ] Under auto-rotation idle playback on the reference hardware profile, the preview maintains a framerate at or above the documented floor.
- [ ] The initial preview render completes within the documented first-render budget on the reference hardware profile.
- [ ] Performance measurements are captured and attached to the release artifact so budget compliance can be audited after the fact.
