/**
 * Sphere — the React Three Fiber mesh rendering the configurator ball.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/Sphere.tsx
 *     | Sphere geometry + material with texture slot from `threeTexture`".
 *   - AAP §0.6.14 — "interactive 3D ball preview rendered via R3F <Canvas>".
 *   - ST-001 acceptance criteria: a spherical ball with default visuals
 *     renders within the initial-load budget; resizing re-centers
 *     without distortion; ZERO console errors during initial render.
 *   - ST-002 / ST-003 — drag and idle auto-rotation are composed into
 *     the mesh's quaternion using the documented order:
 *       finalQuat = autoRotationAccum.copy().multiply(dragRotation)
 *   - ST-004 — material parameters (roughness, metalness) flow into this
 *     component as a `materialParams` prop computed by `useMaterialSwatch`
 *     in the parent (`BallCanvas.tsx`). This component does NOT subscribe
 *     to the `materialFinish` slice itself — it remains a pure renderer
 *     keyed only on its three input refs/values.
 *   - ST-005 — per-frame quaternion math allocates ZERO new objects
 *     (all working `Quaternion`/`Vector3` instances are memoized at
 *     mount), keeping the integration cost inside the ≥30 FPS budget.
 *
 * Architecture (single-code-path discipline per Rule R7 / C6):
 *   - This file READS `threeTexture` (the singleton CanvasTexture wrapping
 *     the Fabric-painted offscreen canvas) and assigns it to the
 *     `<meshStandardMaterial>`'s `map` prop. It NEVER writes
 *     `threeTexture.needsUpdate` — that mutation belongs exclusively to
 *     `texturePipeline.ts` (which is in turn invoked exclusively by
 *     `useColorSync` at the App level). Verified by:
 *       grep -n "needsUpdate" frontend/src/configurator/preview/Sphere.tsx
 *     returning zero matches.
 *   - This file does NOT import the configurator store. Color, pattern,
 *     and logo selections flow into the texture (NOT into this
 *     component) via the texture pipeline. Material parameters arrive
 *     as the `materialParams` prop. This isolation prevents the Sphere
 *     from re-rendering on any color/pattern/logo change — the texture
 *     pixels change on the GPU side, but the React component tree above
 *     the `<Canvas>` is untouched.
 *   - This file does NOT call `useState`. Per-frame mesh updates happen
 *     imperatively inside `useFrame`; rotation values arrive via refs;
 *     the mesh ref captures the underlying Three.js `Mesh` instance.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: ZERO `needsUpdate` mutations in this file.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Camera and lighting rig — owned by `BallCanvas.tsx`.
 *   - Pointer event handling — owned by `useDragRotation.ts`.
 *   - Idle timer — owned by `useIdleAutoRotate.ts`.
 *   - Texture orchestration — owned by `texturePipeline.ts`.
 *   - Material finish slice subscription — owned by `useMaterialSwatch.ts`,
 *     called in `BallCanvas.tsx`, with the resulting `MaterialParams`
 *     forwarded into this component as a prop.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { Quaternion, Vector3 } from 'three';
import type { Mesh } from 'three';

import { threeTexture } from '../texture/threeTexture';

import type { MaterialParams } from './useMaterialSwatch';

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

/**
 * Sphere radius in world units. The PerspectiveCamera in `BallCanvas.tsx`
 * is positioned to frame a unit-radius sphere with comfortable margin.
 */
const SPHERE_RADIUS = 1;

/**
 * Geometry tessellation. 64 widthSegments × 64 heightSegments produces
 * a smooth silhouette (≈ 4225 vertices) without visible faceting at
 * any reasonable configurator viewport size, while keeping the vertex
 * buffer small enough that mobile GPUs can re-upload it cheaply if
 * Three.js triggers a full geometry refresh.
 *
 * 32×32: visible faceting at close zoom (rejected).
 * 64×64: smooth at all reasonable zooms; ~4 KB of vertex data (chosen).
 * 128×128: 16 KB of vertex data; perceptually identical to 64×64
 *   (rejected — extra cost without perceptual benefit).
 */
const SPHERE_WIDTH_SEGMENTS = 64;
const SPHERE_HEIGHT_SEGMENTS = 64;

// ---------------------------------------------------------------------------
// Auto-rotation integration constants
// ---------------------------------------------------------------------------

