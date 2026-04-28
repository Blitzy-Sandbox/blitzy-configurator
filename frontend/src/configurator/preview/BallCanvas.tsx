/**
 * BallCanvas — R3F <Canvas> wrapper hosting the configurator sphere.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/preview/BallCanvas.tsx
 *     | R3F <Canvas> root (ST-001)".
 *   - AAP §0.6.14 — "interactive 3D ball preview rendered via R3F <Canvas>";
 *     "preview auto-centers and re-fits on viewport resize (ST-001-AC3)".
 *   - ST-001 acceptance criteria:
 *       AC1 Sphere renders centered in the available preview area.
 *       AC2 Default visual state is pre-selected (white panels, red
 *           accent, classic stitching, matte finish — sourced from the
 *           Zustand store's CONFIGURATOR_DEFAULTS).
 *       AC3 Resize re-centers the sphere without distortion or clipping.
 *       AC4 ZERO console errors during initial render.
 *   - ST-005 — performance budgets are measured by `performance.ts`;
 *     this component initializes the FPS / initial-load instrumentation
 *     so `window.__strikeforge_perf__` is available to Playwright.
 *   - QA Report Issue #1 (sphere does not render), Issue #3 (resize
 *     re-centering), Issue #4 (zero console errors), Issue #8 (perf
 *     instrumentation never executes).
 *
 * Architecture:
 *   This component is the SOLE owner of the drag-rotation pointer
 *   bindings and the idle-auto-rotation timer. It calls the relevant
 *   hooks at the React-tree level where DOM elements are addressable
 *   (`useDragRotation` requires a real <div> ref to attach pointer
 *   listeners), and forwards the resulting Quaternion refs into
 *   `<Sphere />` as props.
 *
 *   The `<Canvas>` itself is wrapped in a `<div>` that fills its
 *   parent's flex/grid cell. R3F's internal `useThree` resize observer
 *   handles re-centering and aspect-ratio updates automatically when
 *   the wrapping <div> resizes — satisfying ST-001-AC3 with zero
 *   custom resize code.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: untouched (this file does not import or mutate
 *     the texture).
 *   - Rule R2: ZERO `console.*` calls. Errors raised from R3F or the
 *     hooks bubble to React's error boundary — they are not silenced.
 *   - Rule R3: no auth imports.
 */

import { Canvas } from '@react-three/fiber';
import { useEffect, useRef } from 'react';

