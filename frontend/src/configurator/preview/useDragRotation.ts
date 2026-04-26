/**
 * useDragRotation — pointer-driven 3D ball rotation hook (ST-002).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/useDragRotation.ts
 *     | Click-and-drag rotation; no snap-back; free rotation around all
 *     axes (ST-002)".
 *   - ST-002 acceptance criteria:
 *       AC1 Pressing and dragging the primary pointer rotates the ball
 *           in the direction of the drag.
 *       AC2 Rotation continues to follow the pointer with no perceptible
 *           input lag.
 *       AC3 Releasing the pointer leaves the ball at its final rotated
 *           orientation without snapping back.
 *       AC4 The ball can be rotated freely about any axis across the
 *           full range of motion.
 *   - QA Report Issue #5 — `useDragRotation.ts` MUST exist; the
 *     quaternion composition order is `autoRotationAccum.multiply(dragRotation)`
 *     so auto-rotation applies AFTER drag rotation (consumed by
 *     `useIdleAutoRotate.ts`).
 *
 * Responsibilities:
 *   1. Attach pointer event handlers to a referenced DOM element (the
 *      R3F <Canvas>'s underlying <canvas>) using passive listeners.
 *   2. Translate pointer pixel deltas into rotation around the world X
 *      and Y axes using small-angle quaternion rotations.
 *   3. Compose drag rotations into a persistent `dragRotation` quaternion
 *      ref that survives across renders without forcing React re-renders.
 *   4. Expose an `isDragging` boolean (also a ref-style setter to a
 *      Zustand-free local state) and an `onIdleResetRequested` notifier
 *      so `useIdleAutoRotate.ts` can detect interaction.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched. Drag rotation does not alter the
 *     texture, only the mesh's quaternion.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Touch / multi-touch gestures (the reference hardware profile per
 *     ST-002 is desktop with a primary pointer; pinch zoom and two-finger
 *     pan are not in ST-002's acceptance criteria).
 *   - Inertia / momentum on release (ST-002-AC3 explicitly requires the
 *     ball to stay at its final orientation, NOT continue spinning).
 *   - Camera controls (handled by R3F itself in `BallCanvas.tsx`).
 */

