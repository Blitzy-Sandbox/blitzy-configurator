/**
 * Test bridge — dev-only escape hatch for Playwright integration tests.
 *
 * Authority:
 *   - QA Report Issue #5 (drag rotation), Issue #6 (idle auto-rotation),
 *     Issue #3 (resize re-centering) — every behavioral verification at
 *     runtime needs to be observable WITHOUT depending on slow visual
 *     pixel proxies. Headless Chromium under software WebGL (SwiftShader)
 *     produces 100–300 ms frames; combined with R3F `frameloop="always"`
 *     and 1280×720 `canvas.toDataURL()` calls (~200–500 ms each), the
 *     CDP-driven `page.mouse.*` pipeline saturates the main thread and
 *     exceeds the per-test timeout budget. Direct quaternion-state reads
 *     and synthetic DOM event dispatch are O(1) and bypass that cost.
 *   - AAP §0.6.7 Track 2 — the configurator preview tests are first-class
 *     gating artifacts. The bridge is the minimal additional surface
 *     necessary for those tests to pass without degrading production code.
 *   - AAP §0.6.7 R7/C6 — the bridge does NOT touch the texture pipeline.
 *
 * Production safety:
 *   - The sole consumer (`BallCanvas.tsx`'s `useEffect`) gates the
 *     `installTestBridge(...)` call behind `import.meta.env.DEV`. Vite's
 *     production build replaces `import.meta.env.DEV` with `false` and
 *     dead-code-eliminates the entire bridge install (and therefore this
 *     module's runtime side effects).
 *   - The bridge attaches a single property to `window` —
 *     `__strikeforge_test__` — under the `__name__` (double-underscore
 *     prefix and suffix) convention that signals "library-internal,
 *     not part of the application's public API". The cleanup function
 *     deletes the property on unmount, so React StrictMode's
 *     mount/unmount/remount cycle never leaves a stale reference.
 *   - The bridge exposes ONLY read-only state getters and a synthetic
 *     pointer event dispatcher. It does not expose any mutator that
 *     could corrupt application state from the test side.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched. The bridge does not import or mutate
 *     the texture pipeline. Verified by `grep -n "needsUpdate"
 *     frontend/src/configurator/preview/testBridge.ts` returning zero
 *     matches.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *
 * Usage from a Playwright test:
 *
 *   await page.waitForFunction(
 *     () => typeof window.__strikeforge_test__ !== 'undefined',
 *   );
 *   const before = await page.evaluate(
 *     () => window.__strikeforge_test__!.getDragRotation(),
 *   );
 *   await page.evaluate(({ cx, cy }) => {
 *     const api = window.__strikeforge_test__!;
 *     api.dispatchPointerEvent({ type: 'pointerdown', clientX: cx, clientY: cy });
 *     for (let i = 1; i <= 12; i++) {
 *       api.dispatchPointerEvent({
 *         type: 'pointermove',
 *         clientX: cx + i * 25,
 *         clientY: cy,
 *       });
 *     }
 *     api.dispatchPointerEvent({ type: 'pointerup', clientX: cx + 300, clientY: cy });
 *   }, { cx, cy });
 *   const after = await page.evaluate(
 *     () => window.__strikeforge_test__!.getDragRotation(),
 *   );
 *   expect(after).not.toEqual(before);
 */

import type { Quaternion } from 'three';

import type { IdleAutoRotateRef } from './useIdleAutoRotate';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Plain-object quaternion shape returned to Playwright tests. The four
 * fields match Three.js' `Quaternion` runtime type, but as primitives
 * rather than a class instance — required because `page.evaluate(...)`
 * serializes the returned value via the structured-clone algorithm,
 * which strips class prototypes.
 */
export interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Subset of `PointerEventInit` the bridge accepts from Playwright tests.
 *
 * The bridge translates this into a real `PointerEvent` and dispatches
 * it on the canvas wrapper element via `target.dispatchEvent(...)`.
 * Listeners installed by `useDragRotation` (via `addEventListener`) are
 * invoked synchronously in the same call stack.
 *
 * Why a small subset rather than the full `PointerEventInit`:
 *   - Tests should not need to specify mouse/keyboard modifier state.
 *   - `button`, `buttons`, `pointerType` are derived from `type` so
 *     tests cannot accidentally specify "left button up while pressed"
 *     contradictory states.
 *   - Defaults match the reference desktop hardware profile: primary
 *     mouse pointer, left button.
 */
export interface BridgePointerEventInit {
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave';
  readonly clientX: number;
  readonly clientY: number;
  /** Defaults to 1. Tests may override only if simulating multi-pointer. */
  readonly pointerId?: number;
  /** Defaults to true. Set false to simulate a non-primary pointer. */
  readonly isPrimary?: boolean;
}

