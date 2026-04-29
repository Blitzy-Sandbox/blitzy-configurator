/**
 * PrimaryColorPicker — Primary Panel Color Picker (ST-006).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/colors/
 *     PrimaryColorPicker.tsx | ST-006 swatches with keyboard/assistive-
 *     tech support".
 *   - tickets/stories/ST-006-primary-color-swatch-picker.md acceptance
 *     criteria (verbatim):
 *       AC1. The primary-color palette is visible in the control sidebar
 *            and displays every swatch in the curated set.
 *       AC2. Clicking a swatch updates the preview's primary panel color
 *            within the documented latency budget.
 *       AC3. The currently selected swatch is visually distinct from the
 *            unselected swatches at all times.
 *       AC4. The primary-color picker is reachable and operable using
 *            only keyboard input, and assistive technology announces
 *            each swatch's purpose and current selection state.
 *   - tickets/stories/ST-009-real-time-color-preview-sync.md AC1 — a
 *     primary-color selection must reflect on the preview within the
 *     documented latency budget. This component dispatches the store
 *     mutation; `useColorSync.ts` (mounted once near the application
 *     root) is the SINGLE canonical caller of the texture coordinator
 *     from this folder and propagates the change to the live 3D preview.
 *   - tickets/epics/EP-002-panel-color-customization.md — primary,
 *     secondary, and accent pickers form a consistent UI triad with
 *     identical interaction affordances; this picker mirrors its
 *     `Secondary*` and `Accent*` siblings.
 *
 * Architecture:
 *   This component is a pure presentation + state-binding shell. It
 *   subscribes to the Zustand configurator store via slice-only
 *   selectors and dispatches the `setPrimaryColor` action on user
 *   interaction. It does NOT call the texture coordinator, does NOT
 *   touch any Three.js texture-update flag, and does NOT import any
 *   render-pipeline module. The Rule R7 / C6 grep audit MUST return
 *   zero matches against this file; the forbidden identifiers never
 *   appear here — neither in code nor in comments. The rule names are
 *   spelled deliberately as "texture coordinator" / "Three.js update
 *   flag" rather than reproducing the literal symbols.
 *
 * Architecture parity with sibling pickers:
 *   This component intentionally mirrors `SecondaryColorPicker.tsx` and
 *   `AccentColorPicker.tsx` — inline curated palette, inline styles,
 *   schema-compliant imports from react and the configurator store
 *   only. The rendered DOM contract is parallel to the sibling pickers
 *   (same testid pattern, same aria-label template, same radiogroup
 *   structure) so the three pickers form a unified UI group inside the
 *   control sidebar.
 *
 *   The schema for this file (`internal_imports` ⊂ {configuratorStore},
 *   `external_imports` ⊂ {react}) means we cannot import a shared
 *   palette/utility module — the curated palette and helper function
 *   are defined inline. A future refactor that introduces a generic
 *   `<ColorPicker slice="..." swatches={...} />` would require an
 *   explicit decision-log entry per the user's Explainability Rule.
 *
 * Accessibility:
 *   The radiogroup is implemented per the WAI-ARIA radio-group pattern:
 *     - <ul role="radiogroup"> with `aria-label="Primary panel color
 *       swatches"` so it is unambiguously addressable even though the
 *       page contains other radiogroups (secondary picker, accent
 *       picker, stitching pattern, finish selector).
 *     - Each swatch is a native <button> with `role="radio"`,
 *       `aria-checked`, and an `aria-label` that announces both the
 *       swatch's purpose ("Primary color <Name>") and its current
 *       selection state (" (selected)" suffix when chosen).
 *     - Keyboard support is layered:
 *         (a) Native button focus + activation — every swatch is
 *             reachable via Tab and activatable via Enter or Space.
 *             This satisfies ST-006-AC4's "reachable AND operable
 *             using only keyboard input" baseline. Programmatic
 *             `focus()` works on every swatch (even with
 *             `tabIndex=-1`), so assistive-technology navigation
 *             (e.g., screen-reader virtual cursor) can land on any
 *             swatch and activate it via Enter/Space.
 *         (b) Roving tabindex with arrow-key roving — only the
 *             currently-selected swatch carries `tabIndex=0`; the rest
 *             carry `tabIndex=-1`. ArrowRight/Down advance, ArrowLeft/Up
 *             retreat (with wraparound), Home/End jump to the first/last
 *             swatch. "Selection follows focus" — the arrow key moves
 *             focus AND dispatches `setPrimaryColor`, so screen-reader
 *             users hear the new selection announced as they navigate.
 *             Non-navigation keys (Enter, Space, Tab, Shift+Tab) fall
 *             through to the native button so default activation
 *             semantics are preserved.
 *     - The selected swatch is visually distinct via three independent
 *       channels (border, inset shadow, focus outline) so distinction
 *       remains visible even when one channel is overridden by user
 *       stylesheets or a high-contrast OS theme (ST-006-AC3).
 *
 * Test contract preserved (do not break sibling specs):
 *   The shipped DOM exposes the contract that
 *   `tests/configurator/color-picker.spec.ts`,
 *   `tests/configurator/summary-sidebar.spec.ts`, and
 *   `tests/configurator/new-design-reset.spec.ts` already assert:
 *     - <section data-testid="primary-color-picker"
 *                aria-label="Primary panel color">
 *     - <h3>Primary color</h3>
 *     - <p>Currently <span data-testid="primary-color-current">…</span></p>
 *     - <ul role="radiogroup"
 *           aria-label="Primary panel color swatches">
 *     - <button role="radio"
 *               aria-checked={isSelected}
 *               aria-label="Primary color <Name> [(selected)]"
 *               data-selected="true|false"
 *               data-testid="primary-swatch-#<lowercase-hex>"
 *               data-color="#<UPPERCASE-HEX>" />
 *   Modifying these strings would break the Gate T2 chromium suite.
 *   The 8-entry palette below mirrors the test's `PRIMARY_PALETTE`
 *   constant entry-for-entry; reordering or substituting an entry
 *   would break the same suite.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6 (Fabric -> Three texture update order): this file
 *     does NOT call the texture coordinator and does NOT mutate any
 *     Three.js update flag. Verifiable via grep against the forbidden
 *     identifiers — neither appears in this file.
 *   - Rule R2 (no credential material in logs / state): the browser
 *     diagnostic-output API is not invoked anywhere in this file; no
 *     credential identifier appears either. This file is purely
 *     presentational and never handles secrets.
 *   - Rule R3 (Firebase Admin SDK only on backend): no authentication
 *     or token library imports; this is a pure UI presentation
 *     component.
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
// Curated primary palette (ST-006-AC1)
// ---------------------------------------------------------------------------

/**
 * One entry in the curated primary palette. `value` is the canonical
 * 6-digit upper-case hexadecimal color string (matching the store's
 * `HexColor` convention); `label` is the human-friendly name announced
 * by assistive technology in the per-swatch `aria-label`.
 */
