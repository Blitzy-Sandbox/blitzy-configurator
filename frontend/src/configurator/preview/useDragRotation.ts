/**
 * useDragRotation — pointer-driven 3D ball rotation hook (ST-002).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/useDragRotation.ts
 *     | Click-and-drag rotation; no snap-back; free rotation around all
 *     axes (ST-002)".
 *   - ST-002 acceptance criteria (verbatim, see
 *     `tickets/stories/ST-002-click-drag-rotation.md`):
 *       AC1 Pressing and dragging the primary pointer inside the
 *           preview area rotates the ball in the direction of the drag.
 *       AC2 Rotation continues to follow the pointer for the duration
 *           of the drag with no perceptible input lag.
 *       AC3 Releasing the pointer leaves the ball at its final rotated
 *           orientation without snapping back to a prior position.
 *       AC4 The ball can be rotated freely about any axis across the
 *           full range of motion, with no unreachable viewing angles.
 *   - ST-005-AC1 — "30 FPS sustained during drag rotation": this hook
 *     stores the cumulative rotation in a `useRef`, never React state,
 *     so the 60+ Hz pointer-event stream does NOT trigger React
 *     re-renders that would compete with the rAF render loop.
 *
 * Responsibilities:
 *   1. Attach `pointerdown`, `pointermove`, `pointerup`, and
 *      `pointercancel` listeners to the DOM element pointed at by
 *      `containerRef.current`.
 *   2. Translate per-event pointer pixel deltas (dx, dy) into an
 *      incremental "arcball-style" quaternion whose rotation axis lies
 *      perpendicular to the drag direction in the screen plane —
 *      satisfying ST-002-AC4 because a perpendicular axis can be ANY
 *      axis in 3D space (depending on which way the user drags).
 *   3. Left-multiply (`premultiply`) each incremental rotation onto a
 *      cumulative `Quaternion` ref so subsequent rotations are
 *      expressed in the camera's frame — drag-right always rotates the
 *      ball right from the user's perspective, regardless of the ball's
 *      current orientation.
 *   4. NEVER reset the cumulative quaternion on pointer up / cancel
 *      (ST-002-AC3 — no snap-back).
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6 (texture update order): UNTOUCHED — this hook does
 *     not import, read, or mutate any Three.js texture or its
 *     `needsUpdate` flag. Rotation composition lives entirely in the
 *     mesh's quaternion at the consumer's `useFrame` callsite.
 *   - Rule R2 (no credential material in logs): ZERO `console.*`
 *     calls in this file.
 *   - Rule R3 (Firebase Admin only): no auth imports — N/A on the
 *     frontend.
 *   - Rule R9 (no payment processing): no payment imports.
 *
 * Out of scope:
 *   - Touch-pinch zoom, multi-touch gestures (ST-002 specifies a
 *     "primary pointer" only — secondary pointers are intentionally
 *     ignored via `event.button` and `pointerId` tracking).
 *   - Inertial / momentum continuation on release (ST-002-AC3
 *     mandates the ball stay at its final orientation, NOT continue
 *     spinning).
 *   - Idle auto-rotation (owned by `useIdleAutoRotate.ts`).
 *   - Camera framing or lens controls (owned by `BallCanvas.tsx`).
 *   - Rendering / mesh updates (owned by `Sphere.tsx`'s `useFrame`).
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Quaternion, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Read-only view of the cumulative drag-rotation quaternion. The
 * `.current` field is the rotation that the user's drag gestures have
 * accumulated since the hook was first mounted.
 *
 * Per ST-002-AC3, this quaternion is NEVER reset to identity on
 * pointer release — only mutated during active drags. The ball stays
 * exactly where the user left it.
 *
 * Consumers (e.g., `Sphere.tsx`) READ this quaternion inside their
 * `useFrame` callback and apply it to their mesh's rotation. The ref
 * object identity is stable across renders, so it can safely be
 * passed as a prop or stored in a sibling component's state without
 * causing churn.
 *
 * The interface is intentionally minimal — exposing only `.current`
 * preserves the option of future internal refactoring (e.g., adding
 * private bookkeeping fields) without breaking the public contract.
 */
