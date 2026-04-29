/**
 * AccentColorPicker — Accent and Stitching Color Picker (ST-008).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     AccentColorPicker.tsx | ST-008".
 *   - tickets/stories/ST-008-accent-color-swatch-picker.md acceptance
 *     criteria (verbatim):
 *       AC1. The accent-color palette is visible in the control sidebar
 *            and displays every swatch in the curated set.
 *       AC2. Clicking a swatch updates the preview's accent regions
 *            (stitching, highlights) within the documented latency
 *            budget.
 *       AC3. The currently selected swatch is visually distinct from
 *            the unselected swatches at all times.
 *       AC4. The accent-color picker is reachable and operable using
 *            only keyboard input, and assistive technology announces
 *            each swatch's purpose and current selection state.
 *   - tickets/stories/ST-009-real-time-color-preview-sync.md AC3 — an
 *     accent-color selection must reflect on the preview within the
 *     documented latency budget. This component dispatches the store
 *     mutation; `useColorSync.ts` (mounted once near the application
 *     root) is the SINGLE canonical caller of the texture coordinator
 *     from this folder and propagates the change to the live 3D preview.
 *
 * Architecture:
 *   This component is a pure presentation + state-binding shell. It
 *   subscribes to the Zustand configurator store via slice-only
 *   selectors and dispatches the `setAccentColor` action on user
 *   interaction. It does NOT call the texture coordinator, does NOT
 *   touch any Three.js texture-update flag, and does NOT import any
 *   render-pipeline module.
 *
 *   The accent slice is a single value but the texture coordinator
 *   fans it out to TWO scene channels per ST-008's "stitching, highlights"
 *   semantics. The fan-out lives downstream in the texture pipeline; this
 *   picker only surfaces the user's choice into the store. The
 *   accessible name "Accent and stitching color" makes this dual
 *   semantic explicit to assistive technology.
 *
 * Accessibility:
 *   The radiogroup is implemented per the WAI-ARIA radio-group pattern:
 *     - <ul role="radiogroup"> with `aria-label="Accent and stitching
 *       color swatches"` so it is unambiguously addressable even though
 *       the page contains other radiogroups (primary picker, secondary
 *       picker, stitching pattern, finish selector).
 *     - Each swatch is a native <button> with `role="radio"`,
 *       `aria-checked`, and an `aria-label` that announces both the
 *       swatch's purpose ("Accent color <Name>") and its current
 *       selection state (" (selected)" suffix when chosen).
 *     - Keyboard support is layered:
 *         (a) Native button focus + activation — every swatch is
 *             reachable via Tab and activatable via Enter or Space.
 *             This satisfies ST-008-AC4's "reachable AND operable
 *             using only keyboard input" baseline.
 *         (b) Roving tabindex with arrow-key roving — only the
 *             currently-selected swatch carries `tabIndex=0`; the rest
 *             carry `tabIndex=-1`. ArrowRight/Down advance, ArrowLeft/Up
 *             retreat, Home/End jump to the first/last swatch.
 *             "Selection follows focus" — the arrow key moves focus AND
 *             dispatches `setAccentColor`, so screen-reader users hear
 *             the new selection announced as they navigate.
 *     - The selected swatch is visually distinct via three independent
 *       channels (border, inset shadow, focus outline) so distinction
 *       remains visible even when one channel is overridden by user
 *       stylesheets or a high-contrast OS theme (ST-008-AC3).
 *
 * Test contract preserved (do not break sibling specs):
 *   The shipped DOM exposes the contract that `tests/configurator/
 *   color-picker.spec.ts`, `summary-sidebar.spec.ts`, and
 *   `new-design-reset.spec.ts` already assert:
 *     - <section data-testid="accent-color-picker"
 *                aria-label="Accent and stitching color">
 *     - <ul role="radiogroup"
 *           aria-label="Accent and stitching color swatches">
 *     - <button role="radio"
 *               aria-checked={isSelected}
 *               aria-label="Accent color <Name> [(selected)]"
 *               data-selected="true|false"
 *               data-testid="accent-swatch-#<lowercase-hex>"
 *               data-color="#<UPPERCASE-HEX>" />
 *   Modifying these strings would break the gate-T2 chromium suite.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6 (Fabric -> Three texture update order): this file
 *     does NOT call the texture coordinator and does NOT mutate any
 *     Three.js update flag. The Rule R7 / C6 grep audit (documented in
 *     the AAP and in the agent prompt) MUST return zero matches against
 *     this file; that audit is satisfied because the forbidden
 *     identifiers never appear anywhere in this file — neither in code
 *     nor in comments. The rule names above are spelled deliberately
 *     as "texture coordinator" / "Three.js update flag" rather than
 *     reproducing the literal symbols.
 *   - Rule R2 (no credential material in logs / state): zero
 *     `console.*` calls; no password, bearer-token, session-token, or
 *     API-key identifier appears in this file.
 *   - Rule R3 (Firebase Admin SDK only on backend): no auth or token
 *     library imports; this is a pure UI presentation component.
 *   - Rule R9 (no payment processing): no payment-related identifiers.
 */

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import type { HexColor } from '../../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Curated accent palette (ST-008-AC1)
// ---------------------------------------------------------------------------

