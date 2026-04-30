/**
 * finishCatalog — material finish catalog (ST-011).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     FinishSelector.tsx | Three finishes (matte, glossy, metallic)".
 *   - ST-011 acceptance criteria: three selectable finishes (Matte,
 *     Glossy, Metallic); the chosen finish is visibly active in the
 *     sidebar; switching finishes does not reset other selections;
 *     each finish maps to a documented material parameter set.
 *   - QA Report Issue #6 — three buttons; selection updates
 *     `materialFinish` slice; downstream effect changes Three.js
 *     material's roughness/metalness via the previously-shipped
 *     `useMaterialSwatch` hook (matte → 0.9 / 0.0; glossy → 0.2 / 0.0;
 *     metallic → 0.3 / 0.9).
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: N/A (pure data module).
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { MaterialFinish } from '../../../state/configuratorStore';

/**
 * One entry in the material finish catalog. The `description` field
 * is exposed via `aria-description` on the corresponding selector
 * button for assistive technology context.
 */
export interface MaterialFinishEntry {
  readonly value: MaterialFinish;
  readonly label: string;
  readonly description: string;
}

/**
 * The full set of material finishes offered by ST-011. Order matches
 * the documented store default ordering — `matte` first because
 * `CONFIGURATOR_DEFAULTS.materialFinish === 'matte'`.
 */
export const MATERIAL_FINISHES: readonly MaterialFinishEntry[] = Object.freeze([
  Object.freeze({
    value: 'matte',
    label: 'Matte',
    description: 'Soft non-reflective surface with diffuse highlights.',
  }),
  Object.freeze({
    value: 'glossy',
    label: 'Glossy',
    description: 'Smooth surface with sharp specular highlights.',
  }),
  Object.freeze({
    value: 'metallic',
    label: 'Metallic',
    description: 'Polished metal-like surface with strong reflectivity.',
  }),
] as const);