export interface DragRotationRef {
  /**
   * The cumulative rotation quaternion. Mutated in place by this hook
   * while a drag is in progress. Consumers MUST NOT mutate this
   * quaternion — treat it as read-only at the call site even though
   * Three.js's `Quaternion` type does not enforce immutability at the
   * type level.
   *
   * To compose with other rotations (e.g., auto-rotate accumulator),
   * `.clone()` first so the cumulative drag rotation is not corrupted
   * by intermediate operations.
   */
  readonly current: Quaternion;
}

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/**
 * Rotation sensitivity in radians per pixel of pointer movement.
 *
 * 0.005 rad/px ≈ 0.286°/px. A 300-pixel horizontal drag produces
 * ~86° of rotation, which feels natural across desktop and tablet
 * inputs without requiring exaggerated motion. A horizontal drag
 * across a 1280-pixel viewport produces ~6.4 radians ≈ 366° — roughly
 * one full revolution per viewport-width drag, which matches the
 * "turntable" mental model used in popular 3D model viewers
 * (Sketchfab, Spline, Verge3D).
 *
 * Module-scoped so it is stable across renders and not reallocated
 * per hook call. Adjust here if UX review reveals over- or under-
 * sensitivity on the reference hardware profile.
 */
const DRAG_SENSITIVITY_RAD_PER_PX = 0.005;

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Attach pointer-drag rotation listeners to the given container
 * element and return a ref to the cumulative rotation quaternion.
 *
 * Behavior contract:
 *   - `pointerdown` on the container starts a drag for the primary
 *     pointer (`event.button === 0`). Secondary mouse buttons,
 *     non-primary touches, and stylus secondary buttons are ignored.
 *   - The pointer is captured (`element.setPointerCapture`) so
 *     subsequent move events are delivered even if the pointer leaves
 *     the container's bounding box. Without capture, fast drags that
 *     overshoot the canvas would silently desync.
 *   - `pointermove` while dragging computes a per-event quaternion
 *     using the arcball-style algorithm (see Phase 5 of the
 *     accompanying agent prompt for the full mathematical derivation)
 *     and left-multiplies it onto the cumulative quaternion.
 *   - `pointerup` and `pointercancel` end the drag. The cumulative
 *     quaternion is NOT reset (ST-002-AC3).
 *   - Listeners are added on mount and removed on unmount — including
 *     the symmetric pair invoked by React StrictMode's intentional
 *     double-mount in development. The hook is StrictMode-safe by
 *     construction because the listener attach/detach is symmetric
 *     within a single `useEffect` body and the cumulative quaternion
 *     lives on a `useRef` that persists across the StrictMode
 *     mount → unmount → mount cycle.
 *
 * Algorithm (per pointer move event):
 *
 *   1. Compute pixel delta: `dx = event.clientX - lastX`,
 *      `dy = event.clientY - lastY`.
 *   2. Compute rotation magnitude:
 *      `angle = sqrt(dx² + dy²) * DRAG_SENSITIVITY_RAD_PER_PX`.
 *   3. Choose rotation axis perpendicular to the drag direction in
 *      the screen plane: `axis = (dy, dx, 0).normalize()`. (This is
 *      the cross product of the drag vector `(dx, -dy, 0)` with the
 *      camera-forward vector `(0, 0, -1)`, simplified.) Because the
 *      axis varies with drag direction, ANY 3D axis can be reached
 *      by some sequence of drags — satisfying ST-002-AC4 (free
 *      rotation, no unreachable orientations).
 *   4. Build the incremental quaternion:
 *      `delta = Quaternion.setFromAxisAngle(axis, angle)`.
 *   5. Left-multiply (`premultiply`) onto the cumulative quaternion:
 *      `cumulative = delta * cumulative`. Left-multiply applies the
 *      new rotation in the camera's coordinate frame — the user
 *      perceives "drag right → ball rotates right from MY
 *      perspective", regardless of the ball's current orientation.
 *      Right-multiply (`multiply`) would apply the rotation in the
 *      ball's body frame, which feels disorienting after compound
 *      rotations.
 *
 * @param containerRef Ref to the container DOM element (typically
 *                     the wrapping `<div>` around the R3F `<Canvas>`)
 *                     that should receive pointer events. The hook
 *                     attaches listeners to `containerRef.current`
 *                     during the effect's first run; if `.current`
 *                     is `null` at that time (e.g., the parent has
 *                     not yet mounted), the effect is a no-op and
 *                     will be re-run only if the ref's identity
 *                     changes (which it should not, by React
 *                     convention).
 * @returns A `DragRotationRef` whose `.current` is the cumulative
 *          rotation quaternion. The ref object identity is stable
 *          across renders.
 */
