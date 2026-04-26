/**
 * InvalidFileFeedback — Invalid File Rejection Feedback (ST-017).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/logo/
 *     InvalidFileFeedback.tsx | ST-017 rejection messaging".
 *   - ST-017 acceptance criteria:
 *       AC1 — Uploading a file whose type is not among the supported
 *             raster and vector image formats is rejected and the
 *             preview is left unchanged.
 *       AC2 — Uploading a file larger than the documented maximum file
 *             size is rejected and the preview is left unchanged.
 *       AC3 — Every rejection produces a user-facing message that names
 *             the specific reason (unsupported format versus size limit)
 *             and the remediation the user can take.
 *       AC4 — The rejection message is announced to assistive technology
 *             and does not obscure the 3D preview or the control sidebar.
 *
 * Role in the logo control sub-tree:
 *   This is the FOUNDATIONAL LEAF of the logo folder. It has NO sibling
 *   imports and depends only on React primitives for type information.
 *   It is consumed by `./LogoUploader.tsx` which owns the validation
 *   error in local component state and passes it to this component as
 *   a prop. The configurator Zustand store deliberately does NOT carry
 *   a `logoValidationError` slice — the error is view-layer-only state.
 *
 * Pure presentation contract:
 *   - No hooks.
 *   - No side effects.
 *   - No store reads or writes.
 *   - No texture pipeline calls.
 *   - No network I/O.
 *   - Renders are cheap and idempotent.
 *
 * ARIA contract (ST-017-AC4):
 *   - role="alert"          — declares this is an alert region.
 *   - aria-live="assertive" — interrupt current speech for immediate
 *                             announcement (the user just performed an
 *                             action; the failure must be conveyed now).
 *   - aria-atomic="true"    — re-announce the entire heading + detail +
 *                             remediation block when the error changes,
 *                             not just the diff.
 *   - position: 'relative'  — inline in document flow; does NOT obscure
 *                             the 3D preview or the rest of the sidebar.
 *
 * Cross-cutting rules:
 *   - Rule R2: ZERO `console.*` calls in this file.
 *   - Rule R3: NO authentication or JWT imports.
 *   - Rule R7 / C6: NO `texture.needsUpdate` mutations.
 *   - No `dangerouslySetInnerHTML` — every text source is rendered via
 *     React's normal JSX escaping, neutralizing XSS via `error.detail`.
 */

import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Discriminator for a logo-upload validation error variant.
 *
 * Each value maps to one of the two ST-017 rejection criteria:
 *   - `'unsupported-format'` → ST-017-AC1 (unsupported MIME type).
 *   - `'size-exceeded'`      → ST-017-AC2 (oversized file).
 *
 * Exporting the narrow union as a named type lets future consumers
 * (test fixtures, analytics, story data builders) reference the exact
 * enumeration of rejection reasons machine-readably, rather than
 * re-deriving it from string literals scattered across call sites.
 */
export type LogoValidationReason = 'unsupported-format' | 'size-exceeded';

/**
 * The shape of a logo-upload validation error surfaced to the user.
 *
 * The error is produced by `LogoUploader.tsx`'s `validateFile` helper
 * and consumed by this component. The store does NOT persist this
 * state — it is view-layer local state.
 *
 * Fields:
 *   - `reason`          : the discriminator (see {@link LogoValidationReason}).
 *   - `detail`          : a human-readable description of the specific
 *                         input that triggered the rejection (e.g. the
 *                         actual MIME type observed, or the file size
 *                         in megabytes). Rendered as the BODY paragraph.
 *   - `supportedFormats`: optional helper context used when `reason ===
 *                         'unsupported-format'` — a comma-separated
 *                         list of accepted formats (e.g. "PNG, JPEG,
 *                         SVG, WebP"). Surfaced inside the remediation
 *                         paragraph.
 *   - `maximumSize`     : optional helper context used when `reason ===
 *                         'size-exceeded'` — a human-readable size
 *                         (e.g. "5 MB"). Surfaced inside the
 *                         remediation paragraph.
 *
 * Convention (per AAP):
 *   reason = 'unsupported-format' → `supportedFormats` SHOULD be set.
 *   reason = 'size-exceeded'      → `maximumSize` SHOULD be set.
 *
 * Both helper fields are formally optional so the component can render
 * a graceful generic remediation when callers omit them, but well-formed
 * `LogoUploader` invocations will always supply the contextual field
 * matching the chosen `reason`.
 *
 * The `readonly` modifiers express that the error is a value object —
 * once constructed by `validateFile`, the object is never mutated, so
 * passing it to this component does not require a defensive copy.
 */
