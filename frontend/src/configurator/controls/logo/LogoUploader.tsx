/**
 * LogoUploader — Logo file picker with allow-list validation (ST-014,
 * ST-017).
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/controls/logo/
 *     LogoUploader.tsx | ST-014 file-picker with valid-MIME allow-list".
 *   - ST-014 acceptance criteria: a designer can pick a logo image
 *     from the file system; supported MIME types and a maximum file
 *     size are enforced; the file is staged for placement on the
 *     ball.
 *   - ST-017 acceptance criteria: rejected uploads emit a user-facing
 *     message with reason and remediation; the message is announced
 *     to assistive technology.
 *   - QA Report Issues #9 and #11 — `LogoUploader.tsx` MUST exist,
 *     MUST be the documented sole consumer of `<InvalidFileFeedback>`,
 *     and MUST construct a `LogoValidationError` value object on
 *     failure.
 *
 * Architecture:
 *   This component owns the validation-error VIEW STATE locally —
 *   it deliberately is NOT tracked in the configurator store because
 *   a transient rejection is not part of a saved design. The store
 *   only knows whether a logo file is staged (`logoFile` slice).
 *
 *   Validation logic lives in `./logoValidation.ts`. The uploader
 *   merely:
 *     1. Reads the chosen `File` from the native input.
 *     2. Calls `validateLogoFile(file)`.
 *     3. On success: clears the local error and calls
 *        `setLogoFile(file)` on the store.
 *     4. On failure: keeps the existing `logoFile` value (the
 *        preview is NOT mutated — ST-017-AC1 / AC2) and stores the
 *        `LogoValidationError` so `<InvalidFileFeedback>` renders.
 *
 *   Drag-and-drop is intentionally NOT implemented in this component
 *   — ST-014 requires only a file-picker affordance, and the native
 *   `<input type="file">` covers keyboard, touch, mouse, and AT
 *   simultaneously. A future ST-018 enhancement can layer drag-drop
 *   on top without changing this contract.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate`. Verifiable
 *     via `grep -n "texturePipeline\|needsUpdate" LogoUploader.tsx`
 *     returning zero matches.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no auth imports.
 */

import { useId, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';

import { useConfiguratorStore } from '../../../state/configuratorStore';

import { InvalidFileFeedback } from './InvalidFileFeedback';
import type { LogoValidationError } from './InvalidFileFeedback';
import {
  SUPPORTED_LOGO_ACCEPT_ATTRIBUTE,
  SUPPORTED_LOGO_FORMAT_LABELS,
  MAXIMUM_LOGO_SIZE_LABEL,
  validateLogoFile,
} from './logoValidation';
import styles from './logo.module.css';

/**
 * Props are intentionally empty — this component owns its own data via
 * the configurator store. Future stories (e.g., drag-and-drop overlay)
 * can extend this interface.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface LogoUploaderProps {}

/**
 * Format the logoFile slice's currently-staged value for display.
 *
 * The store accepts either a `File` (newly uploaded) or a `string`
 * (a previously-saved URL or data URI when a saved design is loaded);
 * in both cases we render a deterministic short label.
 */
function describeStagedLogo(value: File | string | null): string {
  if (value === null) return 'No logo selected.';
  if (typeof value === 'string') return 'Saved logo from your design.';
  return value.name;
}

/**
 * The logo uploader — file-picker affordance + invalid-file feedback.
 */
export function LogoUploader(_props: LogoUploaderProps = {}): JSX.Element {
  const logoFile = useConfiguratorStore((s) => s.logoFile);
  const setLogoFile = useConfiguratorStore((s) => s.setLogoFile);

  // Local view-layer-only state for the most-recent rejection. Reset
  // to `null` when the next upload succeeds.
  const [error, setError] = useState<LogoValidationError | null>(null);

  // Stable element ids for label / input pairing and for the
  // descriptive copy beside the input.
  const inputId = useId();
  const descriptionId = `${inputId}-description`;

  // Ref to the underlying input so we can clear its `value` after a
  // rejection. Without this, selecting the same invalid file twice
  // would not retrigger the change event and the user could not see
  // the rejection re-announced.
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files;
    if (files === null || files.length === 0) {
      // User opened then dismissed the picker; do nothing.
      return;
    }

    const candidate = files[0];
    if (candidate === undefined) {
      // Defensive: FileList[0] is only `undefined` on engines without
      // index access, but the type still permits it.
      return;
    }

    const result = validateLogoFile(candidate);

    if (result.ok) {
      setError(null);
      setLogoFile(result.file);
    } else {
      setError(result.error);
      // Reset the input so a repeat selection of the same invalid
      // file fires a fresh change event and keeps the alert
      // synchronized with user action.
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
    }
  }

  function handleClear(): void {
    setError(null);
    setLogoFile(null);
    if (inputRef.current !== null) {
      inputRef.current.value = '';
    }
  }

  const stagedDescription = describeStagedLogo(logoFile);
  const hasStagedLogo = logoFile !== null;

  return (
    <section className={styles.section} aria-label="Logo upload" data-testid="logo-uploader">
      <h3 className={styles.section__heading}>Logo upload</h3>
      <p
        id={descriptionId}
        className={styles.section__hint}
        data-testid="logo-uploader-description"
      >
        Accepted: {SUPPORTED_LOGO_FORMAT_LABELS}. Maximum size: {MAXIMUM_LOGO_SIZE_LABEL}.
      </p>

      <div className={styles.uploader}>
        <div className={styles.uploader__field}>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={SUPPORTED_LOGO_ACCEPT_ATTRIBUTE}
            aria-describedby={descriptionId}
            aria-label="Choose a logo image to upload"
            data-testid="logo-uploader-input"
            className={styles.uploader__input}
            onChange={handleChange}
          />
          <label
            htmlFor={inputId}
            className={styles.uploader__label}
            data-testid="logo-uploader-label"
          >
            {hasStagedLogo ? 'Replace logo' : 'Choose a logo image'}
          </label>
        </div>

        <p
          className={styles.uploader__filename}
          aria-live="polite"
          data-testid="logo-uploader-filename"
          data-has-logo={hasStagedLogo ? 'true' : 'false'}
        >
          {stagedDescription}
        </p>

        {hasStagedLogo ? (
          <button
            type="button"
            className={styles.uploader__clearButton}
            onClick={handleClear}
            data-testid="logo-uploader-clear"
          >
            Remove logo
          </button>
        ) : null}
      </div>

      {/*
       * The InvalidFileFeedback component is the documented sole
       * consumer of `LogoValidationError`. Passing `null` is safe —
       * the component returns `null` from React when no error is
       * present, so we render it unconditionally.
       *
       * This is the wiring that resolves QA Issue #11 (dead-code
       * ST-017 component).
       */}
      <InvalidFileFeedback error={error} />
    </section>
  );
}
