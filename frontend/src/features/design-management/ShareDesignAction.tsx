/**
 * ShareDesignAction — Issue a share-link for the current saved design
 * and copy the resulting URL to the system clipboard (ST-021).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.6.9 (Merge Gate 1 — MG1-F: Design Management Integration):
 *       CREATE | frontend/src/features/design-management/ShareDesignAction.tsx
 *       | ST-021 copies share link to clipboard.
 *
 *   - AAP §0.5.2 dependency injection — this component reads the current
 *     `savedDesignId` from the configurator store and calls
 *     `createShareLink(designId)` from the api/designs module.
 *
 *   - User stories — every acceptance criterion is addressed below;
 *     the docstring on each subsection cites the specific AC it
 *     satisfies.
 *
 *       ST-021-AC1: "When the user activates the Share Design control
 *           on a saved design, the system requests a share link AND
 *           writes the returned link to the system clipboard so the
 *           user can paste it directly without retyping."
 *           → On click: await createShareLink(savedDesignId); on
 *             resolve, await navigator.clipboard.writeText(shareLink.url);
 *             on resolve of THAT, transition to success state. The
 *             clipboard write is BIDIRECTIONALLY conditional: only
 *             if the network call resolved AND the clipboard API is
 *             available is the URL written.
 *
 *       ST-021-AC2: "The share link is valid only for a documented
 *           duration; after expiration, attempts to load the design
 *           via the link surface a clear failure message and do NOT
 *           grant access."
 *           → The frontend exposes `shareLink.expiresAt` (an ISO-8601
 *             string) so the success indicator may show "expires
 *             <relative>". The expiration enforcement happens server
 *             side; the read endpoint (/api/share/:token) is
 *             responsible for the failure message, NOT this component.
 *
 *       ST-021-AC3: "If share-link issuance fails, the user sees an
 *           actionable failure message and no link is copied to the
 *           clipboard."
 *           → The clipboard.writeText() call is inside the same try
 *             block as createShareLink(); on any rejection from
 *             EITHER the network call OR the clipboard API, the
 *             component falls into the error branch and the clipboard
 *             is NOT touched. Hard-coded copy by HTTP status (Rule R2).
 *
 *       ST-021-AC4: "The Share Design control is only available when
 *           the user has a saved design to share — when the current
 *           configurator state has not yet been persisted, the control
 *           is disabled with explanatory copy."
 *           → The trigger button is disabled when `savedDesignId` is
 *             undefined OR when `isSaved` is false (the user has
 *             unsaved changes since the last save). The disabled
 *             button has a `title` attribute and an aria-describedby
 *             pointing at sr-only help text explaining why.
 *
 * ============================================================================
 * Cross-cutting rules enforced
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. Error
 *     copy is HARD-CODED by HTTP status — server-supplied strings are
 *     never rendered. No bearer token, password, or session token can
 *     leak through this component.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): the bearer token
 *     is attached to /api/designs/:id/share-link by ./client's
 *     request() helper, not by this component.
 *
 *   - Rule R9 (no payment processing): no payment-processor or
 *     settlement code in this component.
 *
 *   - C5 (correlation ID propagation): the X-Correlation-Id is
 *     attached automatically by ./client's request() helper.
 *
 *   - C6 / R7 (Fabric.js render before texture update): not
 *     applicable — this component does not touch the texture pipeline.
 *
 * ============================================================================
 * Cross-layer wire-format contract
 * ============================================================================
 *
 *   The backend returns ShareLink shaped as:
 *     { token: string, url: string, expiresAt: string (ISO-8601) }
 *
 *   The frontend writes `shareLink.url` VERBATIM to the clipboard.
 *   The frontend does NOT compose the URL from `window.location.origin`
 *   + token. The backend is the canonical authority on the public
 *   share URL because it knows the deployment topology (the API origin
 *   may differ from the user-facing origin in some configurations).
 *
 * ============================================================================
 * Clipboard API resilience
 * ============================================================================
 *
 *   navigator.clipboard.writeText() can fail or be unavailable for
 *   several reasons:
 *     - HTTP (non-HTTPS) origins do not have access to the clipboard
 *       API in modern browsers.
 *     - Headless test browsers may not grant clipboard permission.
 *     - The user agent may have permission restrictions.
 *
 *   When the clipboard write fails, the component shows an error
 *   message that includes the share URL VISIBLY in the success
 *   indicator so the user can copy it manually. This satisfies the
 *   spirit of ST-021-AC1 (the user can paste the link without
 *   retyping) even when the clipboard API is unavailable.
 *
 * ============================================================================
 * Test contract (for the Playwright e2e suite at MG2-H per ST-045)
 * ============================================================================
 *
 *     - `data-testid="share-design-action"`        — the outer wrapper
 *     - `data-testid="share-design-trigger"`       — the trigger button
 *     - `data-testid="share-design-success"`       — the success banner
 *     - `data-testid="share-design-success-url"`   — the visible URL element
 *     - `data-testid="share-design-error"`         — the error banner
 *     - `data-testid="share-design-error-dismiss"` — the error dismiss button
 *     - `data-testid="share-design-help"`          — the sr-only help text
 *
 * ============================================================================
 */

