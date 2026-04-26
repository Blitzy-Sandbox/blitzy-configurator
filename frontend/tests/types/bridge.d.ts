/**
 * Shared browser-side type declarations for the StrikeForge test bridge.
 *
 * Authority:
 *   - frontend/src/configurator/preview/testBridge.ts owns the runtime
 *     contract; this file mirrors the surface for `page.evaluate()` use.
 *   - QA Issue #5–#7 (drag/idle/material) needed deterministic state
 *     reads + synthetic pointer dispatch beyond what the CDP-driven
 *     `page.mouse.*` API offers on software-WebGL Chromium.
 *
 * Why a separate `.d.ts` (and not local declarations in each spec):
 *   - TypeScript's declaration-merging rule requires every redeclaration
 *     of a global interface property to share the *exact same* type.
 *     Locally-scoped interfaces named `StrikeForgeTestApi` in two
 *     different spec files are structurally identical yet treated as
 *     distinct types, producing TS2717 errors at compile time.
 *   - Centralising the declaration here keeps every spec aligned with
 *     the canonical contract from `testBridge.ts` and avoids drift.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file declares types only; no runtime mutations.
 *   - Rule R2: no credentials.
 *   - Rule R3: no JWT operations.
 *   - The bridge itself is dev-only (`import.meta.env.DEV` gate inside
 *     `BallCanvas.tsx`); these types are erased from production builds.
 */

export {}; // Ensure this file is treated as a module.

declare global {
  interface BridgeQuaternionLike {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  }

  interface BridgePointerEventInit {
    readonly type:
      | 'pointerdown'
      | 'pointermove'
      | 'pointerup'
      | 'pointercancel'
      | 'pointerleave';
    readonly clientX: number;
    readonly clientY: number;
    readonly pointerId?: number;
    readonly isPrimary?: boolean;
  }

  interface StrikeForgeTestApi {
    getDragRotation(): BridgeQuaternionLike;
    getAutoRotation(): BridgeQuaternionLike;
    getComposedRotation(): BridgeQuaternionLike;
    getIsDragging(): boolean;
    getIsAutoRotating(): boolean;
    dispatchPointerEvent(init: BridgePointerEventInit): void;
    dispatchPointerSequence(events: ReadonlyArray<BridgePointerEventInit>): void;
  }

  interface StrikeForgePerformanceApi {
    getSnapshot(): {
      readonly fps: number;
      readonly initialLoadMs: number | null;
      readonly totalFrames: number;
      readonly minFpsObserved: number | null;
    };
    resetAccumulators(): void;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __strikeforge_test__?: StrikeForgeTestApi;
    __strikeforge_perf__?: StrikeForgePerformanceApi;
  }
}
