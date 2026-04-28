/**
 * NewDesignDialog — Start-New-Design CTA + unsaved-changes confirmation
 * dialog (ST-020).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 ("New Files to Create — Frontend"):
 *       frontend/src/features/design-management/NewDesignDialog.tsx | ST-020
 *
 *   - AAP §0.6.7 (Track 2 — Frontend Core):
 *       CREATE | frontend/src/features/design-management/NewDesignDialog.tsx
 *       | ST-020 new-design reset with confirmation.
 *
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       MODIFY | frontend/src/features/design-management/NewDesignDialog.tsx
 *       | Wire to live endpoints where applicable.
 *
 *       NOTE: For ST-020 there is NO live endpoint to invoke. The reset is
 *       a CLIENT-ONLY state mutation; the only "side effect" is a Zustand
 *       set() call. The MG1-F directive is therefore a no-op for this
 *       component, and the file is authored in its final, complete form
 *       during Track 2.
 *
 *   - AAP §0.6.14 ("User Interface Design"):
 *       The top-navigation area hosts the New Design action (ST-020).
 *       This component renders INSIDE the App header alongside any future
 *       top-level controls (brand lockup, account menu, etc.).
 *
 * ============================================================================
 * Story coverage (Rule R1 — story files are the AC source of truth)
 * ============================================================================
 *
 *   ST-020-AC1: "A New Design action is accessible from the top navigation
 *               area and is reachable by both pointer and keyboard."
 *               → A native <button> with explicit type="button" is rendered
 *                 unconditionally. It receives Tab focus in document order
 *                 and supports both Enter/Space (built-in <button> keyboard
 *                 affordance) and pointer-click activation.
 *
 *   ST-020-AC2: "Activating New Design while the current design has
 *               unsaved changes shows a confirmation prompt naming what
 *               will be lost, and allows the user to cancel or proceed."
 *               → When the store's `isSaved` flag is FALSE, clicking the
 *                 trigger opens a modal confirmation dialog. The dialog's
 *                 description text enumerates EVERY field that
 *                 resetToDefaults() will restore (derived from
 *                 DEFAULT_DESIGN_PAYLOAD's keys via FIELD_LABELS) so the
 *                 user is fully informed of what will be lost. Two
 *                 affordances are offered: "Cancel" (close without state
 *                 change) and "Discard and start new" (commit reset).
 *
 *   ST-020-AC3: "Confirming the prompt resets every configurator surface
 *               — preview, color pickers, pattern selector, finish
 *               selector, logo controls, and summary sidebar — to the
 *               documented default values."
 *               → handleConfirm() invokes useConfiguratorStore's
 *                 resetToDefaults() action exactly once. The store owns
 *                 the documented-default definition (CONFIGURATOR_DEFAULTS,
 *                 which mirrors DEFAULT_DESIGN_PAYLOAD); this component
 *                 NEVER duplicates default values inline. Subscribed
 *                 selectors throughout the configurator (color pickers,
 *                 pattern selector, finish selector, logo positioner,
 *                 summary sidebar) re-render automatically because the
 *                 underlying slices change.
 *
 *   ST-020-AC4: "Cancelling the prompt leaves every configurator surface
 *               unchanged and does not reset any selection."
 *               → handleCancel() ONLY closes the dialog (setIsOpen(false))
 *                 and restores focus to the trigger. NO call to
 *                 resetToDefaults() or any other store action is made.
 *                 The same handler is invoked for the Cancel button and
 *                 the Escape key. Backdrop clicks are INTENTIONALLY
 *                 non-dismissive: per the dialog's `aria-modal="true"`
 *                 contract and Gate-T2 test 11 in
 *                 `frontend/tests/configurator/new-design-reset.spec.ts`,
 *                 the user MUST explicitly choose Cancel or Discard. This
 *                 safeguards the destructive path against accidental
 *                 dismissal via a mis-aimed click — the user never loses
 *                 unsaved selections by clicking outside the dialog.
 *
 *   Edge case (`isSaved === true`): When there are no unsaved changes,
 *   clicking the trigger SKIPS the confirmation dialog and resets
 *   immediately. ST-020-AC2 only requires confirmation when there ARE
 *   unsaved changes; in the saved-or-pristine state, a confirmation
 *   prompt would be needless friction. This interpretation matches the
 *   AAP's authoritative directive for this file (agent_prompt Phase 4)
 *   and mirrors common product UX for "reset" actions.
 *
 * ============================================================================
 * Cross-cutting rules enforced
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls anywhere
 *     in this file. The component issues NO network requests, holds NO
 *     credential material, and renders NO server-supplied strings.
 *
 *   - Rule R3 (Firebase Admin SDK only — backend): ZERO imports of
 *     `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`. This is
 *     a frontend component; the reset is a client-only state mutation
 *     and has no authentication surface.
 *
 *   - Rule R9 (no payment processing): ZERO references to `stripe`,
 *     `braintree`, `paypal`, `payment_intent`, `charge`, or any payment
 *     vocabulary. The action resets configurator state; it has nothing
 *     to do with cart, order, or settlement.
 *
 *   - C5 (correlation ID propagation): Not applicable — no outbound
 *     HTTP calls originate from this component.
 *
 *   - C6 / R7 (Fabric.js render before texture update): Not applicable
 *     directly here. The store's resetToDefaults() simply mutates state
 *     slices; downstream subscribers (color sync hooks, texture pipeline
 *     coordinator) re-render in the canonical Fabric-then-Three order
 *     because they listen to slice changes via Zustand selectors.
 *
 * ============================================================================
 * Default-shape contract anchor
 * ============================================================================
 *
 *   This component imports BOTH `DEFAULT_DESIGN_PAYLOAD` and
 *   `DEFAULT_DESIGN_TITLE` from `../../api/stub`:
 *
 *     - `DEFAULT_DESIGN_TITLE` is rendered verbatim in the dialog body
 *       so the user-facing copy stays in sync with the documented default
 *       title even if it changes in the future.
 *
 *     - `DEFAULT_DESIGN_PAYLOAD`'s KEYS are used (via Object.keys + a
 *       Record-typed FIELD_LABELS map) to derive the comma-separated
 *       list of fields that will be reset. The Record type forces the
 *       label map to stay in lockstep with the payload shape: adding a
 *       new field to `DEFAULT_DESIGN_PAYLOAD` without updating
 *       `FIELD_LABELS` here is a TypeScript compile error, ensuring the
 *       dialog body always names every reset field exactly.
 *
 *   The actual reset logic lives in the store (`resetToDefaults()`,
 *   which uses `CONFIGURATOR_DEFAULTS`). Both `DEFAULT_DESIGN_PAYLOAD`
 *   and `CONFIGURATOR_DEFAULTS` describe the same defaults by spec
 *   (verified by manual cross-check; see `frontend/src/api/stub.ts`
 *   docstring "Cross-file coordination" section).
 *
 * ============================================================================
 * Accessibility contract (WCAG 2.1 AA — per AAP UI guidelines UI3)
 * ============================================================================
 *
 *   - Trigger is a native <button type="button"> — keyboard-activatable
 *     by default (Enter/Space) and reachable by Tab in document order.
 *   - Trigger has visible label text "Start New Design" — no icon-only
 *     button without a text label.
 *   - aria-haspopup="dialog" + aria-expanded={isOpen} on the trigger
 *     advertise the modal relationship to assistive technology.
 *   - aria-controls={DIALOG_ID} (when open) links the trigger to the
 *     dialog it controls.
 *   - Dialog uses role="dialog" + aria-modal="true" — the canonical
 *     ARIA pattern for modal dialogs (WAI-ARIA Authoring Practices).
 *   - aria-labelledby points at the dialog title heading.
 *   - aria-describedby points at the dialog body paragraph.
 *   - On open: focus moves to the Cancel button (the safer action).
 *   - On open: a global Escape keydown listener dismisses the dialog.
 *   - On open: Tab + Shift+Tab cycle between Cancel and Confirm only
 *     (focus trap). Tab from Confirm wraps to Cancel; Shift+Tab from
 *     Cancel wraps to Confirm.
 *   - On close: focus returns to the trigger button so keyboard users
 *     do not lose their place.
 *   - Backdrop click does NOT dismiss the dialog (deliberate UX for the
 *     destructive `aria-modal="true"` path — the user must explicitly
 *     choose Cancel or Discard). The backdrop is presentational only:
 *     role="presentation" + aria-hidden="true" + NO onClick handler, so
 *     AT does not traverse into it and pointer users cannot inadvertently
 *     dismiss via a mis-aimed click.
 *
 * ============================================================================
 * Test contract (data-testid attributes for the Playwright suite — ST-045)
 * ============================================================================
 *
 *   - data-testid="new-design-trigger"        the trigger button
 *   - data-testid="new-design-backdrop"       the modal backdrop overlay
 *   - data-testid="new-design-dialog"         the dialog container
 *   - data-testid="new-design-dialog-title"   the dialog heading
 *   - data-testid="new-design-dialog-message" the dialog body paragraph
 *   - data-testid="new-design-cancel"         the Cancel button
 *   - data-testid="new-design-confirm"        the Discard/Confirm button
 *
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { DEFAULT_DESIGN_PAYLOAD, DEFAULT_DESIGN_TITLE } from '../../api/stub';
import { useConfiguratorStore } from '../../state/configuratorStore';

// ============================================================================
// Module-level constants
// ============================================================================

/**
 * Human-readable label for each documented-default field on
 * `DEFAULT_DESIGN_PAYLOAD`. The Record type forces this map to stay in
 * sync with the payload's shape: adding a key to DEFAULT_DESIGN_PAYLOAD
 * without updating this map produces a TypeScript compile error,
 * ensuring the confirmation dialog always names every reset field.
 */