export function useDragRotation(
  containerRef: RefObject<HTMLElement | null>,
): DragRotationRef {
  // Cumulative rotation quaternion. Initialized to identity (no
  // rotation). Stored on a `useRef` so the 60+ Hz pointermove event
  // stream mutates it in place without forcing React re-renders —
  // critical for the ST-005-AC1 30 FPS budget under sustained drag.
  const quaternionRef = useRef<Quaternion>(new Quaternion());

  useEffect(() => {
    // Capture the container element at effect-run time. Storing it in
    // a local `const` (rather than re-reading `containerRef.current`
    // inside each handler) ensures the cleanup function dereferences
    // EXACTLY the same element that received the listeners — even if
    // a future render assigns a different element to `containerRef`.
    const element = containerRef.current;
    if (element === null) {
      // Container not yet mounted. No listeners to attach. The effect
      // will not re-run automatically if `containerRef.current`
      // becomes non-null later (refs do not trigger re-renders by
      // design); however, by React's mounting order, the parent
      // component sets the ref before this hook's effect runs, so in
      // practice this branch only fires during the first render of a
      // component that conditionally renders the container — at which
      // point the container is genuinely absent.
      return undefined;
    }

    // ---------------------------------------------------------------------
    // Per-drag closure state. Reset on each effect run, which is
    // correct behavior for StrictMode's double-mount (a re-mounted
    // hook starts in the "not dragging" state).
    // ---------------------------------------------------------------------

    /** Whether a primary-pointer drag is currently in progress. */
    let isDragging = false;

    /** The `pointerId` of the active drag, used to ignore secondary
     *  pointers from multi-touch devices. `null` when not dragging. */
    let activePointerId: number | null = null;

    /** Last observed clientX coordinate (for delta computation). */
    let lastX = 0;

    /** Last observed clientY coordinate (for delta computation). */
    let lastY = 0;

    // ---------------------------------------------------------------------
    // Reusable working objects. Allocated once per effect run rather
    // than once per pointermove event so the 60+ Hz event stream does
    // not churn the garbage collector. Both objects are mutated in
    // place inside `onPointerMove` and have no observable state
    // between events.
    // ---------------------------------------------------------------------

    /** Working axis vector — repopulated each pointermove. */
    const axis = new Vector3();

    /** Working delta quaternion — repopulated each pointermove. */
    const delta = new Quaternion();

    // ---------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------

    const onPointerDown = (event: PointerEvent): void => {
      // Only the primary pointer button (left-click for mouse;
      // primary contact for touch / pen) initiates a drag. Right-click
      // (button 2) and middle-click (button 1) intentionally do
      // nothing — leaving them free for browser context menus and
      // future use cases.
      if (event.button !== 0) {
        return;
      }

      isDragging = true;
      activePointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;

      // Capture the pointer so subsequent `pointermove` and
      // `pointerup` events for THIS pointer flow to OUR element even
      // when the cursor leaves the container's bounding box. Without
      // capture, fast drags that overshoot the canvas would lose
      // events and the rotation would stutter.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // `setPointerCapture` can throw `InvalidPointerId` if the
        // element has been detached, or `InvalidStateError` in some
        // synthetic-event harnesses. The drag still works via
        // bubbled events when capture is unavailable; swallowing the
        // exception is the correct fail-safe behavior here. (No
        // `console.*` logging — Rule R2.)
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      // Ignore moves not associated with the active drag. This guard
      // covers two cases:
      //   1. We are not currently dragging (`isDragging === false`).
      //   2. Another pointer (e.g., a second touch) is moving while
      //      our active pointer is also down — we want to ignore the
      //      secondary pointer entirely.
      if (!isDragging || event.pointerId !== activePointerId) {
        return;
      }

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;

      // Compute the rotation magnitude from total pointer
      // displacement. Using `Math.sqrt` rather than `Math.hypot`
      // because Math.hypot has a documented overflow-safety overhead
      // that is wasted on small pixel deltas; for `dx, dy ∈ [0, ~50]`
      // there is no risk of overflow.
      const displacement = Math.sqrt(dx * dx + dy * dy);
      if (displacement === 0) {
        // Some trackpads and stylus drivers fire `pointermove` with
        // zero movement (e.g., pressure changes). Normalizing a zero
        // vector produces NaN, which would corrupt the cumulative
        // quaternion. Bail out before any math runs.
        return;
      }
      const angle = displacement * DRAG_SENSITIVITY_RAD_PER_PX;

      // Rotation axis perpendicular to the drag direction in the
      // screen plane. The unnormalized vector `(dy, dx, 0)` is
      // perpendicular to the screen-space drag vector `(dx, -dy, 0)`
      // (verify: their dot product is `dx*dy + dx*(-dy) = 0`).
      // Normalize before passing to `setFromAxisAngle` because the
      // quaternion math assumes a unit-length axis; otherwise the
      // resulting rotation would scale by the axis's magnitude.
      axis.set(dy, dx, 0).normalize();

      // Build the incremental rotation for this pointer move.
      delta.setFromAxisAngle(axis, angle);

      // Left-multiply (`premultiply`) onto the cumulative quaternion.
      // Mathematically: `quaternionRef.current = delta * quaternionRef.current`.
      // This applies the new rotation in the CAMERA'S frame — the
      // user perceives consistent "drag right → ball rotates right
      // from my perspective" behavior even after many compound
      // rotations. Right-multiply (`multiply`) would apply in the
      // ball's body frame, producing disorienting wobble.
      quaternionRef.current.premultiply(delta);
    };

    const onPointerUp = (event: PointerEvent): void => {
      // Only end the drag if this is the same pointer that started
      // it. A `pointerup` from a second touch on a multi-touch device
      // must not terminate the primary drag.
      if (event.pointerId !== activePointerId) {
        return;
      }

      isDragging = false;
      activePointerId = null;

      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        // `releasePointerCapture` can throw `InvalidPointerId` if
        // capture was never set (e.g., the `setPointerCapture` call
        // in `onPointerDown` threw). Safe to ignore — we have
        // already cleared our local drag state.
      }

      // ST-002-AC3: do NOT mutate `quaternionRef.current` here. The
      // ball remains at the orientation the user dragged to. Snap-
      // back behavior is explicitly forbidden by the acceptance
      // criterion.
    };

    const onPointerCancel = (event: PointerEvent): void => {
      // `pointercancel` fires when the OS or browser interrupts the
      // pointer (e.g., a notification banner steals focus, the user
      // engages a system gesture). Treat it identically to
      // `pointerup`: end the drag, keep the rotation. The user's
      // expected mental model is "if I lifted my finger, I keep what
      // I rotated to" — and an OS-level cancel is functionally
      // equivalent to a finger-lift from the application's
      // perspective.
      onPointerUp(event);
    };

    // ---------------------------------------------------------------------
    // Listener attachment
    // ---------------------------------------------------------------------

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerCancel);

    // ---------------------------------------------------------------------
    // Cleanup — symmetric removal of all four listeners. React's
    // StrictMode invokes this cleanup between the development-only
    // double mount, ensuring no listener accumulates on the DOM
    // element across the mount/unmount/remount cycle.
    // ---------------------------------------------------------------------
    return (): void => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [containerRef]);

  return quaternionRef;
}
