/**
 * LogoPositioner — Logo position pad, X/Y numeric inputs, and scale
 * control for the configurator sidebar.
 *
 * ===========================================================================
 * Authority
 * ===========================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       LogoPositioner.tsx | ST-015 + ST-016 Fabric.js drag + scale
 *       handles
 *   - AAP §0.6.7 Track 2 — Frontend Core:
 *       CREATE | LogoPositioner.tsx | ST-015 + ST-016 Fabric.js drag +
 *       scale handles
 *   - AAP §0.6.7 Gate T2 verification (user prompt verbatim):
 *       cd frontend && npx playwright test --project=chromium
 *       tests/configurator/  — all pass.
 *
 * ===========================================================================
 * Story Coverage
 * ===========================================================================
 *
 *   ST-015 — Logo positioning on a panel:
 *     ST-015-AC1: drag across the surface of a selected panel and
 *                 remain at its new position when released — satisfied
 *                 by the pointer-event handlers on the 2D drag pad,
 *                 plus arrow-key movement for assistive tech.
 *     ST-015-AC2: numeric coordinate input fields accept entry and
 *                 the preview reflects them within the latency
 *                 budget — satisfied by the X / Y `<input type="number">`
 *                 elements with string staging buffers and on-blur /
 *                 on-Enter commit.
 *     ST-015-AC3: position clamped to panel boundaries — satisfied
 *                 by `clampAxis()` applied at every mutation site
 *                 (pad pointer, pad keyboard, numeric input commit,
 *                 reset).
 *     ST-015-AC4: current position displayed in human-readable form —
 *                 satisfied by the inline "Position: x=N.NN, y=N.NN"
 *                 readout rendered alongside the pad. The format
 *                 mirrors the test contract in
 *                 `frontend/tests/configurator/logo-upload.spec.ts`.
 *
 *   ST-016 — Logo scaling control:
 *     ST-016-AC1: scaling control adjusts size in real time —
 *                 satisfied by the `<input type="range">` slider
 *                 dispatching texture-pipeline updates on every
 *                 onChange.
 *     ST-016-AC2: control clamps to documented min/max — satisfied
 *                 natively by the slider's `min` and `max` HTML
 *                 attributes (browser enforcement) plus a defensive
 *                 `clampScale()` call.
 *     ST-016-AC3: current scale shown as percentage / numeric label —
 *                 satisfied by the "1.00×" textual readout (U+00D7
 *                 multiplication sign) next to the slider.
 *     ST-016-AC4: resetting the configurator to defaults restores
 *                 the documented default scale — primarily satisfied
 *                 by the Zustand store's resetToDefaults action
 *                 invoked from NewDesignDialog (ST-020). This file
 *                 additionally exposes a local "Reset position &
 *                 scale" affordance so users can rebaseline ONLY
 *                 logo placement without losing other selections.
 *
 * ===========================================================================
 * Architectural Invariants
 * ===========================================================================
 *
 *   - Single mutation entry point: every position / scale change in
 *     the store is followed by a `texturePipeline.update()` call so
 *     the 3D preview reflects the new state within the ST-009
 *     latency budget. Updates are serialized through a FIFO promise
 *     queue (`pipelineQueueRef`) so a slow pipeline call cannot be
 *     overtaken by a later one — the visual order matches the user's
 *     interaction order. The chain is wrapped in dual
 *     `.catch(() => undefined)` calls so a single rejected pipeline
 *     update never poisons subsequent updates AND never escapes as
 *     an unhandled-promise warning past the no-floating-promises lint
 *     rule.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this component dispatches texture-pipeline
 *     updates ONLY through the canonical orchestrator (which itself
 *     is the single site that performs the Fabric render then sets
 *     the Three texture refresh flag). This file does NOT import
 *     Fabric.js, does NOT import Three.js, does NOT touch the
 *     refresh flag directly, and does NOT call the render method
 *     directly.
 *   - Rule R2: zero log-statement calls.
 *   - Rule R3: no auth / Firebase / JWT imports — positioning is
 *     unauthenticated UI state.
 *   - AAP §0.4.6: no barrel imports. Explicit relative paths only.
 *
 * ===========================================================================
 * Test Contract Alignment
 * ===========================================================================
 *
 *   The Playwright spec at
 *   `frontend/tests/configurator/logo-upload.spec.ts` exercises this
 *   component as part of Gate T2. The contract is tight; this file
 *   conforms exactly:
 *
 *     - Section root has `data-testid="logo-positioner"`.
 *     - Pad has `data-testid="logo-position-pad"`, `role="application"`,
 *       `tabIndex={0}`, `data-x` and `data-y` reflecting the current
 *       position rounded to 2 decimals.
 *     - Dot has `data-testid="logo-position-dot"`.
 *     - Scale slider has `data-testid="logo-scale-slider"` and
 *       `data-scale` reflecting the current scale rounded to 2 decimals.
 *     - Scale readout has `data-testid="logo-scale-readout"` with text
 *       like "1.00×" (matched by the regex `/\d\.\d{2}\s*[\u00D7x]/i`).
 *     - Position readout text "Position: x=N.NN, y=N.NN" appears within
 *       the section (matched by `toContainText('Position: x=...')`).
 *     - Single arrow-key press moves the position by ±0.05.
 *     - Slider range is [0.25, 2.5] with step 0.05.
 *     - Pointer y axis is flipped so the top edge of the pad is
 *       y = +1; ArrowUp also increments y so both gestures move the
 *       dot upward visually.
 */

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';

