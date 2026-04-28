/**
 * Performance instrumentation for the StrikeForge configurator preview.
 *
 * Authority:
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/configurator/preview/performance.ts →
 *       FPS meter + initial-load timer (ST-005)
 *   - AAP §0.6.7 "Track 2 — Frontend Core":
 *       CREATE | FPS meter + initial-load timer for ST-005 budgets
 *       (≥30 FPS, ≤2000 ms)
 *   - AAP §0.6.7 Gate T2 verification:
 *       `cd frontend && npx playwright test --project=chromium tests/performance/`
 *       — FPS ≥30 and initial-load ≤2000 ms asserted.
 *
 * Story coverage (ST-005):
 *   - AC1: Sustained drag rotation maintains ≥30 FPS — covered by the rolling
 *     500 ms FPS sampler that updates `_fps` and `_minFpsObserved`.
 *   - AC2: Auto-rotation idle playback maintains ≥30 FPS — same sampler; the
 *     rAF loop ticks regardless of which interaction mode is driving rotation.
 *   - AC3: Initial render completes ≤2000 ms — `_initialLoadMs` captured on
 *     the first rAF callback after `initializePerformanceInstrumentation()`.
 *   - AC4: Performance measurements captured for release-artifact audit —
 *     `getSnapshot()` returns a structurally-cloneable plain object that the
 *     Playwright performance suite serializes into its test report.
 *
 * Responsibilities:
 *   - Run a single requestAnimationFrame loop that ticks every browser
 *     compositor frame and counts frames in a rolling sample window.
 *   - Compute and expose four metrics: current rolling-window FPS
 *     (`fps`), initial-load milliseconds (`initialLoadMs`), total frames
 *     measured (`totalFrames`), and minimum FPS observed across all
 *     completed sample windows (`minFpsObserved`).
 *   - Attach a small read-only API to `window.__strikeforge_perf__` so
 *     Playwright tests running in the page context can poll the metrics
 *     via `page.evaluate(() => window.__strikeforge_perf__.getSnapshot())`.
 *   - Behave idempotently under React 18 StrictMode's double-invocation of
 *     the initialization effect: a module-scoped guard prevents duplicate
 *     rAF loops, and the returned cleanup function fully resets state so
 *     that StrictMode's mount/cleanup/remount cycle starts a single fresh
 *     loop on the second mount.
 *
 * Design rationale (recorded once here so that downstream readers do not
 * need to reconstruct it from the implementation):
 *   - Singleton + window global, NOT React Context or Zustand: the primary
 *     consumer (Playwright performance tests) lives outside the React tree
 *     and cannot read Context or store state. A window-attached object is
 *     the standard browser-to-test bridge.
 *   - 500 ms sample window: at 60 FPS each window measures ≈30 frames,
 *     producing fps values with ≈3.3% per-frame resolution. Smaller windows
 *     amplify variance from individual frame jitter; larger windows slow
 *     test assertions and reduce the granularity of `minFpsObserved`.
 *   - `performance.now()` (monotonic, sub-millisecond resolution) is used
 *     instead of `Date.now()` (millisecond resolution, can jump backward on
 *     system clock adjustments). For FPS measurement the monotonic clock
 *     is strictly required.
 *   - The cleanup function fully resets every module-scoped variable, not
 *     just the rAF handle. StrictMode's "first effect → first cleanup →
 *     second effect" sequence requires the post-cleanup state to be
 *     observationally equivalent to "never initialized" so the second
 *     effect can re-run the full initialization path.
 *   - `minFpsObserved` (rather than the rolling `fps`) is the metric the
 *     Playwright test asserts against the 30 FPS floor. ST-005's "sustained"
 *     wording is interpreted as "no completed window dropped below 30",
 *     which `minFpsObserved` captures exactly. A rolling average could
 *     mask brief sub-30 dips that ST-005 considers regressions.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R7 / C6 (Fabric → Three texture update order): UNTOUCHED. This
 *     module does not import or mutate `THREE.Texture#needsUpdate`. The
 *     texture coordinator in `configurator/texture/texturePipeline.ts`
 *     owns that contract.
 *   - Rule R2 (no credential material in logs): there are zero `console.*`
 *     calls in this module. The eslint rule `no-console` is configured to
 *     error on `console.log` and approve only `console.warn`/`console.error`;
 *     this module emits neither.
 *   - Rule R3 (Firebase Admin SDK only on the backend): N/A — frontend-only
 *     utility with zero auth dependencies.
 *
 * Out of scope:
 *   - Telemetry export (OpenTelemetry, Prometheus, vendor analytics): ST-005
 *     captures performance for test-time artifacts only. Production
 *     observability for the configurator is a backend concern handled by
 *     ST-047 / ST-048 / ST-049.
 *   - GPU / paint-timing breakdown (PerformanceObserver entries for paint,
 *     long-task, layout-shift, etc.): the FPS proxy is sufficient for
 *     ST-005's acceptance criteria.
 *   - Frame-jank histograms beyond the rolling-window minimum FPS metric.
 *   - Reactive subscription / publish-subscribe (no `EventTarget`, no
 *     `subscribe()` API): the Playwright contract is intentionally
 *     poll-based to keep the API surface minimal.
 */

