/**
 * StitchingPatternSelector — Stitching pattern picker (ST-010).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     StitchingPatternSelector.tsx | ST-010 six patterns".
 *   - ST-010 acceptance criteria: a designer can choose any of six
 *     stitching patterns, the selected pattern is visibly marked,
 *     the change synchronizes to the live preview, and the control
 *     is accessible via keyboard and assistive technology.
 *   - QA Report Issue #5 — file MUST exist; users MUST be able to pick
 *     any of the 6 patterns; selection MUST update the
 *     `stitchingPattern` Zustand slice; visible selected state MUST be
 *     present on the chosen option.
 *
 * Architecture:
 *   This component is a pure presentation + state-binding shell. It
 *   subscribes to the `stitchingPattern` slice via a Zustand selector
 *   (slice-only, never the whole store), renders one option button per
 *   entry in `STITCHING_PATTERNS`, and dispatches `setStitchingPattern`
 *   on click.
 *
 *   This component does NOT mutate the texture pipeline. Pattern
 *   changes propagate to the 3D preview via `Sphere.tsx` /
 *   `useMaterialSwatch` and via the canonical `texturePipeline.update()`
 *   call orchestrated centrally — this picker simply flips the slice.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`. Verifiable
 *     via `grep -n "texturePipeline\|needsUpdate"
 *     StitchingPatternSelector.tsx` returning zero matches.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import { STITCHING_PATTERNS } from './patternCatalog';
import styles from './pattern.module.css';

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store. Future stories that need to override the
 * pattern set (e.g., a customer-branded subset) can extend this
 * interface.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface StitchingPatternSelectorProps {}

/**
 * Stitching-pattern selector.
 *
 * Renders six toggle-style buttons in a responsive grid. The selected
 * pattern is communicated via:
 *   - `aria-checked="true"` on the chosen `role="radio"` button (the
 *     ARIA contract for a radiogroup),
 *   - `data-selected="true"` for stable Playwright/Jest selectors,
 *   - the visual `option--selected` modifier class.
 *
 * The chosen pattern is also surfaced in a hint paragraph above the
 * radiogroup so screen readers that skim by heading reach the live
 * value before scanning the options.
 */
export function StitchingPatternSelector(_props: StitchingPatternSelectorProps = {}): JSX.Element {
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const setStitchingPattern = useConfiguratorStore((s) => s.setStitchingPattern);

  const currentEntry = STITCHING_PATTERNS.find((entry) => entry.value === stitchingPattern);
  const currentLabel = currentEntry?.label ?? stitchingPattern;

  return (
    <section
      className={styles.selector}
      aria-label="Stitching pattern"
      data-testid="stitching-pattern-selector"
    >
      <h3 className={styles.selector__heading}>Stitching pattern</h3>
      <p className={styles.selector__hint}>
        Currently <span data-testid="stitching-pattern-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Stitching pattern options"
        className={styles.selector__group}
      >
        {STITCHING_PATTERNS.map((entry) => {
          const isSelected = entry.value === stitchingPattern;
          return (
            <li key={entry.value} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Stitching pattern ${entry.label}${
                  isSelected ? ' (selected)' : ''
                }. ${entry.description}`}
                title={entry.label}
                data-selected={isSelected ? 'true' : 'false'}
                data-testid={`stitching-pattern-option-${entry.value}`}
                data-pattern={entry.value}
                className={`${styles.option}${isSelected ? ` ${styles['option--selected']}` : ''}`}
                onClick={() => setStitchingPattern(entry.value)}
              >
                <span className={styles.option__label}>{entry.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