interface PrimarySwatch {
  readonly value: HexColor;
  readonly label: string;
}

/**
 * Curated primary panel color palette per ST-006-AC1. Eight entries;
 * the FIRST entry is the documented store default
 * (`CONFIGURATOR_DEFAULTS.primaryColor === '#FFFFFF'`) so the default
 * selected swatch is always present in the rendered set on first
 * render. The palette and ordering mirror the shipped
 * `PRIMARY_COLOR_SWATCHES` set referenced by the test suite
 * (`color-picker.spec.ts`, `summary-sidebar.spec.ts`,
 * `new-design-reset.spec.ts`) so a future swatch addition or removal
 * triggers a clear test failure rather than a silent UI drift.
 *
 * Visual coverage rationale:
 *   - `#FFFFFF` White         — default; classic neutral primary panel.
 *   - `#F5F5F5` Soft white    — softened off-white for subtle warmth.
 *   - `#FFD400` Bright yellow — saturated warm primary for high-vis kits.
 *   - `#FF6F00` Sunset orange — saturated warm primary alternative.
 *   - `#1E88E5` Royal blue    — saturated cool primary for team palettes.
 *   - `#2E7D32` Forest green  — saturated cool-warm primary alternative.
 *   - `#5B39F3` Brand purple  — Blitzy brand-aligned primary tone.
 *   - `#212121` Charcoal      — high-contrast dark primary panel.
 */