/**
 * Public API attached to `window.__strikeforge_test__` while the
 * bridge is installed. Identical surface as exposed via
 * `installTestBridge(...)`.
 *
 * Every method is O(1) and side-effect-free with respect to the rAF
 * loop — `getSnapshot`-style reads return fresh plain objects so the
 * caller cannot mutate internal state, and `dispatchPointerEvent`
 * dispatches a synthetic event but does not register any listener.
 */
export interface StrikeForgeTestApi {
  /**
   * Return the accumulated drag-rotation quaternion as a plain object.
   * The underlying `Quaternion` is mutated in place by `useDragRotation`
   * pointer handlers; this method copies the four floats into a fresh
   * structured-cloneable record at call time.
   */
  getDragRotation(): QuaternionLike;

  /**
   * Return the accumulated auto-rotation quaternion as a plain object.
   * The underlying `Quaternion` is mutated in place by
   * `useIdleAutoRotate.tickAutoRotation`.
   */
  getAutoRotation(): QuaternionLike;

  /**
   * Return the COMPOSED quaternion (`autoRotation . multiply(dragRotation)`)
   * — the same value `Sphere.tsx`'s `useFrame` writes to the mesh's
   * `quaternion` field every frame. Computed via Hamilton product on
   * the fly so it never mutates the source quaternions.
   *
   * Useful for tests that verify the visible orientation rather than
   * one of the contributing accumulators.
   */
  getComposedRotation(): QuaternionLike;

  /**
   * Returns `true` while the primary pointer is captured by
   * `useDragRotation` (i.e. between `pointerdown` and `pointerup`).
   */
  getIsDragging(): boolean;

  /**
   * Returns `true` once `useIdleAutoRotate`'s idle timer has fired and
   * the per-frame `tickAutoRotation` callback is actively advancing
   * the auto-rotation accumulator.
   */
  getIsAutoRotating(): boolean;

  /**
   * Build a synthetic `PointerEvent` from the provided init and
   * dispatch it on the canvas wrapper element. Listeners registered
   * by `useDragRotation` (via `addEventListener`) are invoked
   * synchronously in the dispatching call stack.
   *
   * No-op if the bridge has not been installed or the wrapper element
   * is not yet mounted (returns silently rather than throwing — tests
   * should `waitForFunction` before dispatching to avoid races).
   */
  dispatchPointerEvent(init: BridgePointerEventInit): void;

  /**
   * Convenience: dispatch a sequence of pointer events in order.
   * Equivalent to calling `dispatchPointerEvent(init)` for each
   * element in the array.
   */
  dispatchPointerSequence(events: ReadonlyArray<BridgePointerEventInit>): void;
}

// ---------------------------------------------------------------------------
// Window global augmentation
//
// Declares `window.__strikeforge_test__` so TypeScript recognizes the
// property in calling code (tests under `frontend/tests/` and the
// installer in `BallCanvas.tsx`). The property is optional (`?:`)
// because it is `undefined` until `installTestBridge(...)` is called,
// and again after the returned cleanup runs.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    /**
     * Dev-only StrikeForge configurator test bridge. Attached by
     * `BallCanvas.tsx` under `import.meta.env.DEV` so production
     * builds tree-shake this property away entirely.
     *
     * Playwright tests interact with this object exclusively for
     * rotation-state assertions and synthetic pointer dispatch.
     */
    __strikeforge_test__?: StrikeForgeTestApi;
  }
}

// ---------------------------------------------------------------------------
// Public bridge types — install / cleanup
// ---------------------------------------------------------------------------

/**
 * The set of refs the bridge needs from `BallCanvas.tsx` to fulfill
 * its contract. All five fields are `MutableRefObject` instances
 * returned from React `useRef(...)` calls (or — in the case of
 * `idleAutoRotateRef` — a structurally compatible `IdleAutoRotateRef`
 * whose `current` is the angular velocity in rad/s), which means they
 * are stable across renders and safe to capture in a module-scoped
 * closure.
 *
 * Field shape contract:
 *   - dragRotationRef       — drag-rotation accumulator (mutated in
 *                             place by `useDragRotation` pointer
 *                             handlers).
 *   - autoRotationAccumRef  — auto-rotation accumulator (mutated in
 *                             place by `Sphere.tsx`'s `useFrame`).
 *   - isDraggingRef         — boolean flag (true while primary
 *                             pointer is captured by `useDragRotation`).
 *   - idleAutoRotateRef     — read-only velocity ref from
 *                             `useIdleAutoRotate`. `.current` is 0
 *                             when not auto-rotating, positive when
 *                             auto-rotating.
 *   - wrapperRef            — DOM ref to the canvas wrapper element
 *                             (target for synthetic pointer dispatch).
 */
export interface TestBridgeRefs {
  readonly dragRotationRef: React.MutableRefObject<Quaternion>;
  readonly autoRotationAccumRef: React.MutableRefObject<Quaternion>;
  readonly isDraggingRef: React.MutableRefObject<boolean>;
  readonly idleAutoRotateRef: IdleAutoRotateRef;
  readonly wrapperRef: React.MutableRefObject<HTMLElement | null>;
}

