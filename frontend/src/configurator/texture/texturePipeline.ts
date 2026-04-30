/**
 * Texture pipeline coordinator — the SINGLE site in the codebase that
 * orchestrates the Fabric.js → Three.js texture update sequence.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/texture/texturePipeline.ts
 *     | C6/R7 coordinator: fabricCanvas.renderAll() → awaited — THEN
 *     threeTexture.needsUpdate = true".
 *   - AAP §0.2.2 Constraint C6 — "When a configurator selection changes,
 *     the sequence MUST be: (1) call fabricCanvas.renderAll(), then (2)
 *     only after renderAll completes, set threeTexture.needsUpdate = true.
 *     Reversing this order produces a one-frame stale texture that is
 *     visible as flicker in Playwright visual-regression baselines. The
 *     texture update coordinator lives in frontend/src/configurator/texture/
 *     and must be the single code path that mutates threeTexture.needsUpdate."
 *   - AAP §0.8.1 Rule R7 — "fabricCanvas.renderAll() MUST resolve before
 *     threeTexture.needsUpdate = true is set."
 *
 * Single-code-path invariants enforced HERE (greppable):
 *   - `grep -rn "needsUpdate" frontend/src/configurator/` — the assignment
 *     `threeTexture.needsUpdate = true` appears EXCLUSIVELY in this file.
 *     Sibling files (preview/Sphere.tsx, texture/threeTexture.ts,
 *     texture/fabricCanvas.ts, controls/**) MUST NOT assign that flag.
 *   - `grep -rn "fabricCanvas.renderAll" frontend/src/configurator/` —
 *     the namespace-form invocation `fabricCanvas.renderAll()` appears
 *     EXCLUSIVELY in this file. The exported function is called only here.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: see above — this module's primary purpose.
 *   - Rule R2: ZERO `console.*` calls. Errors propagate to the caller
 *     (e.g., `LogoUploader.tsx` renders ST-017 rejection UI on logo
 *     decode failure).
 *   - Rule R3: no Firebase / JWT / auth imports.
 *   - Rule R9: no payment-processor imports.
 *
 * Out of scope:
 *   - Drawing primitives (lives in `./fabricCanvas.ts`).
 *   - Three.js material / shader / mesh management (lives in
 *     `../preview/Sphere.tsx` and `./threeTexture.ts`).
 *   - Render-loop scheduling (R3F's `useFrame` hooks).
 *   - Caller-side debouncing / throttling (e.g., `LogoPositioner.tsx`
 *     drag handler may debounce; this module never does).
 */

import * as fabricCanvas from './fabricCanvas';
import { threeTexture } from './threeTexture';
import type { ConfiguratorState } from '../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Internal coordinator
// ---------------------------------------------------------------------------

/**
 * Apply the latest configurator state to the Fabric canvas, commit the
 * Fabric draws to canvas pixels, yield one animation frame, then flag the
 * Three.js CanvasTexture for GPU re-upload.
 *
 * Per Rule R7 / C6, the ordering MUST be:
 *   1. Apply state to Fabric (sync setters + awaited async logo load)
 *   2. fabricCanvas.renderAll()                     ← rasterize Fabric scene
 *   3. await one rAF tick                            ← canvas-pixel flush barrier
 *   4. threeTexture.needsUpdate = true               ← schedule GPU re-upload
 *
 * Reversing steps 3 and 4 (or omitting the rAF barrier) produces a
 * one-frame stale texture that breaks Playwright visual baselines (ST-046),
 * particularly under WebKit where the canvas backing-store flush timing
 * differs from Chromium.
 *
 * Defined as a standalone function (rather than inline on the namespace
 * object) so that `texturePipeline.update.name === 'update'` for stack
 * traces and so the function is hoistable above its `texturePipeline`
 * export below.
 *
 * @param state The Zustand store snapshot — typically read via
 *   `useConfiguratorStore.getState()`. Any object satisfying the
 *   `ConfiguratorState` shape is accepted; the coordinator reads only
 *   the color, pattern, finish, and logo slices.
 * @returns A Promise resolving AFTER `threeTexture.needsUpdate = true`
 *   is set. Callers may `await` this for ST-009 / ST-015 latency-budget
 *   tests but the GPU upload itself happens on the next WebGL render
 *   tick (outside this pipeline's responsibility).
 */
