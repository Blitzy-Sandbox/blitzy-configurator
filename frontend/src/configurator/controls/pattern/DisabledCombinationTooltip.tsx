/**
 * DisabledCombinationTooltip — disabled-combination matrix, predicates,
 * reason getters, and tooltip component for the Pattern + Finish
 * controls (ST-013).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     DisabledCombinationTooltip.tsx | ST-013 tooltip for unsupported
 *     pattern+finish combinations".
 *   - ST-013 acceptance criteria (verbatim from
 *     `tickets/stories/ST-013-disabled-state-handling.md`):
 *       AC1 An unsupported pattern × finish combination renders the
 *           conflicting option in a disabled visual state.
 *       AC2 Hovering or focusing a disabled option reveals a tooltip
 *           explaining why the combination is currently unavailable.
 *       AC3 Clicking a disabled option produces no change to the preview
 *           and does not register as a selection.
 *       AC4 When the user changes the other variable so the combination
 *           becomes supported, the previously disabled option returns to
 *           the enabled state.
 *
 * Architecture & Responsibility split:
 *   This file is the SINGLE source of truth for the disabled
 *   pattern+finish matrix and the user-facing copy that explains it.
 *   It exports five small, pure helpers and one stateless presentational
 *   component:
 *
 *     - `DISABLED_COMBINATIONS` (local, NOT exported)
 *           The matrix of (pattern → disabled finish list) pairs.
 *     - `isPatternDisabledForFinish(pattern, finish)`
 *           Pure predicate consumed by the StitchingPatternSelector to
 *           decide whether a pattern button should render in the
 *           disabled state for the currently selected finish.
 *     - `isFinishDisabledForPattern(finish, pattern)`
 *           Mirror predicate consumed by the FinishSelector. Delegates
 *           to `isPatternDisabledForFinish` so both predicates observe
 *           the identical matrix — single source of truth.
 *     - `getDisabledPatternReason(pattern, finish)`
 *           Returns user-facing copy explaining why the pattern is
 *           disabled (or null when the pair is supported). The copy is
 *           generated dynamically from the matrix + display labels +
 *           the list of supported alternatives, so a matrix change
 *           never produces drifted strings.
 *     - `getDisabledFinishReason(finish, pattern)`
 *           Mirror reason getter consumed by the FinishSelector.
 *     - `DisabledCombinationTooltip`
 *           Stateless tooltip component. Renders a single `<span>` with
 *           `role="tooltip"`, an absolutely-positioned arrow, and the
 *           pre-computed `reason` string. Visibility is controlled by
 *           the CALLER via mount/unmount — when the option is hovered
 *           or focused the caller mounts the tooltip; when focus moves
 *           away the caller unmounts it.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`.
 *   - Rule R2: ZERO `console.*` calls; no credential-shaped fields.
 *   - Rule R3: no auth library imports.
 *   - AAP §0.4.6: no barrel imports — explicit relative paths only.
 *   - AAP §0.1.1: TypeScript strict; no `any`.
 *
 * Why the matrix lives here (per assigned-folder cross-cutting rule):
 *   "The matrix of unsupported pattern+finish pairs lives as a local
 *   constant within `DisabledCombinationTooltip.tsx` … not in `state/`.
 *   This keeps the UI concern collocated with the UI component and
 *   avoids polluting the global store with enablement metadata."
 */

import { type CSSProperties, type HTMLAttributes } from 'react';

import type { MaterialFinish, StitchingPattern } from '../../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Combination matrix (LOCAL — NOT exported)
// ---------------------------------------------------------------------------

/**
 * Mapped-type shape for the disabled-combinations matrix. Every key
 * MUST be a valid `StitchingPattern` and every value MUST be a readonly
 * array of valid `MaterialFinish` strings — TypeScript enforces this at
 * compile time, which is the primary defense against matrix-authoring
 * mistakes.
 *
 * Entries are optional so the matrix can omit fully-supported patterns.
 */
type DisabledMatrix = {
  readonly [P in StitchingPattern]?: readonly MaterialFinish[];
};

/**
 * Declares pattern × finish combinations that the texture pipeline
 * cannot render convincingly. Pairs absent from this table are fully
 * supported.
 *
 * Rationale per pair:
 *  - 'spiral' + 'metallic': the spiral stitching pattern overlaps
 *    itself along its helical path. Applying a full-metalness material
 *    produces harsh specular banding at intersections, which our
 *    SDF-based texture pipeline cannot smooth without per-pixel
 *    roughness maps (out of scope for EP-003). Users are directed to
 *    Matte or Glossy instead.
 *  - 'star' + 'metallic': star-pattern stitching has sharp inside-angle
 *    corners that, at full metalness, create visible aliasing at
 *    standard preview resolution. Matte and Glossy are supported.
 *
 * This matrix is intentionally SMALL. Keeping it short minimises
 * surface area for AC4 violations (combinations re-enabling correctly).
 * Expanding it later is a separate product decision.
 *
 * The structure is keyed by pattern → set of disabled finishes so that
 * lookups are O(1) and the predicate functions have no branching.
 */
