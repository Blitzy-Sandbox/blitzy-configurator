/**
 * useIdleAutoRotate — idle-driven auto-rotation hook (ST-003).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/useIdleAutoRotate.ts
 *     | Idle timer triggers auto-rotation (ST-003)".
 *   - ST-003 acceptance criteria:
 *       AC1 After the configured idle interval elapses, the ball begins
 *           rotating automatically at the configured rotational velocity.
 *       AC2 Any user interaction immediately pauses auto-rotation.
 *       AC3 When interaction stops, the idle timer restarts and
 *           auto-rotation resumes once the interval elapses again.
 *       AC4 Auto-rotation direction and rotational velocity match the
 *           documented configuration values.
 *   - QA Report Issue #6 — `useIdleAutoRotate.ts` MUST exist; the
 *     scope notes specify a 3000ms idle threshold and a Y-axis spin.
 *
 * Responsibilities:
 *   1. Track an idle timer that starts when interaction stops and fires
 *      after `IDLE_THRESHOLD_MS` (3000 ms) milliseconds.
 *   2. While auto-rotation is active, accumulate rotation around the
 *      world Y axis at `AUTO_ROTATION_VELOCITY_RAD_PER_SEC` (0.4 rad/s)
 *      — equivalent to one full revolution every ~15.7 seconds.
 *   3. Expose `notifyInteraction()` so consumers (and `useDragRotation`)
 *      can interrupt the timer / clear the accumulated rotation when
 *      a new interaction begins.
 *   4. Expose `autoRotationRef` (a `Quaternion`) that consumers compose
 *      into the final mesh quaternion.
 *
 * Composition contract (per QA Report Issue #5 scope notes):
 *
 *     finalQuat = autoRotationRef.current.clone().multiply(dragRotationRef.current)
 *
 * — auto-rotation is the LEFT operand so it's pre-applied (in the world
 * frame) on top of any user drag rotation. The hook itself does NOT
 * touch the drag rotation accumulator; the consumer composes the two.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched. Auto-rotation does not alter the texture.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Rotation around X / Z axes (ST-003 specifies Y-axis spin).
 *   - User-configurable idle threshold or velocity (the AAP documents
 *     them as fixed values; future stories may introduce a setting).
 */

