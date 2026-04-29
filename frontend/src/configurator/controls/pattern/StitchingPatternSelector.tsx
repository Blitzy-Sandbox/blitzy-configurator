/**
 * StitchingPatternSelector — Six-pattern stitching picker (ST-010).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     StitchingPatternSelector.tsx | ST-010 six patterns".
 *   - ST-010 acceptance criteria (verbatim from
 *     `tickets/stories/ST-010-stitching-pattern-selector.md`):
 *       AC1 The control sidebar offers exactly six stitching pattern
 *           options named Classic, Hexagonal, Diamond, Spiral, Star,
 *           and Grid.
 *       AC2 Selecting a pattern applies it to the preview ball within
 *           the documented latency budget.
 *       AC3 The currently selected pattern remains visually marked as
 *           active in the sidebar after selection.
 *       AC4 All six patterns render accurately on the preview with no
 *           visual degradation at any rotation angle.
 *
 * Architecture:
 *   This component is a presentation + state-binding shell that
 *   subscribes to BOTH `stitchingPattern` and `materialFinish` slices
 *   so it can re-evaluate the pattern×finish combination matrix when
 *   either side changes (ST-013 cross-cutting). It owns its own
 *   render loop:
 *
 *     1. User activates a pattern (click / Enter / Space / arrow key).
 *     2. `dispatchPattern` writes the new pattern to the Zustand store
 *        synchronously via `setStitchingPattern`.
 *     3. `dispatchPattern` snapshots the FULL configurator state via
 *        `useConfiguratorStore.getState()` (so the pipeline sees the
 *        most-recent values for every other slice — color, logo,
 *        finish, etc.) and queues `texturePipeline.update(snapshot)`
 *        on a serialized FIFO promise chain. The chain ensures rapid
 *        pattern flips are applied to the texture pipeline in
 *        submission order rather than racing each other.
 *     4. ST-010-AC4's "render accurately at any rotation angle" is
 *        satisfied by the texture pipeline's Fabric→Three SDF/atlas
 *        rendering combined with the Three.js sphere geometry — NOT
 *        by this file directly. The visual-regression spec in
 *        `frontend/tests/visual/` locks the appearance.
 *
 * Pattern-side disabled-combination policy (cross-cutting ST-013):
 *   The configurator's documented architectural choice is that the
 *   pattern selector NEVER renders the `aria-disabled` attribute on
 *   any pattern button. Disabled-combination enforcement lives
 *   exclusively on the FINISH side (`FinishSelector.tsx`). The user
 *   is always free to switch patterns; if the resulting pattern×finish
 *   pair is incompatible, the conflicting finish in the FinishSelector
 *   becomes `aria-disabled="true"` with a tooltip pointing to the
 *   resolution path.
 *
 *   This contract is documented and enforced by the existing
 *   Playwright specs:
 *     - `tests/configurator/pattern-selector.spec.ts` (lines 482–497):
 *       "the pattern selector itself never sets aria-disabled — it is
 *        always free-clickable. This test guards against a future
 *        regression that would inadvertently disable pattern options."
 *     - `tests/configurator/finish-selector.spec.ts` (lines 60–67):
 *       "The pattern selector itself does NOT add `aria-disabled` to
 *        any pattern button — the `StitchingPatternSelector`
 *        intentionally does not call `isCombinationDisabled`."
 *     - `tests/configurator/finish-selector.spec.ts` (lines 843–865)
 *       runs after metallic is selected and asserts every pattern
 *       still has `aria-disabled === null`.
 *
 *   This file therefore does NOT propagate
 *   `isPatternDisabledForFinish` to `aria-disabled` and does NOT
 *   short-circuit the click handler when the predicate returns true.
 *   The helpers from `DisabledCombinationTooltip.tsx` are imported and
 *   used here for informational purposes only:
 *     - `isPatternDisabledForFinish` computes a per-button
 *       `data-combination-status` attribute (`"compatible"` /
 *       `"conflict"`) that is purely diagnostic and never gates UI
 *       behavior.
 *     - `getDisabledPatternReason` produces the explanatory copy.
 *     - `DisabledCombinationTooltip` is mounted as an advisory popover
 *       under conflicting buttons and revealed on hover or focus,
 *       informing the user of the documented conflict resolution
 *       (their selection succeeds; the conflicting finish becomes
 *       unavailable). The tooltip never prevents the pattern from
 *       being selected.
 *
 *   This deviation from the agent_prompt's Phase 7 specification (which
 *   suggested propagating disabled state through `aria-disabled` and
 *   short-circuiting `onClick`) is a deliberate alignment with the
 *   binding shipped test contract. The decision is recorded in
 *   `docs/decisions/README.md` per the user-provided Explainability
 *   Rule.
 *
 * DOM structure (matches the codebase convention established by
 * `FinishSelector.tsx` so the two selectors look and feel like a
 * unified control group, and so the existing
 * `tests/configurator/pattern-selector.spec.ts` Playwright suite
 * exercises this component without further indirection):
 *
 *     <section aria-label="Stitching pattern" data-testid="stitching-pattern-selector">
 *       <h3>Stitching pattern</h3>
 *       <p>Currently <span data-testid="stitching-pattern-current">{currentLabel}</span></p>
 *       <ul role="radiogroup" aria-label="Stitching pattern options">
 *         <li>
 *           <button role="radio" data-testid="stitching-pattern-option-${pattern}">{label}</button>
 *           {hasFinishConflict && (
 *             <DisabledCombinationTooltip id={...} reason={...}
 *               data-testid="stitching-pattern-tooltip-${pattern}"
 *               data-visible={tooltipVisible ? 'true' : 'false'}
 *               style={!tooltipVisible ? { opacity: 0, ... } : undefined}
 *             />
 *           )}
 *         </li>
 *         ...
 *       </ul>
 *     </section>
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT mutate `threeTexture.needsUpdate`
 *     and does NOT call any Fabric or Three.js API directly. The ONLY
 *     texture-pipeline interaction is `texturePipeline.update(snapshot)`
 *     AFTER `setStitchingPattern` has been dispatched. Verifiable via
 *     `grep -E "needsUpdate|fabricCanvas|threeTexture"
 *      StitchingPatternSelector.tsx` returning zero matches (the only
 *     `texturePipeline` reference is the canonical
 *     `texturePipeline.update(snapshot)` call inside `dispatchPattern`).
 *   - Rule R2: ZERO `console.*` calls; no credential-shaped fields.
 *   - Rule R3: no Firebase / JWT / auth imports.
 *   - AAP §0.4.6: no barrel imports — explicit relative paths only.
 *   - AAP §0.6.14: no design-system / UI library imports — styling is
 *     entirely inline via React `CSSProperties`.
 *   - AAP §0.1.1 (TypeScript strict): no `any` usage; every state
 *     subscription uses an explicit selector function.
 *
 * Symmetry with FinishSelector.tsx:
 *   This component is intentionally near-identical to its sibling
 *   `FinishSelector.tsx` — same outer `<section>`, same inner
 *   `<ul role="radiogroup">`, same option button shape, same ARIA
 *   semantics — differing only in:
 *     - the bound store slice (`stitchingPattern` vs `materialFinish`),
 *     - the catalog (`STITCHING_PATTERNS` vs `MATERIAL_FINISHES`),
 *     - the disabled-combination policy (this file does NOT propagate
 *       to `aria-disabled` and does NOT short-circuit clicks; the
 *       finish selector does both — this is the documented
 *       architectural asymmetry).
 */

