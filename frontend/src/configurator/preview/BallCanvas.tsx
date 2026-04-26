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
  // ST-003 — Idle auto-rotation hook.
  //
  // Constructed before the drag hook so its `notifyInteraction` is
  // available to be passed into `useDragRotation`'s options.
  //
  // `isAutoRotatingRef` is destructured here SOLELY for the dev-only
  // test bridge below. Production rendering does not consume the flag;
  // `tickAutoRotation` already honors it internally.
  // -----------------------------------------------------------------------
  const { autoRotationRef, isAutoRotatingRef, notifyInteraction, tickAutoRotation } =
    useIdleAutoRotate();

  // -----------------------------------------------------------------------
  // ST-002 — Drag rotation hook.
  //
  // The `attachRef` returned here is bound to the wrapping <div> below.
  // `onInteractionStart` is wired to `notifyInteraction` so a drag
  // immediately pauses auto-rotation per ST-003-AC2.
  //
  // `isDraggingRef` is destructured here SOLELY for the dev-only test
  // bridge below. Production rendering does not consume the flag;
  // `useIdleAutoRotate` reacts to interaction via the
  // `notifyInteraction` callback path, not by polling this flag.
  // -----------------------------------------------------------------------
  const { attachRef, dragRotationRef, isDraggingRef } = useDragRotation({
    onInteractionStart: notifyInteraction,
  });

  // -----------------------------------------------------------------------
  // Wrapper element ref. We type it explicitly as `HTMLDivElement` and
  // cross-cast to the hook's `HTMLElement`-typed ref via a callback
  // ref pattern that keeps both refs synchronized.
  // -----------------------------------------------------------------------
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Synchronize the wrapper ref with the drag hook's `attachRef`.
  // `attachRef` is a `RefObject<HTMLElement>` whose `.current` is
  // read-only at the type level, but mutable at runtime — React's
  // own ref objects work this way. We assign through a small helper
  // that performs the runtime mutation in a single place to keep
  // the type-cast localized.
  const setRefs = (node: HTMLDivElement | null): void => {
    wrapperRef.current = node;
    // The hook's `attachRef` is a `RefObject<HTMLElement>` whose
    // `.current` is mutable at runtime. We assign through a
    // type-localized cast that is safe because <div> implements
    // HTMLElement.
    (attachRef as React.MutableRefObject<HTMLElement | null>).current = node;
  };

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
    return installTestBridge({
      dragRotationRef,
      autoRotationRef,
      isDraggingRef,
      isAutoRotatingRef,
      wrapperRef,
    });
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
      ref={setRefs}
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
            The configurator sphere. Rotation refs and the per-frame
            tick callback are forwarded so the mesh can compose the
            final orientation per QA Report Issue #5 (composition
            order: autoRotation . clone() . multiply(dragRotation)).
        ------------------------------------------------------------- */}
        <Sphere
          dragRotationRef={dragRotationRef}
          autoRotationRef={autoRotationRef}
          tickAutoRotation={tickAutoRotation}
        />
      </Canvas>
    </div>
  );
}
