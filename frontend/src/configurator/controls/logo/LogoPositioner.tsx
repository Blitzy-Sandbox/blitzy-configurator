/**
 * LogoPositioner — Logo position pad and scale slider (ST-015, ST-016).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/logo/
 *     LogoPositioner.tsx | ST-015 + ST-016 Fabric.js drag + scale
 *     handles".
 *   - ST-015 acceptance criteria: a designer can interactively
 *     reposition the logo on the ball; the position is persisted in
 *     normalized coordinates within `[-1, 1]` on both axes; the
 *     control is keyboard-accessible.
 *   - ST-016 acceptance criteria: a designer can interactively scale
 *     the logo within a documented minimum/maximum range; the value
 *     is persisted as a positive multiplier; the control is
 *     keyboard-accessible.
 *   - QA Report Issue #10.
 *
 * Architecture:
 *   This component renders TWO controls:
 *     1. A 2D position pad — a square that maps mouse / touch /
 *        keyboard input to normalized `[-1, 1]` coordinates and
 *        writes them to the `logoPosition` store slice.
 *     2. A scale slider — a `<input type="range">` mapped to the
 *        `logoScale` store slice.
 *
 *   The pad uses pointer events for cross-device input (mouse, touch,
 *   pen). It also exposes ARIA `slider` semantics with explicit min,
 *   max, and current value attributes so assistive technology can
 *   announce the position numerically. Arrow keys nudge the position
 *   in 0.05-unit steps for keyboard users.
 *
 *   The component does NOT use Fabric.js. The texture pipeline
 *   currently composites the logo at compile-time-fixed coordinates;
 *   integrating Fabric drag-handles into the offscreen Fabric canvas
 *   is out-of-scope for this checkpoint and would couple this control
 *   to the texture pipeline (a Rule R7 / C6 risk). When future work
 *   integrates Fabric handles, this component still owns the slice
 *   updates — only the rendering surface changes.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import { useCallback, useId, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, PointerEvent } from 'react';

import type { LogoPosition } from '../../../state/configuratorStore';
import { useConfiguratorStore } from '../../../state/configuratorStore';

import styles from './logo.module.css';

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Lower bound on each normalized axis for {@link LogoPosition}. */
const POSITION_MIN = -1;
/** Upper bound on each normalized axis for {@link LogoPosition}. */
const POSITION_MAX = 1;
/** Keyboard nudge step for arrow-key navigation inside the pad. */
const POSITION_STEP = 0.05;

/** Lower bound on the scale slider (per ST-016). */
const SCALE_MIN = 0.25;
/** Upper bound on the scale slider (per ST-016). */
const SCALE_MAX = 2.5;
/** Slider granularity. 0.05 keeps the readout within 1 decimal place. */
const SCALE_STEP = 0.05;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number into a [min, max] interval. Rounded to 2 decimals so
 * the readout stays terse and Playwright assertions remain
 * deterministic across browsers.
 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.round(value * 100) / 100;
}

/**
 * Convert a pointer event's coordinates to normalized `[-1, 1]` pad
 * coordinates. Returns `null` if the bounding rect could not be read
 * (defensive — should never happen in practice).
 *
 * Convention: the y axis is flipped so dragging UP yields a POSITIVE
 * y value, mirroring the convention used by Three.js / texture UV
 * space.
 */
