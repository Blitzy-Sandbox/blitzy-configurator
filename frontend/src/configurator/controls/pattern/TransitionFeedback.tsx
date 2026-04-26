/**
 * TransitionFeedback — Visible cue that a pattern/finish change is in
 * progress (ST-012).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/pattern/
 *     TransitionFeedback.tsx | ST-012 transition indicator".
 *   - ST-012 acceptance criteria: a visible transition indicator
 *     appears for the duration of pattern/finish change; the
 *     indicator is accessible to assistive technology (announced via
 *     `aria-live` polite region).
 *   - QA Report Issue #7.
 *
 * Architecture:
 *   This component subscribes to BOTH `stitchingPattern` and
 *   `materialFinish` slices. Whenever either slice changes, a
 *   short-lived "active" timer starts. While the timer is active:
 *     - a visible pulsing bar is rendered inline below the selectors,
 *     - a hidden `aria-live="polite"` `<span>` announces the change
 *       so screen readers receive an immediate confirmation.
 *
 *   The duration is intentionally short (1.5 seconds) and matches
 *   `transitionPulse` in `pattern.module.css`. Visual + ARIA stay
 *   synchronized because both are driven by the same React state.
 *
 *   We use a ref-tracked timeout so successive changes RESET the
 *   countdown rather than overlapping multiple timers. This keeps the
 *   indicator visible for the full duration of the *latest* change.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import styles from './pattern.module.css';

/**
 * Total duration of the visible transition indicator, in milliseconds.
 *
 * 1500 ms is comfortable for short pattern/finish swaps and aligns
 * with the keyframe duration in `pattern.module.css`. If we extend the
 * GPU upload chain in the future, this constant should track that
 * upper bound.
 */
const TRANSITION_DURATION_MS = 1500;

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store. Test consumers can address it via the
 * deterministic `data-testid="transition-feedback"`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TransitionFeedbackProps {}

/**
 * Renders a short pulsing bar whenever the pattern or finish changes,
 * accompanied by a polite announcement for assistive technology.
 *
 * The component renders nothing (returns an empty hidden status
 * region) when no transition is active, so it does not consume layout
 * space in the steady state.
 */
export function TransitionFeedback(_props: TransitionFeedbackProps = {}): JSX.Element {
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);

  const [active, setActive] = useState<boolean>(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Skip the very first render so we don't pulse for the initial
  // store-default values. Subsequent slice changes are real
  // transitions and should be announced.
  const initializedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return undefined;
    }

    // Reset any in-flight timer so successive changes always show the
    // full TRANSITION_DURATION_MS for the latest change.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }
    setActive(true);
    const handle = setTimeout(() => {
      setActive(false);
      timeoutRef.current = null;
    }, TRANSITION_DURATION_MS);
    timeoutRef.current = handle;

    return () => {
      clearTimeout(handle);
    };
  }, [stitchingPattern, materialFinish]);

  // Cleanup on unmount — defensive even though the per-effect cleanup
  // above already covers strict-mode double-invocation.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return (
    <div data-testid="transition-feedback" data-active={active ? 'true' : 'false'}>
      {active ? (
        <div
          className={styles.transitionFeedback}
          role="presentation"
          aria-hidden="true"
          data-testid="transition-feedback-bar"
        />
      ) : null}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={styles.transitionFeedback__srOnly}
        data-testid="transition-feedback-status"
      >
        {active
          ? `Updating preview to ${stitchingPattern} pattern with ${materialFinish} finish.`
          : ''}
      </span>
    </div>
  );
}
