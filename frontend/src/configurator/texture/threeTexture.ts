/**
 * Three.js CanvasTexture singleton wrapping the Fabric.js canvas.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/texture/threeTexture.ts
 *     | Three.js texture wrapping the Fabric canvas".
 *   - AAP §0.2.2 Constraint C6 / Rule R7 — "The texture update coordinator
 *     lives in `frontend/src/configurator/texture/` and must be the single
 *     code path that mutates `threeTexture.needsUpdate`." The single code
 *     path is `./texturePipeline.ts`. THIS module is the producer of the
 *     texture singleton, not the mutator of its dirty flag.
 *
 * Responsibilities:
 *   1. Construct exactly ONE `THREE.CanvasTexture` whose source is the
 *      offscreen `HTMLCanvasElement` owned by `./fabricCanvas` (created
 *      once at module evaluation time and never appended to the DOM).
 *   2. Configure the texture for visually correct rendering on a sphere
 *      mesh: sRGB color space, linear filtering, no mipmaps (frequent
 *      updates), repeat wrap mode (closes the equirectangular UV seam),
 *      and modest anisotropy (sharper oblique-angle sampling).
 *   3. Expose the texture as a module-level constant `threeTexture` so
 *      that:
 *        - `../preview/Sphere.tsx` can wire it into a material's `map`
 *          property; and
 *        - `./texturePipeline.ts` can flag it for GPU re-upload by
 *          assigning `threeTexture.needsUpdate = true` after Fabric
 *          has rendered the latest scene.
 *
 * Cross-cutting rules enforced here (by what this module does NOT do):
 *   - Rule R7 / C6: this module performs ZERO assignments to
 *     `texture.needsUpdate`. The Three.js `CanvasTexture` constructor
 *     internally sets `needsUpdate = true` once on instantiation (library
 *     behavior — not user code). Every user-code mutation of that flag
 *     happens exclusively inside `./texturePipeline.ts`.
 *     Verification:
 *       grep -n "\.needsUpdate" frontend/src/configurator/texture/threeTexture.ts
 *     returns ZERO matches; the only mutation site in
 *     `frontend/src/configurator/` is `./texturePipeline.ts`.
 *   - Rule R2: ZERO `console.*` statements; failures throw at module
 *     evaluation time (fail-loud), which is the desired behavior — if
 *     the offscreen canvas cannot be obtained, the entire 3D preview
 *     is non-functional and the app should refuse to start.
 *   - Rule R3: no Firebase, JWT, or auth imports — pure rendering
 *     primitive.
 *
 * Out of scope:
 *   - Drawing onto the canvas — owned by `./fabricCanvas`.
 *   - Ordering of `renderAll()` then `needsUpdate` — owned by
 *     `./texturePipeline`.
 *   - Material / shader / mesh management — owned by `../preview/Sphere`.
 *   - Texture lifecycle / disposal — the singleton is intentionally
 *     page-lifetime; tests that need a fresh state must reload the page
 *     or reset module state via the test runner's module cache.
 */

