---
id: ST-003
title: Auto-Rotate Ball When User Is Idle
epic: EP-001
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want the ball to rotate on its own when I am not interacting with the configurator, so that I can see the full design from every angle without effort.

## Acceptance Criteria

- [ ] After the configured idle interval elapses with no user input, the ball begins rotating automatically at the configured rotational velocity.
- [ ] Any user interaction (pointer movement over the preview area, control click, or rotation drag) immediately pauses the auto-rotation.
- [ ] When interaction stops, the idle timer restarts and auto-rotation resumes once the interval elapses again.
- [ ] Auto-rotation direction and rotational velocity match the documented configuration values.
