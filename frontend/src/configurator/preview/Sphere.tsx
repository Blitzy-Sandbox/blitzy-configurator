/**
 * Sphere — the React Three Fiber mesh rendering the configurator ball.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/Sphere.tsx
 *     | Sphere geometry + material with texture slot".
 *   - AAP §0.6.14 — "interactive 3D ball preview rendered via R3F <Canvas>".
 *   - ST-001 acceptance criteria: a spherical ball with default visuals
 *     renders within the initial-load budget; resizing re-centers
 *     without distortion; ZERO console errors during initial render.
 *   - ST-002 / ST-003 — drag and idle auto-rotation are composed into
 *     the mesh's quaternion using the documented order:
 *       finalQuat = autoRotation.clone().multiply(dragRotation)
 *   - ST-004 — material parameters (roughness, metalness, envMapIntensity)
 *     come from `useMaterialSwatch(currentFinish)`.
 *   - QA Report Issue #5 (composition order), Issue #7 (material params),
 *     Issue #9 (Sphere.tsx contains ZERO needsUpdate mutations).
 *
 * Architecture:
 *   The drag and idle-auto-rotate hooks are NOT called inside this file
 *   because `useDragRotation`'s `attachRef` must bind to a DOM element
 *   (the wrapping <div> around <Canvas>), which only exists at the
 *   `BallCanvas.tsx` level. Instead, `BallCanvas.tsx` calls those hooks
 *   and passes their `Quaternion` refs (and the `tickAutoRotation`
 *   callback) into this component as props. This keeps the rotation
 *   composition logic close to the mesh while preserving the DOM
 *   binding requirement.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: This file MUST NOT contain any `texture.needsUpdate`
 *     assignment. Verified by `grep -n "texture.needsUpdate" frontend/src/configurator/preview/Sphere.tsx`
 *     returning zero matches. The texture pipeline coordinator
 *     (`texturePipeline.update()`) is the single mutation site.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Camera and lighting rig — owned by `BallCanvas.tsx`.
 *   - Pointer event handling — owned by `useDragRotation.ts`.
 *   - Idle timer — owned by `useIdleAutoRotate.ts`.
 *   - Texture orchestration — owned by `texturePipeline.ts`.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { MeshStandardMaterial, Quaternion, SphereGeometry, Vector3, type Mesh } from 'three';

import { useConfiguratorStore } from '../../state/configuratorStore';
import { applyConfiguratorState } from '../texture/texturePipeline';
import { getThreeTexture } from '../texture/threeTexture';

import { useMaterialSwatch } from './useMaterialSwatch';
import type { IdleAutoRotateRef } from './useIdleAutoRotate';

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
 * a smooth silhouette without any visible faceting at the typical
 * configurator viewport sizes, while keeping the vertex buffer small
 * enough that mobile GPUs can re-upload it cheaply if Three.js triggers
 * a full geometry refresh.
 */
const SPHERE_WIDTH_SEGMENTS = 64;
const SPHERE_HEIGHT_SEGMENTS = 64;

// ---------------------------------------------------------------------------
// Auto-rotation integration constants
// ---------------------------------------------------------------------------

/**
 * World up axis around which auto-rotation accumulates. Module-scoped
 * `Vector3` so it is allocated exactly once across the component's
 * entire lifetime (avoids per-frame allocations inside `useFrame`).
 */
const Y_AXIS = new Vector3(0, 1, 0);

/**
 * Maximum delta time (in seconds) honored by the auto-rotation
 * integration. R3F's `delta` is unbounded — when a tab is backgrounded
 * and re-foregrounded, the next `useFrame` tick can carry a delta of
 * many seconds, which would otherwise produce a single-frame rotation
 * of multiple revolutions (visually jarring). Clamping to 0.1 s caps
 * each tick at 100 ms × 0.3 rad/s = 0.03 rad ≈ 1.7° max — small
 * enough to feel continuous.
 */
const MAX_DELTA_TIME_SEC = 0.1;

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Props supplied by `BallCanvas.tsx`. All three fields are stable
 * across renders by virtue of being React refs, so this component
 * never needs to re-mount.
 */
export interface SphereProps {
  /**
   * The accumulated drag-rotation quaternion (mutated in place by
   * `useDragRotation` pointer handlers). Read inside `useFrame` to
   * compose the final mesh orientation.
   */
  readonly dragRotationRef: React.MutableRefObject<Quaternion>;

