---
id: ST-017
title: Reject Invalid Logo Uploads with a Clear User Message
epic: EP-004
layer: frontend
points: 2
priority: medium
---

## Narrative

As an end user, I want the configurator to tell me plainly when my logo upload fails, so that I know how to fix my file instead of being left confused.

## Acceptance Criteria

- [x] Uploading a file whose type is not among the supported raster and vector image formats is rejected and the preview is left unchanged.
- [x] Uploading a file larger than the documented maximum file size is rejected and the preview is left unchanged.
- [x] Every rejection produces a user-facing message that names the specific reason (unsupported format versus size limit) and the remediation the user can take.
- [x] The rejection message is announced to assistive technology and does not obscure the 3D preview or the control sidebar.