export interface LogoValidationError {
  readonly reason: LogoValidationReason;
  readonly detail: string;
  readonly supportedFormats?: string;
  readonly maximumSize?: string;
}

/**
 * Public props accepted by {@link InvalidFileFeedback}.
 *
 * Fields:
 *   - `error`        : the error to render. When `null` the component
 *                      returns `null` from React, allowing callers to
 *                      pass the current error value unconditionally
 *                      without an outer truthy check.
 *   - `data-testid`  : optional Playwright selector identifier. Defaults
 *                      to `'invalid-file-feedback'`. Sub-elements
 *                      (heading / detail / remediation) derive their
 *                      identifiers from this prefix.
 */
export interface InvalidFileFeedbackProps {
  readonly error: LogoValidationError | null;
  readonly 'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Module-private message construction helpers
// ---------------------------------------------------------------------------

/**
 * Build the SHORT heading text for the error. Kept short so screen
 * readers announce the reason quickly; the full detail and remediation
 * follow in subsequent paragraphs.
 *
 * The default branch is unreachable when `reason` is well-typed — the
 * `const _exhaustive: never = reason;` line is the standard TypeScript
 * exhaustiveness check that fails compilation if a new
 * {@link LogoValidationReason} variant is added without updating this
 * switch. The `void _exhaustive;` expression both consumes the binding
 * (avoiding `noUnusedLocals` warnings) and confirms the variable's
 * type is `never` at compile time.
 */
function buildHeading(reason: LogoValidationReason): string {
  switch (reason) {
    case 'unsupported-format':
      return 'Unsupported file format';
    case 'size-exceeded':
      return 'File is too large';
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'Upload failed';
    }
  }
}

/**
 * Build the REMEDIATION text — what the user can do to fix the problem.
 *
 * Explicitly separated from the {@link LogoValidationError.detail}
 * (the "what went wrong" body) so screen readers convey the
 * two-part message structure required by ST-017-AC3:
 *
 *   1. heading      → "What kind of failure".
 *   2. detail       → "What specifically went wrong".
 *   3. remediation  → "What the user can do about it".
 *
 * When the optional helper context (`supportedFormats` / `maximumSize`)
 * is missing, the remediation falls back to a generic phrasing so the
 * component continues to convey actionable guidance.
 */
