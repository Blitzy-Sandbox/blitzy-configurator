/**
 * useIdleAutoRotate — idle-driven auto-rotation hook (ST-003).
 *
 * Authority:
 *   - AAP §0.3.4 — "frontend/src/configurator/preview/useIdleAutoRotate.ts
 *     | Idle auto-rotation (ST-003)".
 *   - AAP §0.6.7 Track 2 — "Idle timer triggers auto-rotation (ST-003)".
 *   - ST-003 acceptance criteria (verbatim from
 *     tickets/stories/ST-003-idle-auto-rotate.md):
 *       AC1 After the configured idle interval elapses with no user
 *           input, the ball begins rotating automatically at the
 *           configured rotational velocity.
 *       AC2 Any user interaction (pointer movement over the preview
 *           area, control click, or rotation drag) immediately pauses
 *           the auto-rotation.
 *       AC3 When interaction stops, the idle timer restarts and
 *           auto-rotation resumes once the interval elapses again.
 *       AC4 Auto-rotation direction and rotational velocity match the
 *           documented configuration values.
 *   - ST-005 acceptance criteria (referenced via source_files):
 *       AC2 Under auto-rotation idle playback on the reference hardware
 *           profile, the preview maintains a framerate at or above the
 *           documented floor of 30 FPS.
 *
 * Architecture:
 *   This hook is the WRITE-SIDE of the idle auto-rotation pipeline. It
 *   maintains a single mutable number — the angular velocity in
 *   radians per second around the world Y axis — and exposes it as a
 *   ref so the read-side (`Sphere.tsx`'s `useFrame` loop) can integrate
 *   the velocity into its rotation accumulator every frame:
 *
 *     // In Sphere.tsx (read-side):
 *     const angularVelocity = idleAutoRotateRef.current;
 *     if (angularVelocity !== 0) {
 *       autoRotationDelta.setFromAxisAngle(yAxis, angularVelocity * delta);
 *       autoRotationAccum.multiply(autoRotationDelta);
 *     }
 *
 *   Activity detection lives entirely inside this hook — listeners on
 *   the container element AND on `window` cover every category of
 *   user interaction enumerated in ST-003-AC2 (pointer movement over
 *   the preview, control click, drag).
 *
 * Velocity contract (ST-003-AC4):
 *   The velocity is binary: either 0 (not auto-rotating) or the
 *   documented module-scoped constant
 *   `AUTO_ROTATION_ANGULAR_VELOCITY_RAD_PER_SEC`. No other values
 *   are ever written. This makes the read-side trivially correct —
 *   the integration check `if (angularVelocity !== 0)` is a single
 *   comparison.
 *
 * Accessibility — `prefers-reduced-motion` (WCAG 2.3.3 "Animation
 * from Interactions"):
 *   When the user's operating system or browser advertises
 *   `prefers-reduced-motion: reduce` (e.g. macOS "Reduce motion",
 *   Windows "Show animations off", or a browser-level override),
 *   this hook MUST NOT engage auto-rotation — vestibular triggers
 *   are an accessibility hazard for users with motion-sensitivity
 *   disorders. The preference is observed via
 *   `window.matchMedia('(prefers-reduced-motion: reduce)')`. The
 *   query is also subscribed to so that flipping the OS-level
 *   preference at runtime (e.g. macOS toggling "Reduce motion"
 *   mid-session) immediately suppresses any active rotation and
 *   prevents future rotations until the preference is cleared.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched. This hook does NOT touch the texture
 *     pipeline. Verified by the absence of any `needsUpdate` reference
 *     and the absence of any `three` / texture imports.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Out of scope:
 *   - Three.js quaternion construction — that is the read-side's
 *     responsibility (`Sphere.tsx`'s `useFrame`).
 *   - Rotation around X / Z axes — ST-003 specifies a Y-axis spin only
 *     (configurator turntable convention).
 *   - User-configurable idle threshold or velocity — the AAP documents
 *     them as fixed values.
 *   - Resume-from-paused-orientation logic — handled by the read-side's
 *     accumulator, which preserves its value across pause/resume cycles
 *     because integration is gated on `angularVelocity !== 0` (when
 *     paused, the accumulator is read but not written).
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// ---------------------------------------------------------------------------
// Documented configuration constants (ST-003-AC4 "the documented
// configuration values"). Module-scoped so they are NOT recreated on
// every hook invocation and so external test harnesses can compare
// observed velocities against the documented constant by importing it
// (the constant is intentionally not exported as part of the schema —
// callers that need to compare should observe the ref directly, which
// already reflects the binary 0-or-velocity contract).
// ---------------------------------------------------------------------------

/**
 * Idle interval in milliseconds — the period of inactivity required
 * before auto-rotation engages. 3000 ms (3 seconds) is the
 * industry-standard "attract mode" threshold:
 *   - Long enough that users reading the sidebar do not accidentally
 *     trigger auto-rotation while skimming the controls.
 *   - Short enough that the UI feels alive when left idle on a
 *     marketing surface.
 *
 * Per ST-003-AC1 "the configured idle interval".
 */