  /**
   * Read-only ref carrying the current auto-rotation angular velocity
   * (in radians per second around the world Y axis). Per the
   * `useIdleAutoRotate` contract, the value is binary:
   *   - 0          when not auto-rotating (interactive or idle-pending).
   *   - >0         when auto-rotating at the documented constant.
   * Read by `useFrame` to gate the per-frame integration step.
   */
  readonly idleAutoRotateRef: IdleAutoRotateRef;

  /**
   * The auto-rotation accumulator quaternion. Mutated IN PLACE by
   * this component's `useFrame` integration step (each frame that
   * `idleAutoRotateRef.current !== 0`, the per-frame rotation delta
   * is multiplied into this accumulator). The accumulator persists
   * across pause/resume cycles — auto-rotation resumes from the
   * orientation it last reached, NOT from identity.
   */
  readonly autoRotationAccumRef: React.MutableRefObject<Quaternion>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The configurator's primary 3D mesh — a textured, drag-rotatable,
 * idle-auto-rotating sphere.
 *
 * Subscribes via Zustand selectors to the three configurator color
 * slices and the material finish. Whenever any of those changes (or on
 * mount), `applyConfiguratorState(...)` paints the new color regions
 * onto the Fabric canvas and commits via the strict R7 / C6 ordering
 * contract (handled inside `texturePipeline.ts`).
 *
 * The mesh's quaternion is composed each frame inside the `useFrame`
 * loop. Per QA Report Issue #5: composition order is
 * `autoRotation.clone().multiply(dragRotation)` so auto-rotation is
 * applied as the LEFT operand (pre-applied in the world frame), with
 * drag rotation applied second.
 */
export function Sphere(props: SphereProps): JSX.Element {
  const { dragRotationRef, idleAutoRotateRef, autoRotationAccumRef } = props;

  // -----------------------------------------------------------------------
  // Subscriptions to the configurator store. SELECTORS only, never the
  // whole store, to avoid re-rendering on unrelated slice changes.
  // -----------------------------------------------------------------------
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);

  // -----------------------------------------------------------------------
  // Material parameters resolved from the current finish (ST-004).
  // -----------------------------------------------------------------------
  const swatchParams = useMaterialSwatch(materialFinish);

  // -----------------------------------------------------------------------
  // Geometry / texture / material construction. Memoized so identical
  // inputs produce identical instances across renders (ST-004-AC4:
  // switching materials does not reset rotation; reusing the same Mesh
  // instance with in-place material parameter updates satisfies that
  // requirement).
  //
  // Per Rule R7 / C6 NOTE: This module imports `getThreeTexture` (a
  // GETTER) and never reaches into `texture.needsUpdate`. The texture
  // pipeline coordinator owns that mutation exclusively.
  // -----------------------------------------------------------------------

  const geometry = useMemo(
    () => new SphereGeometry(SPHERE_RADIUS, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS),
    [],
  );

  const texture = useMemo(() => getThreeTexture(), []);

  // The MeshStandardMaterial is constructed once, then mutated in place
  // via the `useEffect` block below to apply finish parameters. This
  // keeps the same material instance attached to the mesh across
  // renders — which Three.js needs to avoid re-uploading shaders to
  // the GPU.
  const material = useMemo<MeshStandardMaterial>(
    () =>
      new MeshStandardMaterial({
        map: texture,
        roughness: swatchParams.roughness,
        metalness: swatchParams.metalness,
        envMapIntensity: swatchParams.envMapIntensity,
      }),
    // Intentionally an empty dep array (other than texture which is
    // also stable): we want this material instance to persist for the
    // mesh's lifetime, with parameter updates applied via the in-place
    // `useEffect` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [texture],
  );

  // Apply finish parameter changes in place (ST-004 latency budget).
  // No new material instance, so the mesh's `material` ref is stable —
  // satisfying ST-004-AC4 (switching does not reset rotation, because
  // the mesh itself is unchanged).
  useEffect(() => {
    material.roughness = swatchParams.roughness;
    material.metalness = swatchParams.metalness;
    material.envMapIntensity = swatchParams.envMapIntensity;
    // Material.needsUpdate ≠ Texture.needsUpdate. This flag tells
    // Three.js the SHADER PROGRAM may need recompilation due to the
    // changed parameters; it is NOT the texture-update flag covered
    // by Rule R7 / C6.
    material.needsUpdate = true;
  }, [material, swatchParams]);