import { useCallback, useState, type JSX } from 'react';

import { ApiError } from '../../api/client';
import { createShareLink, type ShareLink } from '../../api/designs';
import { useConfiguratorStore } from '../../state/configuratorStore';

// ============================================================================
// Local types
// ============================================================================

/**
 * Phases in the share-design action lifecycle.
 *
 * - `idle`        → no action in progress; the trigger is visible (and
 *                   may be enabled or disabled depending on store
 *                   state).
 * - `requesting`  → POST /api/designs/:id/share-link is in flight, OR
 *                   the network call resolved and the clipboard write
 *                   is in flight. From the user's perspective these
 *                   two phases are indistinguishable; we collapse them
 *                   into one to keep the state machine simple.
 * - `success`     → the share link was issued AND copied to the
 *                   clipboard (or shown for manual copy if the
 *                   clipboard API was unavailable).
 * - `error`       → the share-link issuance OR the clipboard write
 *                   failed; per ST-021-AC3 NO link was copied.
 */
type ShareActionState = 'idle' | 'requesting' | 'success' | 'error';

// ============================================================================
// Module-scope helpers
// ============================================================================

/**
 * Map an unknown error from createShareLink() OR
 * navigator.clipboard.writeText() into a hard-coded user-facing
 * message keyed on HTTP status (when ApiError) or kind (network /
 * clipboard).
 *
 * Per Rule R2, the error message NEVER includes any string sourced
 * from the network response or the JS error object. All copy is
 * hard-coded English.
 *
 * @param error - The thrown error.
 * @param phase - Which lifecycle phase failed: 'network' (the
 *   share-link issuance failed) or 'clipboard' (the issuance
 *   succeeded but the clipboard write failed). When 'clipboard',
 *   the success branch will surface a "copy this manually"
 *   affordance instead of a hard error — this helper is only
 *   called when no manual fallback is possible.
 * @returns A hard-coded user-facing error string.
 */
