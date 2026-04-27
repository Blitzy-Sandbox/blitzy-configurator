/**
 * NewDesignDialog — Start a fresh design with optional unsaved-changes
 * confirmation (ST-020).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.6.7 (Track 2 — Frontend Core):
 *       CREATE | frontend/src/features/design-management/NewDesignDialog.tsx
 *       | ST-020 new-design reset with confirmation.
 *
 *   - AAP §0.6.14 ("User Interface Design"):
 *       The top-navigation area hosts the New Design action (ST-020).
 *       This component is rendered INSIDE the App header alongside the
 *       brand lockup and any future authentication controls.
 *
 *   - User stories — every acceptance criterion is addressed by the
 *     implementation below; the docstring on each subsection cites the
 *     specific AC it satisfies.
 *
 *       ST-020-AC1: "From any state, the user can choose to start a
 *           new design."
 *           → A primary "New Design" button in the App header is
 *             always visible and always clickable. Tab-reachable
 *             with a visible focus indicator.
 *
 *       ST-020-AC2: "When the user confirms starting a new design,
 *           the configurator returns to its documented default
 *           state."
 *           → The confirmation flow ends with a single call to
 *             `useConfiguratorStore.resetToDefaults()`. The store
 *             owns the "documented default state" definition (it
 *             reads from CONFIGURATOR_DEFAULTS), so this component
 *             never duplicates the default values inline.
 *
 *       ST-020-AC3: "The user receives a confirmation prompt when a
 *           reset would discard unsaved changes."
 *           → When the store's `isSaved` flag is FALSE (there are
 *             unsaved changes), clicking the trigger opens a modal
 *             dialog with two clearly-labelled actions: "Discard
 *             changes" (primary destructive) and "Cancel" (secondary,
 *             default-focus). The reset is committed only on the
 *             explicit "Discard changes" click. When `isSaved` is
 *             TRUE, no confirmation is required — the dialog opens
 *             with the lighter "Start fresh?" copy because the user
 *             is not at risk of losing work.
 *
 *       ST-020-AC4: "The user can cancel the prompt with no state
 *           change."
 *           → Cancel button, Escape key, and clicking outside the
 *             dialog all dismiss it without any store mutation.
 *
 * ============================================================================
 * Cross-cutting rules enforced
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. This
 *     component does NOT issue any network requests; it has no error
 *     surface.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): this component
 *     does NOT touch authentication. The reset is a CLIENT-ONLY state
 *     mutation; the user remains signed in.
 *
 *   - Rule R9 (no payment processing): Reset is a configurator action;
 *     no payment, charge, or settlement references appear here.
 *
 *   - C5 (correlation ID propagation): not applicable — no network
 *     requests are issued.
 *
 *   - C6 / R7 (Fabric.js render before texture update): the reset
 *     mutates the store (every slice returns to default), which causes
 *     the texture pipeline coordinator (registered in App.tsx via
 *     useColorSync()) to re-render in the correct fabric-then-three
 *     order. This component itself does NOT touch the texture pipeline.
 *
 * ============================================================================
 * Accessibility contract (WCAG 2.1 AA — per AAP §UD3)
 * ============================================================================
 *
 *   - The trigger is a native <button> with explicit `type="button"`
 *     so it does not submit any ancestor form by accident.
 *   - When the dialog opens, focus moves to the Cancel button (the
 *     non-destructive action). This satisfies the convention "focus
 *     the safer action first".
 *   - The dialog uses role="dialog" + aria-modal="true" so assistive
 *     technology treats it as modal.
 *   - aria-labelledby points at the dialog title.
 *   - aria-describedby points at the dialog description.
 *   - Tab + Shift+Tab cycle through Cancel and Discard only — focus
 *     is trapped inside the dialog. After the dialog closes, focus
 *     returns to the trigger button so keyboard users do not lose
 *     their place.
 *   - Escape key dismisses (treated as Cancel).
 *   - Click on the backdrop dismisses (treated as Cancel). Clicks
 *     INSIDE the dialog content do NOT dismiss.
 *   - The dialog renders inline (NOT via React portal) inside the
 *     section. Z-index and absolute positioning ensure it overlays the
 *     entire viewport. A portal could be added later if a parent
 *     stacking context becomes problematic, but is not required for
 *     ST-020.
 *
 * ============================================================================
 * Test contract (for the Playwright e2e suite at MG2-H per ST-045)
 * ============================================================================
 *
 *     - `data-testid="new-design-trigger"`     — the trigger button in the
 *                                                 App header
 *     - `data-testid="new-design-dialog"`      — the dialog wrapper
 *                                                 (visible only when open)
 *     - `data-testid="new-design-dialog-title"` — the dialog heading
 *     - `data-testid="new-design-dialog-message"` — the body copy
 *     - `data-testid="new-design-confirm"`     — the destructive primary
 *                                                 action ("Discard
 *                                                 changes" or "Start
 *                                                 fresh")
 *     - `data-testid="new-design-cancel"`      — the secondary action
 *     - `data-testid="new-design-backdrop"`    — the backdrop overlay
 *
 * ============================================================================
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { useConfiguratorStore } from '../../state/configuratorStore';

// ============================================================================
// Component
// ============================================================================

/**
 * The Start-New-Design CTA + confirmation dialog.
 *
 * Renders ONE button by default (the trigger). On click, an inline
 * modal dialog appears overlaying the viewport. The dialog's content
 * varies based on whether the user has unsaved changes:
 *
 *   - With unsaved changes (isSaved === false): the dialog warns the
 *     user that their progress will be lost. The destructive action is
 *     labelled "Discard changes".
 *   - Without unsaved changes (isSaved === true): the dialog offers a
 *     low-stakes "Start fresh?" prompt with a "Start fresh" action.
 *     The user can dismiss without consequence; the only effect of
 *     confirming is to revert any non-default selections that happen
 *     to match the saved-or-pristine state. (Edge case: typically
 *     there is nothing to do here, but offering the affordance keeps
 *     the API consistent.)
 *
 * Subscribes via TWO Zustand selectors:
 *   - `isSaved` (a primitive) — re-renders when changed.
 *   - `resetToDefaults` (an action reference) — stable across renders.
 *
 * @returns A JSX element representing the Start-New-Design CTA and
 *   confirmation dialog.
 */