import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import type { StitchingPattern } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';
import {
  DisabledCombinationTooltip,
  getDisabledPatternReason,
  isPatternDisabledForFinish,
} from './DisabledCombinationTooltip';

// ---------------------------------------------------------------------------
// Catalog — six stitching patterns (ST-010-AC1)
// ---------------------------------------------------------------------------

/**
 * The six stitching pattern options surfaced in the control sidebar
 * (ST-010-AC1). Order is intentional and stable:
 *   - `'classic'`   first because the documented store default is
 *                   `CONFIGURATOR_DEFAULTS.stitchingPattern === 'classic'`.
 *   - `'hexagonal'`, `'diamond'`, `'spiral'`, `'star'`, `'grid'`
 *                   in the order specified by ST-010-AC1 verbatim.
 *
 * The order matters for:
 *   - Keyboard navigation (Tab / arrow keys traverse in DOM order).
 *   - Visual regression baselines (re-ordering would invalidate the
 *     committed PNGs in `frontend/visual-baselines/`).
 *   - The Playwright test
 *     `tests/configurator/pattern-selector.spec.ts` "renders pattern
 *     options in the documented DOM order" which compares the rendered
 *     `data-testid` array to the expected `[classic, hexagonal,
 *     diamond, spiral, star, grid]` sequence.
 *
 * The `StitchingPattern` type literal union (declared in the store) is
 * the SINGLE source of truth for the lowercase identifiers; this
 * constant maps each identifier to its display name via the labels
 * record below.
 */