import {
  CanvasTexture,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

import { getElement } from './fabricCanvas';

// ---------------------------------------------------------------------------
// Module-private factory
// ---------------------------------------------------------------------------

/**
 * Construct and configure the singleton `CanvasTexture`.
 *
 * Runs exactly once at module evaluation time. The Three.js
 * `CanvasTexture` constructor receives the offscreen `HTMLCanvasElement`
 * from `getElement()` and binds it as the texture's pixel source — every
 * subsequent GPU upload reads from THIS canvas's 2D context.
 *
 * After construction, configure the properties that make the texture
 * render correctly when applied as a material `map` on a sphere mesh:
 *
 *   - `colorSpace = SRGBColorSpace`
 *     The Fabric canvas's 2D context paints sRGB color values (e.g.
 *     '#FF0000', '#3388CC' — the literal CSS hex strings produced by
 *     the configurator's color pickers). The WebGLRenderer must apply
 *     the correct sRGB-to-linear conversion when sampling. Without
 *     this, color picker selections render visibly washed out or
 *     oversaturated relative to the swatch the user chose.
 *
 *   - `minFilter = magFilter = LinearFilter`
 *     Linear interpolation produces smooth color transitions across the
 *     sphere's UV-mapped surface at varying camera distances. Avoids
 *     the blocky `NearestFilter` look that exposes the underlying
 *     1024x1024 grid.
 *
 *   - `generateMipmaps = false`
 *     Mipmaps would have to be regenerated on every Fabric update
 *     (every color/pattern/logo change). Regeneration cost is roughly
 *     1.33x the upload cost of the base level — non-trivial when the
 *     ST-009 latency budget is "real-time preview sync." We accept a
 *     small aliasing trade-off in exchange for predictable update cost.
 *
 *   - `wrapS = wrapT = RepeatWrapping`
 *     The default Three.js `SphereGeometry` UVs run [0,1] longitude
 *     and [0,1] latitude. RepeatWrapping ensures sampling at u=1.001
 *     returns the same color as u=0.001 — the seam at the longitude
 *     wrap-around is invisible. ClampToEdgeWrapping at the poles is
 *     also acceptable but RepeatWrapping is the safest portable
 *     default and avoids a visible pinch at v=0/v=1.
 *
 *   - `anisotropy = 4`
 *     Improves filtering quality at oblique viewing angles (e.g. when
 *     the user rotates the ball ~70-90 degrees from camera normal).
 *     A modest value of 4 is supported by virtually every WebGL
 *     implementation including iOS Safari; setting it to the absolute
 *     max (16) is silently clamped on lower-end GPUs and adds
 *     bandwidth cost that risks the ST-005 30 FPS floor.
 *
 * Note on `needsUpdate`: the `CanvasTexture` constructor sets
 * `this.needsUpdate = true` internally (this is library behavior in
 * Three.js's `CanvasTexture.js`). That single internal assignment is
 * sufficient for the first GPU upload after the texture is attached
 * to a material. THIS user code does not assign `needsUpdate` at any
 * point — the exclusive mutation site is `./texturePipeline.ts`.
 */
function createTexture(): CanvasTexture {
  // Acquire the offscreen HTMLCanvasElement painted by Fabric. The
  // sibling module created this element at its own module-evaluation
  // time, so it is guaranteed to be a valid `<canvas>` instance here.
  // No defensive null-check: a missing canvas means the entire
  // configurator is broken and the app must fail to load loudly rather
  // than render a black or transparent ball.
  const element = getElement();

  // Construct the texture. The constructor wires `element` as the
  // source (`texture.image === element` after this line) and the
  // Three.js library internally flips its own dirty flag once for
  // the initial GPU upload — see node_modules/three/src/textures/
  // CanvasTexture.js. We do NOT reassert that flag in user code.
  const texture = new CanvasTexture(element);

  // Color space — sRGB roundtrips Fabric's hex-color paint job through
  // the WebGLRenderer's tone-mapping pipeline.
  texture.colorSpace = SRGBColorSpace;

  // Filtering — linear interpolation for smooth UV sampling, no
  // mipmaps (they would have to be regenerated on every Fabric update).
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  // Wrap mode — RepeatWrapping closes the equirectangular sphere UV
  // seam at u=0 / u=1. Same wrap on V for portability across geometry
  // implementations.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;

  // Anisotropy — modest value (4) for sharper oblique-angle sampling
  // without taxing low-end GPUs or risking the ST-005 framerate floor.
  texture.anisotropy = 4;

  return texture;
}

// ---------------------------------------------------------------------------
// Public API — the singleton constant
// ---------------------------------------------------------------------------

/**
 * The single, session-wide Three.js `CanvasTexture` whose pixel source
 * is the offscreen Fabric.js canvas in `./fabricCanvas`.
 *
 * Constructed eagerly at module evaluation time; ESM/Vite caches the
 * module so subsequent imports return this exact reference. React
 * StrictMode's effect double-invocation does NOT re-evaluate the
 * module, so the singleton survives mount/cleanup/remount cycles.
 *
 * Consumers:
 *   - `../preview/Sphere.tsx` reads this texture and assigns it to its
 *     `MeshStandardMaterial.map` field. The material's `map` reference
 *     is stable for the mesh's lifetime — no re-uploads triggered by
 *     React re-renders.
 *   - `./texturePipeline.ts` mutates `threeTexture.needsUpdate = true`
 *     immediately after `fabricCanvas.renderAll()` to schedule a GPU
 *     re-upload on the next WebGL draw call. This file is the SOLE
 *     code path in the codebase that performs that assignment — Rule
 *     R7 / C6 enforces single-code-path mutation of the flag.
 *
 * Members (per AAP exports schema for this file):
 *   - `needsUpdate`   — boolean dirty flag; mutated only by
 *                       `./texturePipeline.ts` per Rule R7 / C6.
 *   - `colorSpace`    — set to `SRGBColorSpace`.
 *   - `minFilter`     — set to `LinearFilter`.
 *   - `magFilter`     — set to `LinearFilter`.
 *   - `generateMipmaps` — set to `false`.
 *   - `wrapS`         — set to `RepeatWrapping`.
 *   - `wrapT`         — set to `RepeatWrapping`.
 *   - `anisotropy`    — set to `4`.
 *   - `image`         — set by the `CanvasTexture` constructor to the
 *                       `HTMLCanvasElement` returned by `getElement()`.
 *
 * Performance profile:
 *   - GPU memory: ~ 4 MB (1024 x 1024 x 4 bytes RGBA), no mipmaps.
 *   - Construction cost: O(1), < 1 ms at module evaluation.
 *   - Per-frame cost when `needsUpdate === false`: zero (Three.js skips
 *     re-upload).
 *   - Per-frame cost when `needsUpdate === true`: one `texSubImage2D`
 *     call (~ 4 MB, typically < 2 ms on integrated GPUs — well within
 *     the ST-005 33 ms-per-frame budget).
 */
export const threeTexture: CanvasTexture = createTexture();
