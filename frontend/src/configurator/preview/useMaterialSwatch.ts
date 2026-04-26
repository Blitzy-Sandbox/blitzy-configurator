/**
 * useMaterialSwatch — material swatch parameters resolved per finish (ST-004).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/useMaterialSwatch.ts
 *     | Apply material swatches to preview (ST-004)".
 *   - ST-004 acceptance criteria:
 *       AC1 Selecting a material swatch updates the ball preview to
 *           display that material within the documented latency budget.
 *       AC2 The previously applied material is replaced — only the
 *           currently selected material is visible at any time.
 *       AC3 The chosen swatch remains visually marked active in the
 *           sidebar after selection.
 *       AC4 Switching materials does not reset rotation or unrelated
 *           selections (color, pattern, logo).
 *   - QA Report Issue #7 — `useMaterialSwatch.ts` MUST exist and expose
 *     `MATERIAL_PARAMS_BY_FINISH` keyed by `'matte' | 'glossy' | 'metallic'`
 *     returning memoized THREE.MeshStandardMaterial parameters.
 *
 * Responsibilities:
 *   1. Map each `MaterialFinish` value to a `{ roughness, metalness, … }`
 *      tuple suitable for `MeshStandardMaterial`.
 *   2. Provide a stable (memoized) reference to the parameter object
 *      for the currently selected finish so that React does not
 *      re-trigger downstream effects when the ball component re-renders.
 *   3. Co-locate the parameter table next to the consumer hook so a
 *      future finish addition is one edit, not multiple.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched. Material parameter changes are processed
 *     by Three independently of the texture's needsUpdate flag.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Constructing the actual `MeshStandardMaterial` instance — that's
 *     the consumer's responsibility (`Sphere.tsx`); this hook supplies
 *     parameters only.
 *   - Per-finish texture maps (e.g., a metallic finish bump map). The
 *     ST-004 acceptance criteria target solid-color / single-texture
 *     finishes; advanced PBR maps are deferred.
 */

import { useMemo } from 'react';

import type { MaterialFinish } from '../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of `THREE.MeshStandardMaterialParameters` actually varied by
 * finish. Keeping the type narrow makes intent clear: only roughness
 * and metalness change between finishes; color, map, and other
 * properties are owned by the consumer.
 */
export interface MaterialSwatchParams {
  /**
   * Surface microfacet roughness (0 = mirror smooth, 1 = fully diffuse).
   * Drives specular highlight tightness.
   */
  readonly roughness: number;

  /**
   * Metallic factor (0 = dielectric / plastic-like, 1 = pure metal).
   * Drives the F0 reflectance of the BRDF — high values look like
   * polished metal regardless of color, low values look like rubber/leather.
   */
  readonly metalness: number;

  /**
   * Multiplier for the environment-map reflection intensity. Boosting
   * this on the metallic finish gives the chrome ball pleasing studio
   * highlights even without a custom HDRI.
   */
  readonly envMapIntensity: number;
}

// ---------------------------------------------------------------------------
// Public lookup table — exported so tests and design tooling can
// directly assert on the per-finish material parameters (per QA Report
// Issue #7 verification harness).
// ---------------------------------------------------------------------------

/**
 * Material parameter table keyed by `MaterialFinish`. Values are
 * frozen at module load time via `as const` and re-frozen explicitly
 * by `Object.freeze` so accidental consumer mutation is rejected at
 * runtime in dev (and a no-op in production).
 *
 * Per QA Report Issue #7 verification:
 *   - 'matte'    → roughness 0.9, metalness 0.0   (low specular, fully diffuse)
 *   - 'glossy'   → roughness 0.2, metalness 0.0   (sharp highlight, no metal)
 *   - 'metallic' → roughness 0.3, metalness 0.9   (metallic with mild blur)
 */
export const MATERIAL_PARAMS_BY_FINISH: Readonly<Record<MaterialFinish, MaterialSwatchParams>> =
  Object.freeze({
    matte: Object.freeze({
      roughness: 0.9,
      metalness: 0.0,
      envMapIntensity: 0.4,
    }),
    glossy: Object.freeze({
      roughness: 0.2,
      metalness: 0.0,
      envMapIntensity: 1.0,
    }),
    metallic: Object.freeze({
      roughness: 0.3,
      metalness: 0.9,
      envMapIntensity: 1.5,
    }),
  });

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Return the memoized material parameter object for the given finish.
 * Reference equality is preserved across renders that pass the same
 * finish, so consumers can use the returned value as a `useEffect`
 * dependency without triggering unnecessary effect re-runs.
 *
 * Because the underlying `MATERIAL_PARAMS_BY_FINISH` table is itself
 * frozen at module load time, the lookup is O(1) and the returned
 * reference is stable for the entire process lifetime per finish.
 */
export function useMaterialSwatch(finish: MaterialFinish): MaterialSwatchParams {
  return useMemo(() => MATERIAL_PARAMS_BY_FINISH[finish], [finish]);
}
