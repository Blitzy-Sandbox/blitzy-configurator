/**
 * logoValidation — Logo upload validation rules and factory for
 * `LogoValidationError` (ST-014, ST-017).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/logo/
 *     LogoUploader.tsx | ST-014 file-picker with valid-MIME allow-list".
 *   - ST-014 acceptance criteria: a designer can upload a logo image
 *     that becomes the placement source for the configurator.
 *   - ST-017 acceptance criteria:
 *       AC1 — Unsupported MIME types are rejected.
 *       AC2 — Files exceeding the documented maximum size are
 *             rejected.
 *       AC3 — The rejection message names the reason and remediation.
 *       AC4 — The rejection message is announced to assistive
 *             technology and does not obscure the preview.
 *   - QA Report Issues #9 and #11.
 *
 * Architecture:
 *   This module is a pure value-object factory. It contains:
 *     - the canonical allow-list of supported MIME types
 *       (PNG, JPEG, GIF, SVG, WebP — five formats per the QA report
 *       and AAP §0.6.7),
 *     - the canonical maximum file size (5 MiB),
 *     - a `validateLogoFile(file)` helper that returns either
 *       `{ ok: true }` or `{ ok: false, error: LogoValidationError }`.
 *
 *   Keeping the rules in a separate module makes them trivially
 *   unit-testable and prevents call-site drift if a future story adds
 *   another supported format or changes the maximum size.
 *
 *   The `LogoValidationError` interface is defined in
 *   `./InvalidFileFeedback.tsx` (the FOUNDATIONAL LEAF of the logo
 *   sub-tree) — we re-export it from here for ergonomic consumption
 *   and to keep dependency direction one-way (uploader → validation →
 *   feedback).
 *
 * Cross-cutting rules:
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 *   - Rule R7 / C6: no texture-pipeline imports.
 */

import type { LogoValidationError, LogoValidationReason } from './InvalidFileFeedback';

// ---------------------------------------------------------------------------
// Public re-exports — consumers need only import from this module.
// ---------------------------------------------------------------------------

export type { LogoValidationError, LogoValidationReason };

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Canonical allow-list of supported logo MIME types.
 *
 * Derived from AAP §0.6.7 / QA Report Issue #9: "5 MIME types
 * (PNG, JPEG, GIF, SVG, WebP)". The order is significant — it is the
 * order in which formats are surfaced in the human-readable
 * remediation message.
 */
export const SUPPORTED_LOGO_MIME_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'image/webp',
] as const);

/**
 * Human-readable label for each supported MIME type, used in the
 * `supportedFormats` field of {@link LogoValidationError}.
 */
const MIME_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/svg+xml': 'SVG',
  'image/webp': 'WebP',
};

/**
 * Comma-separated human-readable list of supported formats — used
 * inside the remediation paragraph of the rejection alert.
 */
export const SUPPORTED_LOGO_FORMAT_LABELS: string = SUPPORTED_LOGO_MIME_TYPES.map(
  (mime) => MIME_LABEL[mime] ?? mime,
).join(', ');

/**
 * Maximum permitted logo file size, in bytes. 5 MiB matches
 * AAP §0.6.7 and the QA Report's expectation for ST-017-AC2.
 *
 * The constant is exported so unit tests can construct fixtures
 * straddling the boundary precisely.
 */
export const MAXIMUM_LOGO_SIZE_BYTES: number = 5 * 1024 * 1024;

/**
 * Human-readable form of the maximum size, surfaced inside the
 * remediation paragraph of the rejection alert.
 */
export const MAXIMUM_LOGO_SIZE_LABEL: string = '5 MB';

/**
 * Accepted MIME types as a single comma-separated string, suitable for
 * passing to `<input accept>`. The native file-picker uses the value
 * to filter the operating-system dialog so users see only valid
 * candidates by default. We still re-validate on the JS side because
 * users can drag-drop or paste files that bypass the filter.
 */
export const SUPPORTED_LOGO_ACCEPT_ATTRIBUTE: string = SUPPORTED_LOGO_MIME_TYPES.join(',');

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by {@link validateLogoFile}.
 *
 * Callers narrow on `ok` to access either `file` (the validated File)
 * or `error` (the populated {@link LogoValidationError}).
 */
export type LogoValidationResult =
  | { readonly ok: true; readonly file: File }
  | { readonly ok: false; readonly error: LogoValidationError };

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Format a number of bytes as megabytes with at most one decimal of
 * precision. Used in the `detail` field for size-exceeded errors so
 * users see "8.4 MB" rather than "8806400 bytes".
 */
function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  // Round to 1 decimal place; trim a trailing ".0" so whole numbers
  // are not surfaced as "8.0 MB".
  const rounded = Math.round(mb * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text} MB`;
}

/**
 * Build a `LogoValidationError` for an unsupported MIME type. The
 * factory is exported so unit tests can construct fixtures
 * deterministically without depending on the validate function.
 */
export function createUnsupportedFormatError(actualMimeType: string): LogoValidationError {
  const observed = actualMimeType.length > 0 ? actualMimeType : 'unknown';
  return {
    reason: 'unsupported-format',
    detail: `The file you selected has type "${observed}", which is not a supported logo format.`,
    supportedFormats: SUPPORTED_LOGO_FORMAT_LABELS,
  };
}

/**
 * Build a `LogoValidationError` for an oversized file.
 */
export function createSizeExceededError(actualBytes: number): LogoValidationError {
  return {
    reason: 'size-exceeded',
    detail: `The file you selected is ${formatMegabytes(actualBytes)}, which exceeds the ${MAXIMUM_LOGO_SIZE_LABEL} limit.`,
    maximumSize: MAXIMUM_LOGO_SIZE_LABEL,
  };
}

// ---------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------

/**
 * Validate a logo upload candidate.
 *
 * Order of checks:
 *   1. MIME-type allow-list (cheap; fails fast).
 *   2. Size limit.
 *
 * The order is significant — when both checks would fail, we surface
 * the format error first because the user cannot remediate a
 * size-exceeded SVG by compressing it without first switching to a
 * raster format.
 */
export function validateLogoFile(file: File): LogoValidationResult {
  // Treat a missing or unrecognised MIME as a format failure rather
  // than letting it slip through. The browser sometimes assigns an
  // empty `type` for files dragged from exotic sources; in that case
  // we cannot guarantee the contents are an image at all, so we
  // reject.
  if (!SUPPORTED_LOGO_MIME_TYPES.includes(file.type)) {
    return { ok: false, error: createUnsupportedFormatError(file.type) };
  }

  if (file.size > MAXIMUM_LOGO_SIZE_BYTES) {
    return { ok: false, error: createSizeExceededError(file.size) };
  }

  return { ok: true, file };
}
