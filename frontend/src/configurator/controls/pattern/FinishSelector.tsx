/**
 * FinishSelector — Three-finish material picker (ST-011) with disabled-
 * combination enforcement (ST-013) and texture-pipeline orchestration
 * (Rule R7 / C6).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     FinishSelector.tsx | Three finishes (matte, glossy, metallic)".
 *   - ST-011 acceptance criteria (verbatim from
 *     `tickets/stories/ST-011-material-finish-selector.md`):
 *       AC1 The control sidebar offers exactly three material finish
 *           options named Matte, Glossy, and Metallic.
 *       AC2 Selecting a finish applies it to the preview ball within
 *           the documented latency budget.
 *       AC3 The currently selected finish remains visually marked as
 *           active in the sidebar after selection.
 *       AC4 Each of the three finishes visibly changes how light
 *           interacts with the ball's surface on the preview.
 *   - ST-013 acceptance criteria (cross-cutting): unsupported
 *     pattern × finish pairs render the conflicting finish in a
 *     disabled visual state with a hover/focus tooltip; clicking a
 *     disabled finish produces no change; when the user changes the
 *     stitching pattern such that a finish becomes supported, the
 *     finish's `aria-disabled` flips back to `false`.
 *
 * Architecture:
 *   This component is a presentation + state-binding shell that
 *   subscribes to BOTH `materialFinish` and `stitchingPattern` slices
 *   so it can re-evaluate disabled state when the pattern changes
 *   (ST-013-AC4). It owns its own render loop:
 *
 *     1. User activates a finish (click / Enter / Space / arrow key).
 *     2. `dispatchFinish` writes the new finish to the Zustand store
 *        synchronously via `setMaterialFinish`.
 *     3. `dispatchFinish` snapshots the FULL configurator state via
 *        `useConfiguratorStore.getState()` (so the pipeline sees the
 *        most-recent values for every other slice — color, logo, etc.)
 *        and queues `texturePipeline.update(snapshot)` on a serialized
 *        FIFO promise chain. The chain ensures rapid finish flips
 *        (e.g., user mashing the keyboard) are applied to the texture
 *        pipeline in submission order rather than racing each other.
 *     4. ST-011-AC4's visible light-interaction differences are
 *        produced by the Three.js material-parameter changes that
 *        `Sphere.tsx` applies based on the store's `materialFinish`
 *        value — NOT by this file directly.
 *
 *   Disabled finishes:
 *     - have `aria-disabled="true"` (NOT native `disabled`, which
 *       would remove the option from the tab order — ST-013 requires
 *       keyboard-focusable disabled options),
 *     - render the `DisabledCombinationTooltip` continuously while
 *       the option is disabled (so screen readers can resolve the
 *       `aria-describedby` reference even before the user hovers or
 *       focuses), but the tooltip's `data-visible` attribute toggles
 *       between `"true"` and `"false"` based on hover/focus, and an
 *       opacity:0 inline-style override hides the tooltip from sighted
 *       users until the disabled control is engaged. This is the
 *       documented "tooltip-by-attribute" pattern that the sibling
 *       Playwright spec exercises.
 *     - have `onClick` short-circuited so the store state never
 *       changes when the user clicks a disabled finish (ST-013-AC3).
 *
 * DOM structure (matches the codebase convention established by
 * `StitchingPatternSelector.tsx` so the two selectors look and feel
 * like a unified control group, and so the existing
 * `tests/configurator/finish-selector.spec.ts` Playwright suite
 * exercises this component without further indirection):
 *
 *     <section aria-label="Material finish" data-testid="finish-selector">
 *       <h3>Material finish</h3>
 *       <p>Currently <span>{currentLabel}</span></p>
 *       <ul role="radiogroup" aria-label="Material finish options">
 *         <li>
 *           <button role="radio" data-testid="finish-option-${finish}">{label}</button>
 *           {isDisabled && (
 *             <DisabledCombinationTooltip id={...} reason={...}
 *               data-testid="finish-tooltip-${finish}"
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
 *     AFTER `setMaterialFinish` has been dispatched. Verifiable via
 *     `grep -E "needsUpdate|fabricCanvas|threeTexture" FinishSelector.tsx`
 *     returning zero matches (the only `texturePipeline` reference is
 *     the canonical `texturePipeline.update(snapshot)` call inside
 *     `dispatchFinish`).
 *   - Rule R2: ZERO `console.*` calls; no credential-shaped fields.
 *   - Rule R3: no Firebase / JWT / auth imports.
 *   - AAP §0.4.6: no barrel imports — explicit relative paths only.
 *   - AAP §0.6.14: no design-system / UI library imports — styling is
 *     entirely inline via React `CSSProperties`.
 *   - AAP §0.1.1 (TypeScript strict): no `any` usage; every state
 *     subscription uses an explicit selector function.
 *
 * Symmetry with StitchingPatternSelector.tsx:
 *   This component is intentionally near-identical to its sibling
 *   `StitchingPatternSelector.tsx` — same outer `<section>`, same
 *   inner `<ul role="radiogroup">`, same option button shape, same
 *   ARIA semantics — differing only in the bound store slice
 *   (`materialFinish` vs `stitchingPattern`), the catalog
 *   (`MATERIAL_FINISHES` vs `STITCHING_PATTERNS`), the disabled-
 *   combination helpers (`isFinishDisabledForPattern` vs the mirror
 *   pattern-side predicate), and the texture-pipeline call (which
 *   the pattern selector deliberately omits per its own header
 *   documentation; the finish selector owns its own pipeline call
 *   here so finish changes refresh the canvas-backed material map).
 */

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import type { MaterialFinish } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';
import {
  DisabledCombinationTooltip,
  getDisabledFinishReason,
  isFinishDisabledForPattern,
} from './DisabledCombinationTooltip';