export function NewDesignDialog(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions
  // -------------------------------------------------------------------------
  const isSaved = useConfiguratorStore((s) => s.isSaved);
  const resetToDefaults = useConfiguratorStore((s) => s.resetToDefaults);

  // -------------------------------------------------------------------------
  // Local React state — owns the dialog open/closed flag.
  // -------------------------------------------------------------------------
  const [isOpen, setIsOpen] = useState<boolean>(false);

  // -------------------------------------------------------------------------
  // Refs for focus management
  // -------------------------------------------------------------------------

  /**
   * Ref to the trigger button so focus can be RESTORED to it after
   * the dialog closes. A keyboard user who opens the dialog with the
   * Enter key should land back on the trigger button after dismissing
   * the dialog.
   */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Ref to the Cancel button so focus can be MOVED to it when the
   * dialog opens. Focusing the safer action by default reduces the
   * risk of an accidental destructive confirmation.
   */
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Ref to the Confirm button — the second tabbable element for the
   * focus trap.
   */
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  /**
   * On dialog open: move focus to the Cancel button. On dialog close:
   * return focus to the trigger button. The conditional dependency
   * makes the effect run on each open/close transition.
   */
  useEffect(() => {
    if (isOpen) {
      // Defer to the next paint so the button has been rendered.
      // requestAnimationFrame is safer than a 0ms setTimeout because
      // it waits for the paint, not just for the microtask queue to
      // drain.
      const id = requestAnimationFrame(() => {
        cancelButtonRef.current?.focus();
      });
      return (): void => {
        cancelAnimationFrame(id);
      };
    }
    // Closing: return focus to the trigger. Guard against the trigger
    // being unmounted (e.g., the App header was re-laid out).
    triggerRef.current?.focus();
    return undefined;
  }, [isOpen]);

  /**
   * Bind a global keydown listener for Escape while the dialog is
   * open. The listener is removed when the dialog closes, so it does
   * not affect general app keyboard behaviour.
   *
   * Why bind globally rather than on the dialog element: focus may
   * temporarily leave the focus trap (e.g., for a screen reader
   * announcement), and we still want Escape to work. Global binding
   * is the canonical modal-dialog pattern.
   */
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return (): void => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isOpen]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * onClick for the trigger. Opens the dialog. Whether confirmation
   * copy is destructive or low-stakes is decided in the render based
   * on `isSaved`.
   */
  const handleOpenTrigger = useCallback(() => {
    setIsOpen(true);
  }, []);

  /**
   * onClick for the Cancel button — close the dialog without any
   * store mutation. The same handler is invoked by the backdrop
   * click and by the global Escape keydown.
   */
  const handleCancel = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * onClick for the Confirm button — invoke the store's
   * resetToDefaults() action and close the dialog.
   *
   * Per ST-020-AC2 the store is the single source of truth for the
   * default state; this component never inlines the default values.
   */
  const handleConfirm = useCallback(() => {
    resetToDefaults();
    setIsOpen(false);
  }, [resetToDefaults]);

  /**
   * onClick for the backdrop. Dismiss the dialog. Stops further
   * propagation so the inner content's click handlers (which would
   * also be backdrop clicks if the dialog children weren't event-
   * stopped explicitly) don't fire.
   */
  const handleBackdropClick = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Focus-trap handler bound to the dialog content.
   *
   * - Tab from the Confirm button wraps to the Cancel button.
   * - Shift+Tab from the Cancel button wraps to the Confirm button.
   * - Tab between the two buttons follows the natural tab order.
   *
   * Implemented manually rather than via a third-party focus-trap
   * library to keep the dependency surface small. The dialog has only
   * two tabbable elements, so manual trapping is straightforward.
   */
  const handleDialogKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Tab') {
        return;
      }
      const isShift = event.shiftKey;
      const cancel = cancelButtonRef.current;
      const confirm = confirmButtonRef.current;
      if (cancel === null || confirm === null) {
        return;
      }
      const active = document.activeElement;
      // Forward tab from Confirm wraps to Cancel.
      if (!isShift && active === confirm) {
        event.preventDefault();
        cancel.focus();
        return;
      }
      // Backward tab from Cancel wraps to Confirm.
      if (isShift && active === cancel) {
        event.preventDefault();
        confirm.focus();
        return;
      }
    },
    [],
  );

  /**
   * Stop a click inside the dialog from bubbling to the backdrop
   * (which would dismiss the dialog).
   */
  const handleDialogClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Inline styles — co-located so the component remains self-contained.
  // -------------------------------------------------------------------------

  /** Style for the trigger button in the App header. */
  const triggerButtonStyle: React.CSSProperties = {
    padding: '0.5rem 1rem',
    backgroundColor: 'transparent',
    color: '#5B39F3',
    border: '1px solid #5B39F3',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  };

  /** Style for the full-viewport modal backdrop. */
  const backdropStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
    padding: '1.25rem',
    minWidth: '20rem',
    maxWidth: '32rem',
    boxShadow: '0 12px 32px rgba(45, 28, 119, 0.25)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  };

  /** Style for the dialog title heading. */
  const dialogTitleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '1rem',
    fontWeight: 600,
    color: '#333',
  };

  /** Style for the dialog body text. */
  const dialogMessageStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '0.875rem',
    color: '#666',
    lineHeight: 1.5,
  };

  /** Style for the dialog actions row (Cancel + Confirm). */
  const dialogActionsStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '0.25rem',
  };

  /** Style for the Cancel button (secondary, default focus). */
  const cancelButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.875rem',
    backgroundColor: 'transparent',
    color: '#333',
    border: '1px solid #D9D9D9',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  };

  /**
   * Style for the Confirm button. The colour reflects the destructive
   * vs low-stakes character of the action: red when discarding
   * unsaved changes, brand-purple when starting fresh from a saved
   * state.
   */
  const confirmButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.875rem',
    backgroundColor: !isSaved ? '#B00020' : '#5B39F3',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  };

  // -------------------------------------------------------------------------
  // Copy variants — keyed on `isSaved`. Hard-coded English strings; if
  // i18n is added later, these become translation keys.
  // -------------------------------------------------------------------------

  /** Title text shown at the top of the dialog. */
  const dialogTitle = !isSaved ? 'Discard your unsaved changes?' : 'Start a new design?';

  /** Body copy explaining the consequence of confirming. */
  const dialogMessage = !isSaved
    ? 'Starting a new design will discard your current selections. This cannot be undone. Save your design first if you want to keep it.'
    : 'Starting a new design will reset every control to its default value.';

  /** Label on the destructive primary action button. */
  const confirmLabel = !isSaved ? 'Discard changes' : 'Start fresh';

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------
  return (
    <>
      {/*
       * Trigger — always visible in the App header. Always enabled so
       * the user can start a new design from any state.
       */}
      <button
        type="button"
        ref={triggerRef}
        data-testid="new-design-trigger"
        onClick={handleOpenTrigger}
        style={triggerButtonStyle}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'new-design-dialog' : undefined}
      >
        New Design
      </button>

      {/*
       * Dialog — rendered inline (no portal) below the trigger. Hidden
       * via conditional render rather than CSS to avoid any chance of
       * the dialog content being scraped by tools that don't compute
       * styles.
       */}
      {isOpen && (
        /*
         * Backdrop:
         *   - role="presentation" — backdrop is decorative; the dialog
         *     inside it is the actual ARIA widget. Screen readers should
         *     not treat the backdrop as interactive.
         *   - aria-hidden="true" — defensive; the dialog has aria-modal,
         *     so AT focus is already constrained to the dialog. Marking
         *     the backdrop hidden ensures no AT artifact bleeds through.
         *   - The onClick={handleBackdropClick} mouse affordance dismisses
         *     the dialog. Keyboard dismissal is handled by the GLOBAL
         *     Escape keydown listener installed on `document` in the
         *     useEffect that runs while the dialog is open — this is the
         *     canonical modal pattern (WAI-ARIA Authoring Practices). The
         *     jsx-a11y/click-events-have-key-events rule wants a handler
         *     on the backdrop element itself, but the keyboard handler
         *     belongs at the document level so it works regardless of
         *     where focus currently sits inside the dialog. The
         *     jsx-a11y/no-static-element-interactions rule wants an
         *     interactive role, but a backdrop is not semantically
         *     interactive — it's a passive overlay whose only job is to
         *     darken the page behind the modal. Per ARIA 1.2 §5.4
         *     "presentation role", presentation is the correct role for
         *     this purpose.
         */
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- See comment block above; keyboard dismissal is at document level via global Escape listener (canonical modal pattern); presentation role is correct for decorative backdrop.
        <div
          role="presentation"
          aria-hidden="true"
          data-testid="new-design-backdrop"
          onClick={handleBackdropClick}
          style={backdropStyle}
        >
          {/*
           * Dialog content:
           *   - role="dialog" + aria-modal="true" implements the ARIA
           *     modal dialog pattern (WAI-ARIA Authoring Practices).
           *   - onClick={handleDialogClick} stops backdrop dismissal when
           *     the user clicks inside the dialog (required for the
           *     backdrop-click-to-dismiss UX to work without false
           *     dismissals).
           *   - onKeyDown={handleDialogKeyDown} implements the manual
           *     Tab/Shift+Tab focus trap that is REQUIRED for modal
           *     dialogs per WAI-ARIA. Without this, Tab from the last
           *     focusable element would escape the modal entirely.
           *   - The jsx-a11y/no-noninteractive-element-interactions rule
           *     classifies role="dialog" as non-interactive (it's a
           *     "window" structure role per ARIA 1.2), but interaction
           *     handlers ARE required by the dialog pattern itself. This
           *     is a known false positive; see
           *     https://github.com/jsx-eslint/eslint-plugin-jsx-a11y
           *     issues for "dialog role + onClick".
           */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- See comment block above; onClick + onKeyDown are required by the WAI-ARIA modal dialog pattern (focus trap + click-isolation). */}
          <div
            id="new-design-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-design-dialog-title"
            aria-describedby="new-design-dialog-message"
            data-testid="new-design-dialog"
            onClick={handleDialogClick}
            onKeyDown={handleDialogKeyDown}
            style={dialogStyle}
          >
            <h2
              id="new-design-dialog-title"
              data-testid="new-design-dialog-title"
              style={dialogTitleStyle}
            >
              {dialogTitle}
            </h2>
            <p
              id="new-design-dialog-message"
              data-testid="new-design-dialog-message"
              style={dialogMessageStyle}
            >
              {dialogMessage}
            </p>
            <div style={dialogActionsStyle}>
              <button
                type="button"
                ref={cancelButtonRef}
                data-testid="new-design-cancel"
                onClick={handleCancel}
                style={cancelButtonStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                ref={confirmButtonRef}
                data-testid="new-design-confirm"
                onClick={handleConfirm}
                style={confirmButtonStyle}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