// ---------------------------------------------------------------------------
// Public API interfaces
//
// These are the named type exports referenced by Playwright tests (which
// import the type from this module via `import type { ... }`) and by the
// global Window augmentation block below.
// ---------------------------------------------------------------------------

/**
 * Read-only snapshot of the current performance metrics.
 *
 * Returned by `StrikeForgePerformanceApi.getSnapshot()`. Plain-object shape
 * is required because Playwright's `page.evaluate(...)` serializes the
 * returned value via the structured-clone algorithm to transport it from
 * the browser back to the Node test runner; functions, prototypes, and
 * non-cloneable types would be stripped or throw.
 *
 * Used by Playwright performance tests to assert:
 *   - `fps` ≥ 30 during drag / auto-rotation (ST-005-AC1, ST-005-AC2).
 *   - `initialLoadMs` ≤ 2000 (ST-005-AC3).
 *
 * Also persisted to the test report for the release-artifact audit
 * (ST-005-AC4).
 */
export interface PerformanceSnapshot {
  /**
   * Frames-per-second measured over the most recent completed sample
   * window. `0` until the first sample window completes (the first ~500 ms
   * after instrumentation init).
   */
  readonly fps: number;

  /**
   * Milliseconds elapsed from `initializePerformanceInstrumentation()`
   * to the first rAF callback (i.e., to the first browser-compositor
   * frame after init). `null` until the first frame has been observed.
   *
   * Per ST-005-AC3 this is the proxy for "initial render complete" and
   * must be ≤ 2000 ms on the reference hardware profile.
   */
  readonly initialLoadMs: number | null;

  /**
   * Total number of rAF callbacks observed since the most recent reset
   * (initialization or `resetAccumulators()`). Informational metric used
   * by tests to validate that an FPS assertion is statistically meaningful
   * — for example, a test may skip the FPS assertion if `totalFrames < 30`
   * to avoid acting on a tiny sample.
   */
  readonly totalFrames: number;

  /**
   * Minimum FPS observed across every completed sample window since the
   * most recent reset. `null` until at least one sample window has
   * completed. This is the metric used to assert ST-005-AC1 / ST-005-AC2:
   * the test asserts `minFpsObserved >= 30` so that a single brief dip
   * below 30 FPS fails the gate.
   */
  readonly minFpsObserved: number | null;
}

/**
 * Public API attached to `window.__strikeforge_perf__`. Playwright
 * performance tests interact with this object exclusively; no other
 * surface is exposed.
 *
 * Both methods are O(1) and side-effect-free with respect to the rAF
 * loop, so tests may call them inside polling loops without perturbing
 * the metrics being measured.
 */