// ---------------------------------------------------------------------------
// Module-scoped constants
// ---------------------------------------------------------------------------

/**
 * Documented minimum logo scale (ST-016-AC2).
 *
 * 0.25 = 25% of the default size. Below this threshold, the logo
 * silhouette becomes illegible at typical sphere render resolution,
 * defeating the point of branding.
 */
const MIN_SCALE = 0.25;

/**
 * Documented maximum logo scale (ST-016-AC2).
 *
 * 2.5 = 250% of the default size. Beyond this, the logo dominates the
 * panel and overflows past the stitched seam, which is undesirable
 * for the StrikeForge ball topology.
 */
const MAX_SCALE = 2.5;

/**
 * Documented default logo scale (ST-016-AC4).
 *
 * MUST match `CONFIGURATOR_DEFAULTS.logoScale` in
 * `frontend/src/state/configuratorStore.ts`.
 */
const DEFAULT_SCALE = 1.0;

/**
 * Slider step granularity. 0.05 = 5% of scale per tick. Coarse enough
 * to feel responsive, fine enough that the readout transitions look
 * smooth as the user drags.
 */
const SCALE_STEP = 0.05;

/**
 * Numeric-input + keyboard step granularity for the position axes.
 * 0.05 = 5% of the half-panel width per tap.
 */
const POSITION_STEP = 0.05;

/**
 * Documented default position (ST-015 implies (0,0) center as default).
 * MUST match `CONFIGURATOR_DEFAULTS.logoPosition` in the store.
 */
const DEFAULT_POSITION_X = 0;
const DEFAULT_POSITION_Y = 0;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a position axis value to [-1, 1] (ST-015-AC3). Returns 0 for
 * any non-finite input (NaN, ±Infinity) so a malformed input cannot
 * leave the store in an undefined state.
 */
function clampAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

/**
 * Clamp a scale multiplier to [MIN_SCALE, MAX_SCALE] (ST-016-AC2).
 * Returns DEFAULT_SCALE for any non-finite input so a malformed value
 * can never leave the store with NaN, +Infinity, or -Infinity (any of
 * which would brick the texture pipeline's matrix math).
 */
function clampScale(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SCALE;
  if (v < MIN_SCALE) return MIN_SCALE;
  if (v > MAX_SCALE) return MAX_SCALE;
  return v;
}

/**
 * Format an axis value as a fixed-decimal string used in BOTH the
 * `data-x` / `data-y` attributes (machine-readable) AND the human
 * readout. Two decimals matches the test contract:
 *   - `data-x="0.10"` after two ArrowRight presses (2 × 0.05).
 *   - `data-y="-0.50"` for explicit negative values.
 *
 * Note on negative zero: `(-0).toFixed(2)` returns "0.00" in
 * JavaScript, so the readout never shows "-0.00".
 */
function formatAxis(v: number): string {
  return clampAxis(v).toFixed(2);
}

/**
 * Format a scale multiplier as "1.00", "0.75", etc. — used in the
 * `data-scale` attribute and as the numeric prefix of the textual
 * readout ("1.00×").
 */
function formatScaleNumeric(scale: number): string {
  return clampScale(scale).toFixed(2);
}