const DISABLED_COMBINATIONS: DisabledMatrix = {
  spiral: ['metallic'],
  star: ['metallic'],
};

// ---------------------------------------------------------------------------
// Display label constants (LOCAL — NOT exported)
// ---------------------------------------------------------------------------

/**
 * Display labels for stitching patterns, used by the reason getters
 * to compose user-facing copy.
 *
 * NOTE — DUPLICATION IS INTENTIONAL: these maps also exist in
 * `StitchingPatternSelector.tsx` / `patternCatalog.ts`. Extracting a
 * shared file would violate AAP scope (the assigned-folder cross-cutting
 * rule mandates exactly four files in this folder). TypeScript's
 * `Record<StitchingPattern, string>` enforces exhaustiveness here — if
 * a new pattern is added to the union, this file fails to compile until
 * the entry is added.
 */
const PATTERN_DISPLAY_LABELS: Readonly<Record<StitchingPattern, string>> = {
  classic: 'Classic',
  hexagonal: 'Hexagonal',
  diamond: 'Diamond',
  spiral: 'Spiral',
  star: 'Star',
  grid: 'Grid',
};

/**
 * Display labels for material finishes — mirror of
 * `PATTERN_DISPLAY_LABELS`. See note above re: intentional duplication.
 */
const FINISH_DISPLAY_LABELS: Readonly<Record<MaterialFinish, string>> = {
  matte: 'Matte',
  glossy: 'Glossy',
  metallic: 'Metallic',
};

/**
 * Ordered list of all stitching patterns. Order matches the order in
 * `STITCHING_PATTERNS` in `patternCatalog.ts`, which in turn matches the
 * order in which the buttons appear in `StitchingPatternSelector.tsx`.
 *
 * Used by `getDisabledFinishReason` to enumerate "Try a different
 * pattern such as …" alternatives.
 */
const ALL_PATTERNS: readonly StitchingPattern[] = [
  'classic',
  'hexagonal',
  'diamond',
  'spiral',
  'star',
  'grid',
] as const;

/**
 * Ordered list of all material finishes. Order matches
 * `MATERIAL_FINISHES` in `finishCatalog.ts` — `matte` first because the
 * documented store default is `'matte'`.
 *
 * Used by `getDisabledPatternReason` to enumerate "Try …" finish
 * alternatives.
 */
const ALL_FINISHES: readonly MaterialFinish[] = ['matte', 'glossy', 'metallic'] as const;

// ---------------------------------------------------------------------------
// Predicate functions
// ---------------------------------------------------------------------------

/**
 * True when `pattern` cannot be used with `finish` — i.e., the pair is
 * present in the disabled-combinations matrix. Both arguments are
 * required; passing `undefined` or an out-of-range value is a TypeScript
 * error.
 *
 * O(1) lookup. No allocations. Safe to call on every render.
 *
 * Consumed by `StitchingPatternSelector.tsx` to decide whether a given
 * pattern option should render in its disabled state given the
 * currently-selected finish (ST-013-AC1).
 *
 * @param pattern — the stitching pattern being evaluated
 * @param finish  — the currently-selected material finish
 * @returns `true` when the pattern is disabled for that finish
 */
export function isPatternDisabledForFinish(
  pattern: StitchingPattern,
  finish: MaterialFinish,
): boolean {
  const disabledFinishesForPattern = DISABLED_COMBINATIONS[pattern];
  if (!disabledFinishesForPattern) {
    return false;
  }
  return disabledFinishesForPattern.includes(finish);
}

/**
 * Mirror of `isPatternDisabledForFinish` with the arguments swapped,
 * intended for use by `FinishSelector.tsx`. The argument order in the
 * function name matches the subject → modifier semantics used at the
 * call site: "is the FINISH disabled, given this PATTERN?".
 *
 * Delegates to `isPatternDisabledForFinish` to ensure both predicates
 * observe the identical matrix — a single source of truth. A direct
 * implementation here would allow drift if a future change to the
 * matrix shape touched only one function.
 *
 * @param finish  — the material finish being evaluated
 * @param pattern — the currently-selected stitching pattern
 * @returns `true` when the finish is disabled for that pattern
 */
