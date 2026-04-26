/**
 * colorSwatches — shared swatch palettes for the color picker triad.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — color picker components for ST-006 / ST-007 /
 *     ST-008 share a curated swatch list rather than duplicating literal
 *     hex strings across three files.
 *   - QA Report Issue #1 / #2 / #3 — the three color pickers must offer
 *     a finite, accessible swatch grid; consolidating the palette here
 *     keeps the picker components small and focused on their UI shell.
 *
 * Responsibilities:
 *   1. Declare the curated swatch palettes for primary, secondary, and
 *      accent slots. Each palette begins with the documented store
 *      default (`#FFFFFF`, `#000000`, `#FF0000` respectively) so that
 *      the default selection is always present in the rendered set.
 *   2. Expose `findSwatchLabel()` which returns a friendly label for a
 *      given hex value (used in `aria-label` strings on the swatch
 *      buttons and in the assistive-technology announcement on selection
 *      change). Falls back to the upper-cased hex if a swatch is unknown.
 *
 * Cross-cutting rules:
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *   - Rule R7 / C6: this module never touches the texture pipeline.
 */

/**
 * One swatch entry. `value` is the canonical 6-digit upper-case hex
 * string (matching the store's `HexColor` convention); `label` is the
 * human-friendly name used in screen-reader announcements.
 */
export interface ColorSwatch {
  readonly value: string;
  readonly label: string;
}

/**
 * Curated primary-color palette (ST-006). The ball's panel-base color.
 *
 * The first entry MUST be `#FFFFFF` (white) so that on first render the
 * documented store default has a matching selected swatch — confirmed
 * by the AAP §0.6.7 default state and verified visually by the
 * "selected swatch state" QA expectation.
 */
export const PRIMARY_COLOR_SWATCHES: readonly ColorSwatch[] = Object.freeze([
  Object.freeze({ value: '#FFFFFF', label: 'White' }),
  Object.freeze({ value: '#F5F5F5', label: 'Soft white' }),
  Object.freeze({ value: '#FFD400', label: 'Bright yellow' }),
  Object.freeze({ value: '#FF6F00', label: 'Sunset orange' }),
  Object.freeze({ value: '#1E88E5', label: 'Royal blue' }),
  Object.freeze({ value: '#2E7D32', label: 'Forest green' }),
  Object.freeze({ value: '#5B39F3', label: 'Brand purple' }),
  Object.freeze({ value: '#212121', label: 'Charcoal' }),
]);

/**
 * Curated secondary-color palette (ST-007). The ball's contrast / panel-
 * accent base color.
 *
 * The first entry MUST be `#000000` (black) so the documented store
 * default is always present in the rendered set.
 */
export const SECONDARY_COLOR_SWATCHES: readonly ColorSwatch[] = Object.freeze([
  Object.freeze({ value: '#000000', label: 'Black' }),
  Object.freeze({ value: '#424242', label: 'Slate' }),
  Object.freeze({ value: '#9E9E9E', label: 'Grey' }),
  Object.freeze({ value: '#FFFFFF', label: 'White' }),
  Object.freeze({ value: '#0D47A1', label: 'Deep blue' }),
  Object.freeze({ value: '#1B5E20', label: 'Pine green' }),
  Object.freeze({ value: '#4101DB', label: 'Brand deep purple' }),
  Object.freeze({ value: '#B71C1C', label: 'Crimson' }),
]);

/**
 * Curated accent-color palette (ST-008). The ball's stitching and
 * highlight color.
 *
 * The first entry MUST be `#FF0000` (red) so the documented store
 * default is always present in the rendered set.
 */
export const ACCENT_COLOR_SWATCHES: readonly ColorSwatch[] = Object.freeze([
  Object.freeze({ value: '#FF0000', label: 'Red' }),
  Object.freeze({ value: '#FFD400', label: 'Yellow' }),
  Object.freeze({ value: '#94FAD5', label: 'Mint teal' }),
  Object.freeze({ value: '#00BCD4', label: 'Cyan' }),
  Object.freeze({ value: '#5B39F3', label: 'Brand purple' }),
  Object.freeze({ value: '#FFFFFF', label: 'White' }),
  Object.freeze({ value: '#000000', label: 'Black' }),
  Object.freeze({ value: '#FF6F00', label: 'Orange' }),
]);

/**
 * Look up the friendly label for a known swatch in any of the three
 * palettes. Falls back to the upper-cased hex string when the value is
 * not in the curated set (which can happen if a saved design loads a
 * custom hex via {@link useConfiguratorStore.loadDesign}). Useful for
 * `aria-label` attributes that read the current selection aloud.
 */
export function findSwatchLabel(palette: readonly ColorSwatch[], hex: string): string {
  const normalized = hex.toUpperCase();
  const match = palette.find((swatch) => swatch.value.toUpperCase() === normalized);
  return match !== undefined ? match.label : normalized;
}
