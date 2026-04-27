/**
 * SaveDesignCta — Save Design call-to-action component (ST-018).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 / §0.6.9 (Merge Gate 1, Step F — Design Management
 *     Integration):
 *       CREATE | frontend/src/features/design-management/SaveDesignCta.tsx
 *       | ST-018 calls live POST /api/designs; success/failure states.
 *
 *   - AAP §0.6.14 ("User Interface Design"):
 *       The Design Summary Sidebar HOSTS the Save Design and Add-to-Cart
 *       CTA anchors per ST-022-AC5. This component is rendered INSIDE the
 *       canonical DesignSummarySidebar component as an inline anchor.
 *
 *   - User stories — every acceptance criterion is addressed by the
 *     implementation below; the docstring on each subsection cites the
 *     specific AC it satisfies.
 *
 *       ST-018-AC1: "Whenever the design has unsaved changes and the user
 *           is authenticated, the Save Design CTA is visible and active."
 *           → Button is disabled when `isSaved === true` (no unsaved
 *             changes); active otherwise.
 *
 *       ST-018-AC2: "Activating the Save Design CTA sends the current
 *           design selections to the persistence service and the user
 *           sees a success indicator on completion."
 *           → onClick handler calls createDesign(); on resolve, the
 *             component transitions to 'success' state and renders a
 *             success banner including the saved design's identifier.
 *
 *       ST-018-AC3: "If persistence fails or the user is not
 *           authenticated, the user sees an actionable failure message
 *           naming the reason and the next step they can take."
 *           → Errors are caught in the onClick handler; ApiError is
 *             narrowed by status code (401, 400, 404, 5xx) and a
 *             hard-coded actionable message is rendered. Network /
 *             abort failures use a generic actionable copy.
 *
 *       ST-018-AC4: "After saving, repeated activations of the CTA are
 *           idempotent until the user changes the design again."
 *           → After a successful save, the store action `markSaved()`
 *             flips `isSaved=true`, which disables the button. Any
 *             subsequent slice change automatically flips `isSaved=false`
 *             (the store's setters do this) so the button re-enables.
 *
 *       ST-027-AC1 .. ST-027-AC4 (backend counterpart): the request body
 *           sent here mirrors the canonical CreateDesignInput shape
 *           accepted by /api/designs (POST). Field validation is
 *           server-authoritative; this component does NOT duplicate the
 *           backend's Zod rules.
 *
 * ============================================================================
 * Cross-cutting rules enforced
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. ALL
 *     user-visible error copy is hard-coded by HTTP status code; never
 *     `error.message` or `error.body`. The server-supplied error body is
 *     not rendered, logged, or re-thrown.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): this component does
 *     NOT decode, parse, or inspect the Firebase ID token. Token
 *     attachment is delegated to `request()` in `../../api/client` which
 *     forwards the raw token to the backend; the backend's session
 *     middleware calls `admin.auth().verifyIdToken()` as the SOLE
 *     authority on validity (AAP C2).
 *
 *   - Rule R9 (no payment processing): the Save action is design
 *     persistence ONLY. NO references to checkout, payment, charge,
 *     intent, settle, or tokenize.
 *
 *   - C5 (correlation ID propagation): every outbound request issued by
 *     this component automatically receives an X-Correlation-Id header
 *     generated inside the `request()` helper. This component does NOT
 *     manage correlation IDs directly.
 *
 *   - C6 / R7 (Fabric.js render before texture update): Save is a
 *     persistence action; it does NOT touch the texture pipeline. After
 *     a successful save the store updates `isSaved=true` but no slice
 *     value changes, so no re-render of the 3D preview is triggered.
 *
 * ============================================================================
 * Cross-layer logo shape contract (QA Issue #12 fix)
 * ============================================================================
 *
 *   The backend's Zod `logoSchema` requires the FLAT shape:
 *     { objectKey: string; offsetX?, offsetY?, scale?, rotation? }
 *
 *   The configurator store holds a different INTERNAL shape:
 *     - logoFile: File | string | null
 *     - logoPosition: { x: number; y: number }
 *     - logoScale: number
 *
 *   This component is the SINGLE place that maps store → wire:
 *
 *     CASE 1: logoFile === null
 *       → send `logo: null` in the payload.
 *
 *     CASE 2: typeof logoFile === 'string'
 *       (a previously-uploaded GCS object key OR a remote URL loaded
 *        from a saved design)
 *       → send `logo: { objectKey: logoFile,
 *                       offsetX: logoPosition.x,
 *                       offsetY: logoPosition.y,
 *                       scale: logoScale,
 *                       rotation: 0 }`
 *       Note: store `logoPosition.x/y` map directly to wire
 *       `offsetX/offsetY`. The store uses panel-space coordinates and
 *       the backend treats the wire values as opaque numerics, so the
 *       mapping is value-preserving.
 *
 *     CASE 3: logoFile instanceof File
 *       (the user just uploaded a logo via LogoUploader.tsx but the
 *        upload pipeline that converts the browser File to a GCS object
 *        key is OUT OF SCOPE for MG1-F per AAP §0.6.9)
 *       → CANNOT save with logo. The Save button is DISABLED with an
 *         explanatory help text. The user can:
 *           (a) remove the logo and save without it, or
 *           (b) wait for a future MG release that wires the upload pipe.
 *       This degraded state is communicated through the disabled-state
 *       tooltip and visually-hidden help text (WCAG sr-only pattern).
 *
 * ============================================================================
 * What this component does NOT do
 * ============================================================================
 *
 *   - Logo upload: if logoFile is a raw File, this component disables
 *     itself with explanatory copy. The upload pipeline is a separate
 *     concern.
 *   - Title authoring UX: the canonical UX is "click Save → modal /
 *     inline input for title → submit". This component implements an
 *     inline input that appears when the button is clicked while there
 *     is no working title; on Enter or Submit the input value is sent.
 *     The default title `'My Design'` is used if the user submits an
 *     empty input — the backend rejects empty titles per ST-027-AC3 so
 *     this is also a defensive UX measure.
 *   - Optimistic UI: `markSaved()` is called only AFTER the server
 *     responds with a success body. A lost network request leaves
 *     `isSaved=false` so the user can retry without an inconsistent
 *     state.
 *   - Retry-on-failure: the user clicks Save again to retry. The error
 *     banner has a Dismiss button that returns the component to 'idle'.
 *   - Sign-in flow: a 401 response surfaces "your session has expired"
 *     copy; the actual sign-in form lives elsewhere and is reached
 *     through the AppHeader's auth controls (out of scope here).
 *
 * ============================================================================
 * Test contract
 * ============================================================================
 *
 *   The Playwright e2e suite (frontend/tests/e2e/save-design.spec.ts,
 *   authored at MG2-H per ST-045) targets the following stable hooks:
 *
 *     - `data-testid="save-design-cta"`         — the outer <section> wrapper
 *     - `data-testid="save-design-button"`      — the primary save button
 *     - `data-testid="save-design-title-input"` — the inline title input
 *                                                  (visible during request)
 *     - `data-testid="save-design-success"`     — success banner
 *     - `data-testid="save-design-success-id"`  — saved design id
 *                                                  (in data-design-id attr)
 *     - `data-testid="save-design-error"`       — error banner
 *     - `data-testid="save-design-error-dismiss"` — dismiss-error button
 *     - `data-testid="save-design-disabled-help"` — sr-only help (when disabled)
 *
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';

import { ApiError } from '../../api/client';
import { createDesign } from '../../api/designs';
import type { CreateDesignInput, Design, DesignLogo, DesignPayload } from '../../api/designs';
import { useConfiguratorStore } from '../../state/configuratorStore';

// ============================================================================
// Local types
// ============================================================================

/**
 * Lifecycle of the Save action exposed to the component as React state.
 *
 *   - 'idle'         — no request in flight; the primary button is
 *                       enabled iff there are unsaved changes AND the
 *                       logo is in a serializable state.
 *   - 'naming'       — the user clicked Save; the inline title input is
 *                       visible and the request has NOT been issued yet.
 *   - 'requesting'   — POST /api/designs is in flight; both the button
 *                       and the title input are disabled to prevent
 *                       double-submit.
 *   - 'success'      — server returned a Design; success banner is
 *                       shown until the user dismisses or the design
 *                       changes again.
 *   - 'error'        — request failed; error banner is shown with
 *                       hard-coded actionable copy keyed by HTTP status.
 */