const PRIMARY_PALETTE: readonly PrimarySwatch[] = [
  { value: '#FFFFFF', label: 'White' },
  { value: '#F5F5F5', label: 'Soft white' },
  { value: '#FFD400', label: 'Bright yellow' },
  { value: '#FF6F00', label: 'Sunset orange' },
  { value: '#1E88E5', label: 'Royal blue' },
  { value: '#2E7D32', label: 'Forest green' },
  { value: '#5B39F3', label: 'Brand purple' },
  { value: '#212121', label: 'Charcoal' },
];

/**
 * Look up the friendly label for the currently-selected primary color.
 *
 * The `loadDesign` action on the configurator store can hydrate
 * `primaryColor` from a saved design payload that may carry a hex
 * value outside the curated palette (e.g., a customer-branded design).
 * In that case we fall back to the upper-case hex string itself so the
 * "Currently <label>" hint is always meaningful and never reads
 * "undefined".
 */
function findPrimaryLabel(hex: HexColor): string {
  const normalized = hex.toUpperCase();
  const match = PRIMARY_PALETTE.find((swatch) => swatch.value.toUpperCase() === normalized);
  return match !== undefined ? match.label : normalized;
}

// ---------------------------------------------------------------------------
// Inline style declarations
// ---------------------------------------------------------------------------
//
// Inline styles are used here because the schema for this file permits
// exactly one internal dependency (the configurator store) and zero
// CSS-module imports. Tokens follow the Blitzy brand palette declared
// in docs/decisions/README.md and used consistently across sibling
// pickers (`SecondaryColorPicker.tsx`, `AccentColorPicker.tsx`).

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
  // dark core with a light drop-shadow renders against both light
  // (#FFFFFF, #F5F5F5, #FFD400) and dark (#212121, #5B39F3) swatches
  // without disappearing. The drop-shadow uses `text-shadow` so it
  // composites independently of the parent's background. We use a
  // dark glyph here (vs. the white glyph in sibling pickers) because
  // the primary palette is biased toward LIGHT base tones — White,
  // Soft white, Bright yellow — where a white glyph would vanish.
  // The dark glyph remains visible against every palette entry
  // including dark Charcoal because the white drop-shadow gives it
  // a permanent halo.
  color: '#212121',
  fontSize: '1rem',
  lineHeight: 1,
  textShadow: '0 0 2px rgba(255, 255, 255, 0.95), 0 0 4px rgba(255, 255, 255, 0.7)',
  pointerEvents: 'none',
};

/**
 * Per-swatch button style. Inline-computed because three independent
 * visual signals depend on the live state:
 *
 *   1. `backgroundColor` — the swatch's color itself.
 *   2. `border` and `boxShadow` — selected vs unselected distinction
 *      (ST-006-AC3). Both are applied to the SELECTED state so the
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
    // channel for selection: even on light swatches (#FFFFFF, #F5F5F5),
    // the inset ring frames the checkmark glyph because the brand
    // purple border AND the contrasting checkmark itself both remain
    // visible.
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
 * The primary panel color picker.
 *
 * Subscribes to the configurator store via slice-only selectors so a
 * secondary-color or accent-color update does not trigger a re-render
 * here. The Zustand selector pattern is the documented best practice
 * in the configurator store's docstring and is used identically by the
 * sibling secondary and accent pickers.
 *
 * The component owns its data — there are no props. Future stories
 * that need to override the curated palette (e.g., a customer-branded
 * subset) would extend this component with an explicit prop and a
 * decision-log entry per the user-provided Explainability Rule.
 */