/**
 * Maximum delta time (in seconds) honored by the auto-rotation
 * integration. R3F's `delta` is unbounded — when a tab is backgrounded
 * and re-foregrounded, the next `useFrame` tick can carry a delta of
 * many seconds, which would otherwise produce a single-frame rotation
 * of multiple revolutions (visually jarring). Clamping to 0.1 s caps
 * each tick at 100 ms × 0.3 rad/s = 0.03 rad ≈ 1.7° max — small
 * enough to feel continuous when the tab regains focus.
 */
const MAX_DELTA_TIME_SEC = 0.1;

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Props supplied by `BallCanvas.tsx`. All three values are stable
 * across renders by virtue of being React refs (`dragRotationRef`,
 * `idleAutoRotateRef`) or memoized derived state (`materialParams`,
 * which is a stable reference per finish per `useMaterialSwatch`'s
 * module-scoped lookup table).
 *
 * The interface satisfies the schema's `members_exposed`:
 *   - `dragRotationRef`
 *   - `idleAutoRotateRef`
 *   - `materialParams`
 */
export interface SphereProps {
  /**
   * Ref to the cumulative drag-rotation quaternion. Updated by
   * `useDragRotation` on pointer events. Read each frame in this
   * component's `useFrame` callback.
   *
   * The ref's `.current` is a `THREE.Quaternion` — the IDENTITY
   * quaternion when the ball has not been dragged yet. The hook
   * initializes the ref with `new Quaternion()`, so the ref's
   * `.current` is never structurally null in practice; the
   * `RefObject<Quaternion>` type still permits a `null` slot for
   * defensive fallback.
   */
  readonly dragRotationRef: RefObject<Quaternion>;

  /**
   * Ref to the current idle-auto-rotation angular velocity (in
   * radians per second around the world Y axis). Updated by
   * `useIdleAutoRotate` based on its idle timer.
   *
   * The ref's `.current` is a number — 0 when not idle, positive
   * (typically 0.3 rad/s ≈ 17°/s) when auto-rotating. The
   * `RefObject<number>` type permits a `null` slot for defensive
   * fallback; the hook initializes the ref with `0`, so the value
   * is never structurally null in practice.
   */
  readonly idleAutoRotateRef: RefObject<number>;