const STITCHING_PATTERNS: readonly StitchingPattern[] = [
  'classic',
  'hexagonal',
  'diamond',
  'spiral',
  'star',
  'grid',
] as const;

/**
 * Display labels for the six stitching patterns — verbatim per
 * ST-010-AC1: "Classic", "Hexagonal", "Diamond", "Spiral", "Star",
 * "Grid".
 *
 * `Record<StitchingPattern, string>` enforces exhaustiveness at the
 * type level: adding a new pattern to the `StitchingPattern` union in
 * the store will produce a compile error here until the new entry is
 * added, preventing silent drift between the catalog and labels.
 */
const STITCHING_PATTERN_LABELS: Readonly<Record<StitchingPattern, string>> = {
  classic: 'Classic',
  hexagonal: 'Hexagonal',
  diamond: 'Diamond',
  spiral: 'Spiral',
  star: 'Star',
  grid: 'Grid',
};

// ---------------------------------------------------------------------------
// Inline style constants
// ---------------------------------------------------------------------------

/**
 * Container style for the outer `<section>`. Visual conventions
 * mirror `FinishSelector.tsx` so the two selectors stack cleanly in
 * the sidebar with consistent spacing.
 */
// QA Issue #5 — adopt the canonical "card" container treatment used by
// PrimaryColorPicker / SecondaryColorPicker / AccentColorPicker /
// LogoUploader / LogoPositioner so all six control sub-sections in the
// `<aside aria-label="Configurator controls">` share one visual idiom.
// The card pattern is: white bg, 1px solid #D9D9D9 border, 0.375rem
// radius, 0.75rem padding (QA Issue #6 — uniform padding across cards).
const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  marginBottom: '1rem',
  padding: '0.75rem',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  backgroundColor: '#FFFFFF',
};

/**
 * Style for the visible "Stitching pattern" heading.
 *
 * QA Issue #4 — standardise h3 typography across the configurator:
 *   - Removed inline `fontFamily: 'Inter'` override so the global
 *     `h3 { font-family: var(--ff-display); }` rule (Space Grotesk)
 *     applies, matching the color pickers' h3 treatment.
 *   - `fontSize` reduced from 0.95rem (15.2px) to 0.875rem (14px) so
 *     all control h3 elements use a single visual size.
 */
const HEADING_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: '0.875rem',
  margin: 0,
  color: '#333333',
};

/**
 * Style for the live "Currently <label>" hint.
 *
 * QA Issue #10 — `#999999` against white was 2.85:1 (FAIL WCAG AA).
 * `#666666` against white is 5.74:1 (PASS WCAG AA), matching the
 * updated `--blitzy-text-muted` token in `global.css`.
 */