// ---------------------------------------------------------------------------
// Catalog — three material finishes (ST-011-AC1)
// ---------------------------------------------------------------------------

/**
 * The three material finish options surfaced in the control sidebar
 * (ST-011-AC1). Order is intentional and stable:
 *   - `'matte'`    first because the documented store default is
 *                  `CONFIGURATOR_DEFAULTS.materialFinish === 'matte'`.
 *   - `'glossy'`   second — increasing visual "flair" left-to-right.
 *   - `'metallic'` third — most reflective.
 *
 * The `MaterialFinish` type literal union (declared in the store) is
 * the SINGLE source of truth for the lowercase identifiers; this
 * constant maps each identifier to its display name via the labels
 * record below.
 *
 * Each finish drives Three.js material parameters in `Sphere.tsx`
 * (NOT in this file):
 *   - matte:    high roughness, no metalness   — diffuse surface.
 *   - glossy:   low roughness, no metalness    — clear-coat highlights.
 *   - metallic: low roughness, full metalness  — chrome / foil look.
 *
 * The visible light-interaction differences (ST-011-AC4) are produced
 * by those material-parameter changes; this file is responsible only
 * for dispatching the user's choice and refreshing the texture
 * pipeline so the canvas-backed material map redraws in lockstep.
 */
const MATERIAL_FINISHES: readonly MaterialFinish[] = [
  'matte',
  'glossy',
  'metallic',
] as const;

/**
 * Display labels for the three material finishes — verbatim per
 * ST-011-AC1: "Matte", "Glossy", "Metallic".
 *
 * `Record<MaterialFinish, string>` enforces exhaustiveness at the
 * type level: adding a new finish to the `MaterialFinish` union in
 * the store will produce a compile error here until the new entry
 * is added, preventing silent drift between the catalog and labels.
 */
const MATERIAL_FINISH_LABELS: Readonly<Record<MaterialFinish, string>> = {
  matte: 'Matte',
  glossy: 'Glossy',
  metallic: 'Metallic',
};

// ---------------------------------------------------------------------------
// Inline style constants
// ---------------------------------------------------------------------------

/**
 * Container style for the outer `<section>`. Visual conventions
 * mirror `StitchingPatternSelector.tsx` so the two selectors stack
 * cleanly in the sidebar with consistent spacing.
 */
const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  marginBottom: '1rem',
};

/** Style for the visible "Material finish" heading. */
const HEADING_STYLE: CSSProperties = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontWeight: 600,
  fontSize: '0.95rem',
  margin: 0,
  color: '#333333',
};

/** Style for the live "Currently <label>" hint. */
const HINT_STYLE: CSSProperties = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: '0.75rem',
  color: '#999999',
  margin: 0,
};