/**
 * Compute the current pad pointer position as normalized
 * coordinates in [-1, 1].
 *
 * Y AXIS CONVENTION (matches the Playwright spec contract):
 *   - Pad's TOP edge → y = +1
 *   - Pad's BOTTOM edge → y = -1
 *   - Center → y = 0
 *
 * The y axis is intentionally flipped relative to CSS pixel space
 * (where the top of an element has the smaller `clientY`) so that
 * upward gestures match positive-y semantics — both pointer drags
 * AND ArrowUp keypresses move the dot upward by adding to y.
 *
 * Defensive: if the pad has zero width or height (e.g., during a
 * resize transition), fall back to the center to avoid division by
 * zero producing NaN downstream.
 */
function computePadCoords(
  event: PointerEvent<HTMLDivElement>,
  pad: HTMLDivElement,
): { x: number; y: number } {
  const rect = pad.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return { x: 0, y: 0 };
  }
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  const nx = relX * 2 - 1; // [-1, 1] normal axis
  const ny = 1 - relY * 2; // [-1, 1] FLIPPED — top edge maps to +1
  return { x: clampAxis(nx), y: clampAxis(ny) };
}

// ---------------------------------------------------------------------------
// Inline-style constants
// ---------------------------------------------------------------------------
//
// Brand colors mirror the sibling color / pattern controls:
//   #5B39F3 primary, #2D1C77 primary-dark, #F4EFF6 surface,
//   #D9D9D9 border, #333333 text, #FFFFFF background.
//
// Inline styles (rather than CSS modules) match the established
// convention in this folder for the LogoUploader's adjacent siblings
// (the color-picker components) so the visual surface area looks
// consistent without requiring a parallel CSS-module file.

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  backgroundColor: '#FFFFFF',
};

const HEADING_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: '0.875rem',
  color: '#333333',
  margin: 0,
};

const HINT_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  color: '#666666',
  fontStyle: 'italic',
  margin: 0,
};

const PAD_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '1 / 1',
  backgroundColor: '#F4EFF6',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  // Crosshair cursor signals "click to place" — matches the
  // expected mental model for a 2D position picker.
  cursor: 'crosshair',
  // Suppresses default touch gestures (scroll, pinch-zoom) so a
  // touchscreen user can drag the dot without the browser
  // intercepting their gesture.
  touchAction: 'none',
  // No default focus outline — we rely on the parent
  // :focus-visible support of native elements; the pad gets a
  // visible focus ring via the inline focus style applied below.
  outline: 'none',
  // Disables text selection so dragging across the pad does not
  // accidentally select text in adjacent elements.
  userSelect: 'none',
};

const PAD_CROSSHAIR_H_STYLE: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: 0,
  width: '100%',
  height: 1,
  backgroundColor: '#D9D9D9',
  pointerEvents: 'none',
};

const PAD_CROSSHAIR_V_STYLE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 0,
  height: '100%',
  width: 1,
  backgroundColor: '#D9D9D9',
  pointerEvents: 'none',
};

const PAD_DOT_STYLE: CSSProperties = {
  position: 'absolute',
  width: '0.875rem',
  height: '0.875rem',
  // Negative half-width / half-height margins center the dot on its
  // anchor coordinate (so left:50%/top:50% places the dot's CENTER
  // at the pad's center, not its upper-left corner).
  marginLeft: '-0.4375rem',
  marginTop: '-0.4375rem',
  backgroundColor: '#5B39F3',
  borderRadius: '50%',
  border: '2px solid #FFFFFF',
  // Outer ring matches brand primary so the dot remains visible
  // against any pad background variation.
  boxShadow: '0 0 0 1px #5B39F3',
  pointerEvents: 'none',
};

const POSITION_READOUT_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  color: '#333333',
  // Tabular-nums keeps values like "0.10" / "-0.05" from jiggling
  // horizontally as the digits change.
  fontVariantNumeric: 'tabular-nums',
  margin: 0,
};

const COORD_INPUTS_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
};

const COORD_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flex: 1,
};

const COORD_LABEL_TEXT_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: '#2D1C77',
  minWidth: '0.75rem',
};

const COORD_INPUT_STYLE: CSSProperties = {
  flex: 1,
  padding: '0.25rem 0.5rem',
  fontSize: '0.8125rem',
  border: '1px solid #D9D9D9',
  borderRadius: '0.25rem',
  fontVariantNumeric: 'tabular-nums',
  backgroundColor: '#FFFFFF',
  color: '#333333',
};