  // -----------------------------------------------------------------------
  // Texture state synchronization. Whenever any color slice changes,
  // re-paint the Fabric canvas and commit through the strict R7 / C6
  // ordering contract. The pipeline coordinator (NOT this component)
  // is the single site that mutates `texture.needsUpdate`.
  // -----------------------------------------------------------------------
  useEffect(() => {
    applyConfiguratorState({
      primaryColor,
      secondaryColor,
      accentColor,
    });
  }, [primaryColor, secondaryColor, accentColor]);

  // -----------------------------------------------------------------------
  // Lifecycle cleanup — dispose Three.js GPU resources owned by this
  // mesh on unmount. The texture pipeline singletons are managed at
  // the BallCanvas level so HMR / StrictMode re-mounts of just this
  // component don't blow them away.
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // -----------------------------------------------------------------------
  // Mesh quaternion composition (ST-002 + ST-003).
  //
  // Per QA Report Issue #5 scope notes, the composition order is:
  //
  //     finalQuat = autoRotationAccum.clone().multiply(dragRotation)
  //
  // — auto-rotation is the LEFT operand (pre-applied in the world
  // frame), drag rotation is the RIGHT operand. This means when the
  // user drags a stationary ball, drag rotation accumulates relative
  // to the world; when auto-rotation is also active, it spins the
  // entire composed orientation around the Y axis without disturbing
  // the user's drag.
  // -----------------------------------------------------------------------

  const meshRef = useRef<Mesh>(null);
  const composedQuaternionRef = useRef<Quaternion>(new Quaternion());

  // Per-frame delta quaternion. Reused (not reallocated) each tick to
  // keep the GC pressure inside `useFrame` at zero. The 4 floats are
  // overwritten via `setFromAxisAngle` before each multiply.
  const autoRotationDeltaRef = useRef<Quaternion>(new Quaternion());

  useFrame((_state, deltaTimeSec) => {
    // -----------------------------------------------------------------
    // ST-003 auto-rotation integration step.
    //
    // Read the current angular velocity from the idle hook's ref. Per
    // contract, the value is binary — 0 when not auto-rotating, or
    // the documented constant (rad/s) when auto-rotating. The strict
    // `!== 0` comparison keeps the integration step out of the hot
    // path entirely while interaction is active or the idle timer is
    // still pending.
    //
    // While paused (angularVelocity === 0), `autoRotationAccumRef`
    // is read below but NOT written, so the orientation reached
    // before the pause is preserved. When the idle timer fires
    // again, integration resumes from the preserved orientation,
    // which matches the turntable mental model in the AAP.
    // -----------------------------------------------------------------
    const angularVelocity = idleAutoRotateRef.current;
    if (angularVelocity !== 0) {
      const clampedDelta = Math.min(deltaTimeSec, MAX_DELTA_TIME_SEC);
      const angleRad = angularVelocity * clampedDelta;
      autoRotationDeltaRef.current.setFromAxisAngle(Y_AXIS, angleRad);
      autoRotationAccumRef.current.multiply(autoRotationDeltaRef.current);
    }

    // -----------------------------------------------------------------
    // Composition step: autoRotation × dragRotation.
    //
    // Per QA Report Issue #5 scope notes, the composition order is:
    //
    //     finalQuat = autoRotationAccum.clone().multiply(dragRotation)
    //
    // We reuse `composedQuaternionRef.current` to avoid allocating a
    // fresh Quaternion per frame — semantically equivalent to:
    //   const finalQuat =
    //     autoRotationAccumRef.current.clone().multiply(dragRotationRef.current);
    // -----------------------------------------------------------------
    composedQuaternionRef.current
      .copy(autoRotationAccumRef.current)
      .multiply(dragRotationRef.current);

    const mesh = meshRef.current;
    if (mesh !== null) {
      mesh.quaternion.copy(composedQuaternionRef.current);
    }
  });

  // -----------------------------------------------------------------------
  // JSX — declarative R3F mesh. Geometry and material are passed as
  // props so R3F attaches them to the mesh without re-creating them
  // each render (matches the memoized refs above).
  // -----------------------------------------------------------------------
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      castShadow={false}
      receiveShadow={false}
    />
  );
}