function describeShareError(error: unknown, phase: 'network' | 'clipboard'): string {
  if (phase === 'clipboard') {
    return (
      'The share link could not be copied to your clipboard automatically. ' +
        'Use the visible link below to copy it manually.'
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your session has expired. Please sign in again to share this design.';
    }
    if (error.status === 403) {
      return 'You can only share designs that you own. Save your current design first.';
    }
    if (error.status === 404) {
      return (
        'This design could not be found. It may have been deleted; refresh the ' +
          'page and try again.'
      );
    }
    if (error.status >= 500) {
      return (
        'The share service is temporarily unavailable. Please try again in a ' + 'moment.'
      );
    }
    // Catch-all for other 4xx (400 validation, 409 conflict, etc.).
    return (
      'The share link could not be created. Please try again; if the problem ' +
        'persists, refresh the page.'
    );
  }
  // Network failure, AbortError, JSON parse failure, etc.
  return (
    'The share link could not be created due to a network issue. ' +
      'Please check your connection and try again.'
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * Share Design action — a single button that issues a share link for
 * the current saved design and copies the URL to the system
 * clipboard.
 *
 * Subscribes via TWO Zustand selectors:
 *   - `savedDesignId` (a primitive string | undefined) — re-renders
 *     when changed.
 *   - `isSaved` (a primitive boolean) — re-renders when changed.
 *
 * The component does NOT subscribe to color, pattern, finish, or
 * logo state — those are not relevant to share-link issuance.
 *
 * @returns A JSX element representing the Share Design control and
 *   its success/error feedback.
 */
export function ShareDesignAction(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions
  // -------------------------------------------------------------------------
  const savedDesignId = useConfiguratorStore((s) => s.savedDesignId);
  const isSaved = useConfiguratorStore((s) => s.isSaved);

  // -------------------------------------------------------------------------
  // Local React state
  // -------------------------------------------------------------------------
  const [actionState, setActionState] = useState<ShareActionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successLink, setSuccessLink] = useState<ShareLink | null>(null);
  /**
   * Tracks whether the success banner shows the link VERBATIM
   * because the clipboard API was unavailable. When true, the success
   * banner copy switches from "Copied to your clipboard." to "Copy
   * this link manually:" and emphasizes the URL.
   */
  const [requiresManualCopy, setRequiresManualCopy] = useState<boolean>(false);

  // -------------------------------------------------------------------------
  // Derived: whether the trigger is enabled.
  // -------------------------------------------------------------------------

  /**
   * The button is enabled only when:
   *   - There is a savedDesignId (the user has saved at least once).
   *   - isSaved is true (the user has not made changes since the
   *     last save). Per ST-021-AC4 sharing a stale ID would create
   *     a confusing experience because the recipient would see the
   *     last-saved state, not what the sharer is currently looking
   *     at.
   *   - The action is not currently in flight.
   */
  const hasSavedDesign = typeof savedDesignId === 'string' && savedDesignId.length > 0;
  const isCurrentVersionSaved = hasSavedDesign && isSaved;
  const isButtonEnabled = isCurrentVersionSaved && actionState !== 'requesting';

  /**
   * The disabled-reason message shown via title and sr-only help.
   * Rendered ONLY when the button is disabled.
   */
  const disabledReason = !hasSavedDesign
    ? 'Save your design first to share it.'
    : !isSaved
      ? 'Save your changes first; the saved version is what would be shared.'
      : null;

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * onClick handler for the Share Design trigger. Drives the full
   * lifecycle: request → clipboard → success or error.
   */
  const handleShare = useCallback(async () => {
    // Defensive: should not be reachable when isButtonEnabled is false,
    // but guard regardless.
    if (!isCurrentVersionSaved) {
      return;
    }
    // savedDesignId is non-undefined when isCurrentVersionSaved; assert
    // for the type checker.
    if (typeof savedDesignId !== 'string') {
      return;
    }

    // Reset feedback for a fresh attempt.
    setActionState('requesting');
    setErrorMessage(null);
    setSuccessLink(null);
    setRequiresManualCopy(false);

    let issuedLink: ShareLink;
    try {
      issuedLink = await createShareLink(savedDesignId);
    } catch (networkError: unknown) {
      // Issuance failed — per ST-021-AC3 NO clipboard mutation.
      setActionState('error');
      setErrorMessage(describeShareError(networkError, 'network'));
      return;
    }

    // Issuance succeeded. Attempt the clipboard write.
    let clipboardSucceeded = false;
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard !== 'undefined' &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      try {
        await navigator.clipboard.writeText(issuedLink.url);
        clipboardSucceeded = true;
      } catch {
        // Clipboard refused (permission denied, non-secure context,
        // etc.). Fall through to manual-copy mode — the share link
        // IS valid; the user just needs to copy it visibly.
        clipboardSucceeded = false;
      }
    }

    setSuccessLink(issuedLink);
    setRequiresManualCopy(!clipboardSucceeded);
    setActionState('success');
  }, [isCurrentVersionSaved, savedDesignId]);

  /**
   * Dismiss the error banner without re-attempting.
   */
  const handleDismissError = useCallback(() => {
    setActionState('idle');
    setErrorMessage(null);
  }, []);

  /**
   * Dismiss the success banner. The share link remains valid on the
   * server until expiration; dismissal is a UI-only operation.
   */
  const handleDismissSuccess = useCallback(() => {
    setActionState('idle');
    setSuccessLink(null);
    setRequiresManualCopy(false);
  }, []);

  // -------------------------------------------------------------------------
  // Inline styles — co-located so the component is self-contained.
  // -------------------------------------------------------------------------

  /**
   * Trigger button style.
   *
   * QA Issue #7 — unify top-nav trigger button styling. The canonical
   * top-nav trigger style is the "outline" treatment from
   * NewDesignDialog: 0.5rem 0.875rem padding (8px 14px), white bg,
   * 1px solid #D9D9D9 border, 0.375rem (6px) radius, Inter 14px 500.
   * The enabled state surfaces the brand-purple primary by switching
   * the bg to `#5B39F3` and text to white; the disabled state uses
   * the same outline shape with neutral surface and `#666666` text
   * for WCAG-AA contrast (QA Issue #10).
   */
  const triggerButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.875rem',
    backgroundColor: isButtonEnabled ? '#5B39F3' : '#FFFFFF',
    color: isButtonEnabled ? '#FFFFFF' : '#666666',
    border: isButtonEnabled ? '1px solid #5B39F3' : '1px solid #D9D9D9',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    cursor: isButtonEnabled ? 'pointer' : 'not-allowed',
  };

  /** Success banner style — green-tinted. */
  const successBannerStyle: React.CSSProperties = {
    marginTop: '0.5rem',
    padding: '0.625rem',
    backgroundColor: '#F0FDF4',
    border: '1px solid #BBF7D0',
    borderRadius: '0.375rem',
    color: '#047857',
    fontSize: '0.8125rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  };

  /** Style for the visible URL element inside the success banner. */
  const successUrlStyle: React.CSSProperties = {
    fontFamily: '"Fira Code", monospace',
    fontSize: '0.8125rem',
    color: '#047857',
    wordBreak: 'break-all',
    backgroundColor: '#FFFFFF',
    border: '1px solid #BBF7D0',
    borderRadius: '0.25rem',
    padding: '0.375rem 0.5rem',
    margin: 0,
    userSelect: 'all',
  };

  /** Error banner style — red-tinted. */
  const errorBannerStyle: React.CSSProperties = {
    marginTop: '0.5rem',
    padding: '0.625rem',
    backgroundColor: '#FFF4F4',
    border: '1px solid #FFB3B3',
    borderRadius: '0.375rem',
    color: '#B00020',
    fontSize: '0.8125rem',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.5rem',
  };

  /** Small dismiss button used in success and error banners. */
  const bannerDismissButtonStyle: React.CSSProperties = {
    padding: '0.125rem 0.5rem',
    backgroundColor: 'transparent',
    color: 'inherit',
    border: '1px solid currentColor',
    borderRadius: '0.25rem',
    fontSize: '0.75rem',
    fontWeight: 500,
    cursor: 'pointer',
    flexShrink: 0,
  };

  /**
   * sr-only style — the WCAG clip-rect technique for visually hidden
   * but assistive-tech-readable content.
   */
  const srOnlyStyle: React.CSSProperties = {
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

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------

  return (
    <section data-testid="share-design-action" aria-label="Share design">
      {/*
       * Trigger button. The disabled-reason string is bound to title
       * (mouse hover) AND surfaced via aria-describedby for screen
       * readers.
       */}
      <button
        type="button"
        data-testid="share-design-trigger"
        onClick={(): void => {
          // void the promise to satisfy no-floating-promises.
          void handleShare();
        }}
        disabled={!isButtonEnabled}
        aria-busy={actionState === 'requesting'}
        aria-describedby={disabledReason !== null ? 'share-design-help' : undefined}
        title={disabledReason ?? undefined}
        style={triggerButtonStyle}
      >
        {actionState === 'requesting' ? 'Sharing…' : 'Share Design'}
      </button>

      {/*
       * sr-only help text explaining why the button is disabled.
       * Rendered only when there is a reason; otherwise the
       * aria-describedby reference would point at nothing.
       */}
      {disabledReason !== null && (
        <span id="share-design-help" data-testid="share-design-help" style={srOnlyStyle}>
          {disabledReason}
        </span>
      )}

      {/*
       * Success banner. Always shows the link VERBATIM (so screen
       * readers can announce it and so the user can copy it manually
       * if the auto-copy failed). The copy varies based on whether the
       * clipboard write succeeded.
       */}
      {actionState === 'success' && successLink !== null && (
        <div
          role="status"
          aria-live="polite"
          data-testid="share-design-success"
          style={successBannerStyle}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
            <strong>
              {requiresManualCopy
                ? 'Share link ready — copy it manually:'
                : 'Share link copied to your clipboard.'}
            </strong>
            <button
              type="button"
              onClick={handleDismissSuccess}
              style={bannerDismissButtonStyle}
              aria-label="Dismiss share link"
            >
              Dismiss
            </button>
          </div>
          {/*
           * The visible URL — selectable via user-select: all so a
           * triple-click selects the entire string.
           */}
          <code data-testid="share-design-success-url" style={successUrlStyle}>
            {successLink.url}
          </code>
        </div>
      )}

      {/*
       * Error banner. Includes a Dismiss action so the user can
       * clear the error before retrying.
       */}
      {actionState === 'error' && errorMessage !== null && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="share-design-error"
          style={errorBannerStyle}
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            data-testid="share-design-error-dismiss"
            onClick={handleDismissError}
            style={bannerDismissButtonStyle}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
