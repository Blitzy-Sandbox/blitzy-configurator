/**
 * Three.js texture singleton wrapping the Fabric.js canvas bitmap.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/texture/threeTexture.ts
 *     | Three.js texture wrapping the Fabric canvas".
 *   - AAP C6 / Rule R7 — texture update ordering. This module owns the
 *     SOLE call site that mutates `THREE.Texture#needsUpdate`. Every
 *     other module that wants to mark the texture dirty MUST go through
 *     `texturePipeline.updateTexture()`, which calls
 *     `fabricCanvas.renderAll()` first and then `markThreeTextureDirty()`.
 *   - QA Report Issue #9 — texture pipeline files MUST exist and the
 *     ordering contract MUST be enforceable.
 *
 * Responsibilities:
 *   1. Construct exactly one `THREE.CanvasTexture` whose source is the
 *      detached HTMLCanvasElement owned by `fabricCanvas.ts`.
 *   2. Expose `getThreeTexture()` to consumers (Sphere.tsx) and
 *      `markThreeTextureDirty()` to the pipeline coordinator.
 *   3. Maintain proper texture configuration (color space, anisotropy,
 *      flip-Y) so the texture renders correctly on a `SphereGeometry`
 *      with default UV mapping.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R7 / C6: `markThreeTextureDirty()` is the SOLE function in
 *     the codebase that sets `texture.needsUpdate = true`. Sphere.tsx
 *     MUST NOT touch `needsUpdate` directly. The texture pipeline
 *     orchestrates ordering by calling `fabricCanvas.renderAll()` first
 *     and `markThreeTextureDirty()` second.
 *   - Rule R2: ZERO `console.*` statements.
 *   - Rule R3: No auth imports.
 *
 * Out of scope:
 *   - Material / shader / mesh management (that lives in `Sphere.tsx`
 *     and `useMaterialSwatch.ts`).
 *   - Multi-texture support (the configurator uses ONE map per ball).
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

import { getElement } from './fabricCanvas';

// ---------------------------------------------------------------------------
// Module-private singleton state.
//
// Module scope (not per-effect) so that the texture survives React
// StrictMode's mount/cleanup/remount and Vite HMR re-execution of
// consuming components.
// ---------------------------------------------------------------------------

/**
 * The single Three.js CanvasTexture wrapping the Fabric canvas bitmap.
 * `null` until first `getThreeTexture()` call; reset to `null` by
 * `disposeThreeTexture()`.
 */
let threeTexture: CanvasTexture | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the singleton Three.js texture, creating it on first call.
 *
 * The texture is constructed from the Fabric HTMLCanvasElement returned
 * by `getElement()`. Three.js's `CanvasTexture` automatically sets
 * `needsUpdate = true` once when constructed (per the official Three.js
 * docs), so the first frame after creation always sees the Fabric
 * content uploaded to the GPU without any extra coordination.
 *
 * Texture configuration:
 *   - `colorSpace = SRGBColorSpace`: pixel values authored in the
 *     Fabric canvas (which uses CSS sRGB color values like '#FFFFFF')
 *     are interpreted as sRGB by the GPU sampler. Without this, colors
 *     would be sampled as linear-RGB and look noticeably washed out.
 *   - `flipY = false`: The Fabric canvas pixel buffer's origin is
 *     top-left; Three.js's default `flipY=true` flips the Y axis on
 *     upload, which would render text and logos upside down on the
 *     ball. Setting `false` preserves the natural orientation.
 *   - `wrapS = wrapT = RepeatWrapping`: lets the equirectangular
 *     projection seam at u=0/u=1 be hidden by the default Three.js UV
 *     mapping for `SphereGeometry`.
 *   - `anisotropy = 4`: provides reasonable filtering quality at
 *     glancing angles (e.g., looking along the equator) without the
 *     8/16-sample cost of higher anisotropy.
 *
 * Cross-cutting note (Rule R7 / C6): This function does NOT itself
 * mutate `needsUpdate` after construction. The CanvasTexture
 * constructor sets it to `true` exactly once for the initial upload;
 * every subsequent dirty marker MUST go through `markThreeTextureDirty()`
 * — and `markThreeTextureDirty()` MUST be called only by the texture
 * pipeline coordinator after `renderFabricCanvas()`.
 */
export function getThreeTexture(): CanvasTexture {
  if (threeTexture !== null) {
    return threeTexture;
  }

  const fabricElement = getElement();
  threeTexture = new CanvasTexture(fabricElement);

  // Color space: Fabric writes sRGB hex colors; the texture must be
  // sampled as sRGB to roundtrip through the renderer's tone mapping.
  threeTexture.colorSpace = SRGBColorSpace;

  // Preserve native HTML canvas pixel orientation.
  threeTexture.flipY = false;

  // Equirectangular wrap so the seam at u=0/u=1 is hidden.
  threeTexture.wrapS = RepeatWrapping;
  threeTexture.wrapT = RepeatWrapping;

  // Glancing-angle filtering quality vs. cost trade-off.
  threeTexture.anisotropy = 4;

  // The CanvasTexture constructor sets `needsUpdate = true` automatically;
  // we do NOT reassert it here because doing so would constitute a
  // second `needsUpdate` mutation, which would create the dual-write
  // pattern Rule R7 / C6 explicitly forbids.

  return threeTexture;
}

/**
 * Mark the Three.js texture dirty, instructing the WebGL renderer to
 * re-upload the underlying canvas pixel buffer to the GPU on the next
 * draw call.
 *
 * (CRITICAL — Rule R7 / C6) This is the SOLE call site in the codebase
 * that is permitted to set `texture.needsUpdate = true`. The texture
 * pipeline coordinator (`texturePipeline.updateTexture()`) MUST call
 * `fabricCanvas.renderAll()` FIRST and `markThreeTextureDirty()` SECOND.
 * Any other call ordering produces a one-frame stale texture flicker
 * that is visible in Playwright visual-regression baselines.
 *
 * Idempotent: calling this when the texture has not yet been created
 * is a no-op (the next `getThreeTexture()` call will mark it dirty
 * automatically via the constructor).
 */
export function markThreeTextureDirty(): void {
  if (threeTexture === null) {
    // Nothing to mark dirty yet — the CanvasTexture constructor will
    // perform the initial upload on first creation. This branch
    // protects against a race where the pipeline coordinator runs
    // before the consumer (Sphere.tsx) has mounted.
    return;
  }
  threeTexture.needsUpdate = true;
}

/**
 * Dispose the singleton texture, releasing GPU resources.
 *
 * Idempotent: safe to call when no texture exists. After invocation,
 * the next `getThreeTexture()` call constructs a fresh texture from
 * the (presumably still-alive) Fabric canvas.
 *
 * In React StrictMode's development double-invocation cycle, the
 * cleanup function returned from `useEffect` runs once before the
 * effect re-runs; calling `disposeThreeTexture()` followed by a
 * subsequent `getThreeTexture()` correctly reproduces the production
 * one-mount lifecycle.
 */
export function disposeThreeTexture(): void {
  if (threeTexture !== null) {
    threeTexture.dispose();
    threeTexture = null;
  }
}

/**
 * Type re-export so consumers can ascribe their `THREE.MeshStandardMaterial.map`
 * field to the texture singleton without importing `three` themselves.
 * Aliased to the base `Texture` type to satisfy `MeshStandardMaterial.map`'s
 * type annotation.
 */
export type ConfiguratorTexture = Texture;
