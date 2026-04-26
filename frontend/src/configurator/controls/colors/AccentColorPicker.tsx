/**
 * AccentColorPicker — Accent and Stitching Color Picker (ST-008).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     AccentColorPicker.tsx | ST-008".
 *   - ST-008 acceptance criteria: accent color (also drives stitching
 *     hue) is selectable from a curated palette; selected swatch is
 *     visibly marked; change synchronizes to the preview; control is
 *     keyboard/assistive-tech accessible.
 *   - QA Report Issue #3 — file MUST exist; default `#FF0000`;
 *     `aria-label` MUST be EXACTLY "Accent and stitching color"
 *     (deliberate inclusion of "stitching" because changing the accent
 *     also recolors the stitching layer). The component MUST update the
 *     `accentColor` slice on selection.
 *
 * Architecture parity with PrimaryColorPicker:
 *   The accent picker mirrors the primary/secondary shells with a single
 *   noteworthy difference: the heading and the section's `aria-label`
 *   spell out the dual semantic ("Accent and stitching color") because
 *   ST-008 explicitly states that the accent slice is the source of
 *   truth for stitching hue.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched (no texture module imports).
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import { ACCENT_COLOR_SWATCHES, findSwatchLabel } from './colorSwatches';
import styles from './colorPicker.module.css';

/**
 * Props are intentionally empty (state lives in the store).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AccentColorPickerProps {}

/**
 * The accent + stitching color picker. The exact `aria-label`
 * "Accent and stitching color" is REQUIRED by the QA report — it is
 * the assistive-technology contract for ST-008.
 */
export function AccentColorPicker(_props: AccentColorPickerProps = {}): JSX.Element {
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const setAccentColor = useConfiguratorStore((s) => s.setAccentColor);

  const currentLabel = findSwatchLabel(ACCENT_COLOR_SWATCHES, accentColor);

  return (
    <section
      className={styles.colorPicker}
      // (CRITICAL — QA Report Issue #3) The string below is part of
      // the assistive-technology contract — DO NOT modify it without
      // updating the QA acceptance criteria first.
      aria-label="Accent and stitching color"
      data-testid="accent-color-picker"
    >
      <h3 className={styles.colorPicker__heading}>Accent and stitching color</h3>
      <p className={styles.colorPicker__hint}>
        Currently <span data-testid="accent-color-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Accent and stitching color swatches"
        className={styles.colorPicker__grid}
      >
        {ACCENT_COLOR_SWATCHES.map((swatch) => {
          const isSelected = swatch.value.toUpperCase() === accentColor.toUpperCase();
          return (
            <li key={swatch.value} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Accent color ${swatch.label}${isSelected ? ' (selected)' : ''}`}
                title={swatch.label}
                data-selected={isSelected ? 'true' : 'false'}
                data-testid={`accent-swatch-${swatch.value.toLowerCase()}`}
                data-color={swatch.value.toUpperCase()}
                className={`${styles.swatch}${isSelected ? ` ${styles['swatch--selected']}` : ''}`}
                style={{ background: swatch.value }}
                onClick={() => setAccentColor(swatch.value)}
              >
                {isSelected ? (
                  <span className={styles.swatch__check} aria-hidden="true">
                    ✓
                  </span>
                ) : null}
                <span className={styles.swatch__srOnly}>{swatch.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
