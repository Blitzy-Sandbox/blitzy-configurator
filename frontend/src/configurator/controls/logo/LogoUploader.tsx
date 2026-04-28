/**
 * LogoUploader — Logo file picker with allow-list validation (ST-014, ST-017).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/logo/
 *     LogoUploader.tsx | ST-014 file-picker with valid-MIME allow-list".
 *   - ST-014 acceptance criteria:
 *       AC1 — A file-picker affordance accepts standard raster and
 *             vector image formats.
 *       AC2 — A valid uploaded logo appears on the preview ball
 *             without requiring a page reload.
 *       AC3 — The logo persists across rotation, color, pattern, and
 *             finish changes for the lifetime of the current design.
 *       AC4 — The file-picker is reachable and operable using only
 *             keyboard input and is labeled for assistive technology.
 *   - ST-017 acceptance criteria:
 *       AC1 — Uploading an unsupported format is rejected and the
 *             preview is left unchanged.
 *       AC2 — Uploading a file larger than the documented maximum is
 *             rejected and the preview is left unchanged.
 *       AC3 — Every rejection produces a user-facing message that
 *             names the specific reason and the remediation.
 *       AC4 — The rejection message is announced to assistive
 *             technology and does not obscure the 3D preview or
 *             control sidebar.
 *
 * Architecture:
 *   This component owns the validation-error VIEW STATE locally —
 *   it deliberately is NOT tracked in the configurator store because
 *   a transient rejection is not part of a saved design. The store
 *   only knows whether a logo file is staged (`logoFile` slice).
 *
 *   The flow on every file-input change:
 *     1. Read the chosen `File` from the native input.
 *     2. Call `validateFile(file)` (inline allow-list + size check).
 *     3. On success:
 *          a. Clear the local error.
 *          b. Call `setLogoFile(file)` on the store (synchronous).
 *          c. Enqueue a `texturePipeline.update(snapshot)` call so
 *             the logo composites onto the preview ball without a
 *             page reload (ST-014-AC2).
 *     4. On failure:
 *          a. Keep the existing `logoFile` value (the preview is NOT
 *             mutated — ST-017-AC1 / AC2).
 *          b. Store the `LogoValidationError` so `<InvalidFileFeedback>`
 *             renders inline below the picker.
 *          c. Reset the native input's `value` so re-selecting the
 *             same invalid file fires a fresh change event.
 *
 *   Drag-and-drop is intentionally NOT implemented in this component
 *   — ST-014 requires only a file-picker affordance, and the native
 *   `<input type="file">` covers keyboard, touch, mouse, and AT
 *   simultaneously.
 *
 * Texture-pipeline FIFO ordering:
 *   `texturePipeline.update()` is asynchronous (it awaits Fabric's
 *   image decode and a `requestAnimationFrame` barrier before flagging
 *   the Three.js texture dirty per Rule R7 / C6). Two rapid uploads
 *   could otherwise interleave and produce stale pixels on the GPU.
 *   We serialize calls through a `useRef<Promise<void>>` chain — every
 *   handler appends `prev.catch(() => undefined).then(() => texturePipeline.update(snapshot))`
 *   so each submission applies its captured state in submission order.
 *   This mirrors the canonical pattern in
 *   `frontend/src/configurator/controls/colors/useColorSync.ts`.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file calls `texturePipeline.update(...)` —
 *     the SINGLE canonical orchestrator that runs `renderAll()` BEFORE
 *     `threeTexture.needsUpdate = true`. The component does NOT touch
 *     `texture.needsUpdate`, does NOT call into Fabric's namespace,
 *     and does NOT inline any pipeline-internal step.
 *   - Rule R2: ZERO `console.*` calls. Pipeline errors are swallowed
 *     at the chain boundary via `.catch(() => undefined)` so the next
 *     link continues.
 *   - Rule R3: no auth imports.
 *   - AAP §0.4.6: no barrel imports — explicit relative paths only.
 *   - AAP §0.5.2: Zustand selector pattern — NEVER subscribe to the
 *     entire store with bare `useConfiguratorStore()`.
 */

