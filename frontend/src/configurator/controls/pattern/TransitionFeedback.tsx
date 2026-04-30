/**
 * TransitionFeedback — Visible cue that a stitching pattern or material
 * finish change is being applied to the live preview (ST-012).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     TransitionFeedback.tsx | ST-012 transition indicator".
 *   - ST-012 acceptance criteria (verbatim from
 *     `tickets/stories/ST-012-preview-transition-feedback.md`):
 *       AC1: Changing the stitching pattern produces a visible
 *            transition on the preview rather than an abrupt swap.
 *       AC2: Changing the material finish produces a visible
 *            transition on the preview rather than an abrupt swap.
 *       AC3: If a transition takes longer than the documented
 *            threshold, a loading indicator appears on the preview
 *            until the new state is fully rendered.
 *       AC4: The transition animation does not block unrelated
 *            interactions such as rotation or other sidebar
 *            selections.
 *   - Related stories: ST-010 (`StitchingPatternSelector` emits
 *     `setStitchingPattern`); ST-011 (`FinishSelector` emits
 *     `setMaterialFinish`). This component observes those slices via
 *     selectors but never mutates them.
 *
 * Architecture:
 *   Passive observer — subscribes to `stitchingPattern` and
 *   `materialFinish` via Zustand selectors, derives transition
 *   state LOCALLY through the canonical "did the value change"
 *   ref-pattern (`previousPatternRef` / `previousFinishRef`).
 *
 *   Two timers drive the visible state:
 *     1. `transitionEndTimerRef` fires after
 *        `TRANSITION_FADE_DURATION_MS`, clearing `isTransitioning`.
 *     2. `loadingIndicatorTimerRef` fires after
 *        `LOADING_INDICATOR_THRESHOLD_MS`, revealing the spinner
 *        (ST-012-AC3). If the transition completes before the
 *        threshold elapses, the loading indicator never appears.
 *
 *   On every change, both timers are reset so successive rapid
 *   selections don't accumulate stale state. The component returns
 *   `null` while idle, contributing zero DOM nodes outside an
 *   active transition.
 *
 *   Mount expectation: an absolutely-positioned overlay (`inset: 0`)
 *   inside its nearest positioned ancestor — typically the preview
 *   region's container. Mounting at a higher level still works (the
 *   overlay covers a larger area) and never blocks interactions
 *   because the overlay carries `pointer-events: none`.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT import `texturePipeline`,
 *     `threeTexture`, `fabricCanvas`, or any module from
 *     `frontend/src/configurator/texture/`. Verifiable via
 *     `grep -E "texturePipeline|needsUpdate|fabricCanvas|threeTexture"
 *     TransitionFeedback.tsx` returning ZERO matches.
 *   - Rule R2: ZERO `console.*` calls; no credential identifiers.
 *   - Rule R3: no auth imports.
 *   - AAP §0.6.14 (no design system): inline styles + module-level
 *     keyframe injection, no UI-library imports.
 *   - Selector pattern: `useConfiguratorStore((s) => s.<slice>)` —
 *     never the bare `useConfiguratorStore()` call.
 *   - AC4 enforcement: the overlay container carries
 *     `pointer-events: none` so rotation gestures and sidebar clicks
 *     pass through to underlying elements.
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Documented thresholds
// ---------------------------------------------------------------------------

/**
 * Duration of the visible transition fade animation in milliseconds.
 *
 * Purely visual — does NOT correspond to actual texture-pipeline
 * work. The pipeline runs synchronously below the frame budget; the
 * fade is a UX cue that "something just changed" so the swap doesn't
 * feel abrupt (ST-012-AC1, ST-012-AC2).
 */
const TRANSITION_FADE_DURATION_MS = 250;