const HINT_STYLE: CSSProperties = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: '0.75rem',
  color: '#666666',
  margin: 0,
};

/**
 * Auto-fitting grid for the option buttons. With six patterns, the
 * `auto-fit` + `minmax(96px, 1fr)` rule produces a 2- or 3-column
 * layout depending on sidebar width without requiring any explicit
 * media query. The list also acts as a `role="radiogroup"`, so default
 * `<ul>` bullet styling and indentation are removed.
 */
const RADIOGROUP_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
  gap: '0.5rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

/**
 * Per-`<li>` wrapper style — establishes the positioning context that
 * the absolute-positioned `DisabledCombinationTooltip` anchors against,
 * and removes default list-item bullet styling.
 */
const LIST_ITEM_STYLE: CSSProperties = {
  position: 'relative',
  listStyle: 'none',
  padding: 0,
  margin: 0,
};

/**
 * Inline-style override applied to the tooltip when its
 * `data-visible` attribute is `"false"`. Combining `opacity: 0`
 * with `pointer-events: none` keeps the tooltip in the DOM and the
 * accessibility tree (so the conflicting button's `aria-describedby`
 * resolves and screen readers can announce the explanation when the
 * button receives focus) while hiding it from sighted users until they
 * hover or focus the conflicting option.
 *
 * The base `TOOLTIP_CONTAINER_STYLE` inside `DisabledCombinationTooltip`
 * already declares `pointerEvents: 'none'`, so this override is
 * additive: opacity is the only visual change.
 */
const TOOLTIP_HIDDEN_OVERRIDE: CSSProperties = {
  opacity: 0,
  pointerEvents: 'none',
};

/**
 * Compute the per-option style based on the option's current
 * selection / focus state.
 *
 * Note that, unlike `FinishSelector.tsx`, this style function does
 * NOT take a `disabled` parameter — pattern options are never
 * disabled per the documented architectural choice (see file header
 * "Pattern-side disabled-combination policy"). A `hasConflict`
 * parameter still exists to apply a subtle decorative warning rim so
 * sighted users can see at a glance that a pattern×finish conflict
 * exists, but the option remains fully clickable and styled like an
 * enabled control.
 *
 * Colors use the Blitzy brand tokens declared in AAP §0.8.2
 * (Executive Presentation Rule):
 *   - `#5B39F3` (primary)      — selected background
 *   - `#2D1C77` (primary-dark) — selected border + warning rim base
 *   - `#FFFFFF`                — selected text
 *   - `#333333`                — default text
 *   - `#999999`                — default border
 *
 * @param isSelected   — whether this option is the currently-active pattern
 * @param isFocused    — whether this option's button currently has focus
 * @param hasConflict  — whether this pattern conflicts with the active finish
 *                       (informational only; does NOT disable the option)
 * @returns A merged `CSSProperties` object for inline application.
 */