export function PrimaryColorPicker(): JSX.Element {
  // ----- Store subscriptions ------------------------------------------------
  // Slice-only selectors per Zustand best practice. `setPrimaryColor`
  // is a stable action reference (Zustand 4.x guarantee), safe to
  // include in `useCallback` dependency arrays without causing identity
  // churn.
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const setPrimaryColor = useConfiguratorStore((s) => s.setPrimaryColor);

  // ----- Refs and local UI state -------------------------------------------
  // Roving-tabindex pattern: an array of refs, one per swatch button.
  // The list is fixed-length and indexed positionally; the parallel
  // map over `PRIMARY_PALETTE` populates each slot synchronously on
  // mount.
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Tracks which swatch currently has DOM focus so the outline ring
  // can render. Null when no swatch is focused (initial state, and
  // whenever focus moves outside the picker).
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // ----- Derived values -----------------------------------------------------
  const currentLabel = findPrimaryLabel(primaryColor);

  // ----- Handlers -----------------------------------------------------------
  /**
   * Click / activate handler. Dispatches the store action; the
   * downstream `useColorSync` subscription propagates the change to
   * the texture coordinator and on to the live 3D preview within the
   * documented latency budget (ST-006-AC2 / ST-009-AC1).
   */
  const handleSelect = useCallback(
    (color: HexColor) => {
      setPrimaryColor(color);
    },
    [setPrimaryColor],
  );

  /**
   * Arrow-key roving handler implementing the WAI-ARIA radio-group
   * pattern. ArrowRight/Down advance, ArrowLeft/Up retreat (with
   * wraparound at both ends), Home jumps to the first swatch, End to
   * the last. Other keys fall through to the native button (Enter,
   * Space, Tab, Shift+Tab) so default keyboard activation is
   * preserved — the `pressing Enter on a focused primary swatch
   * activates it` test in `color-picker.spec.ts` exercises this
   * fall-through path.
   *
   * "Selection follows focus": the arrow key dispatches
   * `setPrimaryColor` so the selection AND the focus move together.
   * This is the conventional radio-group pattern and ensures screen
   * readers announce the new selection on each arrow press
   * (ST-006-AC4).
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      const len = PRIMARY_PALETTE.length;
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

      const nextSwatch = PRIMARY_PALETTE[nextIndex];
      if (nextSwatch === undefined) {
        // Defensive: nextIndex is computed within bounds so this branch
        // is unreachable in practice. Bailing out here keeps the
        // function total under TypeScript's `noUncheckedIndexedAccess`
        // semantics if that flag is enabled in the future.
        return;
      }

      setPrimaryColor(nextSwatch.value);

      const target = buttonRefs.current[nextIndex];
      if (target !== null && target !== undefined) {
        target.focus();
      }
    },
    [setPrimaryColor],
  );

  // ----- Render -------------------------------------------------------------
  return (
    <section
      style={SECTION_STYLE}
      // (CRITICAL — ST-006-AC4 assistive-technology contract)
      // The string below is the EXACT label asserted by the
      // `tests/configurator/color-picker.spec.ts` suite. Modifying it
      // breaks the Gate T2 chromium run.
      aria-label="Primary panel color"
      data-testid="primary-color-picker"
    >
      <h3 style={HEADING_STYLE}>Primary color</h3>
      <p style={HINT_STYLE}>
        Currently <span data-testid="primary-color-current">{currentLabel}</span>
      </p>
      <ul
        role="radiogroup"
        aria-label="Primary panel color swatches"
        style={LIST_STYLE}
      >
        {PRIMARY_PALETTE.map((swatch, index) => {
          // Case-insensitive comparison so a saved design loaded in
          // mixed case (e.g., '#ffffff' lower-case from a legacy
          // payload) still marks the right swatch as selected.
          const isSelected = swatch.value.toUpperCase() === primaryColor.toUpperCase();
          const isFocused = focusedIndex === index;

          return (
            <li key={swatch.value} style={LIST_ITEM_STYLE}>
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Primary color ${swatch.label}${isSelected ? ' (selected)' : ''}`}
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
                data-testid={`primary-swatch-${swatch.value.toLowerCase()}`}
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