const SCALE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
};

const SCALE_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const SCALE_LABEL_TEXT_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: '#2D1C77',
  minWidth: '3rem',
};

const SCALE_SLIDER_STYLE: CSSProperties = {
  flex: 1,
  // ---------------------------------------------------------------------
  // QA Issue #15 — brand-colour the native range slider's filled track
  // and thumb. Without `accent-color`, Chromium / WebKit / Firefox
  // render the slider in their default neutral grey (~`#9D968E`),
  // which is OFF the AAP Blitzy palette and makes the slider visibly
  // off-brand against the surrounding purple swatches and primary
  // CTA. `accent-color: #5B39F3` (Blitzy primary) recolours the
  // filled portion of the track and the thumb in every modern
  // browser using the documented brand primary, with no need for
  // browser-specific `::-webkit-slider-thumb` pseudo-elements.
  // The value is hard-coded rather than `var(--blitzy-primary)`
  // because `accent-color` does not interpolate CSS variables in
  // every browser engine version (notably older Safari) — using the
  // literal hex guarantees deterministic rendering.
  // ---------------------------------------------------------------------
  accentColor: '#5B39F3',
};

const SCALE_VALUE_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: '#333333',
  minWidth: '3rem',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const RESET_BUTTON_STYLE: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '0.375rem 0.75rem',
  borderRadius: '0.25rem',
  border: '1px solid #2D1C77',
  backgroundColor: 'transparent',
  color: '#2D1C77',
  fontSize: '0.8125rem',
  cursor: 'pointer',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * `LogoPositioner` — renders the position pad, X/Y numeric inputs,
 * scale slider, position / scale readouts, and a local reset button.
 *
 * No props — the component subscribes to the global Zustand store
 * for both reading current state and dispatching mutations.
 *
 * The component is rendered unconditionally inside `App.tsx` (it is
 * always present in the control sidebar). It remains operable even
 * before a logo is uploaded — the position / scale slices in the
 * store are settable at all times, and the texture pipeline applies
 * them whenever a logo eventually appears. A polite hint is shown
 * while no logo is staged so users understand the visual effect is
 * deferred until upload.
 */
