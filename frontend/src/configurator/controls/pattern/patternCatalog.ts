/**
 * patternCatalog — stitching pattern + disabled-combination catalog.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     StitchingPatternSelector.tsx | Six patterns (ST-010)" and
 *     "DisabledCombinationTooltip.tsx | Incompatible-combination
 *     tooltip (ST-013)".
 *   - ST-010 acceptance criteria: six selectable stitching patterns
 *     (Classic, Hexagonal, Diamond, Spiral, Star, Grid).
 *   - ST-013 acceptance criteria: certain pattern × finish combinations
 *     are visually unavailable; the disabled state is announced to
 *     assistive technology with a remediation message.
 *   - QA Report Issue #5 — six selectable patterns matching the
 *     FRONTEND naming scheme `[classic, hexagonal, diamond, spiral,
 *     star, grid]`.
 *   - QA Report Issue #8 — `DISABLED_COMBINATIONS = { spiral:
 *     [metallic], star: [metallic] }` MUST be enforced.
 *
 * Naming discrepancy note (per QA Report Areas of Concern §4):
 *   The frontend palette `[classic, hexagonal, diamond, spiral, star,
 *   grid]` does NOT match the backend persisted enum. Cross-layer
 *   alignment is a CP8 concern; this checkpoint stays inside the
 *   frontend domain and uses the QA-mandated frontend names.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: N/A (pure data module).
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { MaterialFinish, StitchingPattern } from '../../../state/configuratorStore';

/**
 * One entry in the stitching-pattern catalog. `value` matches the
 * `StitchingPattern` type from the configurator store. `label` and
 * `description` drive the visible UI; `description` also appears as
 * the option's `aria-description` for screen-reader context.
 */
export interface StitchingPatternEntry {
  readonly value: StitchingPattern;
  readonly label: string;
  readonly description: string;
}

/**
 * The full set of stitching patterns offered by ST-010. The order here
 * is the order in which they appear in the selector UI.
 *
 * The first entry is `classic` to match the documented store default
 * (CONFIGURATOR_DEFAULTS.stitchingPattern === 'classic').
 */
export const STITCHING_PATTERNS: readonly StitchingPatternEntry[] = Object.freeze([
  Object.freeze({
    value: 'classic',
    label: 'Classic',
    description: 'Traditional crosshatch lacing.',
  }),
  Object.freeze({
    value: 'hexagonal',
    label: 'Hexagonal',
    description: 'Six-sided panel arrangement.',
  }),
  Object.freeze({
    value: 'diamond',
    label: 'Diamond',
    description: 'Diamond-shaped panel arrangement.',
  }),
  Object.freeze({
    value: 'spiral',
    label: 'Spiral',
    description: 'Continuous spiraling stitch line.',
  }),
  Object.freeze({
    value: 'star',
    label: 'Star',
    description: 'Star-burst stitch motif.',
  }),
  Object.freeze({
    value: 'grid',
    label: 'Grid',
    description: 'Regular grid lattice.',
  }),
] as const);

/**
 * Map of incompatible pattern × finish combinations (ST-013).
 *
 * (CRITICAL — QA Report Issue #8) The keys are the patterns that have
 * one or more disabled finishes; the values are the finish lists that
 * MUST be unavailable when that pattern is selected. The ST-013
 * disabled-combination logic reads this table directly — DO NOT add
 * filtering elsewhere.
 *
 * Restoring the documented default `'classic'` re-enables every
 * finish, which is exactly what users expect after an "incompatible"
 * encounter — they can revert to the safe default and try again.
 */
export const DISABLED_COMBINATIONS: Readonly<Record<StitchingPattern, readonly MaterialFinish[]>> =
  Object.freeze({
    classic: Object.freeze([] as readonly MaterialFinish[]),
    hexagonal: Object.freeze([] as readonly MaterialFinish[]),
    diamond: Object.freeze([] as readonly MaterialFinish[]),
    // Spiral stitching plus a metallic finish bleeds the highlight along
    // the continuous spiral seam in an unflattering way. Disabled until
    // the texture pipeline gains anisotropic stitching shaders (deferred
    // beyond MG1-F).
    spiral: Object.freeze(['metallic'] as const),
    // Star stitching has very narrow stitch corners that catch the
    // metallic highlight band as an artifact. Disabled for the same
    // reason as spiral.
    star: Object.freeze(['metallic'] as const),
    grid: Object.freeze([] as readonly MaterialFinish[]),
  });

/**
 * Return true when the given pattern × finish combination is disabled
 * per the documented {@link DISABLED_COMBINATIONS} map. False when the
 * combination is allowed.
 *
 * Centralizing this query in one helper keeps every component using
 * the same predicate — the pattern selector, the finish selector, and
 * the disabled-combination tooltip all call this function.
 */
export function isCombinationDisabled(pattern: StitchingPattern, finish: MaterialFinish): boolean {
  const disabled = DISABLED_COMBINATIONS[pattern];
  return disabled.includes(finish);
}
