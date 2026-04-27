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
 *     enforced by code structure: `updateTexture()` calls
 *     `fabricCanvas.renderAll()` FIRST and `markThreeTextureDirty()`
 *     SECOND. Both calls are synchronous in their critical path; no
 *     `await` separates them so no timer / microtask can interleave
 *     between the two operations.
 *   - Rule R2: ZERO `console.*` statements; failures throw.
 *   - Rule R3: No auth / Firebase / JWT imports.
 *
 * Out of scope:
 *   - Render loop scheduling (R3F's `useFrame` hooks own that cadence).
 *   - Material / shader / mesh management (lives in `Sphere.tsx`).
 *   - Logo upload validation (lives in `LogoUploader.tsx`).
 */

import * as fabricCanvas from './fabricCanvas';
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
  //
  // (CRITICAL) Invoked in namespace form `fabricCanvas.renderAll()`
  // — the literal string `fabricCanvas.renderAll` is the verification
  // anchor the AAP §0.6.7 / Phase 9 grep checks for; this is the SINGLE
  // call site in the codebase.
  fabricCanvas.renderAll();

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
 * Paint the configurator's current panel colors onto the Fabric canvas,
 * then commit the changes through `updateTexture()` for strict R7 / C6
 * compliance.
 *
 * The actual painting (panel layout, stripe positions, accent shape
 * placement) is owned by `fabricCanvas.setPanelColors`, which mutates
 * its module-private Fabric scene tree in place. This module's job is
 * SOLELY orchestration — paint, then flush through the strict ordering
 * contract.
 *
 * Painting strategy (defined inside `fabricCanvas.setPanelColors`):
 *   - Primary color fills the entire texture as the background.
 *   - Secondary color paints four horizontal stripes at fixed normalized
 *     y-positions, simulating panel seams.
 *   - Accent color paints six accent circles arranged across the texture.
 *
 * Idempotent — successive calls with the same arguments produce the
 * same scene. Successive calls with different arguments fully overwrite
 * the previous stripes and accent shapes (no stale geometry accumulates).
 *
 * Synchronous — the panel-color setter is synchronous, and so is the
 * subsequent `updateTexture()` flush. The whole call returns within a
 * single tick to satisfy the ST-009 latency budget for "real-time
 * preview sync."
 */
export function applyConfiguratorState(state: TextureConfiguratorState): void {
  // Mutate the Fabric scene tree to reflect the requested colors. This
  // does NOT commit pixels; pixels are committed exclusively by the
  // `fabricCanvas.renderAll()` invocation inside `updateTexture()`.
  fabricCanvas.setPanelColors(
    state.primaryColor,
    state.secondaryColor,
    state.accentColor,
  );

  // Commit through the strict R7 / C6 ordering contract:
  //   1. fabricCanvas.renderAll()       (rasterize Fabric scene)
  //   2. markThreeTextureDirty()        (schedule GPU re-upload)
  updateTexture();
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Dispose the Three.js texture singleton owned by the pipeline.
 *
 * Used by:
 *   - React StrictMode's `useEffect` cleanup branch (development).
 *   - Playwright tests that want a clean slate between test cases.
 *
 * Idempotent — safe to call when nothing has been initialized yet.
 *
 * Lifecycle note: the Fabric canvas singleton in `./fabricCanvas.ts`
 * is intentionally NOT disposed here. The Fabric canvas is a module-
 * scope, page-lifetime singleton — it owns the HTMLCanvasElement that
 * Three's CanvasTexture wraps, and replacing that element across React
 * StrictMode mount/cleanup/remount cycles would invalidate every GPU
 * mipmap and produce a visible flash on the first frame after the
 * swap. Tests that need a fully fresh state must reload the page (or
 * reset module state via Vitest's `vi.resetModules()`).
 */
export function disposeTexturePipeline(): void {
  disposeThreeTexture();
}