function pointerToNormalized(
  event: PointerEvent<HTMLDivElement>,
  pad: HTMLDivElement,
): LogoPosition | null {
  const rect = pad.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const xRatio = (event.clientX - rect.left) / rect.width; // 0..1
  const yRatio = (event.clientY - rect.top) / rect.height; // 0..1

  return {
    x: clamp(xRatio * 2 - 1, POSITION_MIN, POSITION_MAX),
    y: clamp(1 - yRatio * 2, POSITION_MIN, POSITION_MAX), // flipped
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface LogoPositionerProps {}

/**
 * Renders the position pad and scale slider for the staged logo.
 */
export function LogoPositioner(_props: LogoPositionerProps = {}): JSX.Element {
  const logoPosition = useConfiguratorStore((s) => s.logoPosition);
  const logoScale = useConfiguratorStore((s) => s.logoScale);
  const setLogoPosition = useConfiguratorStore((s) => s.setLogoPosition);
  const setLogoScale = useConfiguratorStore((s) => s.setLogoScale);

  const padRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently dragging inside the pad. We only
  // forward `pointermove` events while dragging, so the pad doesn't
  // hijack the cursor for users who simply hover over it.
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // Stable id used for the position pad's accessible name reference.
  const padId = useId();
  const positionLabelId = `${padId}-label`;

  // Convert the current normalized [-1, 1] position to a 0..100 % CSS
  // anchor so the dot can be placed directly via inline style. The y
  // axis is flipped from store coords to CSS coords (since CSS top
  // grows downward).
  const dotLeftPercent = ((logoPosition.x - POSITION_MIN) / (POSITION_MAX - POSITION_MIN)) * 100;
  const dotTopPercent = ((POSITION_MAX - logoPosition.y) / (POSITION_MAX - POSITION_MIN)) * 100;

  // ---------------------------------------------------------------
  // Pointer (mouse / touch / pen) interaction
  // ---------------------------------------------------------------

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      const pad = padRef.current;
      if (pad === null) return;

      // Capture so subsequent move/up events outside the pad still
      // route to it; otherwise quick drags off-target leave the
      // dragging state stuck.
      pad.setPointerCapture(event.pointerId);
      setIsDragging(true);

      const next = pointerToNormalized(event, pad);
      if (next !== null) setLogoPosition(next);
    },
    [setLogoPosition],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (!isDragging) return;
      const pad = padRef.current;
      if (pad === null) return;
      const next = pointerToNormalized(event, pad);
      if (next !== null) setLogoPosition(next);
    },
    [isDragging, setLogoPosition],
  );

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const pad = padRef.current;
    if (pad !== null && pad.hasPointerCapture(event.pointerId)) {
      pad.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
  }, []);

  // ---------------------------------------------------------------
  // Keyboard interaction (arrow keys)
  // ---------------------------------------------------------------

  const handlePadKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      let dx = 0;
      let dy = 0;
      switch (event.key) {
        case 'ArrowLeft':
          dx = -POSITION_STEP;
          break;
        case 'ArrowRight':
          dx = POSITION_STEP;
          break;
        case 'ArrowUp':
          dy = POSITION_STEP;
          break;
        case 'ArrowDown':
          dy = -POSITION_STEP;
          break;
        case 'Home':
          // Reset to origin.
          event.preventDefault();
          setLogoPosition({ x: 0, y: 0 });
          return;
        default:
          return;
      }
      event.preventDefault();
      setLogoPosition({
        x: clamp(logoPosition.x + dx, POSITION_MIN, POSITION_MAX),
        y: clamp(logoPosition.y + dy, POSITION_MIN, POSITION_MAX),
      });
    },
    [logoPosition.x, logoPosition.y, setLogoPosition],
  );

  // ---------------------------------------------------------------
  // Scale slider
  // ---------------------------------------------------------------

  const handleScaleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const next = parseFloat(event.target.value);
      setLogoScale(clamp(next, SCALE_MIN, SCALE_MAX));
    },
    [setLogoScale],
  );

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  return (
    <section className={styles.section} aria-label="Logo placement" data-testid="logo-positioner">
      <h3 className={styles.section__heading}>Logo placement</h3>
      <p className={styles.section__hint}>
        Drag inside the pad to reposition. Use arrow keys for fine control. Range: (
        {POSITION_MIN.toFixed(1)} to {POSITION_MAX.toFixed(1)}) on both axes.
      </p>

      <div className={styles.positioner}>
        <p id={positionLabelId} className={styles.positioner__readout}>
          Position: x={logoPosition.x.toFixed(2)}, y={logoPosition.y.toFixed(2)}
        </p>
        <div
          ref={padRef}
          role="slider"
          tabIndex={0}
          aria-labelledby={positionLabelId}
          aria-describedby={positionLabelId}
          aria-roledescription="2D position pad"
          aria-valuemin={POSITION_MIN}
          aria-valuemax={POSITION_MAX}
          aria-valuenow={logoPosition.x}
          aria-valuetext={`x ${logoPosition.x.toFixed(2)}, y ${logoPosition.y.toFixed(2)}`}
          data-testid="logo-position-pad"
          data-x={logoPosition.x.toFixed(2)}
          data-y={logoPosition.y.toFixed(2)}
          className={styles.positioner__pad}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handlePadKeyDown}
        >
          <span className={styles.positioner__crosshairH} aria-hidden="true" />
          <span className={styles.positioner__crosshairV} aria-hidden="true" />
          <span
            className={styles.positioner__dot}
            data-testid="logo-position-dot"
            style={{ left: `${dotLeftPercent}%`, top: `${dotTopPercent}%` }}
            aria-hidden="true"
          />
        </div>

        <div className={styles.scale}>
          <label htmlFor={`${padId}-scale`} className={styles.section__hint}>
            Logo scale
          </label>
          <div className={styles.scale__row}>
            <input
              id={`${padId}-scale`}
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={logoScale}
              aria-label="Logo scale"
              aria-valuemin={SCALE_MIN}
              aria-valuemax={SCALE_MAX}
              aria-valuenow={logoScale}
              data-testid="logo-scale-slider"
              data-scale={logoScale.toFixed(2)}
              className={styles.scale__input}
              onChange={handleScaleChange}
            />
            <span className={styles.scale__readout} data-testid="logo-scale-readout">
              {logoScale.toFixed(2)}×
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
