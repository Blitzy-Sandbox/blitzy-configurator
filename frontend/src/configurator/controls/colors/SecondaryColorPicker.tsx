/**
 * SecondaryColorPicker — Secondary Panel Color Picker (ST-007).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     SecondaryColorPicker.tsx | ST-007".
 *   - ST-007 acceptance criteria: secondary panel color is selectable
 *     from a curated palette; selection is visibly marked; change
 *     synchronizes to the preview; control is keyboard/assistive-tech
 *     accessible.
 *   - QA Report Issue #2 — file MUST exist; default selection MUST be
 *     `#000000`; clicking a swatch MUST update the `secondaryColor`
 *     slice and trigger the texture pipeline (via `useColorSync.ts`,
 *     not by calling the pipeline directly).
 *
 * Architecture parity with PrimaryColorPicker:
 *   The two color pickers share the same shell — only the slice they
 *   subscribe to and the swatch palette differ. This component
 *   intentionally mirrors PrimaryColorPicker for predictability;
 *   future refactors that introduce a generic `<ColorPicker slice="…"
 *   swatches={…}/>` would need an explicit decision-log entry per the
 *   user's Explainability Rule.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file never imports the texture module, never
 *     calls `texturePipeline.update()`, and never touches
 *     `texture.needsUpdate`. The single canonical caller from this
 *     folder is `useColorSync.ts`.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import { SECONDARY_COLOR_SWATCHES, findSwatchLabel } from './colorSwatches';
import styles from './colorPicker.module.css';

/**
 * Props are intentionally empty (state lives in the store).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SecondaryColorPickerProps {}

/**
 * The secondary panel color picker. See {@link PrimaryColorPicker} for
 * the shared rendering / accessibility contract.
 */
export function SecondaryColorPicker(_props: SecondaryColorPickerProps = {}): JSX.Element {
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const setSecondaryColor = useConfiguratorStore((s) => s.setSecondaryColor);

  const currentLabel = findSwatchLabel(SECONDARY_COLOR_SWATCHES, secondaryColor);

  return (
    <section
      className={styles.colorPicker}
      aria-label="Secondary panel color"
      data-testid="secondary-color-picker"
    >
      <h3 className={styles.colorPicker__heading}>Secondary color</h3>
      <p className={styles.colorPicker__hint}>
        Currently <span data-testid="secondary-color-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Secondary panel color swatches"
        className={styles.colorPicker__grid}
      >
        {SECONDARY_COLOR_SWATCHES.map((swatch) => {
          const isSelected = swatch.value.toUpperCase() === secondaryColor.toUpperCase();
          return (
            <li key={swatch.value} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Secondary color ${swatch.label}${isSelected ? ' (selected)' : ''}`}
                title={swatch.label}
                data-selected={isSelected ? 'true' : 'false'}
                data-testid={`secondary-swatch-${swatch.value.toLowerCase()}`}
                data-color={swatch.value.toUpperCase()}
                className={`${styles.swatch}${isSelected ? ` ${styles['swatch--selected']}` : ''}`}
                style={{ background: swatch.value }}
                onClick={() => setSecondaryColor(swatch.value)}
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