const FIELD_LABELS: Record<keyof typeof DEFAULT_DESIGN_PAYLOAD, string> = {
  primaryColor: 'primary color',
  secondaryColor: 'secondary color',
  accentColor: 'accent color',
  pattern: 'stitching pattern',
  finish: 'material finish',
  logo: 'logo placement',
};

/**
 * Pre-computed comma-separated list of fields that `resetToDefaults()`
 * will restore. Derived once at module load from
 * `DEFAULT_DESIGN_PAYLOAD`'s keys to anchor the dialog message to the
 * actual default-payload shape (per ST-020-AC2 "naming what will be
 * lost"). Computing at module scope (rather than per-render) avoids any
 * re-computation cost on every dialog open.
 */
const RESET_FIELDS_DESCRIPTION: string = (
  Object.keys(DEFAULT_DESIGN_PAYLOAD) as ReadonlyArray<keyof typeof DEFAULT_DESIGN_PAYLOAD>
)
  .map((key) => FIELD_LABELS[key])
  .join(', ');

/** DOM id of the dialog container — referenced by aria-controls + ARIA. */
const DIALOG_ID = 'new-design-dialog';

/** DOM id of the dialog title heading — referenced by aria-labelledby. */
const TITLE_ID = 'new-design-dialog-title';

/** DOM id of the dialog body paragraph — referenced by aria-describedby. */
const DESCRIPTION_ID = 'new-design-dialog-description';