export interface StrikeForgePerformanceApi {
  /**
   * Return a fresh `PerformanceSnapshot` reflecting the current metric
   * values. Constructs a new plain object on every call so that the
   * returned reference cannot be mutated to corrupt internal state.
   */
  getSnapshot(): PerformanceSnapshot;

  /**
   * Reset the rolling-window accumulators (`fps` is left untouched as the
   * most-recent measurement, but `minFpsObserved`, `totalFrames`, and the
   * in-progress sample window all reset). Used by Playwright tests to
   * isolate measurement windows — for example, "measure FPS during drag
   * rotation, independent of the startup warmup phase during which Three.js
   * compiles shaders and Fabric.js builds its initial canvas".
   *
   * Does NOT reset `initialLoadMs` because that metric is a one-shot
   * measurement of the initial render path; resetting it would lose the
   * value that ST-005-AC3 exists to capture.
   */
  resetAccumulators(): void;
}

// ---------------------------------------------------------------------------
// Window global augmentation
//
// Declares `window.__strikeforge_perf__` so TypeScript recognizes the
// property in calling code (e.g., Playwright tests in `tests/performance/`).
// The property is optional (`?:`) because it is `undefined` until
// `initializePerformanceInstrumentation()` is called and again after the
// returned cleanup function runs.
//
// `interface Window` is the only valid form here: TypeScript's declaration
// merging requires interface syntax to extend an existing global interface;
// `type Window = ...` would shadow rather than augment.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    /**
     * StrikeForge configurator performance instrumentation, attached to
     * the window global so Playwright tests can read FPS and initial-load
     * metrics via:
     *
     *     await page.evaluate(
     *       () => window.__strikeforge_perf__?.getSnapshot()
     *     );
     *
     * Undefined until `initializePerformanceInstrumentation()` is called.
     * Reset to undefined when the returned cleanup function runs.
     *
     * The `__name__` (double-underscore prefix and suffix) signals
     * "library-internal; not part of the application's public API"; the
     * `strikeforge_` prefix namespaces our metrics away from any other
     * tool that might attach a `__perf__` global (such as a third-party
     * profiler injected by browser dev tools).
     */
    __strikeforge_perf__?: StrikeForgePerformanceApi;
  }
}

// ---------------------------------------------------------------------------
// Module-scoped constants
// ---------------------------------------------------------------------------

/**
 * Length of the rolling FPS sample window in milliseconds.
 *
 * 500 ms is chosen as the balance point between sample size and assertion
 * latency:
 *   - At 60 FPS, a 500 ms window measures ≈30 frames — statistically
 *     meaningful (one frame represents 3.3% of the sample).
 *   - At 30 FPS (the floor), a 500 ms window still measures ≈15 frames,
 *     enough to detect a sustained dip without being dominated by jitter.
 *   - Two completed windows per second means a Playwright test can
 *     observe at least one full-window FPS measurement within 1 second
 *     of any user-action simulation, keeping test runtime low.
 */
const FPS_SAMPLE_WINDOW_MS = 500;

// ---------------------------------------------------------------------------
// Module-scoped singleton state
//
// All singleton state lives at module scope (not inside the exported
// function) so that the idempotency guard `_initialized` survives across
// multiple `initializePerformanceInstrumentation()` invocations, which is
// the entire point of the guard. Module scope also persists across
// React StrictMode's effect-double-invocation cycle and Vite HMR reloads
// of consuming modules (the consuming component is re-rendered, but this
// module is not re-evaluated unless this file itself changes).
//
// Variables are written by:
//   - `initializePerformanceInstrumentation` (init path)
//   - `frameLoop` closure inside that function (per-frame updates)
//   - The cleanup closure returned from that function (teardown)
//   - `api.resetAccumulators` (test-controlled reset)
// ---------------------------------------------------------------------------

/**
 * `true` while the rAF loop is active and `window.__strikeforge_perf__`
 * is attached. Toggled by `initializePerformanceInstrumentation` (sets to
 * true) and by the returned cleanup function (resets to false). The first
 * statement in `initializePerformanceInstrumentation` checks this flag
 * to avoid starting a duplicate rAF loop on a redundant call.
 */
