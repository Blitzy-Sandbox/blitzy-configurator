/**
 * DisabledCombinationTooltip — Explains an unavailable pattern × finish
 * combination (ST-013).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     DisabledCombinationTooltip.tsx | ST-013 tooltip for unsupported
 *     combinations".
 *   - ST-013 acceptance criteria: when the active stitching pattern is
 *     incompatible with a finish, the disabled finish option remains
 *     keyboard-focusable and exposes a tooltip explaining the
 *     incompatibility; restoring a compatible pattern re-enables the
 *     finish.
 *   - QA Report Issue #8 — `DISABLED_COMBINATIONS = { spiral: ['metallic'],
 *     star: ['metallic'] }` MUST be enforced; the disabled finish MUST
 *     expose `aria-disabled="true"` and an ARIA-described tooltip
 *     (`role="tooltip"` or `aria-describedby`).
 *
 * Architecture:
 *   This component is a small presentational element. It does NOT
 *   subscribe to the configurator store — its parent
 *   (`FinishSelector`) owns the visibility decision and forwards the
 *   pattern + finish context as props. Keeping this component stateless
 *   keeps the tooltip predictable and easy to test.
 *
 *   The tooltip is referenced via `aria-describedby` from the disabled
 *   finish button so assistive technology announces the explanation
 *   automatically when the user focuses the disabled option.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import type { JSX } from 'react';

import type { StitchingPattern, MaterialFinish } from '../../../state/configuratorStore';

import styles from './pattern.module.css';

/**
 * Props for the disabled-combination tooltip.
 *
 * `id` MUST match the `aria-describedby` value on the disabled finish
 * button so screen readers can resolve the description.
 *
 * `visible` toggles the visibility class — the element remains in the
 * accessibility tree even when hidden (it's anchored relative to the
 * disabled button) so focus events expose it consistently.
 */
export interface DisabledCombinationTooltipProps {
  /** Stable DOM id used by `aria-describedby` on the disabled finish button. */
  readonly id: string;
  /** Whether the tooltip should be visually rendered (hover or focus). */
  readonly visible: boolean;
  /** The active pattern that triggered the disabled state. */
  readonly pattern: StitchingPattern;
  /** The finish that is currently unavailable. */
  readonly finish: MaterialFinish;
  /** Optional override for the rendered explanation. */
  readonly message?: string;
  /** Optional Playwright test id. */
  readonly 'data-testid'?: string;
}

/**
 * Builds the canonical "<finish> isn't available with the <pattern> stitching"
 * sentence. We compose this here rather than embedding inside the
 * parent so the wording stays in one place when it inevitably evolves.
 */
function buildDefaultMessage(pattern: StitchingPattern, finish: MaterialFinish): string {
  const finishLabels: Record<MaterialFinish, string> = {
    matte: 'Matte',
    glossy: 'Glossy',
    metallic: 'Metallic',
  };
  const patternLabels: Record<StitchingPattern, string> = {
    classic: 'classic',
    hexagonal: 'hexagonal',
    diamond: 'diamond',
    spiral: 'spiral',
    star: 'star',
    grid: 'grid',
  };
  return `${finishLabels[finish]} finish isn't available with the ${patternLabels[pattern]} stitching pattern.`;
}

/**
 * Renders the explanatory tooltip for a disabled finish option.
 *
 * The tooltip is rendered with `role="tooltip"` so assistive
 * technology recognizes it. Visibility is toggled via the
 * `--visible` class to avoid a layout shift on every hover.
 */
export function DisabledCombinationTooltip({
  id,
  visible,
  pattern,
  finish,
  message,
  'data-testid': testId = 'disabled-combination-tooltip',
}: DisabledCombinationTooltipProps): JSX.Element {
  const text = message ?? buildDefaultMessage(pattern, finish);
  const className = `${styles.tooltip}${visible ? ` ${styles['tooltip--visible']}` : ''}`;

  return (
    <span
      id={id}
      role="tooltip"
      data-visible={visible ? 'true' : 'false'}
      data-pattern={pattern}
      data-finish={finish}
      data-testid={testId}
      className={className}
    >
      {text}
    </span>
  );
}