export function isFinishDisabledForPattern(
  finish: MaterialFinish,
  pattern: StitchingPattern,
): boolean {
  return isPatternDisabledForFinish(pattern, finish);
}

// ---------------------------------------------------------------------------
// Reason getters
// ---------------------------------------------------------------------------

/**
 * Human-readable explanation of why a disabled pattern cannot be used
 * with the currently-selected finish. Returns `null` when the pair is
 * supported (callers can use the non-null return as a "should the
 * tooltip be shown?" signal).
 *
 * Consumed by `StitchingPatternSelector.tsx` to populate the tooltip
 * that appears on hover or focus of a disabled option (ST-013-AC2).
 *
 * The message tone is friendly and action-oriented ("Try Matte or
 * Glossy"); copy MUST mention the supported alternatives so users are
 * not left at a dead-end. Alternatives are joined with " or " because
 * there are at most three finishes — natural English phrasing.
 *
 * @param pattern — the stitching pattern that is disabled
 * @param finish  — the finish that triggered the disabled state
 * @returns user-facing copy explaining the conflict, or `null` when the
 *          combination is in fact supported
 */
export function getDisabledPatternReason(
  pattern: StitchingPattern,
  finish: MaterialFinish,
): string | null {
  if (!isPatternDisabledForFinish(pattern, finish)) {
    return null;
  }

  const finishLabel = FINISH_DISPLAY_LABELS[finish];
  const patternLabel = PATTERN_DISPLAY_LABELS[pattern];
  const alternatives = ALL_FINISHES.filter(
    (candidate) => candidate !== finish && !isPatternDisabledForFinish(pattern, candidate),
  )
    .map((candidate) => FINISH_DISPLAY_LABELS[candidate])
    .join(' or ');

  if (alternatives.length > 0) {
    return `${patternLabel} stitching is not available with a ${finishLabel} finish. Try ${alternatives} instead.`;
  }
  return `${patternLabel} stitching is not available with a ${finishLabel} finish.`;
}

/**
 * Human-readable explanation of why a disabled finish cannot be used
 * with the currently-selected pattern. Mirror of
 * `getDisabledPatternReason` for the FinishSelector.
 *
 * Pattern alternatives are joined with `, ` (comma) because there are
 * up to six patterns — natural English phrasing for longer lists.
 *
 * @param finish  — the finish that is disabled
 * @param pattern — the pattern that triggered the disabled state
 * @returns user-facing copy explaining the conflict, or `null` when the
 *          combination is in fact supported
 */
export function getDisabledFinishReason(
  finish: MaterialFinish,
  pattern: StitchingPattern,
): string | null {
  if (!isFinishDisabledForPattern(finish, pattern)) {
    return null;
  }

  const finishLabel = FINISH_DISPLAY_LABELS[finish];
  const patternLabel = PATTERN_DISPLAY_LABELS[pattern];
  const alternatives = ALL_PATTERNS.filter(
    (candidate) => candidate !== pattern && !isFinishDisabledForPattern(finish, candidate),
  )
    .map((candidate) => PATTERN_DISPLAY_LABELS[candidate])
    .join(', ');

  if (alternatives.length > 0) {
    return `A ${finishLabel} finish is not available with ${patternLabel} stitching. Try a different stitching pattern such as ${alternatives}.`;
  }
  return `A ${finishLabel} finish is not available with ${patternLabel} stitching.`;
}

// ---------------------------------------------------------------------------
// Tooltip component — props, styles, and implementation
// ---------------------------------------------------------------------------

/**
 * Props for the `DisabledCombinationTooltip` component.
 *
 * The `id` prop is REQUIRED — the caller uses the same value on its
 * disabled button's `aria-describedby` attribute to satisfy ST-013-AC2's
 * ARIA wiring contract.
 *
 * The `reason` prop is the pre-formatted user-facing copy, produced by
 * `getDisabledPatternReason` or `getDisabledFinishReason`. The component
 * intentionally does NOT accept `children` — using a prop instead of
 * children makes the caller's contract explicit (the reason MUST come
 * from the getters) and keeps the tooltip structurally stable so a
 * caller cannot accidentally inject interactive elements like buttons
 * or links that would complicate `pointer-events: none`.
 *
 * The component extends `HTMLAttributes<HTMLSpanElement>` so callers
 * can forward `data-*` attributes (for Playwright targeting),
 * `className`, `style`, and event handlers. `role`, `id`, and
 * `children` are stripped from the inherited type so the caller cannot
 * override those — the role is hard-wired to `"tooltip"`, the id is
 * the required prop, and children are replaced by `reason`.
 */
export interface DisabledCombinationTooltipProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, 'role' | 'id' | 'children'> {
  /** Stable DOM id used by the disabled button's `aria-describedby`. */
  id: string;
  /** User-facing explanation for why the option is disabled. */
  reason: string;
}

/**
 * Inline styles for the tooltip container.
 *
 * Color choices use the Blitzy brand tokens declared in AAP §0.8.2
 * (Executive Presentation Rule) — `#2D1C77` (primary-dark) for the
 * background, `#FFFFFF` for foreground text. This keeps the configurator
 * visually consistent with the broader product identity even though no
 * design-system library is used.
 *
 * `pointer-events: none` is critical: when the cursor moves over the
 * tooltip, browsers would otherwise treat the tooltip as a hover target
 * and steal focus away from the disabled button beneath. The disabled
 * button's mouseleave event would fire, the tooltip would unmount, the
 * cursor would now be over the button again, mouseenter would fire,
 * the tooltip would re-mount … producing a visible flicker. Disabling
 * pointer events on the tooltip eliminates this flicker entirely.
 *
 * Positioning: `top: calc(100% + 6px)` places the tooltip 6 px below
 * the disabled button (the parent must establish a positioning context
 * via `position: relative`); the `transform: translateX(-50%)` paired
 * with `left: 50%` centers the tooltip horizontally below the button.
 */
const TOOLTIP_CONTAINER_STYLE: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 100,
  pointerEvents: 'none',
  minWidth: '12rem',
  maxWidth: '18rem',
  padding: '0.5rem 0.75rem',
  background: '#2D1C77',
  color: '#FFFFFF',
  fontSize: '0.8125rem',
  fontFamily: 'Inter, system-ui, sans-serif',
  fontWeight: 400,
  lineHeight: 1.4,
  borderRadius: '0.375rem',
  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
  textAlign: 'center',
};

/**
 * Inline styles for the small decorative arrow that points up from the
 * tooltip toward the disabled button.
 *
 * The arrow is implemented as a 10×10 px square rotated 45°, with the
 * top half of the rotated square clipped by the parent container's
 * vertical positioning (the arrow's `top: -5px` places half of the
 * rotated square above the parent's top edge). The colour matches the
 * tooltip background so it appears as a contiguous notch.
 *
 * `aria-hidden` is set on the arrow element itself in the JSX below —
 * assistive technology must not announce the decorative shape.
 */
const TOOLTIP_ARROW_STYLE: CSSProperties = {
  position: 'absolute',
  top: '-5px',
  left: '50%',
  transform: 'translateX(-50%) rotate(45deg)',
  width: '10px',
  height: '10px',
  background: '#2D1C77',
  pointerEvents: 'none',
};

/**
 * Tooltip surfaced when a disabled pattern or finish option is hovered
 * or focused (ST-013-AC2). Rendered as a sibling of the disabled
 * button, positioned absolutely relative to the button's container.
 *
 * ARIA contract:
 *   - `role="tooltip"` identifies this element to assistive technology.
 *   - The caller links its disabled `<button>` to this tooltip via
 *     `aria-describedby` referencing this tooltip's `id` prop, so a
 *     screen reader announces the explanation when focus reaches the
 *     button.
 *
 * Visibility model: this component is mounted only when the tooltip
 * should be visible; when the user moves focus or hover off the
 * disabled button the caller unmounts the component. This "render or
 * don't" approach avoids the complexity of CSS transitions, timers, or
 * aria-hidden juggling. The trade-off is that there is no fade-in
 * animation — the tooltip appears instantly. For a configurator that
 * runs at ≥30 FPS (ST-005), this is acceptable.
 *
 * Tag choice: a `<span>` is used because the tooltip is a phrase, not
 * a block-level document region. `span` + `role="tooltip"` ensures
 * assistive technology announces the content as inline text. The
 * positioning is provided by the inline style, not by tag semantics.
 */
export function DisabledCombinationTooltip({
  id,
  reason,
  style: overrideStyle,
  className: overrideClassName,
  ...rest
}: DisabledCombinationTooltipProps): JSX.Element {
  const className = overrideClassName
    ? `disabled-combination-tooltip ${overrideClassName}`
    : 'disabled-combination-tooltip';

  return (
    <span
      {...rest}
      id={id}
      role="tooltip"
      className={className}
      style={{ ...TOOLTIP_CONTAINER_STYLE, ...overrideStyle }}
    >
      <span
        aria-hidden="true"
        className="disabled-combination-tooltip__arrow"
        style={TOOLTIP_ARROW_STYLE}
      />
      {reason}
    </span>
  );
}
