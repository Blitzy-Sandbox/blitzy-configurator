---
id: ST-012
title: Show Visual Transition Feedback When Pattern or Finish Changes
epic: EP-003
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want a smooth transition or loading indicator when I change the stitching pattern or material finish, so that the change feels intentional rather than jarring.

## Acceptance Criteria

- [x] Changing the stitching pattern produces a visible transition on the preview rather than an abrupt swap.
- [x] Changing the material finish produces a visible transition on the preview rather than an abrupt swap.
- [x] If a transition takes longer than the documented threshold, a loading indicator appears on the preview until the new state is fully rendered.
- [x] The transition animation does not block unrelated interactions such as rotation or other sidebar selections.