// ============================================================================
// Inline styles
// ============================================================================
//
// AAP §0.6.14 specifies "no design system library" — styles are co-located
// inline. Using the React.CSSProperties type ensures TypeScript catches
// invalid CSS property names. Colors come from the Blitzy brand palette
// referenced by AAP §0.8.2 (Executive Presentation Rule); for this
// non-hero surface we use the neutral interaction palette.

/** Style for the trigger button in the App header. */
const triggerButtonStyle: React.CSSProperties = {
  padding: '0.5rem 0.875rem',
  backgroundColor: '#FFFFFF',
  color: '#333333',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 500,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  cursor: 'pointer',
};

/** Style for the full-viewport modal backdrop. */
const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(45, 28, 119, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

/** Style for the dialog content card. */
const dialogStyle: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  borderRadius: '0.5rem',
  padding: '1.5rem',
  width: '90%',
  maxWidth: '28rem',
  boxShadow: '0 12px 32px rgba(45, 28, 119, 0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

/** Style for the dialog title heading. */
const dialogTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.125rem',
  fontWeight: 600,
  color: '#333333',
  lineHeight: 1.4,
};

/** Style for the dialog body text. */
const dialogMessageStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: '#555555',
  lineHeight: 1.5,
};

/** Style for the dialog actions row (Cancel + Confirm). */
const dialogActionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.5rem',
};

/** Style for the Cancel button (secondary, default focus). */
const cancelButtonStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  backgroundColor: '#FFFFFF',
  color: '#333333',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 500,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  cursor: 'pointer',
};

/**
 * Style for the destructive Confirm button. The red colour signals the
 * destructive nature of the action without relying on color alone — the
 * button label "Discard and start new" is also explicit.
 */
const confirmButtonStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  backgroundColor: '#B00020',
  color: '#FFFFFF',
  border: '1px solid #B00020',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 500,
  fontFamily: 'inherit',
  lineHeight: 1.5,
  cursor: 'pointer',
};