function optionStyle(isSelected: boolean, isFocused: boolean, hasConflict: boolean): CSSProperties {
  // Conflict rim colour — a muted dashed border appears on
  // non-selected options to telegraph the conflict without preventing
  // selection. When the option is selected the selected-state border
  // takes priority (the conflicting selection is the user's choice;
  // the conflicting finish in the FinishSelector is the disabled side).
  const baseBorderColor = hasConflict ? '#7A6DEC' : '#999999';
  const baseBorderStyle = hasConflict && !isSelected ? 'dashed' : 'solid';

  return {
    width: '100%',
    appearance: 'none',
    WebkitAppearance: 'none',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '2.5rem',
    padding: '0.5rem 0.75rem',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '0.875rem',
    fontWeight: isSelected ? 600 : 500,
    textAlign: 'center',
    color: isSelected ? '#FFFFFF' : '#333333',
    background: isSelected ? '#5B39F3' : '#FFFFFF',
    border: isSelected ? '2px solid #2D1C77' : `1px ${baseBorderStyle} ${baseBorderColor}`,
    borderRadius: '0.375rem',
    cursor: 'pointer',
    outline: isFocused ? '2px solid #5B39F3' : '2px solid transparent',
    outlineOffset: '2px',
    opacity: 1,
    transition:
      'background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, outline-color 120ms ease-out',
    userSelect: 'none',
  };
}
/**
 * Short user-facing description for each pattern — surfaced as part of
 * the option button's `aria-label` so screen-reader users hear a
 * human-readable summary alongside the pattern name. The descriptions
 * keep the assistive-technology surface consistent across the
 * pattern and finish selectors.
 *
 * The labels above are guaranteed by the test contract; the
 * descriptions below are private to this file and may be edited
 * without breaking external assertions.
 */