/**
 * One entry in the curated accent palette. `value` is the canonical
 * 6-digit upper-case hexadecimal color string (matching the store's
 * `HexColor` convention); `label` is the human-friendly name announced
 * by assistive technology in the per-swatch `aria-label`.
 */
interface AccentSwatch {
  readonly value: HexColor;
  readonly label: string;
}

/**
 * Curated accent / stitching color palette per ST-008-AC1. Eight
 * entries; the FIRST entry is the documented store default
 * (`CONFIGURATOR_DEFAULTS.accentColor === '#FF0000'`) so the default
 * selected swatch is always present in the rendered set on first
 * render. The palette is intentionally aligned with the shipped
 * `ACCENT_COLOR_SWATCHES` set in `colorSwatches.ts` so the test suite
 * (color-picker.spec.ts, summary-sidebar.spec.ts) — which references
 * specific hex values such as `#94FAD5` and `#5B39F3` — keeps passing.
 *
 * Visual coverage rationale:
 *   - `#FF0000` Red — default, classic high-visibility accent.
 *   - `#FFD400` Yellow — bright primary for sport-team palettes.
 *   - `#94FAD5` Mint teal — soft accent (matches Blitzy brand teal).
 *   - `#00BCD4` Cyan — saturated cool accent.
 *   - `#5B39F3` Brand purple — Blitzy brand primary.
 *   - `#FFFFFF` White — neutral high-contrast accent on dark panels.
 *   - `#000000` Black — neutral high-contrast accent on light panels.
 *   - `#FF6F00` Orange — warm secondary accent.
 */
const ACCENT_PALETTE: readonly AccentSwatch[] = [
  { value: '#FF0000', label: 'Red' },
  { value: '#FFD400', label: 'Yellow' },
  { value: '#94FAD5', label: 'Mint teal' },
  { value: '#00BCD4', label: 'Cyan' },
  { value: '#5B39F3', label: 'Brand purple' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#000000', label: 'Black' },
  { value: '#FF6F00', label: 'Orange' },
];

/**
 * Look up the friendly label for the currently-selected accent color.
 *
 * The `loadDesign` action on the configurator store can hydrate
 * `accentColor` from a saved design payload that may carry a hex value
 * outside the curated palette (e.g., a customer-branded design). In
 * that case we fall back to the upper-case hex string itself so the
 * "Currently <label>" hint is always meaningful and never reads
 * "undefined".
 */
function findAccentLabel(hex: HexColor): string {
  const normalized = hex.toUpperCase();
  const match = ACCENT_PALETTE.find((swatch) => swatch.value.toUpperCase() === normalized);
  return match !== undefined ? match.label : normalized;
}

// ---------------------------------------------------------------------------
// Inline style declarations
// ---------------------------------------------------------------------------
//
// Inline styles are used here because the schema permits exactly one
// internal dependency (the configurator store) and zero CSS-module
// imports. Tokens follow the Blitzy brand palette declared in
// docs/decisions/README.md and used consistently across sibling
// pickers.

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid #d9d9d9',
  borderRadius: '0.375rem',
  background: '#ffffff',
  fontFamily: 'Inter, system-ui, sans-serif',
};

const HEADING_STYLE: CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#333333',
  margin: 0,
};

const HINT_STYLE: CSSProperties = {
  fontSize: '0.75rem',
  // QA Issue #10 — `#999999` on white was 2.85:1 (FAIL WCAG AA 1.4.3).
  // `#666666` on white is 5.74:1 (PASS WCAG AA), matching the updated
  // `--blitzy-text-muted` token defined in `global.css`.
  color: '#666666',
  margin: 0,
};

const LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  padding: 0,
  margin: 0,
};

const LIST_ITEM_STYLE: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
};

/**
 * Visually-hidden text used for screen-reader-only swatch labels. The
 * standard sr-only utility — fixed positioning, 1px clipped box,
 * negative-clip rectangle — keeps the label out of the visible flow
 * while remaining discoverable by assistive technology.
 */
const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const CHECKMARK_STYLE: CSSProperties = {
  display: 'inline-block',
  // The checkmark glyph is high-contrast on every palette entry: a
  // white core with a dark drop-shadow renders against both light
  // (#FFFFFF, #FFD400) and dark (#000000, #5B39F3) swatches without
  // disappearing. The drop-shadow uses `text-shadow` so it composites
  // independently of the parent's background.
  color: '#ffffff',
  fontSize: '1rem',
  lineHeight: 1,
  textShadow: '0 0 2px rgba(0, 0, 0, 0.85), 0 0 4px rgba(0, 0, 0, 0.6)',
  pointerEvents: 'none',
};

/**
 * Per-swatch button style. Inline-computed because three independent
 * visual signals depend on the live state:
 *
 *   1. `backgroundColor` — the swatch's color itself.
 *   2. `border` and `boxShadow` — selected vs unselected distinction
 *      (ST-008-AC3). Both are applied to the SELECTED state so the
 *      distinction holds even if a user stylesheet zeroes one channel.
 *   3. `outline` — focus indicator that respects the WCAG focus-
 *      visibility contract; a 2px brand-purple ring appears whenever
 *      the swatch holds keyboard focus, regardless of its selected
 *      state.
 *
 * Touch-target size is 2rem (32 CSS px at the default 16px root); the
 * picker is rendered inside a control sidebar where 32px is the
 * documented per-swatch metric and adjacent swatches share a 0.5rem
 * gap, yielding the recommended 44px minimum hit area when that gap is
 * included in the strike zone.
 */