let _initialized = false;

/**
 * Handle returned by the most recent `requestAnimationFrame()` call, or
 * `null` when no frame is currently scheduled (i.e., before init or
 * after cleanup). The cleanup function passes this to
 * `cancelAnimationFrame` to stop the loop.
 */
let _rafHandle: number | null = null;

/**
 * Most recent FPS sample (frames-per-second over the last completed
 * 500 ms window). `0` until the first window completes — Playwright tests
 * use `totalFrames` to detect when a real measurement is available.
 */
let _fps = 0;

/**
 * Minimum sample-window FPS observed since the most recent reset, or
 * `null` if no window has completed yet. Updated only at sample-window
 * boundaries, never on individual frames.
 */
let _minFpsObserved: number | null = null;

/**
 * Total number of rAF callbacks observed since the most recent reset
 * (init or `resetAccumulators`). Strictly informational — the Playwright
 * test reports it for forensic context but does not assert against it.
 */
let _totalFrames = 0;

/**
 * Time in milliseconds from `initializePerformanceInstrumentation()` to
 * the first rAF callback, or `null` if the first frame has not yet
 * arrived. Set exactly once per init cycle (gated by `_firstFrameSeen`).
 */
let _initialLoadMs: number | null = null;

/**
 * `true` once the first rAF callback after init has been observed. Used
 * to gate `_initialLoadMs` so it captures the first-frame timing only —
 * subsequent frames must NOT overwrite it.
 */
let _firstFrameSeen = false;

/**
 * High-resolution timestamp (`performance.now()` reading) marking the
 * start of the current in-progress sample window. The next sample window
 * begins when the current frame's timestamp - `_sampleStartTimeMs` is
 * ≥ FPS_SAMPLE_WINDOW_MS.
 */
let _sampleStartTimeMs = 0;

/**
 * Number of rAF callbacks observed since the start of the current
 * in-progress sample window. Reset to `0` whenever the window closes
 * and a new sample is computed.
 */
let _sampleFrameCount = 0;

/**
 * High-resolution timestamp marking the moment
 * `initializePerformanceInstrumentation()` was invoked. Subtracted from
 * the first rAF callback's timestamp to compute `_initialLoadMs`.
 */
let _initializationStartTimeMs = 0;

// ---------------------------------------------------------------------------
// Public initialization function
// ---------------------------------------------------------------------------

/**
 * Initialize the performance instrumentation.
 *
 * Idempotent: if the instrumentation is already running (because of a
 * redundant call, e.g. from React StrictMode's double-invocation of
 * `useEffect`), this function returns immediately with a no-op cleanup.
 *
 * On the first call (or the first call after a previous cleanup ran):
 *   1. Records the initialization timestamp via `performance.now()`.
 *   2. Resets all metric accumulators to their initial values.
 *   3. Schedules the first rAF callback that drives the FPS sampler.
 *   4. Attaches the public API to `window.__strikeforge_perf__` so
 *      Playwright tests can read metrics from the page context.
 *
 * The returned cleanup function (a closure capturing the init-time state)
 * is intended to be returned from `useEffect`:
 *
 *     useEffect(() => {
 *       const cleanup = initializePerformanceInstrumentation();
 *       return cleanup;
 *     }, []);
 *
 * Invoking the cleanup function:
 *   - Calls `cancelAnimationFrame` to stop the rAF loop.
 *   - Removes `window.__strikeforge_perf__`.
 *   - Resets every module-scoped variable to the same value it had before
 *     `initializePerformanceInstrumentation` was first called.
 *
 * After cleanup, a subsequent call to `initializePerformanceInstrumentation`
 * starts a fresh rAF loop and returns a new (real) cleanup closure. This
 * is the contract that makes React StrictMode's double-invocation pattern
 * work: cleanup → re-init → final cleanup all execute the full path
 * exactly once.
 *
 * @returns A cleanup function. Caller must invoke it on component unmount
 *   to stop the rAF loop and release the window global.
 */