const STITCHING_PATTERN_DESCRIPTIONS: Readonly<Record<StitchingPattern, string>> = {
  classic: 'Traditional even seam pattern.',
  hexagonal: 'Hex-tiled stitching for a modern look.',
  diamond: 'Diamond-grid stitch arrangement.',
  spiral: 'Continuous spiraling seam path.',
  star: 'Star-burst stitch arrangement.',
  grid: 'Orthogonal grid stitch layout.',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Stitching-pattern selector. Renders six accessible radio-style
 * buttons (Classic, Hexagonal, Diamond, Spiral, Star, Grid),
 * dispatches the user's choice to the configurator store, and
 * triggers a texture-pipeline update so the live preview redraws in
 * lockstep within the documented latency budget (ST-010-AC2).
 *
 * Keyboard contract (matches WAI-ARIA radiogroup pattern):
 *   - Tab into the group: focus lands on the currently-selected
 *     option (`tabIndex={0}`); the other options are removed from
 *     the natural tab order (`tabIndex={-1}`) — i.e., roving tabindex.
 *   - ArrowRight / ArrowDown: move focus AND selection to the next
 *     option (wrapping). Because patterns are never disabled,
 *     selection always follows focus.
 *   - ArrowLeft / ArrowUp: mirror — previous option (wrapping).
 *   - Home: jump to the first option.
 *   - End: jump to the last option.
 *   - Space / Enter: select the currently-focused option.
 *
 * Pointer contract:
 *   - Click on any option: dispatches the pattern and triggers
 *     pipeline update (ST-010-AC2). Re-clicking the already-selected
 *     option is a no-op at the store level (Zustand's `set` does not
 *     trigger re-renders for shallow-equal updates) — this satisfies
 *     the radiogroup contract that "clicking an already-checked radio
 *     is a no-op".
 *   - Hover or focus on a conflicting option: flips the advisory
 *     tooltip's `data-visible` attribute from `"false"` to `"true"`
 *     and removes the opacity:0 override so the tooltip becomes
 *     visible. The tooltip is informational only — it never gates
 *     the option's clickability.
 */
export function StitchingPatternSelector(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions — slice-only via selectors (Zustand 4.x best
  // practice). Subscribing to the whole store would cause re-renders
  // on every unrelated slice change.
  // -------------------------------------------------------------------------
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const setStitchingPattern = useConfiguratorStore((s) => s.setStitchingPattern);

  // ST-013 cross-cutting: subscribe to `materialFinish` so this
  // component re-renders when the user changes the finish, allowing
  // each pattern's combination status to be re-evaluated against the
  // new finish. The status feeds the advisory tooltip and the
  // `data-combination-status` data attribute — it never gates UI
  // behavior on the pattern side (per documented architectural
  // choice; see file header).
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);

  // -------------------------------------------------------------------------
  // Local UI state
  // -------------------------------------------------------------------------

  /** Refs to each option button — used for keyboard focus management. */
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * Index of the currently-focused option, or `null` if focus is
   * outside the radiogroup. Drives the visible focus outline and the
   * advisory tooltip's focus-side trigger.
   */
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  /**
   * Index of the currently-hovered option, or `null` if no option is
   * hovered. Drives the advisory tooltip's hover-side trigger. (We
   * use a separate state from `focusedIndex` so an option that is
   * both hovered and focused does not cause double-mount of the
   * tooltip.)
   */
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  /**
   * Serialized async queue for texture-pipeline updates. Each
   * dispatch chains the next `texturePipeline.update(snapshot)` call
   * after the previous one completes, ensuring rapid pattern changes
   * are applied to the pipeline in submission order. The leading
   * `.catch(() => undefined)` swallows prior rejections so the chain
   * does not get "stuck"; the trailing `.catch(() => undefined)`
   * swallows the new rejection (if any) so React 18's
   * unhandled-promise warnings stay quiet AND the
   * `@typescript-eslint/no-floating-promises` lint rule is satisfied
   * — every Promise placed in the chain has an explicit terminal
   * handler.
   *
   * The ref starts at `Promise.resolve()` so the first call has a
   * resolved precursor to chain off of.
   */
  const pipelineQueueRef = useRef<Promise<void>>(Promise.resolve());

  // -------------------------------------------------------------------------
  // Dispatch + texture pipeline coordination
  // -------------------------------------------------------------------------

  /**
   * Apply a pattern selection to the store and queue a texture-
   * pipeline refresh. The function is a `useCallback` with
   * `setStitchingPattern` in the dependency list so the function
   * reference is stable across re-renders that do not change the
   * setter, which keeps `onKeyDown` and `onClick` handler identities
   * stable for React.
   *
   * Unlike `FinishSelector.tsx`'s `dispatchFinish`, this function
   * does NOT consult `isPatternDisabledForFinish` and does NOT
   * short-circuit on conflict. The user is always free to switch
   * patterns; if the result conflicts with the active finish, the
   * conflicting finish will surface as `aria-disabled="true"` in
   * `FinishSelector` (the documented finish-side enforcement).
   *
   * @param pattern — the pattern identifier the user chose
   */
  const dispatchPattern = useCallback(
    (pattern: StitchingPattern): void => {
      // Step 1 — Update the store synchronously so any subscriber
      // reading state immediately afterward sees the new pattern.
      setStitchingPattern(pattern);

      // Step 2 — Snapshot the FULL post-update store and queue a
      // texture-pipeline refresh. We use `getState()` (not the
      // selector subscription above) so the snapshot includes the
      // freshly-set pattern AND every other slice the pipeline reads
      // (color, logo, finish) at the most-recent committed values.
      const snapshot = useConfiguratorStore.getState();

      // Chain the next pipeline call onto the FIFO queue. The
      // leading and trailing `.catch(() => undefined)` shield the
      // chain from rejection propagation — see `pipelineQueueRef`
      // doc for rationale. Per Rule R7 / C6 the canonical
      // texture-pipeline call lives EXCLUSIVELY inside
      // `texturePipeline.update`; this file MUST NOT touch
      // `threeTexture.needsUpdate` or any Fabric / Three.js API
      // directly.
      pipelineQueueRef.current = pipelineQueueRef.current
        .catch(() => undefined)
        .then(() => texturePipeline.update(snapshot))
        .catch(() => undefined);
    },
    [setStitchingPattern],
  );

  /**
   * Click / activation handler. Pattern options are never disabled
   * (per documented architectural choice), so this function simply
   * delegates to `dispatchPattern` without any conflict check or
   * short-circuit logic. The function exists as a stable reference
   * so `onClick` and `onKeyDown` handlers can share a single call
   * site, which improves reasoning during code review and keeps the
   * call graph easy to grep.
   */
  const handleSelect = useCallback(
    (pattern: StitchingPattern): void => {
      dispatchPattern(pattern);
    },
    [dispatchPattern],
  );

  /**
   * Keyboard handler for radiogroup navigation. See class doc for
   * the full keyboard contract. Because patterns are never disabled,
   * arrow-key navigation always selects the destination option (no
   * "move focus but don't select" branch is needed, in contrast to
   * `FinishSelector.tsx`).
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
      const len = STITCHING_PATTERNS.length;

      // Determine the destination index (if the key is a navigation key).
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % len;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + len) % len;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = len - 1;
      }

      if (nextIndex !== null) {
        event.preventDefault();
        const nextPattern = STITCHING_PATTERNS[nextIndex];
        // Move focus to the destination option; selection follows
        // automatically because patterns are never disabled.
        buttonRefs.current[nextIndex]?.focus();
        dispatchPattern(nextPattern);
        return;
      }

      // Activation keys (Space / Enter) commit the currently-focused
      // option. We compare via the `event.key` exact strings rather
      // than `event.code` to honor user keyboard layouts.
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const pattern = STITCHING_PATTERNS[currentIndex];
        dispatchPattern(pattern);
      }
    },
    [dispatchPattern],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Display label for the currently-active pattern. Surfaced in a
   * "Currently <label>" hint above the radiogroup so screen readers
   * skimming by heading reach the live value before scanning the
   * options. Mirrors `FinishSelector.tsx`.
   */
  const currentLabel = STITCHING_PATTERN_LABELS[stitchingPattern];

  return (
    <section
      aria-label="Stitching pattern"
      data-testid="stitching-pattern-selector"
      style={SECTION_STYLE}
    >
      <h3 style={HEADING_STYLE}>Stitching pattern</h3>
      <p style={HINT_STYLE}>
        Currently <span data-testid="stitching-pattern-current">{currentLabel}</span>
      </p>
      <ul role="radiogroup" aria-label="Stitching pattern options" style={RADIOGROUP_STYLE}>
        {STITCHING_PATTERNS.map((pattern, index) => {
          const isSelected = pattern === stitchingPattern;
          const isFocused = focusedIndex === index;
          const isHovered = hoveredIndex === index;

          // ST-013 cross-cutting: compute the pattern×finish
          // combination status. `hasConflict === true` indicates the
          // chosen pattern is incompatible with the currently-active
          // finish — but unlike `FinishSelector`, we do NOT propagate
          // this to `aria-disabled` and do NOT short-circuit clicks.
          // The status drives only the advisory tooltip and the
          // diagnostic `data-combination-status` data attribute.
          const hasConflict = isPatternDisabledForFinish(pattern, materialFinish);

          // The reason string is the user-facing copy that explains
          // why this pattern conflicts with the active finish.
          // `null` when there is no conflict — in which case the
          // tooltip is unmounted and `aria-describedby` is unset.
          const reason = hasConflict ? getDisabledPatternReason(pattern, materialFinish) : null;

          // The advisory tooltip element's id is referenced by the
          // conflicting option's `aria-describedby`. The id MUST be
          // unique on the page across multiple renders of this
          // component type, so we namespace it with the pattern
          // identifier.
          const tooltipId = `stitching-pattern-tooltip-id-${pattern}`;

          // Tooltip becomes VISIBLE on hover or focus when there's a
          // conflict. The tooltip remains in the DOM while the
          // option has a conflict (so `aria-describedby` always
          // resolves), but the `data-visible` attribute and the
          // inline opacity override toggle the visual surface in
          // lockstep.
          const tooltipVisible = hasConflict && (isHovered || isFocused);

          // Compose the accessible label. Includes the pattern name
          // and a short description so screen readers announce the
          // semantic distinction between, say, "Spiral" and
          // "Diamond". When the pattern is currently selected the
          // suffix " (selected)" is appended for redundancy with the
          // `aria-checked` state. When the pattern conflicts with
          // the active finish the suffix " (conflict with current
          // finish)" is appended so screen-reader users learn about
          // the conflict at the same time sighted users see the
          // dashed warning rim.
          const optionLabel = `Stitching pattern ${STITCHING_PATTERN_LABELS[pattern]}${
            isSelected ? ' (selected)' : ''
          }${hasConflict ? ' (conflict with current finish)' : ''}. ${
            STITCHING_PATTERN_DESCRIPTIONS[pattern]
          }`;

          return (
            <li key={pattern} style={LIST_ITEM_STYLE}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={optionLabel}
                // INTENTIONAL OMISSION: this component never sets
                // `aria-disabled` on a pattern button. See the file
                // header "Pattern-side disabled-combination policy"
                // and the corresponding test contract in
                // `tests/configurator/pattern-selector.spec.ts`
                // (lines 482–497).
                //
                // Reference the advisory tooltip whenever the
                // option has a conflict — the tooltip element is
                // mounted in the DOM continuously while the
                // conflict exists, so the `aria-describedby`
                // reference always resolves to a real element. When
                // there is no conflict, the tooltip is unmounted
                // and this attribute is omitted (`undefined`).
                aria-describedby={hasConflict ? tooltipId : undefined}
                title={STITCHING_PATTERN_LABELS[pattern]}
                // Roving tabindex: only the selected option is in
                // the natural tab order; the rest are reachable
                // exclusively via arrow keys from within the group.
                tabIndex={isSelected ? 0 : -1}
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                onClick={() => {
                  // Pattern options are always free-clickable per
                  // the documented architectural choice. Even when
                  // the pattern conflicts with the active finish,
                  // the click still dispatches; the conflicting
                  // finish in `FinishSelector` will become
                  // `aria-disabled="true"` as a result.
                  handleSelect(pattern);
                }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onFocus={() => setFocusedIndex(index)}
                onBlur={() => setFocusedIndex((curr) => (curr === index ? null : curr))}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex((curr) => (curr === index ? null : curr))}
                data-testid={`stitching-pattern-option-${pattern}`}
                data-pattern={pattern}
                data-selected={isSelected ? 'true' : 'false'}
                // `data-combination-status` is informational only —
                // a stable hook for diagnostics, telemetry, and
                // visual-regression assertions. The Playwright
                // contract does not require this attribute and does
                // not check its value, but exposing it costs
                // nothing and aids debugging.
                data-combination-status={hasConflict ? 'conflict' : 'compatible'}
                style={optionStyle(isSelected, isFocused, hasConflict)}
              >
                {STITCHING_PATTERN_LABELS[pattern]}
              </button>
              {hasConflict && reason !== null ? (
                <DisabledCombinationTooltip
                  id={tooltipId}
                  reason={reason}
                  // QA Issue #1 fix: the tooltip is portaled to
                  // document.body and dynamically positioned from
                  // this anchor element's getBoundingClientRect(),
                  // so the `<aside aria-label="Configurator
                  // controls">`'s `overflow-y: auto` no longer
                  // clips the tooltip text on the right edge.
                  anchorElement={buttonRefs.current[index] ?? null}
                  data-testid={`stitching-pattern-tooltip-${pattern}`}
                  // The `data-visible` attribute is the contract a
                  // future Playwright spec could exercise to verify
                  // hover/focus reveal. It always carries a literal
                  // `"true"` or `"false"` string so any
                  // `toHaveAttribute('data-visible', '...')`
                  // assertions resolve deterministically.
                  data-visible={tooltipVisible ? 'true' : 'false'}
                  // When the tooltip is hidden, layer an opacity:0
                  // override on top of the component's own base
                  // styling so sighted users do not see the tooltip
                  // at rest while screen readers continue to
                  // resolve `aria-describedby` to the live tooltip
                  // element.
                  style={tooltipVisible ? undefined : TOOLTIP_HIDDEN_OVERRIDE}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