import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';
import { texturePipeline } from '../../texture/texturePipeline';
import {
  InvalidFileFeedback,
  type LogoValidationError,
} from './InvalidFileFeedback';

// ---------------------------------------------------------------------------
// Module-scoped constants — validation
// ---------------------------------------------------------------------------

/**
 * Documented supported MIME types for logo uploads (ST-014-AC1, ST-017-AC1).
 *
 * Standard raster formats: PNG, JPEG, GIF, WebP.
 * Standard vector format: SVG.
 *
 * These are the formats Fabric.js 6 + modern browsers can decode as
 * images and composite onto a Canvas 2D context. Any file whose MIME
 * type is not in this list is rejected with an `'unsupported-format'`
 * error.
 *
 * Order matches the codebase convention established in the existing
 * `logoValidation.ts` constants, so the `accept` attribute string
 * remains stable across implementations.
 */
const SUPPORTED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'image/webp',
] as const;

/**
 * Human-readable list of supported file extensions for the helper text
 * and the remediation message. Tests assert this string contains
 * "PNG", "JPEG", "GIF", "SVG", and "WebP" via case-insensitive regex
 * (ST-017-AC3).
 */
const SUPPORTED_EXTENSIONS_DISPLAY = 'PNG, JPEG, GIF, SVG, WebP';

/**
 * The file-input `accept` attribute string. Restricts the OS file-picker
 * dialog's default filter to images-of-these-types. NOT a security
 * boundary — runtime validation via {@link SUPPORTED_MIME_TYPES} is the
 * authoritative allow-list.
 */
const ACCEPT_ATTR = SUPPORTED_MIME_TYPES.join(',');

/**
 * Documented maximum uploaded file size in bytes (ST-017-AC2).
 *
 * 5 MiB = 5 * 1024 * 1024 = 5,242,880 bytes.
 *
 * Rationale: 5 MiB comfortably accommodates professionally-prepared
 * logo assets (typical 500 KB–2 MB) while rejecting oversized
 * camera/scanner captures that would slow image decode and balloon the
 * canvas texture memory footprint. Users needing larger files can
 * optimize them externally (e.g., compress PNG, convert to WebP).
 */
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Human-readable maximum file size for the helper text and the
 * remediation message. Tests assert this string is "5 MB" via
 * case-insensitive regex (ST-017-AC3).
 */
const MAX_FILE_SIZE_DISPLAY = '5 MB';

// ---------------------------------------------------------------------------
// Module-scoped constants — element identifiers
// ---------------------------------------------------------------------------

/**
 * Stable DOM `id` for the hidden `<input type="file">` element.
 *
 * The id is referenced from the visible `<label htmlFor=...>` so the
 * label-as-trigger pattern works (clicking the label opens the OS
 * file-picker dialog). It is also referenced from the description's
 * `aria-describedby` to associate the helper copy with the input for
 * assistive technology (ST-014-AC4).
 *
 * A static id is safe because `LogoUploader` is mounted exactly once
 * at the App root level. Mounting multiple instances would produce
 * duplicate-id warnings, which is the desired signal that a callsite
 * is misusing the component.
 */
const INPUT_ID = 'logo-uploader-input-element';

/**
 * Stable DOM `id` for the description paragraph. Referenced from the
 * input's `aria-describedby` so screen readers announce the supported
 * formats and size limit when the input receives focus.
 */
const DESCRIPTION_ID = 'logo-uploader-description-text';

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a human-readable megabyte string with one
 * decimal place. Used inside the `'size-exceeded'` error detail.
 *
 * Examples:
 *   formatMegabytes(5_242_880)       === "5.0 MB"
 *   formatMegabytes(8_400_000)       === "8.0 MB"
 *   formatMegabytes(12_500_000)      === "11.9 MB"
 */
function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}

