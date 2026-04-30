/**
 * useMaterialSwatch — derive Three.js PBR material parameters from the
 * configurator store's `materialFinish` slice (ST-004, ST-011).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/useMaterialSwatch.ts
 *     | Apply material swatches to preview (ST-004)".
 *   - AAP §0.6.7 "Track 2 — Frontend Core" — three finishes are supported:
 *       matte:    roughness 0.9, metalness 0.0  (high diffuse, no metal)
 *       glossy:   roughness 0.2, metalness 0.0  (low diffuse, no metal)
 *       metallic: roughness 0.3, metalness 0.8  (specular metal)
 *
 * Story coverage:
 *   ST-004-AC1  Selecting a swatch updates the preview within the
 *               documented latency budget. Implementation: a Zustand
 *               selector subscription to the `materialFinish` slice
 *               feeds a memoized lookup into the module-scoped
 *               MATERIAL_PARAMS_BY_FINISH table; the result flows
 *               synchronously through one React render cycle to the
 *               downstream <meshStandardMaterial>.
 *   ST-004-AC2  The previously applied material is replaced (not
 *               accumulated). Each finish corresponds to a single
 *               MaterialParams object — switching finishes returns a
 *               different reference, prompting React to re-render the
 *               material with the NEW values; the old values are
 *               replaced wholesale, never combined.
 *   ST-004-AC4  Switching materials does NOT reset rotation or any
 *               unrelated selections (color, pattern, logo). This hook
 *               READS only `materialFinish` and WRITES nothing back to
 *               the store, so other slices and the rotation refs in
 *               useDragRotation/useIdleAutoRotate are untouched.
 *   ST-011-AC2  Selecting a finish applies it to the preview within
 *               the latency budget. Same single-render-cycle path as
 *               ST-004-AC1.
 *   ST-011-AC4  Each of the three finishes visibly changes how light
 *               interacts with the surface. The roughness/metalness
 *               pairs are chosen to be perceptually distinct under
 *               standard scene lighting:
 *                 - matte:    near-Lambertian diffuse, no specular
 *                 - glossy:   tight specular highlight, dielectric
 *                 - metallic: rough metal with color-tinted specular
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: This hook is a pure derived-state helper and does
 *     NOT touch any texture's `needsUpdate` flag. The texture pipeline
 *     coordinator owns that mutation exclusively.
 *   - Rule R2: ZERO `console.*` calls; no credential material involved.
 *   - Rule R3: no auth imports.
 *
 * Architecture notes:
 *   - The MATERIAL_PARAMS_BY_FINISH map is module-scoped (NOT inside the
 *     hook body) so the per-finish parameter objects are allocated ONCE
 *     at module load. Selecting the same finish twice returns the same
 *     reference both times — React prop diffing sees reference equality
 *     and skips the downstream material re-render. Defining the map
 *     inside the hook body would allocate fresh objects on every render
 *     and defeat the latency budget.
 *   - The map type is `Readonly<Record<MaterialFinish, MaterialParams>>`.
 *     The `Record<MaterialFinish, ...>` constraint enforces exhaustive
 *     coverage at compile time: if a fourth finish (e.g. 'satin') is
 *     ever added to the MaterialFinish union, TypeScript errors here
 *     until the mapping is updated. This is a self-healing guarantee
 *     against store enum drift.
 *   - `useMemo` documents the intent ("this is a stable derived value")
 *     and future-proofs against someone adding a computation step that
 *     would otherwise break reference stability.
 *
 * Out of scope:
 *   - Constructing the actual `MeshStandardMaterial` instance — that is
 *     the consumer's responsibility (`Sphere.tsx`); this hook supplies
 *     the parameter object only.
 *   - Marking the active swatch in the sidebar (ST-004-AC3, ST-011-AC3)
 *     — owned by the `FinishSelector` component on the producer side.
 *   - Per-finish texture maps (e.g., a metallic finish bump map). The
 *     ST-004 acceptance criteria target solid-color / single-texture
 *     finishes; advanced PBR maps are deferred.
 */

import { useMemo } from 'react';