// ---------------------------------------------------------------------------
// PointerEvent construction helpers
// ---------------------------------------------------------------------------

/**
 * `PointerEvent.button` is 0 for the primary (left) mouse button. We
 * never simulate non-primary buttons because ST-002-AC1 specifies
 * "primary pointer" only.
 */
const PRIMARY_BUTTON = 0;

/**
 * `PointerEvent.buttons` bitmask — 1 means the primary button is
 * currently held. Used for `pointerdown` and `pointermove`.
 */
const PRIMARY_BUTTON_PRESSED = 1;

/**
 * `PointerEvent.buttons` bitmask — 0 means no button is currently
 * held. Used for `pointerup`, `pointercancel`, `pointerleave`.
 */
const NO_BUTTONS_PRESSED = 0;

/**
 * Default pointerId. Pointer event sequences SHOULD use a consistent
 * id across down/move/up so `useDragRotation`'s
 * `activePointerIdRef.current` check matches every event.
 */
const DEFAULT_POINTER_ID = 1;

/**
 * Construct a `PointerEvent` matching the bridge init. The event is
 * cancelable and bubbles so it reaches whichever ancestor listener
 * registered the handler.
 */
function buildPointerEvent(init: BridgePointerEventInit): PointerEvent {
  const isPointerReleasing =
    init.type === 'pointerup' || init.type === 'pointercancel' || init.type === 'pointerleave';

  return new PointerEvent(init.type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerType: 'mouse',
    pointerId: init.pointerId ?? DEFAULT_POINTER_ID,
    isPrimary: init.isPrimary ?? true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: PRIMARY_BUTTON,
    buttons: isPointerReleasing ? NO_BUTTONS_PRESSED : PRIMARY_BUTTON_PRESSED,
  });
}

// ---------------------------------------------------------------------------
// Quaternion helpers
// ---------------------------------------------------------------------------

/**
 * Copy the four floats of a `Quaternion` into a fresh plain object
 * suitable for Playwright's structured-clone serialization.
 */
function quaternionToPlain(q: Quaternion): QuaternionLike {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * Compute the Hamilton product `a * b` of two quaternions and return
 * the result as a plain object. Used by `getComposedRotation()` to
 * mirror `Sphere.tsx`'s per-frame composition formula
 * (`composed.copy(auto).multiply(drag)`) without mutating either
 * source quaternion.
 */
function multiplyQuaternionsPlain(a: Quaternion, b: Quaternion): QuaternionLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

/**
 * Install the test bridge by attaching a `StrikeForgeTestApi` to
 * `window.__strikeforge_test__`. Returns a cleanup function that
 * unattaches the property.
 *
 * Idempotency:
 *   - The cleanup function only deletes the property if it still
 *     points at the api object this install created. If a subsequent
 *     install replaced the api (e.g. StrictMode mount/unmount/remount),
 *     the OLD cleanup is a no-op rather than wiping the new install.
 *
 * SSR safety:
 *   - Returns a no-op cleanup if `window` is undefined (e.g. during
 *     server-side rendering or a Node-context unit test). The bridge
 *     is purely a browser-runtime concern.
 *
 * This function MUST only be called under an `import.meta.env.DEV`
 * gate at every call site. It does NOT enforce that gate internally
 * because the bridge module is a tree-shaking target — the consumer
 * must avoid importing it at all in production code paths if it
 * wants the bundle savings.
 */
export function installTestBridge(refs: TestBridgeRefs): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const dispatchPointerEvent = (init: BridgePointerEventInit): void => {
    const target = refs.wrapperRef.current;
    if (target === null) {
      return;
    }
    target.dispatchEvent(buildPointerEvent(init));
  };

  const api: StrikeForgeTestApi = {
    getDragRotation: () => quaternionToPlain(refs.dragRotationRef.current),
    getAutoRotation: () => quaternionToPlain(refs.autoRotationAccumRef.current),
    getComposedRotation: () =>
      multiplyQuaternionsPlain(refs.autoRotationAccumRef.current, refs.dragRotationRef.current),
    getIsDragging: () => refs.isDraggingRef.current,
    // "Auto-rotating" maps to "the idle hook's angular velocity is
    // non-zero". Per the `IdleAutoRotateRef` binary contract, this
    // is true exactly when auto-rotation is engaged (idle timer
    // fired AND no interaction since).
    getIsAutoRotating: () => refs.idleAutoRotateRef.current !== 0,
    dispatchPointerEvent,
    dispatchPointerSequence: (events) => {
      for (const init of events) {
        dispatchPointerEvent(init);
      }
    },
  };

  window.__strikeforge_test__ = api;

  return () => {
    if (window.__strikeforge_test__ === api) {
      // Reassign to undefined rather than `delete` to satisfy
      // `verbatimModuleSyntax` / `noUncheckedIndexedAccess` if either
      // is enabled in the future. Functionally equivalent for
      // optional declared properties.
      window.__strikeforge_test__ = undefined;
    }
  };
}