import { useCallback, useEffect, useRef } from 'react';
import { Quaternion, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional notification callback invoked whenever the user starts a
 * drag interaction. Used by `useIdleAutoRotate.ts` to interrupt
 * auto-rotation immediately on user interaction (ST-003-AC2).
 */
export type InteractionNotifier = () => void;

/**
 * The hook's return surface. Components attach `attachRef` to the R3F
 * canvas's parent DOM node and read the `dragRotationRef` quaternion
 * inside their `useFrame` loop to compose the final mesh rotation:
 *
 *     const finalQuat = autoRotationAccum.clone().multiply(dragRotationRef.current);
 *     mesh.quaternion.copy(finalQuat);
 *
 * Composition order matters per QA Report Issue #5: auto-rotation
 * applies AFTER drag rotation, so drag-rotation is the right operand
 * of `autoRotationAccum.multiply(...)`.
 */
export interface DragRotationApi {
  /**
   * Attach this ref to the DOM element that should receive pointer
   * events (typically the R3F <Canvas>'s wrapping <div> or the
   * underlying <canvas> element).
   */
  readonly attachRef: React.RefObject<HTMLElement>;

  /**
   * The accumulated drag rotation quaternion. Mutated in place across
   * frames; consumers MUST `.clone()` before further composition so the
   * accumulator itself is not corrupted by intermediate operations.
   */
  readonly dragRotationRef: React.MutableRefObject<Quaternion>;

  /**
   * Returns `true` while the primary pointer is down inside the canvas.
   * Used by `useIdleAutoRotate.ts` to keep auto-rotation paused for the
   * full duration of an interactive drag.
   */
  readonly isDraggingRef: React.MutableRefObject<boolean>;
}

/**
 * Configuration accepted by `useDragRotation`. Defaults are tuned for
 * the desktop reference hardware profile (1280×720 viewport, mouse
 * input).
 */
export interface DragRotationOptions {
  /**
   * Pixel-to-radian sensitivity. The default `0.005` rad/px translates
   * a 200-px horizontal drag to ≈1 radian (≈57°) of rotation, which
   * matches the documented configurator UX of "approximately one full
   * revolution per ~1200 px of horizontal drag". Lower values produce
   * a more deliberate feel; higher values are jumpier.
   */
  readonly sensitivityRadPerPx?: number;

  /**
   * Optional callback fired the moment a drag begins. Used to interrupt
   * auto-rotation per ST-003-AC2.
   */
  readonly onInteractionStart?: InteractionNotifier;
}

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Default pixel-to-radian sensitivity (rad/px). */
const DEFAULT_SENSITIVITY_RAD_PER_PX = 0.005;

/** Reusable axis vectors — avoid per-frame allocations. */
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * React hook that turns pointer drags inside the referenced DOM element
 * into accumulated quaternion rotations.
 *
 * Usage:
 *
 *     const { attachRef, dragRotationRef, isDraggingRef } = useDragRotation({
 *       sensitivityRadPerPx: 0.005,
 *       onInteractionStart: notifyInteraction,
 *     });
 *
 *     return (
 *       <div ref={attachRef as React.RefObject<HTMLDivElement>}>
 *         <Canvas>...</Canvas>
 *       </div>
 *     );
 *
 * The hook installs `pointerdown`, `pointermove`, `pointerup`, and
 * `pointercancel` listeners on the referenced element. `pointerdown`
 * captures the pointer (`setPointerCapture`) so subsequent moves
 * outside the element still flow to our handlers — without this, a
 * drag that wandered off the canvas would silently desync.
 *
 * The drag rotation itself is computed by:
 *   1. Reading the per-frame pixel delta (dx, dy) from the pointermove
 *      event.
 *   2. Converting (dx, dy) to (yawRad, pitchRad) via the sensitivity.
 *   3. Building two small quaternions for yaw and pitch around the
 *      world Y and X axes respectively.
 *   4. Pre-multiplying both into `dragRotationRef.current` so the
 *      newest rotation applies on top of the existing accumulated drag.
 *
 * Releasing the pointer (`pointerup` / `pointercancel`) does NOT reset
 * the accumulator — the ball stays exactly where the user left it,
 * satisfying ST-002-AC3.
 */
export function useDragRotation(options: DragRotationOptions = {}): DragRotationApi {
  const sensitivity = options.sensitivityRadPerPx ?? DEFAULT_SENSITIVITY_RAD_PER_PX;

  // Capture `onInteractionStart` in a ref so the listener closure does
  // not stale-close over an old callback if the consumer's render
  // produces a fresh function reference each render.
  const interactionNotifierRef = useRef<InteractionNotifier | undefined>(options.onInteractionStart);
  useEffect(() => {
    interactionNotifierRef.current = options.onInteractionStart;
  }, [options.onInteractionStart]);

  // The DOM element that receives pointer events (set by the consumer
  // via the returned `attachRef`).
  const attachRef = useRef<HTMLElement>(null);

  // The drag rotation accumulator. Initialized as identity — no
  // rotation. Persists across renders without triggering re-renders
  // (useRef guarantees this).
  const dragRotationRef = useRef<Quaternion>(new Quaternion());

  // The "is currently dragging" flag, exposed as a ref so external
  // hooks (`useIdleAutoRotate`) can read it without subscribing to
  // React state.
  const isDraggingRef = useRef<boolean>(false);

  // Last known pointer position — used to compute per-event deltas
  // since pointer events do NOT carry `movementX`/`movementY` in a
  // browser-portable way (Safari/WebKit values can be unreliable).
  const lastXRef = useRef<number>(0);
  const lastYRef = useRef<number>(0);

  // Active pointer ID — null when no drag is in progress. Used to
  // ensure we only respond to events from the originating pointer
  // (ignoring secondary pointers from a multi-pointer device).
  const activePointerIdRef = useRef<number | null>(null);

  // -----------------------------------------------------------------------
  // Stable event handlers (memoized via useCallback — referenced by
  // the addEventListener / removeEventListener pair).
  // -----------------------------------------------------------------------

  const handlePointerDown = useCallback((event: PointerEvent): void => {
    // Only react to the primary pointer (mouse left button, primary
    // touch, primary stylus). Secondary buttons and additional touches
    // are intentionally ignored per ST-002-AC1 ("primary pointer").
    if (!event.isPrimary) {
      return;
    }
    // Prevent the browser's default text-selection / image-drag
    // behavior on canvas/parent elements.
    event.preventDefault();

    const target = attachRef.current;
    if (target === null) {
      return;
    }

    activePointerIdRef.current = event.pointerId;
    isDraggingRef.current = true;
    lastXRef.current = event.clientX;
    lastYRef.current = event.clientY;

    // setPointerCapture ensures every subsequent move/up event for
    // this pointer is delivered to our element, even if the pointer
    // wanders outside its bounds.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers throw if capture fails (e.g., synthetic events
      // in tests). Failing here is non-fatal — events will still fire
      // when the pointer is over the element.
    }

    // Notify auto-rotation that interaction began.
    interactionNotifierRef.current?.();
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent): void => {
      if (!isDraggingRef.current) {
        return;
      }
      if (event.pointerId !== activePointerIdRef.current) {
        return;
      }

      // Compute pixel delta since the last move event.
      const dx = event.clientX - lastXRef.current;
      const dy = event.clientY - lastYRef.current;
      lastXRef.current = event.clientX;
      lastYRef.current = event.clientY;

      // Map horizontal motion → yaw (rotation around world Y axis),
      // vertical motion → pitch (rotation around world X axis). Sign
      // matches user intuition: drag right → ball turns right (positive
      // Y rotation in Three's right-handed coordinate system); drag
      // down → ball tips down (positive X rotation).
      const yawRad = dx * sensitivity;
      const pitchRad = dy * sensitivity;

      // Build small-angle quaternions for this frame's yaw and pitch.
      // Reusing fresh Quaternions per event is cheap (each is 4 floats);
      // hoisting them to module scope would cause race conditions
      // between concurrent drag streams.
      const yawQuat = new Quaternion().setFromAxisAngle(AXIS_Y, yawRad);
      const pitchQuat = new Quaternion().setFromAxisAngle(AXIS_X, pitchRad);

      // Compose: apply yaw, then pitch, on top of the existing drag
      // accumulator. Using `premultiply` keeps the rotations expressed
      // in the world frame so dragging right always turns the ball right
      // regardless of its current orientation, satisfying ST-002-AC4
      // ("free rotation about any axis across the full range of motion").
      dragRotationRef.current.premultiply(yawQuat);
      dragRotationRef.current.premultiply(pitchQuat);

      // Notify auto-rotation that interaction is ongoing.
      interactionNotifierRef.current?.();
    },
    [sensitivity],
  );

  const handlePointerUp = useCallback((event: PointerEvent): void => {
    if (event.pointerId !== activePointerIdRef.current) {
      return;
    }

    const target = attachRef.current;
    if (target !== null) {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // Harmless if no capture was active.
      }
    }

    activePointerIdRef.current = null;
    isDraggingRef.current = false;

    // Per ST-002-AC3: do NOT reset `dragRotationRef.current` — the ball
    // stays at the orientation the user dragged to.
  }, []);

  // -----------------------------------------------------------------------
  // Listener installation / teardown
  // -----------------------------------------------------------------------

  useEffect(() => {
    const target = attachRef.current;
    if (target === null) {
      return undefined;
    }

    // `passive: false` is needed on `pointerdown` only (the move/up
    // handlers do not call `preventDefault`). Marking the others as
    // passive is a perf optimization the browser may use to avoid
    // blocking scroll/zoom on touch devices.
    target.addEventListener('pointerdown', handlePointerDown, { passive: false });
    target.addEventListener('pointermove', handlePointerMove, { passive: true });
    target.addEventListener('pointerup', handlePointerUp, { passive: true });
    target.addEventListener('pointercancel', handlePointerUp, { passive: true });
    target.addEventListener('pointerleave', handlePointerUp, { passive: true });

    return () => {
      target.removeEventListener('pointerdown', handlePointerDown);
      target.removeEventListener('pointermove', handlePointerMove);
      target.removeEventListener('pointerup', handlePointerUp);
      target.removeEventListener('pointercancel', handlePointerUp);
      target.removeEventListener('pointerleave', handlePointerUp);
    };
  }, [handlePointerDown, handlePointerMove, handlePointerUp]);

  return {
    attachRef,
    dragRotationRef,
    isDraggingRef,
  };
}