function buildRemediation(error: LogoValidationError): string {
  switch (error.reason) {
    case 'unsupported-format':
      return error.supportedFormats !== undefined && error.supportedFormats.length > 0
        ? `Please upload an image in one of these formats: ${error.supportedFormats}.`
        : 'Please upload an image in a supported format.';
    case 'size-exceeded':
      return error.maximumSize !== undefined && error.maximumSize.length > 0
        ? `Please upload an image smaller than ${error.maximumSize}. You can compress or resize it externally, then try again.`
        : 'Please upload a smaller image.';
    default: {
      const _exhaustive: never = error.reason;
      void _exhaustive;
      return 'Please try again.';
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private style constants
// ---------------------------------------------------------------------------

/**
 * Container style.
 *
 * `position: 'relative'` is REQUIRED by ST-017-AC4 — the component must
 * NOT obscure the 3D preview or the control sidebar. Inline (not fixed,
 * not absolute) positioning guarantees the message flows naturally
 * within the sidebar layout where it is mounted.
 *
 * Color palette deliberately diverges from the purple brand palette
 * because "error red" is a culturally expected convention for
 * rejection feedback in Western UX. The darkened red text (#5B1A1A)
 * over a tinted red background (#FFF3F3) measures ≈8:1 contrast —
 * comfortably exceeds WCAG AA (4.5:1) and approaches AAA (7:1).
 */
const CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.625rem 0.75rem',
  paddingLeft: '1rem',
  borderLeft: '4px solid #C62828',
  backgroundColor: '#FFF3F3',
  borderRadius: '0.25rem',
  color: '#5B1A1A',
};

/**
 * Heading paragraph style. Bold weight (`600`) without claiming an
 * `<h2>`/`<h3>` heading level — the parent's heading hierarchy is
 * unknown from this leaf component, and `role="alert"` on the
 * container ensures assistive technology announces the message
 * regardless of the visual emphasis.
 */
const HEADING_STYLE: CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  margin: 0,
  color: '#5B1A1A',
};

/** Body (detail) paragraph style. Slightly smaller than the heading. */
const BODY_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  lineHeight: 1.4,
  margin: 0,
  color: '#5B1A1A',
};

/**
 * Remediation paragraph style. Same metrics as the body but a heavier
 * weight (`500`) signals the actionable nature of the line — the user
 * should attend to "what to do next" more than "what went wrong".
 */
const REMEDIATION_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  lineHeight: 1.4,
  margin: 0,
  color: '#5B1A1A',
  fontWeight: 500,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * InvalidFileFeedback — pure presentation component that renders a
 * user-facing error message for a rejected logo upload (ST-017).
 *
 * Accessibility:
 *   - The container element carries `role="alert"`, `aria-live="assertive"`,
 *     and `aria-atomic="true"` so screen readers announce the FULL
 *     heading + detail + remediation message immediately whenever the
 *     error changes (ST-017-AC4).
 *   - Heading, detail, and remediation are rendered as SEPARATE `<p>`
 *     elements so assistive-technology rotor / region navigation can
 *     move between the parts.
 *
 * Layout:
 *   - The container uses `position: 'relative'` and inline flexbox —
 *     it does NOT overlay the 3D preview or the sidebar (ST-017-AC4).
 *
 * Test selectors:
 *   - Container: `data-testid={testId}` (default `'invalid-file-feedback'`).
 *   - Container: `data-reason={error.reason}` exposes the variant for
 *     Playwright selectors such as `[data-reason="size-exceeded"]`.
 *   - Heading:     `data-testid={`${testId}-heading`}`.
 *   - Detail:      `data-testid={`${testId}-detail`}`.
 *   - Remediation: `data-testid={`${testId}-remediation`}`.
 *
 * Defensive null handling:
 *   When `error === null`, returns `null` from React so the caller can
 *   pass the current value unconditionally. The typical caller
 *   (`LogoUploader.tsx`) wraps this component in a truthy check
 *   (`{error !== null && <InvalidFileFeedback .../>}`); both patterns
 *   produce identical render output.
 */
export function InvalidFileFeedback(props: InvalidFileFeedbackProps) {
  const { error, 'data-testid': testId = 'invalid-file-feedback' } = props;

  if (error === null) {
    return null;
  }

  const heading = buildHeading(error.reason);
  const remediation = buildRemediation(error);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      style={CONTAINER_STYLE}
      data-testid={testId}
      data-reason={error.reason}
    >
      <p style={HEADING_STYLE} data-testid={`${testId}-heading`}>
        {heading}
      </p>
      <p style={BODY_STYLE} data-testid={`${testId}-detail`}>
        {error.detail}
      </p>
      <p style={REMEDIATION_STYLE} data-testid={`${testId}-remediation`}>
        {remediation}
      </p>
    </div>
  );
}
