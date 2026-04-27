/**
 * FinishSelector — Material finish picker (ST-011) with disabled-
 * combination enforcement (ST-013).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     FinishSelector.tsx | ST-011 three finishes (matte, glossy,
 *     metallic)".
 *   - ST-011 acceptance criteria: a designer can choose any of three
 *     finishes (matte, glossy, metallic), the selected finish is
 *     visibly marked, the change synchronizes to the live preview's
 *     material parameters, and the control is accessible via keyboard
 *     and assistive technology.
 *   - ST-013 acceptance criteria: when the active stitching pattern is
 *     incompatible with a finish (per `DISABLED_COMBINATIONS`), the
 *     finish option is rendered as `aria-disabled="true"` with a
 *     tooltip explaining the incompatibility; the option remains
 *     keyboard-focusable; restoring a compatible pattern re-enables
 *     the finish.
 *   - QA Report Issues #6 and #8.
 *
 * Architecture:
 *   This component is a presentation + state-binding shell. It
 *   subscribes to BOTH `materialFinish` and `stitchingPattern` slices
 *   so it can render the disabled state for incompatible
 *   combinations. The decision is delegated to
 *   `isFinishDisabledForPattern` from `DisabledCombinationTooltip.tsx`
 *   so the rule lives in a single, easily-tested module that also owns
 *   the user-facing tooltip copy via `getDisabledFinishReason`.
 *
 *   Disabled options:
 *     - have `aria-disabled="true"` (NOT `disabled`, which would
 *       remove them from the tab order — ST-013 explicitly requires
 *       keyboard focusability),
 *     - reference a per-option tooltip via `aria-describedby` only
 *       while the tooltip is mounted (mount/unmount visibility model
 *       per the AAP, so the ARIA reference never dangles),
 *     - render the tooltip on hover OR focus (managed locally via
 *       `useState<MaterialFinish | null>` for the actively-revealed
 *       finish),
 *     - have their `onClick` short-circuited so the state never
 *       changes when the user clicks a disabled finish.
 *
 *   This component does NOT call the texture pipeline. Finish changes
 *   propagate to the 3D preview through the `materialFinish` slice
 *   consumed by `useMaterialSwatch` in `Sphere.tsx`.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`. Verifiable
 *     via `grep -n "texturePipeline\|needsUpdate" FinishSelector.tsx`
 *     returning zero matches.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import { useId, useState } from 'react';
import type { JSX } from 'react';

import type { MaterialFinish } from '../../../state/configuratorStore';
import { useConfiguratorStore } from '../../../state/configuratorStore';

import {
  DisabledCombinationTooltip,
  getDisabledFinishReason,
  isFinishDisabledForPattern,
} from './DisabledCombinationTooltip';
import { MATERIAL_FINISHES } from './finishCatalog';
import styles from './pattern.module.css';

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store. Future stories that need to override the
 * finish set or the disabled-combination map can extend this
 * interface.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FinishSelectorProps {}

/**
 * Material-finish selector with disabled-combination enforcement.
 */
export function FinishSelector(_props: FinishSelectorProps = {}): JSX.Element {
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const setMaterialFinish = useConfiguratorStore((s) => s.setMaterialFinish);

  /**
   * The id of the finish whose tooltip is currently revealed (via
   * hover or focus). `null` means no tooltip is showing. We reveal one
   * tooltip at a time so the UI never becomes a noisy wall of
   * announcements.
   */
  const [revealedFinish, setRevealedFinish] = useState<MaterialFinish | null>(null);

  // Stable DOM-id prefix for `aria-describedby` references. `useId`
  // gives us a per-render unique value that is consistent across
  // re-renders so the ARIA wiring stays valid.
  const tooltipIdPrefix = useId();

  const currentEntry = MATERIAL_FINISHES.find((entry) => entry.value === materialFinish);
  const currentLabel = currentEntry?.label ?? materialFinish;

  return (
    <section className={styles.selector} aria-label="Material finish" data-testid="finish-selector">
      <h3 className={styles.selector__heading}>Material finish</h3>
      <p className={styles.selector__hint}>
        Currently <span data-testid="finish-current">{currentLabel}</span>
      </p>
      <ul role="radiogroup" aria-label="Material finish options" className={styles.selector__group}>
        {MATERIAL_FINISHES.map((entry) => {
          const isSelected = entry.value === materialFinish;
          const disabled = isFinishDisabledForPattern(entry.value, stitchingPattern);
          const tooltipId = `${tooltipIdPrefix}-${entry.value}`;
          const tooltipVisible = disabled && revealedFinish === entry.value;
          // The reason copy is computed by the disabled-combination
          // module so the wording stays in lockstep with the matrix.
          // It is `null` when the combination is supported, in which
          // case the tooltip is also unmounted and aria-describedby is
          // unset.
          const tooltipReason = tooltipVisible
            ? getDisabledFinishReason(entry.value, stitchingPattern)
            : null;

          // Compose the visible class list. Disabled and selected are
          // mutually exclusive at runtime — a disabled option cannot
          // be selected because clicks are short-circuited — but we
          // defensively combine both modifiers in case of stale state.
          const className = [
            styles.option,
            isSelected ? styles['option--selected'] : '',
            disabled ? styles['option--disabled'] : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li
              key={entry.value}
              style={{ listStyle: 'none', padding: 0, margin: 0, position: 'relative' }}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-disabled={disabled}
                aria-label={`${entry.label} finish${isSelected ? ' (selected)' : ''}${
                  disabled ? ' (unavailable for current pattern)' : ''
                }. ${entry.description}`}
                // Reference the tooltip only while it is mounted —
                // dangling aria-describedby IDs are valid HTML but
                // misleading to assistive tech. Tooltips appear on
                // hover or focus, so screen readers receive the
                // description at exactly the moment focus reaches the
                // disabled button.
                aria-describedby={tooltipReason !== null ? tooltipId : undefined}
                title={entry.label}
                data-selected={isSelected ? 'true' : 'false'}
                data-disabled={disabled ? 'true' : 'false'}
                data-testid={`finish-option-${entry.value}`}
                data-finish={entry.value}
                className={className}
                onClick={() => {
                  if (disabled) {
                    // Reveal the tooltip on click as well so touch
                    // users (no hover) get the explanation.
                    setRevealedFinish(entry.value);
                    return;
                  }
                  setMaterialFinish(entry.value);
                }}
                onMouseEnter={() => {
                  if (disabled) setRevealedFinish(entry.value);
                }}
                onMouseLeave={() => {
                  if (disabled && revealedFinish === entry.value) setRevealedFinish(null);
                }}
                onFocus={() => {
                  if (disabled) setRevealedFinish(entry.value);
                }}
                onBlur={() => {
                  if (disabled && revealedFinish === entry.value) setRevealedFinish(null);
                }}
              >
                <span className={styles.option__label}>{entry.label}</span>
                {tooltipReason !== null ? (
                  <DisabledCombinationTooltip
                    id={tooltipId}
                    reason={tooltipReason}
                    data-testid={`finish-tooltip-${entry.value}`}
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