import { useConfiguratorStore } from '../../state/configuratorStore';
import type { MaterialFinish } from '../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * PBR material parameters returned by `useMaterialSwatch`. Maps directly
 * onto Three.js `MeshStandardMaterial` properties:
 *   - roughness: 0 (mirror smooth) → 1 (fully diffuse). Drives specular
 *     highlight tightness.
 *   - metalness: 0 (dielectric / plastic-like) → 1 (pure metal). Drives
 *     the F0 reflectance of the BRDF — high values look like polished
 *     metal regardless of color, low values look like rubber/leather.
 *
 * Per AAP §0.6.7 "Track 2 — Frontend Core", three finishes are supported:
 *   - matte:    roughness 0.9, metalness 0.0  (paper-like, no specular)
 *   - glossy:   roughness 0.2, metalness 0.0  (polished paint, clear specular)
 *   - metallic: roughness 0.3, metalness 0.8  (brushed metal with specular)
 */
export interface MaterialParams {
  readonly roughness: number;
  readonly metalness: number;
}

// ---------------------------------------------------------------------------
// Module-scoped finish → parameters table
// ---------------------------------------------------------------------------

/**
 * Canonical mapping from the `materialFinish` enum to Three.js PBR
 * parameters. Values are pinned per AAP §0.6.7 "Track 2 — Frontend Core".
 *
 * The `Readonly<Record<MaterialFinish, MaterialParams>>` type:
 *   - `Record<MaterialFinish, ...>` enforces EXHAUSTIVE coverage at
 *     compile time: if a new `MaterialFinish` literal is added to the
 *     union but not to this map, TypeScript errors here.
 *   - `Readonly<...>` prevents accidental mutation at the type layer.
 *
 * The per-finish object literals are allocated ONCE at module load.
 * Selecting the same finish on consecutive renders returns the same
 * object reference both times, which means React prop diffing sees
 * reference equality on the downstream `<meshStandardMaterial>` and
 * skips the material re-render — a key contributor to the ST-004-AC1
 * latency budget.
 */
const MATERIAL_PARAMS_BY_FINISH: Readonly<Record<MaterialFinish, MaterialParams>> = {
  matte: { roughness: 0.9, metalness: 0.0 },
  glossy: { roughness: 0.2, metalness: 0.0 },
  metallic: { roughness: 0.3, metalness: 0.8 },
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to the configurator store's `materialFinish` slice and
 * returns the corresponding Three.js PBR parameters.
 *
 * Implementation strategy:
 *   - Use Zustand's selector form `useConfiguratorStore((state) => state.materialFinish)`
 *     so React only re-renders when the `materialFinish` slice changes
 *     (NOT on every store update — color/pattern/logo writes are
 *     ignored by this subscription).
 *   - Look up the params via the module-scoped MATERIAL_PARAMS_BY_FINISH
 *     table. The lookup is O(1) and returns a stable reference for each
 *     finish, so unchanged finish ⇒ unchanged reference ⇒ no downstream
 *     material re-render.
 *   - `useMemo` wraps the lookup as a defensive guard. The map lookup
 *     itself returns a stable reference, so strictly speaking the memo
 *     is redundant — but it documents the intent ("this value is a
 *     stable derived state") and future-proofs against someone adding
 *     a computation step that would otherwise break the guarantee.
 *
 * Per ST-004-AC1 (latency budget): the selector + memo path updates
 * the prop synchronously within a single React render cycle. The
 * parent re-renders, which propagates the new `MaterialParams` to
 * `<Sphere>`, which propagates to `<meshStandardMaterial>`. Total
 * path length is one React render (~16ms on reference hardware), well
 * inside the documented latency budget.
 *
 * Per ST-004-AC4 (unrelated selections preserved): this hook ONLY
 * READS `materialFinish` from the store. It does not write any state,
 * does not touch rotation refs (which live inside useDragRotation /
 * useIdleAutoRotate), and does not affect colors, patterns, or logo
 * slices. Switching finishes therefore preserves rotation and every
 * other unrelated selection.
 *
 * @returns A stable `MaterialParams` reference for the currently
 *   selected finish. The reference changes only when the finish
 *   changes; identical finishes return identical references.
 */
export function useMaterialSwatch(): MaterialParams {
  // Subscribe only to the materialFinish slice. Zustand uses Object.is
  // for slice equality by default; since `materialFinish` is a primitive
  // string, this comparison is cheap and exact, and the subscriber is
  // re-rendered ONLY when the finish actually changes.
  const materialFinish = useConfiguratorStore((state) => state.materialFinish);

  // Look up the params. The MATERIAL_PARAMS_BY_FINISH table returns a
  // STABLE reference for each finish (per the module-scoped allocation),
  // so unchanged finish ⇒ unchanged reference ⇒ React's downstream
  // material re-render is skipped.
  const params = useMemo(() => MATERIAL_PARAMS_BY_FINISH[materialFinish], [materialFinish]);

  return params;
}
