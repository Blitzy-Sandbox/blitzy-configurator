/**
 * ErrorBoundary — React error boundary with brand-styled fallback.
 *
 * Authority:
 *   - QA Report Issue #12 (MAJOR): "no error boundary protects the
 *     React tree from the BallCanvas WebGL throw". When WebGL is
 *     unavailable, the entire React tree currently unmounts and
 *     `<div id="root">` ends with zero children. This boundary
 *     contains the failure to the wrapped subtree (the 3D preview)
 *     so the rest of the layout — header, control sidebar, summary
 *     sidebar — continues to render and remain interactive.
 *
 * Architecture:
 *   This is a React 18 class component because `getDerivedStateFromError`
 *   and `componentDidCatch` are still only available on class
 *   components (no hook equivalent at the time of writing).
 *
 *   The boundary renders the wrapped children when no error has
 *   propagated, and a customizable fallback when one has. The fallback
 *   defaults to a brand-styled message that explains 3D preview is
 *   unavailable in the current environment, so users on browsers
 *   without WebGL still see a usable, accessible interface.
 *
 *   The component does NOT log errors via `console.*` (Rule R2). It
 *   forwards the captured error/info to an optional `onError` prop so
 *   tests and observability hooks can react to it.
 *
 * Cross-cutting rules:
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *   - Rule R7 / C6: no texture-pipeline imports.
 */

import { Component } from 'react';
import type { ErrorInfo, JSX, ReactNode } from 'react';

/**
 * Props for {@link ErrorBoundary}.
 *
 * `children` is required. `fallback` is an optional renderable shown
 * when the boundary trips — defaults to {@link DefaultErrorFallback}.
 *
 * `onError` is an optional notification hook — invoked whenever the
 * boundary catches an error, useful for plumbing into a logger /
 * analytics sink without coupling the boundary to a specific
 * provider.
 *
 * `aria-label` is optional and is forwarded to the fallback container
 * so callers can override the default "Preview unavailable" wording
 * in context.
 */
export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
}

/** Internal component state. */
interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly errorMessage: string;
}

/**
 * Brand-styled fallback message. Inline styles use the documented
 * brand tokens via `var(--blitzy-*)` so the fallback matches the
 * surrounding shell when the global stylesheet is loaded.
 */
const FALLBACK_STYLE = Object.freeze({
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  width: '100%',
  padding: 'var(--space-2xl, 48px)',
  background: 'var(--blitzy-surface-2, #F4EFF6)',
  color: 'var(--blitzy-text, #333333)',
  fontFamily: 'var(--ff-body, "Inter", system-ui, sans-serif)',
  textAlign: 'center' as const,
  boxSizing: 'border-box' as const,
});

const FALLBACK_HEADING_STYLE = Object.freeze({
  fontFamily: 'var(--ff-display, "Space Grotesk", system-ui, sans-serif)',
  fontSize: '1.4rem',
  fontWeight: 600,
  margin: 0,
  marginBottom: 'var(--space-md, 16px)',
  color: 'var(--blitzy-primary-dark, #2D1C77)',
});

const FALLBACK_BODY_STYLE = Object.freeze({
  fontSize: '0.95rem',
  lineHeight: 1.5,
  margin: 0,
  maxWidth: '32rem',
  color: 'var(--blitzy-text-muted, #999999)',
});

const FALLBACK_DETAIL_STYLE = Object.freeze({
  fontFamily: 'var(--ff-mono, "Fira Code", monospace)',
  fontSize: '0.75rem',
  marginTop: 'var(--space-md, 16px)',
  color: 'var(--blitzy-text-muted, #999999)',
});

/**
 * The default fallback view. Rendered when the boundary trips and no
 * `fallback` prop is provided.
 *
 * Exported separately so tests and storybook can render the fallback
 * in isolation without forcing an error.
 */
export interface DefaultErrorFallbackProps {
  readonly title?: string;
  readonly description?: string;
  readonly errorMessage?: string;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
}

export function DefaultErrorFallback({
  title = '3D preview is unavailable',
  description = "Your browser couldn't initialize the 3D rendering surface. Your design choices are still saved — try this configurator in Chrome, Firefox, or Safari with hardware acceleration enabled.",
  errorMessage,
  'aria-label': ariaLabel = 'Preview unavailable',
  'data-testid': testId = 'error-boundary-fallback',
}: DefaultErrorFallbackProps): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="polite"
      aria-label={ariaLabel}
      data-testid={testId}
      style={FALLBACK_STYLE}
    >
      <h2 style={FALLBACK_HEADING_STYLE} data-testid={`${testId}-heading`}>
        {title}
      </h2>
      <p style={FALLBACK_BODY_STYLE} data-testid={`${testId}-description`}>
        {description}
      </p>
      {errorMessage !== undefined && errorMessage.length > 0 ? (
        <p style={FALLBACK_DETAIL_STYLE} data-testid={`${testId}-detail`}>
          Details: {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

/**
 * React error boundary with brand-styled fallback.
 *
 * Tripping is a one-way operation in React's design — once an error
 * propagates, the only way to "reset" is for the boundary to be
 * remounted (e.g., via a key change). We deliberately don't expose a
 * "Try again" affordance because the underlying failure (missing
 * WebGL context) is environmental and would re-occur on any retry.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message ?? 'Unknown rendering error.',
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Forward to the optional notification hook. We intentionally do
    // NOT call `console.error` (Rule R2). Consumers that need
    // observability wire `onError` to a structured sink.
    if (typeof this.props.onError === 'function') {
      this.props.onError(error, info);
    }
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      const { fallback, 'aria-label': ariaLabel, 'data-testid': testId } = this.props;
      if (fallback !== undefined) return fallback;
      return (
        <DefaultErrorFallback
          errorMessage={this.state.errorMessage}
          aria-label={ariaLabel}
          data-testid={testId}
        />
      );
    }
    return this.props.children;
  }
}