// ============================================================================
// Component
// ============================================================================

/**
 * The Start-New-Design action and confirmation dialog.
 *
 * Rendering contract:
 *   - Always renders a single trigger button labelled "Start New Design".
 *   - When `isSaved === false` and the user activates the trigger:
 *     opens a modal confirmation dialog with Cancel / Discard buttons.
 *   - When `isSaved === true` and the user activates the trigger:
 *     immediately calls `resetToDefaults()` with no confirmation —
 *     there is nothing to lose, so prompting would be needless friction.
 *
 * Subscribes to the configurator store via two stable selectors:
 *   - `isSaved` (boolean) — drives the immediate-reset vs. show-dialog
 *     branch in the trigger handler. Triggers a re-render when the
 *     saved state changes (e.g., user makes their first edit).
 *   - `resetToDefaults` (action ref) — Zustand 4.x guarantees stable
 *     references for action functions, so this never causes a re-render.
 *
 * @returns A JSX fragment containing the trigger button and (when open)
 *          the confirmation dialog.
 */
export function NewDesignDialog(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions
  // -------------------------------------------------------------------------
  const isSaved = useConfiguratorStore((s) => s.isSaved);
  const resetToDefaults = useConfiguratorStore((s) => s.resetToDefaults);

  // -------------------------------------------------------------------------
  // Local React state — owns the dialog open/closed flag
  // -------------------------------------------------------------------------
  const [isOpen, setIsOpen] = useState<boolean>(false);

  // -------------------------------------------------------------------------
  // Refs for focus management
  // -------------------------------------------------------------------------

  /**
   * Ref to the trigger button so focus can be RESTORED to it after the
   * dialog closes. A keyboard user who opens the dialog with Enter
   * should land back on the trigger after dismissing the dialog.
   */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Ref to the Cancel button so focus can be MOVED to it when the dialog
   * opens. Focusing the safer (non-destructive) action by default
   * reduces the risk of accidental confirmation.
   */
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Ref to the Confirm button — the second tabbable element used by
   * the manual focus trap inside the dialog.
   */
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * Restore focus to the trigger button after dialog dismissal. Uses
   * `requestAnimationFrame` to defer until the dialog has unmounted and
   * the trigger is reachable, which is more robust than a synchronous
   * focus call (the dialog may still own focus at the moment of the
   * setIsOpen(false) call).
   */
  const restoreTriggerFocus = useCallback((): void => {
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, []);

  /**
   * onClick handler for the trigger button.
   *
   *   - If isSaved === true: invoke resetToDefaults() immediately, no
   *     confirmation. The trigger keeps focus naturally because no
   *     dialog opens.
   *   - If isSaved === false: open the confirmation dialog. The reset
   *     itself is deferred to handleConfirm.
   */
  const handleTriggerClick = useCallback((): void => {
    if (isSaved) {
      // Pristine or saved state — reset is a no-loss action, no prompt.
      resetToDefaults();
      return;
    }
    // Unsaved changes present — open the confirmation dialog (ST-020-AC2).
    setIsOpen(true);
  }, [isSaved, resetToDefaults]);

  /**
   * onClick handler for the Cancel button — also invoked by the global
   * Escape keydown listener. Per ST-020-AC4: NO store mutation occurs;
   * the dialog simply closes and focus returns to the trigger. Backdrop
   * clicks are NOT routed here (the backdrop has no onClick handler) so
   * the user cannot inadvertently dismiss this destructive confirmation
   * via a mis-aimed click — they must explicitly choose Cancel or
   * Discard.
   */
  const handleCancel = useCallback((): void => {
    setIsOpen(false);
    restoreTriggerFocus();
  }, [restoreTriggerFocus]);

  /**
   * onClick handler for the Confirm button. Per ST-020-AC3: invokes
   * resetToDefaults() (the SINGLE source of truth for the documented
   * default state), closes the dialog, and restores focus to the
   * trigger.
   */
  const handleConfirm = useCallback((): void => {
    resetToDefaults();
    setIsOpen(false);
    restoreTriggerFocus();
  }, [resetToDefaults, restoreTriggerFocus]);

  // -------------------------------------------------------------------------
  // Effects — focus management, Escape, Tab focus trap
  // -------------------------------------------------------------------------

  /**
   * On dialog open:
   *   1. Move focus to the Cancel button (the safer default).
   *   2. Bind a global keydown listener to handle:
   *        - Escape: dismiss the dialog (ST-020-AC4).
   *        - Tab / Shift+Tab: trap focus between Cancel and Confirm.
   *
   * On dialog close (cleanup):
   *   - Cancel any pending focus animation frame.
   *   - Remove the global keydown listener.
   *
   * The listener is bound globally (rather than on the dialog element)
   * because focus may temporarily leave the trapped pair (e.g., for a
   * screen-reader announcement) and we still want Escape and Tab cycling
   * to work — the canonical modal dialog pattern per WAI-ARIA APG.
   */
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    // Focus the Cancel button on the next animation frame so the button
    // has been mounted and laid out by the time we call .focus(). A
    // synchronous focus call inside the same render-tick can race with
    // React's commit phase on some browsers.
    const focusFrame = requestAnimationFrame(() => {
      cancelButtonRef.current?.focus();
    });

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
        return;
      }
      if (event.key === 'Tab') {
        const cancelButton = cancelButtonRef.current;
        const confirmButton = confirmButtonRef.current;
        if (cancelButton === null || confirmButton === null) {
          // Refs not attached yet — let the browser handle Tab.
          return;
        }
        const focusables: ReadonlyArray<HTMLButtonElement> = [cancelButton, confirmButton];
        const active = document.activeElement;
        const currentIndex = focusables.findIndex((el) => el === active);
        const direction = event.shiftKey ? -1 : 1;
        // If focus is currently outside the trap (currentIndex === -1),
        // pull it back into the trap at index 0 (Cancel button).
        const nextIndex =
          currentIndex < 0 ? 0 : (currentIndex + direction + focusables.length) % focusables.length;
        event.preventDefault();
        focusables[nextIndex].focus();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);

    return (): void => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isOpen, handleCancel]);

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------
  return (
    <>
      {/*
        Trigger button — always rendered in the App header. Always
        enabled, so the user can start a new design from any state.
        aria-haspopup="dialog" advertises that activating this control
        opens a modal dialog. aria-expanded reflects the open/closed
        state for AT users. aria-controls links the trigger to the
        dialog (when open) so AT can navigate between them.
      */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        data-testid="new-design-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? DIALOG_ID : undefined}
        style={triggerButtonStyle}
      >
        Start New Design
      </button>
      {isOpen && (
        /*
          Backdrop:
            - role="presentation" + aria-hidden="true" mark the backdrop
              as decorative; AT users interact with the dialog inside,
              not the backdrop.
            - DELIBERATELY no onClick handler. Backdrop clicks must NOT
              dismiss the dialog because this is a destructive
              confirmation — the user must explicitly choose Cancel or
              Discard. Keyboard dismissal via Escape is handled by the
              GLOBAL keydown listener installed above. This contract is
              asserted by Test 11 in
              frontend/tests/configurator/new-design-reset.spec.ts which
              clicks at coordinates outside the dialog and verifies the
              dialog remains visible. Pointer dismissal happens only via
              the explicit Cancel button below.
        */
        <div
          role="presentation"
          aria-hidden="true"
          data-testid="new-design-backdrop"
          style={backdropStyle}
        >
          {/*
            Dialog:
              - role="dialog" + aria-modal="true" implements the ARIA
                modal dialog pattern.
              - aria-labelledby + aria-describedby link the dialog to its
                title and body for AT announcement.
          */}
          <div
            id={DIALOG_ID}
            role="dialog"
            aria-modal="true"
            aria-labelledby={TITLE_ID}
            aria-describedby={DESCRIPTION_ID}
            data-testid="new-design-dialog"
            style={dialogStyle}
          >
            <h2 id={TITLE_ID} data-testid="new-design-dialog-title" style={dialogTitleStyle}>
              Discard your unsaved changes?
            </h2>
            <p
              id={DESCRIPTION_ID}
              data-testid="new-design-dialog-message"
              style={dialogMessageStyle}
            >
              Your current design selections ({RESET_FIELDS_DESCRIPTION}) will be discarded and
              replaced with a fresh &ldquo;
              {DEFAULT_DESIGN_TITLE}&rdquo;. This action cannot be undone.
            </p>
            <div style={dialogActionsStyle}>
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={handleCancel}
                data-testid="new-design-cancel"
                style={cancelButtonStyle}
              >
                Cancel
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={handleConfirm}
                data-testid="new-design-confirm"
                style={confirmButtonStyle}
              >
                Discard and start new
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