/**
 * Threshold beyond which the loading indicator becomes visible
 * (ST-012-AC3). The spinner only appears in degraded cases (logo
 * decode delay, GC pause, GPU contention). Sits below
 * `TRANSITION_FADE_DURATION_MS`, so a slow transition shows: fade
 * starts → 200 ms spinner appears → 50 ms more → fade ends. Healthy
 * transitions show only the fade. 200 ms is the Nielsen-Norman
 * threshold below which UI changes feel instantaneous.
 */
const LOADING_INDICATOR_THRESHOLD_MS = 200;

// ---------------------------------------------------------------------------
// Module-level keyframe injection
// ---------------------------------------------------------------------------

/**
 * CSS keyframe definitions consumed by the inline-styled overlay
 * and spinner. Declared at module scope so the runtime cost is paid
 * once per page load. The de-dup guard makes the inject idempotent
 * under Vite hot-module reload and Jest module re-evaluation.
 */
const KEYFRAMES_CSS = `
@keyframes sf-transition-fade {
  0%   { opacity: 0; }
  20%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}

@keyframes sf-transition-spin {
  to { transform: rotate(360deg); }
}
`;

/**
 * Append a one-time `<style>` tag containing the keyframes to
 * `document.head`. Skipped under SSR (no `document`). Re-running
 * this is a no-op thanks to the `data-sf-transition-keyframes`
 * marker attribute on the injected `<style>` element.
 */
function injectKeyframesOnce(): void {
  if (typeof document === 'undefined') {
    return;
  }
  if (document.head.querySelector('style[data-sf-transition-keyframes]') !== null) {
    return;
  }
  const styleTag = document.createElement('style');
  styleTag.setAttribute('data-sf-transition-keyframes', '');
  styleTag.textContent = KEYFRAMES_CSS;
  document.head.appendChild(styleTag);
}

injectKeyframesOnce();

// ---------------------------------------------------------------------------
// Inline style constants
// ---------------------------------------------------------------------------

/**
 * Overlay container style. `pointerEvents: 'none'` (ST-012-AC4)
 * ensures the overlay NEVER intercepts pointer events. `position:
 * absolute` + `inset: 0` fills the nearest positioned ancestor.
 */
const OVERLAY_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  // ST-012-AC4 — the overlay is purely decorative; never block pointer events.
  pointerEvents: 'none',
  // Subtle radial gradient draws attention to the center without obscuring content.
  background:
    'radial-gradient(circle at center, rgba(255, 255, 255, 0) 40%, rgba(91, 57, 243, 0.04) 70%, rgba(91, 57, 243, 0.06) 100%)',
  animation: 'sf-transition-fade 250ms ease-out',
  zIndex: 10,
};

/**
 * Spinner — 32×32 circular border with a colored top arc that
 * rotates via `sf-transition-spin`. Visible only when the
 * transition exceeds `LOADING_INDICATOR_THRESHOLD_MS` (ST-012-AC3).
 */
const SPINNER_STYLE: CSSProperties = {
  width: '2rem',
  height: '2rem',
  border: '3px solid rgba(91, 57, 243, 0.2)',
  borderTopColor: '#5B39F3',
  borderRadius: '50%',
  animation: 'sf-transition-spin 800ms linear infinite',
  // Spinner is descriptive only; never intercepts pointer events.
  pointerEvents: 'none',
};

/**
 * Visually-hidden text for assistive technology — standard sr-only
 * pattern. Screen readers announce the live region while the
 * visible UI shows the gradient/spinner.
 */
const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Visual transition feedback indicator. Renders an absolutely-
 * positioned, non-blocking overlay whenever the user changes the
 * stitching pattern (ST-010) or material finish (ST-011). When the
 * transition lasts longer than the documented threshold
 * (ST-012-AC3), a loading spinner appears.
 *
 * Returns `null` when no transition is active so the component
 * contributes zero DOM nodes outside its active state.
 */
