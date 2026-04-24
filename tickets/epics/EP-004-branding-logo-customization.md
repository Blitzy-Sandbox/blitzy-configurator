---
id: EP-004
title: Branding & Logo Customization
layer: frontend
stories: [ST-014, ST-015, ST-016, ST-017]
---

## Overview

This epic lets a user apply their own branding to the ball by uploading a logo image and placing it on a chosen panel. The user selects a file from their device, sees the logo appear on the preview immediately, then repositions and resizes it interactively until the placement feels right. If the chosen file is not a supported image, is too large, or is otherwise unusable, the configurator rejects it with a clear, human-friendly explanation so the user understands what to try next instead of being met with a silent failure.

The capability covers the full upload-to-placement journey on the client side: file selection, validation, preview rendering, positioning, and scaling. It does not include server-side persistence of uploaded logos — that concern lives under the design persistence epic.

## Goals

- Provide a logo upload control in the configurator sidebar that accepts standard raster and vector image formats.
- Let the user reposition the uploaded logo on the selected panel with direct manipulation.
- Let the user scale the uploaded logo within defined minimum and maximum bounds.
- Reject unsupported or unusable files with a clear user-facing error message.
- Show the uploaded logo on the 3D preview within the latency budget once validated.

## Success Criteria

- A valid logo uploaded by the user appears on the preview without a page reload.
- The uploaded logo can be dragged to a new position on the panel and the new position is reflected on the preview.
- The uploaded logo can be scaled up and down within the permitted range and the new size is reflected on the preview.
- An unsupported or unusable file triggers a clear, human-friendly error message naming the reason for rejection.
- No upload produces a silent failure or a visually broken preview.

## Child Stories

- ST-014 — Logo upload control with client-side file selection.
- ST-015 — Logo positioning on the selected panel via direct manipulation.
- ST-016 — Logo scaling within defined minimum and maximum bounds.
- ST-017 — Invalid-file rejection with user-facing explanatory feedback.