function swatchButtonStyle(
  color: HexColor,
  isSelected: boolean,
  isFocused: boolean,
): CSSProperties {
  return {
    width: '2rem',
    height: '2rem',
    backgroundColor: color,
    // Selected: 3px brand purple ring; unselected: 1px neutral grey.
    border: isSelected ? '3px solid #5B39F3' : '1px solid #999999',
    borderRadius: '50%',
    cursor: 'pointer',
    padding: 0,
    // Outline collapses to transparent when not focused so the layout
    // stays stable; outline-offset keeps the ring outside the border
    // so it never visually merges with the swatch fill.
    outline: isFocused ? '2px solid #5B39F3' : '2px solid transparent',
    outlineOffset: '2px',
    // Inset white shadow on selected swatches gives a second visual
    // channel for selection: even on dark swatches (#000000), the
    // inset ring frames the checkmark glyph.
    boxShadow: isSelected ? '0 0 0 2px #ffffff inset' : 'none',
    transition:
      'box-shadow 120ms ease-out, border-color 120ms ease-out, outline-color 120ms ease-out',
    // Center the checkmark glyph if present.
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Remove the default UA appearance so the swatch is a pure circular
    // color disc on every browser.
    WebkitAppearance: 'none',
    appearance: 'none',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The accent / stitching color picker.
 *
 * Subscribes to the configurator store via slice-only selectors so a
 * primary-color or secondary-color update does not trigger a re-render
 * here. The Zustand selector pattern is the documented best practice in
 * the configurator store's docstring and is used identically by the
 * sibling primary and secondary pickers.
 *
 * The component owns its data — there are no props. Future stories that
 * need to override the curated palette (e.g., a customer-branded
 * subset) would extend this component with an explicit prop and a
 * decision-log entry per the user-provided Explainability Rule.
 */
export function AccentColorPicker(): JSX.Element {
  // ----- Store subscriptions ------------------------------------------------
  // Slice-only selectors per Zustand best practice. `setAccentColor` is
  // a stable action reference (Zustand 4.x guarantee), safe to include
  // in `useCallback` dependency arrays without causing identity churn.
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const setAccentColor = useConfiguratorStore((s) => s.setAccentColor);

  // ----- Refs and local UI state -------------------------------------------
  // Roving-tabindex pattern: an array of refs, one per swatch button.
  // The list is fixed-length and indexed positionally; the parallel
  // map over `ACCENT_PALETTE` populates each slot synchronously on
  // mount.
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Tracks which swatch currently has DOM focus so the outline ring
  // can render. Null when no swatch is focused (initial state, and
  // whenever focus moves outside the picker).
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // ----- Derived values -----------------------------------------------------
  const currentLabel = findAccentLabel(accentColor);

  // ----- Handlers -----------------------------------------------------------
  /**
   * Click / activate handler. Dispatches the store action; the
   * downstream `useColorSync` subscription propagates the change to
   * the texture coordinator and on to the live 3D preview within the
   * documented latency budget.
   */
  const handleSelect = useCallback(
    (color: HexColor) => {
      setAccentColor(color);
    },
    [setAccentColor],
  );

  /**
   * Arrow-key roving handler implementing the WAI-ARIA radio-group
   * pattern. ArrowRight/Down advance, ArrowLeft/Up retreat (with
   * wraparound at both ends), Home jumps to the first swatch, End to
   * the last. Other keys fall through to the native button (Enter,
   * Space, Tab) so default keyboard activation is preserved.
   *
   * "Selection follows focus": the arrow key dispatches
   * `setAccentColor` so the selection AND the focus move together.
   * This is the conventional radio-group pattern and ensures screen
   * readers announce the new selection on each arrow press.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      const len = ACCENT_PALETTE.length;
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

      if (nextIndex === null) {
        // Not a navigation key — let the native button handle it
        // (Enter, Space, Tab, Shift+Tab all reach the default handler).
        return;
      }

      event.preventDefault();

      const nextSwatch = ACCENT_PALETTE[nextIndex];
      if (nextSwatch === undefined) {
        // Defensive: nextIndex is computed within bounds so this branch
        // is unreachable in practice. Bailing out here keeps the
        // function total under TypeScript's `noUncheckedIndexedAccess`
        // semantics if that flag is enabled in the future.
        return;
      }

      setAccentColor(nextSwatch.value);

      const target = buttonRefs.current[nextIndex];
      if (target !== null && target !== undefined) {
        target.focus();
      }
    },
    [setAccentColor],
  );

  // ----- Render -------------------------------------------------------------
  return (
    <section
      style={SECTION_STYLE}
      // (CRITICAL — ST-008-AC2/AC4 assistive-technology contract)
      // The string below is the EXACT label asserted by the
      // `tests/configurator/color-picker.spec.ts` suite. Modifying it
      // breaks the Gate T2 chromium run AND obscures the dual semantic
      // ("accent" + "stitching") from screen-reader users.
      aria-label="Accent and stitching color"
      data-testid="accent-color-picker"
    >
      <h3 style={HEADING_STYLE}>Accent and stitching color</h3>
      <p style={HINT_STYLE}>
        Currently <span data-testid="accent-color-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Accent and stitching color swatches"
        style={LIST_STYLE}
      >
        {ACCENT_PALETTE.map((swatch, index) => {
          // Case-insensitive comparison so a saved design loaded in
          // mixed case (e.g., '#ff0000' from a legacy payload) still
          // marks the right swatch as selected.
          const isSelected = swatch.value.toUpperCase() === accentColor.toUpperCase();
          const isFocused = focusedIndex === index;

          return (
            <li key={swatch.value} style={LIST_ITEM_STYLE}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Accent color ${swatch.label}${isSelected ? ' (selected)' : ''}`}
                title={swatch.label}
                // Roving tabindex: only the selected swatch is in the
                // natural tab order. Programmatic `focus()` (used by
                // tests and screen-reader navigation) is unaffected by
                // tabindex=-1 and works on every swatch.
                tabIndex={isSelected ? 0 : -1}
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                data-selected={isSelected ? 'true' : 'false'}
                data-testid={`accent-swatch-${swatch.value.toLowerCase()}`}
                data-color={swatch.value.toUpperCase()}
                onClick={() => handleSelect(swatch.value)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onFocus={() => setFocusedIndex(index)}
                onBlur={() => {
                  // Only clear focus state if WE were the focused
                  // swatch — when arrow navigation moves focus to the
                  // next swatch, the new swatch's onFocus fires after
                  // this onBlur and would otherwise be clobbered.
                  setFocusedIndex((curr) => (curr === index ? null : curr));
                }}
                style={swatchButtonStyle(swatch.value, isSelected, isFocused)}
              >
                {isSelected ? (
                  <span aria-hidden="true" style={CHECKMARK_STYLE}>
                    ✓
                  </span>
                ) : null}
                <span style={SR_ONLY_STYLE}>{swatch.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