/**
 * Validate an uploaded file against the documented MIME allow-list and
 * maximum size limit (ST-017).
 *
 * Returns `null` when the file is valid. Returns a {@link LogoValidationError}
 * value object describing the failure when the file is invalid.
 *
 * Validation order:
 *   1. MIME type check FIRST — unsupported formats are a hard reject
 *      regardless of size (a 10 KB EXE file still fails format before
 *      size).
 *   2. Size check SECOND — only meaningful when the format is
 *      supported.
 *
 * The `detail` field includes the actual observed value (the MIME
 * type, or the file size in megabytes) so the user can recognize
 * their input and the rejection feedback (`InvalidFileFeedback`) can
 * surface it in its body paragraph (ST-017-AC3).
 *
 * The optional `supportedFormats` and `maximumSize` fields supply the
 * remediation context that `InvalidFileFeedback`'s `buildRemediation`
 * helper consumes — when present, the rendered remediation text
 * names the documented constraints by value.
 */
function validateFile(file: File): LogoValidationError | null {
  if (!SUPPORTED_MIME_TYPES.includes(file.type)) {
    const observedType = file.type !== '' ? file.type : 'unknown';
    return {
      reason: 'unsupported-format',
      detail: `The file you selected has type "${observedType}", which is not a supported logo format.`,
      supportedFormats: SUPPORTED_EXTENSIONS_DISPLAY,
    };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      reason: 'size-exceeded',
      detail: `The file you selected is ${formatMegabytes(file.size)}, which exceeds the ${MAX_FILE_SIZE_DISPLAY} limit.`,
      maximumSize: MAX_FILE_SIZE_DISPLAY,
    };
  }
  return null;
}

/**
 * Format the `logoFile` slice's currently-staged value for display in
 * the filename row.
 *
 * The store accepts either:
 *   - a `File` object (fresh upload from the file-picker),
 *   - a `string` URL or data URI (loaded from a previously-saved
 *     design, where the server-side store hands us back a URL rather
 *     than a `File`), or
 *   - `null` (no logo selected).
 *
 * In each case we render a deterministic short label so the visual UI
 * communicates the slice's state without leaking implementation detail.
 *
 * The exact strings ("No logo selected.", "Saved logo from your design.",
 * the file's `name`) are part of the test contract — Playwright tests
 * assert them via `toHaveText`.
 */
function describeStagedLogo(value: File | string | null): string {
  if (value === null) return 'No logo selected.';
  if (typeof value === 'string') return 'Saved logo from your design.';
  return value.name;
}

// ---------------------------------------------------------------------------
// Module-private style constants
// ---------------------------------------------------------------------------

/**
 * Outer section style.
 *
 * Brand surface (#FFFFFF) with the documented neutral border (#D9D9D9)
 * and the codebase's standard 0.375rem corner radius. Padding is
 * 0.875rem on all sides, matching the spacing rhythm used by the
 * sibling pattern selector.
 */
const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.875rem',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  backgroundColor: '#FFFFFF',
};

/** Section heading style — matches sibling controls' visual weight. */
const HEADING_STYLE: CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#333333',
  margin: 0,
};

/** Description paragraph style — secondary helper copy. */
const DESCRIPTION_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  color: '#666666',
  lineHeight: 1.4,
  margin: 0,
};

/**
 * Inner uploader container — vertical stack holding the field row,
 * filename row, and remove button.
 */
const UPLOADER_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

/**
 * Field row — wraps the visually-hidden file input and the
 * label-as-trigger so they live in the same flex/positioning context.
 */
const UPLOADER_FIELD_STYLE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

/**
 * The visually-hidden pattern (`clip: rect(0,0,0,0)`) keeps the input
 * out of the viewport while leaving it focusable and operable as a
 * keyboard fallback (ST-014-AC4). The associated `<label>` carries
 * the visible affordance.
 */