export function LogoPositioner(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions — slice-only selectors per Zustand best
  // practice (AAP §0.5.2). Subscribing to the entire store would
  // re-render this component on every unrelated slice change (e.g.,
  // color picker clicks).
  // -------------------------------------------------------------------------
  const logoFile = useConfiguratorStore((s) => s.logoFile);
  const logoPosition = useConfiguratorStore((s) => s.logoPosition);
  const logoScale = useConfiguratorStore((s) => s.logoScale);
  const setLogoPosition = useConfiguratorStore((s) => s.setLogoPosition);
  const setLogoScale = useConfiguratorStore((s) => s.setLogoScale);

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /**
   * Serialized async queue for texture-pipeline updates.
   *
   * Mirrors the canonical pattern from `FinishSelector.tsx` and
   * `StitchingPatternSelector.tsx` exactly:
   *   - Initial value `Promise.resolve()` so the first call has a
   *     resolved precursor to chain off of.
   *   - LEADING `.catch(() => undefined)` swallows any prior rejection
   *     so the chain never deadlocks — a single failed pipeline call
   *     must not poison every subsequent update.
   *   - TRAILING `.catch(() => undefined)` swallows any new rejection
   *     so React 18's unhandled-promise warnings stay quiet AND the
   *     `@typescript-eslint/no-floating-promises` lint rule passes.
   */
  const pipelineQueueRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * Pad DOM ref. Used for:
   *   1. `getBoundingClientRect()` in `computePadCoords()` to convert
   *      pointer client coordinates into normalized pad coordinates.
   *   2. Pointer-capture acquisition / release so drags continue when
   *      the pointer leaves the pad's bounds (otherwise fast drags
   *      "stick" because move/up events stop being delivered).
   */
  const padRef = useRef<HTMLDivElement | null>(null);

  // -------------------------------------------------------------------------
  // Local UI state
  // -------------------------------------------------------------------------

  /**
   * The pointer id currently captured by the pad, or `null` when no
   * drag is in progress. Tracking this prevents a stray pointermove
   * from a different pointer (e.g., a second finger on a multi-touch
   * device) from advancing the position mid-drag.
   */
  const [activePointerId, setActivePointerId] = useState<number | null>(null);

  /**
   * String-typed staging buffers for the numeric X/Y inputs.
   *
   * Why strings: `<input type="number">`'s `value` attribute is a
   * string; if we bound `value={logoPosition.x}` directly and parsed
   * + committed on every keystroke, typing `"-0.5"` would fail the
   * `Number.parseFloat` round-trip at the intermediate `"-"` and
   * `"-0."` states, snapping the input back to the prior committed
   * value before the user could finish typing. Buffering as a string
   * and committing only on blur or Enter avoids that snap-back.
   *
   * The buffers are seeded from the current store values via the
   * functional initializer form so `logoPosition.x.toFixed(2)` runs
   * exactly once at mount.
   */
  const [xInputBuffer, setXInputBuffer] = useState<string>(() =>
    formatAxis(logoPosition.x),
  );
  const [yInputBuffer, setYInputBuffer] = useState<string>(() =>
    formatAxis(logoPosition.y),
  );

  // -------------------------------------------------------------------------
  // Pipeline dispatch helper
  // -------------------------------------------------------------------------

  /**
   * Queue a texture-pipeline refresh on the FIFO chain.
   *
   * Captures a snapshot via `useConfiguratorStore.getState()` AT
   * EXECUTION TIME (inside the `.then(...)` callback), so the
   * snapshot reflects the most-recently committed store state when
   * the pipeline call actually runs. This is the appropriate
   * semantic for logo positioning: rapid-fire pointermove events
   * that all set the SAME slice should collapse to "apply the latest
   * position" rather than each carrying its own snapshot — the
   * visual effect is the same and the GPU upload count is reduced.
   */
  const dispatchPipeline = useCallback((): void => {
    pipelineQueueRef.current = pipelineQueueRef.current
      .catch(() => undefined)
      .then(() => texturePipeline.update(useConfiguratorStore.getState()))
      .catch(() => undefined);
  }, []);

  // -------------------------------------------------------------------------
  // Drag pad pointer handlers
  // -------------------------------------------------------------------------

  const handlePadPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const pad = padRef.current;
      if (pad === null) return;
      // Only respond to PRIMARY mouse button (left-click). Touch and
      // pen pointer types fire `button = 0` for their initial press,
      // so this check is mouse-specific. Without it, right-click on
      // a mouse would erroneously initiate a drag.
      if (event.button !== 0 && event.pointerType === 'mouse') return;

      // Acquire pointer capture so subsequent move/up events route
      // to this element even if the cursor exits its bounding rect.
      pad.setPointerCapture(event.pointerId);
      setActivePointerId(event.pointerId);

      // Apply the initial pointer position immediately — clicking on
      // the pad without dragging should still move the dot to the
      // clicked location (vs. only responding to drags).
      const { x, y } = computePadCoords(event, pad);
      setLogoPosition({ x, y });
      setXInputBuffer(formatAxis(x));
      setYInputBuffer(formatAxis(y));
      dispatchPipeline();
    },
    [setLogoPosition, dispatchPipeline],
  );

  const handlePadPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      // Ignore pointermove events when no drag is in progress, or
      // when a different pointer is moving (multi-touch second
      // finger).
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      const pad = padRef.current;
      if (pad === null) return;
      const { x, y } = computePadCoords(event, pad);
      setLogoPosition({ x, y });
      setXInputBuffer(formatAxis(x));
      setYInputBuffer(formatAxis(y));
      dispatchPipeline();
    },
    [activePointerId, setLogoPosition, dispatchPipeline],
  );

  const handlePadPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      // Only reset capture / activePointerId for the SAME pointer
      // that was captured on pointerdown. A pointerup from a
      // different pointer should not terminate the in-flight drag.
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      const pad = padRef.current;
      if (pad !== null && pad.hasPointerCapture(event.pointerId)) {
        pad.releasePointerCapture(event.pointerId);
      }
      setActivePointerId(null);
    },
    [activePointerId],
  );

  // -------------------------------------------------------------------------
  // Keyboard accessibility on the pad
  // -------------------------------------------------------------------------

  /**
   * Arrow keys nudge the position by `POSITION_STEP` (0.05) per
   * press. ArrowUp INCREASES y (the pad's top edge is y = +1, so
   * "up" means more positive). Home recenters the position to
   * (0, 0) — scale is intentionally not reset by Home so the
   * keyboard contract stays surprise-free.
   */
  const handlePadKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      let { x, y } = logoPosition;
      let handled = false;
      switch (event.key) {
        case 'ArrowLeft':
          x = clampAxis(x - POSITION_STEP);
          handled = true;
          break;
        case 'ArrowRight':
          x = clampAxis(x + POSITION_STEP);
          handled = true;
          break;
        case 'ArrowUp':
          // Top of pad is y = +1, so "up" adds to y.
          y = clampAxis(y + POSITION_STEP);
          handled = true;
          break;
        case 'ArrowDown':
          y = clampAxis(y - POSITION_STEP);
          handled = true;
          break;
        case 'Home':
          x = 0;
          y = 0;
          handled = true;
          break;
        default:
          return;
      }
      if (handled) {
        // Prevent the browser default (e.g., page scroll on arrows)
        // ONLY when we successfully handled the key — passing
        // through unrelated keys like Tab or Escape is essential.
        event.preventDefault();
        setLogoPosition({ x, y });
        setXInputBuffer(formatAxis(x));
        setYInputBuffer(formatAxis(y));
        dispatchPipeline();
      }
    },
    [logoPosition, setLogoPosition, dispatchPipeline],
  );

  // -------------------------------------------------------------------------
  // Numeric X/Y input handlers
  // -------------------------------------------------------------------------

  /**
   * Commit the X-axis input buffer to the store after parse + clamp.
   * Invalid values (NaN, non-numeric) revert the buffer to the
   * current store value, providing visual feedback that the input
   * was rejected without producing a hard error.
   */
  const commitXInput = useCallback(
    (raw: string): void => {
      const parsed = Number.parseFloat(raw);
      if (Number.isNaN(parsed)) {
        setXInputBuffer(formatAxis(logoPosition.x));
        return;
      }
      const clamped = clampAxis(parsed);
      setLogoPosition({ x: clamped, y: logoPosition.y });
      setXInputBuffer(formatAxis(clamped));
      dispatchPipeline();
    },
    [logoPosition, setLogoPosition, dispatchPipeline],
  );

  /** Commit the Y-axis input buffer to the store after parse + clamp. */
  const commitYInput = useCallback(
    (raw: string): void => {
      const parsed = Number.parseFloat(raw);
      if (Number.isNaN(parsed)) {
        setYInputBuffer(formatAxis(logoPosition.y));
        return;
      }
      const clamped = clampAxis(parsed);
      setLogoPosition({ x: logoPosition.x, y: clamped });
      setYInputBuffer(formatAxis(clamped));
      dispatchPipeline();
    },
    [logoPosition, setLogoPosition, dispatchPipeline],
  );

  /**
   * `onChange` for the X input — updates the staging buffer ONLY.
   * Commit happens on blur or Enter via `commitXInput`. This split
   * is necessary so partial typed values like `"-"` don't fail-parse
   * mid-keystroke.
   */
  const handleXChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setXInputBuffer(event.target.value);
    },
    [],
  );

  /** `onChange` for the Y input — see `handleXChange` for rationale. */
  const handleYChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setYInputBuffer(event.target.value);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Scale slider handler
  // -------------------------------------------------------------------------

  /**
   * `onChange` for the scale range slider. The browser-native `min`
   * / `max` attributes ensure the input cannot deliver an
   * out-of-range value via UI interaction; we still call
   * `clampScale` defensively so that programmatic changes
   * (e.g., `slider.fill('3')` in a Playwright test, which the
   * browser auto-clamps to 2.5) cannot leak through with a stale
   * raw value.
   */
  const handleScaleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const raw = Number.parseFloat(event.target.value);
      if (Number.isNaN(raw)) return;
      const clamped = clampScale(raw);
      setLogoScale(clamped);
      dispatchPipeline();
    },
    [setLogoScale, dispatchPipeline],
  );

  // -------------------------------------------------------------------------
  // Reset handler
  // -------------------------------------------------------------------------

  /**
   * Reset ONLY the position and scale slices to documented defaults.
   * Preserves the uploaded `logoFile`, colors, pattern, and finish.
   *
   * This complements (does not replace) the Zustand store's
   * `resetToDefaults` action exposed by NewDesignDialog (ST-020),
   * which clears EVERY slice. Per ST-016-AC4, full default
   * restoration is the documented behavior; this local reset is UX
   * polish for users who want to rebaseline logo placement without
   * losing their other selections.
   */
  const handleReset = useCallback((): void => {
    setLogoPosition({ x: DEFAULT_POSITION_X, y: DEFAULT_POSITION_Y });
    setLogoScale(DEFAULT_SCALE);
    setXInputBuffer(formatAxis(DEFAULT_POSITION_X));
    setYInputBuffer(formatAxis(DEFAULT_POSITION_Y));
    dispatchPipeline();
  }, [setLogoPosition, setLogoScale, dispatchPipeline]);

  // -------------------------------------------------------------------------
  // Derived render values
  // -------------------------------------------------------------------------

  // Format current values for both the data-* attributes (read by
  // the Playwright spec via toHaveAttribute) and the human-readable
  // inline readouts.
  const xString = formatAxis(logoPosition.x);
  const yString = formatAxis(logoPosition.y);
  const scaleString = formatScaleNumeric(logoScale);

  // Convert the normalized [-1, 1] position to a [0, 100]% CSS
  // anchor for the visual dot handle.
  //   x: dotLeft = (x + 1) * 50 → x=-1 → 0%, x=+1 → 100%
  //   y: dotTop  = (1 - y) * 50 → y=+1 (top) → 0%, y=-1 (bottom) → 100%
  // The y inversion mirrors the pad's flipped coordinate
  // convention: positive y means "up" on screen, so it must map to
  // a smaller `top` percent.
  const dotLeftPercent = (logoPosition.x + 1) * 50;
  const dotTopPercent = (1 - logoPosition.y) * 50;

  const noLogo = logoFile === null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section
      aria-label="Logo placement"
      style={SECTION_STYLE}
      data-testid="logo-positioner"
      data-has-logo={noLogo ? 'false' : 'true'}
    >
      <p id="logo-positioner-heading" style={HEADING_STYLE}>
        Logo position &amp; scale
      </p>

      {/*
       * Polite hint shown while no logo is staged. The position /
       * scale controls remain fully operable so the user can
       * configure desired placement before uploading; the hint just
       * explains why no visual change appears on the preview yet.
       */}
      {noLogo && (
        <p style={HINT_STYLE} aria-live="polite" data-testid="logo-positioner-hint">
          Upload a logo to see your placement on the preview.
        </p>
      )}

      {/*
       * 2D drag pad. ARIA contract:
       *   - role="application" tells assistive tech this is a
       *     custom widget that owns its keyboard interactions; AT
       *     should pass arrow keys through rather than intercepting
       *     them for their own navigation gestures.
       *   - aria-label names the widget. We intentionally do NOT
       *     set aria-valuetext here — the WAI-ARIA spec lists
       *     valuetext as a property of slider / spinbutton /
       *     scrollbar / progressbar / meter, and jsx-a11y rejects
       *     it on role="application". The aria-live readout below
       *     announces position changes instead.
       *   - data-x / data-y attributes carry the current position
       *     in machine-readable form (used by the Playwright spec
       *     to verify state transitions).
       *   - tabIndex={0} so the pad is reachable via Tab from the
       *     surrounding controls. The frontend .eslintrc.json
       *     explicitly allows tabindex on role="application" via
       *     the `roles` option of jsx-a11y/no-noninteractive-tabindex.
       *
       * jsx-a11y note: The `no-noninteractive-element-interactions`
       * rule treats role="application" as a non-interactive
       * container by default, even though WAI-ARIA defines it as
       * the role for custom widgets that own their keyboard. The
       * inline disable below scopes a single-element exception so
       * the widget can attach its own keyboard handler — exactly
       * the pattern WAI-ARIA prescribes for application widgets.
       */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role="application" is the WAI-ARIA-prescribed role for a custom widget that owns its keyboard; attaching onKeyDown is the entire point. */}
      <div
        ref={padRef}
        role="application"
        aria-label="Logo position pad"
        data-testid="logo-position-pad"
        data-x={xString}
        data-y={yString}
        tabIndex={0}
        onPointerDown={handlePadPointerDown}
        onPointerMove={handlePadPointerMove}
        onPointerUp={handlePadPointerUp}
        onPointerCancel={handlePadPointerUp}
        onKeyDown={handlePadKeyDown}
        style={PAD_STYLE}
      >
        {/* Crosshair lines marking the panel center (0, 0). Decorative. */}
        <div style={PAD_CROSSHAIR_H_STYLE} aria-hidden="true" />
        <div style={PAD_CROSSHAIR_V_STYLE} aria-hidden="true" />

        {/*
         * Position dot handle. Decorative — the actual interaction
         * surface is the pad itself. Inline `left` / `top` are
         * computed from `logoPosition` so the dot tracks the stored
         * value. `pointer-events: none` (in PAD_DOT_STYLE) ensures
         * the dot never swallows pointer events meant for the pad.
         */}
        <div
          style={{
            ...PAD_DOT_STYLE,
            left: `${dotLeftPercent}%`,
            top: `${dotTopPercent}%`,
          }}
          aria-hidden="true"
          data-testid="logo-position-dot"
        />
      </div>

      {/*
       * Human-readable position readout (ST-015-AC4). The text
       * format "Position: x=N.NN, y=N.NN" matches the Playwright
       * spec contract (`positioner.toContainText('Position: x=0.10, y=0.05')`).
       * `aria-live="polite"` announces changes without interrupting
       * the user's current screen-reader focus.
       */}
      <p
        style={POSITION_READOUT_STYLE}
        aria-live="polite"
        data-testid="logo-positioner-readout"
      >
        Position: x={xString}, y={yString}
      </p>

      {/*
       * Numeric X/Y inputs (ST-015-AC2). Each has:
       *   - `min={-1}` / `max={1}` for browser-level boundary
       *     enforcement
       *   - `step={POSITION_STEP}` for keyboard arrow-key fine
       *     control in supported browsers
       *   - String-buffer state via xInputBuffer / yInputBuffer so
       *     the user can type partial values like "-" without
       *     snap-back
       *   - Commit on blur AND on Enter keypress — matches the
       *     standard `<input type="number">` UX
       */}
      <div style={COORD_INPUTS_ROW_STYLE}>
        <label style={COORD_LABEL_STYLE}>
          <span style={COORD_LABEL_TEXT_STYLE}>X</span>
          <input
            type="number"
            min={-1}
            max={1}
            step={POSITION_STEP}
            value={xInputBuffer}
            onChange={handleXChange}
            onBlur={(e) => commitXInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitXInput((e.target as HTMLInputElement).value);
              }
            }}
            aria-label="Logo horizontal position"
            style={COORD_INPUT_STYLE}
            data-testid="logo-positioner-x-input"
          />
        </label>
        <label style={COORD_LABEL_STYLE}>
          <span style={COORD_LABEL_TEXT_STYLE}>Y</span>
          <input
            type="number"
            min={-1}
            max={1}
            step={POSITION_STEP}
            value={yInputBuffer}
            onChange={handleYChange}
            onBlur={(e) => commitYInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitYInput((e.target as HTMLInputElement).value);
              }
            }}
            aria-label="Logo vertical position"
            style={COORD_INPUT_STYLE}
            data-testid="logo-positioner-y-input"
          />
        </label>
      </div>

      {/*
       * Scale slider (ST-016-AC1, ST-016-AC2, ST-016-AC3).
       * Browser-native range input clamps to
       * `[MIN_SCALE, MAX_SCALE]` so an out-of-range value cannot
       * reach `handleScaleChange` via UI interaction. The
       * `data-scale` attribute carries the current scale rounded
       * to 2 decimals — read by the Playwright spec.
       */}
      <div style={SCALE_ROW_STYLE}>
        <label style={SCALE_LABEL_STYLE}>
          <span style={SCALE_LABEL_TEXT_STYLE}>Scale</span>
          <input
            type="range"
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={SCALE_STEP}
            value={logoScale}
            onChange={handleScaleChange}
            aria-label="Logo scale"
            style={SCALE_SLIDER_STYLE}
            data-testid="logo-scale-slider"
            data-scale={scaleString}
          />
          <span
            style={SCALE_VALUE_STYLE}
            aria-live="polite"
            data-testid="logo-scale-readout"
          >
            {scaleString}
            {'\u00D7'}
          </span>
        </label>
      </div>

      {/*
       * Reset button — restores ONLY position and scale to defaults.
       * Distinct from the global "New Design" reset in
       * NewDesignDialog which clears EVERY slice including the
       * uploaded file.
       */}
      <button
        type="button"
        onClick={handleReset}
        aria-label="Reset logo position and scale to defaults"
        style={RESET_BUTTON_STYLE}
        data-testid="logo-positioner-reset"
      >
        Reset position &amp; scale
      </button>
    </section>
  );
}