type SaveActionState = 'idle' | 'naming' | 'requesting' | 'success' | 'error';

/**
 * Reasons the Save button may be disabled while the design has unsaved
 * changes. Drives the disabled-state tooltip / sr-only help text so the
 * user understands WHY they cannot save.
 *
 *   - 'already-saved'      — no unsaved changes (ST-018-AC4 idempotence).
 *   - 'logo-pending-upload' — the user uploaded a raw File that has not
 *                             yet been pushed through the GCS upload
 *                             pipeline. Out of scope for MG1-F.
 *   - 'request-in-flight'   — a POST is already running; the button is
 *                             disabled to prevent double-submit.
 *   - null (enabled)        — the button is enabled.
 */
type SaveDisabledReason = 'already-saved' | 'logo-pending-upload' | 'request-in-flight' | null;

// ============================================================================
// Module-scope helpers
// ============================================================================

/**
 * Build a {@link DesignLogo} | null from the configurator store's logo
 * slice values. Returns:
 *
 *   - `null` when `logoFile` is `null` (no logo applied).
 *   - A flat {@link DesignLogo} matching the backend's Zod schema when
 *     `logoFile` is a string (a GCS object key or a remote URL from a
 *     loaded design).
 *
 * Throws never; the File-pending-upload case is handled at the gate
 * level via {@link computeDisabledReason} so this helper is invoked only
 * when the wire shape is constructible.
 *
 * Cross-layer contract (QA Issue #12 fix): the store's `logoPosition.x/y`
 * map directly to the backend's `offsetX/offsetY`. Both are unbounded
 * finite numbers in panel space; the backend stores them verbatim.
 *
 * @param logoFile - The raw store logo source.
 * @param logoPosition - The store's normalized panel-space position.
 * @param logoScale - The store's scale multiplier (1.0 = native size).
 * @returns A {@link DesignLogo} for the wire format, or null.
 */