/**
 * Auto-fitting grid for the option buttons. With exactly three
 * finishes, a single row of equal-width columns fills the sidebar
 * cleanly without wrapping at typical sidebar widths. The list is
 * also a `role="radiogroup"`, so default `<ul>` bullet styling and
 * indentation are removed.
 */
const RADIOGROUP_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(64px, 1fr))',
  gap: '0.5rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

/**
 * Per-`<li>` wrapper style — establishes the positioning context
 * the absolute-positioned `DisabledCombinationTooltip` anchors
 * against, and removes default list-item bullet styling.
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
 * accessibility tree (so the disabled button's `aria-describedby`
 * resolves and screen readers can announce the explanation when
 * the button receives focus) while hiding it from sighted users
 * until they hover or focus the disabled option.
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
 * selection / focus / disabled state.
 *
 * Colors use the Blitzy brand tokens declared in AAP §0.8.2
 * (Executive Presentation Rule):
 *   - `#5B39F3` (primary)      — selected background
 *   - `#2D1C77` (primary-dark) — selected border
 *   - `#FFFFFF`                — selected text
 *   - `#333333`                — default text
 *   - `#999999`                — default border + disabled text
 *   - `#F5F5F5`                — disabled background
 *
 * @param isSelected  — whether this option is the currently-active finish
 * @param isFocused   — whether this option's button currently has focus
 * @param isDisabled  — whether this option is disabled by the active pattern
 * @returns A merged `CSSProperties` object for inline application.
 */