import { Sphere } from './Sphere';
import { initializePerformanceInstrumentation } from './performance';
import { installTestBridge } from './testBridge';
import { useDragRotation } from './useDragRotation';
import { useIdleAutoRotate } from './useIdleAutoRotate';
import { useMaterialSwatch } from './useMaterialSwatch';

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Optional CSS class applied to the wrapping <div>. Allows the
 * containing layout (App.tsx's `.app-shell-preview` cell) to control
 * sizing without leaking layout concerns into the configurator
 * preview module itself.
 */
export interface BallCanvasProps {
  readonly className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pixel device-pixel-ratio range for R3F. The lower bound (1) is the
 * minimum supported quality; the upper bound (2) caps the cost on
 * Retina displays so a 4× DPR phone doesn't churn through 16× the
 * fragments. This range is appropriate for a 1024² texture mapped onto
 * a unit-radius sphere.
 */
const DEFAULT_DPR_RANGE: [number, number] = [1, 2];

/**
 * Camera position. Z=2.6 frames a unit-radius sphere with comfortable
 * margin in a 1280×720 viewport at fov=45°. The camera looks at the
 * world origin (R3F default).
 */
const CAMERA_POSITION: [number, number, number] = [0, 0, 2.6];

/**
 * Camera vertical field of view in degrees. 45° is a comfortable
 * "product photography" perspective — wider lenses introduce visible
 * fish-eye warping near the silhouette, narrower lenses look too
 * telephoto for an interactive product viewer.
 */
const CAMERA_FOV = 45;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The configurator's R3F <Canvas> root.
 *
 * Lifecycle:
 *   1. On mount, calls `initializePerformanceInstrumentation()` and
 *      stores the returned cleanup function. On unmount, invokes
 *      cleanup so React StrictMode's mount→unmount→mount double-pass
 *      doesn't leak the rAF loop or the global window hook.
 *   2. Initializes the idle-auto-rotate hook FIRST (so its
 *      `notifyInteraction` callback can be wired into the drag hook).
 *   3. Initializes the drag-rotation hook with `notifyInteraction` as
 *      its `onInteractionStart` so any drag immediately pauses
 *      auto-rotation and resets the idle timer.
 *   4. Attaches `attachRef` to the wrapping <div>. Pointer events
 *      against any descendant (including the R3F canvas) bubble up
 *      and trigger our handlers.
 *   5. Renders the R3F <Canvas> with default lights and the <Sphere />.
 */
export function BallCanvas(props: BallCanvasProps): JSX.Element {
  // -----------------------------------------------------------------------
  // ST-005 — Performance instrumentation lifecycle.
  //
  // `initializePerformanceInstrumentation` sets up the rAF loop,
  // attaches `window.__strikeforge_perf__`, and returns a cleanup
  // function. We call it inside `useEffect` rather than at module
  // load so React StrictMode's mount/unmount/remount produces exactly
  // one active instrumentation at a time.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const cleanup = initializePerformanceInstrumentation();
    return () => {
      cleanup();
    };
  }, []);

  // -----------------------------------------------------------------------
  // Wrapper element ref. We type it explicitly as `HTMLDivElement` and
  // cross-cast to the drag hook's `HTMLElement`-typed ref via a callback
  // ref pattern that keeps both refs synchronized.
  //
  // Constructed BEFORE the hooks below because `useIdleAutoRotate` now
  // takes a containerRef as input — its activity-detection listeners
  // bind to the wrapping <div>'s pointer/wheel/touch events. The same
  // ref is also forwarded to `useDragRotation` via `attachRef`.
  // -----------------------------------------------------------------------
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // -----------------------------------------------------------------------
  // ST-003 — Idle auto-rotation hook.
  //
  // Returns an `IdleAutoRotateRef` whose `.current` is the angular
  // velocity in rad/s around the world Y axis (binary: 0 when
  // interactive, AUTO_ROTATION_ANGULAR_VELOCITY_RAD_PER_SEC when
  // idle). The hook attaches its own activity-detection listeners
  // to the wrapper element and to `window`, so no `notifyInteraction`
  // callback is needed from the drag hook — auto-rotation pauses on
  // ANY pointer interaction with the container, on ANY pointer click
  // anywhere in the configurator (sidebars, header, etc.), and on
  // ANY keyboard event.
  // -----------------------------------------------------------------------
  const idleAutoRotateRef = useIdleAutoRotate(wrapperRef);

  // -----------------------------------------------------------------------
  // ST-004 — Material parameters from the current finish.
  //
  // `useMaterialSwatch` subscribes via Zustand selector to the
  // `materialFinish` store slice and returns one of three
  // module-scoped `MaterialParams` objects (matte, glossy, metallic).
  // The reference is stable per finish: identical finishes return
  // identical references, so React skips the downstream
  // `<meshStandardMaterial>` re-render when the finish hasn't
  // changed.
  //
  // The hook is called HERE (in `BallCanvas.tsx`) rather than inside
  // `Sphere.tsx` so that `Sphere` remains a pure rendering primitive
  // with no store coupling. Per AAP §0.6.7 / Sphere's schema, the
  // `materialParams` flow into `Sphere` as a prop, not via an
  // internal subscription.
  // -----------------------------------------------------------------------
  const materialParams = useMaterialSwatch();

  // -----------------------------------------------------------------------
  // ST-002 — Drag rotation hook.
  //
  // The hook accepts the wrapper <div>'s ref directly and attaches
  // its pointer event listeners (pointerdown, pointermove, pointerup,
  // pointercancel) to the underlying DOM element. It returns a
  // `DragRotationRef` whose `.current` is the cumulative rotation
  // quaternion mutated in place by drag gestures.
  //
  // ST-003-AC2 (auto-rotation pause on user interaction) is satisfied
  // because `useIdleAutoRotate` self-detects activity via its OWN
  // listeners on the same container element — pointerdown on the
  // wrapper bubbles to BOTH hooks' listeners simultaneously (DOM
  // event listeners are additive on a single element).
  // -----------------------------------------------------------------------
  const dragRotationRef = useDragRotation(wrapperRef);

  // -----------------------------------------------------------------------
  // Dev-only "is dragging" tracking ref.
  //
  // Per the schema-defined `useDragRotation` API, the hook exposes
  // ONLY the cumulative quaternion ref — it does not expose internal
  // drag state. The Playwright test bridge below needs to verify
  // that drag state cleared after release (preview.spec.ts uses this
  // as a belt-and-braces check), so we maintain a local boolean ref
  // that tracks the same primary-pointer drag lifecycle in this
  // component. The tracking listeners are installed alongside the
  // test bridge inside the dev-only `useEffect` further down — they
  // are absent from production builds entirely.
  // -----------------------------------------------------------------------
  const isDraggingRef = useRef<boolean>(false);

  // -----------------------------------------------------------------------
  // Dev-only test bridge (Playwright integration tests).
  //
  // The bridge attaches a small `window.__strikeforge_test__` API that
  // exposes the rotation refs and a synthetic-PointerEvent dispatcher,
  // so Playwright tests can verify drag, idle, and composition
  // behavior without depending on slow `canvas.toDataURL()` pixel
  // proxies or the CDP-driven `page.mouse.*` actionability checks
  // (both unworkably slow under software-WebGL headless Chromium).
  //
  // GATE: `import.meta.env.DEV` is true in `npm run dev` (Vite's dev
  // server, which Playwright's `webServer` config invokes) and false
  // in `npm run build` production output. Vite replaces the literal
  // at build time and dead-code-eliminates the entire bridge call.
  // The bridge module's runtime side effects are therefore confined
  // to local development and CI test environments.
  //
  // Why a separate `useEffect`: the bridge depends on `wrapperRef` /
  // the rotation refs being defined (which they are at mount), but
  // it does NOT depend on `wrapperRef.current` being non-null at
  // bridge-install time. The bridge defers the lookup to
  // `dispatchPointerEvent` call time, which always runs after mount
  // because tests `waitForFunction` before invoking it.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!import.meta.env.DEV) {
      return undefined;
    }

    // ---------------------------------------------------------------------
    // Dev-only `isDraggingRef` tracking.
    //
    // We mirror `useDragRotation`'s primary-pointer drag lifecycle so
    // the test bridge can answer `getIsDragging()` without the hook
    // having to expose internal state. The listeners watch only the
    // primary pointer (button === 0) and only flip the ref boolean;
    // they do NOT touch any rotation state, capture pointers, or
    // call `preventDefault`. They are install-once / cleanup-once
    // alongside the test bridge itself.
    // ---------------------------------------------------------------------
    const target = wrapperRef.current;
    const dragTrackingListeners: Array<{
      type: 'pointerdown' | 'pointerup' | 'pointercancel';
      handler: (event: PointerEvent) => void;
    }> = [];
    if (target !== null) {
      let trackedPointerId: number | null = null;

      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) {
          return;
        }
        trackedPointerId = event.pointerId;
        isDraggingRef.current = true;
      };

      const onPointerUp = (event: PointerEvent): void => {
        if (event.pointerId !== trackedPointerId) {
          return;
        }
        trackedPointerId = null;
        isDraggingRef.current = false;
      };

      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
      dragTrackingListeners.push(
        { type: 'pointerdown', handler: onPointerDown },
        { type: 'pointerup', handler: onPointerUp },
        { type: 'pointercancel', handler: onPointerUp },
      );
    }

    const uninstallBridge = installTestBridge({
      dragRotationRef,
      isDraggingRef,
      idleAutoRotateRef,
      wrapperRef,
    });

    return () => {
      // Symmetric cleanup so React StrictMode's double-mount leaves
      // no listener accumulated on the wrapper element, and the
      // `window.__strikeforge_test__` global is cleared first to
      // avoid tests racing against a stale API instance.
      uninstallBridge();
      if (target !== null) {
        for (const { type, handler } of dragTrackingListeners) {
          target.removeEventListener(type, handler);
        }
      }
    };
    // The five refs are stable `MutableRefObject` instances returned
    // from `useRef` / hooks built on top of `useRef`; their identity
    // does not change across renders, so an empty dep array correctly
    // captures the install-once / cleanup-once lifecycle. React's
    // exhaustive-deps lint rule is permissive of refs but we disable
    // it explicitly here so the intent is unambiguous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------
  // JSX
  //
  // The wrapping <div> uses 100% width/height so the parent's grid /
  // flex layout dictates the actual pixel dimensions. R3F's <Canvas>
  // automatically observes the parent for resize events and re-fits
  // its drawing buffer + camera aspect ratio — no manual ResizeObserver
  // is required, which directly satisfies ST-001-AC3.
  // -----------------------------------------------------------------------
  return (
    <div
      ref={wrapperRef}
      className={props.className}
      style={{
        width: '100%',
        height: '100%',
        // `touch-action: none` prevents the browser's default
        // pan/pinch from stealing pointer events during a drag —
        // ST-002-AC1/AC2 require uninterrupted drag tracking.
        touchAction: 'none',
        // The preview surface uses a subtle Blitzy-light surface so
        // the white default ball remains visible against the
        // background. The actual color comes from `var(--blitzy-surface-1)`
        // declared in `global.css`.
        background: 'var(--blitzy-surface-1, #F5F5F5)',
      }}
      data-testid="ball-canvas-wrapper"
      // Accessibility — keyboard alternative for the drag rotation
      // contract (AAP §0.6.7 "every control reachable by keyboard";
      // WCAG 2.1 AA SC 2.1.1 "Keyboard"). `tabIndex={0}` makes the
      // wrapper a Tab-stop so keyboard users can focus the preview
      // and use the arrow keys (handled by `useDragRotation`) to
      // rotate the ball.
      tabIndex={0}
      role="application"
      aria-label="3D ball preview. Drag with the pointer or use the arrow keys to rotate."
    >
      <Canvas
        camera={{ position: CAMERA_POSITION, fov: CAMERA_FOV }}
        dpr={DEFAULT_DPR_RANGE}
        gl={{
          antialias: true,
          // `preserveDrawingBuffer` is required for Playwright's
          // visual-regression `toHaveScreenshot()` to capture the
          // canvas pixels reliably (ST-046).
          preserveDrawingBuffer: true,
        }}
        // R3F's `frameloop="always"` keeps the render loop ticking
        // even when there's no scene change — required so
        // auto-rotation animates smoothly and `useFrame`'s delta
        // is always recent.
        frameloop="always"
      >
        {/* -------------------------------------------------------------
            Lighting rig. A combination of ambient + directional gives
            sufficient illumination for `MeshStandardMaterial` to
            distinguish matte / glossy / metallic finishes (ST-004).
        ------------------------------------------------------------- */}
        <ambientLight intensity={0.6} color="#FFFFFF" />
        <directionalLight position={[2.5, 3, 4]} intensity={1.0} color="#FFFFFF" />
        <directionalLight position={[-2.5, 1, -2]} intensity={0.35} color="#FFFFFF" />

        {/* -------------------------------------------------------------
            The configurator sphere. The drag and idle-velocity refs
            are forwarded so the mesh can compose the final orientation
            per QA Report Issue #5 (composition order: autoRotation .
            multiply(dragRotation) inside Sphere's `useFrame`). The
            material parameters flow as a value prop (not a ref)
            because finish changes are infrequent — React's prop
            diffing handles the propagation cheaply.
        ------------------------------------------------------------- */}
        <Sphere
          dragRotationRef={dragRotationRef}
          idleAutoRotateRef={idleAutoRotateRef}
          materialParams={materialParams}
        />
      </Canvas>
    </div>
  );
}