function buildLogoForWire(
  logoFile: string | null,
  logoPosition: { x: number; y: number },
  logoScale: number,
): DesignLogo | null {
  if (logoFile === null) {
    return null;
  }
  return {
    objectKey: logoFile,
    offsetX: logoPosition.x,
    offsetY: logoPosition.y,
    scale: logoScale,
    rotation: 0,
  };
}

/**
 * Determine whether the Save button is disabled and, if so, the reason.
 *
 * Order of precedence (most-specific first):
 *
 *   1. 'request-in-flight' — a POST is currently running (transient,
 *      cleared on resolve/reject).
 *   2. 'logo-pending-upload' — the store holds a raw File that has not
 *      been uploaded yet. Out of scope for MG1-F per AAP §0.6.9.
 *   3. 'already-saved' — `isSaved === true` (no unsaved changes per
 *      ST-018-AC1 / ST-018-AC4).
 *   4. null (enabled) — there are unsaved changes AND the logo is in a
 *      serializable shape.
 *
 * @param actionState - Current save lifecycle state.
 * @param isSaved - The store's `isSaved` flag.
 * @param logoFile - The store's logo slice value.
 * @returns The reason the button is disabled, or null when enabled.
 */
function computeDisabledReason(
  actionState: SaveActionState,
  isSaved: boolean,
  logoFile: File | string | null,
): SaveDisabledReason {
  if (actionState === 'requesting') {
    return 'request-in-flight';
  }
  if (logoFile instanceof File) {
    return 'logo-pending-upload';
  }
  if (isSaved) {
    return 'already-saved';
  }
  return null;
}

/**
 * The default title used when the user submits the inline title input
 * empty. The backend rejects empty titles with HTTP 400 per ST-027-AC3,
 * so this default is BOTH a UX courtesy and a defensive measure that
 * keeps the success path navigable for users who don't read every label.
 */
const DEFAULT_DESIGN_TITLE = 'My Design';