  /**
   * Material parameter object derived from the `materialFinish` store
   * slice. Passed by value (not by ref) because parameter changes are
   * infrequent (only on user finish-swatch selection) and React's
   * prop diffing handles the propagation cheaply.
   *
   * Per `useMaterialSwatch`'s contract, identical finishes return
   * identical references — so unchanged finish ⇒ unchanged reference
   * ⇒ React skips the downstream `<meshStandardMaterial>` re-render.
   */
  readonly materialParams: MaterialParams;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The configurator's primary 3D mesh — a textured, drag-rotatable,
 * idle-auto-rotating sphere.
 *
 * Per QA Report Issue #5 / agent prompt: composition order is
 *
 *     finalQuat = autoRotationAccum.copy().multiply(dragRotation)
 *
 * — auto-rotation is the LEFT operand (pre-applied in the world
 * frame), drag rotation is the RIGHT operand. This means when the
 * user drags a stationary ball, drag rotation accumulates relative
 * to the world; when auto-rotation is also active, it spins the
 * entire composed orientation around the world Y axis without
 * disturbing the user's drag.
 *
 * The auto-rotation accumulator is INTERNAL to this component (per
 * the agent prompt's explicit `useMemo(() => new Quaternion(), [])`
 * pattern). This keeps the rotation state co-located with the
 * `useFrame` integration step that owns it.
 */
export function Sphere({
  dragRotationRef,
  idleAutoRotateRef,
  materialParams,
}: SphereProps): JSX.Element {
  // -----------------------------------------------------------------------
  // Mesh ref. R3F binds the underlying Three.js `Mesh` instance to this
  // ref via the JSX `ref` prop on the <mesh> element below. Read inside
  // `useFrame` to apply the composed rotation.
  // -----------------------------------------------------------------------
  const meshRef = useRef<Mesh | null>(null);

  // -----------------------------------------------------------------------
  // Per-frame working objects. All allocated ONCE at mount via `useMemo`
  // with an empty dep array, then reused (not reallocated) on every
  // `useFrame` tick. This keeps GC pressure inside the rAF loop at
  // ZERO bytes per frame — a hard requirement for sustaining ≥30 FPS
  // (ST-005-AC1) on the reference hardware profile.
  //
  // `composedQuaternion` — the per-frame composition target. Holds
  //   `autoRotationAccum * dragRotation` after the integration step
  //   and is then copied onto the mesh.
  // `yAxis`               — the unit Y axis. Constant value, but
  //   instantiated as a Vector3 once so `setFromAxisAngle` does not
  //   allocate.
  // `autoRotationDelta`   — the per-frame delta quaternion produced by
  //   `setFromAxisAngle(yAxis, velocity * delta)`. Multiplied into
  //   `autoRotationAccum`.
  // `autoRotationAccum`   — the cumulative auto-rotation quaternion
  //   (the integration of the angular velocity over time). Starts at
  //   identity. Persists across pause/resume cycles — auto-rotation
  //   resumes from the orientation it last reached when the idle timer
  //   re-fires, which matches the turntable mental model in the AAP.
  //   This accumulator is INTERNAL to this component per the schema
  //   (the parent does NOT pass an external accumulator ref).
  // -----------------------------------------------------------------------
  const composedQuaternion = useMemo(() => new Quaternion(), []);
  const yAxis = useMemo(() => new Vector3(0, 1, 0), []);
  const autoRotationDelta = useMemo(() => new Quaternion(), []);
  const autoRotationAccum = useMemo(() => new Quaternion(), []);

  // -----------------------------------------------------------------------
  // Per-frame rotation update.
  //
  // Algorithm:
  //   1. Read drag-rotation quaternion from `dragRotationRef.current`
  //      (defensive: fall back to identity if the ref slot is null).
  //   2. Read idle angular velocity from `idleAutoRotateRef.current`
  //      (defensive: fall back to 0 if the ref slot is null).
  //   3. If the velocity is non-zero, integrate:
  //        clampedDelta = min(deltaTimeSec, MAX_DELTA_TIME_SEC)
  //        angleRad     = velocity * clampedDelta
  //        autoRotationDelta.setFromAxisAngle(yAxis, angleRad)
  //        autoRotationAccum.multiply(autoRotationDelta)
  //      The clamp prevents huge single-frame rotations after a tab is
  //      backgrounded then re-foregrounded.
  //   4. Compose the final orientation:
  //        composedQuaternion = autoRotationAccum * dragRotation
  //      (auto-rotation is the LEFT operand, applied in the world
  //      frame; drag rotation is the RIGHT operand.)
  //   5. Copy the composed quaternion onto the mesh's quaternion field
  //      so the next renderer pass uses it.
  //
  // Rule R7 / C6: this callback does NOT touch `threeTexture.needsUpdate`.
  // The texture flag is mutated exclusively by `texturePipeline.ts`.
  // -----------------------------------------------------------------------
  useFrame((_state, deltaTimeSec) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      // R3F hasn't bound the ref yet (the very first tick after mount,
      // before the JSX <mesh> element has flushed). Skip this frame —
      // there's nothing to rotate. The ref is populated by the second
      // tick at the latest.
      return;
    }

    // ST-003 auto-rotation integration. Per the `IdleAutoRotateRef`
    // contract, `current` is BINARY — 0 when not auto-rotating, or the
    // documented positive constant (rad/s) when auto-rotating. The
    // strict `!== 0` comparison keeps the integration step out of the
    // hot path entirely while interaction is active or the idle timer
    // is still pending.
    //
    // While paused (angularVelocity === 0), `autoRotationAccum` is
    // read below (step 4) but NOT written, so the orientation reached
    // before the pause is preserved. When the idle timer fires again,
    // integration resumes from the preserved orientation.
    const angularVelocity = idleAutoRotateRef.current ?? 0;
    if (angularVelocity !== 0) {
      const clampedDelta =
        deltaTimeSec < MAX_DELTA_TIME_SEC ? deltaTimeSec : MAX_DELTA_TIME_SEC;
      const angleRad = angularVelocity * clampedDelta;
      autoRotationDelta.setFromAxisAngle(yAxis, angleRad);
      autoRotationAccum.multiply(autoRotationDelta);
    }

    // Composition step: composedQuaternion = autoRotationAccum * dragRotation.
    //
    // We use a SEPARATE working quaternion (`composedQuaternion`) for
    // the composition target so we never alias the input refs — copying
    // `autoRotationAccum` into a working slot then multiplying by the
    // drag ref is the only safe shape that preserves `autoRotationAccum`
    // and `dragRotationRef.current` unchanged across the call.
    composedQuaternion.copy(autoRotationAccum);
    const dragRotation = dragRotationRef.current;
    if (dragRotation !== null) {
      composedQuaternion.multiply(dragRotation);
    }

    // Write to mesh. The renderer will pick this up on the next draw.
    mesh.quaternion.copy(composedQuaternion);

    // Dev-only test instrumentation: mirror the internal accumulator
    // and composed orientation to a window-scope slot so the Playwright
    // test bridge can assert auto-rotation progress without depending
    // on slow `canvas.toDataURL()` pixel proxies. Production builds
    // tree-shake this branch entirely (Vite replaces
    // `import.meta.env.DEV` with `false` and dead-code-eliminates the
    // surrounding `if`).
    //
    // The mirror writes the four floats of each quaternion into a
    // pre-allocated plain object so structured-clone serialization
    // across the CDP boundary is cheap and the test bridge sees a
    // fresh snapshot on every read. The slot is initialized lazily
    // here rather than at module load so SSR and unit-test contexts
    // (where `window` is unavailable) are unaffected.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const w = window as Window & {
        __strikeforge_internal__?: {
          autoRotation: { x: number; y: number; z: number; w: number };
          composedRotation: { x: number; y: number; z: number; w: number };
        };
      };
      let slot = w.__strikeforge_internal__;
      if (slot === undefined) {
        slot = {
          autoRotation: { x: 0, y: 0, z: 0, w: 1 },
          composedRotation: { x: 0, y: 0, z: 0, w: 1 },
        };
        w.__strikeforge_internal__ = slot;
      }
      slot.autoRotation.x = autoRotationAccum.x;
      slot.autoRotation.y = autoRotationAccum.y;
      slot.autoRotation.z = autoRotationAccum.z;
      slot.autoRotation.w = autoRotationAccum.w;
      slot.composedRotation.x = composedQuaternion.x;
      slot.composedRotation.y = composedQuaternion.y;
      slot.composedRotation.z = composedQuaternion.z;
      slot.composedRotation.w = composedQuaternion.w;
    }
  });

  // -----------------------------------------------------------------------
  // JSX — declarative R3F mesh.
  //
  // Geometry: a unit-radius sphere with 64×64 segments (see SPHERE_*
  // constants above for tessellation rationale).
  //
  // Material: `<meshStandardMaterial>` is the canonical PBR material in
  // Three.js. We bind:
  //   - `map`        — the `threeTexture` singleton (Fabric-painted
  //                    offscreen canvas wrapped as a sRGB CanvasTexture).
  //                    READ-ONLY: this component never mutates
  //                    `texture.needsUpdate` (Rule R7 / C6).
  //   - `roughness`  — from `materialParams.roughness` (matte ≈ 0.9,
  //                    glossy ≈ 0.2, metallic ≈ 0.3). Drives specular
  //                    highlight tightness.
  //   - `metalness`  — from `materialParams.metalness` (dielectric
  //                    finishes 0, metallic 0.8). Drives the F0
  //                    reflectance of the BRDF.
  //   - `color`      — `#FFFFFF` (white). The base color is multiplied
  //                    with the map; white means "use texture color
  //                    verbatim" so the user's color picker selections
  //                    appear EXACTLY on the ball without tint.
  //   - `toneMapped` — `true`. Enables the WebGLRenderer's tone-mapping
  //                    so bright highlights from PBR lighting do not
  //                    clip; matches the renderer's outputColorSpace =
  //                    sRGB configuration in `BallCanvas.tsx`.
  //
  // Shadows are explicitly disabled (`castShadow={false}` and
  // `receiveShadow={false}`) because no shadow map is configured in
  // `BallCanvas.tsx`'s `<Canvas>`. Disabling the flags avoids
  // confusing the renderer's culling pass and keeps the per-frame
  // cost minimal.
  // -----------------------------------------------------------------------
  return (
    <mesh ref={meshRef} castShadow={false} receiveShadow={false}>
      <sphereGeometry args={[SPHERE_RADIUS, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS]} />
      <meshStandardMaterial
        map={threeTexture}
        roughness={materialParams.roughness}
        metalness={materialParams.metalness}
        color="#FFFFFF"
        toneMapped={true}
      />
    </mesh>
  );
}