export function initializePerformanceInstrumentation(): () => void {
  // Idempotency guard: a redundant call (e.g., StrictMode's first
  // re-invocation before the first cleanup runs) returns the no-op
  // cleanup so the caller's `return cleanup;` still type-checks. The
  // REAL cleanup tied to the running loop was returned from the prior
  // successful call and is still owned by that prior caller; calling
  // `noopCleanup` here does not interfere with it.
  if (_initialized) {
    return noopCleanup;
  }

  _initialized = true;
  _initializationStartTimeMs = performance.now();
  _sampleStartTimeMs = _initializationStartTimeMs;
  _sampleFrameCount = 0;
  _totalFrames = 0;
  _fps = 0;
  _minFpsObserved = null;
  _initialLoadMs = null;
  _firstFrameSeen = false;

  // The rAF callback. Captures no parameters and reads only module-scoped
  // state, so it has no allocation cost per frame beyond the one fresh
  // closure for the next `requestAnimationFrame` call.
  //
  // The `timestampMs` argument is the high-resolution timestamp the
  // browser passes to every rAF callback — equivalent to
  // `performance.now()` evaluated at the start of the frame. Using it
  // instead of calling `performance.now()` ourselves avoids one syscall
  // per frame and keeps timing on the same monotonic clock the browser
  // uses for compositor scheduling.
  const frameLoop = (timestampMs: number): void => {
    // Capture initial-load on the FIRST frame only. Without the gate
    // every frame would overwrite `_initialLoadMs` and ST-005-AC3 would
    // become "time to most recent frame" rather than "time to first
    // frame" — a meaningless metric.
    if (!_firstFrameSeen) {
      _firstFrameSeen = true;
      // Evaluate `performance.now()` here (rather than reusing the rAF
      // `timestampMs` argument) for the FIRST-FRAME branch only. The
      // rAF spec defines `timestampMs` as the time of the frame the
      // callback is being invoked for, but in practice some browser
      // implementations (notably Chromium when a frame was already in
      // flight at the moment `requestAnimationFrame` was scheduled) can
      // pass a `timestampMs` that predates `_initializationStartTimeMs`,
      // producing a negative `_initialLoadMs`. A negative initial-load
      // value violates ST-005-AC4 (auditable performance measurements)
      // because release-artifact consumers must be able to reason about
      // it as a non-negative duration. `performance.now()` evaluated
      // inside the callback is guaranteed to be ≥ `_initializationStart-
      // TimeMs` (both read the same monotonic clock and the callback
      // necessarily executes after init), so the computed difference is
      // always non-negative. The per-frame syscall optimization
      // documented above does not apply here because this branch fires
      // exactly ONCE in the lifetime of the loop.
      _initialLoadMs = performance.now() - _initializationStartTimeMs;
    }

    _sampleFrameCount += 1;
    _totalFrames += 1;

    // Close the current sample window if it has elapsed FPS_SAMPLE_WINDOW_MS.
    // Note: `elapsedMs` may modestly exceed FPS_SAMPLE_WINDOW_MS because
    // rAF callbacks fire at compositor cadence (≈16.67 ms at 60 Hz), not
    // at exact 500 ms boundaries. Computing `fps = frames * 1000 / elapsedMs`
    // (rather than `frames * 1000 / FPS_SAMPLE_WINDOW_MS`) corrects for
    // the slight overshoot and produces an accurate per-window FPS value.
    const elapsedMs = timestampMs - _sampleStartTimeMs;
    if (elapsedMs >= FPS_SAMPLE_WINDOW_MS) {
      // FPS = frames / seconds = frames * (1000 / elapsedMs). One division
      // (slightly better floating-point precision and marginally faster
      // than `frames / (elapsedMs / 1000)`).
      const sampleFps = (_sampleFrameCount * 1000) / elapsedMs;
      _fps = sampleFps;
      if (_minFpsObserved === null || sampleFps < _minFpsObserved) {
        _minFpsObserved = sampleFps;
      }
      _sampleStartTimeMs = timestampMs;
      _sampleFrameCount = 0;
    }

    // Schedule the next frame. The handle is stored at module scope so
    // the cleanup closure can `cancelAnimationFrame(_rafHandle)` to stop
    // the loop. Without this assignment the cleanup would be unable to
    // cancel an in-flight scheduled frame.
    _rafHandle = requestAnimationFrame(frameLoop);
  };

  // Kick off the loop. The handle returned here is the very first one;
  // every subsequent frame's handle replaces it inside `frameLoop`.
  _rafHandle = requestAnimationFrame(frameLoop);

  // Build the public API object. The methods close over the module-scoped
  // variables, so they always see the freshest values — but the returned
  // snapshot itself is a plain object with primitive fields, ensuring
  // structured-clone compatibility for Playwright's `page.evaluate(...)`
  // serialization boundary.
  const api: StrikeForgePerformanceApi = {
    getSnapshot(): PerformanceSnapshot {
      return {
        fps: _fps,
        initialLoadMs: _initialLoadMs,
        totalFrames: _totalFrames,
        minFpsObserved: _minFpsObserved,
      };
    },
    resetAccumulators(): void {
      // Reset everything related to the rolling sample, including
      // `_totalFrames` and `_minFpsObserved`. Do NOT reset `_initialLoadMs`
      // — that metric is a one-shot measurement of the initial render
      // and resetting it would lose the value ST-005-AC3 captures. Do
      // NOT reset `_fps` either; leaving the most-recent measurement
      // visible during the immediate post-reset interval is more useful
      // to tests than zeroing it out.
      _minFpsObserved = null;
      _totalFrames = 0;
      _sampleStartTimeMs = performance.now();
      _sampleFrameCount = 0;
    },
  };

  // Attach the API to the window. Browser-only by design: this module is
  // imported only by React components that mount inside the Vite-served
  // browser bundle, never in an SSR or pure-Node context, so `window` is
  // guaranteed to be defined.
  window.__strikeforge_perf__ = api;

  // Return the REAL cleanup closure to the caller. Each call site that
  // sees `_initialized === false` and falls into this branch produces a
  // unique closure; the closure's job is to reverse the effects of THIS
  // initialization path, which is identical for every invocation, so
  // every closure is functionally equivalent.
  return (): void => {
    if (_rafHandle !== null) {
      cancelAnimationFrame(_rafHandle);
      _rafHandle = null;
    }
    // The Window augmentation declares the property as optional, which
    // satisfies TypeScript's requirement that `delete` only be applied
    // to optional properties under strict mode.
    delete window.__strikeforge_perf__;

    // Reset every singleton variable to the value it would have on a
    // fresh module load. After this assignment block, the post-cleanup
    // state is observationally identical to "module just imported,
    // never initialized" — which is exactly the contract that StrictMode's
    // mount/cleanup/remount cycle relies on.
    _initialized = false;
    _fps = 0;
    _minFpsObserved = null;
    _totalFrames = 0;
    _initialLoadMs = null;
    _firstFrameSeen = false;
    _sampleStartTimeMs = 0;
    _sampleFrameCount = 0;
    _initializationStartTimeMs = 0;
  };
}

/**
 * No-op cleanup returned when `initializePerformanceInstrumentation` is
 * called while the instrumentation is already initialized.
 *
 * Defined as a named function declaration (not an arrow expression) for
 * two reasons:
 *   1. Stack traces from production debugging surface the function name
 *      `noopCleanup` rather than an anonymous lambda — easier to grep.
 *   2. The function is hoisted, so the early-return at the top of
 *      `initializePerformanceInstrumentation` can reference it before
 *      the lexical position where it is defined in source order.
 *
 * Invoking this function is safe and has no effect: the running rAF loop
 * and window global are owned by the closure returned from the first
 * (successful) `initializePerformanceInstrumentation` call. That earlier
 * closure is the one that gets invoked on real component unmount.
 */
function noopCleanup(): void {
  // Intentionally empty. See JSDoc above.
}
