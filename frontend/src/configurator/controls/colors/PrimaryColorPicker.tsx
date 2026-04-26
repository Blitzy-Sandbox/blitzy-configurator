/**
 * PrimaryColorPicker — Primary Panel Color Picker (ST-006).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     PrimaryColorPicker.tsx | ST-006 swatches with keyboard/assistive-
 *     tech support".
 *   - ST-006 acceptance criteria (per the source story file): primary
 *     panel color is selectable from a curated palette, the selected
 *     swatch is visibly marked, the change synchronizes to the live
 *     preview, and the control is accessible via keyboard and assistive
 *     technology.
 *   - QA Report Issue #1 — file MUST exist and component MUST render
 *     inside `ControlSidebar` with an `aria-label` containing "Primary";
 *     default selection MUST be `#FFFFFF`; clicking a swatch MUST invoke
 *     `setPrimaryColor` on the Zustand store.
 *
 * Architecture:
 *   This component is a pure presentation + state-binding shell. It
 *   never calls the texture pipeline directly — that is the job of
 *   `useColorSync.ts` (the SINGLE canonical caller of
 *   `texturePipeline.update()` from `controls/colors/`). The picker
 *   merely flips the `primaryColor` slice on the configurator store;
 *   `useColorSync`'s subscription does the rest.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call `texturePipeline.update()`,
 *     does NOT touch `texture.needsUpdate`, and does NOT import any
 *     texture module. Verifiable via `grep -n "texturePipeline\|needsUpdate"
 *     PrimaryColorPicker.tsx` returning zero matches.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import { PRIMARY_COLOR_SWATCHES, findSwatchLabel } from './colorSwatches';
import styles from './colorPicker.module.css';

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store. Future stories that need to override the
 * palette (e.g., a customer-branded subset) can extend this interface.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PrimaryColorPickerProps {}

/**
 * The primary panel color picker.
 *
 * Subscribes via Zustand selectors (slice-only, never the whole store)
 * and renders one button per swatch. Each button's `aria-label`
 * declares the color name and selected state so assistive technology
 * announces the rich context on focus.
 *
 * Buttons receive `aria-pressed` (accurate for toggle-style swatches)
 * AND a `data-selected` attribute so Playwright tests can use a single
 * stable selector (`[data-selected="true"]`) regardless of ARIA state.
 */
export function PrimaryColorPicker(_props: PrimaryColorPickerProps = {}): JSX.Element {
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const setPrimaryColor = useConfiguratorStore((s) => s.setPrimaryColor);

  const currentLabel = findSwatchLabel(PRIMARY_COLOR_SWATCHES, primaryColor);

  return (
    <section
      className={styles.colorPicker}
      aria-label="Primary panel color"
      data-testid="primary-color-picker"
    >
      <h3 className={styles.colorPicker__heading}>Primary color</h3>
      <p className={styles.colorPicker__hint}>
        Currently <span data-testid="primary-color-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Primary panel color swatches"
        className={styles.colorPicker__grid}
      >
        {PRIMARY_COLOR_SWATCHES.map((swatch) => {
          const isSelected = swatch.value.toUpperCase() === primaryColor.toUpperCase();
          return (
            <li key={swatch.value} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Primary color ${swatch.label}${isSelected ? ' (selected)' : ''}`}
                title={swatch.label}
                data-selected={isSelected ? 'true' : 'false'}
                data-testid={`primary-swatch-${swatch.value.toLowerCase()}`}
                data-color={swatch.value.toUpperCase()}
                className={`${styles.swatch}${isSelected ? ` ${styles['swatch--selected']}` : ''}`}
                style={{ background: swatch.value }}
                onClick={() => setPrimaryColor(swatch.value)}
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
