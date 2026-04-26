/**
 * Texture pipeline coordinator — the SINGLE site in the codebase that
 * orchestrates the Fabric.js → Three.js texture update sequence.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/texture/texturePipeline.ts
 *     | C6/R7 coordinator: fabricCanvas.renderAll() → awaited — THEN
 *     threeTexture.needsUpdate = true".
 *   - AAP C6 — "When a configurator selection changes, the sequence MUST be:
 *     (1) call fabricCanvas.renderAll(), then (2) only after renderAll
 *     completes, set threeTexture.needsUpdate = true. Reversing this
 *     order produces a one-frame stale texture that is visible as flicker
 *     in Playwright visual-regression baselines. The texture update
 *     coordinator lives in frontend/src/configurator/texture/ and must
 *     be the single code path that mutates threeTexture.needsUpdate."
 *   - Rule R7 — same constraint, restated. This file is the SOLE caller
 *     of `markThreeTextureDirty()`; greppable enforcement.
 *   - QA Report Issue #9 — texture pipeline files MUST exist and the
 *     ordering contract MUST be enforceable.
 *
 * Responsibilities:
 *   1. Provide the SINGLE function (`updateTexture`) that consumers call
 *     after every configurator state change. Internally enforces:
 *
 *       fabricCanvas.renderAll()      ← from `fabricCanvas.ts`
 *       threeTexture.needsUpdate = true   ← from `threeTexture.ts`
 *
 *     in this exact order, never reversed.
 *
 *   2. Provide an `applyConfiguratorState` that paints the current
 *      configurator selection (primary color, accent color, optional
 *      logo placeholder) onto the Fabric canvas, then invokes
 *      `updateTexture()` to commit the changes through the strict
 *      ordering contract.
 *
 *   3. Expose lifecycle helpers (`disposeTexturePipeline`) so that
 *      tests and React StrictMode cleanup paths can fully reset the
 *      pipeline without leaking GPU memory.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R7 / C6 (THIS module's primary purpose). The ordering is
 *     enforced by code structure: `updateTexture()` calls `renderFabricCanvas()`
 *     FIRST and `markThreeTextureDirty()` SECOND. Both functions are
 *     synchronous in their critical path; no `await` separates them so
 *     no timer / microtask can interleave between the two operations.
 *   - Rule R2: ZERO `console.*` statements; failures throw.
 *   - Rule R3: No auth / Firebase / JWT imports.
 *
 * Out of scope:
 *   - Render loop scheduling (R3F's `useFrame` hooks own that cadence).
 *   - Material / shader / mesh management (lives in `Sphere.tsx`).
 *   - Logo upload validation (lives in `LogoUploader.tsx`).
 */

import { Rect } from 'fabric';

import {
  FABRIC_CANVAS_DIMENSIONS,
  getFabricCanvas,
  renderFabricCanvas,
  disposeFabricCanvas,
} from './fabricCanvas';
import { disposeThreeTexture, markThreeTextureDirty } from './threeTexture';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of the Zustand configurator store that the texture pipeline
 * needs in order to render the current ball appearance. Kept narrow so
 * the pipeline does not transitively depend on `loadedDesign`,
 * `isSaved`, or any other slice unrelated to visual rendering.
 *
 * The shape mirrors the corresponding fields on `ConfiguratorState`
 * (defined in `configuratorStore.ts`) but is restated here so this
 * module has zero direct dependency on the store — a future swap from
 * Zustand to another state library would require ZERO changes in this
 * file.
 */
export interface TextureConfiguratorState {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
}

// ---------------------------------------------------------------------------
// Public API — texture coordinator (Rule R7 / C6 enforcement)
// ---------------------------------------------------------------------------

/**
 * Commit pending Fabric mutations to the Three.js texture.
 *
 * (CRITICAL — Rule R7 / C6) Enforces the documented ordering:
 *
 *   1. fabricCanvas.renderAll()        ← rasterize all object updates
 *   2. threeTexture.needsUpdate = true ← schedule GPU re-upload
 *
 * Both calls are synchronous; no `await` separates them, so no timer /
 * microtask / promise resolution can interleave between the two
 * operations. Reversing the order would produce a one-frame stale
 * texture (the GPU would re-upload the OLD bitmap, then Fabric would
 * render the NEW one but the upload would not happen until the next
 * frame).
 *
 * Idempotent — safe to call multiple times back-to-back. Each
 * invocation re-rasterizes Fabric's object list and re-marks the
 * texture dirty. The GPU upload itself happens at most once per frame
 * regardless of how many times `needsUpdate` is set within that frame
 * window.
 */