const IDLE_THRESHOLD_MS = 3000;

/**
 * Auto-rotation angular velocity in radians per second around the
 * world Y axis. 0.3 rad/s ≈ 17.2°/s ≈ one full revolution every
 * ~21 seconds:
 *   - Slow enough to let the user inspect different sides of the ball
 *     comfortably (high-speed spins are jarring and obscure detail).
 *   - Fast enough that a passive viewer perceives motion within a
 *     few seconds without having to wait for a noticeable change.
 *
 * Per ST-003-AC4 "the documented configuration".
 *
 * Sign convention: positive values rotate the ball "to the right" in
 * the standard right-handed Three.js coordinate system (positive Y is
 * up; positive rotation around +Y is counter-clockwise when viewed
 * from above). The read-side composes this around the world Y axis
 * via `quaternion.setFromAxisAngle(new Vector3(0, 1, 0), velocity * delta)`.
 */
const AUTO_ROTATION_ANGULAR_VELOCITY_RAD_PER_SEC = 0.3;

/**
 * `prefers-reduced-motion` media query string. Centralized as a
 * module-scoped constant so the listener-add and listener-remove
 * paths stay in lock-step (any drift in the query string would
 * silently break listener removal on cleanup).
 */
const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Read the current `prefers-reduced-motion` user preference. Returns
 * `false` outside browser environments (e.g. Jest with `node`
 * environment) so unit tests do not need to stub `matchMedia`.
 *
 * Defensive against environments where `window.matchMedia` is
 * undefined (SSR, older Node test environments) — falls back to
 * `false` which is the "no reduced-motion preference expressed"
 * baseline.
 */
function isReducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Read-only view of the current idle-auto-rotation angular velocity.
 *
 * Per ST-003-AC4, the value held in `current` is binary by contract:
 *   - 0          — not auto-rotating (idle timer pending OR user is
 *                  interacting with the configurator).
 *   - >0         — auto-rotating at the documented angular velocity
 *                  (in radians per second, around the world Y axis).
 *
 * No intermediate or transient values occur. The hook never ramps the
 * velocity — it switches from 0 to the documented constant atomically
 * when the idle timer elapses, and back to 0 atomically on the next
 * activity event.
 *
 * Consumers (`Sphere.tsx`) READ this value every frame inside their
 * `useFrame` callback and integrate it into a rotation accumulator
 * quaternion (delta time × angularVelocity = per-frame rotation
 * angle around the Y axis). The accumulator itself lives on the
 * read-side, NOT on this hook.
 *
 * Type design note:
 *   The interface intentionally exposes `current` as `readonly` so the
 *   read-side (Sphere.tsx) cannot accidentally mutate the velocity
 *   from inside its frame loop. Internally, the hook holds a
 *   `MutableRefObject<number>` from React's `useRef` — its `current`
 *   field IS mutable at runtime, but `MutableRefObject<number>` is
 *   structurally compatible with the `{ readonly current: number }`
 *   shape (a more-permissive write side widens to a more-restrictive
 *   read side; the interface promises only readability).
 */