const HIDDEN_INPUT_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * Visible label-as-trigger style. Brand purple (#5B39F3) on white
 * text, behaves as a primary CTA button. The `cursor: 'pointer'`
 * communicates clickability for sighted mouse users; keyboard users
 * activate via Tab → Enter on the underlying input.
 */
const UPLOADER_LABEL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.5rem 0.875rem',
  borderRadius: '0.375rem',
  border: '1px solid #5B39F3',
  backgroundColor: '#5B39F3',
  color: '#FFFFFF',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

/**
 * Filename row — tinted brand surface (#F4EFF6) housing the staged
 * file's name. The `aria-live="polite"` on the rendered element will
 * announce filename changes without interrupting other speech.
 */
const UPLOADER_FILENAME_STYLE: CSSProperties = {
  fontSize: '0.8125rem',
  color: '#333333',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.25rem',
  backgroundColor: '#F4EFF6',
  margin: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/**
 * Remove-logo button style — secondary action with brand-dark
 * (#2D1C77) outline-only treatment so it does not compete with the
 * primary upload CTA.
 */
const UPLOADER_CLEAR_BUTTON_STYLE: CSSProperties = {
  padding: '0.375rem 0.75rem',
  borderRadius: '0.25rem',
  border: '1px solid #2D1C77',
  backgroundColor: 'transparent',
  color: '#2D1C77',
  fontSize: '0.8125rem',
  fontWeight: 500,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The logo uploader — file-picker affordance + invalid-file feedback.
 *
 * Public contract:
 *   - Renders the `<section data-testid="logo-uploader">` container.
 *   - Subscribes to the `logoFile` slice via a Zustand selector.
 *   - On valid upload: writes to the store via `setLogoFile`, then
 *     enqueues a serialized `texturePipeline.update()` call so the
 *     preview ball reflects the new logo without a page reload.
 *   - On invalid upload: stores the validation error in local state
 *     and renders `<InvalidFileFeedback>` inline below the picker,
 *     leaving the preview unchanged.
 *   - On remove: clears `logoFile`, clears the validation error, and
 *     enqueues a pipeline update so the preview returns to its
 *     no-logo state.
 *
 * The component does NOT accept props — its data flow is entirely
 * via the global Zustand store, matching the convention established
 * by the sibling pattern and color selectors.
 *
 * @returns The rendered React element.
 */
export function LogoUploader() {
  // ----- Store subscriptions: SLICE-only selectors per Zustand best practice
  //
  // Subscribing to `logoFile` re-renders the component when the slice
  // changes (e.g., a saved design is loaded into the store). The
  // setter is also subscribed via a selector so the function identity
  // is stable across renders.
  const logoFile = useConfiguratorStore((s) => s.logoFile);
  const setLogoFile = useConfiguratorStore((s) => s.setLogoFile);

  // ----- Local view-layer state -------------------------------------------
  //
  // Validation errors are NOT part of the saved design — they are a
  // transient view-layer concern tied to THIS component's upload
  // interaction. Storing them locally keeps the global store narrow
  // and prevents the error from leaking into other surfaces (e.g.,
  // the design-summary sidebar) that have no use for it.
  const [validationError, setValidationError] = useState<LogoValidationError | null>(null);

  // ----- Refs --------------------------------------------------------------
  //
  // `fileInputRef` lets us imperatively clear the input's `value`
  // after a rejection so re-selecting the same invalid file fires a
  // fresh change event (browsers skip "no change" events otherwise).
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // `pipelineQueueRef` serializes asynchronous `texturePipeline.update`
  // calls in submission order. The leading `Promise.resolve()` lets
  // the first appended `.then(...)` run via microtask immediately
  // after the current React commit phase.
  const pipelineQueueRef = useRef<Promise<void>>(Promise.resolve());

  // ----- Pipeline enqueue helper ------------------------------------------
  //
  // Snapshot the FULL store state at submission time (mirrors the
  // canonical pattern in `useColorSync.ts`). The texture pipeline
  // applies all current configurator state to Fabric on each call,
  // so we always pass the entire snapshot — even though we only
  // enqueue from logo-related events here.
  //
  // The leading `.catch(() => undefined)` converts any prior
  // rejection into a resolved void, preventing chain deadlock — a
  // failed pipeline call must not poison every subsequent update.
  const enqueuePipelineUpdate = useCallback(() => {
    const snapshot = useConfiguratorStore.getState();
    pipelineQueueRef.current = pipelineQueueRef.current
      .catch(() => undefined)
      .then(() => texturePipeline.update(snapshot));
  }, []);

  // ----- File-input change handler ----------------------------------------
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files === null || files.length === 0) {
        // User opened then dismissed the picker; do nothing.
        return;
      }

      const candidate = files[0];
      if (candidate === undefined) {
        // Defensive: `FileList[0]` is only `undefined` on engines
        // without numeric index access, but TypeScript's lib types
        // permit it.
        return;
      }

      const error = validateFile(candidate);

      if (error === null) {
        // Valid file: clear any prior error, write to the store, and
        // schedule a preview refresh.
        setValidationError(null);
        setLogoFile(candidate);
        enqueuePipelineUpdate();
      } else {
        // Invalid file: store the error so `<InvalidFileFeedback>`
        // renders the alert. Do NOT call `setLogoFile` — the preview
        // remains unchanged (ST-017-AC1 / AC2).
        setValidationError(error);
        // Reset the input so a repeat selection of the same invalid
        // file fires a fresh change event and keeps the alert
        // synchronized with user action.
        if (fileInputRef.current !== null) {
          fileInputRef.current.value = '';
        }
      }
    },
    [setLogoFile, enqueuePipelineUpdate],
  );

  // ----- Remove-logo handler ----------------------------------------------
  const handleClear = useCallback(() => {
    setValidationError(null);
    setLogoFile(null);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = '';
    }
    // Refresh the preview so the ball returns to its no-logo state.
    enqueuePipelineUpdate();
  }, [setLogoFile, enqueuePipelineUpdate]);

  // ----- Derived display values -------------------------------------------
  const stagedDescription = describeStagedLogo(logoFile);
  const hasStagedLogo = logoFile !== null;

  // ----- Render -----------------------------------------------------------
  return (
    <section
      style={SECTION_STYLE}
      aria-label="Logo upload"
      data-testid="logo-uploader"
    >
      <h3 style={HEADING_STYLE}>Logo upload</h3>
      <p
        id={DESCRIPTION_ID}
        style={DESCRIPTION_STYLE}
        data-testid="logo-uploader-description"
      >
        Accepted: {SUPPORTED_EXTENSIONS_DISPLAY}. Maximum size: {MAX_FILE_SIZE_DISPLAY}.
      </p>

      <div style={UPLOADER_STYLE}>
        <div style={UPLOADER_FIELD_STYLE}>
          <input
            ref={fileInputRef}
            id={INPUT_ID}
            type="file"
            accept={ACCEPT_ATTR}
            aria-describedby={DESCRIPTION_ID}
            aria-label="Choose a logo image to upload"
            data-testid="logo-uploader-input"
            style={HIDDEN_INPUT_STYLE}
            onChange={handleChange}
          />
          <label
            htmlFor={INPUT_ID}
            style={UPLOADER_LABEL_STYLE}
            data-testid="logo-uploader-label"
          >
            {hasStagedLogo ? 'Replace logo' : 'Choose a logo image'}
          </label>
        </div>

        <p
          style={UPLOADER_FILENAME_STYLE}
          aria-live="polite"
          data-testid="logo-uploader-filename"
          data-has-logo={hasStagedLogo ? 'true' : 'false'}
        >
          {stagedDescription}
        </p>

        {hasStagedLogo ? (
          <button
            type="button"
            style={UPLOADER_CLEAR_BUTTON_STYLE}
            onClick={handleClear}
            data-testid="logo-uploader-clear"
          >
            Remove logo
          </button>
        ) : null}
      </div>

      {/*
       * `<InvalidFileFeedback>` is the documented sole consumer of
       * `LogoValidationError`. It returns `null` from React when
       * `error === null`, so we render it unconditionally — there is
       * no need for a truthy wrapper. The default `data-testid` is
       * `'invalid-file-feedback'` (per the test contract).
       */}
      <InvalidFileFeedback error={validationError} />
    </section>
  );
}