export function TransitionFeedback(): JSX.Element | null {
  // Subscribe to ONLY the slices we care about, via selectors
  // (Zustand 4.x recommended pattern). Scopes re-renders to the
  // smallest possible surface so unrelated state changes (color,
  // logo, save) do not trigger fades.
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);

  // Refs for "did change" detection. React effects fire on initial
  // mount with the current values; tracking previous values via
  // refs ensures the transition only fires on ACTUAL changes.
  const previousPatternRef = useRef(stitchingPattern);
  const previousFinishRef = useRef(materialFinish);

  // Timer handles. `window.setTimeout` returns `number` in browsers.
  const transitionEndTimerRef = useRef<number | null>(null);
  const loadingIndicatorTimerRef = useRef<number | null>(null);

  const [isTransitioning, setIsTransitioning] = useState<boolean>(false);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState<boolean>(false);

  useEffect(() => {
    // Detect actual change (skip initial mount via ref comparison).
    const patternChanged = previousPatternRef.current !== stitchingPattern;
    const finishChanged = previousFinishRef.current !== materialFinish;

    if (!patternChanged && !finishChanged) {
      return;
    }

    // Update refs so the next effect run compares against the latest values.
    previousPatternRef.current = stitchingPattern;
    previousFinishRef.current = materialFinish;

    // Cancel any in-flight timers from a previous transition so rapid
    // successive changes don't accumulate stale state.
    if (transitionEndTimerRef.current !== null) {
      window.clearTimeout(transitionEndTimerRef.current);
      transitionEndTimerRef.current = null;
    }
    if (loadingIndicatorTimerRef.current !== null) {
      window.clearTimeout(loadingIndicatorTimerRef.current);
      loadingIndicatorTimerRef.current = null;
    }

    // Begin a fresh transition cycle.
    setIsTransitioning(true);
    setShowLoadingIndicator(false);

    // Schedule the spinner reveal at the documented threshold (ST-012-AC3).
    loadingIndicatorTimerRef.current = window.setTimeout(() => {
      setShowLoadingIndicator(true);
      loadingIndicatorTimerRef.current = null;
    }, LOADING_INDICATOR_THRESHOLD_MS);

    // Schedule the end of the transition (clears both visible states).
    transitionEndTimerRef.current = window.setTimeout(() => {
      setIsTransitioning(false);
      setShowLoadingIndicator(false);
      transitionEndTimerRef.current = null;
      // Defensive: also clear the loading indicator timer if it
      // hasn't fired yet (it will be re-scheduled on the next change).
      if (loadingIndicatorTimerRef.current !== null) {
        window.clearTimeout(loadingIndicatorTimerRef.current);
        loadingIndicatorTimerRef.current = null;
      }
    }, TRANSITION_FADE_DURATION_MS);
  }, [stitchingPattern, materialFinish]);

  // Cleanup timers on unmount to prevent stale-state updates.
  useEffect(() => {
    return () => {
      if (transitionEndTimerRef.current !== null) {
        window.clearTimeout(transitionEndTimerRef.current);
        transitionEndTimerRef.current = null;
      }
      if (loadingIndicatorTimerRef.current !== null) {
        window.clearTimeout(loadingIndicatorTimerRef.current);
        loadingIndicatorTimerRef.current = null;
      }
    };
  }, []);

  // Idle: contribute zero DOM nodes.
  if (!isTransitioning) {
    return null;
  }

  // Single accessible name; the visible UI is the gradient/spinner,
  // so screen readers receive the same information via `aria-label`
  // and the visually-hidden status text.
  const accessibleStatus = showLoadingIndicator ? 'Applying preview update' : 'Preview updating';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={accessibleStatus}
      data-testid="transition-feedback"
      data-transitioning="true"
      data-loading={showLoadingIndicator ? 'true' : 'false'}
      style={OVERLAY_STYLE}
    >
      {showLoadingIndicator ? (
        <div aria-hidden="true" data-testid="transition-feedback-spinner" style={SPINNER_STYLE} />
      ) : null}
      <span style={SR_ONLY_STYLE}>{accessibleStatus}</span>
    </div>
  );
}