async function update(state: ConfiguratorState): Promise<void> {
  // STEP 1 — Apply state to the Fabric scene tree.
  //
  // The setters mutate Fabric scene state imperatively; they do NOT
  // commit pixels to the canvas (that is exclusively `renderAll()`'s
  // job). Synchronous setters run first; the async logo loader is
  // `await`ed so the canvas has all objects in their final state when
  // `renderAll()` runs in step 2.
  //
  // Refine PR Directive 5 — call order: `setStitchingPattern()` MUST
  // run BEFORE `setPanelColors()`. The pattern setter rebuilds the
  // `_panelFills` group's geometry against the colour cache; the
  // colour setter then walks the freshly built geometry and mutates
  // every fill object's `fill` property by its `data-role` tag.
  // Reversing the order would leave the previous pattern's geometry
  // in place when the user changes pattern AND colour in the same
  // render commit (which can happen via `loadDesign()` or
  // `resetToDefaults()` in the Zustand store).
  fabricCanvas.setStitchingPattern(state.stitchingPattern);
  fabricCanvas.setPanelColors(state.primaryColor, state.secondaryColor, state.accentColor);
  fabricCanvas.setMaterialFinish(state.materialFinish);
  await fabricCanvas.setLogo(
    state.logoFile,
    state.logoPosition.x,
    state.logoPosition.y,
    state.logoScale,
  );

  // STEP 2 — Commit Fabric draws to canvas pixels.
  //
  // Fabric 6.x's `renderAll()` is synchronous (returns void); it walks
  // the object tree and rasterizes every object via the underlying
  // 2D context. After this returns the canvas pixels are written, but
  // the browser may not have flushed them to the GPU-readable surface
  // that Three.js will sample on its next draw call.
  fabricCanvas.renderAll();

  // STEP 3 — rAF barrier (canvas-pixel flush).
  //
  // Yielding one animation frame gives the browser an opportunity to
  // commit the canvas writes from step 2 to the underlying surface
  // that Three.js's WebGLRenderer will read. Without this barrier, on
  // WebKit (Safari) and some Chromium variants under load, the GPU
  // upload at step 4 can read STALE canvas pixels — producing the
  // one-frame flicker that ST-046's `toHaveScreenshot()` baselines
  // catch as a visual diff. This barrier is the documented separator
  // between Fabric pixel commit and Three texture flag mutation.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

  // STEP 4 — Mark the Three.js CanvasTexture dirty.
  //
  // (CRITICAL — Rule R7 / C6) This is THE single assignment to
  // `threeTexture.needsUpdate` in the entire `frontend/src/configurator/`
  // subtree. Three.js's renderer reads this flag on its next
  // `WebGLRenderer.render()` call; when `true`, it re-uploads the
  // canvas pixels to the GPU texture. Setting this BEFORE the canvas
  // pixels are flushed (i.e., reversing steps 3 and 4) causes Three
  // to upload the stale prior bitmap.
  threeTexture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Public API — single namespace export
// ---------------------------------------------------------------------------

/**
 * The texture-pipeline namespace object.
 *
 * Exported as `texturePipeline` (not as the bare `update` function) so
 * call sites read `texturePipeline.update(state)` — making the R7 / C6
 * ordering invariant trivial to spot in code review and grep audits.
 *
 * The single public entry point for triggering a texture refresh is
 * `texturePipeline.update(state)`. Every caller in
 * `frontend/src/configurator/controls/**` and
 * `frontend/src/features/design-management/**` MUST go through this
 * function; any direct `threeTexture.needsUpdate = ...` assignment
 * outside this file violates Rule R7 / C6 and MUST be rejected during
 * code review.
 *
 * The `as const` assertion freezes the namespace at the type level
 * (`update` becomes a readonly property whose value is precisely the
 * `update` function declared above) and prevents accidental runtime
 * re-assignment in consumer code.
 */
export const texturePipeline = {
  update,
} as const;