export interface IdleAutoRotateRef {
  readonly current: number;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Attach idle-detection listeners to the given container element AND
 * to `window`, and return a ref whose `.current` is the current
 * auto-rotation angular velocity (in rad/s around the world Y axis).
 *
 * Lifecycle contract:
 *   - On mount: sets `velocityRef.current = 0` and starts the idle
 *     timer. After IDLE_THRESHOLD_MS ms with no activity, the timer
 *     fires and sets `velocityRef.current` to the documented constant.
 *   - On any user activity (pointer events on container, keydown
 *     anywhere, touchstart, wheel, pointerdown anywhere): sets
 *     `velocityRef.current = 0` synchronously and reschedules the
 *     idle timer.
 *   - On unmount: clears the timer, removes all listeners, and resets
 *     the velocity ref to 0.
 *
 * Activity coverage (ST-003-AC2 "Any user interaction"):
 *   - `pointerdown` on the container — direct clicks on the preview.
 *   - `pointermove` on the container — hovering over the preview.
 *   - `pointerup`   on the container — drag releases on the preview.
 *   - `wheel`       on the container — scroll over the preview (e.g.
 *                                       future zoom support).
 *   - `touchstart`  on the container — touch begins on the preview.
 *   - `pointerdown` on `window`      — control click anywhere in the
 *                                       configurator (sidebar, header).
 *   - `keydown`     on `window`      — keyboard interaction (Tab, Esc,
 *                                       typing in color/text fields).
 *
 * The dual coverage (container + window for pointerdown; window-only
 * for keydown) ensures the idle timer resets on EVERY kind of
 * configurator interaction, satisfying ST-003-AC2 verbatim.
 *
 * Pause behavior (ST-003-AC2 "immediately"):
 *   The pause happens SYNCHRONOUSLY in the event handler — no
 *   `setTimeout(0)`, no `requestAnimationFrame`, no microtask
 *   indirection. The ref is updated in the same call stack as the
 *   originating pointer/keyboard event. The only remaining latency is
 *   the rendering tick (≤16 ms at 60 FPS), well within the
 *   "immediate" perceptual threshold (~100 ms).
 *
 * Resume behavior (ST-003-AC3 "the idle timer restarts"):
 *   `scheduleIdleTimer` is called from `onActivity`, which fires on
 *   every activity event. When the user stops interacting, the LAST
 *   `onActivity` call schedules a fresh timer that elapses
 *   IDLE_THRESHOLD_MS later, re-engaging auto-rotation.
 *
 * StrictMode safety:
 *   React 18 StrictMode double-invokes effects. The cleanup phase
 *   between the two invocations clears the timer, removes the seven
 *   listener pairs, and resets the velocity to 0 — so the second
 *   invocation starts from a clean baseline. The symmetric
 *   add/remove pairs guarantee no listener accumulation across the
 *   double-mount.
 *
 * Performance:
 *   `pointermove` is a high-frequency event (~60 Hz during active
 *   movement). Each `onActivity` call clears and reschedules a
 *   timer, both of which are O(1) and run in well under a
 *   microsecond. Total CPU cost is negligible (<<0.01% of a single
 *   core), so no throttling is required.
 *
 * @param containerRef Ref to the configurator container element
 *                     (typically the wrapping `<div>` around R3F's
 *                     `<Canvas>`). MUST be a stable ref — React
 *                     `useRef` results meet this requirement
 *                     automatically.
 * @returns IdleAutoRotateRef — a ref whose `.current` is the current
 *                              angular velocity in rad/s (binary:
 *                              0 or the documented constant).
 */
export function useIdleAutoRotate(
  containerRef: RefObject<HTMLElement | null>,
): IdleAutoRotateRef {
  // Angular velocity ref. The contract is binary:
  //   - 0   when not auto-rotating (idle timer pending or activity).
  //   - AUTO_ROTATION_ANGULAR_VELOCITY_RAD_PER_SEC when auto-rotating.
  // No other values are ever written.
  const velocityRef = useRef<number>(0);

  useEffect(() => {
    const element = containerRef.current;
    // Defensive: if the container ref hasn't attached to a DOM node
    // yet (could happen in edge-case render orderings), skip the
    // effect entirely. The hook will re-run when the ref changes
    // because containerRef is in the dependency array.
    if (element === null) {
      return undefined;
    }

    // Idle timer handle. Closure-scoped (not a useRef) because the
    // handle is implementation detail with no consumer outside this
    // effect — and because re-creating it on each effect run is the
    // correct behavior for StrictMode's mount/unmount/remount cycle.
    // `ReturnType<typeof setTimeout>` is portable across browser
    // (returns `number`) and Node typings (returns `Timeout`); we
    // accept either via the type alias.
    let idleTimerHandle: ReturnType<typeof setTimeout> | null = null;

    /**
     * Schedule (or re-schedule) the idle timer. Clears any pending
     * timer first so that `scheduleIdleTimer()` followed by another
     * `scheduleIdleTimer()` produces exactly ONE pending callback,
     * not two. This invariant is critical for ST-003-AC3 (timer
     * restarts on each activity event).
     *
     * `prefers-reduced-motion` short-circuit (WCAG 2.3.3): if the
     * user has expressed a motion-reduction preference, we ALWAYS
     * clear any pending timer AND skip scheduling a new one. The
     * velocity ref is left at 0 so the read-side never observes a
     * non-zero auto-rotation velocity. Re-scheduling resumes
     * automatically when the preference is cleared (handled by
     * `onReducedMotionChange` below).
     */
    const scheduleIdleTimer = (): void => {
      if (idleTimerHandle !== null) {
        clearTimeout(idleTimerHandle);
        idleTimerHandle = null;
      }
      if (isReducedMotionPreferred()) {
        // Reduced motion preferred — never engage auto-rotation.
        // The activity-handler path still runs and pauses any in-
        // flight rotation, but no new timer is scheduled.
        return;
      }
      idleTimerHandle = setTimeout(() => {
        // Idle threshold reached — engage auto-rotation by setting
        // the velocity to the documented constant (ST-003-AC1, AC4).
        // This is the ONLY place the velocity becomes non-zero.
        // Defensive re-check: if the user toggled reduced-motion
        // during the 3-second wait, the change handler will have
        // already cleared this timer, but we add a second guard
        // here in case the timer fires in the same tick the
        // change handler runs.
        if (isReducedMotionPreferred()) {
          velocityRef.current = 0;
          idleTimerHandle = null;
          return;
        }
        velocityRef.current = AUTO_ROTATION_ANGULAR_VELOCITY_RAD_PER_SEC;
        idleTimerHandle = null;
      }, IDLE_THRESHOLD_MS);
    };

    /**
     * Activity handler. Fires on every user interaction and:
     *   1. Pauses auto-rotation by setting velocity to 0
     *      synchronously (ST-003-AC2 "immediately").
     *   2. Reschedules the idle timer so auto-rotation can resume
     *      after the interval elapses again (ST-003-AC3).
     *
     * Step ordering matters: we set velocity to 0 BEFORE scheduling
     * the next timer so a hypothetical 0 ms timer (we use 3000 ms,
     * but defensively) would still observe the cleared velocity.
     */
    const onActivity = (): void => {
      velocityRef.current = 0;
      scheduleIdleTimer();
    };

    // -------------------------------------------------------------------
    // Pointer / wheel / touch events on the container.
    //
    // These cover ST-003-AC2's "pointer movement over the preview area,
    // control click, drag" within the preview's own DOM subtree.
    //
    // `wheel` and `touchstart` use `{ passive: true }` to opt out of
    // the browser's default-prevention contract — our handler never
    // calls preventDefault(), and the passive flag enables smooth
    // scroll optimizations on mobile and avoids the Chromium
    // non-passive-listener warning.
    //
    // `pointermove` is intentionally NOT passive: pointermove is not
    // a scroll-blocking event so the passive optimization does not
    // apply, and some touch input pipelines benefit from non-passive
    // pointer handling.
    // -------------------------------------------------------------------
    element.addEventListener('pointerdown', onActivity);
    element.addEventListener('pointermove', onActivity);
    element.addEventListener('pointerup', onActivity);
    element.addEventListener('wheel', onActivity, { passive: true });
    element.addEventListener('touchstart', onActivity, { passive: true });

    // -------------------------------------------------------------------
    // Global keyboard / pointer events on `window`.
    //
    // Keyboard events on window catch typing into sidebar fields,
    // Tab/Shift+Tab navigation, Escape, etc. — none of which fire
    // on the container's DOM subtree.
    //
    // Pointerdown on window catches control clicks anywhere in the
    // configurator (sidebar buttons, dropdowns, etc.) per ST-003-AC2
    // "control click". Container-attached pointerdown ALSO fires for
    // clicks on the preview itself (DOM event bubbling), but the
    // container handler returning would not fire when the click
    // happens outside the container — hence the dual subscription.
    // -------------------------------------------------------------------
    window.addEventListener('keydown', onActivity);
    window.addEventListener('pointerdown', onActivity);

    // -------------------------------------------------------------------
    // `prefers-reduced-motion` media-query subscription.
    //
    // The OS-level / browser-level preference can change at runtime
    // (macOS lets the user toggle "Reduce motion" without restarting
    // applications; Chromium DevTools exposes the setting via the
    // Rendering panel). Subscribing to the media query keeps the
    // hook's behavior in sync with the live preference:
    //   - If the user enables reduced motion mid-rotation, we
    //     clear the in-flight rotation immediately by setting the
    //     velocity to 0 and clearing any pending idle timer.
    //   - If the user disables reduced motion, we re-schedule the
    //     idle timer so auto-rotation resumes after the documented
    //     idle interval (consistent with the activity-driven
    //     resume path).
    //
    // `addEventListener('change', ...)` is the modern, well-supported
    // API on `MediaQueryList`. Older Safari versions (< 14) use the
    // legacy `addListener` API; we accept the slim compatibility
    // window because the project targets evergreen browsers (per
    // Vite build target `es2022`).
    // -------------------------------------------------------------------
    const reducedMotionMql =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(PREFERS_REDUCED_MOTION_QUERY)
        : null;
    const onReducedMotionChange = (): void => {
      if (isReducedMotionPreferred()) {
        // User just enabled reduced motion — pause immediately.
        if (idleTimerHandle !== null) {
          clearTimeout(idleTimerHandle);
          idleTimerHandle = null;
        }
        velocityRef.current = 0;
      } else {
        // User just disabled reduced motion — resume the
        // idle-timer cycle so auto-rotation re-engages after the
        // documented idle interval (matches the resume-after-
        // activity contract in ST-003-AC3).
        scheduleIdleTimer();
      }
    };
    if (reducedMotionMql !== null) {
      reducedMotionMql.addEventListener('change', onReducedMotionChange);
    }

    // Bootstrap: set velocity to 0 (defensive — ref already starts at
    // 0, but a re-mount could carry a stale value if the ref were
    // shared across mounts) and schedule the first idle timer.
    // `scheduleIdleTimer` itself short-circuits when reduced-motion
    // is preferred, so the bootstrap path is correct in both
    // preference states.
    velocityRef.current = 0;
    scheduleIdleTimer();

    return (): void => {
      // Clear the pending timer so its callback never fires after
      // unmount. Without this, an orphaned setTimeout would set the
      // velocity ref AFTER the component is gone, violating the
      // hook's lifecycle contract.
      if (idleTimerHandle !== null) {
        clearTimeout(idleTimerHandle);
        idleTimerHandle = null;
      }

      // Remove all listeners symmetrically. Each removeEventListener
      // call must match its addEventListener call exactly (same
      // type + same handler reference); the options argument does
      // NOT need to match for removeEventListener — only `capture`
      // is significant, and we don't use capture.
      element.removeEventListener('pointerdown', onActivity);
      element.removeEventListener('pointermove', onActivity);
      element.removeEventListener('pointerup', onActivity);
      element.removeEventListener('wheel', onActivity);
      element.removeEventListener('touchstart', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('pointerdown', onActivity);

      // Symmetric cleanup of the media-query subscription. The
      // remove call must reference the same handler instance that
      // was added — both reference the closure-scoped
      // `onReducedMotionChange` so the pair is exact.
      if (reducedMotionMql !== null) {
        reducedMotionMql.removeEventListener('change', onReducedMotionChange);
      }

      // Reset velocity on unmount so a re-mount (e.g. StrictMode
      // mount/unmount/remount or HMR refresh) starts from the
      // "not auto-rotating" baseline. The ref persists across the
      // StrictMode double-pass (refs are not re-created), so
      // resetting in cleanup keeps the bootstrap path
      // deterministic.
      velocityRef.current = 0;
    };
  }, [containerRef]);

  // Return the velocity ref. `MutableRefObject<number>` is
  // structurally compatible with `IdleAutoRotateRef` (which has only
  // a `readonly current: number`) — TypeScript's structural typing
  // recognizes that a writable property satisfies a readonly
  // requirement (the readonly side simply won't allow writes from
  // its own viewpoint).
  return velocityRef;
}