// ============================================================================
// Component
// ============================================================================

/**
 * The Save Design CTA.
 *
 * Subscribes via individual Zustand selectors to every store slice it
 * needs. Each selector subscribes to ONLY that slice; unrelated changes
 * (e.g., a color sweep in the control sidebar) do NOT re-render this
 * component. This is important for ST-005's ≥30 FPS interactive budget.
 *
 * The component is intentionally kept simple — no useMemo, no React.memo
 * — because the selector subscriptions provide all the granularity.
 *
 * @returns A JSX element representing the Save Design CTA.
 */
export function SaveDesignCta(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions — one selector per slice for fine-grained reactivity.
  // -------------------------------------------------------------------------
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);
  const logoFile = useConfiguratorStore((s) => s.logoFile);
  const logoPosition = useConfiguratorStore((s) => s.logoPosition);
  const logoScale = useConfiguratorStore((s) => s.logoScale);
  const isSaved = useConfiguratorStore((s) => s.isSaved);
  const markSaved = useConfiguratorStore((s) => s.markSaved);

  // -------------------------------------------------------------------------
  // Local React state — owns the request lifecycle and the inline title input.
  // -------------------------------------------------------------------------
  const [actionState, setActionState] = useState<SaveActionState>('idle');
  const [titleInput, setTitleInput] = useState<string>(DEFAULT_DESIGN_TITLE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedDesignDisplay, setSavedDesignDisplay] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // -------------------------------------------------------------------------
  // Refs for focus management
  // -------------------------------------------------------------------------

  /**
   * Ref to the title input. Used to focus the input PROGRAMMATICALLY
   * when the form opens (state transitions from 'idle' to 'naming').
   *
   * Why programmatic instead of `autoFocus`: the jsx-a11y/no-autofocus
   * rule warns against `autoFocus` because it can disrupt screen
   * reader users who haven't reached the input yet via their normal
   * navigation. Programmatic focus is OK in this case because:
   *   - The input is rendered in response to a user action (clicking
   *     the Save button) — focus belongs with the form they just
   *     opened.
   *   - The user EXPECTED a control to appear; moving focus there is
   *     consistent with their mental model.
   *   - Without focus, the user would have to tab from the Save
   *     button to find the input — extra friction for keyboard users.
   */
  const titleInputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // Derived values — recomputed each render; cheap and references stable.
  // -------------------------------------------------------------------------
  const disabledReason = computeDisabledReason(actionState, isSaved, logoFile);
  const isButtonEnabled = disabledReason === null && actionState !== 'naming';

  // -------------------------------------------------------------------------
  // Effect: focus the title input when the form opens.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (actionState === 'naming') {
      // requestAnimationFrame defers focus to the next paint, after
      // the input has been mounted by the conditional render below.
      const id = requestAnimationFrame(() => {
        titleInputRef.current?.focus();
        // Select the default title so the user can immediately type
        // their own without manually clearing the placeholder text.
        titleInputRef.current?.select();
      });
      return (): void => {
        cancelAnimationFrame(id);
      };
    }
    return undefined;
  }, [actionState]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * onClick for the primary Save button. Transitions 'idle' → 'naming'
   * to surface the inline title input. The actual POST is deferred to
   * the form submit handler so the user has a chance to change the
   * title before the request is issued.
   *
   * Defense-in-depth: if `disabledReason` is non-null, no-op. The
   * button's `disabled` attribute should already prevent invocation,
   * but assistive technology and rapid clicks during state transitions
   * can sometimes bypass it.
   */
  const handlePrimaryClick = useCallback(() => {
    if (disabledReason !== null) {
      return;
    }
    // Reset any prior success/error feedback so the user gets a clean
    // canvas for the new save attempt.
    setErrorMessage(null);
    setSavedDesignDisplay(null);
    setActionState('naming');
  }, [disabledReason]);

  /**
   * onChange for the inline title input. Bounded by user typing speed;
   * no debouncing needed.
   */
  const handleTitleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitleInput(event.target.value);
  }, []);

  /**
   * onSubmit for the inline form. Builds the wire payload, calls
   * `createDesign()`, and updates state based on the outcome.
   *
   * Error handling (Rule R2): on rejection we NEVER render
   * `error.message`, `error.body`, or any server-supplied string.
   * Hard-coded actionable copy is keyed by HTTP status code:
   *
   *   - 401 → "Your session has expired. Please sign in again to save
   *           this design."
   *   - 400 → "This design could not be saved because some details are
   *           invalid. Adjust your selections and try again."
   *   - 5xx → "The save service is temporarily unavailable. Please try
   *           again in a moment."
   *   - other 4xx (403, 409, etc.) → generic actionable copy.
   *   - non-ApiError (network, abort) → connectivity-focused copy.
   */
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      // Defensive: cannot submit if button is disabled OR an error
      // sneaked the form open without a valid logo state. Bail.
      if (logoFile instanceof File) {
        return;
      }

      // Reset feedback for a retry attempt.
      setActionState('requesting');
      setErrorMessage(null);

      // Title fallback — empty string becomes the default (per ST-027
      // backend rejects empty; we default to keep the happy path open).
      const trimmedTitle = titleInput.trim();
      const titleToSend = trimmedTitle.length > 0 ? trimmedTitle : DEFAULT_DESIGN_TITLE;

      // Build the wire payload. Maps store internal logo shape to the
      // backend's flat logoSchema shape per QA Issue #12 fix.
      const payload: DesignPayload = {
        primaryColor,
        secondaryColor,
        accentColor,
        pattern: stitchingPattern,
        finish: materialFinish,
        logo: buildLogoForWire(logoFile, logoPosition, logoScale),
      };
      const input: CreateDesignInput = {
        title: titleToSend,
        payload,
      };

      try {
        const created: Design = await createDesign(input);
        // Server-authoritative success: flip the store's saved state
        // and capture the canonical record for the success banner.
        markSaved(created.id);
        setSavedDesignDisplay({ id: created.id, title: created.title });
        setActionState('success');
      } catch (error: unknown) {
        // Branch on the error type and HTTP status; render hard-coded
        // copy ONLY (Rule R2). Server-supplied strings are NOT rendered.
        setActionState('error');
        if (error instanceof ApiError) {
          if (error.status === 401) {
            setErrorMessage(
              'Your session has expired. Please sign in again to save this design.',
            );
          } else if (error.status === 400) {
            setErrorMessage(
              'This design could not be saved because some details are invalid. ' +
                'Adjust your selections and try again.',
            );
          } else if (error.status === 404) {
            setErrorMessage(
              'The design service could not be reached. Please refresh the page and try again.',
            );
          } else if (error.status >= 500) {
            setErrorMessage(
              'The save service is temporarily unavailable. Please try again in a moment.',
            );
          } else {
            // Catch-all for other 4xx (403 forbidden, 409 conflict, etc.).
            setErrorMessage(
              'This design could not be saved. Please try again; if the problem ' +
                'persists, refresh the page.',
            );
          }
        } else {
          // Network failure, AbortError, JSON parse failure, etc.
          setErrorMessage(
            'This design could not be saved due to a network issue. ' +
              'Please check your connection and try again.',
          );
        }
      }
    },
    [
      logoFile,
      logoPosition,
      logoScale,
      markSaved,
      materialFinish,
      primaryColor,
      secondaryColor,
      accentColor,
      stitchingPattern,
      titleInput,
    ],
  );

  /**
   * Cancel the inline title input — return to 'idle' without sending a
   * request. The user typically reaches this via the Cancel button or
   * by pressing Escape (handled in onKeyDown on the input).
   */
  const handleCancel = useCallback(() => {
    setActionState('idle');
  }, []);

  /**
   * Dismiss success or error feedback. Returns to 'idle' and re-enables
   * (or keeps disabled if isSaved became true again) the primary button.
   */
  const handleDismissFeedback = useCallback(() => {
    setActionState('idle');
    setErrorMessage(null);
    setSavedDesignDisplay(null);
  }, []);

  // -------------------------------------------------------------------------
  // Inline styles — co-located so the component remains self-contained.
  // -------------------------------------------------------------------------

  /** Style for the primary Save button. */
  const primaryButtonStyle: React.CSSProperties = {
    padding: '0.625rem 1rem',
    backgroundColor: isButtonEnabled ? '#5B39F3' : '#D9D9D9',
    color: isButtonEnabled ? '#FFFFFF' : '#999999',
    border: 'none',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: isButtonEnabled ? 'pointer' : 'not-allowed',
    width: '100%',
  };

  /** Style for the inline title-input form wrapper. */
  const inlineFormStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  };

  /** Style for the title input text field. */
  const titleInputStyle: React.CSSProperties = {
    padding: '0.5rem 0.625rem',
    fontSize: '0.875rem',
    border: '1px solid #D9D9D9',
    borderRadius: '0.375rem',
    fontFamily: 'inherit',
  };

  /** Style for the inline form's submit/cancel button row. */
  const formActionsStyle: React.CSSProperties = {
    display: 'flex',
    gap: '0.5rem',
  };

  /** Style for the inline form's primary submit button. */
  const submitButtonStyle: React.CSSProperties = {
    flex: '1 1 auto',
    padding: '0.5rem 0.75rem',
    backgroundColor: actionState === 'requesting' ? '#999999' : '#5B39F3',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    cursor: actionState === 'requesting' ? 'wait' : 'pointer',
  };

  /** Style for the inline form's cancel/secondary button. */
  const cancelButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    background: 'transparent',
    color: '#333333',
    border: '1px solid #D9D9D9',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    cursor: actionState === 'requesting' ? 'not-allowed' : 'pointer',
  };

  /** Style for the success banner. */
  const successBannerStyle: React.CSSProperties = {
    padding: '0.625rem 0.75rem',
    backgroundColor: '#F0FDF4',
    border: '1px solid #BBF7D0',
    borderRadius: '0.375rem',
    color: '#047857',
    fontSize: '0.8125rem',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.5rem',
  };

  /** Style for the error banner. */
  const errorBannerStyle: React.CSSProperties = {
    padding: '0.625rem 0.75rem',
    backgroundColor: '#FFF4F4',
    border: '1px solid #FFB3B3',
    borderRadius: '0.375rem',
    color: '#B00020',
    fontSize: '0.8125rem',
  };

  /**
   * The visually-hidden help text rendered when the button is disabled.
   * The clip-rect technique is the canonical WCAG sr-only pattern. This
   * span is announced by screen readers when the button receives focus
   * via `aria-describedby`.
   */
  const srOnlyHelpStyle: React.CSSProperties = {
    position: 'absolute',
    clip: 'rect(0 0 0 0)',
    clipPath: 'inset(50%)',
    width: 1,
    height: 1,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  };

  // -------------------------------------------------------------------------
  // Disabled-state copy — fed both into the button title attribute (for
  // sighted users with hover) AND the visually-hidden span (for assistive
  // technology) so all users learn why the button is disabled.
  // -------------------------------------------------------------------------
  let disabledHelpText: string | null = null;
  if (disabledReason === 'already-saved') {
    disabledHelpText =
      'This design is already saved. Make a change to enable saving again.';
  } else if (disabledReason === 'logo-pending-upload') {
    disabledHelpText =
      'Saving with a logo is not yet supported. Remove the logo to save your design, ' +
      'or wait for the logo upload feature to be released.';
  } else if (disabledReason === 'request-in-flight') {
    disabledHelpText = 'Saving design…';
  }

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------
  return (
    <section
      aria-label="Save design action"
      data-testid="save-design-cta"
      className="save-design-cta"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.625rem',
      }}
    >
      {/* PRIMARY BUTTON — visible in 'idle', 'success', 'error' states. */}
      {actionState !== 'naming' && actionState !== 'requesting' && (
        <>
          <button
            type="button"
            data-testid="save-design-button"
            onClick={handlePrimaryClick}
            disabled={!isButtonEnabled}
            aria-describedby={
              disabledHelpText !== null ? 'save-design-disabled-help' : undefined
            }
            title={
              disabledHelpText !== null
                ? disabledHelpText
                : 'Save the current design to your account'
            }
            style={primaryButtonStyle}
          >
            {isSaved && actionState !== 'success' && actionState !== 'error'
              ? 'Saved'
              : 'Save Design'}
          </button>

          {/*
           * Visually-hidden help text — announced to screen readers via
           * aria-describedby when the primary button receives focus while
           * disabled. Mirrors the title attribute for sighted-hover users.
           */}
          {disabledHelpText !== null && (
            <span
              id="save-design-disabled-help"
              data-testid="save-design-disabled-help"
              style={srOnlyHelpStyle}
            >
              {disabledHelpText}
            </span>
          )}
        </>
      )}

      {/*
       * INLINE TITLE INPUT — visible in 'naming' and 'requesting' states.
       * The form's submit handler builds the payload, calls createDesign,
       * and transitions to 'success' or 'error'. The input is disabled
       * during the in-flight request to prevent edits that would race
       * with the resolve.
       */}
      {(actionState === 'naming' || actionState === 'requesting') && (
        <form
          // The handler is async; wrap with `void` so React + ESLint
          // (`no-floating-promises`) treat the discarded promise
          // explicitly. React itself does not await event handlers.
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          style={inlineFormStyle}
          aria-label="Save design title"
        >
          <label
            htmlFor="save-design-title-input"
            style={{
              fontSize: '0.75rem',
              color: '#666',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Design title
          </label>
          <input
            ref={titleInputRef}
            id="save-design-title-input"
            data-testid="save-design-title-input"
            type="text"
            value={titleInput}
            onChange={handleTitleChange}
            onKeyDown={(event) => {
              // Escape cancels the inline input — common keyboard UX pattern.
              if (event.key === 'Escape' && actionState !== 'requesting') {
                handleCancel();
              }
            }}
            disabled={actionState === 'requesting'}
            maxLength={200}
            placeholder={DEFAULT_DESIGN_TITLE}
            style={titleInputStyle}
          />
          <div style={formActionsStyle}>
            <button
              type="submit"
              data-testid="save-design-submit"
              disabled={actionState === 'requesting'}
              style={submitButtonStyle}
            >
              {actionState === 'requesting' ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              data-testid="save-design-cancel"
              onClick={handleCancel}
              disabled={actionState === 'requesting'}
              style={cancelButtonStyle}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/*
       * SUCCESS BANNER — shown after a successful POST /api/designs.
       * `role="status"` + `aria-live="polite"` so screen readers
       * announce the success without yanking focus mid-task. The saved
       * design's id is exposed via `data-design-id` for e2e assertions
       * but is NOT shown in the visible text — users don't need a UUID,
       * they need to know it worked.
       */}
      {actionState === 'success' && savedDesignDisplay !== null && (
        <div
          role="status"
          aria-live="polite"
          data-testid="save-design-success"
          data-design-id={savedDesignDisplay.id}
          style={successBannerStyle}
        >
          <span data-testid="save-design-success-id">
            Design saved as &ldquo;{savedDesignDisplay.title}&rdquo;.
          </span>
          <button
            type="button"
            onClick={handleDismissFeedback}
            aria-label="Dismiss save confirmation"
            data-testid="save-design-success-dismiss"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#047857',
              cursor: 'pointer',
              fontSize: '1rem',
              padding: '0 0.25rem',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/*
       * ERROR BANNER — shown on save failure. `role="alert"` +
       * `aria-live="polite"` so the failure is announced but does NOT
       * yank focus. The displayed text is hard-coded actionable copy
       * keyed by HTTP status (Rule R2). NO server-supplied error string
       * is ever rendered.
       */}
      {actionState === 'error' && errorMessage !== null && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="save-design-error"
          style={errorBannerStyle}
        >
          <p style={{ margin: 0 }}>{errorMessage}</p>
          <button
            type="button"
            onClick={handleDismissFeedback}
            data-testid="save-design-error-dismiss"
            style={{
              marginTop: '0.5rem',
              padding: '0.25rem 0.625rem',
              border: '1px solid #B00020',
              background: 'transparent',
              color: '#B00020',
              borderRadius: '0.25rem',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