function optionStyle(
  isSelected: boolean,
  isFocused: boolean,
  isDisabled: boolean,
): CSSProperties {
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
    color: isDisabled ? '#999999' : isSelected ? '#FFFFFF' : '#333333',
    background: isDisabled ? '#F5F5F5' : isSelected ? '#5B39F3' : '#FFFFFF',
    border: isSelected ? '2px solid #2D1C77' : '1px solid #999999',
    borderRadius: '0.375rem',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    outline: isFocused ? '2px solid #5B39F3' : '2px solid transparent',
    outlineOffset: '2px',
    opacity: isDisabled ? 0.55 : 1,
    transition:
      'background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, outline-color 120ms ease-out',
    userSelect: 'none',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Material-finish selector. Renders three accessible radio-style
 * buttons (Matte, Glossy, Metallic), dispatches the user's choice to
 * the configurator store, and triggers a texture-pipeline update so
 * the live preview redraws in lockstep.
 *
 * Keyboard contract (matches WAI-ARIA radiogroup pattern):
 *   - Tab into the group: focus lands on the currently-selected
 *     option (`tabIndex={0}`); the other options are removed from
 *     the natural tab order (`tabIndex={-1}`) — i.e., roving tabindex.
 *   - ArrowRight / ArrowDown: move focus AND selection to the next
 *     option (wrapping). If the next option is disabled, focus moves
 *     but selection does NOT change (ST-013-AC3 in keyboard form).
 *   - ArrowLeft / ArrowUp: mirror — previous option (wrapping).
 *   - Home: jump to the first option.
 *   - End: jump to the last option.
 *   - Space / Enter: select the currently-focused option (no-op when
 *     the option is disabled).
 *
 * Pointer contract:
 *   - Click on enabled option: dispatches the finish and triggers
 *     pipeline update (ST-011-AC2).
 *   - Click on disabled option: no-op (ST-013-AC3); the tooltip is
 *     already revealed because hover triggered it.
 *   - Hover or focus on disabled option: flips the tooltip's
 *     `data-visible` attribute from `"false"` to `"true"` and
 *     removes the opacity:0 override so the tooltip becomes visible.
 */
export function FinishSelector(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions — slice-only via selectors (Zustand 4.x best
  // practice). Subscribing to the whole store would cause re-renders
  // on every unrelated slice change.
  // -------------------------------------------------------------------------
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);
  const setMaterialFinish = useConfiguratorStore((s) => s.setMaterialFinish);

  // ST-013-AC4: subscribe to `stitchingPattern` so this component
  // re-renders when the user changes the pattern, allowing each
  // finish's disabled-state to be re-evaluated against the new
  // pattern.
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);

  // -------------------------------------------------------------------------
  // Local UI state
  // -------------------------------------------------------------------------

  /** Refs to each option button — used for keyboard focus management. */
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * Index of the currently-focused option, or `null` if focus is
   * outside the radiogroup. Drives the visible focus outline and the
   * tooltip's focus-side trigger.
   */
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  /**
   * Index of the currently-hovered option, or `null` if no option is
   * hovered. Drives the tooltip's hover-side trigger. (We use a
   * separate state from `focusedIndex` so an option that is both
   * hovered and focused does not cause double-mount of the tooltip.)
   */
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  /**
   * Serialized async queue for texture-pipeline updates. Each
   * dispatch chains the next `texturePipeline.update(snapshot)` call
   * after the previous one completes, ensuring rapid finish changes
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
   * Apply a finish selection to the store and queue a texture-pipeline
   * refresh. The function is a `useCallback` with `setMaterialFinish`
   * and `stitchingPattern` in the dependency list so:
   *   - The function reference is stable across re-renders that do
   *     not change those two values, which keeps `onKeyDown` and
   *     `onClick` handler identities stable for React.
   *   - When `stitchingPattern` changes, the closure captures the
   *     fresh value so the disabled-check uses the up-to-date
   *     pattern. (Without this dep, a stale closure could allow a
   *     dispatch for a finish that became disabled mid-render.)
   *
   * @param finish — the finish identifier the user chose
   */
  const dispatchFinish = useCallback(
    (finish: MaterialFinish): void => {
      // Defensive guard — never dispatch a disabled finish even if a
      // path bypassed the per-handler check. ST-013-AC3.
      if (isFinishDisabledForPattern(finish, stitchingPattern)) {
        return;
      }

      // Step 1 — Update the store synchronously so any subscriber
      // reading state immediately afterward sees the new finish.
      setMaterialFinish(finish);

      // Step 2 — Snapshot the FULL post-update store and queue a
      // texture-pipeline refresh. We use `getState()` (not the
      // selector subscription above) so the snapshot includes the
      // freshly-set finish AND every other slice the pipeline reads
      // (color, logo, pattern) at the most-recent committed values.
      const snapshot = useConfiguratorStore.getState();

      // Chain the next pipeline call onto the FIFO queue. The
      // leading and trailing `.catch(() => undefined)` shield the
      // chain from rejection propagation — see `pipelineQueueRef`
      // doc for rationale.
      pipelineQueueRef.current = pipelineQueueRef.current
        .catch(() => undefined)
        .then(() => texturePipeline.update(snapshot))
        .catch(() => undefined);
    },
    [setMaterialFinish, stitchingPattern],
  );

  /**
   * Click / activation handler for an enabled option. Disabled-option
   * clicks are short-circuited inline at the `onClick` site (NOT via
   * this function) so the disabled visual feedback is unmistakable
   * in the call graph.
   */
  const handleSelect = useCallback(
    (finish: MaterialFinish): void => {
      dispatchFinish(finish);
    },
    [dispatchFinish],
  );

  /**
   * Keyboard handler for radiogroup navigation. See class doc for
   * the full keyboard contract.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
      const len = MATERIAL_FINISHES.length;

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
        const nextFinish = MATERIAL_FINISHES[nextIndex];
        // Move focus regardless — disabled options remain in the
        // tab order (ST-013) so the user can read the tooltip.
        buttonRefs.current[nextIndex]?.focus();
        // Selection only follows focus when the destination is
        // enabled (ST-013-AC3 in keyboard form).
        if (!isFinishDisabledForPattern(nextFinish, stitchingPattern)) {
          dispatchFinish(nextFinish);
        }
        return;
      }

      // Activation keys (Space / Enter) commit the currently-focused
      // option. We compare via the `event.key` exact strings rather
      // than `event.code` to honor user keyboard layouts.
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const finish = MATERIAL_FINISHES[currentIndex];
        if (!isFinishDisabledForPattern(finish, stitchingPattern)) {
          dispatchFinish(finish);
        }
      }
    },
    [dispatchFinish, stitchingPattern],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Display label for the currently-active finish. Surfaced in a
   * "Currently <label>" hint above the radiogroup so screen readers
   * skimming by heading reach the live value before scanning the
   * options. Mirrors `StitchingPatternSelector.tsx`.
   */
  const currentLabel = MATERIAL_FINISH_LABELS[materialFinish];

  return (
    <section
      aria-label="Material finish"
      data-testid="finish-selector"
      style={SECTION_STYLE}
    >
      <h3 style={HEADING_STYLE}>Material finish</h3>
      <p style={HINT_STYLE}>
        Currently <span data-testid="finish-selector-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Material finish options"
        style={RADIOGROUP_STYLE}
      >
        {MATERIAL_FINISHES.map((finish, index) => {
          const isSelected = finish === materialFinish;
          const isFocused = focusedIndex === index;
          const isHovered = hoveredIndex === index;
          const isDisabled = isFinishDisabledForPattern(finish, stitchingPattern);
          // The reason string is the user-facing copy that explains
          // why this finish is currently unavailable. `null` when
          // the finish is enabled — in which case the tooltip is
          // unmounted and `aria-describedby` is unset.
          const reason = isDisabled
            ? getDisabledFinishReason(finish, stitchingPattern)
            : null;
          // The tooltip element's id is referenced by the disabled
          // option's `aria-describedby`. The id MUST be unique on
          // the page across multiple renders of this component
          // type, so we namespace it with the finish identifier.
          const tooltipId = `finish-tooltip-id-${finish}`;
          // ST-013-AC2: tooltip becomes VISIBLE on hover or focus.
          // The tooltip remains in the DOM while the option is
          // disabled (so `aria-describedby` always resolves), but
          // the `data-visible` attribute and the inline opacity
          // override toggle the visual surface in lockstep.
          const tooltipVisible = isDisabled && (isHovered || isFocused);
          const optionLabel = `Material finish: ${MATERIAL_FINISH_LABELS[finish]}${
            isSelected ? ' (selected)' : ''
          }${isDisabled ? ' (unavailable)' : ''}`;

          return (
            <li key={finish} style={LIST_ITEM_STYLE}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={optionLabel}
                // `aria-disabled={isDisabled || undefined}` renders
                // as `aria-disabled="true"` when disabled and omits
                // the attribute entirely when enabled. This matches
                // the contract the spec exercises via
                // `expectAriaDisabledFalsy` (which accepts both
                // `null` and `'false'`).
                aria-disabled={isDisabled || undefined}
                // Reference the tooltip whenever the option is
                // disabled — the tooltip element is mounted in the
                // DOM continuously while disabled, so the
                // `aria-describedby` reference always resolves to a
                // real element. When the option is enabled, the
                // tooltip is unmounted and this attribute is
                // omitted (`undefined`), which the spec verifies
                // returns `null` from `getAttribute`.
                aria-describedby={isDisabled ? tooltipId : undefined}
                // Roving tabindex: only the selected option is in
                // the natural tab order; the rest are reachable
                // exclusively via arrow keys from within the group.
                tabIndex={isSelected ? 0 : -1}
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                onClick={() => {
                  if (isDisabled) {
                    // ST-013-AC3 — clicking a disabled option must
                    // produce no state change. The tooltip is
                    // already mounted; hover / focus events are
                    // already revealing it for pointer / keyboard
                    // users; no further action is required here.
                    return;
                  }
                  handleSelect(finish);
                }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onFocus={() => setFocusedIndex(index)}
                onBlur={() =>
                  setFocusedIndex((curr) => (curr === index ? null : curr))
                }
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() =>
                  setHoveredIndex((curr) => (curr === index ? null : curr))
                }
                data-testid={`finish-option-${finish}`}
                data-disabled={isDisabled ? 'true' : 'false'}
                data-selected={isSelected ? 'true' : 'false'}
                data-finish={finish}
                style={optionStyle(isSelected, isFocused, isDisabled)}
              >
                {MATERIAL_FINISH_LABELS[finish]}
              </button>
              {isDisabled && reason !== null ? (
                <DisabledCombinationTooltip
                  id={tooltipId}
                  reason={reason}
                  data-testid={`finish-tooltip-${finish}`}
                  // The `data-visible` attribute is the contract
                  // the spec exercises to verify hover/focus reveal
                  // (ST-013-AC2). It always carries a literal
                  // `"true"` or `"false"` string so the test's
                  // `toHaveAttribute('data-visible', '...')`
                  // assertions resolve deterministically.
                  data-visible={tooltipVisible ? 'true' : 'false'}
                  // When the tooltip is hidden, layer an opacity:0
                  // override on top of the component's own base
                  // styling so sighted users do not see the
                  // tooltip at rest while screen readers continue
                  // to resolve `aria-describedby` to the live
                  // tooltip element.
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