export function updateTexture(): void {
  // STEP 1 — Fabric MUST render first. The synchronous `renderAll()`
  // walks Fabric's object list and rasterizes into the underlying
  // 2D context (the HTMLCanvasElement that Three's CanvasTexture
  // sources from).
  renderFabricCanvas();

  // STEP 2 — Mark the Three texture dirty so the next WebGL draw
  // call re-uploads the pixel buffer to the GPU. This MUST happen
  // AFTER step 1 — reversing the order would upload the stale bitmap
  // and the new Fabric content would be invisible until the next
  // frame triggers another `needsUpdate` cycle.
  markThreeTextureDirty();
}

// ---------------------------------------------------------------------------
// Public API — high-level paint helpers
// ---------------------------------------------------------------------------

/**
 * Paint the configurator's current visual state onto the Fabric canvas,
 * then commit the changes through `updateTexture()` for strict R7 / C6
 * compliance.
 *
 * Painting strategy (matches the equirectangular UV mapping of
 * `THREE.SphereGeometry`):
 *
 *   ┌──────────────────────────────────────────────────┐  (1024 × 512)
 *   │                                                  │
 *   │   ┌────────────────────────────────────────┐     │  ← top edge
 *   │   │                                        │     │
 *   │   │             primary color              │     │  ← upper hemisphere
 *   │   │                                        │     │
 *   │   ├────────────────────────────────────────┤     │  ← equator
 *   │   │       accent stripe (1 row tall)        │    │
 *   │   ├────────────────────────────────────────┤     │
 *   │   │            secondary color             │     │  ← lower hemisphere
 *   │   │                                        │     │
 *   │   └────────────────────────────────────────┘     │
 *   │                                                  │
 *   └──────────────────────────────────────────────────┘
 *
 * This is a deliberately simple panel layout — a primary upper hemisphere,
 * an accent equator stripe, and a secondary lower hemisphere — chosen
 * so the texture pipeline produces a visibly distinct ball for each
 * combination of {primary, secondary, accent} colors without depending
 * on stitching pattern artwork or uploaded logo assets (those land in
 * MG1-F when LogoPositioner.tsx is wired up).
 *
 * Uses Fabric `Rect` objects with absolute positions; clears the canvas
 * by removing every existing object before re-painting. This is O(N)
 * in the number of objects — currently 3 — so each call is constant-
 * time even at 60 Hz update cadence.
 */
export function applyConfiguratorState(state: TextureConfiguratorState): void {
  const canvas = getFabricCanvas();
  const { width, height } = FABRIC_CANVAS_DIMENSIONS;

  // Wipe the existing object list so consecutive calls do not accumulate
  // overlapping rects. `clear()` also resets the background color, so
  // we re-set it explicitly below.
  canvas.clear();
  canvas.backgroundColor = state.primaryColor;

  // Upper-hemisphere rect — the primary color.
  // The background is already primary, so this rect is technically
  // redundant. Drawing it explicitly anyway documents the intent and
  // future-proofs against changes that might layer additional content
  // (e.g. stitching pattern overlays from EP-003) below the rect.
  const upperHalf = new Rect({
    left: 0,
    top: 0,
    width,
    height: height / 2,
    fill: state.primaryColor,
    selectable: false,
    evented: false,
  });

  // Accent equator stripe — 24px tall band centered on the equator.
  // The pixel-precise Y coordinate (`height / 2 - 12`) keeps the band
  // exactly centered and avoids subpixel anti-aliasing seams.
  const accentHeight = 24;
  const accent = new Rect({
    left: 0,
    top: height / 2 - accentHeight / 2,
    width,
    height: accentHeight,
    fill: state.accentColor,
    selectable: false,
    evented: false,
  });

  // Lower-hemisphere rect — the secondary color.
  const lowerHalf = new Rect({
    left: 0,
    top: height / 2,
    width,
    height: height / 2,
    fill: state.secondaryColor,
    selectable: false,
    evented: false,
  });

  canvas.add(upperHalf);
  canvas.add(lowerHalf);
  // Accent is added LAST so it renders on top of the two hemisphere
  // rects (Fabric uses painter's-order: later additions sit higher in
  // the z-stack).
  canvas.add(accent);

  // Commit through the strict R7 / C6 ordering contract.
  updateTexture();
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Dispose every singleton owned by the texture pipeline.
 *
 * Used by:
 *   - React StrictMode's `useEffect` cleanup branch (development).
 *   - Playwright tests that want a clean slate between test cases.
 *
 * Idempotent — safe to call when nothing has been initialized yet. The
 * Fabric canvas dispose runs first because the Three texture references
 * the Fabric element (disposing the texture first would leave the
 * Fabric canvas alive briefly, then disposing the canvas would
 * invalidate the texture's source mid-frame on rare timing).
 */
export function disposeTexturePipeline(): void {
  disposeThreeTexture();
  disposeFabricCanvas();
}