import { useCallback, useEffect, useRef } from 'react';
import { Quaternion, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Documented configuration constants
// ---------------------------------------------------------------------------

/**
 * Idle interval in milliseconds. Per QA Report Issue #6: "After 3000ms
 * idle, ball auto-rotates around vertical axis." This constant is the
 * single source of truth for the idle-threshold across the codebase.
 */
export const IDLE_THRESHOLD_MS = 3000;

/**
 * Auto-rotation angular velocity in radians per second.
 *
 * 0.4 rad/s ≈ 22.9°/s ≈ one full revolution every 15.7 seconds —
 * slow enough to read color choices comfortably, fast enough that a
 * passive viewer perceives motion without waiting.
 */
export const AUTO_ROTATION_VELOCITY_RAD_PER_SEC = 0.4;

// ---------------------------------------------------------------------------
// Module-level reusable axis (no per-frame allocation).
// ---------------------------------------------------------------------------

const AUTO_ROTATION_AXIS = new Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IdleAutoRotateApi {
  /**
   * Quaternion holding the accumulated auto-rotation around the Y axis.
   * Mutated in place inside the hook. Consumers should NOT mutate this
   * ref themselves; instead, compose via:
   *
   *   const finalQuat = autoRotationRef.current.clone().multiply(dragRotationRef.current);
   *   mesh.quaternion.copy(finalQuat);
   */
  readonly autoRotationRef: React.MutableRefObject<Quaternion>;

  /**
   * Read-only ref that callers can poll inside a `useFrame` loop to
   * decide whether to skip per-frame work (e.g., texture re-uploads
   * that don't depend on auto-rotation).
   */
  readonly isAutoRotatingRef: React.MutableRefObject<boolean>;

  /**
   * Call this on every user interaction (drag start, drag move, control
   * click, etc.) to interrupt the idle timer and reset the
   * `IDLE_THRESHOLD_MS` countdown. Stable reference across renders.
   */
  readonly notifyInteraction: () => void;

  /**
   * Advance the auto-rotation accumulator by `deltaTimeSec` seconds.
   * Consumers MUST call this from inside their `useFrame` loop (R3F
   * passes `delta` in seconds as the second argument). The function is
   * a no-op while interaction is active or while the idle timer is
   * still counting down. Stable reference across renders.
   */
  readonly tickAutoRotation: (deltaTimeSec: number) => void;
}

export interface IdleAutoRotateOptions {
  /** Override idle threshold in milliseconds (rare; defaults to 3000). */
  readonly idleThresholdMs?: number;
  /** Override angular velocity in rad/s (rare; defaults to 0.4). */
  readonly velocityRadPerSec?: number;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Idle-driven auto-rotation hook. See module JSDoc for full behavior.
 */
export function useIdleAutoRotate(options: IdleAutoRotateOptions = {}): IdleAutoRotateApi {
  const idleThresholdMs = options.idleThresholdMs ?? IDLE_THRESHOLD_MS;
  const velocityRadPerSec = options.velocityRadPerSec ?? AUTO_ROTATION_VELOCITY_RAD_PER_SEC;

  // Auto-rotation accumulator quaternion (mutated in place per frame).
  const autoRotationRef = useRef<Quaternion>(new Quaternion());

  // Whether auto-rotation is currently active. Toggled by the idle
  // timer callback (true) and by `notifyInteraction` (false).
  const isAutoRotatingRef = useRef<boolean>(false);

  // Handle of the pending setTimeout, or null if no timer is pending.
  // `ReturnType<typeof setTimeout>` is portable across Node + browser
  // (browser returns number, Node returns Timeout).
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Cancel the pending idle timer (if any). */
  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  /**
   * Schedule the idle timer. After `idleThresholdMs` ms with no
   * interruption, sets `isAutoRotatingRef.current = true` so the next
   * `tickAutoRotation()` call begins accumulating rotation.
   */
  const scheduleIdleTimer = useCallback((): void => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      isAutoRotatingRef.current = true;
      idleTimerRef.current = null;
    }, idleThresholdMs);
  }, [clearIdleTimer, idleThresholdMs]);

  // -----------------------------------------------------------------------
  // Public callbacks
  // -----------------------------------------------------------------------

  /**
   * Notify the hook that user interaction occurred. Pauses auto-rotation
   * and restarts the idle countdown per ST-003-AC2 / AC3.
   *
   * Intentionally does NOT reset the `autoRotationRef` accumulator —
   * the user-driven drag rotation is composed on top of the existing
   * auto-rotation, so the ball stays oriented where it was when the
   * user grabbed it.
   */
  const notifyInteraction = useCallback((): void => {
    isAutoRotatingRef.current = false;
    scheduleIdleTimer();
  }, [scheduleIdleTimer]);

  /**
   * Advance the auto-rotation accumulator by `deltaTimeSec` seconds.
   * No-op while interaction is active or the idle timer is pending.
   *
   * `delta` is unbounded by R3F; clamping at 0.1s caps the per-tick
   * rotation in the rare case the tab is backgrounded and re-foregrounded
   * (a single huge tick would otherwise spin the ball multiple
   * revolutions in one frame, which looks jarring).
   */
  const tickAutoRotation = useCallback(
    (deltaTimeSec: number): void => {
      if (!isAutoRotatingRef.current) {
        return;
      }
      const clampedDelta = Math.max(0, Math.min(deltaTimeSec, 0.1));
      const angleRad = clampedDelta * velocityRadPerSec;
      // Build the per-tick rotation as a fresh Quaternion (cheap; 4
      // floats) then pre-multiply into the accumulator (world-frame
      // rotation around Y).
      const tickQuat = new Quaternion().setFromAxisAngle(AUTO_ROTATION_AXIS, angleRad);
      autoRotationRef.current.premultiply(tickQuat);
    },
    [velocityRadPerSec],
  );

  // -----------------------------------------------------------------------
  // Initial timer scheduling and unmount cleanup
  // -----------------------------------------------------------------------

  useEffect(() => {
    // On mount, start the idle countdown so auto-rotation kicks in
    // after IDLE_THRESHOLD_MS even if the user never interacts.
    scheduleIdleTimer();
    return () => {
      clearIdleTimer();
      isAutoRotatingRef.current = false;
    };
  }, [scheduleIdleTimer, clearIdleTimer]);

  return {
    autoRotationRef,
    isAutoRotatingRef,
    notifyInteraction,
    tickAutoRotation,
  };
}
